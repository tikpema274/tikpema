import { json } from "./_arc.mjs";
import { GATEWAY } from "./_gateway.mjs";

// POST /api/gateway-balance — read-only. Reads the AGENT wallet's unified USDC
// balance ACROSS CHAINS (Arc Testnet + Base Sepolia) from Circle's Gateway API.
//
// Public read keyed by the depositor address — NO secrets, NO kit/adapter. Each
// chain is read INDEPENDENTLY (Promise.allSettled) so one chain failing degrades to
// the others rather than breaking the whole view. This is the AGENT wallet
// (AGENT_WALLET_ADDRESS), NOT a per-user wallet — the UI labels it as such.
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

  const depositor = process.env.AGENT_WALLET_ADDRESS;
  if (!depositor) {
    return json(400, { error: "AGENT_WALLET_ADDRESS not set — run /api/agent-init first." });
  }

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
