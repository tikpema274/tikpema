// POST /api/agent-send { to, amountUsdc }  (auth required)  — Sub-brick A
//
// Transfer USDC FROM the caller's OWN agent wallet (the per-user 2a wallet that
// holds their funds and pays for jobs), resolved from the SESSION — never
// client-supplied. The agent wallet is a Circle dev-controlled SCA, so only the
// server can move it; this is the server-side "send" for the wallet the user
// actually funds. Gasless (Gas Station sponsored).
import { connectLambda } from "@netlify/blobs";
import { formatUnits } from "viem";
import { json, parseBody, ARC, CONTRACTS, USDC_DECIMALS } from "./_arc.mjs";
import { circle, waitForTx, TxPendingError } from "./_circle.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet } from "./_agent-wallets.mjs";
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
  if (event.blobs) connectLambda(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { to, amountUsdc } = parseBody(event);
  if (!/^0x[0-9a-fA-F]{40}$/.test(to || "")) {
    return json(400, { error: "valid 'to' address required" });
  }
  const amount = Number(amountUsdc);
  if (!(amount > 0)) return json(400, { error: "amountUsdc must be > 0" });

  // Resolve the caller's OWN wallet from the session (never client-supplied).
  const wallet = await ensureOwnerWallet(session);
  if (wallet.pending) {
    return json(202, { status: "provisioning", message: "Your agent wallet is being set up — retry shortly." });
  }
  const walletAddress = wallet.walletAddress;

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
    return json(200, { txHash, tx: `${ARC.explorer}/tx/${txHash}`, from: walletAddress });
  } catch (e) {
    if (e instanceof TxPendingError) {
      return json(202, { pending: true, txId: e.txId, message: e.message });
    }
    return json(500, { error: e.message });
  }
}
