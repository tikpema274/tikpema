// verify-ub-spend-refusal.mjs — a client insufficient-balance condition is a 402, never a 500.
//
//   node scripts/verify-ub-spend-refusal.mjs
//
// ═══ 🚨 THE DEFECT THIS PINS ═════════════════════════════════════════════════════════════════════
// agent-ub-spend used to end `} catch (e) { return json(500, { error: e.message }); }`. The SDK's
// greedy allocator throws BALANCE_INSUFFICIENT_TOKEN (KitError code 9001, message "Insufficient
// balance to cover N USDC.") when the unified pool cannot cover amount + the cross-chain fee — a
// USER condition (nothing burns; the allocator throws before any intent is signed). The blanket
// catch turned that into a 500, which pages an operator for a user error and is INDISTINGUISHABLE
// from a real fault to any monitor — the same class as a 200 that hides a failure. MEASURED
// 2026-09-12: unified 10.000000, a 10 spend → 500 "Insufficient balance to cover 10 USDC."
//
// ⭐ DRIVES THE PURE CLASSIFIER, not a regex over source. classifySpendThrow(e, amount) is exported
// from the handler; a status is a value, so assert the value. [[assert-on-rendered-output-not-source-regex]]
//
// ⛔ TYPED-FIRST, PROSE-BACKUP — three shapes of the same fault must ALL map to 402: the typed code,
// the typed name, and the bare message (the same fault surfaced without the code). And an UNRELATED
// error MUST stay 500 — a classifier that called everything 402 would hide real faults, the mirror
// of the bug. Both directions are asserted. [[check-whose-failure-mode-is-a-pass]]
import { classifySpendThrow } from "../netlify/functions/agent-ub-spend.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };

console.log("── a client insufficient-balance condition → 402, a real fault → 500 ──\n");

// 1. typed code (KitError BALANCE_INSUFFICIENT_TOKEN = 9001)
{
  const r = classifySpendThrow({ code: 9001, name: "KitError", message: "Insufficient balance to cover 10 USDC." }, 10);
  check("⭐ typed code 9001 → 402", r.status === 402, `status ${r.status}`);
  check("  …and the 402 body NAMES the amount + fee, and says no funds moved",
    /10 USDC/.test(r.body.error) && /fee/i.test(r.body.error) && /no funds moved/i.test(r.body.error) && r.body.need === 10 && r.body.blocked === true);
}
// 2. typed name only (no code)
{
  const r = classifySpendThrow({ name: "BALANCE_INSUFFICIENT_TOKEN", message: "nope" }, 10);
  check("⭐ typed name BALANCE_INSUFFICIENT_TOKEN → 402", r.status === 402, `status ${r.status}`);
}
// 3. prose only — the exact SDK message, no code/name (the fault surfaced bare)
{
  const r = classifySpendThrow(new Error("Insufficient balance to cover 10 USDC."), 10);
  check("⭐ prose 'Insufficient balance to cover' → 402 (backup path)", r.status === 402, `status ${r.status}`);
}
// 4. ⛔ THE OTHER DIRECTION — a genuine fault MUST stay 500, or the classifier hides real breaks
{
  const r = classifySpendThrow(new Error("RPC Request failed: 503 upstream"), 10);
  check("⛔ an unrelated fault stays 500 (does NOT get laundered into a 402)", r.status === 500, `status ${r.status}`);
  check("  …and the 500 carries the real message", /RPC Request failed/.test(r.body.error));
}
// 5. a 1098-style async quirk is NOT insufficient-balance → 500 (ubSpend handles 1098 upstream; if
//    it ever reached here it must not be misread as a balance refusal)
{
  const r = classifySpendThrow({ code: 1098, message: "transaction hash is required" }, 10);
  check("⛔ code 1098 (async quirk) is NOT treated as insufficient → 500", r.status === 500, `status ${r.status}`);
}
// 6. ⭐ the amount is echoed, not hard-coded — a different amount flows through
{
  const r = classifySpendThrow({ code: 9001 }, 25);
  check("⭐ the refusal names the ACTUAL amount (25), not a constant", /25 USDC/.test(r.body.error) && r.body.need === 25);
}

console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
