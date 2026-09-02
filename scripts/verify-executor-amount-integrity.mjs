// verify-executor-amount-integrity.mjs — THE VALUE EXECUTED IS THE VALUE CAPPED AND AUDITED.
//
//   node scripts/verify-executor-amount-integrity.mjs   (also: npm run test:amountintegrity)
//
// ═══ 🚨 THE INVARIANT, AND WHY IT IS NOT A PRECISION RULE ══════════════════════════════════════
// Three boundaries passed `.toFixed(2)` to a fund-moving executor while the per-action cap, the day
// ceiling and `recordAgentSpend` all used the UNROUNDED value.
//
// ⛔ toFixed ROUNDS. 1.237 executed as 1.24 — MORE than requested, MORE than the cap was checked
// against, MORE than the audit row recorded. Every such execution moved more than the ledger says,
// so the daily ceiling permitted more total movement than it was configured for, by up to
// 0.005 USDC per action, silently and cumulatively. That is a CAP-INTEGRITY defect that happened to
// look like a formatting one.
//
// ═══ 📏 READ FROM THE LIVE LEDGER, 2026-09-02 — read-only, `data-budget` ═══════
// 305 keys / 282 entries across BOTH record shapes (`audit:<owner>:<date>:<id>` objects AND the
// legacy `audit:log` ARRAY, which holds 72 of them and was missed on the first pass). 0 unreadable.
//
// 5 entries from a boundary that was rounding carry more than 2dp. ⛔ THAT IS EVIDENCE THAT
// SUB-CENT VALUES WERE ROUTINE ON THE MONEY PATH — nothing more. It is NOT a measurement of what
// the chain received, and an earlier version of this comment claimed it was, headlined as a
// +0.002941 USDC over-send. WITHDRAWN: all five are `swap_tokens`, where the ledger records
// `valueInUsdc(tokenIn, amountIn)` and the defect rounded `step.amountIn` — different quantities.
// `step.amountIn` is persisted nowhere, so the historical divergence is UNMEASURED.
//
// ⚠️ THE 18 SUB-CENT ROWS ARE STILL THE SHARPER RESULT, and that one is unaffected: 0.0001 under
// toFixed(2) is 0.00 — an ERASURE, not a rounding. They were spared only because the researcher
// pays through `payX402` in `_research.mjs`, which is not one of these boundaries. ⛔ A fact about
// today's call graph, not a safety property. See verify-amount-zero-floor for the guard that is.
//
// ⛔ AND THIS DOES NOT GREP FOR toFixed. A grep finds one spelling. `Math.round(x*100)/100`,
// `Number(x.toPrecision(3))`, a `parseFloat` through a formatter — all reintroduce it wearing a
// different name. This asserts the SHAPE at each boundary: the amount argument must be the step's
// own value, not an expression that transforms it.

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } return !!c; };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// ⭐ EVERY FUND-MOVING EXECUTOR, by the function that moves the money. Derived by walking call
// sites, not by grepping a defect spelling.
const EXECUTORS = ["agentSwap", "agentPay", "ubSpend", "agentBridge", "vaultDeposit", "vaultWithdraw"];
const FILES = ["netlify/functions/_actions.mjs", "netlify/functions/agent-ub-spend.mjs"];

/** The amount-bearing argument names an executor may receive. */
const AMOUNT_ARG = /^\s*(amountIn|amountUsdc|amountMinor|shares|payAmountUsdc)\s*:\s*(.+?),?\s*$/;

/** ⛔ Any expression that TRANSFORMS the amount rather than passing it. Not a toFixed grep: this
 *  is the class — anything that is not a bare reference or a String()/Number() of one. */
function transforms(expr) {
  const e = expr.trim().replace(/\s+/g, " ");
  if (/^String\([A-Za-z_$][\w$.?]*\)$/.test(e)) return false;   // String(step.amountIn)
  if (/^[A-Za-z_$][\w$.?]*$/.test(e)) return false;             // amount, step.amountUsdc
  if (/^[A-Za-z_$][\w$.?]*\.toString\(\)$/.test(e)) return false; // bal.raw.toString()
  if (/^[A-Za-z_$][\w$.?]*\s*\?\?\s*undefined$/.test(e)) return false;
  return true;                                                   // toFixed, Math.round, arithmetic…
}

// ═══ ⛔ SECTION 3 IS A CLASS CHECK, BECAUSE SECTIONS 1–2 ARE AN INCLUDE-LIST ═══════
// EXECUTORS above is a list of FUNCTION NAMES. `transfer_usdc` does not call any of them: it hands
// USDC to Circle directly via `createContractExecutionTransaction` with `transfer(address,uint256)`.
// 🚨 PROVEN, not suspected — rounding transfer_usdc's amount passed the name-based check at 28/0.
// A seventh fund-moving boundary was invisible to a check whose whole subject is fund-moving
// boundaries, because it was enumerated by NAME and the name was new.
//
// ⭐ So this section asks a question that does not mention any executor: WHEREVER THE CODE READS AN
// AMOUNT OFF THE STEP, is that read untransformed? Every money path must read the amount somewhere,
// so a new boundary is covered the moment it exists — it cannot be forgotten from a list, because
// there is no list.
const AMOUNT_FIELDS = ["amountUsdc", "amountIn", "payAmountUsdc"];

// ⚠️ A READ IS NOT ALWAYS A SPEND. `amountFloorViolation(step.amountUsdc)` reads the amount to
// JUDGE it and returns a refusal reason — no value flows onward to an executor. Such consumers are
// exempt, but the exemption is itself checked below: a name here that no longer exists, or that
// starts returning a number, would silently cover a real transform.
// ⛔ THIS IS THE ONE PLACE A NAME LIST IS ALLOWED, so it is kept to consumers that RETURN A REASON.
const REASON_RETURNING = {
  amountFloorViolation: "returns a refusal string or null — never a value that is executed",
};

// ⛔⛔ THIS EXTRACTOR WAS WRONG ONCE ALREADY, IN THE SAME WAY THE 14-LINE WINDOW WAS.
// Its first version grew RIGHT from the read and stopped at the first `)`. For
// `Number(Number(step.amountUsdc).toFixed(2))` that put `.toFixed(2)` OUTSIDE the expression it
// examined — it saw the inner `Number(...)`, called it a cast, and passed the mutation at 33/0.
// ⭐ The lesson repeated: an extractor that looks at PART of an expression fails by finding
// something innocent, and something innocent reads as clean. Take the WHOLE value expression.

// ⛔⛔ THIS EXTRACTOR WAS WRONG TWICE BEFORE IT WAS RIGHT, BOTH TIMES THE SAME WAY.
//   1. A fixed 14-line window put `amountIn:` outside it — restoring toFixed PASSED at 19/0.
//   2. A hand-rolled expression parser grew RIGHT from the read and stopped at the first `)`, so in
//      `Number(Number(step.amountUsdc).toFixed(2))` the `.toFixed(2)` sat OUTSIDE what it examined.
//      It saw the inner cast, called it clean, and PASSED the transfer_usdc mutation at 33/0.
//
// ⭐⭐ BOTH FAILURES ARE ONE FAILURE: an extractor that looks at PART of an expression fails by
// finding something innocent, and something innocent reads as clean. Each fix made the parser
// cleverer and handed it a new place to be quietly wrong.
//
// ⭐ SO THIS DOES NOT PARSE. It takes the whole statement and asks whether a numeric transform sits
// in it alongside the read. COARSE ON PURPOSE: it cannot mistake a fragment for the whole, and when
// it is wrong it is wrong LOUDLY — a false positive names a line a human can look at, where a false
// negative names nothing at all.
//
// ⛔ ITS LIMIT, WRITTEN DOWN RATHER THAN DISCOVERED LATER: a transform applied to an ALIAS in a
// LATER statement (`const a = step.amountUsdc;` … `foo(a.toFixed(2))`) is invisible here. Section 2
// covers that for the named executors; on a direct-to-Circle path it is uncovered, and the zero
// floor is what stands between an aliased transform and an execution of nothing.
const TRANSFORMS = [
  ".toFixed(", ".toPrecision(", "Math.round(", "Math.floor(", "Math.ceil(",
  "parseFloat(", "parseInt(", ".toLocaleString(",
];

/** The whole statement a read sits in — previous `;`/`{`/`}` to the next, never a fragment. */
function statementAround(src, at) {
  let start = at;
  while (start > 0 && !/[;{}]/.test(src[start - 1])) start--;
  let end = at;
  while (end < src.length && !/[;{}]/.test(src[end])) end++;
  return src.slice(start, end + 1);
}

section("3 — ⛔ NO READ OF A STEP AMOUNT IS TRANSFORMED (a class check, not a name list)");
let reads = 0;
const violations = [];
for (const f of FILES) {
  const src = read(f);
  for (const field of AMOUNT_FIELDS) {
    const re = new RegExp(`step\\.${field}\\b`, "g");
    let m;
    while ((m = re.exec(src))) {
      const lineStart = src.lastIndexOf("\n", m.index) + 1;
      const before = src.slice(lineStart, m.index);
      if (before.includes("//") || before.trimStart().startsWith("*")) continue;
      reads++;
      // Comment lines out — prose ABOUT the defect must never read AS the defect.
      const stmt = statementAround(src, m.index)
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
        .join("\n");
      const hit = TRANSFORMS.find((t) => stmt.includes(t));
      if (hit) {
        const line = src.slice(0, m.index).split("\n").length;
        violations.push(`${f}:${line} step.${field} shares a statement with ${hit})`);
      }
    }
  }
}
check("⭐ the scan found step amount reads at all — a class check over nothing proves nothing",
  reads > 0, `${reads} reads across ${FILES.length} money files`);
check("⛔ no read of a step amount shares a statement with a numeric transform",
  violations.length === 0, violations.join(" · ") || `${reads} reads, none transformed`);

// ⭐⭐ THE EXEMPTION IS CHECKED, NOT TRUSTED — a stale name silently covers whatever next takes it.
const floorSrc = read("netlify/functions/_amount-floor.mjs");
for (const [name, why] of Object.entries(REASON_RETURNING)) {
  check(`⭐ exemption "${name}" names a function that exists`, new RegExp(`export function ${name}\\b`).test(floorSrc), why);
  // ⛔ Parse the function's RETURNS, not its lines — a ternary reason spans several lines, and a
  // line-based read of it would be the windowed-extractor mistake in a new costume.
  const body = floorSrc.slice(floorSrc.indexOf(`export function ${name}`));
  const rets = [...body.slice(0, body.indexOf("\n}")).matchAll(/return\s+([\s\S]*?);/g)].map((m) =>
    m[1].trim().replace(/\s+/g, " ")
  );
  const reasonShaped = (r) => r === "null" || /^[`"']/.test(r) || /\?[\s\S]*[`"']/.test(r);
  check(`  …and every one of its ${rets.length} returns is a REASON, not a number`,
    rets.length > 0 && rets.every(reasonShaped),
    rets.filter((r) => !reasonShaped(r)).join(" · ") || "all string-or-null");
}
check("⭐ the exemption list stays small — 1 entry", Object.keys(REASON_RETURNING).length <= 1,
  `${Object.keys(REASON_RETURNING).length} exempt consumer(s)`);

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  EXECUTOR AMOUNT INTEGRITY — executed == capped == audited          ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("1 — ⭐ EVERY BOUNDARY IS FOUND, AND EVERY FOUND NAME IS A REAL BOUNDARY");
const found = [];
for (const f of FILES) {
  const lines = read(f).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp(`await\\s+(${EXECUTORS.join("|")})\\s*\\(`));
    if (!m) continue;
    // ═══ 🚨🚨 A WINDOWED EXTRACTOR FAILS BY FINDING NOTHING, AND FINDING NOTHING READS AS CLEAN.
    //
    // The first draft took a FIXED 14 LINES from the call site and stopped. An eleven-line comment
    // written above `amountIn:` displaced the argument past line 14 — so the extractor found no
    // amount to judge, judged nothing, and RESTORING `.toFixed(2)` AT THE SWAP BOUNDARY PASSED
    // AT 19/0.
    //
    // ⛔ THE COMMENT THAT BROKE IT WAS THE COMMENT DOCUMENTING THE DEFECT. Writing down what went
    // wrong moved the code the checker needed to see. Neither the guard nor the guarded code was
    // wrong in isolation — only the DISTANCE between two lines was, and nothing reads distance.
    //
    // ⭐⭐ AND ONLY ONE OF THE TWO MUTATIONS COULD SEE IT. (a) "restore the old defect" was the
    // blind spot. (b) "add a new rounded boundary" was RED THROUGHOUT — its new call site carried
    // no displacing comment, so it sat inside any window. A single-direction mutation proof would
    // have certified this extractor and shipped the hole.
    // 🚨 MUTATE BOTH DIRECTIONS, ALWAYS. One red mutation is not a validated check.
    //
    // Now depth-counted to the real closing paren, with a large cap for TERMINATION ONLY — never
    // as a scan limit, which is the bug it replaced.
    const block = [];
    let depth = 0, started = false;
    for (let j = i; j < Math.min(i + 120, lines.length); j++) {
      block.push(lines[j]);
      for (const ch of lines[j]) {
        if (ch === "(") { depth++; started = true; }
        else if (ch === ")") depth--;
      }
      if (started && depth <= 0) break;
    }
    found.push({ file: f, line: i + 1, fn: m[1], block });
  }
}
// ⭐⭐ BOTH INCLUSIONS. Every executor in the list must appear at a real call site, and every call
// site found must name an executor from the list — an empty or one-sided derivation is green and
// blind. [[collapse-needs-pairwise-inequality]]
check("⭐ boundaries were found at all — an empty derivation passes vacuously",
  found.length >= 5, `${found.length} call sites`);
const seen = new Set(found.map((b) => b.fn));
for (const e of EXECUTORS) {
  check(`⭐ executor "${e}" has a call site — or it was renamed and this list rotted`, seen.has(e));
}
for (const b of found) {
  check(`⭐ call site ${b.file}:${b.line} names a known executor`, EXECUTORS.includes(b.fn), b.fn);
}

section("2 — ⛔ NO BOUNDARY TRANSFORMS THE AMOUNT IT IS GIVEN");
for (const b of found) {
  const bad = [];
  for (const line of b.block) {
    const m = line.match(AMOUNT_ARG);
    if (!m) continue;
    if (transforms(m[2])) bad.push(`${m[1]}: ${m[2]}`);
  }
  check(`⛔ ${b.fn} (${b.file}:${b.line}) passes the amount unchanged`,
    bad.length === 0,
    bad.length ? `${bad.join(" · ")} — executed must equal capped and audited` : "unchanged");
}

// ═══ 📌 THE PRODUCTION ROWS — AND WHAT THEY DO NOT PROVE ════════════════
// ⛔ THIS SECTION USED TO ASSERT A MEASURED LEDGER-VS-CHAIN DIVERGENCE, headlined +0.002941 USDC.
// THAT CLAIM IS WITHDRAWN. For `swap_tokens` the ledger records valueOfStep — `valueInUsdc(tokenIn,
// amountIn)`, the USDC-EQUIVALENT — while `.toFixed(2)` was applied to `step.amountIn`, in tokenIn
// units. Applying toFixed to the equivalent rounds a DIFFERENT NUMBER than the defect rounded, so
// every delta computed that way was arithmetic about the wrong quantity.
//
// ⭐⭐ THE FAILURE WAS NOT THE ARITHMETIC, IT WAS NOT ASKING WHAT THE FIELD MEANT. `amountUsdc` sits
// in the audit row next to `source: "swap_tokens"` and reads exactly like the swap's amount. One
// look at valueOfStep — sixteen lines above the boundary being fixed — settles it.
//
// ⛔ AND IT CANNOT BE MEASURED FROM THIS STORE AT ALL: `step.amountIn` is persisted nowhere (not in
// the audit rows, not in the 17 `job:` records), and the 2026-08-09 row carries no txHash — it is
// `confirmation: "submitted"`, so it is not established that it landed. The historical divergence is
// UNMEASURED. Not zero, not small: unmeasured. [[publish-the-intermediate-not-just-the-conclusion]]
//
// ⭐ WHAT THE ROWS STILL EARN: the money path routinely carried more than two decimal places. That
// makes the rounding boundary a live hazard rather than a theoretical one — evidence about the
// INPUTS, which is a smaller claim than the one first made, and one these rows actually support.
section("📌 production rows — sub-cent inputs were real; the divergence is UNMEASURED");
const fx = JSON.parse(read("scripts/fixtures/ledger-rounding-divergences-2026-08.json"));
check("⭐ the fixture is present and non-empty", Array.isArray(fx.rows) && fx.rows.length > 0,
  `${fx.rows?.length} rows, read ${fx._readAt}`);
check("  …and every row cites the store key it came from",
  fx.rows.every((d) => typeof d.storeKey === "string" && d.storeKey.startsWith("audit:")));
check("⭐ every row carried MORE than 2 decimal places — sub-cent values were routine",
  fx.rows.every((d) => String(d.ledgerAmountUsdc).split(".")[1]?.length > 2),
  fx.rows.map((d) => d.ledgerAmountUsdc).join(", "));
// ⛔⛔ THE WITHDRAWAL IS PINNED. A future edit that quietly restores an `executedAmountUsdc` number
// would revive a claim the store cannot support — so the ABSENCE is what this asserts.
check("⛔ no row claims an executed amount — that number does not exist in any record",
  fx.rows.every((d) => d.executedAmountUsdc === null),
  fx.rows.filter((d) => d.executedAmountUsdc !== null).map((d) => d.timestamp).join(", ") || "all null");
check("⛔ the fixture states the withdrawal explicitly, so a reader cannot re-derive the old claim",
  typeof fx["⛔_WITHDRAWN_CLAIM"] === "string" && fx["⛔_WITHDRAWN_CLAIM"].includes("WITHDRAWN"));
check("⭐ …and names the only step types where a ledger row WOULD be a valid comparison",
  /pay_for_service/.test(fx._measurableSet || "") && /ZERO/.test(fx._measurableSet || ""));

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0`);
console.log(`⭐ ${found.length} fund-moving boundaries, none transforming its amount.\n`);
