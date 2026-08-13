import assert from "node:assert/strict";
import { mock } from "node:test";

// verify-ub-withdraw-guard — one open withdrawal at a time, enforced where the money moves.
//
//   node --experimental-test-module-mocks scripts/verify-ub-withdraw-guard.mjs
//
// ═══ 🚨 THE DEFECT THIS CLOSES ═══════════════════════════════════════════════════════════════
// Nothing stopped a second POST. `randomUUID()` mints a fresh id, `createRecord` writes a fresh
// record, and the only bound was `amount <= available` — so a double press with 1.51 available
// started a SECOND independent seven-day clock.
//
// ⭐⭐ AND IT IS WORSE THAN TWO CLOCKS. Hop 2 is `withdraw(address)`: no amount, sweeps everything
// matured in ONE tx. Two records maturing together are completed by a single transaction — the
// sweeper marks one COMPLETED, the second then reads withdrawable:0 → "not-yet-matured" FOREVER,
// until it trips the overdue alert as a stuck withdrawal that is not stuck. A double press
// manufactures a permanently-open record AND a false page.
//
// ⭐ A DISABLED BUTTON CANNOT DO THIS. Refresh, second tab, stale session, direct call — all bypass
// client state. This suite exists because the guard must hold with no browser involved at all.
//
// ⚠️ NO REAL NETWORK, NO REAL CHAIN, NO MONEY. Every boundary is mocked.

let openRows = [];
let listReadable = true;
let initiateCalls = 0;
let createdRecords = 0;

const REAL = await import("../netlify/functions/_ubwithdraw-record.mjs");

mock.module("../netlify/functions/_blobs.mjs", { namedExports: { connectBlobs: () => {} } });
mock.module("../netlify/functions/_auth.mjs", {
  namedExports: { requireSession: () => ({ address: "0xowner", method: "passkey" }) },
});
mock.module("../netlify/functions/_agent-wallets.mjs", {
  namedExports: {
    ensureOwnerWallet: async () => ({ walletAddress: "0x058957de", pending: false }),
    WALLET_PROVISIONING_STATUS: 503,
    walletProvisioningRefusal: () => ({ error: "provisioning", reason: "wallet-provisioning" }),
  },
});
mock.module("../netlify/functions/_ubwithdraw.mjs", {
  namedExports: {
    readExitState: async () => ({
      readable: true, availableAtomic: "2510000", availableUsdc: "2.51",
      withdrawableAtomic: "0", withdrawableUsdc: "0", delayBlocks: "1209600",
      approxDelayDays: 7.1, delayProvenance: "test",
    }),
    ubInitiateWithdrawal: async () => { initiateCalls++; return { txHash: "0xdead", step: "initiated" }; },
  },
});
mock.module("../netlify/functions/_ubwithdraw-record.mjs", {
  namedExports: {
    STATE: { INITIATING: "initiating", WAITING: "waiting", COMPLETING: "completing", COMPLETED: "completed", FAILED: "failed" },
    OPEN_STATES: ["initiating", "waiting", "completing"],
    createRecord: async () => { createdRecords++; return {}; },
    // ⭐ THE REAL IMPLEMENTATION, imported rather than stubbed. A stubbed predicate would make every
    // lockout assertion below test a fiction — the whole point is what the real one decides.
    blocksNewWithdrawal: REAL.blocksNewWithdrawal,
    INITIATING_BLOCKS_MS: REAL.INITIATING_BLOCKS_MS,
    patchRecord: async () => ({}),
    listByOwner: async () => (listReadable
      ? { readable: true, rows: openRows, matchedKeys: openRows.length, returned: openRows.length, skipped: 0 }
      : { readable: false, rows: [], matchedKeys: null, returned: 0, skipped: 0, error: "store down" }),
  },
});

const { handler } = await import("../netlify/functions/ub-withdraw.mjs");

const post = (body = { amountUsdc: 1 }) =>
  handler({ httpMethod: "POST", body: JSON.stringify(body), headers: {} });
const reset = () => { openRows = []; listReadable = true; initiateCalls = 0; createdRecords = 0; };

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.error(`  ❌ ${name}\n     ${e.message}`); }
};

console.log("\n── ub-withdraw: one open withdrawal at a time ──────────────────");

await t("⭐⭐ a second request while one is WAITING is refused 409 — no second clock", async () => {
  reset();
  openRows = [{ withdrawalId: "16be509f", state: "waiting", amountUsdc: "1", maturesApprox: "2026-08-19T23:13:09.662Z" }];
  const res = await post();
  assert.equal(res.statusCode, 409, "must be a state conflict, not a success");
  assert.equal(initiateCalls, 0, "🚨 THE CHAIN CALL MUST NOT HAPPEN — that is the second clock");
  assert.equal(createdRecords, 0, "no record may be written either, or the sweeper sees a phantom");
});

await t("⭐ …and it NAMES the existing one, so nobody hunts a withdrawal that does not exist", async () => {
  reset();
  openRows = [{ withdrawalId: "16be509f", state: "waiting", amountUsdc: "1", maturesApprox: "2026-08-19T23:13:09.662Z" }];
  const b = JSON.parse((await post()).body);
  assert.equal(b.reason, "withdrawal-already-open");
  assert.equal(b.existing.withdrawalId, "16be509f");
  assert.equal(b.existing.maturesApprox, "2026-08-19T23:13:09.662Z");
  assert.match(b.whatHappened, /nothing new/i, "must say the existing one is unaffected");
  assert.equal(b.retryable, false, "retrying changes nothing until the open one completes");
});

// ⚠️ FIXTURES CARRY amountAtomic AND createdAt because REAL records do. The original fixture
// omitted both, which made `initiating` look like a never-broadcast record — the test passed for a
// reason that had nothing to do with the state name it claimed to be checking.
for (const state of ["initiating", "waiting", "completing"]) {
  await t(`⭐ every OPEN state blocks — "${state}"`, async () => {
    reset();
    openRows = [{ withdrawalId: "x", state, amountUsdc: "1", amountAtomic: "1000000",
                  createdAt: new Date().toISOString() }];
    const res = await post();
    assert.equal(res.statusCode, 409, `"${state}" is open and must block a second start`);
    assert.equal(initiateCalls, 0);
  });
}

for (const state of ["completed", "failed"]) {
  await t(`⭐⭐ a CLOSED withdrawal does NOT block a new one — "${state}"`, async () => {
    reset();
    openRows = [{ withdrawalId: "old", state, amountUsdc: "1" }];
    const res = await post();
    assert.equal(res.statusCode, 202, `"${state}" is finished — blocking here would TRAP the user`);
    assert.equal(initiateCalls, 1);
  });
}

await t("a clean slate starts normally", async () => {
  reset();
  const res = await post();
  assert.equal(res.statusCode, 202);
  assert.equal(initiateCalls, 1);
  assert.equal(createdRecords, 1);
});

await t("⭐⭐ an UNREADABLE list REFUSES — an absence of evidence is not evidence of absence", async () => {
  reset();
  listReadable = false;
  const res = await post();
  assert.equal(res.statusCode, 503, "we do not know whether one is open, so we must not guess");
  assert.equal(initiateCalls, 0, "🚨 starting a clock on an unreadable list is the fail-open");
  const b = JSON.parse(res.body);
  assert.equal(b.reason, "withdrawals-unreadable");
  assert.equal(b.retryable, true, "unlike 409, this one clears on its own");
  assert.match(b.whatHappened, /nothing/i);
});

await t("⭐ the GET is NOT gated — a user must always be able to LOOK at their own exit", async () => {
  reset();
  openRows = [{ withdrawalId: "16be509f", state: "waiting", amountUsdc: "1" }];
  const res = await handler({ httpMethod: "GET", headers: {} });
  assert.equal(res.statusCode, 200, "blocking the read would hide the very thing the 409 refers to");
  assert.equal(JSON.parse(res.body).withdrawals.length, 1);
});

await t("the guard runs AFTER cheap validation — a bad amount still 400s", async () => {
  reset();
  openRows = [{ withdrawalId: "x", state: "waiting" }];
  assert.equal((await post({ amountUsdc: 0 })).statusCode, 400,
    "an invalid request should not be reported as a conflict");
});


// ═══ 🚨 THE LOCKOUT: two correct features composing into a denial of the feature ═════════════
// The sweeper leaves an unconfirmable `initiating` record in that state FOREVER, on purpose. The
// guard counted every OPEN_STATE as blocking. Together: one stuck record blocks every future
// withdrawal, trips the overdue alert, and never clears — the "pocket with no exit" rebuilt by the
// guard meant to protect it.

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const HOUR = 60 * 60 * 1000;

await t("⭐⭐ a SUB-ATOMIC stuck record does NOT lock the user out", async () => {
  reset();
  // amountAtomic "0" ⇒ ubInitiateWithdrawal threw BEFORE the chain call, so nothing can be running.
  openRows = [{ withdrawalId: "stuck", state: "initiating", amountAtomic: "0", createdAt: ago(5 * 60_000) }];
  const res = await post();
  assert.equal(res.statusCode, 202,
    "a record that provably never broadcast must not deny the exit — that is a permanent lockout");
});

await t("⭐ a FRESH initiating record with real units DOES block — the chain call may have landed", async () => {
  reset();
  openRows = [{ withdrawalId: "fresh", state: "initiating", amountAtomic: "1000000", createdAt: ago(60_000) }];
  assert.equal((await post()).statusCode, 409, "caution while the sweeper has not yet reconciled");
});

await t("⭐⭐ …but an OLD one stops blocking — the sweeper has looked twice and found nothing", async () => {
  reset();
  openRows = [{ withdrawalId: "old", state: "initiating", amountAtomic: "1000000", createdAt: ago(3 * HOUR) }];
  assert.equal((await post()).statusCode, 202,
    "continuing to block past 2 sweeper periods is a lockout, not caution");
});

await t("⭐ WAITING blocks regardless of age — a real clock IS running", async () => {
  reset();
  openRows = [{ withdrawalId: "old-waiting", state: "waiting", amountAtomic: "1000000", createdAt: ago(30 * 24 * HOUR) }];
  assert.equal((await post()).statusCode, 409, "age must never release a genuinely running clock");
});

await t("⭐ an unparseable createdAt errs toward CAUTION (blocks), not toward a second clock", async () => {
  reset();
  openRows = [{ withdrawalId: "nodate", state: "initiating", amountAtomic: "1000000", createdAt: "???" }];
  assert.equal((await post()).statusCode, 409);
});

// ═══ FIX 1: the decimal check and the atomic conversion must agree ═══════════════════════════
await t("⭐⭐ a SUB-ATOMIC amount is refused 400 BEFORE any record is written", async () => {
  reset();
  const res = await post({ amountUsdc: 0.0000001 });
  assert.equal(res.statusCode, 400, "0.0000001 passes `amount > 0` but rounds to ZERO atomic units");
  assert.equal(createdRecords, 0, "🚨 writing a record here is what created the lockout");
  assert.equal(initiateCalls, 0);
  const b = JSON.parse(res.body);
  assert.equal(b.reason, "amount-below-one-atomic-unit");
  assert.match(b.whatHappened, /nothing/i);
});

await t("⭐ the smallest ACCEPTED amount is exactly one atomic unit", async () => {
  reset();
  assert.equal((await post({ amountUsdc: 0.000001 })).statusCode, 202, "0.000001 = 1 atomic unit must work");
  reset();
  assert.equal((await post({ amountUsdc: 0.0000004 })).statusCode, 400, "rounds to 0 — refused");
});


await t("⭐⭐ an initiating record with NO amountAtomic does not block — it died before the chain call", async () => {
  reset();
  // ub-withdraw writes amountAtomic BEFORE calling the chain, so `null` proves nothing was
  // broadcast. ⚠️ If that ordering ever changes, this assertion becomes wrong — see the note in
  // blocksNewWithdrawal.
  openRows = [{ withdrawalId: "half-written", state: "initiating", amountAtomic: null,
                createdAt: new Date().toISOString() }];
  assert.equal((await post()).statusCode, 202,
    "a half-written record must not deny the exit — nothing was started");
});


await t("⭐⭐ the age bound EXCEEDS the sweeper period — that is the whole safety argument", async () => {
  // The harmful case is two records maturing in the SAME sweeper tick (one withdraw() completes
  // both; the loser reads withdrawable:0 forever). A second withdrawal permitted at this age
  // matures ≥ 2 sweeper periods after the first, so they land on SEPARATE ticks.
  assert.ok(REAL.INITIATING_BLOCKS_MS > REAL.SWEEPER_PERIOD_MS,
    "at or below one sweeper period, a permitted second withdrawal could mature in the same tick");
  assert.equal(REAL.INITIATING_BLOCKS_MS, 2 * REAL.SWEEPER_PERIOD_MS,
    "the 2× margin exists for block-time drift — maturity is block-derived, so wall-clock spacing compresses");
});

await t("⭐ the bound is tied to the sweeper period, not a hardcoded clock", async () => {
  // ⚠️ If the sweeper's schedule changes, this must change with it. Pinning the RELATIONSHIP is
  // what makes that a suite failure rather than a silent drift.
  assert.equal(REAL.SWEEPER_PERIOD_MS, 30 * 60 * 1000, "matches ub-withdraw-sweep's */30 schedule");
});

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-ub-withdraw-guard: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
