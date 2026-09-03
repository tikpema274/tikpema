// verify-fee-reconcile.mjs — THE POST-BURN FEE RECONCILIATION, AGAINST TWO REAL BURN RECEIPTS.
//
//   node --experimental-test-module-mocks scripts/verify-fee-reconcile.mjs
//
// ═══ WHY THIS SUITE EXISTS ═══════════════════════════════════════════════════════════════════
// The reconciliation reads a fee out of an Arc burn receipt's logs and compares it against the
// figure a user was shown. Every way it can be wrong is a way it can be CONFIDENTLY wrong:
//   · read the NATIVE 18-dp stream instead of the ERC-20 one  -> off by 1e12
//   · match an `Approval` instead of a `Transfer`             -> same value, same addresses
//   · pick the AMOUNT leg instead of the FEE leg              -> both are payer → TMWF
//   · compare log COUNTS                                      -> fails on every sponsored userOp
//   · read an absence as agreement                            -> a retention window becomes a tick
// None of those is visible in a green run of a hand-written fixture, so this suite runs the
// PRODUCTION function against the two real receipts on disk and mutates them.
//
// ⭐ THE FIXTURES ARE REAL BYTES, NOT IMAGINED ONES. `scripts/spikes/erc20-fee-burn-receipt-*.json`
// are the raw `eth_getTransactionReceipt` results of the only two ERC-20-`feeToken` burns this
// project has made — run 1 from an EOA, run 2 from the gasless agent SCA. A hand-written fixture
// only ever proves the code handles what its author imagined; these carry the dual emission, the
// Approval collisions and the bundler's gas refund exactly as the chain produced them.
//
// Zero network. Zero money. Zero real Blobs.

import { readFileSync } from "node:fs";
import { mock } from "node:test";
import {
  ARC_USDC, TRANSFER_TOPIC, TMWF, FEE_MANAGER, ARC_CHAIN,
  FEE_RECON_VERDICTS, FEE_RECON_REASONS,
  observeFeeMovement, reconcileFee, disclosedFeeMinor, usdcDecimalToMinorExact, minorToUsdcString,
} from "../netlify/functions/_fee-reconcile.mjs";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
  return !!cond;
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

const F = "scripts/spikes/";
const load = (n) => JSON.parse(readFileSync(F + n, "utf8")).result;
const RUN1 = load("erc20-fee-burn-receipt-2026-09-03.json");
const RUN2 = load("erc20-fee-burn-run2-receipt-2026-09-03.json");

// The two burns, as recorded in the pre-registrations' RESULT sections.
//   run 1 — EOA `0x1a63e59d…18dc99`, plain tx, fee 53971, amount 1
//   run 2 — agent SCA `0xc54d4721…b4e621`, userOp, fee 53985, amount 1
const RUN1_PAYER = RUN1.from;                                        // a plain tx: the payer IS tx.from
const RUN2_PAYER = "0xc54d47211997aca90ef4fcfbc742a3b511b4e621";     // a userOp: tx.from is the BUNDLER
const lc = (s) => String(s).toLowerCase();

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  FEE RECONCILIATION — a DETECTOR, read against two real Arc burns    ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("0 — THE INSTRUMENT IS NOT VACUOUS");
// 🚨 A suite that loads an empty fixture reports the same green as one that loads a real receipt.
// Every count below is asserted before any verdict is trusted.
check("⭐ both real receipts loaded, with logs", RUN1.logs?.length > 0 && RUN2.logs?.length > 0,
  `run1 ${RUN1.logs.length} logs · run2 ${RUN2.logs.length} logs`);
check("  …and both succeeded on chain", RUN1.status === "0x1" && RUN2.status === "0x1");
// ⭐ THE HAZARD IS PRESENT IN THE FIXTURE, which is what makes pinning it meaningful. If the
// fixtures happened to contain no native twins, every emitter assertion below would pass for free.
const nativeLogs = RUN2.logs.filter((l) => lc(l.address) === "0xfffffffffffffffffffffffffffffffffffffffe");
check("🚨 the fixture CONTAINS the 18-dp native twins the emitter pin exists to exclude",
  nativeLogs.length > 0, `${nativeLogs.length} native logs in run 2`);
// ⭐ And the Approval collision the topic0 pin exists to exclude.
const approvalsAtFee = RUN2.logs.filter(
  (l) => lc(l.address) === lc(ARC_USDC) && lc(l.topics[0]) !== TRANSFER_TOPIC && l.topics.length === 3);
check("🚨 …and the Approval logs the topic0 pin exists to exclude", approvalsAtFee.length > 0,
  `${approvalsAtFee.length} non-Transfer 3-topic USDC logs`);
// ⭐⭐ THE F5 FINDING, PRESENT IN THE FIXTURE. The two streams have DIFFERENT Transfer counts, so a
// count-based reconciliation would be wrong here — which is why nothing in this module counts.
const erc20T = RUN2.logs.filter((l) => lc(l.address) === lc(ARC_USDC) && lc(l.topics[0]) === TRANSFER_TOPIC);
const natT = nativeLogs.filter((l) => lc(l.topics[0]) === TRANSFER_TOPIC);
check("⭐⭐ the two streams' Transfer counts DIFFER in the fixture — a count comparison would fail here",
  erc20T.length !== natT.length, `erc20 ${erc20T.length} vs native ${natT.length}`);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — CONTROL: the production reader against both real burns");
// ⭐ THE EXPECTED VALUES COME FROM THE PRE-REGISTRATIONS' RESULT SECTIONS, not from running this
// code and writing down what it said. 53971 and 53985 were recorded before this module existed.
{
  const o1 = observeFeeMovement(RUN1.logs, { payer: RUN1_PAYER });
  check("⭐ run 1 (EOA) — the fee leg reads 53971", o1.read && o1.feeMinor === "53971",
    JSON.stringify(o1));
  check("  …and the remaining payer→TMWF leg is the amount, 1", JSON.stringify(o1.amountLegsMinor) === '["1"]');

  const o2 = observeFeeMovement(RUN2.logs, { payer: RUN2_PAYER });
  check("⭐ run 2 (gasless SCA, a userOp) — the fee leg reads 53985", o2.read && o2.feeMinor === "53985",
    JSON.stringify(o2));
  check("  …and the remaining payer→TMWF leg is the amount, 1", JSON.stringify(o2.amountLegsMinor) === '["1"]');

  // ⚠️ THE SAME CODE PATH READS BOTH, and the two burns differ in every way that could matter:
  // an EOA versus a deployed SCA, a plain transaction versus a sponsored userOp, 22 logs versus 25.
  check("⭐⭐ ONE reader handles both a plain tx and a sponsored userOp — no path branches on shape",
    o1.read && o2.read && o1.feeMinor !== o2.feeMinor);

  check("⭐ the verdict is MATCHED when the disclosed figure is the one that moved",
    reconcileFee({ observed: o2, disclosedMinor: 53985n }).verdict === "matched");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — 🚨 THE TWO PINS, PROVEN LOAD-BEARING (each looks redundant; neither is)");
{
  // ── THE EMITTER PIN ──────────────────────────────────────────────────────────────────────────
  // Re-address every native log to the USDC contract: the 18-dp values now sit in the stream the
  // reader trusts. ⭐ CORRECTING AN EARLIER NOTE: the ~1e12 dual-emission hazard is a FALSE ALARM,
  // not a false pass. It yields a MISMATCH three orders of magnitude out — loud, never silent.
  const swapped = JSON.parse(JSON.stringify(RUN2));
  let moved = 0;
  for (const l of swapped.logs) {
    if (lc(l.address) === "0xfffffffffffffffffffffffffffffffffffffffe") { l.address = ARC_USDC; moved++; }
  }
  // ⚠️ Also drop the genuine 6-dp legs, so what remains is ONLY the 18-dp view of the same money —
  // the state a reader with no emitter pin would actually be looking at.
  const only18 = { logs: swapped.logs.filter((l) => !RUN2.logs.some(
    (o) => lc(o.address) === lc(ARC_USDC) && Number(o.logIndex) === Number(l.logIndex))) };
  check("  [mutation applied] every native log re-addressed to the USDC contract", moved > 0, `${moved} logs`);
  const o = observeFeeMovement(only18.logs, { payer: RUN2_PAYER });
  const v = reconcileFee({ observed: o, disclosedMinor: 53985n });
  check("🚨 reading the 18-dp view as if it were the 6-dp one gives MISMATCHED, not MATCHED",
    v.verdict === "mismatched", JSON.stringify(v));
  check("⭐ …and it is LOUD — the observed figure is 1e12 too large, not subtly off",
    v.feeObservedMinor === "53985000000000000");

  // ── THE TOPIC0 PIN ───────────────────────────────────────────────────────────────────────────
  // `Approval(owner, spender, value)` has the SAME arity and the SAME two indexed addresses as
  // `Transfer`. Run 2 carries `Approval(TMWF → FeeManager, 53985)` — identical emitter, identical
  // from/to, identical value to the fee Transfer. Retopic it and the forward leg doubles.
  const retopiced = JSON.parse(JSON.stringify(RUN2));
  let flipped = 0;
  for (const l of retopiced.logs) {
    if (lc(l.address) === lc(ARC_USDC) && lc(l.topics[0]) !== TRANSFER_TOPIC && l.topics.length === 3) {
      l.topics[0] = TRANSFER_TOPIC; flipped++;
    }
  }
  check("  [mutation applied] the USDC Approval logs now carry the Transfer topic", flipped > 0, `${flipped} logs`);
  const o2 = observeFeeMovement(retopiced.logs, { payer: RUN2_PAYER });
  check("🚨 without the topic0 pin the forward leg is AMBIGUOUS, not merely wrong",
    !o2.read && o2.reason === "fee_forward_legs", JSON.stringify(o2));
  check("⭐ …and ambiguity resolves to unreadable, never to a guess",
    reconcileFee({ observed: o2, disclosedMinor: 53985n }).verdict === "unreadable");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐⭐ MUTATIONS, BOTH DIRECTIONS, EACH VERIFIED APPLIED");
// ⛔ THE TWO DIRECTIONS COME FROM DIFFERENT PLACES, and that is the point of separating them:
//   · mutate OUR RECORD (the disclosed figure)  -> MISMATCHED. The finding this detector exists for.
//   · mutate THE CHAIN (the logs)               -> UNREADABLE. Never a mismatch invented from a
//                                                   reading we could not make.
// A suite proving only the first would pass on a reader that reports a mismatch whenever it is
// confused, which is the worst possible behaviour for an alarm.
const isFeeCharge = (l) =>
  lc(l.address) === lc(ARC_USDC) && lc(l.topics[0]) === TRANSFER_TOPIC &&
  "0x" + lc(l.topics[1]).slice(26) === lc(RUN2_PAYER) &&
  "0x" + lc(l.topics[2]).slice(26) === lc(TMWF) && BigInt(l.data) === 53985n;

{
  // ── DIRECTION 1: the RECORD disagrees with the chain ─────────────────────────────────────────
  const o = observeFeeMovement(RUN2.logs, { payer: RUN2_PAYER });
  const v = reconcileFee({ observed: o, disclosedMinor: 53900n });
  check("⭐⭐ a disclosed figure that is not what moved → MISMATCHED", v.verdict === "mismatched");
  check("  …and BOTH figures travel with the verdict — a verdict without its numbers cannot be acted on",
    v.feeObservedMinor === "53985" && v.feeDisclosedMinor === "53900");
  // ⚠️ ONE minor unit is a real mismatch. A tolerance would be a policy nobody wrote down.
  check("⭐ off by ONE minor unit is still a mismatch — there is no tolerance band",
    reconcileFee({ observed: o, disclosedMinor: 53984n }).verdict === "mismatched");

  // ── DIRECTION 2a: the fee charge leg is GONE, its native twin left in place ──────────────────
  const gone = RUN2.logs.filter((l) => !isFeeCharge(l));
  check("  [mutation applied] the ERC-20 fee charge log removed, native twin kept",
    RUN2.logs.length - gone.length === 1, `removed ${RUN2.logs.length - gone.length}`);
  const vg = reconcileFee({ observed: observeFeeMovement(gone, { payer: RUN2_PAYER }), disclosedMinor: 53985n });
  check("🚨 a missing charge leg is UNREADABLE — the native twin must not be substituted for it",
    vg.verdict === "unreadable" && vg.reason === "fee_charge_candidates", JSON.stringify(vg));

  // ── DIRECTION 2b: the charge leg's VALUE is altered ──────────────────────────────────────────
  const altered = JSON.parse(JSON.stringify(RUN2)).logs;
  let hit = 0;
  for (const l of altered) if (isFeeCharge(l)) { l.data = "0x" + (53000n).toString(16).padStart(64, "0"); hit++; }
  check("  [mutation applied] the charge leg's value changed 53985 → 53000", hit === 1, `${hit} log(s)`);
  const va = reconcileFee({ observed: observeFeeMovement(altered, { payer: RUN2_PAYER }), disclosedMinor: 53985n });
  check("⭐ a charge leg that no longer matches the forward leg is UNREADABLE, not a mismatch",
    va.verdict === "unreadable" && va.reason === "fee_charge_candidates",
    "the contract's own assert makes charge≠forward impossible — so this shape means we misread, not that we were overcharged");

  // ── DIRECTION 2c: A BUNDLE. Two userOps in one transaction. ──────────────────────────────────
  // ⚠️ UNMEASURED, NOT IMPOSSIBLE. Run 2's receipt carried exactly one `UserOperationEvent` — one
  // observation, not a guarantee. An ERC-4337 bundler may batch, and the receipt would then carry
  // another wallet's movements. The reader must refuse, never pick one.
  const bundled = RUN2.logs.concat(RUN2.logs.filter(isFeeCharge).map((l) => ({ ...l, logIndex: "0x99" })));
  check("  [mutation applied] a second payer→TMWF fee leg appended", bundled.length === RUN2.logs.length + 1);
  const vb = reconcileFee({ observed: observeFeeMovement(bundled, { payer: RUN2_PAYER }), disclosedMinor: 53985n });
  check("🚨 two candidate charge legs → UNREADABLE. Ambiguity is an OUTCOME, never a guess",
    vb.verdict === "unreadable" && vb.reason === "fee_charge_candidates" && vb.detail === "2");

  // ── DIRECTION 2d: a burn that never used the upfront-fee path at all ─────────────────────────
  // ⚠️ THE EXPECTED VERDICT FOR EVERY BRIDGE UNTIL THE MIGRATION LANDS. It gets its own reason
  // because "this path has no fee transfer" and "we failed to read the fee transfer" are different
  // findings, and only the second is a problem.
  const noTmwf = RUN2.logs.filter((l) => !(l.topics.length === 3 && "0x" + lc(l.topics[2]).slice(26) === lc(TMWF)));
  check("  [mutation applied] every USDC movement into TMWF removed", noTmwf.length < RUN2.logs.length,
    `${RUN2.logs.length - noTmwf.length} removed`);
  const vn = reconcileFee({ observed: observeFeeMovement(noTmwf, { payer: RUN2_PAYER }), disclosedMinor: 53985n });
  check("⭐⭐ a burn that never touched TokenMessengerWithFees is `not_upfront_fee_path`, not a failure",
    vn.verdict === "unreadable" && vn.reason === "not_upfront_fee_path");

  // ── DIRECTION 2e: the payer is unknown ───────────────────────────────────────────────────────
  // ⛔ ABSENCE MUST NOT READ AS SAFE. Every receipt written before `payer` existed lands here.
  for (const bad of [null, undefined, "", "0xnope", RUN2.from /* the BUNDLER, not the payer */]) {
    const r = observeFeeMovement(RUN2.logs, { payer: bad });
    const ok = bad === RUN2.from
      ? !r.read && r.reason === "fee_charge_candidates"   // a real address that paid nothing here
      : !r.read && r.reason === "payer_unknown";
    check(`⛔ payer ${JSON.stringify(bad)} → refused, never assumed`, ok, JSON.stringify(r));
  }
  // 🚨 THE BUNDLER IS THE TRAP. `tx.from` on a userOp is the bundler, and using it would scope the
  // read to a wallet that moved no USDC at all — a silent zero-candidate read, not an obvious error.
  check("🚨 …and `tx.from` on a userOp is the BUNDLER — using it finds no charge leg, it does not guess one",
    observeFeeMovement(RUN2.logs, { payer: RUN2.from }).reason === "fee_charge_candidates");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — THE CONVERSION IS COMPUTED, AND REFUSES RATHER THAN ROUNDS");
{
  check("⭐ 0.053985 USDC → 53985 minor, exactly", usdcDecimalToMinorExact(0.053985) === 53985n);
  check("  …and 1 → 1000000, 0 → 0", usdcDecimalToMinorExact(1) === 1000000n && usdcDecimalToMinorExact(0) === 0n);
  check("  …and 2.054129 → 2054129", usdcDecimalToMinorExact(2.054129) === 2054129n);
  // ⛔ A REFUSAL, NOT A ZERO AND NOT A ROUNDING. A fee with seven decimals is not a USDC amount, and
  // silently dropping the seventh is how a comparison passes on a number nobody ever displayed.
  for (const bad of [0.0000001, NaN, Infinity, -1, 1e21, "0.5", null, undefined])
    check(`⛔ ${JSON.stringify(String(bad))} is refused, not rounded`, usdcDecimalToMinorExact(bad) === null);
  // ⭐ THE ROUND TRIP, both ways, so neither direction can drift alone.
  check("⭐ minor → decimal → minor is the identity for the real figures",
    usdcDecimalToMinorExact(Number(minorToUsdcString(53985n))) === 53985n &&
    usdcDecimalToMinorExact(Number(minorToUsdcString(53971n))) === 53971n);
  check("  …and minorToUsdcString pads, so 1 minor unit is 0.000001 and never 0.1",
    minorToUsdcString(1n) === "0.000001" && minorToUsdcString(1000000n) === "1.000000");

  // ── which figure the record supplies ─────────────────────────────────────────────────────────
  check("⭐⭐ the STORED integer wins over the decimal — no conversion on a new receipt",
    disclosedFeeMinor({ feeDisclosedMinor: "53985", feeDisclosed: 0.05 }) === 53985n,
    "if the decimal were preferred this would be 50000");
  check("  …a legacy receipt converts exactly from its decimal", disclosedFeeMinor({ feeDisclosed: 0.053985 }) === 53985n);
  check("  …the pre-2026-08-30 `feeUsdc` name still reads", disclosedFeeMinor({ feeUsdc: 0.053971 }) === 53971n);
  check("⛔ a receipt with no fee at all yields null — which becomes `disclosed_unknown`, not zero",
    disclosedFeeMinor({}) === null);
  check("⛔ …and an inexact decimal yields null rather than a rounded comparison",
    disclosedFeeMinor({ feeDisclosed: 0.00000012 }) === null);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — THE CLOSED VOCABULARIES, AND THE FOURTH READER STATE");
{
  check("⭐ three verdicts, never two — `unreadable` is first-class",
    JSON.stringify(FEE_RECON_VERDICTS) === JSON.stringify(["matched", "mismatched", "unreadable"]));
  // 🚨 EVERY REASON THE CODE CAN EMIT MUST BE DECLARED. A reason invented at a call site and absent
  // from the set is one no renderer and no reader knows how to interpret — the same shape as a
  // receipt state the client never learned, which rendered a row with no status at all.
  const src = readFileSync("netlify/functions/_fee-reconcile.mjs", "utf8") +
              readFileSync("netlify/functions/bridge-fee-reconcile-background.mjs", "utf8");
  // ⛔ THE DECLARATION IS EXCISED BEFORE SCANNING, AND THE FIRST VERSION OF THIS CHECK WAS VACUOUS
  // WITHOUT IT. `FEE_RECON_REASONS` is an array of quoted strings living in the very file being
  // searched, so "is every declared reason present in the source?" was answered by the declaration
  // itself. It could not have failed for any input — a check whose failure mode is a pass.
  const emissionSrc = src.replace(/export const FEE_RECON_REASONS = Object\.freeze\(\[[\s\S]*?\]\);/, "");
  check("⛔ the declaration really is excised — otherwise the reverse check below is vacuous",
    src.includes("export const FEE_RECON_REASONS") && !emissionSrc.includes("export const FEE_RECON_REASONS") &&
    src.length - emissionSrc.length > 100,
    `${src.length - emissionSrc.length} chars of declaration removed before scanning`);
  // ⚠️ TWO DIRECTIONS, TWO INSTRUMENTS, BECAUSE THEY ARE DIFFERENT QUESTIONS.
  //
  //   UNDECLARED — "did someone invent a reason at a call site?" The candidate is unknown, so this
  //   must recognise the SHAPES a reason is written in. Three exist today: `reason: "x"`, the
  //   `?? "x"` fallback in reconcileFee, and the ternary in the boundary's disclosed check.
  const emitted = new Set([
    ...[...emissionSrc.matchAll(/reason: "([a-z_]+)"/g)].map((m) => m[1]),
    ...[...emissionSrc.matchAll(/\?\?\s*"([a-z_]+)"/g)].map((m) => m[1]),
    ...[...emissionSrc.matchAll(/[?:]\s*"([a-z_]+)"\s*;/g)].map((m) => m[1]),
  ].filter((r) => /^[a-z_]+$/.test(r)));
  const undeclared = [...emitted].filter((r) => !FEE_RECON_REASONS.includes(r));
  check("🚨 every reason emitted anywhere is DECLARED in the closed set", undeclared.length === 0,
    undeclared.join(", ") || `${emitted.size} distinct reasons, all declared`);
  check("  …and the scan is not vacuously empty", FEE_RECON_REASONS.length >= 9 && emitted.size >= 8,
    `${FEE_RECON_REASONS.length} declared, ${emitted.size} distinct emitted`);
  //   UNREACHABLE — "is this declared reason dead?" Here the candidate is KNOWN, so shape-matching
  //   is the wrong instrument: a reason emitted through a shape the regex above has not learned
  //   would be reported as dead when it is live. ⭐ THIS EXACT FALSE ALARM HAPPENED — the ternary
  //   form was missing, and `disclosed_not_exact` was reported unreachable while the boundary emits
  //   it. Asking whether the string appears at all, outside the declaration, cannot make that
  //   mistake, and is not vacuous now that the declaration is excised.
  const unreachable = FEE_RECON_REASONS.filter((r) => !emissionSrc.includes(`"${r}"`));
  check("⚠️ …and no DECLARED reason is unreachable from the code", unreachable.length === 0,
    unreachable.join(", ") || `all ${FEE_RECON_REASONS.length} reachable`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — 🚨 THE KEY LIVES OUTSIDE THE RECEIPT PREFIX");
{
  const mem = new Map();
  mock.module("@netlify/blobs", {
    namedExports: {
      getStore: () => ({
        get: async (k) => (mem.has(k) ? JSON.parse(mem.get(k)) : null),
        setJSON: async (k, v) => { mem.set(k, JSON.stringify(v)); },
        set: async (k, v) => { mem.set(k, v); },
        delete: async (k) => { mem.delete(k); },
        list: async ({ prefix }) => ({ blobs: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }),
      }),
      connectLambda: () => {},
    },
  });
  const R = await import("../netlify/functions/_bridge-receipts.mjs");
  const OWNER = "0xOWNER0000000000000000000000000000000000";
  const HASH = "0xd5d003c07323ae7d750250b515a7f449ce82d1a178de74a41be17a6092d0f895";

  const rk = R.receiptKey(OWNER, HASH), fk = R.feeVerdictKey(OWNER, HASH);
  check("⭐ the receipt key is `o/<owner>/<burnHash>`", rk === `o/${lc(OWNER)}/${lc(HASH)}`, rk);
  check("⭐⭐ the fee verdict key is NOT under `o/<owner>/`", !fk.startsWith("o/"), fk);

  // 🚨 THE FAILURE THIS PREVENTS, DEMONSTRATED RATHER THAN ASSERTED. Written under the receipt
  // prefix, a verdict carrying an `owner` passes listByOwner's cross-check and comes back AS A
  // RECEIPT — one with no `state`, which this panel renders as a row with an amount and no status.
  await R.saveReceipt({ owner: OWNER, burnHash: HASH, state: "burn_confirmed" });
  await R.writeFeeVerdictOnce({ owner: OWNER, burnHash: HASH, verdict: "matched" });
  const listed = await R.listByOwner(OWNER);
  check("🚨 listByOwner returns the RECEIPT ONLY — the verdict is invisible to it",
    listed.receipts.length === 1 && listed.receipts[0].state === "burn_confirmed",
    `${listed.receipts.length} record(s): ${listed.receipts.map((x) => x.state ?? "NO STATE").join(", ")}`);
  // ⛔ THE CONTROL. Under the receipt prefix the same record DOES come back — so the assertion above
  // is about the prefix, not about listByOwner failing to find anything at all.
  mem.set(`o/${lc(OWNER)}/fee-${lc(HASH)}`, JSON.stringify({ owner: OWNER, verdict: "matched" }));
  const polluted = await R.listByOwner(OWNER);
  check("⛔ CONTROL: under `o/<owner>/` the very same record IS returned as a stateless receipt",
    polluted.receipts.length === 2 && polluted.receipts.some((x) => x.state === undefined),
    `${polluted.receipts.length} record(s)`);
  mem.delete(`o/${lc(OWNER)}/fee-${lc(HASH)}`);

  // ── WRITE-ONCE ───────────────────────────────────────────────────────────────────────────────
  // ⭐ Retention only ever makes the answer worse, so the FIRST reading is the best one this system
  // will ever have. A second run must not overwrite a `matched` earned while the burn was readable.
  const second = await R.writeFeeVerdictOnce({ owner: OWNER, burnHash: HASH, verdict: "unreadable", reason: "burn_absent" });
  check("⭐⭐ a second write is REFUSED — the verdict is write-once", second.written === false && second.reason === "already_written");
  const kept = await R.readFeeVerdict(OWNER, HASH);
  check("  …and the ORIGINAL verdict survives, not the later one", kept.verdict === "matched", JSON.stringify(kept));
  check("⛔ a verdict with no owner or no burnHash is refused — a key-less record is unreadable forever",
    (await R.writeFeeVerdictOnce({ verdict: "matched" })).written === false);
  check("⭐ an unwritten burn reads back null — 'never ran' is distinguishable from every verdict",
    (await R.readFeeVerdict(OWNER, "0xnot-a-burn")) === null);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — ON ARC, AN ABSENCE IS ALWAYS UNREADABLE");
{
  check("⭐ the Arc chain descriptor has exactly ONE endpoint — the fact the rule rests on",
    ARC_CHAIN.rpcs.length === 1, ARC_CHAIN.rpcs.join(", "));
  check("  …and it is chain-pinned, so a wrong-chain endpoint cannot answer for Arc", ARC_CHAIN.chainId === 5042002);

  // 🚨 THE HELPER MUST NOT CLAIM CORROBORATION IT CANNOT HAVE. `corroborated` was
  // `failures.length === 0`, trivially true when the only endpoint answers absent — so a
  // single-endpoint absence declared itself corroborated by nobody.
  const { rpcFallback } = await import("../netlify/functions/_receipt.mjs");
  const realFetch = globalThis.fetch;
  // ⭐ THE CHAIN ID IS COMPUTED FROM ARC_CHAIN, NEVER TYPED AS HEX. The first draft of this mock
  // hand-wrote `0x4cee52`, which is 5041746 — a different chain — and rpcFallback's own pin threw.
  // The pin worked; the instrument was my arithmetic. Same shape as the block-number conversion
  // that produced a confident false retraction during the run-3 measurement.
  const idHex = "0x" + ARC_CHAIN.chainId.toString(16);
  globalThis.fetch = async (_u, o) => {
    const { method } = JSON.parse(o.body);
    return { ok: true, json: async () => ({ result: method === "eth_chainId" ? idHex : null }) };
  };
  try {
    const one = await rpcFallback({ rpcs: ["https://a.invalid"], chainId: ARC_CHAIN.chainId },
      "eth_getTransactionReceipt", ["0x0"], { absenceNeedsCorroboration: true });
    check("🚨 a ONE-endpoint absence is NOT corroborated — there was nobody else to ask",
      one.result === null && one.corroborated === false, JSON.stringify(one));
    const two = await rpcFallback({ rpcs: ["https://a.invalid", "https://b.invalid"], chainId: ARC_CHAIN.chainId },
      "eth_getTransactionReceipt", ["0x0"], { absenceNeedsCorroboration: true });
    check("⭐ CONTROL: a TWO-endpoint absence still IS corroborated — the fix narrowed nothing real",
      two.result === null && two.corroborated === true, JSON.stringify(two));
  } finally { globalThis.fetch = realFetch; }

  // ⭐ AND THE RULE IS WRITTEN AT THE CALL SITE, because the helper exists and someone will reach
  // for it. A note only in the helper's body is a note nobody reads before passing the flag.
  const bg = readFileSync("netlify/functions/bridge-fee-reconcile-background.mjs", "utf8");
  check("⭐⭐ the Arc read does NOT pass absenceNeedsCorroboration", !/absenceNeedsCorroboration/.test(
    bg.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")));
  check("  …and the reason is written AT that call, not only in the helper",
    /ON ARC, AN ABSENCE IS ALWAYS `unreadable`, NEVER A FINDING/.test(bg));
  check("⭐ an absent burn receipt produces `burn_absent`, which is an `unreadable` verdict",
    /reason: "burn_absent"/.test(bg) && FEE_RECON_REASONS.includes("burn_absent"));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("8 — IT IS A DETECTOR, AND THE SOURCE SAYS SO");
{
  const bg = readFileSync("netlify/functions/bridge-fee-reconcile-background.mjs", "utf8");
  const mod = readFileSync("netlify/functions/_fee-reconcile.mjs", "utf8");
  const rec = readFileSync("netlify/functions/_bridge-record.mjs", "utf8");

  // 🚨 ALERT ON MISMATCHED ONLY. `unreadable` is the COMMON verdict until the migration lands, and
  // an alarm that fires on the common case is one nobody reads by the time it matters.
  // 🚨 THE CONDITION IS READ, NOT MERELY LOOKED FOR — and the first version of this check was a
  // HOLE, found by mutating it. It asserted that `rec.verdict === "mismatched"` APPEARS and that
  // there is one call site. Widening the guard to `=== "mismatched" || === "unreadable"` satisfies
  // both: the substring is still present and the call site is still one. The suite stayed green
  // while the alarm had been rewired to fire on the COMMON verdict.
  // ⭐ SO IT PARSES THE ACTUAL CONDITION AND REQUIRES THAT NO OTHER VERDICT APPEARS IN IT. That is
  // semantic rather than positional, so a reformat cannot break it and a widening cannot pass it.
  const shoutGuard = bg.match(/if \(([^)]*)\)\s*\{\s*shoutFeeMismatch\(/);
  const cond = shoutGuard?.[1] ?? "";
  check("🚨 the alert fires on `mismatched` ONLY — the condition names no other verdict",
    !!shoutGuard && /"mismatched"/.test(cond) &&
    FEE_RECON_VERDICTS.filter((v) => v !== "mismatched").every((v) => !cond.includes(`"${v}"`)),
    shoutGuard ? `condition: ${cond}` : "could not find the guarded call at all");
  check("  …and there is exactly ONE call site to widen", (bg.match(/shoutFeeMismatch\(/g) || []).length === 1);
  check("  …and the owner address is TRUNCATED in it — an owner address is an identity",
    /String\(owner \?\? ""\)\.slice\(0, 10\)/.test(mod));
  check("⭐ the alert is fire-and-forget — an alerting failure must not compound the finding",
    /\}\)\.catch\(\(\) => \{\}\);/.test(mod));

  // ⛔ IT MUST NOT BE ABLE TO FAIL A BRIDGE. The trigger is swallowed, exactly like the settler's.
  check("⛔ the reconcile trigger is swallowed — a detector may never fail a bridge that succeeded",
    /triggerFeeReconcile[\s\S]{0,900}?catch \(e\) \{[\s\S]{0,300}?swallowed/.test(rec));
  check("⭐ …and it is AWAITED, because an un-awaited fetch from a returning handler may never be sent",
    /await triggerFeeReconcile\(/.test(rec));

  // ⭐ INTERNAL ONLY, BEFORE ANY READ OR WRITE.
  const guardIdx = bg.indexOf("requireInternal(event)");
  check("⭐ requireInternal runs before the first store read", guardIdx > 0 && guardIdx < bg.indexOf("readFeeVerdict("));
  check("  …and before the first chain read", guardIdx < bg.indexOf("rpcFallback("));

  // ⛔ THE PAYER IS PERSISTED, AND ITS ABSENCE IS A REFUSAL RATHER THAN A GUESS.
  check("⛔ the writer persists `payer` and defaults it to null, never to the owner",
    /payer: r\.payer \?\? null/.test(rec));
  check("🚨 …and the reconciler refuses a receipt without one", /reason: "payer_unknown"/.test(bg));

  // ⭐ job-bridge-approve STAYS OUT — the same deliberate exclusion the receipt writer documents.
  const approve = readFileSync("netlify/functions/job-bridge-approve.mjs", "utf8");
  check("⭐⭐ job-bridge-approve does NOT reconcile — it owns its own receipt system",
    !/_fee-reconcile|bridge-fee-reconcile/.test(approve));
  check("  …and the exclusion's REASON is written where the next editor looks",
    /job-bridge-approve[\s\S]{0,400}?own receipt system/.test(rec) || /OUT OF SCOPE[\s\S]{0,200}?job-bridge-approve/.test(mod));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("9 — THE FEE MANAGER LITERAL IS A STATED CHOICE, AND ITS STALENESS IS CAUGHT");
{
  check("⭐ the discriminating addresses are pinned as constants, not rediscovered per read",
    /^0x[0-9a-fA-F]{40}$/.test(TMWF) && /^0x[0-9a-fA-F]{40}$/.test(FEE_MANAGER) && TMWF !== FEE_MANAGER);
  // ⚠️ WHITESPACE-NORMALISED BEFORE MATCHING, and that is not a nicety. These phrases live in a
  // wrapped comment block, so a re-wrap moves a line break into the middle of the phrase and the
  // regex stops matching text that is still there, unchanged. That is the false-alarm history the
  // bridge copy guard records four times over — and it happened here on the first run, when
  // "a stale\n * literal DEGRADES TO" broke a match on prose nobody had touched.
  const mod = readFileSync("netlify/functions/_fee-reconcile.mjs", "utf8")
    .replace(/^\s*\*\s?/gm, " ").replace(/\s+/g, " ");
  // ⚠️ A LITERAL COPIED FROM A THIRD PARTY NEEDS ITS PROVENANCE AND ITS FAILURE DIRECTION WRITTEN
  // DOWN, or the next reader cannot tell a checked constant from a guessed one.
  check("⭐⭐ the getter check that justified the literal is recorded beside it",
    /feeManager\(\)/.test(mod) && /0xd0fb0203/.test(mod));
  check("  …along with the failure direction — a stale literal degrades to `unreadable`, never to MATCHED",
    /stale literal DEGRADES TO `unreadable`/.test(mod));
  check("⭐ …and the live check is named, so the staleness is caught by a suite not by a wrong verdict",
    /verify-fee-manager-live\.mjs/.test(mod) && /test:feemanagerlive/.test(mod));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
console.log(`\n${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail ? 1 : 0);
