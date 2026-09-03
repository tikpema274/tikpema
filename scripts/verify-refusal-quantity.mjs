#!/usr/bin/env node
// verify-refusal-quantity.mjs — ⛔ A REFUSAL MESSAGE MUST REPORT THE QUANTITY THE TEST COMPARED,
// NOT THE QUANTITY THE USER TYPED. Where they differ, show BOTH and say which failed.
//
//   node --experimental-test-module-mocks scripts/verify-refusal-quantity.mjs
//   (also: npm run test:refusalquantity)   ·   --list prints every validation point found
//
// ═══ 🚨 THE THREE INSTANCES THAT SHARE THIS SHAPE ════════════════════════════════════════════
//   _budget.mjs:338  canSpend      test `Math.round(x*1e6) <= 0`, message "amount 0.0000001 must
//   _budget.mjs:702  canSpendDay   be > 0" — about a value that VISIBLY IS > 0.
//   _swap.mjs:413    approve gate  test compares `capBase < amountBase` in tokenIn base units, the
//                                  message printed the TYPED amount against the USDC cap. Two
//                                  quantities, neither of them an operand. NOW FIXED — section 4.
//
// ⛔ A REFUSAL THE CALLER CAN DISPROVE BY READING IT teaches them the service is broken, not that
// their amount was too small. For an autonomous agent it is worse than useless: it invites a retry
// of the identical request, because the stated reason is visibly not the case.
//
// ⚠️ AND IT IS NOT A COPY NIT. The comparison is on minor units because that is what the chain and
// the ledger use; the sentence is on the decimal because that is what was typed. Two representations
// of one quantity, validated in one place and reported in another — the same duplicate-source split
// `ub-withdraw` names in its own floor comment. [[duplicate-source-of-truth-is-the-recurring-bug]]
//
// ═══ ⭐ WHAT THE CHECK ACTUALLY IS ═══════════════════════════════════════════════════════════
// Not a phrase pin. A message is SELF-CONTRADICTORY when it asserts a bound AND prints a number
// that satisfies the bound it says was violated. That is mechanical, general, and it is the defect:
// `"amount 0.0000001 must be > 0"` fails it; `"amount 0.0000001 is below the smallest amount this
// token can move (0.000001)"` passes, because nothing in it is contradicted by 0.0000001.
//
// The census then answers the OTHER half — how many validation points exist, and how many are on
// the honest helper — because a contradiction check over three known sites proves nothing about the
// twenty it never looked at. [[refuted-by-what-you-read-not-what-you-failed-to-find]]

import { readdirSync, readFileSync } from "node:fs";
import { mock } from "node:test";

let pass = 0, fail = 0;
const fails = [];
const ok = (l, c, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; fails.push(l); console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
  return !!c;
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE CONTRADICTION CHECKER — the rule, as a function.
// ═════════════════════════════════════════════════════════════════════════════════════════════
/** Bounds a refusal can assert, paired with the predicate a printed number must NOT satisfy. */
const BOUND_CLAIMS = [
  { re: /must be\s*>\s*0|must be greater than zero|must be positive/i, satisfied: (n) => n > 0,
    says: "the value must be > 0" },
  { re: /is not a positive finite number|not a positive number/i, satisfied: (n) => Number.isFinite(n) && n > 0,
    says: "the value is not a positive finite number" },
  { re: /must be\s*>=?\s*0(?!\.)|must not be negative/i, satisfied: (n) => n >= 0,
    says: "the value must be >= 0" },
];

/**
 * ⭐ NUMBERS THAT ARE PART OF THE EXPLANATION ARE NOT THE SUBJECT. "below the smallest amount this
 * token can move (0.000001)" prints a positive number ON PURPOSE — it is the FLOOR, the quantity the
 * test compared against, and the sentence makes no claim that contradicts it. Only numbers the
 * message presents AS THE OFFENDING VALUE are judged, so the parenthesised floor and any named cap
 * are excluded first.
 * ⚠️ Without this the honest helper would fail the check written to protect it, and the guard would
 * be pushing every site back toward the copy it exists to remove.
 */
function contradictoryClaim(msg) {
  if (typeof msg !== "string" || !msg) return null;
  // ═══ ⭐⭐ THE HAVE/NEED SHAPE — a refusal whose own two numbers say it should have passed ═══════
  // "You have 2.05 USDC, need 2.05" is what `have 2.0549 / need 2.0512` renders as at 2dp on a 6-dp
  // token. Nothing in the SENTENCE is wrong; the ROUNDING made the printed quantities differ from
  // the compared ones, which is this file's rule stated in a second way. Rendering a requirement
  // DOWN and a balance UP is what closes it — see requiredAmount/availableAmount in formatAmount.ts.
  const have = /\bhave\s+~?\s*(-?\d+(?:\.\d+)?)/i.exec(msg);
  const need = /\bneed(?:s|ed)?\s+~?\s*(-?\d+(?:\.\d+)?)/i.exec(msg);
  if (have && need) {
    const h = Number(have[1]), n = Number(need[1]);
    if (Number.isFinite(h) && Number.isFinite(n) && h >= n) {
      return `prints "have ${h}" and "need ${n}" — the numbers say the refusal should not have fired`;
    }
  }
  const subject = msg
    .replace(/\([^)]*\)/g, " ")                       // parenthesised floors: "(0.000001)"
    .replace(/\b(?:limit|cap|ceiling|smallest|maximum|minimum)\b[^,;.]*/gi, " ") // named bounds
    .replace(/\bof\s+\d+(?:\.\d+)?(?:e-?\d+)?\s+\w+/gi, (m) => m);               // keep "of <n>"
  for (const claim of BOUND_CLAIMS) {
    if (!claim.re.test(msg)) continue;
    const nums = [...subject.matchAll(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)].map((m) => Number(m[0]));
    const offender = nums.find((n) => Number.isFinite(n) && claim.satisfied(n));
    if (offender !== undefined) {
      return `says "${claim.says}" while printing ${offender}, which satisfies it`;
    }
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("0 — ⭐⭐ THE CHECKER ITSELF, on known-good and known-bad copy");
// A contradiction checker that never fires is indistinguishable from a codebase with no
// contradictions. Both directions are pinned before it is trusted on real messages.
{
  ok("⛔ the ORIGINAL defect is caught", !!contradictoryClaim("amount 0.0000001 must be > 0"),
    contradictoryClaim("amount 0.0000001 must be > 0") || "NOT CAUGHT");
  ok("⛔ …and its canSpendDay twin", !!contradictoryClaim("amount 1e-7 must be > 0"));
  ok("⛔ …and the 'not a positive finite number' phrasing over a positive value",
    !!contradictoryClaim("amount 0.5 is not a positive finite number"));
  ok("⭐ the HONEST helper message passes — the floor in parentheses is not the offender",
    contradictoryClaim(
      "amountUsdc of 1e-7 is below the smallest amount this token can move (0.000001); it would execute as zero",
    ) === null,
    String(contradictoryClaim(
      "amountUsdc of 1e-7 is below the smallest amount this token can move (0.000001); it would execute as zero")));
  ok("⭐ a TRUE bound claim passes — 0 does not satisfy '> 0'",
    contradictoryClaim("amount must be greater than zero") === null);
  ok("⭐ …and so does a NaN refusal", contradictoryClaim("amountUsdc is not a number") === null);
  ok("⭐ a cap refusal that prints two numbers is not a contradiction",
    contradictoryClaim("amount 5 exceeds per-transaction limit of 2 USDC") === null,
    String(contradictoryClaim("amount 5 exceeds per-transaction limit of 2 USDC")));

  // ── the have/need shape, both directions ────────────────────────────────────────────────────
  ok("⛔ the ROUNDED insufficient-funds refusal is caught — 'have 2.05, need 2.05'",
    !!contradictoryClaim("Insufficient funds. You have 2.05 USDC, need 2.05."),
    contradictoryClaim("Insufficient funds. You have 2.05 USDC, need 2.05.") || "NOT CAUGHT");
  ok("⛔ …and the strictly-greater case, which is worse",
    !!contradictoryClaim("Insufficient USDC: need ~2.05 (stake + gas), have 2.09"));
  // ⚠️ THE REFUSAL FIRES WHEN need > have, SO `have` IS THE LOWER NUMBER. My first fixture here had
  //   them the other way round and the checker rejected it — correctly: that pair describes a state
  //   that would never have thrown. The checker caught the example, not the code.
  ok("⭐ the FULL-PRECISION version passes — the refusal is now legible as a refusal",
    contradictoryClaim("Insufficient funds. You have 2.051200 USDC, need 2.054900.") === null,
    String(contradictoryClaim("Insufficient funds. You have 2.051200 USDC, need 2.054900.")));
  ok("⭐ …and so does a genuine shortfall at 2dp, which must NOT be flagged",
    contradictoryClaim("You have 1.00 USDC, need 2.05") === null);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE CENSUS — every amount-validation point on the money surface, classified.
// ═════════════════════════════════════════════════════════════════════════════════════════════
const SURFACES = ["netlify/functions", "shared"];
const walk = (d) => readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
const files = SURFACES.flatMap(walk).filter((f) => /\.mjs$/.test(f) && !/-test\.mjs$/.test(f));

/** Line shapes that VALIDATE an amount before funds move. */
const VALIDATION = [
  /(?:amt|amount|value|units?|qty)[A-Za-z]*\s*(?:<=|<|>)\s*0\b/i,
  /Number\([^)]*(?:amount|amt)[^)]*\)\s*(?:<=|<|>)\s*0/i,
  /amountFloorViolation\s*\(/,
];
const HELPER = /amountFloorViolation\s*\(/;
/** A site that implements the minor-unit floor itself rather than importing it. */
const SELF_TEST = /(?:BigInt\()?Math\.round\([^)]*\*\s*(?:1e6|10\s*\*\*)/;

/**
 * DECLARED EXEMPTIONS — a validation point that guards a DIFFERENT QUANTITY, where the helper's
 * message would be wrong rather than merely differently worded. ⚠️ Each was READ before it was
 * written down, and each names the quantity.
 * ⛔ Keyed by a substring of the line, not a line number: line numbers drift and a drifted exemption
 * silently covers whatever moved into its place. A stale key fails.
 */
const EXEMPT = [
  { file: "netlify/functions/_swap.mjs", match: "cannot value",
    why: "DIFFERENT QUANTITY — a pricing precondition on an arbitrary token amount whose decimals " +
         "are unknown here; a 6-decimal floor would be a false claim about, say, an 18-dp token." },
  { file: "netlify/functions/user-swap-start.mjs", match: "cannot band a swap without a positive input value",
    why: "DIFFERENT QUANTITY — `amountInUsd` is the USDC-EQUIVALENT of a token amount, not the " +
         "amount the user typed. Same trap as _swap.mjs's approve gate." },
  { file: "netlify/functions/user-swap-start.mjs", match: "Enter an amount greater than 0.",
    why: "DIFFERENT DECIMALS — `amountIn` is denominated in tokenIn, which need not be 6-decimal. " +
         "The helper defaults to USDC_DECIMALS and would state a floor that is wrong for the token." },
  { file: "netlify/functions/agent-act.mjs", match: 'blocked: "amountIn must be > 0"',
    why: "DIFFERENT DECIMALS — the swap leg's tokenIn amount, same reason as user-swap-start." },
  { file: "netlify/functions/job-swap-approve.mjs", match: "proposal amount is not > 0",
    why: "DIFFERENT DECIMALS — re-checks a stored proposal's tokenIn amount at approval time." },
  { file: "netlify/functions/_analystb.mjs", match: "The proposed swap is not well-formed",
    why: "COMPOSITE GATE, NO FUNDS — one verdict over tokens AND amount, in the analyst that PRICES " +
         "a proposal. Splitting it to name the amount would change the refusal taxonomy for a path " +
         "that moves nothing." },
  { file: "netlify/functions/_analystb.mjs", match: "The proposed bridge has no valid amount",
    why: "NO FUNDS MOVE — analyst-side well-formedness before pricing; the executor's own floor is " +
         "what stands between a proposal and the chain." },
  { file: "netlify/functions/_analystb.mjs", match: "amountOut",
    why: "DIFFERENT QUANTITY — the venue's ESTIMATED OUTPUT, not an input the caller chose. " +
         "'Below the floor' would misdescribe a router that returned nothing usable." },
  { file: "netlify/functions/_proposal.mjs", match: "SWAP_ZERO_OUTPUT",
    why: "DIFFERENT QUANTITY — the estimate's output amount, as above." },
  { file: "netlify/functions/_bridge-record.mjs", match: 'typeof fee !== "number"',
    why: "NOT A GATE — a ratio helper that returns null on unusable inputs. It refuses to COMPUTE, " +
         "it does not refuse a caller, and it emits no message at all." },
  { file: "netlify/functions/_research.mjs", match: "advertised an unusable price",
    why: "DIFFERENT QUANTITY — a THIRD PARTY's advertised x402 price, already atomic and divided " +
         "down. The refusal quotes the raw advertised string, which is the quantity compared." },
  { file: "netlify/functions/_bridge.mjs", match: "Number.isFinite(fee)",
    why: "DIFFERENT QUANTITY — a joint amount+fee readability precondition, not an amount floor." },
  { file: "netlify/functions/_budget.mjs", match: "unusable amount",
    why: "DIFFERENT QUANTITY — an amount read back OUT of a stored audit entry during reversal. " +
         "There is no caller to advise and nothing to execute; it reports the stored value verbatim." },
  { file: "netlify/functions/_budget.mjs", match: "is not a positive finite number",
    why: "SAME QUANTITY, DIFFERENT TEST — canSpend's finiteness precondition, which fires ONLY for " +
         "non-finite or non-positive input. It cannot contradict itself: the floor case never " +
         "reaches it. Verified behaviourally in section 3." },
  { file: "netlify/functions/_user-bridge.mjs", match: 'code: "bad_amount"',
    why: "NO PROSE — returns a typed code plus the raw value as data. There is no sentence to " +
         "contradict, and the caller receives the quantity verbatim." },
  { file: "netlify/functions/_proposal.mjs", match: "BRIDGE_BAD_AMOUNT",
    why: "NO PROSE — a typed no-proposal code carrying the value as evidence." },
  { file: "netlify/functions/_proposal.mjs", match: "SWAP_BAD_AMOUNT",
    why: "NO PROSE — as above." },
  { file: "netlify/functions/_dca.mjs", match: "per-swap amount must be a positive number",
    why: "DIFFERENT DECIMALS — a DCA per-tick amount denominated in tokenIn, which the code's own " +
         "next comment notes may be EURC. A create-time convenience check; executeAction re-enforces " +
         "the live cap at every fill and the executor's floor is what guards the chain." },
  { file: "netlify/functions/agent-ub-deposit-background.mjs", match: "outside the per-deposit limit",
    why: "TWO CONDITIONS, ONE MESSAGE — `!(amount > 0) || amount > cap`. It already prints the " +
         "compared value and the cap; naming WHICH of the two failed is a real improvement and a " +
         "SEPARATE change, not a helper adoption." },
  { file: "netlify/functions/agent-act.mjs", match: "exceeds per-transaction limit",
    why: "TWO CONDITIONS, ONE MESSAGE — the send leg's twin of the above, same reasoning." },
];

// ⭐ RATCHET. Lower it when an exemption is retired; it may never be raised.
const MAX_EXEMPT = 20;

/**
 * ⛔ KNOWN INSTANCES OF THE CLASS THAT ARE **NOT FIXED**, declared so they cannot be forgotten.
 *
 * ⚠️ Entries here sit OUTSIDE the census population on purpose: the scan counts comparisons against
 * ZERO — one coherent quantity class — and a cap comparison between two derived quantities is not
 * something a floor regex would find. Widening the detector to every cap comparison would triple the
 * exemption table and bury the class.
 * ⭐ EMPTY IS A RESULT, NOT AN OMISSION. `_swap.mjs`'s approve gate was the one entry; it is fixed
 * and asserted in section 4, so it was REMOVED rather than left as a stale note. An empty list here
 * is checked for emptiness explicitly, so "nothing declared" cannot be confused with "nothing
 * looked at". [[unreconciled-marker-needs-a-real-observation]]
 */
const KNOWN_UNCONVERTED = [];
const points = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  lines.forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, "");
    // ⛔ An `import` line is not a validation point. Counting it would inflate "on the helper"
    //    with files that merely mention it — the census must count TESTS, not mentions.
    if (/^\s*import\b/.test(line)) return;
    if (!VALIDATION.some((re) => re.test(line))) return;
    // ⭐ THE EXEMPTION MATCHES A WINDOW, NOT THE LINE. The test and the sentence it produces are
    //    usually on different lines — that separation IS the defect class — so a key that only
    //    matched the `if` could never name the message it licenses.
    // ⚠️ NEAREST WINS, AND THE LINE ITSELF WINS OUTRIGHT. Two exemptions can both fall inside one
    //    window — canSpend's finiteness guard and the jobPrice guard are five lines apart — and
    //    first-in-array-order gave one point the OTHER's reason, which then reported the right
    //    exemption as stale. The nearest match is the one that describes this test.
    const window = lines.slice(i, i + 8);
    const here = EXEMPT.filter((e) => e.file === f && raw.includes(e.match));
    const near = EXEMPT
      .map((e) => ({ e, at: e.file === f ? window.findIndex((l) => l.includes(e.match)) : -1 }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at);
    const ex = here[0] ?? near[0]?.e ?? null;
    points.push({
      file: f, line: i + 1, text: raw.trim().slice(0, 110),
      klass: HELPER.test(line) ? "helper" : ex ? "exempt" : SELF_TEST.test(line) ? "self" : "offending",
      why: ex?.why ?? null,
    });
  });
}
// A self-testing site is one whose FILE implements the minor-unit floor near the point.
for (const p of points) {
  if (p.klass !== "offending") continue;
  const src = readFileSync(p.file, "utf8").split("\n");
  const near = src.slice(p.line - 1, p.line + 14).join("\n");
  if (SELF_TEST.test(near) && /too small|below the smallest|atomic unit/i.test(near)) p.klass = "self";
}

const byClass = (k) => points.filter((p) => p.klass === k);
console.log("\nverify-refusal-quantity — does every refusal report the quantity its test compared?");
console.log(
  `\n     files scanned ${files.length}  ·  validation points ${points.length}` +
  `  ·  on the helper ${byClass("helper").length}  ·  self-testing ${byClass("self").length}` +
  `  ·  exempt ${byClass("exempt").length}  ·  OFFENDING ${byClass("offending").length}`);
console.log(`     known-unconverted (declared, outside this population): ${KNOWN_UNCONVERTED.length}` +
  (KNOWN_UNCONVERTED.length ? ` — ${KNOWN_UNCONVERTED.map((k) => `${k.file} (${k.match})`).join(", ")}` : ""));
if (process.argv.includes("--list")) {
  for (const p of points) console.log(`     ${p.klass.padEnd(9)} ${p.file}:${p.line}  ${p.text}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — 🚨 EVERY validation point is on the helper, self-testing, or declared exempt");
{
  ok("⭐⭐ ZERO unclassified validation points",
    byClass("offending").length === 0,
    byClass("offending").map((p) => `${p.file}:${p.line}  ${p.text}`).join("\n      "));
  ok("the scan is non-empty and reaches the money path",
    points.length > 10 && points.some((p) => p.file === "netlify/functions/_budget.mjs"),
    `${points.length} points`);
  ok("⭐ the helper is actually in use — a census where nothing adopted it proves nothing",
    byClass("helper").length > 0, `${byClass("helper").length} on the helper`);
  const stale = EXEMPT.filter((e) => !points.some((p) => p.file === e.file && p.why === e.why));
  ok("⛔ no stale exemption — a declared licence nobody is using is where this table rots",
    stale.length === 0, stale.map((e) => `${e.file} :: ${e.match}`).join(" · "));
  ok(`⭐ the ratchet holds — ${EXEMPT.length} exemptions, ceiling ${MAX_EXEMPT}`,
    EXEMPT.length <= MAX_EXEMPT, `${EXEMPT.length} > ${MAX_EXEMPT}`);
  const missing = KNOWN_UNCONVERTED.filter((k) => !readFileSync(k.file, "utf8").includes(k.match));
  ok(KNOWN_UNCONVERTED.length === 0
      ? "⭐ the KNOWN-UNCONVERTED list is EMPTY — every named instance of the class is fixed"
      : `⛔ the ${KNOWN_UNCONVERTED.length} KNOWN-UNCONVERTED instance(s) still exist where declared`,
    missing.length === 0, missing.map((k) => `${k.file} :: ${k.match}`).join(" · "));
  ok("⭐ every exemption names the quantity it guards instead",
    EXEMPT.every((e) => /DIFFERENT|NO PROSE|NOT A GATE|NO FUNDS|COMPOSITE|TWO CONDITIONS|SAME QUANTITY/.test(e.why)),
    EXEMPT.filter((e) => !/DIFFERENT|NO PROSE|NOT A GATE|NO FUNDS|COMPOSITE|TWO CONDITIONS|SAME QUANTITY/.test(e.why))
      .map((e) => e.match).join(", "));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// BEHAVIOURAL — drive the real gates and read the real sentences.
// ═════════════════════════════════════════════════════════════════════════════════════════════
const origin = new Map();
const fakeStore = {
  async get(key, opts = {}) { const h = origin.get(key); return h ? { data: h, etag: "e" } : null; },
  async getWithMetadata(key) { const h = origin.get(key); return h ? { data: h, etag: "e" } : null; },
  async setJSON(key, value) { origin.set(key, JSON.stringify(value)); return { modified: true }; },
  async list() { return { blobs: [] }; },
};
mock.module("@netlify/blobs", {
  namedExports: { getStore: () => fakeStore, connectLambda: () => {}, getDeployStore: () => fakeStore },
});

const { canSpend, canSpendDay } = await import("../netlify/functions/_budget.mjs");
const { amountFloorViolation, FLOOR_CONSEQUENCE } = await import("../netlify/functions/_amount-floor.mjs");
const { validateStepShape } = await import("../netlify/functions/_actions.mjs");

const SUB_FLOOR = 0.0000001;
const OWNER = "0xrq0000000000000000000000000000000000001";

section("2 — ⛔ THE TWO SITES: the sentence now describes the comparison that failed");
{
  const day = await canSpendDay({ amountUsdc: SUB_FLOOR, owner: OWNER });
  ok("canSpendDay REFUSES a sub-floor amount", day.allowed === false, JSON.stringify(day));
  ok("⭐⭐ …and its reason is not self-contradictory",
    contradictoryClaim(day.reason) === null, `${day.reason}  ⟶  ${contradictoryClaim(day.reason)}`);
  ok("⭐ …it reports the FLOOR, which is the quantity the test compared against",
    /0\.000001/.test(day.reason || ""), day.reason);
  ok("⭐ …and the value the caller passed, so both quantities are visible",
    /1e-7|0\.0000001/.test(day.reason || ""), day.reason);
  ok("⭐⭐ …with the consequence stated for a GATE, not for an executor — nothing is signed here",
    day.reason === amountFloorViolation(SUB_FLOOR, { field: "amount", consequence: FLOOR_CONSEQUENCE.BUDGET }),
    day.reason);

  const buy = await canSpend({ jobId: "j1", jobPriceUsdc: 1, amountUsdc: SUB_FLOOR, owner: OWNER });
  ok("canSpend REFUSES a sub-floor amount", buy.allowed === false, JSON.stringify(buy));
  ok("⭐⭐ …and its reason is not self-contradictory either",
    contradictoryClaim(buy.reason) === null, `${buy.reason}  ⟶  ${contradictoryClaim(buy.reason)}`);

  // ⭐ THE PAIRWISE INEQUALITY. A gate that refused everything would satisfy every check above.
  const okDay = await canSpendDay({ amountUsdc: 0.000001, owner: OWNER });
  ok("⭐ …and exactly one minor unit is still ALLOWED — the floor is a floor, not a wall",
    okDay.allowed === true, JSON.stringify(okDay));
}

section("3 — ⭐ NO GATE ON THE MONEY PATH CONTRADICTS ITSELF, across the whole input range");
{
  // ⚠️ Every value a comparison-based guard has ever failed on, not only the interesting one.
  const INPUTS = [SUB_FLOOR, 0.0000004, 0, -1, NaN, undefined, "0.0000001"];
  let checked = 0, worst = null;
  for (const v of INPUTS) {
    for (const [name, r] of [
      ["canSpendDay", await canSpendDay({ amountUsdc: v, owner: OWNER })],
      ["canSpend", await canSpend({ jobId: "j", jobPriceUsdc: 1, amountUsdc: v, owner: OWNER })],
    ]) {
      if (r.allowed) continue;
      checked++;
      const bad = contradictoryClaim(r.reason);
      if (bad && !worst) worst = `${name}(${String(v)}): "${r.reason}" — ${bad}`;
    }
    for (const step of [
      { type: "transfer_usdc", to: `0x${"a".repeat(40)}`, amountUsdc: v },
      { type: "bridge_usdc", destination: "base", amountUsdc: v },
    ]) {
      const r = validateStepShape(step);
      if (typeof r !== "string") continue;
      checked++;
      const bad = contradictoryClaim(r);
      if (bad && !worst) worst = `validateStepShape(${step.type}, ${String(v)}): "${r}" — ${bad}`;
    }
  }
  ok(`⭐ ${checked} refusals were produced and read — a zero here would make the verdict vacuous`,
    checked >= 20, `${checked} refusals`);
  ok("⭐⭐ NONE of them asserts a bound its own printed value satisfies", worst === null, String(worst));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3b — ⛔ THE TWO have/need REFUSALS RENDER DIRECTIONALLY, not to nearest");
{
  // ⚠️ SOURCE, comment-stripped: these live in .ts and this suite is plain node. The BEHAVIOUR of the
  //   helpers is asserted in verify-amount-precision, which runs under tsx and imports them; what is
  //   checked here is that these two call sites actually reach them.
  const strip = (f) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, "");
  const SITES = [
    ["src/wallet/useModularWallet.ts", "Insufficient funds"],
    ["src/wallet/connectors/metamask.ts", "Insufficient USDC"],
  ];
  for (const [file, marker] of SITES) {
    const src = strip(file);
    ok(`⭐ ${file} still carries its insufficient-funds refusal`, src.includes(marker));
    ok(`⭐⭐ …and renders the NEED with requiredAmount (rounds up) and the BALANCE with ` +
      `availableAmount (rounds down)`,
      /requiredAmount\(/.test(src) && /availableAmount\(/.test(src), file);
    ok(`⛔ …and no longer rounds either side to NEAREST with toFixed(2)`,
      !/toFixed\(2\)/.test(src.slice(Math.max(0, src.indexOf(marker) - 400), src.indexOf(marker) + 400)),
      "a nearest-rounded pair is what produced 'have 2.05, need 2.05'");
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3c — 🚨 THE have/need CENSUS — the shape §3b fixed at TWO sites, counted everywhere");
{
  // ═══ ⛔⛔ A DETECTOR BLIND TO ITS OWN REPAIR GOES GREEN ON THE NEXT INSTANCE ═══════════════
  // The first version of this scan read ONE LINE AT A TIME. It found 4 of 6 sites, and the two it
  // missed were missed for a reason worth writing down: **the fix splits the string across a `+`**,
  // so a one-line scan cannot see a sentence the repair itself made two lines long. The detector
  // would have gone green on every future instance repaired the same way — and looked thorough.
  // ⭐ Same family as esbuild FOLDING a concatenated template back into one (2026-09-03, the deploy
  // probe): both are source-level assumptions about how text is laid out, and both were wrong — in
  // opposite directions. A minifier joins what you split; a line scanner splits what you joined.
  // ⭐ So the scan reads a WINDOW, and the anchor accepts EITHER half of the pair: `metamask.ts`
  // says "need ~X … have Y", need first, and an anchor demanding `have` on the opening line missed
  // it entirely. Two blind spots, both found by widening rather than by the assertions.
  // ⚠️ WHY THIS SECTION EXISTS. §3b pins the two CLIENT sites by name. That is a guard against the
  //   instances already fixed, and it is exactly the shape this file's header warns about: on
  //   2026-09-03 the morning fix touched `useModularWallet` and `metamask` because that is where I
  //   had looked, and FIVE server functions carried the identical defect. A named-site check could
  //   never have found them. So the population is now scanned and its denominator printed.
  const SURF = ["netlify/functions", "shared", "src"];
  const files = SURF.flatMap(walk).filter((f) => /\.(mjs|ts|tsx)$/.test(f) && !/\.d\.mts$/.test(f));
  // A user-facing string that puts a BALANCE and a REQUIREMENT in one sentence.
  const PAIR = /[Hh]ave|holds/;
  const NEED = /\bneed\b/;
  const sites = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    // ⚠️ A WINDOW, NOT A LINE. My first version matched one line at a time and found FOUR sites —
    //    because the fix itself splits these strings across a `+`, and a one-line scan cannot see a
    //    sentence that spans two. A detector blind to the shape its own repair produces would go
    //    green on the next instance. [[a-check-whose-failure-mode-is-a-pass]]
    const lines = src.split("\n").map((l) => l.replace(/^\s*\/\/.*$/, ""));
    lines.forEach((line, i) => {
      const win = lines.slice(i, i + 3).join(" ");
      // ⭐ ANCHOR ON EITHER HALF. metamask.ts says "need ~X … have Y" — need FIRST — so an
      //   anchor that demanded `have` on the opening line missed it entirely.
      if (!/[`"']/.test(line) || !(PAIR.test(line) || NEED.test(line))) return;
      if (!PAIR.test(win) || !NEED.test(win) || !/\$\{/.test(win)) return;
      if (i > 0 && (PAIR.test(lines[i - 1]) || NEED.test(lines[i - 1])) &&
          PAIR.test(lines.slice(i - 1, i + 2).join(" ")) && NEED.test(lines.slice(i - 1, i + 2).join(" "))) return; // one hit per sentence
      sites.push({ file: f, line: i + 1, text: lines.slice(i, i + 2).join(" ").trim().slice(0, 110),
                   nearest: /toFixed\(\s*[0-4]\s*\)/.test(win) });
    });
  }
  const rounded = sites.filter((s) => s.nearest);
  console.log(`     have/need sites ${sites.length}  ·  nearest-rounded ${rounded.length}  ·  directional ${sites.length - rounded.length}`);
  if (process.argv.includes("--list")) for (const s of sites) console.log(`     ${s.nearest ? "NEAREST " : "ok      "} ${s.file}:${s.line}  ${s.text}`);

  ok("⭐ the scan finds the population at all — a zero here would be the guard, not the estate",
    sites.length >= 5, `${sites.length} sites`);
  ok("⭐⭐ NO have/need refusal rounds its figures to NEAREST — a shortfall must never render as equal",
    rounded.length === 0,
    rounded.map((s) => `${s.file}:${s.line}  ${s.text}`).join("\n      "));
  ok("⭐ …and the two the morning fix named are still in the population, not special-cased",
    sites.some((s) => s.file.includes("useModularWallet")) && sites.some((s) => s.file.includes("metamask")),
    sites.map((s) => s.file).join(", "));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⭐⭐ THE SWAP CAP GATE: both quantities, from the OPERANDS, with the direction named");
{
  const { swapCapRefusal } = await import("../netlify/functions/_swap.mjs");
  // ⚠️ COMMENTS OUT FIRST. The block above the gate QUOTES the sentence it replaced, as a
  //   tombstone — and a source scan that reads comments flags the tombstone and can never go green.
  //   Second time this exact trap has bitten a guard in this session; the denial and the tombstone
  //   are the same shape. [[assert-on-rendered-output-not-source-regex]]
  const swapSrc = readFileSync("netlify/functions/_swap.mjs", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "");

  // The realistic case: 9.5 EURC against a 10 USDC cap, EURC above parity. 9.5 < 10 as bare
  // numbers, which is exactly why the old sentence read as a broken gate.
  const m = swapCapRefusal({ token: "EURC", amountBase: 9500000n, capBase: 9128884n, capUsdc: 10, unitUsd: 1.0955 });

  ok("⛔ it is not self-contradictory", contradictoryClaim(m) === null, `${m} ⟶ ${contradictoryClaim(m)}`);
  ok("⭐ BOTH quantities appear — the amount and the cap AS CONVERTED",
    m.includes("9.5 EURC") && m.includes("9.128884 EURC"), m);
  ok("⭐ …and the cap in its own currency, so the reader sees where 10 came from",
    m.includes("10 USDC"), m);
  ok("⭐⭐ it says WHICH failed, in the caller's own units",
    /THE AMOUNT IS WHAT FAILED/.test(m) && /9\.5 EURC is more than the cap allows/.test(m), m);
  ok("⭐⭐ …and that the CAP IS SET IN USDC, not in the token being spent",
    /THE CAP IS SET IN USDC/.test(m) && /NOT IN EURC/.test(m), m);
  ok("⭐⭐ …and names the conversion DIRECTION — the cap was converted, the amount was not",
    /CAP was converted into EURC/.test(m) && /the amount was not converted/.test(m), m);
  ok("⭐ the rate that produced the converted operand is shown",
    /1 EURC = 1\.0955 USDC/.test(m), m);

  // ═══ ⭐⭐⭐ THE VALUE COMES FROM THE COMPARISON, NOT FROM A SECOND CONVERSION ═══════════════
  // Fed an INCONSISTENT triple — a capBase that is NOT ceil(capUsdc / unitUsd) — a message that
  // recomputed the conversion at render would print its own number. One that renders the OPERAND
  // prints the operand. Nothing else discriminates between the two implementations.
  const inconsistent = swapCapRefusal({
    token: "EURC", amountBase: 9500000n, capBase: 1234567n, capUsdc: 10, unitUsd: 1.0955,
  });
  ok("⭐⭐⭐ the converted cap is the OPERAND `capBase`, not a re-derivation of capUsdc/unitUsd",
    inconsistent.includes("1.234567 EURC") && !inconsistent.includes("9.128884"), inconsistent);

  // …and the same for the amount: `amountBase` is what the `if` compared; `amountIn` is what was
  // typed. They differ whenever the caller types more precision than the token can hold.
  const rounded = swapCapRefusal({
    token: "EURC", amountBase: 9500000n, capBase: 9128884n, capUsdc: 10, unitUsd: 1.0955,
  });
  ok("⭐⭐ the amount is rendered from `amountBase` — the compared value, not the typed decimal",
    rounded.includes("9.5 EURC"), rounded);

  // ⛔ AND THE INVERSE CONVERSION IS NOT EMITTED. amountBase * unitUsd = 10.40725 would be a second
  // source of truth for the same relationship, and a different operation from the gate's divide.
  ok("⛔ the amount's USDC-equivalent is NOT printed — that would be the second derivation",
    !m.includes("10.40725") && !m.includes("10.407"), m);

  // The USDC case: no conversion happened, so no rate sentence may claim one.
  const same = swapCapRefusal({ token: "USDC", amountBase: 12000000n, capBase: 10000000n, capUsdc: 10, unitUsd: 1 });
  ok("⭐ a USDC swap gets NO conversion clause — nothing was converted, so nothing is explained",
    !/converted/.test(same) && /directly comparable/.test(same), same);
  ok("  …and still shows both quantities and which failed",
    same.includes("12 USDC") && same.includes("10") && /THE AMOUNT IS WHAT FAILED/.test(same), same);

  // ── the binding at the call site ────────────────────────────────────────────────────────────
  ok("⭐⭐ the gate HANDS OVER its operands rather than the typed amount",
    /swapCapRefusal\(\{\s*\n?\s*token: tIn, amountBase, capBase, capUsdc: swapCapUsdc\(\), unitUsd,/.test(swapSrc),
    "the throw must pass amountBase and capBase");
  ok("⛔ …and `amountIn` no longer appears in the cap refusal",
    !/exceeds the per-swap cap \(\$\{swapCapUsdc\(\)\}/.test(swapSrc) &&
    !/swap amount \(\$\{amountIn\}/.test(swapSrc),
    "the old two-quantity sentence is still in the source");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
const total = pass + fail;
console.log("\n" + "─".repeat(92));
console.log(`${fail === 0 ? "✅" : "❌"} verify-refusal-quantity — ${pass}/${total} passed, ${fail} failed`);
if (fail) {
  console.log(`\n   FAILED: ${fails.join(" · ")}`);
  console.log(`\n   ⛔ A refusal must report the quantity the TEST compared. Where the tested quantity`);
  console.log(`      and the typed one differ — minor units vs decimals, USDC-equivalent vs token —`);
  console.log(`      show BOTH and say which failed. If the site guards a different quantity than the`);
  console.log(`      floor helper does, declare it in EXEMPT and name that quantity.`);
}
console.log("─".repeat(92) + "\n");
process.exit(fail === 0 ? 0 : 1);
