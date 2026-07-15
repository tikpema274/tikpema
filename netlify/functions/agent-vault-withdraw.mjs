// POST /api/agent-vault-withdraw { vault }  (auth required) — RECLAIM (moves funds back).
//
// Redeem the caller's ENTIRE current vault position back into USDC in their OWN agent wallet. The
// amount is NOT supplied by the client and is NOT a session receipt: executeAction reads the live
// on-chain share balance (balanceOf) for this wallet and redeems exactly that. So a user returning
// in a NEW session — with shares deposited in a prior one — can still reclaim, and there is no
// free-text amount anywhere on the wire to mis-scale.
//
// A RECLAIM: it returns the user's funds and only ever to their own SCA (redeem to self), so — like
// agent-withdraw — it is deliberately NOT capped and NOT blocked by a pause. Pausing the Vault agent
// must never trap funds inside the vault. Withdraw carries the ~0.1% exit fee (see the inspection).
//
// Three outcomes: reclaimed (200, tx + USDC received) · nothing to reclaim (200, reclaimed:false,
// balance was genuinely 0) · could-not-read-balance (502, FAIL CLOSED — nothing signed).
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

  const { vault } = parseBody(event);
  const v = resolveVault(vault);
  if (!v) return json(400, { error: `unsupported vault "${vault}" (not on the allowlist)`, supported: SUPPORTED_VAULT_KEYS });

  const wallet = await ensureOwnerWallet(session);
  if (wallet.pending) return json(202, { status: "provisioning", message: "Your agent wallet is being set up — retry shortly." });
  const walletAddress = wallet.walletAddress;

  try {
    const r = await executeAction(
      { type: "vault_withdraw", vault: v.key, reasoning: "user vault withdraw (reclaim full balance)" },
      { walletAddress }
    );
    // FAIL CLOSED: the only way a reclaim is !ok is a balance-read failure (it is uncapped and
    // pause-exempt). Surface it as 502 — the read failed, nothing was redeemed — never a success.
    if (!r.ok) return json(502, { error: r.blocked, blocked: true });
    // Genuinely no shares → a clear "nothing to reclaim", NOT an error and NOT a redeem.
    if (r.reclaimed === false) {
      return json(200, { ok: true, reclaimed: false, shareBalanceRaw: r.shareBalanceRaw ?? "0",
        message: "Nothing to reclaim — you hold no shares in this vault." });
    }
    return json(200, { ok: true, to: walletAddress, ...r });
  } catch (e) {
    return json(500, { error: e.message });
  }
}
