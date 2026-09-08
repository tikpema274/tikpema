// verify-receive-and-paylink.tsx — ONE receiving address, and a payment link that cannot pre-authorise.
//
//   npx tsx scripts/verify-receive-and-paylink.tsx        (also: npm run test:receive)
//
// ⛔ TWO PROPERTIES, AND BOTH ARE ABOUT MONEY GOING SOMEWHERE THE USER DID NOT MEAN.
//
// 1. RECEIVE SHOWS EXACTLY ONE ADDRESS, AND IT IS THE USER'S OWN WALLET. This app has three
//    pockets and only TWO are addresses: "Your wallet" (✅), the agent's SPENDING FLOAT, and the
//    unified balance — which is NOT AN ADDRESS AT ALL (USDC enters it via a `depositFor` call, so
//    a transfer cannot reach it; that trap already earned its own "not a deposit address"
//    caution). A picker over three pockets with different rules is the choice that produces the
//    wrong answer. [[a-category-label-became-a-position]]
//
// 2. A PAYMENT LINK IS ATTACKER-SUPPLIED INPUT. `#/send?to=…&amount=…` PREFILLS a form the user
//    reads and submits; it never pre-authorises a destination. The recipient must stay VISIBLE and
//    EDITABLE, and the screen must SAY the values came from a link — a reader who assumes they
//    typed them is exactly the reader a link can rob.
//    [[manual-send-confirmation-names-nothing]]
//
// ⚠️ THE QR IS ASSERTED ON ITS PAYLOAD, NOT ITS PIXELS. It renders synchronously to inline SVG for
// exactly this reason: an async/canvas QR is invisible to renderToStaticMarkup, and the payload —
// which address it encodes — is the part that can be wrong.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import ReceivePanel from "../src/components/ReceivePanel";
import { paymentLinkParams } from "../src/components/SendPanel";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
  .replace(/\s+/g, " ").trim();

const USER  = "0x" + "ab".repeat(20);
const AGENT = "0x" + "cd".repeat(20);
const wallet = (address: string | null = USER): any => ({
  address, usdcBalance: "12.3456", busy: false, isAuthenticated: !!address,
  agentWallet: { address: AGENT, balance: "5.0" },
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⛔ RECEIVE SHOWS THE USER'S WALLET, AND ONLY THAT");
{
  const html = renderToStaticMarkup(<ReceivePanel wallet={wallet()} />);
  const t = text(html);
  check("the panel renders", /Get paid in USDC/.test(t));
  check("⭐ the user's own address is shown", html.includes(USER));
  check("🚨 the AGENT wallet address is NOT shown", !html.includes(AGENT),
    "the agent float is not a receiving address — money sent there lands in the wrong pocket");
  check("⭐⭐ exactly ONE address appears in the whole panel",
    (html.match(/0x[0-9a-fA-F]{40}/g) || []).filter((a, i, s) => s.indexOf(a) === i).length === 1,
    JSON.stringify((html.match(/0x[0-9a-fA-F]{40}/g) || []).filter((a, i, s) => s.indexOf(a) === i)));
  check("⛔ there is no pocket PICKER", !/select|<option/i.test(html));
  // ⚠️ FULL, NOT MASKED — AddressDisplay masks by default and that is right where an address is
  // incidental. Here it is the content: a masked address cannot be read aloud, compared against
  // what the sender typed, or checked against the QR. Verification defends against substitution.
  check("⭐⭐ the address is shown in FULL, not masked", !/0x[0-9a-fA-F]{4}…/.test(text(html)),
    "a masked address on a receive screen cannot be verified by the person about to send to it");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⚠️ THE CHAIN CAVEAT IS THE SAFETY CONTENT");
{
  const t = text(renderToStaticMarkup(<ReceivePanel wallet={wallet()} />));
  check("🚨 names the chain AND the token", /USDC on Arc only/.test(t));
  check("⭐ warns it LOOKS like an Ethereum address", /looks like an Ethereum address and is not one/.test(t));
  check("⭐⭐ states the consequence — not recoverable", /cannot be recovered/.test(t),
    "a caveat without a consequence reads as pedantry and gets skipped");
  check("⭐ says which pocket the money lands in", /lands in your own wallet/.test(t));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐ THE QR ENCODES THE ADDRESS, AND IS ASSERTABLE");
{
  const html = renderToStaticMarkup(<ReceivePanel wallet={wallet()} />);
  check("a QR renders as inline SVG (sync, so it exists server-side)", /<svg[^>]*role="img"/.test(html));
  check("⭐ it has a path with modules drawn", /<path d="M[^"]{20,}"/.test(html));
  check("⭐ it is labelled for screen readers", /aria-label="QR code for your receiving address"/.test(html));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⛔ NO ADDRESS → NO QR, AND IT SAYS WHY");
{
  const html = renderToStaticMarkup(<ReceivePanel wallet={wallet(null)} />);
  const t = text(html);
  check("🚨 no QR is rendered", !/<svg[^>]*role="img"/.test(html),
    "an empty or placeholder QR is a control the user cannot act on");
  check("⭐ it explains the state", /no address to show yet/.test(t));
  check("⭐ …and offers the way out", /Wallet/.test(t));
  check("⛔ the two states differ — a collapse would pass a presence-only test",
    renderToStaticMarkup(<ReceivePanel wallet={wallet()} />) !== html);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — ⛔ THE PAYMENT LINK PARSES, AND REFUSES MALFORMED INPUT");
{
  const ok = paymentLinkParams("#/send?to=" + USER + "&amount=5&note=coffee");
  check("⭐ a valid link yields to + amount + note",
    ok.to === USER && ok.amount === "5" && ok.note === "coffee", JSON.stringify(ok));
  check("🚨 a MALFORMED address is DROPPED, never half-parsed",
    paymentLinkParams("#/send?to=0xnope&amount=5").to === undefined,
    "a truncated address in a field the user then submits is worse than no prefill");
  check("🚨 a non-address string is dropped", paymentLinkParams("#/send?to=vitalik.eth").to === undefined);
  for (const [label, q] of [["zero", "amount=0"], ["negative", "amount=-5"], ["NaN", "amount=abc"], ["empty", "amount="]]) {
    check(`⛔ a ${label} amount is dropped, not coerced`, paymentLinkParams("#/send?" + q).amount === undefined);
  }
  check("⭐ no query string → nothing prefilled", JSON.stringify(paymentLinkParams("#/send")) === "{}");
  check("⭐ a note is length-capped", (paymentLinkParams("#/send?note=" + "x".repeat(500)).note || "").length === 120);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — ⛔⛔ THE LINK PREFILLS; IT NEVER PRE-AUTHORISES");
{
  const src = readFileSync("src/components/SendPanel.tsx", "utf8");
  check("⭐ the recipient input is bound to editable state, not to the link",
    /value=\{to\}/.test(src) && /onChange=\{[^}]*setTo/.test(src),
    "the recipient must stay editable — a hidden destination is the whole attack");
  check("⭐⭐ the link is read ONCE at mount, not re-applied over user edits",
    /useState\(\(\) =>\s*paymentLinkParams/.test(src));
  check("🚨 the screen SAYS the form was filled from a link",
    /Filled in from a payment link/.test(src));
  check("⭐ …and tells the reader to check the values, naming why",
    /anyone can create a link/.test(src));
  check("⛔ nothing auto-submits from a link",
    !/useEffect\([^)]*send\(\)/.test(src), "a link that sends on open would be catastrophic");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6b — ⭐ THE WAY OUT TO SEND — NAVIGATION, NEVER AN ACTION");
{
  const html = renderToStaticMarkup(<ReceivePanel wallet={wallet()} />);
  check("a Send control exists on the receive page", /Send instead/.test(text(html)));
  check("⭐ it targets the SEND route", /\/send/.test(readFileSync("src/components/ReceivePanel.tsx", "utf8")));
  check("⛔⛔ it does NOT move money — no send call on this page",
    !/agent-send|\bsend\(\)/.test(readFileSync("src/components/ReceivePanel.tsx", "utf8")),
    "a receive screen must not be able to spend");
  // ⚠️ It must not out-shout the address, which is the page's whole content.
  check("⭐ it is NOT the primary emerald action",
    !/className="emerald"[^>]*>\s*Send instead/.test(html) && !/emerald/.test(html),
    "a primary button here would read as 'the thing to do on this screen'");
  // ⛔ Absent when there is nothing to receive to — a nav control on a dead-end state.
  check("⛔ it is absent in the signed-out state, like everything else on this page",
    !/Send instead/.test(text(renderToStaticMarkup(<ReceivePanel wallet={wallet(null)} />))));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — ⛔ THE ENTRY POINT SITS UNDER THE RIGHT CLAIM");
{
  // 🚨 THE DEFECT THIS PINS. The Receive card was first placed beside Vault, inside the "Move money
  // out" plane — under a heading reading "This leaves you." Money ARRIVING is not money leaving.
  // Presence is not enough: POSITION decides which claim a card sits under, which is why
  // verify-dashboard-copy already asserts the money groups with indexOf.
  const dash = readFileSync("src/components/Dashboard.tsx", "utf8").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");
  const iIn  = dash.indexOf("Move money between your accounts");
  const iOut = dash.indexOf("Move money out");
  const iRcv = dash.indexOf('title="Receive"');
  check("the route exists and the card links to it", iRcv >= 0 && /go\("receive"\)/.test(dash));
  check("⛔⛔ Receive sits in the INBOUND group, ABOVE 'Move money out'",
    iIn >= 0 && iOut > iIn && iRcv > iIn && iRcv < iOut,
    `inbound@${iIn} receive@${iRcv} out@${iOut}`);
  check("⭐ …and the card repeats the chain caveat, where the decision is made",
    /USDC on Arc\s*only/.test(dash));
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money, zero network.`);
process.exit(fail === 0 ? 0 : 1);
