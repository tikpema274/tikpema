// verify-checkout-copy.tsx — WHAT THE PAY SURFACE SAYS, rendered, per order state.
//
//   npx tsx scripts/verify-checkout-copy.tsx      (npm run test:checkoutcopy)
//
// ═══ THE ONE CLAIM THIS SURFACE EXISTS TO MAKE ══════════════════════════════════════════════════
// A direct payment CANNOT be reversed by Tikpema (decided 2026-09-18: payTo = the merchant's login
// wallet, no escrow in v1). The buyer must read that BEFORE the seal — so the line is asserted PRESENT
// in the open state AND its position in the markup is BEFORE the seal button's. A line below the
// button is a line read after the click. [[manual-send-confirmation-names-nothing]]
//
// ⚠️ RENDERED, NOT GREPPED. SSR cannot click Pay, so the post-action states are rendered through the
// EXPORTED sub-component with crafted orders/results — the SendReviewBox / SendOutcome seam.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PayOrderView, PayDoor, IRREVERSIBLE_LINE } from "../src/components/PayPanel";
import SellPanel, { SellResult, checkoutLink, MerchantOrders, listHeader } from "../src/components/SellPanel";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? `  — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);
const strip = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const MERCHANT = "0x" + "ab".repeat(20);
const AGENT = "0x" + "cd".repeat(20);
const HASH = "0x" + "9f".repeat(32);
const EXPL = "https://testnet.arcscan.app";
const base = {
  id: "o_mu7dugw0_a9f8523e2b9816f7", merchant: MERCHANT, amountUsdc: "1.500000", description: "Two coffees",
  settlement: "direct", status: "open", createdAt: "2026-09-18T20:00:00.000Z", expiresAt: "2026-10-02T20:00:00.000Z",
  paidTx: null, paidAt: null, circleId: null, createdAtBlock: 62816113,
};
const wallet = (opts: { agentWallet?: any } = {}) => ({
  address: "0x" + "77".repeat(20),
  agentWallet: "agentWallet" in opts ? opts.agentWallet : { address: AGENT, balance: "4.000000" },
  ensureSession: async () => "t", sendFromAgent: async () => ({}), refreshAgentWallet: async () => {},
});
const view = (order: any, extra: any = {}, w: any = wallet()) =>
  renderToStaticMarkup(<PayOrderView order={order} wallet={w} paying={false} result={null} payError="" mark={null} onPay={() => {}} {...extra} />);

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  CHECKOUT PAY SURFACE — what it says, per state, rendered            ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("1 — 🚨 OPEN: what, to whom, how much — and the irreversibility line ABOVE the seal");
{
  const m = view(base);
  const t = strip(m);
  check("what: the description is rendered", t.includes("Two coffees"));
  // ⭐ Masked by default (T, 2026-09-18) via AddressDisplay: 0xabab…abab shown, click expands to the full
  //    address, Copy copies the full one. The full address is therefore ONE TAP away, never absent.
  const masked = `${MERCHANT.slice(0, 6)}…${MERCHANT.slice(-4)}`;
  check("to whom: the merchant address, masked by default, with click-to-expand + Copy", t.includes(masked) && /Click to show full address/.test(m) && />Copy</.test(m));
  check("how much: the amount, 6dp, with the unit", /1\.500000 USDC/.test(t));
  check("the agent spending-limits rail is present (same claim as SendPanel)", /spending limits apply/i.test(t));
  const line = m.indexOf(IRREVERSIBLE_LINE);
  const seal = m.search(/<button[^>]*class="emerald[^"]*"[^>]*>Pay /);
  check("🚨 the irreversibility line is PRESENT", line >= 0);
  check("🚨 …and it says Tikpema cannot reverse it and a refund is the merchant's act",
    /cannot be reversed/i.test(IRREVERSIBLE_LINE) && /merchant/i.test(IRREVERSIBLE_LINE) && /refund/i.test(IRREVERSIBLE_LINE));
  check("🚨 …and it sits BEFORE the seal button in the markup", line >= 0 && seal > line, `line@${line} seal@${seal}`);
  check("the seal names the amount", /Pay 1\.500000 USDC/.test(t));
  check("no receipt, no tx link before paying", !/\/tx\//.test(m));
}

section("2 — OPEN without an agent wallet: the order is READABLE, the seal is not offered");
{
  // ⚠️ This fixture has a LOGIN address and no session — which is the "address, no session" state,
  // not "no wallet". Until 2026-09-19 it rendered "Set up your wallet first — open Wallet" (the
  // send-away that lost the order id); now it renders Sign in INLINE. The no-address state is
  // pinned in verify-wallet-gate.tsx together with the other three.
  const m = view(base, {}, wallet({ agentWallet: null }));
  const t = strip(m);
  check("⭐ door not wall: description, merchant (masked, expandable) and amount still render", t.includes("Two coffees") && t.includes(`${MERCHANT.slice(0, 6)}…${MERCHANT.slice(-4)}`) && /1\.500000/.test(t));
  check("no seal button", !/class="emerald[^"]*"[^>]*>Pay /.test(m));
  check("⭐ a connected login without a session is offered Sign in HERE, not sent to Wallet", /<button[^>]*>Sign in/.test(m) && !/Set up your wallet/i.test(t));
  const noAddr = view(base, {}, { ...wallet({ agentWallet: null }), address: null });
  check("⭐ no login wallet at all → points at Wallet to set one up (with return-to, not a bare link)", /Set up your wallet/i.test(strip(noAddr)) && /Wallet/.test(strip(noAddr)));
}

section("3 — PAID: receipt with the hash and explorer link; no seal");
{
  const paid = { ...base, status: "paid", paidTx: HASH, paidAt: "2026-09-18T20:05:00.000Z" };
  const m = view(paid);
  const t = strip(m);
  check("says paid", /\bPaid\b/.test(t));
  check("⭐ shows the hash and an explorer link to THAT hash", t.includes(HASH) && m.includes(`href="${EXPL}/tx/${HASH}"`));
  check("no seal button on a paid order", !/class="emerald[^"]*"[^>]*>Pay /.test(m));
  check("no irreversibility warning on a paid order (nothing left to decide)", !m.includes(IRREVERSIBLE_LINE));
}

section("4 — SUBMITTED is NOT paid; EXPIRED offers nothing");
{
  const sub = view({ ...base, status: "submitted", circleId: "circle-1" });
  const st = strip(sub);
  check("🚨 submitted does NOT say paid or confirmed", !/\bpaid\b/i.test(st.replace(/not (yet )?paid/i, "")) && !/confirmed/i.test(st));
  check("…says submitted / not confirmed yet, names the Circle id, no tx link", /submitted/i.test(st) && st.includes("circle-1") && !/\/tx\//.test(sub));
  check("…no seal (paying again would be a second payment)", !/class="emerald[^"]*"[^>]*>Pay /.test(sub));
  const exp = view({ ...base, status: "expired" });
  const et = strip(exp);
  check("expired says so and offers no seal", /expired/i.test(et) && !/class="emerald[^"]*"[^>]*>Pay /.test(exp));
}

section("5 — the result of Pay renders through SendOutcome (200 / 202 / error), plus the mark");
{
  const ok = view(base, { result: { txHash: HASH }, mark: { status: "paid", paidTx: HASH } });
  check("200 → SendOutcome receipt (confirmed on Arc + tx link) and order marked paid", /confirmed on Arc/.test(strip(ok)) && ok.includes(`/tx/${HASH}`) && /marked paid|Paid/.test(strip(ok)));
  const pend = view(base, { result: { pending: true, txId: "circle-9" }, mark: { status: "submitted" } });
  check("202 → submitted copy, agent-wallet address link, never 'confirmed', no tx link", /has not landed on Arc yet/.test(strip(pend)) && pend.includes(`/address/${AGENT}`) && !/confirmed/i.test(strip(pend)) && !/\/tx\//.test(pend));
  const err = view(base, { payError: "Per-transaction cap is 5 USDC" });
  check("error → the error only, no receipt", strip(err).includes("Per-transaction cap is 5 USDC") && !/\/tx\//.test(err) && !/confirmed/i.test(strip(err)));
  const unv = view(base, { result: { txHash: HASH }, mark: { unverified: "receipt not available yet" } });
  check("⭐ paid on chain but the mark is UNVERIFIED → says so, keeps the hash, does not say the order is paid", /unverified|could not yet verify/i.test(strip(unv)) && strip(unv).includes(HASH) && !/order (is )?paid/i.test(strip(unv)));
}

section("6 — the DOOR (no order in the link)");
{
  const m = renderToStaticMarkup(<PayDoor />);
  const t = strip(m);
  check("explains what a checkout link is and how to open one", /checkout link/i.test(t));
  check("⭐ links Sell (every live route linked)", /#\/sell/.test(m) || /Sell something/.test(t));
}

section("7 — SELL: the merchant is told the money comes straight to their login wallet, and it's final");
{
  const w: any = { address: MERCHANT, agentWallet: { address: AGENT }, ensureSession: async () => "t", isAuthenticated: true };
  const m = renderToStaticMarkup(<SellPanel wallet={w} />);
  const t = strip(m);
  check("names the payee: the merchant's own (login) wallet, masked with click-to-expand + Copy", t.includes(`${MERCHANT.slice(0, 6)}…${MERCHANT.slice(-4)}`) && /Click to show full address/.test(m));
  check("⭐ says payments arrive DIRECTLY and a refund is the merchant sending it back", /directly/i.test(t) && /refund/i.test(t) && /send(ing)? it back/i.test(t));
  check("has an amount and a description field and a Create control", /Amount/.test(t) && /What is it for|description/i.test(t) && /Create checkout link/.test(t));
  const out = renderToStaticMarkup(<SellResult origin="https://app.tikpema.xyz" order={base as any} path={`/#/pay?order=${base.id}`} />);
  const ot = strip(out);
  check("⭐ the produced link is origin + /#/pay?order=<id>", ot.includes(`https://app.tikpema.xyz/#/pay?order=${base.id}`));
  check("checkoutLink composes exactly that", checkoutLink("https://app.tikpema.xyz", base.id) === `https://app.tikpema.xyz/#/pay?order=${base.id}`);
  check("…and restates what the buyer will see: description, amount", ot.includes("Two coffees") && /1\.500000 USDC/.test(ot));
  const signedOut = strip(renderToStaticMarkup(<SellPanel wallet={{ ...w, address: null } as any} />));
  check("signed out → no address, points at Wallet, no Create control", !signedOut.includes(MERCHANT.slice(0, 6)) && /Wallet/.test(signedOut) && !/Create checkout link/.test(signedOut));
}

section("8 — ⛔ BOTH ROUTES ARE LINKED: Pay is a NAV item, Sell has a Dashboard card (the #/dca lesson)");
{
  // On SOURCE, because a render of App needs the whole wallet. The claim is about wiring, not copy.
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const nav = app.match(/const NAV = \[([\s\S]*?)\];/)?.[1] ?? "";
  check("⭐ 'pay' IS a NAV item", /id:\s*"pay"/.test(nav));
  check("…and both routes resolve", app.includes('case "pay"') && app.includes('case "sell"'));
  const dash = readFileSync(new URL("../src/components/Dashboard.tsx", import.meta.url), "utf8");
  check("⭐ the Dashboard card is the way into Sell", dash.includes('go("sell")'));
  check("…and the Pay door links Sell too", /window\.location\.hash = "\/sell"/.test(readFileSync(new URL("../src/components/PayPanel.tsx", import.meta.url), "utf8")));
}

section("9 — 🚨 REFUSED marks: a 409 is a VERDICT the buyer must read, never 'could not yet verify'");
{
  // The server READ the receipt and said "not a payment of this order". Rendering that through the
  // unverified branch would tell the buyer "the order will show paid once the server can read it" —
  // a false promise about a verdict already given. Each refusal has its own copy, pinned here.
  const OTHER_ID = "o_mu7ju1sf_0123456789abcdef";
  const replay = view(base, { result: { txHash: HASH }, mark: { refused: `not a payment of this order: this transaction already paid order ${OTHER_ID}`, code: "replay", paidOrderId: OTHER_ID } });
  const rt = strip(replay);
  check("🚨 replay: NAMES the order the transaction already paid", rt.includes(OTHER_ID), rt.slice(0, 200));
  check("⭐ …and LINKS it (#/pay?order=<that id>), so the buyer can open the order that got the money", replay.includes(`#/pay?order=${OTHER_ID}`));
  check("…says THIS order is still unpaid and nothing was marked", /still unpaid|not (been )?marked|remains unpaid/i.test(rt));
  check("🚨 …does NOT promise 'will show paid once the server can read it' (that is the unverified copy)", !/once the server can read it/i.test(rt) && !/could not yet verify/i.test(rt));
  check("…keeps the transfer hash visible (the money did move)", rt.includes(HASH));

  const predates = view(base, { result: { txHash: HASH }, mark: { refused: "not a payment of this order: the transfer was mined in block 62816721, before this order was created at block 62816722", code: "predates", paidOrderId: null } });
  const pt = strip(predates);
  check("🚨 predates: renders the server's reason verbatim (both blocks visible)", pt.includes("62816721") && pt.includes("62816722"));
  check("…says the order is still unpaid, no false promise", /still unpaid|remains unpaid/i.test(pt) && !/once the server can read it/i.test(pt));

  const unbound = view(base, { result: { txHash: HASH }, mark: { refused: "not a payment of this order: the order is unbound — it has no createdAtBlock", code: "unbound", paidOrderId: null } });
  const ut = strip(unbound);
  check("unbound (server-side): says the link cannot be settled and to ask the seller for a NEW link", /cannot be settled|can no longer be settled/i.test(ut) && /new (checkout )?link/i.test(ut));
}

section("10 — 🚨 an UNBOUND order (createdAtBlock null: the two pre-binding prod orders) offers NO seal");
{
  // The pay path sends FIRST and reports SECOND. If the seal were offered on an order the server will
  // refuse as unbound, the buyer's money would move and the order would never mark. So the refusal
  // must happen BEFORE the money: no seal, and the reason on the page.
  const m = view({ ...base, createdAtBlock: null });
  const t = strip(m);
  check("🚨 no seal button on an unbound order", !/class="emerald[^"]*"[^>]*>Pay /.test(m));
  check("⭐ says why: the link predates payment binding / cannot be settled, ask the seller for a new one", /cannot be settled|predates/i.test(t) && /new (checkout )?link/i.test(t));
  check("…still shows what / to whom / how much (door, not wall)", t.includes("Two coffees") && /1\.500000 USDC/.test(t));
  check("…no irreversibility hazard (nothing to decide)", !m.includes(IRREVERSIBLE_LINE));
  const bound = view(base);
  check("(a bound order still offers the seal)", /class="emerald[^"]*"[^>]*>Pay /.test(bound));
}

section("11 — 🚨 YOUR CHECKOUT LINKS (the merchant listing): rows per state; nothing invented; absence ≠ no orders");
{
  const ORIGIN = "https://app.tikpema.xyz";
  const row = (id: string, extra: any) => ({ ...base, id, ...extra });
  const orders = [
    row("o_mu8aqqbu_c87576aaf1375c4c", { status: "open", amountUsdc: "0.200000", description: "data", createdAt: "2026-09-19T10:00:00.000Z", createdAtBlock: 62906070 }),
    row("o_mu8hewk4_7b898539e3d371c9", { status: "paid", amountUsdc: "0.100000", description: "paid one", paidTx: HASH, paidAt: "2026-09-19T14:30:34.614Z", paidBy: AGENT, paidUnits: "100000", createdAtBlock: 62928454 }),
    row("o_mu8b5obw_4f194018540eb160", { status: "submitted", amountUsdc: "0.300000", description: "in flight", circleId: "circle-7", paidTx: null, createdAtBlock: 62907463 }),
    row("o_mu7d0000_0000000000000000", { status: "expired", amountUsdc: "0.400000", description: "stale", createdAtBlock: 62800000 }),
    row("o_mu7ju1sf_ae83dd7ebd87e0a5", { status: "open", amountUsdc: "0.150000", description: "legacy", createdAtBlock: null }),
  ];
  const listed = renderToStaticMarkup(<MerchantOrders origin={ORIGIN} state={{ state: "listed", orders, listedAt: "2026-09-19T15:00:00.000Z", truncated: false }} open onToggle={() => {}} onRefresh={() => {}} />);
  const lt = strip(listed);
  check("heading names the section", /Your checkout links/i.test(lt));
  check("⭐ every row: id, amount, description", orders.every((o) => listed.includes(o.id) && lt.includes(o.description) && lt.includes(`${Number(o.amountUsdc).toFixed(6)}`)), lt.slice(0, 200));
  const bound = orders.filter((o) => o.createdAtBlock !== null);
  check("⭐ every BOUND row carries its copyable link (origin + /#/pay?order=<id>); the unbound one does not", bound.every((o) => listed.includes(checkoutLink(ORIGIN, o.id))) && (listed.match(/\/#\/pay\?order=/g) || []).length === bound.length, `links=${(listed.match(/\/#\/pay\?order=/g) || []).length} bound=${bound.length}`);
  check("open row says open; expired row says expired; submitted row says submitted, NOT paid", /\bopen\b/i.test(lt) && /expired/i.test(lt) && /submitted/i.test(lt));
  check("⭐ the PAID row shows the hash AND an explorer link to THAT hash", lt.includes(HASH) && listed.includes(`${EXPL}/tx/${HASH}`));
  check("🚨 exactly ONE tx link on the page — no link without a hash (submitted has a circleId, not a tx)", (listed.match(/\/tx\//g) || []).length === 1);
  check("submitted row names the Circle id, not a tx", lt.includes("circle-7"));
  check("🚨 the UNBOUND legacy row says 'cannot be settled — make a new link' (the pay page's words)", /cannot be settled/i.test(lt) && /make a new link/i.test(lt));
  check("🚨 …and the legacy row offers NO copy of its link (a link nobody can pay is not shared)", (() => { const seg = listed.slice(listed.indexOf("o_mu7ju1sf_ae83dd7ebd87e0a5")); const next = seg.slice(1).search(/o_mu[0-9a-z]+_[0-9a-f]{16}/); const rowHtml = next > 0 ? seg.slice(0, next + 1) : seg; return !/>Copy</.test(rowHtml); })());
  check("⭐ a listed page STILL says a link made seconds ago may not be listed yet (the listing lags)", /seconds ago|may not be listed yet|can lag/i.test(lt));
  check("no seal-like button (nothing here moves money; no cancel either)", !/class="emerald/.test(listed) && !/cancel/i.test(lt));

  const empty = strip(renderToStaticMarkup(<MerchantOrders origin={ORIGIN} state={{ state: "listed", orders: [], listedAt: "2026-09-19T15:00:00.000Z", truncated: false }} open onToggle={() => {}} onRefresh={() => {}} />));
  check("🚨 EMPTY is never 'you have no orders': it says nothing is LISTED and that a recent link may be missing", /no checkout links listed|nothing listed/i.test(empty) && /may not be listed yet|seconds/i.test(empty) && !/you have no (orders|links)/i.test(empty), empty.slice(0, 220));
  check("🚨 …absence of a row is not absence of an order — said in those words", /absence of a row is not absence of an order/i.test(empty));
  check("…and offers Refresh", /Refresh/.test(empty));

  const unreadable = strip(renderToStaticMarkup(<MerchantOrders origin={ORIGIN} state={{ state: "unreadable", reason: "list down" }} open onToggle={() => {}} onRefresh={() => {}} />));
  check("🚨 UNREADABLE is distinct from empty: names the reason, does not say 'no links', offers Refresh", /could not be listed|couldn't list/i.test(unreadable) && unreadable.includes("list down") && !/no checkout links listed/i.test(unreadable) && /Refresh/.test(unreadable));
  const loading = strip(renderToStaticMarkup(<MerchantOrders origin={ORIGIN} state={{ state: "loading" }} open onToggle={() => {}} onRefresh={() => {}} />));
  check("LOADING says so and does not say empty", /Listing|Loading/i.test(loading) && !/no checkout links/i.test(loading));
  const truncated = strip(renderToStaticMarkup(<MerchantOrders origin={ORIGIN} state={{ state: "listed", orders, listedAt: "2026-09-19T15:00:00.000Z", truncated: true, total: 120 }} open onToggle={() => {}} onRefresh={() => {}} />));
  check("a truncated listing SAYS it is (newest 100 of 120)", /newest 100|of 120|not all/i.test(truncated));

  // the section is on #/sell for a signed-in merchant, below the form
  const w: any = { address: MERCHANT, agentWallet: { address: AGENT }, ensureSession: async () => "t", isAuthenticated: true };
  const page = renderToStaticMarkup(<SellPanel wallet={w} />);
  check("⭐ #/sell carries the section (below the Create control)", page.indexOf("Your checkout links") > page.indexOf("Create checkout link"));
  const out = strip(renderToStaticMarkup(<SellPanel wallet={{ ...w, address: null } as any} />));
  check("signed out → no listing section (nothing to list without a session)", !/Your checkout links/i.test(out));
}

section("12 — 🚨 the listing is COLLAPSIBLE: header count per state (honest), collapsed by default, expands, auto-expands after a create");
{
  const ORIGIN = "https://app.tikpema.xyz";
  const rows = [{ ...base, id: "o_mu8aqqbu_c87576aaf1375c4c", createdAtBlock: 1 }, { ...base, id: "o_mu8b3jz9_28071ae34b58668f", createdAtBlock: 2 }];
  const listed = { state: "listed", orders: rows, listedAt: "2026-09-19T15:00:00.000Z", truncated: false } as any;
  // ── the header text, pure ──
  check("⭐ listed → 'Your checkout links (2)'", listHeader(listed) === "Your checkout links (2)", listHeader(listed));
  check("🚨 loading → says listing, NO number", /listing/i.test(listHeader({ state: "loading" } as any)) && !/\d/.test(listHeader({ state: "loading" } as any)), listHeader({ state: "loading" } as any));
  check("🚨 unreadable → NO number at all (neither zero nor a total is known)", !/\d/.test(listHeader({ state: "unreadable", reason: "x" } as any)) && !/none/i.test(listHeader({ state: "unreadable", reason: "x" } as any)), listHeader({ state: "unreadable", reason: "x" } as any));
  check("⭐ empty → '(none listed yet)' — not '(0)', which would claim a known total", listHeader({ state: "listed", orders: [], listedAt: "t", truncated: false } as any) === "Your checkout links (none listed yet)");
  check("⭐ truncated → the STATED total, not 100", listHeader({ state: "listed", orders: rows, listedAt: "t", truncated: true, total: 120 } as any) === "Your checkout links (120)");
  check("truncated without a total → says 100+ , never a bare 100", /100\+/.test(listHeader({ state: "listed", orders: new Array(100).fill(rows[0]), listedAt: "t", truncated: true } as any)));

  // ── rendered: collapsed by default (open=false) hides the rows; open=true shows them ──
  const collapsed = renderToStaticMarkup(<MerchantOrders origin={ORIGIN} state={listed} open={false} onToggle={() => {}} onRefresh={() => {}} />);
  check("🚨 collapsed: the header is a button with aria-expanded=false, showing the count", /<button[^>]*aria-expanded="false"[^>]*>[^<]*Your checkout links \(2\)/.test(collapsed), collapsed.slice(0, 200));
  check("🚨 …and NO rows, no links, no lag line are rendered while collapsed", !collapsed.includes(rows[0].id) && !/\/#\/pay\?order=/.test(collapsed) && !/can lag/i.test(strip(collapsed)));
  const expanded = renderToStaticMarkup(<MerchantOrders origin={ORIGIN} state={listed} open onToggle={() => {}} onRefresh={() => {}} />);
  check("⭐ expanded: aria-expanded=true, the rows render exactly as before", /aria-expanded="true"/.test(expanded) && expanded.includes(rows[0].id) && expanded.includes(rows[1].id) && /can lag/i.test(strip(expanded)));
  const emptyCollapsed = renderToStaticMarkup(<MerchantOrders origin={ORIGIN} state={{ state: "listed", orders: [], listedAt: "t", truncated: false }} open={false} onToggle={() => {}} onRefresh={() => {}} />);
  const emptyOpen = strip(renderToStaticMarkup(<MerchantOrders origin={ORIGIN} state={{ state: "listed", orders: [], listedAt: "t", truncated: false }} open onToggle={() => {}} onRefresh={() => {}} />));
  check("⭐ empty collapsed: header says (none listed yet); the absence line is on EXPAND (pinned choice)", /none listed yet/.test(strip(emptyCollapsed)) && !/absence of a row/i.test(strip(emptyCollapsed)) && /absence of a row is not absence of an order/i.test(emptyOpen) && /may not be listed yet/i.test(emptyOpen));
  const unrOpen = strip(renderToStaticMarkup(<MerchantOrders origin={ORIGIN} state={{ state: "unreadable", reason: "list down" }} open onToggle={() => {}} onRefresh={() => {}} />));
  check("unreadable expanded still names the reason and offers Refresh", unrOpen.includes("list down") && /Refresh/.test(unrOpen));
  const loadingCollapsed = strip(renderToStaticMarkup(<MerchantOrders origin={ORIGIN} state={{ state: "loading" }} open={false} onToggle={() => {}} onRefresh={() => {}} />));
  check("loading collapsed: header says listing…, no number", /listing/i.test(loadingCollapsed) && !/\(\d+\)/.test(loadingCollapsed));

  // ── the page: collapsed by default on #/sell ──
  const w: any = { address: MERCHANT, agentWallet: { address: AGENT }, ensureSession: async () => "t", isAuthenticated: true };
  const page = renderToStaticMarkup(<SellPanel wallet={w} />);
  check("🚨 #/sell renders the listing COLLAPSED by default (aria-expanded=false)", /Your checkout links[^<]*<\/button>/.test(page) ? /aria-expanded="false"/.test(page) : /aria-expanded="false"/.test(page));

  // ── wiring that SSR cannot click: source pins ──
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/components/SellPanel.tsx", import.meta.url), "utf8");
  check("⭐ the header button toggles (onClick={onToggle})", /aria-expanded=\{open\}[\s\S]{0,200}onClick=\{onToggle\}|onClick=\{onToggle\}[\s\S]{0,200}aria-expanded=\{open\}/.test(src));
  check("⭐ a successful create AUTO-EXPANDS the listing (setListOpen(true) beside setCreated)", /setCreated\(\{ order: data\.order, path: data\.path \}\);[\s\S]{0,120}setListOpen\(true\)/.test(src));
  check("⭐ …and the created order is pinned at the TOP of the rows even before the listing catches up (dedupe by id)", /created\?\.order[\s\S]{0,300}orders\.some|withCreated|pinned/.test(src));
}

section("13 — 🚨 CANCEL: the pay page's cancelled state; the buyer whose transfer landed after the cancel; the merchant's control");
{
  const ORIGIN = "https://app.tikpema.xyz";
  // ── pay page: cancelled ──
  const c = view({ ...base, status: "cancelled", cancelledAt: "2026-09-19T18:00:00.000Z" });
  const ct = strip(c);
  check("🚨 cancelled → says the SELLER cancelled it and nothing can be paid; no seal; no hazard", /cancelled by the seller/i.test(ct) && /nothing can be paid|cannot be paid/i.test(ct) && !/class="emerald[^"]*"[^>]*>Pay /.test(c) && !c.includes(IRREVERSIBLE_LINE));
  check("…what / to whom / how much still render (door, not wall)", ct.includes("Two coffees") && /1\.500000 USDC/.test(ct));
  // ── the buyer whose transfer LANDED after the cancel: the 409 with a real hash on screen ──
  const late = view({ ...base, status: "cancelled" }, { result: { txHash: HASH }, mark: { refused: "not a payment of this order: the seller cancelled it before your payment was recorded", code: "cancelled", paidOrderId: null, lateReported: true } });
  const lt = strip(late);
  check("🚨 says the seller cancelled BEFORE the payment was recorded", /cancelled/i.test(lt) && /before your payment was recorded|before .* recorded/i.test(lt), lt.slice(0, 260));
  check("🚨 says the transfer DID go through and is in the seller's wallet — never 'nothing happened'", /did go through|went through|is in the seller/i.test(lt) && !/nothing was paid/i.test(lt));
  check("⭐ keeps the hash + explorer link on screen (the money is real and visible)", lt.includes(HASH) && late.includes(`${EXPL}/tx/${HASH}`));
  check("⭐ says Tikpema cannot reverse it and a refund is the seller sending it back", /cannot (be )?revers/i.test(lt) && /refund/i.test(lt) && /seller/i.test(lt));
  check("⭐ says the report was recorded for the seller (lateReported:true)", /recorded for the seller|the seller has been told|reported to the seller|seller will see/i.test(lt));
  check("🚨 …and does NOT say 'Do not pay again' or 'will show paid' (that is the unverified copy)", !/once the server can read it/i.test(lt));
  // ⭐ With a RESULT on screen the cancelled banner is suppressed: "Nothing can be paid on it" directly above a
  //    landed payment reads as a contradiction at exactly the moment the buyer is anxious. The receipt + the
  //    refusal copy tell the whole story. Without a result the banner must be there.
  check("🚨 WITH a result: the section does NOT render 'Nothing can be paid on it'", !/Nothing can be paid on it/i.test(lt));
  check("⭐ WITHOUT a result: it does", /Nothing can be paid on it/i.test(ct));

  // ── the merchant listing: Cancel control with inline confirm; cancelled row; late report ──
  const open = { ...base, id: "o_mu8aqqbu_c87576aaf1375c4c", status: "open", createdAtBlock: 62906070 };
  const paidRow = { ...base, id: "o_mu8hewk4_7b898539e3d371c9", status: "paid", paidTx: HASH, paidAt: "t", paidBy: AGENT, createdAtBlock: 1 };
  const sub = { ...base, id: "o_mu8b5obw_4f194018540eb160", status: "submitted", circleId: "circle-7", createdAtBlock: 1 };
  const cancelledRow = { ...base, id: "o_mu8b42ov_7fbce1bb9a3b862f", status: "cancelled", cancelledAt: "2026-09-19T18:00:00.000Z", createdAtBlock: 1, lateReport: null };
  const cancelledLate = { ...base, id: "o_mu8blkvc_eabf0202ebd465f0", status: "cancelled", cancelledAt: "2026-09-19T18:10:00.000Z", createdAtBlock: 1, lateReport: { txHash: HASH, by: "0x" + "77".repeat(20), at: "2026-09-19T18:12:00.000Z", verified: false } };
  const legacy = { ...base, id: "o_mu7ju1sf_ae83dd7ebd87e0a5", status: "open", createdAtBlock: null };
  const rows = [open, paidRow, sub, cancelledRow, cancelledLate, legacy];
  const render = (extra: any = {}) => renderToStaticMarkup(<MerchantOrders origin={ORIGIN} state={{ state: "listed", orders: rows, listedAt: "t", truncated: false }} open onToggle={() => {}} onRefresh={() => {}} onCancel={async () => {}} {...extra} />);
  const m = render();
  const rowOf = (id: string) => { const i = m.indexOf(id); const rest = m.slice(i + 1); const re = /o_mu[0-9a-z]+_[0-9a-f]{16}/g; let mm; while ((mm = re.exec(rest))) { if (mm[0] !== id) return m.slice(i, i + 1 + mm.index); } return m.slice(i); };
  check("⭐ an OPEN bound row has a 'Cancel link' control", /Cancel link/.test(strip(rowOf(open.id))));
  check("⭐ an UNBOUND legacy row has it too (cleanup)", /Cancel link/.test(strip(rowOf(legacy.id))));
  check("🚨 PAID has NO cancel control", !/Cancel link/.test(strip(rowOf(paidRow.id))));
  check("🚨 SUBMITTED has NO cancel control (money in flight)", !/Cancel link/.test(strip(rowOf(sub.id))));
  check("🚨 CANCELLED has NO cancel control; says Cancelled and when", !/Cancel link/.test(strip(rowOf(cancelledRow.id))) && /Cancelled/.test(strip(rowOf(cancelledRow.id))));
  check("🚨 a cancelled row offers NO link to share", !/\/#\/pay\?order=o_mu8b42ov/.test(rowOf(cancelledRow.id)));
  const lr = strip(rowOf(cancelledLate.id));
  check("🚨 the cancelled row WITH a late report warns: a payment was reported after cancel, NOT VERIFIED, check your wallet", /payment was reported/i.test(lr) && /not verified/i.test(lr) && /check your wallet/i.test(lr), lr.slice(0, 300));
  check("…names the reported hash and links the explorer (it IS a hash the buyer gave; the link lets the seller check)", lr.includes(HASH) && rowOf(cancelledLate.id).includes(`${EXPL}/tx/${HASH}`));
  check("…and says a refund may be owed", /refund/i.test(lr));
  // inline confirm: render with confirmingId set
  const confirming = render({ confirmingId: open.id });
  const cf = strip(confirming);
  check("⭐ the inline confirm names the consequence: link-holders see it as cancelled; a payment already sent cannot be undone", /Void this link|cancel this link/i.test(cf) && /cannot be undone|cannot be reversed/i.test(cf) && /see it as cancelled|cannot pay it/i.test(cf), cf.slice(cf.indexOf("Void"), cf.indexOf("Void") + 200));
  check("…with a Cancel and a Keep control, neither a seal", /<button[^>]*>[^<]*(Yes, cancel|Cancel it)/.test(confirming) && /<button[^>]*>[^<]*Keep/.test(confirming) && !/class="emerald/.test(confirming));
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0\n`);
