// spike-step8c-verifier-reversal.mjs — STEP 8, part 4: mock-prove the VERIFIER integration.
//
// ═══ ZERO MONEY, ZERO NETWORK ═══
// @netlify/blobs in-memory; confirmSwapLanded, publicClient, requireInternal and circle() all
// scripted. Nothing is submitted, no chain is read, no Circle API is contacted.
//
// ⚠️ HONEST NOTE ON SCOPE: job-swap-receipt-background does NOT roll back `spentAmount` — that field
// exists only in _dca.mjs / dca-tick.mjs (the DCA scheduler). This verifier's own "rollback" is the
// RECEIPT STATE flip to "failed". So the pairing proven here is: receipt→failed + day-ceiling
// reversed, from one observed revert.
//
// The two fail-open cases are asserted explicitly, both against daySpend RE-READS:
//   ⭐ FAILED LOOKUP  → day-ceiling NOT reversed, needsAttention raised, nothing guessed.
//   ⭐ DAY-KEY        → reversal lands on the CHARGE's day, never the verifier's run-day.
//
// RUN:  node --experimental-test-module-mocks --env-file=.env scripts/spikes/spike-step8c-verifier-reversal.mjs

import { mock } from "node:test";

const OWNER = "0x6fb28d6366e755e0e27307692282490c6682fc58";
const HOUR = 60 * 60 * 1000;

// ── in-memory blobs (maps tracked so cases isolate by CLEARING, not replacing — _budget caches its adapter) ──
const maps = [];
let etagSeq = 0;
const memStore = (name) => {
  const nm = typeof name === "string" ? name : name?.name ?? "default";
  let m = maps.find((x) => x._n === nm);
  if (!m) { m = new Map(); m._n = nm; maps.push(m); }
  return {
    async get(k, opts) { const e = m.get(k); if (e == null) return null; return opts?.type === "json" ? e.value : JSON.stringify(e.value); },
    async getJSON(k) { return m.get(k)?.value ?? null; },
    async setJSON(k, v, opts) {
      const cur = m.get(k);
      if (opts?.onlyIfNew && cur) return { modified: false };
      if (opts?.onlyIfMatch && cur?.etag !== opts.onlyIfMatch) return { modified: false };
      m.set(k, { value: v, etag: `e${++etagSeq}` }); return { modified: true };
    },
    async getWithMetadata(k) { const e = m.get(k); return e ? { data: e.value, etag: e.etag } : null; },
    async list(opts) { const p = opts?.prefix ?? ""; return { blobs: [...m.keys()].filter((x) => x.startsWith(p)).map((key) => ({ key })) }; },
  };
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: memStore } });

// ── the verifier's collaborators, all scripted ──
let WITNESS = { reason: "pending" };                 // what confirmSwapLanded reports
mock.module("../../netlify/functions/_auth.mjs", { namedExports: { requireInternal: () => true } });
mock.module("../../netlify/functions/_swap-confirm.mjs", { namedExports: { confirmSwapLanded: async () => WITNESS } });
const realPredict = await import("../../netlify/functions/_predict.mjs");
mock.module("../../netlify/functions/_predict.mjs", {
  namedExports: { ...realPredict, publicClient: () => ({ getBlockNumber: async () => 100000n }) },
});
const SCRIPT = new Map(); // circleId -> { state } for the BACKSTOP's getTransaction
const realCircleMod = await import("../../netlify/functions/_circle.mjs");
mock.module("../../netlify/functions/_circle.mjs", {
  namedExports: {
    ...realCircleMod,
    circle: () => ({
      getTransaction: async ({ id }) => {
        const s = SCRIPT.get(id);
        if (!s) throw new Error(`no script for ${id}`);
        return { data: { transaction: { state: s.state, txHash: s.txHash ?? null } } };
      },
    }),
  },
});

const { handler: verify } = await import("../../netlify/functions/job-swap-receipt-background.mjs");
const { handler: sweep } = await import("../../netlify/functions/budget-sweep.mjs");
const { recordAgentSpend, daySpend } = await import("../../netlify/functions/_budget.mjs");

let fails = 0;
const check = (name, cond, detail = "") => { console.log(`   ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); if (!cond) fails++; };
const reset = () => { maps.forEach((m) => m.clear()); SCRIPT.clear(); WITNESS = { reason: "pending" }; };
const budgetMap = () => maps.find((m) => m._n && !["job-deliverables", "budget-sweep-heartbeat"].includes(m._n));
const auditKeys = () => [...(budgetMap()?.keys() ?? [])];
const hasKey = (frag) => auditKeys().some((k) => k.endsWith(frag));
const dayOf = (at) => new Date(at).toISOString().slice(0, 10);
const dayRec = (at) => budgetMap().get(`day:${OWNER.toLowerCase()}:${dayOf(at)}`)?.value;

async function seedCharge({ id, amount = 1, ageMs = 2 * HOUR }) {
  const at = new Date(Date.now() - ageMs).toISOString();
  await recordAgentSpend({ owner: OWNER, amountUsdc: amount, source: "swap_tokens", justification: "t", at, confirmation: "submitted", circleId: id });
  return at;
}
async function seedReceipt({ jobId, circleId }) {
  await memStore("job-deliverables").setJSON(jobId, {
    receipt: { state: "submitted_no_hash", walletAddress: OWNER, amountIn: 1, tokenIn: "USDC", tokenOut: "EURC", txHash: null, circleId },
  });
}
const readReceipt = async (jobId) => (await memStore("job-deliverables").getJSON(jobId))?.receipt;
const runVerifier = (jobId) => verify({ body: JSON.stringify({ jobId }), blobs: null });

console.log(`\n════ STEP 8 · PART 4 · verifier reversal — ZERO MONEY, ZERO NETWORK ════`);

// ═══ 0 · INSTRUMENTATION SELF-CHECK ═══
console.log(`\n── 0 · instrumentation self-check ──`);
{
  reset();
  const at = await seedCharge({ id: "probe" });
  await seedReceipt({ jobId: "j-probe", circleId: "probe" });
  WITNESS = { confirmed: true, verifiedBy: "hash", txHash: "0x1" };
  const storeLive = (await daySpend({ owner: OWNER, at })) === 1;
  await runVerifier("j-probe");
  const r = await readReceipt("j-probe");
  check("blobs store is LIVE (charge lands and reads back)", storeLive, `daySpend=${await daySpend({ owner: OWNER, at })}`);
  check("the verifier RAN against the scripted witness (receipt settled confirmed)", r?.state === "confirmed", `state=${r?.state}`);
  check("a CONFIRMED swap reverses nothing (control)", (await daySpend({ owner: OWNER, at })) === 1 && !hasKey("reversal-probe"), `daySpend=${await daySpend({ owner: OWNER, at })}`);
  if (!storeLive || r?.state !== "confirmed") { console.error("\n✖ ABORT — instrumentation not attached; the absence assertions below would pass VACUOUSLY."); process.exit(2); }
}

// ═══ 1 · HAPPY PATH ═══
console.log(`\n── 1 · happy path: verifier observes a revert → both rollbacks ──`);
{
  reset();
  const at = await seedCharge({ id: "cid-ok" });
  await seedReceipt({ jobId: "j1", circleId: "cid-ok" });
  WITNESS = { reason: "reverted", txHash: "0xdead" };
  await runVerifier("j1");
  const r = await readReceipt("j1");
  check("receipt rolled back to 'failed' (the verifier's own state rollback, as today)", r?.state === "failed", `state=${r?.state}`);
  check("day-ceiling REVERSED (re-read): 1 → 0", (await daySpend({ owner: OWNER, at })) === 0, `daySpend=${await daySpend({ owner: OWNER, at })}`);
  check("both markers written (reversal + resolution)", hasKey("reversal-cid-ok") && hasKey("resolution-cid-ok"), "keys present");
  check("id recorded once in reversedIds", JSON.stringify(dayRec(at).reversedIds) === JSON.stringify(["cid-ok"]), JSON.stringify(dayRec(at).reversedIds));
  check("receipt records the reversal happened, no needsAttention", r?.dayCeilingReversed === true && !r?.needsAttention, `dayCeilingReversed=${r?.dayCeilingReversed}`);
}

// ═══ 2 · ⭐ FAILED LOOKUP — the instance-5 case ═══
console.log(`\n── 2 · ⭐ failed lookup: charge not findable → NEVER guess ──`);
{
  reset();
  // A charge exists for a DIFFERENT swap, so daySpend is non-zero and "unchanged" is meaningful.
  const other = await seedCharge({ id: "cid-other" });
  await seedReceipt({ jobId: "j2", circleId: "cid-missing" }); // no audit entry for this id
  WITNESS = { reason: "reverted", txHash: "0xdead" };
  await runVerifier("j2");
  const r = await readReceipt("j2");
  check("receipt still rolls back to 'failed' (unaffected by the lookup miss)", r?.state === "failed", `state=${r?.state}`);
  check("⭐ day-ceiling NOT reversed (re-read) — nothing guessed", (await daySpend({ owner: OWNER, at: other })) === 1, `daySpend=${await daySpend({ owner: OWNER, at: other })}`);
  check("⭐ needsAttention RAISED", r?.needsAttention === true, `needsAttention=${r?.needsAttention}`);
  check("no reversal/resolution marker written for the missing id", !hasKey("reversal-cid-missing") && !hasKey("resolution-cid-missing"), "no markers");
  check("the reason is preserved on the receipt (not dropped)", /no charge found/.test(r?.reversalNote || ""), `note="${r?.reversalNote}"`);
}

// ═══ 3 · ⭐ THE INTERACTION — does a failed-lookup charge EVER get reversed? ═══
console.log(`\n── 3 · ⭐ interaction: verifier missed it (transient) → does the BACKSTOP still get it? ──`);
{
  reset();
  // Verifier runs BEFORE the audit entry is visible (blobs eventual consistency), so it misses.
  await seedReceipt({ jobId: "j3", circleId: "cid-late" });
  WITNESS = { reason: "reverted", txHash: "0xdead" };
  await runVerifier("j3");
  const r1 = await readReceipt("j3");
  check("verifier flagged and reversed nothing", r1?.needsAttention === true && r1?.dayCeilingReversed === false, `flagged=${r1?.needsAttention}`);

  // The entry becomes visible afterwards, aged past the backstop's 6h threshold.
  const at = await seedCharge({ id: "cid-late", ageMs: 7 * HOUR });
  check("precondition: the charge is now readable and unresolved", (await daySpend({ owner: OWNER, at })) === 1 && !hasKey("resolution-cid-late"), "unmarked");
  SCRIPT.set("cid-late", { state: "FAILED" });
  const beat = JSON.parse((await sweep({})).body);
  check("⭐ THE BACKSTOP REVERSES IT LATER (re-read): 1 → 0", (await daySpend({ owner: OWNER, at })) === 0, `daySpend=${await daySpend({ owner: OWNER, at })}`);
  check("…so a transient miss at verifier-time is NOT a permanent gap", beat.reversed === 1 && hasKey("reversal-cid-late"), `reversed=${beat.reversed}`);
}

// ═══ 4 · ⭐ DAY-KEY FROM THE CHARGE ═══
console.log(`\n── 4 · ⭐ day-key: charged day N, verified day N+1 ──`);
{
  reset();
  const at = await seedCharge({ id: "cid-day", ageMs: 26 * HOUR }); // yesterday
  await seedReceipt({ jobId: "j4", circleId: "cid-day" });
  WITNESS = { reason: "reverted", txHash: "0xdead" };
  const runDay = dayOf(Date.now());
  check("precondition: charge day differs from the verifier's run day", dayOf(at) !== runDay, `charge=${dayOf(at)} run=${runDay}`);
  await runVerifier("j4");
  check("⭐ the CHARGE's day was decremented", (await daySpend({ owner: OWNER, at })) === 0, `day ${dayOf(at)} spend=${await daySpend({ owner: OWNER, at })}`);
  check("⭐ the RUN day is untouched — no phantom credit", budgetMap().get(`day:${OWNER.toLowerCase()}:${runDay}`) === undefined, "run-day record absent");
}

// ═══ 5 · IDEMPOTENCY / NO DOUBLE-REVERSE ═══
console.log(`\n── 5 · no double-reverse across verifier + backstop ──`);
{
  reset();
  const at = await seedCharge({ id: "cid-idem", ageMs: 7 * HOUR });
  await seedReceipt({ jobId: "j5", circleId: "cid-idem" });
  WITNESS = { reason: "reverted", txHash: "0xdead" };
  await runVerifier("j5");
  check("verifier reversed once (re-read)", (await daySpend({ owner: OWNER, at })) === 0, `daySpend=${await daySpend({ owner: OWNER, at })}`);
  SCRIPT.set("cid-idem", { state: "FAILED" });
  const beat = JSON.parse((await sweep({})).body);
  check("backstop SKIPS it (retired by the key scan — never even queried)", beat.open === 0 && beat.reversed === 0, `open=${beat.open} reversed=${beat.reversed}`);
  check("daySpend still moved exactly once", (await daySpend({ owner: OWNER, at })) === 0 && dayRec(at).reversedIds.length === 1, JSON.stringify(dayRec(at).reversedIds));

  // A re-run of the verifier never even REACHES the reversal path: the terminal-receipt guard
  // (job-swap-receipt-background.mjs:106) short-circuits a receipt that is already 'failed'. That is
  // a STRONGER idempotency than "the reversal no-ops" — the branch is unreachable on a replay.
  // (So reverseChargeById's benign "already handled" branch is reachable from the BACKSTOP or a
  //  genuine race, not from a verifier replay.)
  const before = JSON.stringify(await readReceipt("j5"));
  await runVerifier("j5");
  const r = await readReceipt("j5");
  check("re-running the verifier is a NO-OP at the terminal-receipt guard (never re-enters reversal)", JSON.stringify(r) === before && !r?.needsAttention, `receipt unchanged=${JSON.stringify(r) === before}`);
  check("…and daySpend is STILL 0, not −1", (await daySpend({ owner: OWNER, at })) === 0, `daySpend=${await daySpend({ owner: OWNER, at })}`);
}

// ═══ 6 · needsAttention persists ═══
console.log(`\n── 6 · a flagged charge is surfaced, never silently dropped ──`);
{
  reset();
  await seedCharge({ id: "cid-keep" });
  await seedReceipt({ jobId: "j6", circleId: "cid-gone" });
  WITNESS = { reason: "reverted", txHash: "0xdead" };
  await runVerifier("j6");
  const fresh = await readReceipt("j6"); // re-read from the store, not the in-flight object
  check("needsAttention survives on the persisted receipt", fresh?.needsAttention === true, `needsAttention=${fresh?.needsAttention}`);
  check("…with the reason attached for a human", !!fresh?.reversalNote, `note="${fresh?.reversalNote}"`);
}

console.log(`\n════ VERDICT — STEP 8 PART 4 ════`);
console.log(fails === 0
  ? `✅ PASS — on an observed revert the verifier rolls the receipt back to 'failed' AND reverses the\n   day-ceiling by looking the charge up by circleId, against the CHARGE's day (not its own run-day).\n   A failed lookup reverses NOTHING and raises needsAttention — and the backstop still catches that\n   charge later, so a transient miss is a DELAY, not a permanent gap. Verifier and backstop cannot\n   double-reverse: the markers retire the charge, and reversedIds no-ops any race.`
  : `❌ FAIL — ${fails} assertion(s) above.`);
console.log(`\n  (zero money, zero network: in-memory blobs + scripted witness/resolver.)`);
process.exit(fails === 0 ? 0 : 1);
