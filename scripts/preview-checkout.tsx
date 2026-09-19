// preview-checkout.tsx — a STATIC render of #/pay in the states the 2026-09-19 binding introduced,
// openable in a browser without a server, a session, or a payment.
//
//   npx tsx scripts/preview-checkout.tsx && open preview-checkout.html
//
// ⛔ WHY NOT dev:vite. `npm run dev:vite` is plain `vite` — no /api proxy, and `netlify dev` has never
// worked here (memory: verify-on-prod-not-local-dev). #/pay?order=… fetches /api/checkout-get, gets
// Vite's index.html back, fails to parse it and lands in "could not be read". So NONE of the states
// below is reachable in dev:vite through the real data path, and two of them (the replay 409, the
// payable fresh order) need a deployed server and, for the 409, a LIVE payment. This file renders
// them the way verify-checkout-copy asserts them: the REAL PayOrderView with crafted props, the REAL
// src/styles.css inlined. Same loop as preview-swap.tsx: nothing is reproduced, so it cannot drift.
//
// ⭐ STATES 1–2 USE THE TWO REAL PROD RECORDS, VERBATIM, as /api/checkout-get returned them on
// 2026-09-19 (read-only GET; the current prod code emits no `createdAtBlock`). That is exactly the
// payload the new PayOrderView will see for them after deploy: UNBOUND → no seal.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, writeFileSync } from "node:fs";
import { PayOrderView } from "../src/components/PayPanel";
import { MerchantOrders } from "../src/components/SellPanel";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const fonts = readFileSync(new URL("../index.html", import.meta.url), "utf8")
  .match(/<link[^>]*fonts\.googleapis[^>]*>/)?.[0] ?? "";

// ── the two prod orders, as served by https://app.tikpema.xyz/api/checkout-get on 2026-09-19 ──────
// (merchant = the seller's login wallet, the payee — public by design; both still `open`, never paid)
const PROD_A = { id: "o_mu7ju1sf_ae83dd7ebd87e0a5", merchant: "0x74b7b561fd71c68eb1da6b96a7a87033904b24e5", amountUsdc: "0.150000", description: "info", settlement: "direct", createdAt: "2026-09-18T22:47:38.127Z", expiresAt: "2026-10-02T22:47:38.127Z", status: "open", paidTx: null, paidAt: null, circleId: null };
const PROD_B = { id: "o_mu7jxx8h_56d2d2d3b03a6c4c", merchant: "0x74b7b561fd71c68eb1da6b96a7a87033904b24e5", amountUsdc: "0.110000", description: "info", settlement: "direct", createdAt: "2026-09-18T22:50:38.849Z", expiresAt: "2026-10-02T22:50:38.849Z", status: "open", paidTx: null, paidAt: null, circleId: null };

// ── a FRESH order minted by the new checkout-create (carries createdAtBlock) ───────────────────────
const AGENT = "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
const FRESH = { ...PROD_B, id: "o_mu85e5bu_a1bad55dd20a03bf", description: "Two coffees", amountUsdc: "0.110000", createdAt: "2026-09-19T09:00:00.000Z", expiresAt: "2026-10-03T09:00:00.000Z", createdAtBlock: 62816900 };
const HASH = "0x9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f";

const wallet = { address: "0x7777777777777777777777777777777777777777", agentWallet: { address: AGENT, balance: "4.000000" }, ensureSession: async () => "t", sendFromAgent: async () => ({}), refreshAgentWallet: async () => {} } as any;
const view = (order: any, extra: any = {}) =>
  renderToStaticMarkup(<PayOrderView order={order} wallet={wallet} paying={false} result={null} payError="" mark={null} onPay={() => {}} {...extra} />);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
function bothWidths(markup: string, tall = 760) {
  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">${fonts}<style>${css}
  body{margin:0}</style></head><body><div class="app" style="padding:12px">${markup}</div></body></html>`;
  return `<div class="pv-both">
    <div class="pv-col"><div class="pv-w">desktop</div><div class="app pv-desk">${markup}</div></div>
    <div class="pv-col"><div class="pv-w">mobile · 380px (real viewport)</div>
      <iframe class="pv-mob" width="380" height="${tall}" srcdoc="${esc(doc)}"></iframe></div>
  </div>`;
}
const label = (n: string, t: string, note: string) => `<div class="pv-label">${n} — ${t}</div><div class="pv-note">${note}</div>`;

// ── the FOUR states behind "no agent wallet" (AgentWalletGate, 2026-09-19) ─────────────────────────
type GateState = "noAddress" | "noSession" | "resolving" | "failed";
const gateWallet = (st: GateState) => ({
  ...wallet,
  address: st === "noAddress" ? null : wallet.address,
  isAuthenticated: st === "resolving" || st === "failed",
  agentWallet: null,
  agentWalletResolving: st === "resolving",
  agentWalletError: st === "failed" ? "session expired" : null,
  refreshAgentWallet: async () => null,
  activeKind: st === "noAddress" ? null : "modular",
}) as any;
const gate = (st: GateState) =>
  renderToStaticMarkup(<PayOrderView order={FRESH as any} wallet={gateWallet(st)} paying={false} result={null} payError="" mark={null} onPay={() => {}} />);

// ── YOUR CHECKOUT LINKS (#/sell listing) — the prod rows as of 2026-09-19 15:00Z, plus the three non-row states ──
const ORIGIN = "https://app.tikpema.xyz";
const listRows = [
  { ...PROD_B, id: "o_mu8hewk4_7b898539e3d371c9", description: "data", amountUsdc: "0.100000", status: "paid", createdAt: "2026-09-19T14:27:38.452Z", createdAtBlock: 62928454, paidTx: "0x79950cb47e7f3f8aa9228859909e1c4196a66a6714a5de4634e4ae1a86832bb4", paidAt: "2026-09-19T14:30:34.614Z", paidBy: AGENT, paidUnits: "100000", paidAtBlock: 62928802 },
  { ...PROD_B, id: "o_mu8hcts6_6ce7ab6b6b181c39", description: "data", amountUsdc: "0.100000", createdAt: "2026-09-19T14:25:00.000Z", createdAtBlock: 62928259 },
  { ...PROD_B, id: "o_mu8blkvc_eabf0202ebd465f0", description: "try", amountUsdc: "0.120000", createdAt: "2026-09-19T10:20:00.000Z", createdAtBlock: 62908947 },
  { ...PROD_B, id: "o_mu8b5obw_4f194018540eb160", description: "data", amountUsdc: "0.300000", status: "submitted", circleId: "circle-example", createdAt: "2026-09-19T10:05:00.000Z", createdAtBlock: 62907463 },
  { ...PROD_A, createdAtBlock: null },
] as any[];
const listView = (state: any, open = true) => renderToStaticMarkup(<MerchantOrders origin={ORIGIN} state={state} open={open} onToggle={() => {}} onRefresh={() => {}} />);

const sections = [
  label("L0", "YOUR CHECKOUT LINKS — COLLAPSED (the default on #/sell): header with the honest count",
    "Collapsed by default. The header is the only place the count is stated: listed → (N); truncated → the server's total; empty → (none listed yet), never (0); loading → (listing…); unreadable → no number at all. Click expands. A create auto-expands and pins the new link at the top."),
  bothWidths(listView({ state: "listed", orders: listRows, listedAt: "2026-09-19T15:00:00.000Z", truncated: false }, false) + listView({ state: "listed", orders: listRows, listedAt: "t", truncated: true, total: 120 }, false) + listView({ state: "listed", orders: [], listedAt: "t", truncated: false }, false) + listView({ state: "loading" }, false) + listView({ state: "unreadable", reason: "list down" }, false), 420),
  label("L1", "YOUR CHECKOUT LINKS — EXPANDED (paid / open / submitted / unbound rows)",
    "The merchant's own orders from /api/checkout-list, newest first. The paid row shows the REAL hash + explorer link; the submitted row has a Circle id and NO tx link; the unbound legacy row says “cannot be settled — make a new link” and offers no link. The lag line is on every listed page."),
  bothWidths(listView({ state: "listed", orders: listRows, listedAt: "2026-09-19T15:00:00.000Z", truncated: false }), 1400),
  label("L2", "YOUR CHECKOUT LINKS — EMPTY (never “you have no orders”)",
    "🚨 The listing is eventual. Empty says nothing is LISTED, that a link made moments ago may be missing, and that absence of a row is not absence of an order."),
  bothWidths(listView({ state: "listed", orders: [], listedAt: "2026-09-19T15:00:00.000Z", truncated: false }), 300),
  label("L3", "YOUR CHECKOUT LINKS — UNREADABLE (a third state, distinct from empty)",
    "The store could not be listed: the reason, ‘says nothing about whether you have any’, Refresh."),
  bothWidths(listView({ state: "unreadable", reason: "orders unreadable — the store could not be listed (list down); try again" }), 300),

  label("g1", "NO LOGIN WALLET — connect, with a return-to",
    "The only state that leaves the page. The Wallet link now stashes #/pay?order=… in sessionStorage; the wallet page brings the buyer back the moment the wallet is ready. The order stays on screen."),
  bothWidths(gate("noAddress"), 560),
  label("g2", "WALLET, NO SESSION — Sign in INLINE",
    "Was: “Set up your wallet first — open Wallet” (wrong: the wallet exists). Now: SignInPrompt on the order itself — one passkey tap, the buyer never leaves."),
  bothWidths(gate("noSession"), 560),
  label("g3", "SESSION, RESOLVE IN FLIGHT — Preparing your agent wallet",
    "Was: the same send-away sentence during a network round-trip. Now: a spinner and the plain statement that the agent wallet is created for the login and needs NO funds to be created."),
  bothWidths(gate("resolving"), 560),
  label("g4", "SESSION, RESOLVE FAILED — the reason, ‘Nothing was paid’, Retry",
    "🚨 The most important one. Was: a permanent “Set up your wallet first” with no reason and no way out (the failure was swallowed in useWallet). Now: the server's reason, the reassurance, and a Retry wired to refreshAgentWallet()."),
  bothWidths(gate("failed"), 560),

  label("a1", "PROD order o_mu7ju1sf (0.15 USDC) — UNBOUND, no seal",
    "The real record as prod serves it today: no <code>createdAtBlock</code>. The new page reads that as UNBOUND: what / to whom / how much still render (door, not wall), the reason is stated, <b>no Pay button</b>, no irreversibility hazard. The money never moves on this link."),
  bothWidths(view(PROD_A), 620),

  label("a2", "PROD order o_mu7jxx8h (0.11 USDC) — UNBOUND, no seal",
    "Same record shape, the order the unrelated 0.13 transfer WOULD have satisfied under the old test. After deploy the server also refuses any posted hash for it (code:unbound)."),
  bothWidths(view(PROD_B), 620),

  label("c", "FRESH order — the normal payable state (bound at block 62816900)",
    "Minted by the new checkout-create: <code>createdAtBlock</code> present → open → the summary block, the hazard BEFORE the seal, and the seal. Unchanged from Deploy 8 apart from the binding it now carries."),
  bothWidths(view(FRESH), 760),

  label("b", "REPLAY 409 — the buyer posted a hash that already paid ANOTHER order",
    "The buyer's transfer (SendOutcome, top) landed; then /api/checkout-paid answered 409 code:replay with <code>paidOrderId</code>. The mark NAMES the order the transaction already paid and LINKS it (#/pay?order=…). It says this order remains unpaid and nothing was marked. ⛔ It does NOT say “will show paid once the server can read it” — that is the 503 copy, and this is a verdict."),
  bothWidths(view(FRESH, { result: { txHash: HASH }, mark: { refused: `not a payment of this order: this transaction already paid order ${PROD_A.id}`, code: "replay", paidOrderId: PROD_A.id } }), 980),

  label("b2", "PREDATES 409 — the transfer was mined before the order existed",
    "The prod shape (block 62816721 vs an order created later). Server reason rendered verbatim, both blocks visible; order remains unpaid."),
  bothWidths(view(FRESH, { result: { txHash: HASH }, mark: { refused: "not a payment of this order: the transfer was mined in block 62816721, before this order was created at block 62816900", code: "predates", paidOrderId: null } }), 980),

  label("b3", "UNBOUND 409 — server-side refusal (defence in depth; the page should never let it get here)",
    "Only reachable if a client posts a hash for an unbound order directly. Says the link cannot be settled and to ask the seller for a new one."),
  bothWidths(view(FRESH, { result: { txHash: HASH }, mark: { refused: "not a payment of this order: the order is unbound — it has no createdAtBlock", code: "unbound", paidOrderId: null } }), 980),

  label("503", "UNVERIFIED (503) — for contrast: could not READ, not a verdict",
    "Receipt not yet available. This copy keeps the hash and says the order will show paid once the server can read it — correct HERE, and exactly why a 409 must not share it."),
  bothWidths(view(FRESH, { result: { txHash: HASH }, mark: { unverified: "receipt not available yet — the transaction may still be confirming" } }), 980),
];

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>checkout #/pay — binding states, static preview</title>${fonts}
<style>${css}
  body{padding:24px;background:var(--ink-2)}
  .pv-label{font-family:"Space Mono",monospace;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--amber-hi);margin:40px 0 6px}
  .pv-note{color:var(--muted);font-size:12px;max-width:70ch;line-height:1.6;margin-bottom:12px}
  .pv-both{display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap}
  .pv-col{flex:0 0 auto}
  .pv-w{font-family:"Space Mono",monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
  .pv-desk{width:560px;max-width:560px;margin:0}
  .pv-mob{border:1px solid var(--line-strong);border-radius:12px;background:var(--ink)}
</style></head><body>
  <div class="pv-label" style="color:var(--paper);font-size:15px">Checkout #/pay — wallet gate (g1–g4) · one hash, one order (2026-09-19) — static preview</div>
  <div class="pv-note">Real PayOrderView, real styles.css, crafted props. a1/a2 are the two live prod records verbatim.
    Nothing here talks to a server; nothing can be paid from this file.</div>
  ${sections.join("\n")}
</body></html>`;

writeFileSync("preview-checkout.html", html);
console.log(`\n  wrote preview-checkout.html  (${(html.length / 1024).toFixed(1)} KB)`);
console.log(`  open it directly in a browser — no server, no session, no payment.\n`);
