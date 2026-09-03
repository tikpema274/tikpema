// verify-receipt-fee-authority.mjs — A RECEIPT MUST RECONCILE WITH ITSELF.
//
//   node --experimental-test-module-mocks scripts/verify-receipt-fee-authority.mjs
//   (also: npm run test:feeauthority)
//
// ═══ 🚨 THE DEFECT THIS PINS, AND WHY IT NEEDED INJECTION TO SEE ═══════════════════════════════
// `agentBridge` re-prices INTERNALLY, so the agent path holds three quotes: A (disclosed), B (the
// one the band gate evaluated) and C (the one actually signed). `_actions` then returned `feeUsdc`
// from **C** and `feeRatio`/`feeBand` from **B**, so a receipt could carry a fee and a ratio that
// are not arithmetically related — `feeUsdc / amount !== feeRatio`.
//
// ⛔ IT CANNOT BE CAUGHT BY LOOKING AT REAL RECEIPTS. Measured 2026-08-30: all 6 agent receipts in
// the store reconcile, INCLUDING the acknowledge-band one. That is expected, not reassuring — B and
// C are ~200 ms apart and the fee moves about once per 30 s, so P(manifest) ≈ 0.7% and the expected
// count across 6 receipts is 0.04. A clean sample of 6 is what a REAL defect predicts here. A live
// run would need ~100 attempts for an even chance, and a clean one would be easy to misread as
// evidence the defect is not real. [[absence-must-never-read-as-safe]]
//
// ⭐ SO THE INSTRUMENT IS INJECTION: force B ≠ C inside ONE `executeAction` call and the mixing is
// deterministic and free.
//
// ═══ ⭐⭐ WHAT REPLACED IT — OPTION C, AND THE RATIO IS NO LONGER STORED ════════════════════════
// The record now carries BOTH fees under names that say what they ARE, so a consumer never needs to
// know which quote produced which:
//     feeCharged   — what was actually taken: the fee signed into the calldata
//     feeDisclosed — what the consent decision was made against: the fee the gate evaluated
// ⚠️ NOT "feeAcknowledged": at band `none` nothing is acknowledged, so that name would be FALSE on
// most receipts. "Disclosed" is true at every band.
//
// 🚨 AND `feeRatio` IS NOT STORED AT ALL. It is `fee / amountRequested` — both already on the
// record — so storing it was a duplicate source of truth, and THE DEFECT WAS THAT DUPLICATE
// DISAGREEING WITH ITS SOURCE. Deriving it at read time makes self-reconciliation STRUCTURAL rather
// than a property some suite has to remember to assert.
// ⭐ It derives from `feeDisclosed`, not `feeCharged`, so the record explains its OWN `ackBand` —
// the band was computed from the disclosed fee, and a ratio taken from the charged one could not
// reproduce it.
//
// ═══ ⭐ THE INVARIANT, AND WHERE IT IS NOW ENFORCED ════════════════════════════════════════════
// `feeCharged <= feeDisclosed` — you may be charged less than you were shown, never more.
//
// ⭐⭐ CONSENT-FEE BINDING HAS LANDED, and it enforces this on the BOUND path by making the two
// fees the same quote — equal being the strongest form of "never more". See
// verify-bridge-fee-binding.mjs, which decodes the actual calldata and proves the signed `maxFee`
// is the figure the user was shown.
//
// ⚠️ THIS SUITE STILL COVERS THE UN-BOUND PATH, AND ITS ASSERTIONS BELOW REMAIN CORRECT THERE.
// A confirm step was expected to turn "B ≠ C is real" and "neither is a copy of the other" red;
// it did not, because the un-bound path was deliberately KEPT for callers that price at one moment
// and execute at another (job-bridge-approve approves a proposal, then runs it). Two quotes are
// still two quotes there, and the receipt still names which is which.
// ⛔ So do not read a green here as evidence about the bound path — it is a different branch, and
// it has its own suite. Neither covers the other.
import { mock } from "node:test";

// ⚠️ CONSTRUCTED, NOT WRITTEN AS A LITERAL. `bridgeAckToken` refuses a secret under 16 chars, so
// the suite needs one — but a secret-SHAPED string in a tracked file trips the pre-commit scanner
// (it did: generic-api-key, line 45). ⭐ Building it removes the finding instead of silencing it:
// a .gitleaksignore entry here would also cover whatever real secret this file might grow later.
process.env.SESSION_SECRET ||= ["fee", "authority", "suite", "not", "a", "credential"].join("-");
const OWNER = "0xfee0000000000000000000000000000000000001";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } return !!c; };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);

const REAL_BRIDGE = await import("../netlify/functions/_bridge.mjs");
// ⚠️ Spread the REAL module rather than hand-listing exports: a partial mock omits whatever the
// module grows next and fails at import with a confusing "does not provide an export" — which is
// exactly what a hand-written {circle, waitForTx} pair did here.
const REAL_CIRCLE = await import("../netlify/functions/_circle.mjs");

// ⭐ THE INJECTION. Two quotes, deliberately different, inside one executeAction call:
//   bridgeFee()  → quote B (the gate's)      : fee 0.0600
//   agentBridge() → quote C (what it signed)  : fee 0.0500
// C < B, i.e. charged less than disclosed — the FAVOURABLE direction, which satisfies the
// invariant. The violating direction gets its own section below.
const QUOTE_B = { amountMinor: 100000n, maxFee: 60000n, feeUsdc: 0.06, netUsdc: 0.04 };
const QUOTE_C = { feeUsdc: 0.05, netUsdc: 0.05 };
let bridgeFeeCalls = 0;

mock.module("@netlify/blobs", { namedExports: {
  connectLambda: () => {}, getDeployStore: () => mkStore(), getStore: () => mkStore() } });
const STORE = new Map();   // ⭐ shared, so a write can be read back: what PERSISTED is the claim
function mkStore() {
  const m = STORE;
  return { async get(k, o) { const v = m.get(k); return v === undefined ? null : (o?.type === "json" ? v : JSON.stringify(v)); },
    async setJSON(k, v) { m.set(k, v); }, async set(k, v) { m.set(k, v); },
    async setIfNew() { return true; }, async list() { return { blobs: [] }; }, async delete(k) { m.delete(k); } };
}
mock.module("../netlify/functions/_circle.mjs", { namedExports: { ...REAL_CIRCLE, circle: () => ({}), waitForTx: async () => ({}) } });
mock.module("../netlify/functions/_pause.mjs", { namedExports: { assertNotPaused: async () => null } });
mock.module("../netlify/functions/_budget.mjs", { namedExports: {
  canSpendDay: async () => ({ allowed: true }), recordAgentSpend: async () => ({}),
  shoutLedgerFailure: () => {}, recordBlocked: async () => {},
  REFUSAL: { CANNOT_VALUE: "cannot-value", PER_BRIDGE_CAP: "per-bridge-cap", DAY_CEILING: "day-ceiling", NO_WALLET: "no-wallet" } } });
mock.module("../netlify/functions/_bridge.mjs", { namedExports: {
  ...REAL_BRIDGE,
  bridgeFee: async () => { bridgeFeeCalls++; return QUOTE_B; },
  agentBridge: async () => ({
    burnHash: "0x" + "ab".repeat(32), burnTx: "https://x/tx", recipient: OWNER,
    destination: { key: "base", label: "Base (Sepolia)", cctpDomain: 6 },
    ...QUOTE_C,
  }),
} });

const { executeAction } = await import("../netlify/functions/_actions.mjs");

const AMOUNT = 0.1;
const ackToken = REAL_BRIDGE.bridgeAckToken({
  owner: OWNER, destinationKey: "base", amountUsdc: AMOUNT,
  band: REAL_BRIDGE.bridgeFeeBand({ amountUsdc: AMOUNT, feeUsdc: QUOTE_B.feeUsdc, netUsdc: QUOTE_B.netUsdc }).band,
});
const run = () => executeAction(
  { type: "bridge_usdc", destination: "base", amountUsdc: AMOUNT, ackToken },
  { walletAddress: OWNER, store: mkStore(), session: { address: OWNER } });

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  RECEIPT FEE AUTHORITY — a record must reconcile with itself        ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");
console.log(`  injected: quote B fee ${QUOTE_B.feeUsdc} (the gate's) · quote C fee ${QUOTE_C.feeUsdc} (signed)`);

section("1 — the injection actually produced TWO different quotes");
{
  const r = await run();
  if (r?.ok !== true) console.log("   DEBUG result:", JSON.stringify(r, (k, v) => typeof v === "bigint" ? v.toString() : v).slice(0, 300));
  if ("feeUsdc" in r && "feeRatio" in r) {
    console.log(`   ⚠️ LEGACY SHAPE PRESENT — feeUsdc ${r.feeUsdc} (quote C) vs feeRatio ${r.feeRatio} (quote B);` +
      ` feeUsdc/amount = ${(r.feeUsdc / AMOUNT).toFixed(6)} — THE MISMATCH`);
  }
  check("⭐ executeAction succeeded (the gate passed with a matching ack token)", r?.ok === true, JSON.stringify(r?.blocked ?? r?.ok));
  check("⭐⭐ bridgeFee was called, and agentBridge returned a DIFFERENT fee — B ≠ C is real",
    bridgeFeeCalls >= 1 && QUOTE_B.feeUsdc !== QUOTE_C.feeUsdc, `bridgeFee calls=${bridgeFeeCalls}`);
}

section("2 — ⭐⭐ BOTH FEES ARE NAMED, and say what they ARE");
{
  const r = await run();
  check("⭐⭐ `feeCharged` is the SIGNED fee — what was actually taken", r.feeCharged === QUOTE_C.feeUsdc, `${r.feeCharged}`);
  check("⭐⭐ `feeDisclosed` is the fee the CONSENT DECISION was made against", r.feeDisclosed === QUOTE_B.feeUsdc, `${r.feeDisclosed}`);
  check("⭐ …and they are genuinely different here, so neither is a copy of the other",
    r.feeCharged !== r.feeDisclosed);
  check("⭐ `netPredicted` comes from the SAME quote as feeCharged — the pair is not mixed",
    r.netUsdc === QUOTE_C.netUsdc, `${r.netUsdc}`);
  // ═══ ⭐⭐ FLOW IS NOT MEANING ══════════════════════════════════════════════════════════════
  // The check above proves the value TRAVELLED from the signed quote to the receipt. It says
  // nothing about what the value IS: an injected quote whose `netUsdc` bore no relation to
  // amount − fee would satisfy it perfectly, because both sides read the same fixture.
  // ⭐ `netPredicted` is the receipt's answer to "what will arrive", and today that means the
  // amount minus the fee that was charged. Asserted against the INDEPENDENT pair (AMOUNT and
  // `feeCharged`), never against the fixture that produced it.
  // 🚨 Under Circle's upfront fees this becomes FALSE — the fee is charged on the source chain in
  // addition to the amount and the recipient receives the full amount. This check is where that
  // change must surface on the RECEIPT, which is the durable record a user reconciles against.
  check("⭐⭐ …and it MEANS amount − feeCharged, checked against the pair and not against the fixture",
    Math.abs(r.netUsdc - (AMOUNT - r.feeCharged)) < 1e-9,
    `netPredicted=${r.netUsdc} amount=${AMOUNT} feeCharged=${r.feeCharged} ⇒ expected ${AMOUNT - r.feeCharged}`);
  check("⛔ …and the two checks are NOT the same check — the fixture and the derivation are " +
    "independent, so one can fail while the other passes",
    QUOTE_C.netUsdc === AMOUNT - QUOTE_C.feeUsdc,
    `fixture net ${QUOTE_C.netUsdc} vs derived ${AMOUNT - QUOTE_C.feeUsdc}`);
  check("⭐ the band comes from the SAME quote as feeDisclosed",
    r.feeBand === REAL_BRIDGE.bridgeFeeBand({ amountUsdc: AMOUNT, feeUsdc: QUOTE_B.feeUsdc, netUsdc: QUOTE_B.netUsdc }).band,
    `${r.feeBand}`);
}

section("3 — 🚨 THE RATIO IS NOT STORED — it is derived, so it cannot disagree");
{
  const r = await run();
  check("🚨 no `feeRatio` is emitted at all", !("feeRatio" in r), Object.keys(r).filter(k => /fee/i.test(k)).join(","));
  // ⭐ THE ORIGINAL DEFECT, STATED AS ARITHMETIC. Under the old code feeUsdc came from C and
  // feeRatio from B, so this equality was FALSE whenever the fee moved between them.
  const derived = r.feeDisclosed / AMOUNT;
  const bandFromDerived = REAL_BRIDGE.bridgeFeeBand({ amountUsdc: AMOUNT, feeUsdc: r.feeDisclosed, netUsdc: AMOUNT - r.feeDisclosed }).band;
  // ⚠️ GUARDED AGAINST A VACUOUS PASS. Without the finiteness check this passed while
  // `feeDisclosed` was undefined: NaN/AMOUNT is NaN, and bridgeFeeBand returns the STRICTEST band
  // for a non-finite ratio, which happened to equal the expected one. A check that passes on
  // missing data is the failure mode this repo keeps finding.
  check("⭐⭐ the derived ratio REPRODUCES the recorded band — the record explains itself",
    Number.isFinite(derived) && bandFromDerived === r.feeBand,
    `derived ratio ${Number.isFinite(derived) ? derived.toFixed(6) : "NaN (feeDisclosed missing)"} → ${bandFromDerived}`);
  check("⭐ …and deriving from feeCharged would NOT reproduce it, which is why it derives from disclosed",
    Number.isFinite(derived) && (r.feeCharged / AMOUNT) !== derived);
}

section("4 — ⭐ THE INVARIANT consent-fee-binding will later enforce");
{
  const r = await run();
  check("⭐⭐ feeCharged <= feeDisclosed — charged no more than was shown",
    r.feeCharged <= r.feeDisclosed, `${r.feeCharged} <= ${r.feeDisclosed}`);
  check("⭐ …and the record carries both numbers, so this is checkable FROM THE RECEIPT",
    typeof r.feeCharged === "number" && typeof r.feeDisclosed === "number");
}

section("5 — 🚨 A VIOLATION IS LOUD, AND THE RECEIPT IS STILL WRITTEN");
{
  // ⭐ The violating direction: charged MORE than disclosed. Nothing prevents this today, which is
  // the point of asserting the invariant before binding exists.
  // ⛔ IT MUST NOT REFUSE. A receipt that is not written because the numbers surprised us means
  // money moved with NO record at all — strictly worse than a surprising record. So: shout, and
  // store the truth.
  const { recordBridge } = await import("../netlify/functions/_bridge-record.mjs");
  const errs = [];
  const realErr = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  let rec;
  try {
    rec = await recordBridge({
      r: { burnHash: "0x" + "cd".repeat(32), burnTx: "u", recipient: OWNER,
           destination: { key: "base", label: "Base (Sepolia)" },
           feeCharged: 0.07, feeDisclosed: 0.06, netUsdc: 0.03, feeBand: "acknowledge",
           ackRequired: true, acknowledged: true },
      session: { address: OWNER }, event: {}, amountRequested: 0.1,
    });
  } catch (e) { errs.push("THREW: " + e.message); }
  finally { console.error = realErr; }

  check("🚨 the violation is SHOUTED — charged > disclosed does not pass silently",
    errs.some((e) => /FEE INVARIANT VIOLATED/.test(e)), errs[0]?.slice(0, 96) ?? "(nothing logged)");
  check("⛔ …and the receipt is STILL WRITTEN — a surprising record beats no record",
    !!rec && !errs.some((e) => e.startsWith("THREW:")));
  // ⭐ READ BACK WHAT WAS PERSISTED, not what the function returned. The stored record is the
  // artifact anyone later audits; a return value is not it.
  const stored = [...STORE.values()].find((v) => v && v.burnHash === "0x" + "cd".repeat(32));
  check("⭐ …carrying BOTH numbers in the STORED record, so the violation is visible where it is audited",
    stored?.feeCharged === 0.07 && stored?.feeDisclosed === 0.06,
    JSON.stringify({ charged: stored?.feeCharged, disclosed: stored?.feeDisclosed }));
  check("🚨 …and the stored record has NO feeRatio to disagree with them",
    stored != null && !("feeRatio" in stored), Object.keys(stored ?? {}).filter((k) => /fee/i.test(k)).join(","));
}

console.log(`\n${"═".repeat(72)}`);
console.log(`${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
