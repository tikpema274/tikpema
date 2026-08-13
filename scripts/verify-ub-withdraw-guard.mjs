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

for (const state of ["initiating", "waiting", "completing"]) {
  await t(`⭐ every OPEN state blocks — "${state}"`, async () => {
    reset();
    openRows = [{ withdrawalId: "x", state, amountUsdc: "1" }];
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

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-ub-withdraw-guard: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
