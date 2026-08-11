#!/usr/bin/env node
// verify-subject-preview.mjs — the 402's pre-payment coverage disclosure.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════════════════════════
// Measured 2026-08-11: a no-bytecode address was sold a report covering ONE catalogue item, at full
// price. The terms did warn that thin coverage still settles — but a buyer decides from the 402, and
// "could check little" reads as "occasionally fewer checks", not "one item". The seller could tell in
// advance (eth_getCode is one call, and the subject is named in the request) and did not say.
//
// ⭐⭐ THE LOAD-BEARING ASSERTION: an UNREADABLE bytecode read must render as an explicit UNKNOWN —
// never as "has code", never as a coverage prediction, and never as reassurance. A new field is a new
// place for absence to read as safety, which is THE recurring failure family in this codebase.

import {
  SUBJECT_CODE, readSubjectCode, subjectPreview, challenge402, ddPaymentRequirements,
} from "../../netlify/functions/_dd-x402.mjs";
import { POWER_SIGS } from "../../shared/onchain-facts/index.mjs";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  cond ? pass++ : fail++;
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);

const GROUPS = Object.keys(POWER_SIGS).length;

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  402 SUBJECT PREVIEW — informed consent before payment               ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("1 — readSubjectCode is TRI-STATE and never throws");
{
  const noCode = await readSubjectCode({ rpcCall: async () => "0x", address: "0x" + "1".repeat(40) });
  check("empty bytecode → NO_CODE", noCode.state === SUBJECT_CODE.NO_CODE, `codeLen ${noCode.codeLen}`);

  const hasCode = await readSubjectCode({ rpcCall: async () => "0x6080604052", address: "0x" + "2".repeat(40) });
  check("non-empty bytecode → HAS_CODE", hasCode.state === SUBJECT_CODE.HAS_CODE, `codeLen ${hasCode.codeLen}`);

  // Every failure shape must land on UNREADABLE, not throw and not masquerade.
  const throws = await readSubjectCode({ rpcCall: async () => { throw new Error("RPC down"); }, address: "0x" + "3".repeat(40) });
  check("⭐ an RPC THROW → UNREADABLE (never propagates)", throws.state === SUBJECT_CODE.UNREADABLE);
  const garbage = await readSubjectCode({ rpcCall: async () => ({ nonsense: true }), address: "0x" + "4".repeat(40) });
  check("a malformed node reply → UNREADABLE", garbage.state === SUBJECT_CODE.UNREADABLE);
  const nullish = await readSubjectCode({ rpcCall: async () => null, address: "0x" + "5".repeat(40) });
  check("a null reply → UNREADABLE", nullish.state === SUBJECT_CODE.UNREADABLE);
  const badAddr = await readSubjectCode({ rpcCall: async () => "0x", address: "not-an-address" });
  check("a malformed subject address → UNREADABLE (no read attempted)", badAddr.state === SUBJECT_CODE.UNREADABLE);
  const missing = await readSubjectCode({ rpcCall: async () => "0x" });
  check("a MISSING address → UNREADABLE", missing.state === SUBJECT_CODE.UNREADABLE);
  // eth_getCode result can arrive wrapped; both shapes must work or a live read silently degrades.
  const wrapped = await readSubjectCode({ rpcCall: async () => ({ result: "0x" }), address: "0x" + "6".repeat(40) });
  check("a {result} wrapper is unwrapped", wrapped.state === SUBJECT_CODE.NO_CODE);
}

section("2 — 🚨 THE UNREADABLE PREVIEW MUST NOT READ AS SAFE");
{
  const p = subjectPreview({ address: "0x" + "7".repeat(40), code: { state: SUBJECT_CODE.UNREADABLE, detail: "x" } });
  check("⭐⭐ hasCode is NULL — not true, not false", p.hasCode === null, JSON.stringify(p.hasCode));
  check("⭐⭐ expectedCoverage is NULL — never a prediction", p.expectedCoverage === null);
  check("⭐ it says UNKNOWN in words", /UNKNOWN/i.test(p.detail));
  check("⭐⭐ it explicitly denies meaning 'has code'", /NOT a statement that the\s+address has code/i.test(p.detail.replace(/\s+/g, " ")));
  check("⭐⭐ it explicitly denies meaning 'full coverage'", /NOT a prediction of full coverage/i.test(p.detail));
  check("⭐ it names the minimal case as still consistent", /no-code address .* is entirely consistent/i.test(p.detail));
  check("it does NOT claim reassurance", !/(safe|fine|no issues|clean)/i.test(p.detail));
  check("a quote-time read failure does NOT imply a refund", p.stillCharged === true && /no effect on billing/i.test(p.stillChargedWhy));
  check("  …and is distinguished from an ANALYSIS-time failure, which IS free",
    /not the same as the engine failing during analysis/i.test(p.stillChargedWhy));
}

section("3 — the NO-CODE preview states the floor, derived not transcribed");
{
  const p = subjectPreview({ address: "0x" + "8".repeat(40), code: { state: SUBJECT_CODE.NO_CODE, codeLen: 0, detail: "" } });
  check("hasCode false", p.hasCode === false);
  check("expectedCoverage MINIMAL", p.expectedCoverage === "MINIMAL");
  check(`⭐ the group count is DERIVED from POWER_SIGS (${GROUPS}), not hardcoded`,
    p.detail.includes(String(GROUPS)));
  check("⭐ it says the caller IS still charged", p.stillCharged === true);
  check("⭐ …and why: nothing-to-check is an ANSWER", /is an ANSWER about the/i.test(p.stillChargedWhy));
  check("it advises checking the address first", /check the address\s+before paying/i.test(p.stillChargedWhy.replace(/\s+/g, " ")));
}

section("4 — the HAS-CODE preview must NOT over-promise");
{
  const p = subjectPreview({ address: "0x" + "9".repeat(40), code: { state: SUBJECT_CODE.HAS_CODE, codeLen: 163, detail: "" } });
  check("hasCode true", p.hasCode === true);
  check("⭐⭐ coverage is NOT predicted high — bytecode ≠ good coverage",
    p.expectedCoverage === "NOT PREDICTED");
  check("⭐ it names what can still be missed", /prox/i.test(p.detail) && /unreadable/i.test(p.detail));
  check("it reports the measured code length", p.codeLen === 163);
}

section("5 — PREDICTED vs MEASURED: reuse the bridge vocabulary, don't invent a dialect");
{
  for (const st of [SUBJECT_CODE.NO_CODE, SUBJECT_CODE.HAS_CODE, SUBJECT_CODE.UNREADABLE]) {
    const p = subjectPreview({ address: "0x" + "a".repeat(40), code: { state: st, codeLen: 1, detail: "" } });
    check(`[${st}] basis is "predicted"`, p.basis === "predicted");
    check(`[${st}] observedAt is quote-time`, p.observedAt === "quote-time");
    check(`[${st}] ⭐ names the delivered manifest as MEASURED and authoritative`,
      /MEASURED value and is\s+the authority/i.test(p.authority.replace(/\s+/g, " ")));
    check(`[${st}] ⭐ says the manifest WINS on disagreement`, /the manifest wins/i.test(p.authority));
  }
}

section("6 — the 402 body: floor and flat-price rationale travel TOGETHER");
{
  const req = ddPaymentRequirements({ resource: "https://x/y", payTo: "0x" + "b".repeat(40) });
  const body = JSON.parse(challenge402({ requirements: req }).body);
  const w = body.whatYouAreBuying;

  check("coverage still says 'not a clean bill'", /not a clean bill/i.test(w.coverage));
  check("⭐⭐ coverage now states the FLOOR", /FLOOR IS LOW/i.test(w.coverage));
  check(`  …with the group count derived (${GROUPS})`, w.coverage.includes(String(GROUPS)));
  check("  …and says it is the SAME full price", /same full price/i.test(w.coverage));
  check("  …and points at subjectPreview", /subjectPreview/.test(w.coverage));

  check("⭐⭐ priceIsFlat EXISTS and is buyer-facing", typeof w.priceIsFlat === "string" && w.priceIsFlat.length > 100);
  check("⭐⭐ …and gives the INCENTIVE argument, the strongest thing we can say",
    /incentive to overstate/i.test(w.priceIsFlat));
  check("  …naming that the buyer cannot audit coverage pre-purchase",
    /cannot independently audit/i.test(w.priceIsFlat));

  check("⭐⭐ notCharged distinguishes NOTHING-to-check from COULD-NOT-check",
    /NOTHING to check/i.test(w.notCharged) && /COULD NOT check/i.test(w.notCharged));
  check("  …says thin coverage alone is NEVER a refund reason",
    /never a refund reason/i.test(w.notCharged));
  check("  …and a broken instrument ALWAYS is", /broken instrument always is/i.test(w.notCharged));
}

section("7 — the preview is OPTIONAL and its absence is not a silent 'fine'");
{
  const req = ddPaymentRequirements({ resource: "https://x/y", payTo: "0x" + "c".repeat(40) });
  const without = JSON.parse(challenge402({ requirements: req }).body);
  check("no preview key when none was formed", without.subjectPreview === undefined);
  check("⭐ but the FLOOR is still disclosed unconditionally",
    /FLOOR IS LOW/i.test(without.whatYouAreBuying.coverage));
  check("  …and so is the flat-price reasoning", /incentive to overstate/i.test(without.whatYouAreBuying.priceIsFlat));

  const withP = JSON.parse(challenge402({
    requirements: req,
    preview: subjectPreview({ address: "0x" + "d".repeat(40), code: { state: SUBJECT_CODE.NO_CODE, codeLen: 0, detail: "" } }),
  }).body);
  check("preview appears when supplied", withP.subjectPreview?.hasCode === false);
  check("⭐ the priced terms are UNCHANGED by the preview — disclosure, not price",
    withP.accepts[0].maxAmountRequired === without.accepts[0].maxAmountRequired
      && withP.accepts[0].maxAmountRequired === "60000");
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
