// POST /api/agent-send { to, amountUsdc }  (auth required)  — Sub-brick A
//
// Transfer USDC FROM the caller's OWN agent wallet (the per-user 2a wallet that
// holds their funds and pays for jobs), resolved from the SESSION — never
// client-supplied. The agent wallet is a Circle dev-controlled SCA, so only the
// server can move it; this is the server-side "send" for the wallet the user
// actually funds. Gasless (Gas Station sponsored).
import { formatUnits } from "viem";
import { connectBlobs } from "./_blobs.mjs";
import { json, parseBody, ARC, CONTRACTS, USDC_DECIMALS, sendCapUsdc } from "./_arc.mjs";
import { circle, waitForTx, TxPendingError } from "./_circle.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet, WALLET_PROVISIONING_STATUS, walletProvisioningRefusal, WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal } from "./_agent-wallets.mjs";
import { canSpendDay, recordAgentSpend } from "./_budget.mjs";
import { AGENT } from "./_agents.mjs";
import { assertNotPaused } from "./_pause.mjs";
import { publicClient } from "./_predict.mjs";

const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectBlobs(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { to, amountUsdc } = parseBody(event);
  if (!/^0x[0-9a-fA-F]{40}$/.test(to || "")) {
    return json(400, { error: "valid 'to' address required" });
  }
  const amount = Number(amountUsdc);
  if (!(amount > 0)) return json(400, { error: "amountUsdc must be > 0" });

  // GUARDRAIL 1 — per-transaction send cap (hard limit; checked first so an
  // over-cap send returns the cap message).
  const cap = sendCapUsdc();
  if (amount > cap) {
    return json(400, { error: `exceeds per-transaction limit of ${cap} USDC`, cap });
  }

  // Resolve the caller's OWN wallet from the session (never client-supplied).
  let wallet;
  // ⭐ A THROW HERE IS A REFUSAL, NOT A CRASH. Unwrapped it surfaced as a bare 500 that said
  // nothing about retryability or whether anything happened. See walletUnresolvableRefusal.
  try { wallet = await ensureOwnerWallet(session); }
  catch (e) { return json(WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal(e)); }
  if (wallet.pending) {
    return json(WALLET_PROVISIONING_STATUS, walletProvisioningRefusal());
  }
  const walletAddress = wallet.walletAddress;

  // GUARDRAIL 2 — day-ceiling: cumulative agent sends count against the same
  // rolling-UTC-day budget as other autonomous spend, PER USER — keyed to this
  // caller's own wallet (server-resolved), so it can't be blocked by, or block,
  // any other wallet.
  // ── THE KILL SWITCH. agent-send moves funds via a direct transfer() and NEVER calls
  // executeAction, so a pause enforced only there would leave this path wide open.
  // Fail-closed: an unreadable switch refuses. ──
  const paused = await assertNotPaused({ owner: walletAddress, agent: AGENT.EXECUTOR });
  if (paused) return json(409, { error: paused, paused: true });

  const day = await canSpendDay({ amountUsdc: amount, owner: walletAddress });
  if (!day.allowed) {
    return json(429, { error: day.reason, dayCeiling: true });
  }

  // Clean insufficient-funds error before attempting the transfer.
  try {
    const raw = await publicClient().readContract({
      address: CONTRACTS.USDC,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [walletAddress],
    });
    const have = Number(formatUnits(raw, USDC_DECIMALS));
    if (have < amount) {
      return json(402, {
        error: `Insufficient funds. Have ${have.toFixed(2)} USDC, need ${amount.toFixed(2)}.`,
        have: Number(have.toFixed(2)),
      });
    }
  } catch {
    /* balance read hiccup — let the transfer attempt surface any real failure */
  }

  try {
    const client = circle();
    const units = BigInt(Math.round(amount * 10 ** USDC_DECIMALS)).toString();
    const tx = await client.createContractExecutionTransaction({
      walletAddress,
      blockchain: ARC.blockchain,
      contractAddress: CONTRACTS.USDC,
      abiFunctionSignature: "transfer(address,uint256)",
      abiParameters: [to, units],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const txHash = await waitForTx(client, tx.data?.id);
    // Ledger the send against today's ceiling (best-effort; the tx already landed).
    await recordAgentSpend({
      agent: AGENT.EXECUTOR,
      owner: walletAddress,
      amountUsdc: amount,
      source: "agent-send",
      justification: `user send to ${to}`,
    }).catch(() => {});
    return json(200, { txHash, tx: `${ARC.explorer}/tx/${txHash}`, from: walletAddress });
  } catch (e) {
    if (e instanceof TxPendingError) {
      return json(202, { pending: true, txId: e.txId, message: e.message });
    }
    return json(500, { error: e.message });
  }
}
