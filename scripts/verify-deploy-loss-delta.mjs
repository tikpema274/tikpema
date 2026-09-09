// verify-deploy-loss-delta.mjs — THE DEPLOY-LOSS GATE'S VERDICT, driven through every branch.
//
//   node scripts/verify-deploy-loss-delta.mjs        (also: npm run test:deploylossdelta)
//
// ═══ WHY THIS SUITE EXISTS ═══════════════════════════════════════════════════════════════════
// `deploy:prod` now ends in `gate:deployloss`, which fails the deploy when an abandoned deploy
// appears that the ledger had not already recorded. Two things about that gate are dangerous
// enough to need driving directly, because both fail SILENTLY IN THE SAFE-LOOKING DIRECTION:
//
//   1. ⭐ A MISSING BASELINE. A delta needs something to subtract. If the ledger is absent, empty
//      or unparseable, the tempting reading is `previous = {}` — and an empty previous set makes
//      the comparison either a false alarm on everything or, inverted, a pass on everything. The
//      gate must report CANNOT MEASURE (2), never "nothing new" (0). This is the
//      absence-must-never-read-as-safe family, which this repo has shipped five times.
//
//   2. ⭐⭐ A GATE THAT CANNOT FAIL. 8 losses stand by decision. If the delta were computed after
//      this run appended its own census line, `previous` would always already contain everything
//      and `appeared` would be permanently empty — a green gate that can never redden, which
//      looks identical to a working one in every passing run.
//
// ⚠️ SO THE VERDICT IS TESTED AS A PURE FUNCTION, NOT INFERRED FROM OUTPUT. A suite's verdict is
// its exit code, and output is a separate channel: this repo measured nine assertions printing ❌
// after a `process.exit`, with the suite green. `verdictFor` exists so every exit-code branch can
// be driven here without an API, a clock or a filesystem.
//
// Zero network. Zero money. Zero real Blobs.

import { readFileSync } from "node:fs";
import { previousCensus, diffLosses, verdictFor } from "./lib/deploy-loss-delta.mjs";
import { KNOWN_PRESERVED } from "./lib/deploy-loss-sweep.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
  return !!c;
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

/** A ledger line in exactly the shape deploy-loss-sweep.mjs appends. */
const line = (ids, observedAt = "2026-09-09T22:42:10.754Z") =>
  JSON.stringify({ observedAt, scanned: 551, pages: 6, exhausted: true, minAgeHours: 6, counts: {}, ids });
const rec = (id, preserved = false) => ({ id, state: "new", created_at: "2026-09-08T23:05:57.973Z", context: "production", preserved });
const loss = (id) => ({ id, state: "new", created_at: "2026-09-08T23:05:57.973Z", context: "production", preserved: false });

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  DEPLOY-LOSS DELTA — the gate's verdict, every branch driven         ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("0 — THE INSTRUMENT IS NOT VACUOUS");
// ⚠️ Fixtures that agree cannot discriminate. If the "old" and "new" id sets were equal, every
// assertion below would pass against a diffLosses that returned constants.
const OLD_IDS = ["aaa1", "aaa2"];
const NEW_IDS = ["aaa1", "bbb9"];
check("⭐ the two fixture id sets are PAIRWISE UNEQUAL in both directions",
  NEW_IDS.some((i) => !OLD_IDS.includes(i)) && OLD_IDS.some((i) => !NEW_IDS.includes(i)),
  `old=[${OLD_IDS}] new=[${NEW_IDS}]`);
check("⭐ …and they OVERLAP, so `carried` is distinguishable from `appeared`",
  NEW_IDS.some((i) => OLD_IDS.includes(i)));
check("the known-preserved set is non-empty, so the exclusion test below is not vacuous",
  KNOWN_PRESERVED.size > 0, `${KNOWN_PRESERVED.size} known survivors`);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — 🚨 NO BASELINE IS NOT AN EMPTY BASELINE");
for (const [name, input] of [["absent (null)", null], ["undefined", undefined], ["empty string", ""], ["whitespace only", "\n  \n"]]) {
  const r = previousCensus(input);
  check(`⭐ a ledger that is ${name} reports NOT-OK`, r.ok === false, r.ok === false ? r.why : "returned ok");
  check(`⭐⭐ …and carries NO lossIds field that could be read as "no previous losses"`,
    r.ok === false && r.lossIds === undefined);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — 🚨 A CORRUPT LAST LINE DOES NOT SILENTLY FALL BACK TO AN OLDER ONE");
{
  const good = line([rec("aaa1")]);
  const r = previousCensus(`${good}\n{not json at all\n`);
  check("⭐⭐ a good line followed by an unparseable one reports NOT-OK", r.ok === false, r.why);
  check("⭐⭐ …and does NOT quietly baseline against the older good line",
    r.ok === false || !(r.lossIds?.has("aaa1")),
    "a silent re-baseline would change what the gate means on exactly the run the ledger misbehaves");

  const shaped = previousCensus(`${good}\n${JSON.stringify({ observedAt: "x", counts: {} })}\n`);
  check("⭐ a line that PARSES but has no `ids` array is NOT-OK, not an empty census",
    shaped.ok === false, shaped.ok === false ? shaped.why : "read as empty");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — THE LAST LINE IS THE BASELINE, NOT THE FIRST");
{
  const r = previousCensus(`${line(OLD_IDS.map((i) => rec(i)), "2026-08-15T21:33:04.995Z")}\n${line(NEW_IDS.map((i) => rec(i)))}\n`);
  check("the two-line ledger parses", r.ok === true, r.ok ? "" : r.why);
  check("⭐ the baseline is the LAST line's ids", r.ok && r.lossIds.has("bbb9"));
  check("⭐ …and NOT the first line's", r.ok && !r.lossIds.has("aaa2"), "aaa2 appears only in the earlier line");
  check("the recorded observedAt comes from that same last line", r.ok && r.observedAt === "2026-09-09T22:42:10.754Z", r.observedAt);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⭐ PRESERVED SURVIVORS ARE NOT LOSSES, ON EITHER SIDE");
{
  // The ledger deliberately stores every limbo record INCLUDING the 23 known survivors, while
  // classifyDeployLosses excludes them. Comparing raw `ids` to `result.losses` would report all
  // 23 as resolved on the first run and as appeared the moment the reporting decision changed.
  const mixed = line([rec("real1"), rec("surv1", true), rec("surv2", true), rec("real2")]);
  const r = previousCensus(mixed);
  check("⭐⭐ preserved records are EXCLUDED from the baseline loss set", r.ok && r.lossIds.size === 2, `size ${r.lossIds?.size}`);
  check("⭐ …the non-preserved ones survive", r.ok && r.lossIds.has("real1") && r.lossIds.has("real2"));
  check("⭐ …and no survivor leaks in", r.ok && !r.lossIds.has("surv1") && !r.lossIds.has("surv2"));

  const d = diffLosses(r.lossIds, [loss("real1"), loss("real2")]);
  check("⭐⭐ so a census whose losses are unchanged shows ZERO appeared and ZERO resolved",
    d.appeared.length === 0 && d.resolved.length === 0 && d.carried.length === 2,
    "the 23 survivors must not oscillate in and out of the delta every run");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — THE DELTA ITSELF");
{
  const prev = previousCensus(line(OLD_IDS.map((i) => rec(i)))).lossIds;
  const d = diffLosses(prev, NEW_IDS.map((i) => loss(i)));
  check("⭐ an id absent from the ledger is APPEARED", d.appeared.length === 1 && d.appeared[0].id === "bbb9");
  check("⭐ an id present in both is CARRIED, not appeared", d.carried.length === 1 && d.carried[0].id === "aaa1");
  check("⭐ an id that left the loss set is RESOLVED", d.resolved.length === 1 && d.resolved[0] === "aaa2");
  check("⭐⭐ resolved never double-counts as appeared", !d.appeared.some((r) => d.resolved.includes(r.id)));
  check("the appeared record is the FULL record, not just an id — the report names state and date",
    typeof d.appeared[0].state === "string" && typeof d.appeared[0].created_at === "string");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — ⭐⭐ THE VERDICT: EVERY EXIT-CODE BRANCH");
const V = (o) => verdictFor(o);
const BASE = { scanned: 551, exhausted: true };
check("census mode, no losses → 0", V({ ...BASE, standingLosses: 0 }) === 0);
check("census mode, losses standing → 1", V({ ...BASE, standingLosses: 8 }) === 1);
check("⭐⭐ GATE mode, 8 losses standing but NONE new → 0",
  V({ ...BASE, gateNew: true, baselineOk: true, appearedCount: 0, standingLosses: 8 }) === 0,
  "the whole point: a gate on the TOTAL would fail every deploy forever");
check("⭐⭐ GATE mode, one NEW loss → 1",
  V({ ...BASE, gateNew: true, baselineOk: true, appearedCount: 1, standingLosses: 9 }) === 1);
check("⭐ GATE mode, no baseline → 2 (never 0)",
  V({ ...BASE, gateNew: true, baselineOk: false, appearedCount: 0, standingLosses: 8 }) === 2);
check("⭐ nothing scanned → 2, even in census mode with zero losses",
  V({ scanned: 0, exhausted: true, standingLosses: 0 }) === 2);
check("⭐ paging not exhausted → 2 — the count is a floor, not a total",
  V({ scanned: 551, exhausted: false, standingLosses: 0 }) === 2);
check("census mode is unaffected by baselineOk being null", V({ ...BASE, baselineOk: null, standingLosses: 0 }) === 0);
check("a non-finite scanned count → 2, not a crash", V({ scanned: NaN, exhausted: true, standingLosses: 0 }) === 2);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — 🚨 THE MATRIX: NO CANNOT-MEASURE COMBINATION MAY RETURN 0");
{
  let combos = 0, wrong = 0;
  for (const scanned of [0, 551]) {
    for (const exhausted of [true, false]) {
      for (const gateNew of [true, false]) {
        for (const baselineOk of [true, false, null]) {
          for (const appearedCount of [0, 3]) {
            for (const standingLosses of [0, 8]) {
              combos++;
              const v = verdictFor({ scanned, exhausted, gateNew, baselineOk, appearedCount, standingLosses });
              const cannotMeasure = scanned === 0 || exhausted !== true || (gateNew && baselineOk !== true);
              if (cannotMeasure && v !== 2) wrong++;
              if (!cannotMeasure && ![0, 1].includes(v)) wrong++;
            }
          }
        }
      }
    }
  }
  check("⭐ the matrix is non-empty", combos === 2 * 2 * 2 * 3 * 2 * 2, `${combos} combinations`);
  check("⭐⭐ EVERY cannot-measure combination returns exactly 2 — none reads as clean", wrong === 0, `${wrong} wrong of ${combos}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("8 — GROUNDED: THE REAL LEDGER ON DISK IS A USABLE BASELINE");
{
  // ⚠️ Structural, not a pinned count — the gate appends a line on every deploy, so asserting
  // "8 losses" here would go red on the next successful deploy for no reason.
  let text = null;
  try { text = readFileSync(new URL("../deploy-loss-log.jsonl", import.meta.url), "utf8"); } catch { /* reported below */ }
  check("the real ledger exists and is readable", typeof text === "string" && text.length > 0);
  const r = previousCensus(text);
  check("⭐ its last line parses as a baseline the gate can use", r.ok === true, r.ok ? `${r.lines} line(s), observed ${r.observedAt}` : r.why);
  check("⭐⭐ no known survivor appears in the real baseline's loss set",
    r.ok && ![...r.lossIds].some((id) => KNOWN_PRESERVED.has(id)),
    "the 23 deliberately-uncancelled records must never enter the delta");
  check("⭐ the real baseline is NON-EMPTY, so a delta against it is not vacuous",
    r.ok && r.lossIds.size > 0, r.ok ? `${r.lossIds.size} recorded losses` : "");
}

console.log(`\n${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail ? 1 : 0);
