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
import SellPanel, { SellResult, checkoutLink } from "../src/components/SellPanel";

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

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0\n`);
