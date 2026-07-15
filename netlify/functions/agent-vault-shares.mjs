// POST /api/agent-vault-shares { vault }  (auth required) — READ-ONLY, moves nothing.
//
// Returns the caller's OWN live on-chain share balance in an allowlisted vault — balanceOf(vault,
// ownerSCA), read fresh from the chain, scoped to the VERIFIED SESSION's own wallet (never a
// client-supplied address). This is what lets a returning user see and reclaim shares deposited in
// a prior session: the balance is on-chain truth, not a session receipt.
//
// FAILS CLOSED: if the balance cannot be read, this returns 502 — it never reports an unread balance
// as zero (which would falsely tell a user they have nothing to reclaim). `readShareBalance` throws
// on read failure and returns 0n only for a genuine empty position.
import { connectLambda } from "@netlify/blobs";
import { json, parseBody } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet } from "./_agent-wallets.mjs";
import { resolveVault, readShareBalance, SUPPORTED_VAULT_KEYS } from "./_vault.mjs";

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

  try {
    const bal = await readShareBalance({ walletAddress: wallet.walletAddress, vault: v });
    return json(200, {
      vault: { key: v.key, address: v.address, label: v.label, shareSymbol: v.shareSymbol },
      owner: wallet.walletAddress,
      shareBalanceRaw: bal.raw.toString(),
      shareBalanceFormatted: bal.formatted,
      shareDecimals: bal.decimals,
      shareSymbol: v.shareSymbol,
      hasShares: bal.raw > 0n,
    });
  } catch (e) {
    // FAIL CLOSED — an unread balance is NOT reported as zero.
    return json(502, { error: `could not read your share balance on-chain: ${e.message}` });
  }
}
