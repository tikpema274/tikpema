// verify-dca-ledger-failclosed.mjs — a confirmed fill whose LEDGER WRITE FAILS must stop the mandate.
//
//   node scripts/verify-dca-ledger-failclosed.mjs
//
// ═══ 🚨 WHAT THIS GUARDS ═════════════════════════════════════════════════════════════════════
// dca-tick advances three ledgers AFTER a fill is witnessed on-chain. Those writes were
// `.catch(() => {})`. A swallowed failure meant MONEY MOVED AND NOTHING COUNTED IT — and
// `recordAgentSpend` is the DAY CEILING, so every later spend (not just DCA's) would be measured
// against an understated total. A widened cap, silently, in the path whose own comment says all
// three ledgers must advance there.
//
// ⚠️ AND WHY THE OBVIOUS FIX IS WRONG. Neither write is idempotent — recordAgentSpend does a CAS
// increment AND appends an audit entry. Simply removing the catch would throw, skip the mandate
// patch, leave pendingPeriod set, and the next tick would re-reconcile and re-apply whichever write
// SUCCEEDED. Under-count traded for double-count.
//
// ⭐ THE SHAPE THAT WORKS: always complete the patch (no re-reconcile ⇒ no double-count), and make
// the failure fail-closed ON THE FUTURE — the past fill cannot be un-spent, but the NEXT one can be
// prevented. That means STATUS, not a flag: `evaluate()` gates on `status !== ACTIVE`, and NOTHING
// gates on `needsAttention`.
//
// Zero network. Zero money. Zero writes.

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  DCA — a confirmed fill that cannot be ledgered STOPS the mandate     ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

const { runLedgerWrites, ledgerFailurePatch } = await import("../netlify/functions/dca-tick.mjs");
const { STATUS, evaluate } = await import("../netlify/functions/_dca.mjs");

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("1 — failures are CAPTURED, never swallowed");
{
  const ok = await runLedgerWrites([["a", async () => {}], ["b", async () => {}]]);
  check("all writes succeed -> ok:true, nothing reported", ok.ok === true && ok.failed.length === 0);

  const one = await runLedgerWrites([
    ["recordDcaSpend", async () => { throw new Error("blobs unavailable"); }],
    ["recordAgentSpend(day-ceiling)", async () => {}],
  ]);
  check("⭐⭐ a failing write is REPORTED, not swallowed", one.ok === false && one.failed.length === 1);
  check("  …and it is NAMED, so the operator knows which ledger is missing",
    /recordDcaSpend/.test(one.failed[0]), one.failed[0]);
  check("  …with the underlying reason attached", /blobs unavailable/.test(one.failed[0]));

  // ⭐ ORDERING MATTERS: the day ceiling is the more important write. A sub-ledger failure must not
  // prevent it from being attempted — losing the ceiling is what widens the global cap.
  let ceilingRan = false;
  await runLedgerWrites([
    ["recordDcaSpend", async () => { throw new Error("x"); }],
    ["recordAgentSpend(day-ceiling)", async () => { ceilingRan = true; }],
  ]);
  check("⭐⭐ an earlier failure does NOT abort the later write — the day ceiling is still attempted",
    ceilingRan === true);

  const both = await runLedgerWrites([
    ["recordDcaSpend", async () => { throw new Error("e1"); }],
    ["recordAgentSpend(day-ceiling)", async () => { throw new Error("e2"); }],
  ]);
  check("both failing -> both reported", both.failed.length === 2);

  const nasty = await runLedgerWrites([["x", async () => { throw new Error("z".repeat(400)); }]]);
  check("a huge error message is truncated, not pasted whole into the record",
    nasty.failed[0].length < 200, `${nasty.failed[0].length} chars`);
  const weird = await runLedgerWrites([["x", async () => { throw "a bare string"; }]]);
  check("a non-Error throw is still captured as a failure", weird.ok === false);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("2 — the failure patch STOPS the mandate (status, not a flag)");
{
  const p = ledgerFailurePatch(["recordAgentSpend(day-ceiling) (blobs unavailable)"]);
  check("⭐⭐ sets status STOPPED_FAILED — the only field `evaluate()` actually enforces",
    p.status === STATUS.STOPPED_FAILED);
  check("  …also raises needsAttention for the human/UI", p.needsAttention === true);
  check("  …and records WHICH ledger did not land", Array.isArray(p.ledgerUnrecorded) && p.ledgerUnrecorded.length === 1);
  check("  …with a stoppedAt timestamp", typeof p.stoppedAt === "number");

  // 🚨 THE POINT OF THE WHOLE FIX. needsAttention is a display flag — nothing gates on it. If the
  // patch set only that, the mandate would keep filling against an understated counter.
  const src = readFileSync("netlify/functions/_dca.mjs", "utf8");
  check("⭐⭐ `evaluate()` gates on STATUS…", /mandate\.status !== STATUS\.ACTIVE/.test(src));
  check("⭐⭐ …and gates on needsAttention NOWHERE — a flag alone would not have stopped anything",
    !/needsAttention/.test(src.replace(/^\s*\/\/.*$/gm, "")));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("3 — end to end: the patched mandate is actually refused");
// ⭐ The binding tested ACROSS what it binds: patch -> evaluate. Asserting the patch shape alone
// would prove nothing about whether the scheduler honours it.
{
  const base = {
    status: STATUS.ACTIVE, endAt: Date.now() + 86_400_000,
    totalBudgetAmount: 10, spentAmount: 1, perTickAmount: 1,
    lastFilledPeriod: null, periodMs: 3_600_000, startAt: Date.now() - 7_200_000,
  };
  const due = evaluate(base, Date.now());
  check("control: an ACTIVE mandate is considered (not refused on status)",
    !/not active/.test(due.reason ?? ""), due.reason ?? "due");

  const stopped = { ...base, ...ledgerFailurePatch(["recordAgentSpend(day-ceiling) (down)"]) };
  const after = evaluate(stopped, Date.now());
  check("⭐⭐ after the ledger-failure patch the mandate is NOT due — no further fill",
    after.due === false, after.reason);
  check("  …and the reason names the stopped status", /not active/.test(after.reason ?? ""));

  // A mandate carrying ONLY needsAttention keeps filling — the counter-example that shows why the
  // status is load-bearing.
  const flagOnly = evaluate({ ...base, needsAttention: true }, Date.now());
  check("⭐⭐ needsAttention alone leaves it DUE — proof the flag could never have been the fix",
    !/not active/.test(flagOnly.reason ?? ""));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("4 — no swallowed ledger write remains in dca-tick");
{
  const tick = readFileSync("netlify/functions/dca-tick.mjs", "utf8");
  const code = tick.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("⭐⭐ zero `recordDcaSpend/recordAgentSpend ... .catch(() => {})`",
    !/record(Dca|Agent)Spend[\s\S]{0,400}?\.catch\(\(\)\s*=>\s*\{\s*\}\)/.test(code));
  check("both ledger sites route through runLedgerWrites",
    (code.match(/runLedgerWrites\(/g) || []).length >= 2);
  check("⭐ the patch is applied on BOTH branches — pendingPeriod is always cleared, so a failure " +
        "cannot re-reconcile and double-apply the write that succeeded",
    (code.match(/pendingPeriod: null/g) || []).length >= 2);
  check("the failure branch reports STOPPED_FAILED as the outcome",
    /OUTCOME\.STOPPED_FAILED/.test(code));
  check("⭐ the reason string carries the amount and the ids for reconciliation",
    /FILLED BUT NOT LEDGERED/.test(tick) && /circleId/.test(tick));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
