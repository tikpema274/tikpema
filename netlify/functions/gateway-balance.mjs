import { connectLambda } from "@netlify/blobs";
import { json } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet } from "./_agent-wallets.mjs";
import { GATEWAY } from "./_gateway.mjs";

// POST /api/gateway-balance — read-only. Reads THE CALLER'S OWN unified USDC balance
// ACROSS CHAINS (Arc Testnet + Base Sepolia) from Circle's Gateway API.
//
// ⚠️ THIS IS NOW AUTH-GATED. It used to be a PUBLIC read keyed on the shared
// AGENT_WALLET_ADDRESS — anyone could see the shared agent's balance. Now the depositor is
// resolved from the VERIFIED SESSION (ensureOwnerWallet), so a caller can only ever read
// the balance of the wallet their own session owns. No session ⇒ 401, and the shared
// wallet's balance is not disclosed to anyone.
//
// Each chain is read INDEPENDENTLY (Promise.allSettled) so one chain failing degrades to
// the others rather than breaking the whole view.
//
// Returns { depositor, unifiedBalanceUsdc, perChain: [{ chain, domain, usdc, ok }] }.
// READ-ONLY: no deposit, no authorize, no spend — it cannot move money.

const CHAINS = [
  { chain: "Arc Testnet", domain: GATEWAY.ARC_DOMAIN },
  { chain: "Base Sepolia", domain: GATEWAY.BASE_SEPOLIA_DOMAIN },
];

// Read one domain's unified USDC for a depositor. Never throws — returns
// { ok:false } on any failure so a single chain can't break the others.
async function readDomain(depositor, domain) {
  try {
    const res = await fetch(`${GATEWAY.API_BASE}/v1/balances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "USDC", sources: [{ domain, depositor }] }),
    });
    if (!res.ok) return { ok: false };
    const data = await res.json();
    const balances = Array.isArray(data?.balances) ? data.balances : [];
    const usdc = balances.reduce((sum, b) => sum + Number(b?.balance || 0), 0);
    if (!Number.isFinite(usdc)) return { ok: false };
    return { ok: true, usdc: (Math.round(usdc * 1e6) / 1e6).toString() };
  } catch {
    return { ok: false };
  }
}

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectLambda(event); // Blobs wiring for classic-Lambda handlers

  // Auth gate — a balance is now per-user, so it needs a proven identity to key on.
  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  // The depositor: THIS session's own agent SCA. Provisioned on first touch, so a brand-new
  // user reads their own (honest) $0 rather than someone else's balance.
  const wallet = await ensureOwnerWallet(session);
  if (wallet.pending) {
    return json(202, { status: "provisioning", message: "Your wallet is being set up — retry shortly." });
  }
  const depositor = wallet.walletAddress;

  const settled = await Promise.allSettled(CHAINS.map((c) => readDomain(depositor, c.domain)));
  const perChain = CHAINS.map((c, i) => {
    const r = settled[i];
    const v = r.status === "fulfilled" ? r.value : { ok: false };
    return { chain: c.chain, domain: c.domain, usdc: v.ok ? v.usdc : null, ok: v.ok };
  });

  // Unified figure = sum over the chains that read OK (a failed chain is excluded,
  // not counted as a 0 we vouch for).
  const unified = (
    Math.round(perChain.filter((p) => p.ok).reduce((s, p) => s + Number(p.usdc || 0), 0) * 1e6) / 1e6
  ).toString();

  return json(200, { depositor, unifiedBalanceUsdc: unified, perChain });
}
