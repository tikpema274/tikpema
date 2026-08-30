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
import WalletGuardNotice from "../src/components/WalletGuardNotice";
// ⭐⭐ THE CUSTODY SENTENCE IS NOT RESTATED HERE. It is rendered from CustodyNotice and the panel's
// output is asserted to CONTAIN it, so the expected text is COMPOSED from the same source that
// produces the real text. A hardcoded regex would go red when the sentence changed even though this
// panel was still correct — and worse, it drifted: this suite family once carried TWO different
// regexes for one sentence, the weaker of which matched either wording and detected neither.
// The WORDING is asserted once, in verify-custody-notice.tsx, which also demonstrates this property.
import CustodyNotice from "../src/components/CustodyNotice";

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

// ═══ ⭐⭐ BOTH DIRECTIONS OF THE MID-MARKET SENTENCE ════════════════════════════════════════════
// 🚨 THIS SECTION EXISTS BECAUSE A DEFECT SHIPPED AND NO SUITE COULD SEE IT. Every fixture above is
// POSITIVE (0.0312, 0.03, 0.14, 0.07), so the sentence was never rendered with a NEGATIVE implied
// loss — the state where its wording failed. "below" was hardcoded while the number carried its own
// sign, so a real −11.64% rendered as "is -11.64% below the mid-market value": an 11.64% GAIN
// displayed as a loss. Observed live on the EURC→USDC run.
// ⭐ The old assertion ("the implied loss is stated as a percentage") passed on the broken output —
// which is why the fix is asserted as DIRECTION IN WORDS + MAGNITUDE ALWAYS POSITIVE, in both
// directions, rather than as a single string. [[state-behind-a-transition-is-untested-by-default]]
console.log("\n⭐⭐ THE MID-MARKET SENTENCE READS CORRECTLY IN BOTH DIRECTIONS");
{
  const at = (il: number, extra: any = {}) => strip(renderToStaticMarkup(
    <SwapReview decoded={decoded(OWNER)} owner={OWNER} tokenIn="USDC" tokenOut="EURC"
      amountIn={1} band="none" impliedLoss={il} secondsLeft={500} {...extra} />));

  const pos = at(0.0422);
  check("POSITIVE → says 'below'", /4\.22% below the mid-market value/i.test(pos));
  check("⛔ …and never 'above'", !/above the mid-market/i.test(pos));

  // ⭐ THE FIXTURE THAT DID NOT EXIST: the real value from the live EURC→USDC run.
  const neg = at(-0.1164);
  check("⭐⭐ NEGATIVE → says 'above' (this is the defect that shipped)", /11\.64% above the mid-market value/i.test(neg));
  check("⛔ …and never 'below'", !/below the mid-market value/i.test(neg));
  check("🚨 …and renders NO minus sign in the sentence", !/-\s*11\.64%/.test(neg));
  // ⚠️ SENTENCE-SCOPED, NOT A BARE SUBSTRING. `/11\.64%/` also matches "-11.64%", so the naive form
  // PASSED against the pre-fix copy while the two checks above went red — a weak assertion sitting
  // among strong ones and looking like coverage. Extract the sentence and read the token it renders.
  const magnitude = (t: string) => (t.match(/That guarantee is\s+(-?[\d.]+%)/) ?? [])[1];
  check("⭐ the magnitude token itself carries NO sign, either way",
    magnitude(neg) === "11.64%" && magnitude(pos) === "4.22%", `neg=${magnitude(neg)} pos=${magnitude(pos)}`);

  // Boundary: exactly zero must not read as "above".
  check("zero reads as 'below' (the boundary is not ambiguous)", /0\.00% below the mid-market value/i.test(at(0)));

  // ⭐ The advisory is ADVISORY: it appears on the flag, and it never appears without it.
  const flagged = at(-0.1164, { rateCheckUnreliable: true });
  check("⭐ far-above + flag → says the CHECK is unreliable, not that the deal is good",
    /could not price-check this swap/i.test(flagged) && !/bargain|good deal|in your favour/i.test(flagged));
  check("⭐ …and points at what IS still enforced", /still enforced on-chain/i.test(flagged));
  check("⛔ …and it is ABSENT without the flag", !/could not price-check/i.test(neg));
  check("⛔ …and it is NOT a gate — no acknowledgement control appears with it",
    !/I understand/i.test(flagged));
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
  // ⭐ COMPOSED, not restated. 🚨 THIS is the assertion that used to be the WEAK regex
  // /spending caps do not apply here/i — weakened to accommodate this panel's divergent wording,
  // so it passed against either and detected neither. ⚠️ NO token prop: a swap spends USDC OR EURC.
  check("renders the shared custody notice (caps do not apply)",
    t.includes(strip(renderToStaticMarkup(<CustodyNotice />))));
  // ⛔ REMOVED, not relaxed: this asserted /this is your wallet and your money/ — a fragment of the
  // DIVERGENT wording this panel used to carry on its own. That claim now lives in CustodyNotice
  // ("not a limit on your own funds") and is asserted ONCE, in verify-custody-notice.tsx §1.
  // Re-asserting it here would rebuild the duplication the composed binding above just removed.
  check("⭐ the TITLE distinguishes it from the agent panel", /Swap from your own wallet/i.test(t));
  check("it says the user pays the gas (the agent panel is gasless)", /you pay the gas/i.test(t));
  check("it links back to the capped agent panel", /agent wallet/i.test(t));
}

// 🚨 THIS BLOCK USED TO ASSERT THE WRONG PAIR, AND IT PASSED WHILE THE DEFECT SHIPPED.
// It compared `activeKind:"modular"` against `activeKind:"metamask"` with a missing capability —
// two states that DID differ — while the state that actually collapsed was
// `metamaskConnected:true, activeKind:"modular"` versus `metamaskConnected:false`, which rendered
// BYTE-IDENTICALLY. A guard that exercises a neighbouring pair proves nothing about the pair that
// broke. ⭐ Non-collapse is now asserted PAIRWISE over all three states in verify-custody-notice §6,
// and this suite asserts only the BINDING — that the panel renders the shared guard with the right
// props — with the expected text COMPOSED from the component rather than restated.
console.log("\n⚠️ THE PANEL DELEGATES ITS WALLET GUARD (states asserted in verify-custody-notice §6)");
{
  const g = (mmConnected: boolean, active: boolean) => strip(renderToStaticMarkup(
    <WalletGuardNotice metamaskConnected={mmConnected} active={active}
      verb="swap" twinLabel="Swap" twinRoute="/swap" />));
  const notConnected = strip(renderToStaticMarkup(<ManualSwapPanel wallet={wallet("modular", { metamaskConnected: false })} />));
  const connectedInactive = strip(renderToStaticMarkup(<ManualSwapPanel wallet={wallet("modular", { metamaskConnected: true })} />));
  check("⭐ renders the shared guard in the not-connected state", notConnected.includes(g(false, false)));
  check("⭐⭐ …and the CONNECTED-BUT-NOT-ACTIVE state — the pair that collapsed",
    connectedInactive.includes(g(true, false)));
  check("🚨 …and the two are NOT identical", notConnected !== connectedInactive);
  check("⛔ the panel offers no signing control in either state",
    !/Get quote/i.test(notConnected) && !/Get quote/i.test(connectedInactive));
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
  // ⭐ COMPOSED IN THE NEGATIVE TOO. A hardcoded regex here went RED under validation 1 when the
  // shared sentence changed, even though this panel was still correct — the same false failure the
  // positive assertion was composed to avoid. Non-inclusion of the RENDERED notice is the property.
  // ⚠️ Composed, with a stated residual: this proves SwapPanel does not carry the CANONICAL notice,
  // not that it could never phrase an absence some other way. That broader property is not
  // mechanically checkable, and the hardcoded version did not check it either.
  check("⛔ …and it never carries the custody notice ITSELF", !t.includes(strip(renderToStaticMarkup(<CustodyNotice />))));
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
