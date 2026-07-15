// POST /api/agent-vault-withdraw { vault, shares }  (auth required) — RECLAIM (moves funds back).
//
// Redeem the caller's vault shares back into USDC in their OWN agent wallet. A RECLAIM: it returns
// the user's funds and only ever to their own SCA (redeem to self), so — like agent-withdraw — it
// is deliberately NOT capped and NOT blocked by a pause (executeAction skips both for
// vault_withdraw). Pausing the Vault agent must never trap funds inside the vault.
//
// `shares` is in the share token's base units (raw). Use agent-vault-inspect / the share balance
// to pick it. Withdraw carries the ~0.1% exit fee the vault charges (see the inspection).
import { connectLambda } from "@netlify/blobs";
import { json, parseBody } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet } from "./_agent-wallets.mjs";
import { executeAction } from "./_actions.mjs";
import { resolveVault, SUPPORTED_VAULT_KEYS } from "./_vault.mjs";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectLambda(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { vault, shares } = parseBody(event);
  const v = resolveVault(vault);
  if (!v) return json(400, { error: `unsupported vault "${vault}" (not on the allowlist)`, supported: SUPPORTED_VAULT_KEYS });
  // shares is a raw base-unit integer (string or number). Must be > 0.
  const sharesStr = String(shares ?? "").trim();
  if (!/^[0-9]+$/.test(sharesStr) || BigInt(sharesStr) <= 0n) {
    return json(400, { error: "shares must be a positive integer (raw base units)" });
  }

  const wallet = await ensureOwnerWallet(session);
  if (wallet.pending) return json(202, { status: "provisioning", message: "Your agent wallet is being set up — retry shortly." });
  const walletAddress = wallet.walletAddress;

  try {
    const r = await executeAction(
      { type: "vault_withdraw", vault: v.key, shares: sharesStr, reasoning: "user vault withdraw (reclaim)" },
      { walletAddress }
    );
    if (!r.ok) return json(400, { error: r.blocked, blocked: true });
    return json(200, { ok: true, to: walletAddress, ...r });
  } catch (e) {
    return json(500, { error: e.message });
  }
}
