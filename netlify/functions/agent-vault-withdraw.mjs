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
// Outcomes: reclaimed (200, tx + REAL on-chain USDC delta) · nothing to reclaim (200,
// reclaimed:false, balance was genuinely 0) · unconfirmed (502, FAIL CLOSED — the reclaim was not
// PROVEN on-chain: balance unreadable, tx not mined status:success, or no USDC delta. Carries an
// honest reason and the tx hash if one exists; NEVER a computed/placeholder amount).
import { json, parseBody } from "./_arc.mjs";
import { connectBlobs } from "./_blobs.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet, WALLET_PROVISIONING_STATUS, walletProvisioningRefusal, WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal } from "./_agent-wallets.mjs";
import { executeAction } from "./_actions.mjs";
import { resolveVault, SUPPORTED_VAULT_KEYS } from "./_vault.mjs";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectBlobs(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { vault } = parseBody(event);
  const v = resolveVault(vault);
  if (!v) return json(400, { error: `unsupported vault "${vault}" (not on the allowlist)`, supported: SUPPORTED_VAULT_KEYS });

  let wallet;
  // ⭐ A THROW HERE IS A REFUSAL, NOT A CRASH. Unwrapped it surfaced as a bare 500 that said
  // nothing about retryability or whether anything happened. See walletUnresolvableRefusal.
  try { wallet = await ensureOwnerWallet(session); }
  catch (e) { return json(WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal(e)); }
  if (wallet.pending) return json(WALLET_PROVISIONING_STATUS, walletProvisioningRefusal());
  const walletAddress = wallet.walletAddress;

  try {
    const r = await executeAction(
      { type: "vault_withdraw", vault: v.key, reasoning: "user vault withdraw (reclaim full balance)" },
      { walletAddress }
    );
    // FAIL CLOSED: a reclaim is only !ok when it could not be PROVEN on-chain (uncapped, pause-exempt,
    // so no cap/pause path). Surface the honest reason as 502 — never a success, never a number.
    if (!r.ok) return json(502, { error: r.blocked, blocked: true, unconfirmed: !!r.unconfirmed, withdrawHash: r.withdrawHash ?? null });
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
