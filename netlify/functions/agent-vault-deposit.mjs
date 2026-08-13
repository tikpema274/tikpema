// POST /api/agent-vault-deposit { vault, amountUsdc, ackToken }  (auth required) — MOVES FUNDS.
//
// Deposit the caller's OWN agent-wallet USDC into an allowlisted ERC-4626 vault. The wallet is
// resolved from the SESSION (never client-supplied); the vault is resolved from the allowlist by
// key (never a free-form address). All the guardrails live in executeAction — the ONE secure
// path: AGENT.VAULT pause, the fail-closed vault-deposit cap, the daily ceiling, and the on-chain
// inspection GATE (BLOCK / WARN+ack) — so this handler is thin and cannot bypass any of them.
import { formatUnits } from "viem";
import { connectBlobs } from "./_blobs.mjs";
import { json, parseBody, CONTRACTS, USDC_DECIMALS } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet, WALLET_PROVISIONING_STATUS, walletProvisioningRefusal } from "./_agent-wallets.mjs";
import { executeAction } from "./_actions.mjs";
import { resolveVault, SUPPORTED_VAULT_KEYS } from "./_vault.mjs";
import { publicClient } from "./_predict.mjs";

const BAL_ABI = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }];

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectBlobs(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { vault, amountUsdc, ackToken } = parseBody(event);
  const v = resolveVault(vault);
  if (!v) return json(400, { error: `unsupported vault "${vault}" (not on the allowlist)`, supported: SUPPORTED_VAULT_KEYS });
  const amount = Number(amountUsdc);
  if (!(amount > 0)) return json(400, { error: "amountUsdc must be > 0" });

  const wallet = await ensureOwnerWallet(session);
  if (wallet.pending) return json(WALLET_PROVISIONING_STATUS, walletProvisioningRefusal());
  const walletAddress = wallet.walletAddress;

  // Clean insufficient-funds error before executeAction attempts the approve/deposit.
  try {
    const raw = await publicClient().readContract({ address: CONTRACTS.USDC, abi: BAL_ABI, functionName: "balanceOf", args: [walletAddress] });
    const have = Number(formatUnits(raw, USDC_DECIMALS));
    if (have < amount) return json(402, { error: `Insufficient funds. Have ${have.toFixed(2)} USDC, need ${amount.toFixed(2)}.`, have: Number(have.toFixed(2)) });
  } catch {
    /* balance read hiccup — let executeAction surface any real failure */
  }

  try {
    const r = await executeAction(
      { type: "vault_deposit", vault: v.key, amountUsdc: amount, ackToken, reasoning: "user-approved vault deposit" },
      { walletAddress }
    );
    if (!r.ok) {
      // A pause is a 409; a gate refusal (BLOCK / needs-ack) is a 409 too, carrying the disclosure
      // so the UI can render exactly what must be acknowledged. A cap/shape refusal is a 400.
      const paused = /paused/i.test(r.blocked || "");
      const gate = /inspection|acknowledg/i.test(r.blocked || "");
      const code = paused || gate ? 409 : 400;
      return json(code, { error: r.blocked, blocked: true, disclosure: r.disclosure ?? null });
    }
    return json(200, { ok: true, from: walletAddress, ...r });
  } catch (e) {
    return json(500, { error: e.message });
  }
}
