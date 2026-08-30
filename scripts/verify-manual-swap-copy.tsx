// verify-manual-swap-copy.tsx — WHAT THE MANUAL SWAP PANEL ACTUALLY SAYS, rendered.
//
//   npx tsx scripts/verify-manual-swap-copy.tsx      (also: npm run test:manualswapcopy)
//
// ═══ 🚨 THE CLAIM THIS PANEL CARRIES THAT NO OTHER PANEL DOES ══════════════════════════════════
// ⭐⭐ IT SHOWS THE USER WHERE THEIR MONEY GOES, IN FULL, BECAUSE METAMASK CANNOT.
// The adapter does not bind payer to beneficiary (measured), and the signing prompt renders an
// opaque contract call. This panel is the ONLY surface on which a wrong destination is visible.
// ⛔ So the full address — not a truncation — is asserted here. `0x6Fb2…FC58` beside `0xdEaD…1234`
// is not a comparison a human can make; the whole point is that a mismatch is READABLE.
//
// ⛔ AND "AGENT CAPS DO NOT APPLY" — it sits one route from a panel where they DO, and silence
// reads as capped.
//
// ⚠️ RENDERED, NOT GREPPED. A gated state that only appears after a live quote is a state no test
// ever sees — which is why SwapReview is exported pure and rendered here with real numbers.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import ManualSwapPanel, { SwapReview } from "../src/components/ManualSwapPanel";
import SwapPanel from "../src/components/SwapPanel";
import type { DecodedSwap } from "../src/lib/decodeSwapCalldata";
import { CONTRACTS } from "../src/config/contracts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const strip = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const OWNER = "0x6Fb28d6366E755E0E27307692282490C6682FC58";
const ATTACKER = "0xDeAdbEeF00000000000000000000000000001234";
const decoded = (beneficiary: string): DecodedSwap => ({
  beneficiary, minTokenOut: 809669n, deadline: 1788094956n, amountIn: 1000000n,
  // ⭐ FROM THE APP'S OWN CONSTANT, never restated here — one source of truth for a contract
  // address. (It also stops gitleaks' generic-api-key rule firing on a `tokenOut: "0x…"` literal,
  // which it does regardless of case — but the reason to do it is the duplication, not the scanner.)
  tokenIn: CONTRACTS.USDC,
  tokenOut: CONTRACTS.EURC,
});
const wallet = (kind: string, over: any = {}) => ({
  activeKind: kind, address: OWNER, usdcBalance: "12.00",
  manualSwap: kind === "metamask" ? async () => ({}) : undefined,
  waitForSwapReceipt: kind === "metamask" ? async () => ({}) : undefined,
  refreshEurcBalance: kind === "metamask" ? async () => "5.00" : undefined,
  ensureSession: async () => "t", refreshBalance: async () => "12.00",
  ...over,
}) as any;

console.log("\n⭐⭐ THE REVIEW STEP — rendered with real numbers (the state a live quote would reach)");
{
  const t = strip(renderToStaticMarkup(
    <SwapReview decoded={decoded(OWNER)} owner={OWNER} tokenIn="USDC" tokenOut="EURC"
      amountIn={1} band="none" impliedLoss={0.0312} secondsLeft={540} />));
  check("⭐ the beneficiary appears IN FULL, not truncated", t.includes(OWNER));
  check("⭐ the user's OWN address appears too, so the two can be compared", t.split(OWNER).length - 1 >= 2);
  check("it says the address was read from the transaction data, not the quote",
    /read from the transaction data itself, not from the quote/i.test(t));
  check("⭐ the FLOOR is stated as a guarantee, with its figure", /guaranteed at least/i.test(t) && t.includes("0.809669"));
  check("the amount being spent is stated", t.includes("1.000000") && t.includes("USDC"));
  check("the implied loss is stated as a percentage", t.includes("3.12%"));
  check("the expiry is shown as a countdown", /expires in/i.test(t) && t.includes("540s"));
  check("⛔ NO internal band enum leaks into the prose",
    !/\bnone\b/i.test(t) && !/\backnowledge\b/i.test(t) && !/\bwarn\b/i.test(t));
  check("a matching wallet is confirmed in words", /this is your wallet/i.test(t));
}

console.log("\n🚨 A FOREIGN BENEFICIARY IS VISIBLE ON SCREEN, not merely caught in code");
{
  const t = strip(renderToStaticMarkup(
    <SwapReview decoded={decoded(ATTACKER)} owner={OWNER} tokenIn="USDC" tokenOut="EURC"
      amountIn={1} band="none" impliedLoss={0.03} secondsLeft={500} />));
  check("⭐ the FOREIGN address is printed in full", t.includes(ATTACKER));
  check("⭐ it is called out as NOT the user's wallet", /NOT your wallet/i.test(t));
  check("the user's own address is still shown beside it", t.includes(OWNER));
}

console.log("\n⚠️ THE BANDS SAY SOMETHING DIFFERENT FROM EACH OTHER, and neither names the enum");
{
  const at = (band: any) => strip(renderToStaticMarkup(
    <SwapReview decoded={decoded(OWNER)} owner={OWNER} tokenIn="USDC" tokenOut="EURC"
      amountIn={1} band={band} impliedLoss={band === "acknowledge" ? 0.14 : 0.07} secondsLeft={500} />));
  const none = at("none"), warn = at("warn"), ack = at("acknowledge");
  check("`warn` adds a caution the neutral state does not", warn.length > none.length && /noticeably below/i.test(warn));
  check("`acknowledge` says something DIFFERENT from `warn`, not just louder",
    /large share/i.test(ack) && !/large share/i.test(warn));
  check("⛔ neither leaks the enum", !/acknowledge/i.test(ack.replace(/I understand/g, "")) && !/\bwarn\b/i.test(warn));
}

console.log("\n⛔ CAPS — stated, because silence beside a capped panel reads as capped");
{
  const t = strip(renderToStaticMarkup(<ManualSwapPanel wallet={wallet("metamask")} />));
  check("the panel says agent caps DO NOT apply", /spending caps do not apply here/i.test(t));
  check("it names whose money this is", /this is your wallet and your money/i.test(t));
  check("⭐ the TITLE distinguishes it from the agent panel", /Swap from your own wallet/i.test(t));
  check("it says the user pays the gas (the agent panel is gasless)", /you pay the gas/i.test(t));
  check("it links back to the capped agent panel", /agent wallet/i.test(t));
}

console.log("\n⚠️ THE NON-METAMASK STATES DIFFER FROM EACH OTHER (the two-state collapse defect)");
{
  const notConnected = strip(renderToStaticMarkup(<ManualSwapPanel wallet={wallet("modular")} />));
  const connectedNoCap = strip(renderToStaticMarkup(
    <ManualSwapPanel wallet={wallet("metamask", { manualSwap: undefined })} />));
  check("a non-MetaMask wallet is told it needs MetaMask", /needs MetaMask/i.test(notConnected));
  check("⭐ a CONNECTED-but-unable wallet gets a DIFFERENT message", notConnected !== connectedNoCap);
  check("…and that message says to reconnect", /reconnect metamask/i.test(connectedNoCap));
}

// ⭐⭐ SwapPanel IS RENDERED HERE, NOT GREPPED — and it is declared against this suite in
// guard-registry.mjs for that reason. It stopped being claim-free the moment it grew a cap sentence
// and a link to its uncapped twin, which is the SAME staleness recorded above SendPanel in that
// file. 🚨 §2 of gate:registry did NOT catch it: its CLAIM vocabulary has no "cap"/"limits apply",
// so a money claim written in those words is invisible to the detector. Found by reading.
// ⛔ The pair only works together — ManualSwapPanel says caps do NOT apply, SwapPanel says they DO.
// An absence stated against silence teaches the reader nothing, so both halves live in one file.
console.log("\n⭐⭐ THE AGENT PANEL — RENDERED, because it now carries a cap claim of its own");
{
  const t = strip(renderToStaticMarkup(<SwapPanel wallet={wallet("modular", {
    agentWallet: { address: OWNER, balance: "12.00", eurcBalance: "5.00" }, swapFromAgent: async () => ({}),
  })} />));
  check("⭐ it STATES that caps DO apply (the other half of the pair)", /within your per-transaction and daily safety caps/i.test(t));
  check("⭐ its title names WHICH wallet", /Swap from your agent wallet/i.test(t));
  check("it offers the uncapped twin in words a user can act on", /Swap from your own wallet instead/i.test(t));
  // ⚠️ NOT `!/do not apply/` — that phrase DOES appear here, correctly, describing the TWIN
  // ("…where those caps do not apply"). The distinction that matters is WHO the absence is claimed
  // about: this panel must never claim it about ITSELF. `here` is the word that does that work, and
  // it is the exact phrasing ManualSwapPanel uses for its own uncapped state.
  check("⛔ …and it never claims the absence about ITSELF", !/caps do not apply here/i.test(t));
  check("⭐ …while the twin's absence IS attributed to the twin", /those caps do not apply/i.test(t));
}

console.log("\n⭐ ROUTE + REDIRECT (a live route nothing links to is invisible)");
{
  const src = readFileSync(new URL("../src/components/SwapPanel.tsx", import.meta.url), "utf8");
  check("SwapPanel links to #/swap-manual", src.includes('"/swap-manual"'));
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  check("the route exists in App.tsx", app.includes('case "swap-manual"'));
  const toml = readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
  check("🚨 the API redirect exists (a missing one 404s the panel)", toml.includes('from = "/api/user-swap-start"'));
  check("…and it is status 200, not a 301 that would break the POST",
    /from = "\/api\/user-swap-start"\s*\n\s*to = "[^"]+"\s*\n\s*status = 200/.test(toml));
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money, zero network.`);
process.exit(fail === 0 ? 0 : 1);
