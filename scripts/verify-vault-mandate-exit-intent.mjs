#!/usr/bin/env node
// verify-vault-mandate-exit-intent.mjs — piece 5 step 4: the EXIT INTENT and its state machine.
//
//   node --experimental-test-module-mocks scripts/verify-vault-mandate-exit-intent.mjs
//
// ═══ THE RULES (T, 2026-09-29; design: PROGRESS "PIECE 5" §5 recovery + C8) ═══════════════════════════════
//   1. ONE exit intent per mandate, CREATE-ONLY, at x/<owner>/<id>.
//   2. States: submitting → submitted (Circle id) → redeemed (hash) → asserted | failed. Nothing else.
//   3. The mandate goes to `exiting` BEFORE the intent is written, so no deposit can interleave.
//   4. One exit at a time: never resubmit while an intent is open (a resubmit from a stale balance either reverts or
//      redeems a remainder that changes what the outcome means).
//   5. An OPEN DEPOSIT INTENT blocks the exit (C8).
//   + a crash between states leaves the intent readable and RESOLVABLE;
//   + an UNREADABLE intent BLOCKS, never read as absent.
// Blobs are faked in memory with @netlify/blobs' onlyIfNew / onlyIfMatch semantics; the adapters are the REAL ones.

import { mock } from "node:test";
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: () => ({ async get() { return null; }, async setJSON() { throw new Error("not used"); } }) } });

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const show = (v) => { try { return JSON.stringify(v, (k, x) => (typeof x === "bigint" ? `${x}n` : x)); } catch { return String(v); } };
const tryImport = async (p) => { try { return await import(p); } catch (e) { console.log(`  (import ${p} failed: ${e.message.split("\n")[0]})`); return {}; } };
const call = async (fn, ...a) => { try { if (typeof fn !== "function") return { threw: "missing" }; return await fn(...a); } catch (e) { return { threw: e.message }; } };

const XI = await tryImport("../shared/vault-mandate/exit-intent.mjs");
const EX = await tryImport("../netlify/functions/_vault-mandate-exit.mjs");
const ST = await import("../netlify/functions/_vault-mandate-store.mjs");
const REC = await import("../shared/vault-mandate/record.mjs");
const { idempotencyKeyFor, isV4Uuid } = await import("../shared/circle-idempotency.mjs");

// ── a real, acknowledged record ──
const OWNER = "0xaaaa000000000000000000000000000000000001";
const WALLET = "0x3d7d4c52305ed0c394e01c7184701a522116097d";
const T0 = Date.parse("2026-09-29T12:00:00Z");
const built = REC.buildMandateRecord({ owner: OWNER, walletAddress: WALLET,
  vault: { key: "xylo-usdc", address: "0x240Eb85458CD41361bd8C3773253a1D78054f747", chainId: 31337, label: "Xylo" }, // fixture chain id
  terms: { amountPerDepositUsdc: 10, maxTotalUsdc: 100, cadence: "weekly" },
  rules: [{ kind: "state", subject: "owner-changed", onFinding: "pause" }, { kind: "state", subject: "exit-fee-above", limitBps: 50, onFinding: "pause" }],
  baseline: { ok: true, owner: { address: "0x94e0dc7ad29b94ec9819f6cec3364dd34f41b3c6", kind: "eoa" }, reportBlock: 990, reportSigned: true, signerVerified: true, maxFeeBps: 2000, vaultAckToken: "ab".repeat(32) },
  now: T0 - 86400000, id: "vm-1" });
const active = (progress = { sharesTrackedRaw: "500", sharesTrackedGaps: 0 }) => {
  const a = REC.acknowledgeMandate(built.record, built.record.fingerprint, T0 - 86400000).record;
  return { ...a, progress: { ...a.progress, ...progress } };
};

// ── the in-memory store: onlyIfNew / onlyIfMatch, strong reads, an op log, and injectable failures ──
function memStore() {
  const m = new Map(); const ops = []; let n = 0; const fault = { get: null, list: null, set: null };
  const hit = (f, k) => (typeof f === "function" ? f(k) : f instanceof RegExp ? f.test(k) : !!f);
  return { m, ops, fault,
    async setJSON(key, value, o = {}) {
      ops.push(["set", key, value?.status ?? value?.state ?? null]);
      if (fault.set && hit(fault.set, key)) throw new Error(`blobs down (set ${key})`);
      const cur = m.get(key);
      if (o.onlyIfNew && cur) return { modified: false };
      if (o.onlyIfMatch !== undefined && (!cur || cur.etag !== o.onlyIfMatch)) return { modified: false };
      const etag = `e${++n}`; m.set(key, { data: JSON.parse(JSON.stringify(value)), etag }); return { modified: true, etag };
    },
    async getWithMetadata(key) {
      ops.push(["get", key]);
      if (fault.get && hit(fault.get, key)) throw new Error(`blobs down (get ${key})`);
      const cur = m.get(key); return cur ? { data: JSON.parse(JSON.stringify(cur.data)), etag: cur.etag } : null;
    },
    async get(key) { const r = await this.getWithMetadata(key); return r?.data ?? null; },
    async list({ prefix }) {
      ops.push(["list", prefix]);
      if (fault.list && hit(fault.list, prefix)) throw new Error(`blobs down (list ${prefix})`);
      return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}
const xAdapter = (st) => (typeof ST.exitIntentAdapter === "function" ? ST.exitIntentAdapter(st)
  : { async read() { return undefined; }, async create() { return undefined; }, async update() { return undefined; } });
const seed = (st, record) => st.m.set(ST.vaultMandateKey(record.owner, record.id), { data: JSON.parse(JSON.stringify(record)), etag: "e0" });
const notHalted = { async read() { return { readable: true, halted: false, open: [], cleared: [], unparseable: [], why: null }; } };
const depsFor = (st, over = {}) => ({
  mandates: ST.mandateAdapter(st), depositIntents: ST.intentAdapter(st),
  exitIntents: typeof ST.exitIntentAdapter === "function" ? ST.exitIntentAdapter(st) : undefined,
  halt: notHalted, now: () => T0, ...over,
});
const begin = (st, over = {}, args = {}) => call(EX.beginMandateExit ?? (() => { throw new Error("beginMandateExit missing"); }),
  { owner: OWNER, id: "vm-1", liveShares: 1009998n, deps: depsFor(st, over), ...args });
const XKEY = `x/${OWNER}/vm-1/1`; // step 4c: the attempt suffix; the first attempt is 1
const stored = (st, k) => st.m.get(k)?.data;

// ════════════════════════════════════════════════════════════════════════════════════════════════
section("RULE 1 — one exit intent per mandate, create-only, at x/<owner>/<id>");
{
  ok("the key is x/<owner lowercased>/<id>/<attempt>", XI.exitIntentKey?.("0xAAAA000000000000000000000000000000000001", "vm-1", 1) === XKEY, show(XI.exitIntentKey?.("0xAAAA000000000000000000000000000000000001", "vm-1", 1)));
  for (const bad of [0, -1, 1.5, "1", undefined, null]) {
    let threw = false; try { XI.exitIntentKey?.(OWNER, "vm-1", bad); } catch { threw = true; }
    ok(`exitIntentKey refuses attempt ${show(bad) ?? "undefined"} (a key always names a real attempt)`, threw);
  }
  const st = memStore(); seed(st, active());
  const r = await begin(st);
  ok("⭐ begin → ok, the intent is written at x/<owner>/<id>/1", r?.ok === true && r?.key === XKEY && !!stored(st, XKEY), show(r));
  const it = stored(st, XKEY);
  ok("…state `submitting`, sharesToRedeem = min(tracked 500, live 1009998) = 500, with the tracked figure it used",
    it?.state === "submitting" && it?.sharesToRedeem === "500" && it?.sharesTracked === "500" && it?.sharesTrackedGaps === 0, show(it));
  ok("⭐ …a v4-format idempotency key DERIVED from the intent key (recovery can recompute it)", isV4Uuid(it?.idempotencyKey) && it?.idempotencyKey === idempotencyKeyFor(XKEY), it?.idempotencyKey);
  ok("…no Circle id, no hash, no outcome yet", it?.circleId === null && it?.txHash === null && it?.outcome === null);

  const direct = await call(() => xAdapter(st).create(XKEY, { ...it, sharesToRedeem: "1" }));
  ok("⭐ a second create at the same key → refused (exists), the first byte-for-byte", direct?.ok === false && direct?.exists === true && stored(st, XKEY)?.sharesToRedeem === "500", show(direct));
  const other = memStore(); seed(other, active()); await begin(other);
  ok("one begin writes ONE x/ record (attempt 1)", [...other.m.keys()].filter((k) => k.startsWith("x/")).length === 1, show([...other.m.keys()]));
}

section("RULE 2 — the state machine");
{
  const base = XI.buildExitIntent ? XI.buildExitIntent({ record: active(), limit: { ok: true, shares: "500", tracked: "500", live: "1009998", nothingToRedeem: false }, now: T0, attempt: 1 }) : null;
  ok("buildExitIntent → a `submitting` intent", base?.ok === true && base?.intent?.state === "submitting", show(base));
  for (const lim of [{ ok: true, shares: "0", tracked: "0", live: "1009998", nothingToRedeem: true }, { ok: false, code: "tracked-has-gaps" }, null]) {
    const b = XI.buildExitIntent?.({ record: active(), limit: lim, now: T0, attempt: 1 });
    ok(`buildExitIntent refuses ${lim?.nothingToRedeem ? "a ZERO limit (no intent for nothing)" : lim ? "a refused limit" : "no limit"}`, b?.ok === false && !b?.intent, show(b));
  }
  const adv = (i, e) => (XI.advanceExitIntent ? XI.advanceExitIntent(i, { at: T0 + 1000, ...e }) : undefined); // missing → undefined → every case red
  const s0 = base?.intent;
  const s1 = adv(s0, { to: "submitted", circleId: "c-1" });
  ok("submitting → submitted (with the Circle id)", s1?.ok === true && s1.intent.state === "submitted" && s1.intent.circleId === "c-1", show(s1));
  const s2 = adv(s1?.intent, { to: "redeemed", txHash: "0x" + "ab".repeat(32) });
  ok("submitted → redeemed (with the hash)", s2?.ok === true && s2.intent.state === "redeemed" && s2.intent.txHash === "0x" + "ab".repeat(32), show(s2?.why));
  const s3 = adv(s2?.intent, { to: "asserted", outcome: { outcome: "exited", flags: [] } });
  ok("redeemed → asserted (with the classified outcome)", s3?.ok === true && s3.intent.state === "asserted", show(s3?.why));
  const s3f = adv(s2?.intent, { to: "failed", outcome: { outcome: "failed", why: "reverted" } });
  ok("redeemed → failed (the chain said so)", s3f?.ok === true && s3f.intent.state === "failed", show(s3f?.why));
  ok("submitting → failed (Circle rejected before broadcast)", adv(s0, { to: "failed", reason: "rejected before broadcast" })?.ok === true);
  ok("submitted → failed", adv(s1?.intent, { to: "failed", reason: "Circle FAILED, no hash" })?.ok === true);
  ok("…the history records every state with its time", s3?.intent?.history?.map((h) => h.state).join(">") === "submitting>submitted>redeemed>asserted", show(s3?.intent?.history));

  for (const [label, from, e] of [
    ["submitting → redeemed (skips the Circle id)", s0, { to: "redeemed", txHash: "0x" + "ab".repeat(32) }],
    ["submitting → asserted", s0, { to: "asserted", outcome: { outcome: "exited" } }],
    ["submitted → asserted (skips the hash)", s1?.intent, { to: "asserted", outcome: { outcome: "exited" } }],
    ["submitted → submitting (backwards)", s1?.intent, { to: "submitting" }],
    ["asserted → failed (terminal)", s3?.intent, { to: "failed", reason: "x" }],
    ["failed → submitted (terminal)", s3f?.intent, { to: "submitted", circleId: "c-2" }],
    ["an unknown state", s0, { to: "exited" }],
    ["submitted without a Circle id", s0, { to: "submitted" }],
    ["redeemed without a hash", s1?.intent, { to: "redeemed" }],
    ["redeemed with a malformed hash", s1?.intent, { to: "redeemed", txHash: "0x12" }],
    ["asserted without an outcome", s2?.intent, { to: "asserted" }],
    ["asserted with an UNCONFIRMED outcome (that is not an assertion)", s2?.intent, { to: "asserted", outcome: { outcome: "unconfirmed" } }],
    ["asserted with a FAILED outcome (that is `failed`)", s2?.intent, { to: "asserted", outcome: { outcome: "failed" } }],
    ["failed with no reason or outcome", s1?.intent, { to: "failed" }],
  ]) {
    const r = adv(from, e);
    ok(`⛔ refused: ${label}`, r?.ok === false && typeof r?.why === "string", show(r?.why ?? r));
  }
  const changeId = adv(s1?.intent, { to: "submitted", circleId: "c-OTHER" });
  ok("⛔ a recorded Circle id is never replaced (submitted → submitted refused)", changeId?.ok === false, show(changeId?.why));
  ok("advancing never mutates its input", s0?.state === "submitting" && s0?.circleId === null);
  const vbad = XI.verifyExitIntent?.({ ...s1?.intent, circleId: null });
  ok("verifyExitIntent: a `submitted` intent with no Circle id is malformed", vbad?.ok === false, show(vbad));
  ok("verifyExitIntent: a good intent in each state passes", [s0, s1?.intent, s2?.intent, s3?.intent, s3f?.intent].every((i) => XI.verifyExitIntent?.(i)?.ok === true));
}

section("RULE 3 — `exiting` BEFORE the intent, so no deposit can interleave");
{
  const st = memStore(); seed(st, active());
  const r = await begin(st);
  const mkey = ST.vaultMandateKey(OWNER, "vm-1");
  const sets = st.ops.filter((o) => o[0] === "set").map((o) => o[1]);
  const iStatus = sets.indexOf(mkey), iIntent = sets.indexOf(XKEY);
  ok("⭐⭐ the mandate record is written `exiting` BEFORE the intent is written", r?.ok && iStatus >= 0 && iIntent > iStatus && st.ops.find((o) => o[0] === "set" && o[1] === mkey)?.[2] === "exiting", show(st.ops.filter((o) => o[0] === "set")));
  const after = REC.verifyMandateRecord(stored(st, mkey));
  ok("⭐ …and an `exiting` record may NOT deposit (mayDeposit false) — the acknowledgement is untouched (status is outside the fingerprint)",
    after.ok === true && after.mayDeposit === false && /exiting/.test(after.errors.join(" ")), show(after.errors));

  // the status write loses its CAS race → NO intent is written
  const st2 = memStore(); seed(st2, active());
  const racing = { ...ST.mandateAdapter(st2), update: async () => ({ ok: false, conflict: true, errors: ["the mandate changed while it was being updated"] }) };
  const r2 = await begin(st2, { mandates: racing });
  ok("⭐ the `exiting` write fails (CAS) → refused, and NO intent is written", r2?.ok === false && !stored(st2, XKEY), show(r2));

  // a deposit intent that appears AFTER `exiting` but before the intent (a deposit working from a stale read)
  const st3 = memStore(); seed(st3, active());
  const base = ST.mandateAdapter(st3);
  const sneaky = { ...base, update: async (a) => { const u = await base.update(a); st3.m.set(`d/${OWNER}/vm-1/1`, { data: { status: "submitting" }, etag: "d1" }); return u; } };
  const r3 = await begin(st3, { mandates: sneaky });
  ok("⭐⭐ a deposit intent written between `exiting` and the exit intent → the exit re-checks, refuses, writes NO intent",
    r3?.ok === false && r3?.code === "open-deposit-intent" && !stored(st3, XKEY), show(r3));
  ok("…and hands the mandate back from `exiting` (its prior status), so it is not stranded", stored(st3, ST.vaultMandateKey(OWNER, "vm-1"))?.status === "active", stored(st3, ST.vaultMandateKey(OWNER, "vm-1"))?.status);
}

section("RULE 4 — one exit at a time: never resubmit while an intent is open");
{
  for (const state of ["submitting", "submitted", "redeemed"]) {
    // the record says attempt 1 is the last begun, and it is back to exit-blocked (inconsistent with an open intent,
    // which is the point: the intent, read by its number, is what refuses)
    const st = memStore(); seed(st, { ...active(), status: "exit-blocked", exit: { attempt: 1, fromStatus: "active" } });
    st.m.set(XKEY, { data: { schema: "vault-mandate-exit/1", state, owner: OWNER, id: "vm-1" }, etag: "x1" });
    const before = JSON.stringify([...st.m.entries()]);
    const r = await begin(st);
    ok(`⭐ an OPEN intent (${state}) → refused exit-in-flight; nothing written`, r?.ok === false && r?.code === "exit-in-flight" && JSON.stringify([...st.m.entries()]) === before, show(r));
  }
  for (const state of ["asserted", "failed"]) {
    const st = memStore(); seed(st, { ...active(), status: "exit-blocked", exit: { attempt: 1, fromStatus: "active" } });
    st.m.set(XKEY, { data: { schema: "vault-mandate-exit/1", state, owner: OWNER, id: "vm-1" }, etag: "x1" });
    const r = await begin(st, { now: () => T0 + 10 * 3600000 });
    ok(`a MALFORMED terminal attempt (${state}, no fields) → blocked, never retried past`, r?.ok === false && r?.code === "exit-intent-malformed", show(r));
  }
  { const st = memStore(); seed(st, active());
    st.m.set(XKEY, { data: { schema: "vault-mandate-exit/1", state: "submitting", owner: OWNER, id: "vm-1" }, etag: "x1" });
    const r = await begin(st);
    ok("⭐ an intent at /1 that the record does not name (attempt 0) → refused exit-intent-exists BEFORE anything is written (the mandate is not stranded `exiting`)",
      r?.ok === false && r?.code === "exit-intent-exists" && !st.ops.some((o) => o[0] === "set") && stored(st, ST.vaultMandateKey(OWNER, "vm-1"))?.status === "active", show({ r, sets: st.ops.filter((o) => o[0] === "set") })); }
  const st = memStore(); seed(st, { ...active(), status: "exiting", exit: { attempt: 1, fromStatus: "active" } });
  const r = await begin(st);
  ok("⭐ the mandate already `exiting` → refused exit-in-flight, nothing written", r?.ok === false && r?.code === "exit-in-flight" && !stored(st, XKEY), show(r));
  const st2 = memStore(); seed(st2, active());
  const a = await begin(st2); const b = await begin(st2);
  ok("two begins in a row → the first writes, the second is refused", a?.ok === true && b?.ok === false, show([a?.ok, b?.code]));
}

section("RULE 5 — an OPEN DEPOSIT INTENT blocks the exit (C8)");
{
  for (const status of ["submitting", "submitted", "landed"]) {
    const st = memStore(); seed(st, active());
    st.m.set(`d/${OWNER}/vm-1/3`, { data: { status }, etag: "d1" });
    const r = await begin(st);
    ok(`⭐ an open deposit intent (${status}) → refused open-deposit-intent BEFORE anything is written (0 writes; not exiting-then-handed-back)`,
      r?.ok === false && r?.code === "open-deposit-intent" && !st.ops.some((o) => o[0] === "set") && !stored(st, XKEY), show({ r, sets: st.ops.filter((o) => o[0] === "set") }));
  }
  const st = memStore(); seed(st, active());
  st.m.set(`d/${OWNER}/vm-1/3`, { data: { status: "asserted" }, etag: "d1" });
  const r = await begin(st);
  ok("a CLOSED deposit intent (asserted) does not block", r?.ok === true, show(r));
  const st2 = memStore(); seed(st2, active()); st2.fault.list = /^d\//;
  const r2 = await begin(st2);
  ok("⭐ the deposit intents UNREADABLE → refused (never read as 'none open')", r2?.ok === false && r2?.code === "deposit-intents-unreadable" && !stored(st2, XKEY), show(r2));
  const st3 = memStore(); seed(st3, { ...active(), progress: { ...active().progress, sharesTrackedRaw: "500" } });
  st3.m.set(`d/${OWNER}/other-mandate/1`, { data: { status: "submitting" }, etag: "d1" });
  ok("another mandate's open deposit intent does not block this one", (await begin(st3))?.ok === true);
}

section("UNREADABLE BLOCKS — never read as absent");
{
  const st = memStore(); seed(st, active()); st.fault.get = (k) => k.startsWith("x/");
  const r = await begin(st);
  ok("⭐ the exit intent UNREADABLE → refused exit-intent-unreadable; nothing written", r?.ok === false && r?.code === "exit-intent-unreadable" && !st.ops.some((o) => o[0] === "set"), show(r));
  const st2 = memStore(); seed(st2, active()); st2.fault.get = (k) => k.startsWith("m/");
  const r2 = await begin(st2);
  ok("the mandate UNREADABLE → refused; nothing written", r2?.ok === false && !st2.ops.some((o) => o[0] === "set"), show(r2));
  const res = XI.resolveExitState?.({ record: { ...active(), status: "exiting" }, read: { readable: false, why: "blobs down" } });
  ok("⭐ resolveExitState: an unreadable intent → BLOCKED, never 'no intent'", res?.action === "blocked" && res?.code === "exit-intent-unreadable", show(res));
  const mal = XI.resolveExitState?.({ record: { ...active(), status: "exiting" }, read: { readable: true, intent: { state: "weird" } } });
  ok("resolveExitState: a malformed intent → BLOCKED", mal?.action === "blocked", show(mal));
}

section("OTHER REFUSALS — before anything is written");
{
  const cases = [
    ["halted", { halt: { async read() { return { readable: true, halted: true, open: ["i"] }; } } }, "halted"],
    ["halt unreadable", { halt: { async read() { throw new Error("x"); } } }, "halt-unreadable"],
    ["no halt reader", { halt: undefined }, "halt-unreadable"],
  ];
  for (const [label, over, code] of cases) {
    const st = memStore(); seed(st, active());
    const r = await begin(st, over);
    ok(`the latch ${label} → refused ${code}; nothing written`, r?.ok === false && r?.code === code && !st.ops.some((o) => o[0] === "set"), show(r));
  }
  const st = memStore(); seed(st, active({ sharesTrackedRaw: "0", sharesTrackedGaps: 0 }));
  const z = await begin(st);
  ok("⭐ today's live case (tracked 0, 1009998 manual) → nothing-to-redeem: NO status change, NO intent", z?.ok === false && z?.code === "nothing-to-redeem" && !st.ops.some((o) => o[0] === "set"), show(z));
  const st2 = memStore(); seed(st2, active({ sharesTrackedRaw: "500", sharesTrackedGaps: 1 }));
  const g = await begin(st2);
  ok("a gapped tracked figure → refused with the limit's code; nothing written", g?.ok === false && g?.code === "tracked-has-gaps" && !st2.ops.some((o) => o[0] === "set"), show(g));
  const st3 = memStore(); seed(st3, { ...active(), status: "closed" });
  ok("a closed mandate → refused", (await begin(st3))?.ok === false);
  const st4 = memStore(); seed(st4, { ...active(), status: "exit-blocked" });
  const nb = await begin(st4);
  ok("an exit-blocked record that names NO attempt is inconsistent (4c: exit-blocked always names one) → refused", nb?.ok === false && nb?.code === "mandate-inconsistent", show(nb));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
section("CRASH BETWEEN STATES — the intent stays readable and RESOLVABLE");
{
  const R = (record, read) => XI.resolveExitState?.({ record, read });
  const exiting = { ...active(), status: "exiting", exit: { attempt: 1, fromStatus: "active" } };

  // crash after `exiting`, before the intent: the intent write throws
  const st = memStore(); seed(st, active()); st.fault.set = /^x\//;
  const r = await begin(st);
  ok("⭐ the intent write THROWS after `exiting` → refused exit-intent-unwritten, the mandate left `exiting`", r?.ok === false && r?.code === "exit-intent-unwritten" && stored(st, ST.vaultMandateKey(OWNER, "vm-1"))?.status === "exiting", show(r));
  const res0 = R(exiting, await xAdapter(st).read(OWNER, "vm-1", 1));
  ok("⭐ …resolvable: `exiting` + NO intent → nothing-submitted (a submit only ever follows a written intent)", res0?.action === "nothing-submitted", show(res0));

  // crash after the intent is written, before Circle: submitting
  const st2 = memStore(); seed(st2, active()); await begin(st2);
  const read2 = await xAdapter(st2).read(OWNER, "vm-1", 1);
  ok("the intent reads back after a crash (readable, state submitting)", read2?.readable === true && read2?.intent?.state === "submitting", show(read2));
  const res1 = R(exiting, read2);
  ok("⭐ submitting → locate-by-idempotency-key, carrying the key (Circle may or may not have accepted it)", res1?.action === "locate-by-idempotency-key" && res1?.idempotencyKey === read2.intent.idempotencyKey, show(res1));

  // advance through the store, crash after each state, resolve
  const x = xAdapter(st2);
  const a1 = await call(EX.advanceStoredExitIntent, { exitIntents: x, owner: OWNER, id: "vm-1", attempt: 1, to: "submitted", circleId: "c-9", at: T0 + 1 });
  ok("advanceStoredExitIntent: submitted, persisted", a1?.ok === true && stored(st2, XKEY)?.state === "submitted", show(a1));
  const res2 = R(exiting, await x.read(OWNER, "vm-1", 1));
  ok("⭐ submitted → read-circle, with the recorded Circle id", res2?.action === "read-circle" && res2?.circleId === "c-9", show(res2));
  await call(EX.advanceStoredExitIntent, { exitIntents: x, owner: OWNER, id: "vm-1", attempt: 1, to: "redeemed", txHash: "0x" + "cd".repeat(32), at: T0 + 2 });
  const res3 = R(exiting, await x.read(OWNER, "vm-1", 1));
  ok("⭐ redeemed → classify, with the hash (the chain decides the outcome)", res3?.action === "classify" && res3?.txHash === "0x" + "cd".repeat(32), show(res3));
  await call(EX.advanceStoredExitIntent, { exitIntents: x, owner: OWNER, id: "vm-1", attempt: 1, to: "asserted", outcome: { outcome: "exited", flags: [] }, at: T0 + 3 });
  const res4 = R(exiting, await x.read(OWNER, "vm-1", 1));
  ok("asserted → close (the mandate's status is settled next)", res4?.action === "close" && res4?.state === "asserted", show(res4));

  const bad = await call(EX.advanceStoredExitIntent, { exitIntents: x, owner: OWNER, id: "vm-1", attempt: 1, to: "failed", reason: "late", at: T0 + 4 });
  ok("⛔ a stored terminal intent cannot be advanced", bad?.ok === false && stored(st2, XKEY)?.state === "asserted", show(bad));
  const st5 = memStore(); seed(st5, active()); await begin(st5); st5.fault.get = /^x\//;
  const unr = await call(EX.advanceStoredExitIntent, { exitIntents: xAdapter(st5), owner: OWNER, id: "vm-1", attempt: 1, to: "submitted", circleId: "c-1", at: T0 });
  ok("advancing an UNREADABLE stored intent → refused, nothing written", unr?.ok === false && stored(st5, XKEY)?.state === "submitting", show(unr));
  const lost = memStore(); seed(lost, active()); await begin(lost);
  const xl = xAdapter(lost); const lostCas = { ...xl, update: async () => ({ ok: false, conflict: true }) };
  const l = await call(EX.advanceStoredExitIntent, { exitIntents: lostCas, owner: OWNER, id: "vm-1", attempt: 1, to: "submitted", circleId: "c-1", at: T0 });
  ok("a lost CAS on advance → refused (conflict), never silently applied", l?.ok === false && stored(lost, XKEY)?.state === "submitting", show(l));

  const inc = R({ ...active(), status: "active" }, { readable: true, intent: stored(st2, XKEY) && { ...stored(st2, XKEY), state: "submitted", circleId: "c-9" } });
  ok("⭐ an OPEN intent while the mandate is NOT `exiting` → blocked (inconsistent: a deposit could interleave)", inc?.action === "blocked" && inc?.code === "inconsistent", show(inc));
  const none = R(active(), { readable: true, intent: null });
  ok("an active mandate with no intent → none", none?.action === "none", show(none));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
section("4c — ATTEMPTS: x/<owner>/<id>/<n>, n on the record in the SAME CAS as `exiting`");
const H = 3600000;
const key = (n) => `x/${OWNER}/vm-1/${n}`;
const LIM = { ok: true, shares: "500", tracked: "500", live: "1009998", nothingToRedeem: false };
const mk = (n, path, at = T0) => {
  let i = XI.buildExitIntent?.({ record: active(), limit: LIM, now: at, attempt: n })?.intent;
  for (const step of path) i = i && XI.advanceExitIntent?.(i, { at, ...step })?.intent;
  return i;
};
const FAILED = [{ to: "submitted", circleId: "c-1" }, { to: "failed", reason: "the redeem reverted" }];
const PARTIAL = (redeemed, remaining) => [{ to: "submitted", circleId: "c-1" }, { to: "redeemed", txHash: "0x" + "ab".repeat(32) },
  { to: "asserted", outcome: { outcome: "exit-partial", mandateSharesRedeemed: redeemed, mandateSharesRemaining: remaining, flags: [] } }];
const EXITED = [{ to: "submitted", circleId: "c-1" }, { to: "redeemed", txHash: "0x" + "ab".repeat(32) },
  { to: "asserted", outcome: { outcome: "exited", mandateSharesRedeemed: "500", mandateSharesRemaining: "0", flags: [] } }];
const put = (st, n, intent) => st.m.set(key(n), { data: intent === undefined ? { unbuilt: true } : JSON.parse(JSON.stringify(intent)), etag: `x${n}` }); // unbuilt → red, not a crash
const settle = (st, now = T0) => call(EX.settleExitAttempt ?? (() => { throw new Error("settleExitAttempt missing"); }), { owner: OWNER, id: "vm-1", deps: depsFor(st, { now: () => now }) });
const rec = (st) => stored(st, ST.vaultMandateKey(OWNER, "vm-1"));
{
  ok("the retry policy: 3 failed attempts, 6 in all, a retry at least one hour after the last attempt closed",
    XI.EXIT_RETRY_POLICY?.maxFailedAttempts === 3 && XI.EXIT_RETRY_POLICY?.maxAttempts === 6 && XI.EXIT_RETRY_POLICY?.retryAfterMs === H && Object.isFrozen(XI.EXIT_RETRY_POLICY), show(XI.EXIT_RETRY_POLICY));

  const st = memStore(); seed(st, active());
  const r = await begin(st);
  const mSets = st.ops.filter((o) => o[0] === "set" && o[1] === ST.vaultMandateKey(OWNER, "vm-1"));
  ok("⭐⭐ ONE record write carries BOTH `exiting` and exit.attempt = 1 (the same CAS), before the intent at /1",
    r?.ok === true && mSets.length === 1 && rec(st)?.status === "exiting" && rec(st)?.exit?.attempt === 1 && rec(st)?.exit?.fromStatus === "active" && !!stored(st, key(1)), show(rec(st)?.exit));
  ok("…the intent names its attempt", stored(st, key(1))?.attempt === 1);
  const v = REC.verifyMandateRecord(rec(st));
  ok("…and the exiting record verifies (the new field validated) but may not deposit", v.ok === true && v.mayDeposit === false, show(v.errors));
}

section("4c — settling an attempt, and the retry after a FAILURE");
{
  const st = memStore(); seed(st, { ...active(), status: "exiting", exit: { attempt: 1, fromStatus: "active" } });
  put(st, 1, mk(1, FAILED, T0));
  const s1 = await settle(st, T0 + 1000);
  ok("⭐ attempt 1 FAILED → settle: the mandate exit-blocked, lastOutcome failed, the tracked shares UNCHANGED (500)",
    s1?.ok === true && rec(st)?.status === "exit-blocked" && rec(st)?.exit?.lastOutcome === "failed" && rec(st)?.exit?.attempt === 1 && rec(st)?.progress?.sharesTrackedRaw === "500", show({ s1, exit: rec(st)?.exit }));
  const soon = await begin(st, { now: () => T0 + 30 * 60000 });
  ok("⭐ a retry 30 minutes later → refused retry-too-soon; nothing written", soon?.ok === false && soon?.code === "retry-too-soon" && !stored(st, key(2)), show(soon));
  const later = await begin(st, { now: () => T0 + H + 1000 });
  ok("⭐⭐ a retry after an hour → attempt 2 at /2; attempt 1 untouched", later?.ok === true && later?.key === key(2) && stored(st, key(2))?.attempt === 2 && stored(st, key(1))?.state === "failed" && rec(st)?.exit?.attempt === 2 && rec(st)?.status === "exiting", show(later));
  ok("⭐ …a DIFFERENT idempotency key, derived from /2 (attempt 1's key at Circle is never reused)",
    stored(st, key(2))?.idempotencyKey === idempotencyKeyFor(key(2)) && stored(st, key(2))?.idempotencyKey !== stored(st, key(1))?.idempotencyKey);
  ok("…the retry records WHY: after a failure", later?.retryOf?.lastOutcome === "failed" || stored(st, key(2))?.retryOf?.lastOutcome === "failed", show(stored(st, key(2))?.retryOf));
}

section("4c — EXIT-PARTIAL retries, for the REMAINDER only, distinguishable from a failure");
{
  const st = memStore(); seed(st, { ...active(), status: "exiting", exit: { attempt: 1, fromStatus: "active" } });
  put(st, 1, mk(1, PARTIAL("200", "300"), T0));
  const s1 = await settle(st, T0 + 1000);
  ok("⭐⭐ attempt 1 PARTIAL (200 of 500 redeemed) → exit-blocked, lastOutcome exit-partial, and the TRACKED shares drop 500 → 300",
    s1?.ok === true && rec(st)?.status === "exit-blocked" && rec(st)?.exit?.lastOutcome === "exit-partial" && rec(st)?.progress?.sharesTrackedRaw === "300", show({ exit: rec(st)?.exit, tracked: rec(st)?.progress?.sharesTrackedRaw }));
  const r2 = await begin(st, { now: () => T0 + H + 1000 });
  ok("⭐⭐ the retry redeems the REMAINDER: 300, not 500 — the 1009998 manual shares are never reached", r2?.ok === true && stored(st, key(2))?.sharesToRedeem === "300", show(stored(st, key(2))?.sharesToRedeem));
  ok("⭐ …and says it is a retry AFTER A PARTIAL (not after a failure)", stored(st, key(2))?.retryOf?.lastOutcome === "exit-partial", show(stored(st, key(2))?.retryOf));
  const d = XI.retryDecision?.({ record: { ...active(), status: "exit-blocked", exit: { attempt: 1, fromStatus: "active", lastOutcome: "exit-partial" } }, attempts: [{ n: 1, read: { readable: true, intent: mk(1, PARTIAL("200", "300"), T0) } }], now: T0 + H + 1 });
  const f = XI.retryDecision?.({ record: { ...active(), status: "exit-blocked", exit: { attempt: 1, fromStatus: "active", lastOutcome: "failed" } }, attempts: [{ n: 1, read: { readable: true, intent: mk(1, FAILED, T0) } }], now: T0 + H + 1 });
  ok("⭐ retryDecision distinguishes them by the LAST ATTEMPT'S INTENT: after-partial vs after-failure", d?.ok === true && d?.kind === "after-partial" && f?.ok === true && f?.kind === "after-failure", show({ d, f }));
}

section("4c — a FULL exit closes the mandate");
{
  const st = memStore(); seed(st, { ...active(), status: "exiting", exit: { attempt: 1, fromStatus: "active" } });
  put(st, 1, mk(1, EXITED, T0));
  const s1 = await settle(st, T0 + 1000);
  ok("⭐ attempt 1 EXITED → the mandate closed, tracked 0", s1?.ok === true && rec(st)?.status === "closed" && rec(st)?.exit?.lastOutcome === "exited" && rec(st)?.progress?.sharesTrackedRaw === "0", show({ status: rec(st)?.status, exit: rec(st)?.exit }));
  const again = await begin(st, { now: () => T0 + 5 * H });
  ok("…and no further attempt begins", again?.ok === false, show(again?.code));
}

section("4c — RECOVERY: attempt 2 in flight vs attempt 1 failed and attempt 2 never started");
{
  // (a) exiting, attempt 2, /2 open
  const a = memStore(); seed(a, { ...active(), status: "exiting", exit: { attempt: 2, fromStatus: "exit-blocked", lastOutcome: "failed" } });
  put(a, 1, mk(1, FAILED, T0)); put(a, 2, mk(2, [{ to: "submitted", circleId: "c-2" }], T0 + H));
  const ra = XI.resolveExitState?.({ record: rec(a), read: await xAdapter(a).read(OWNER, "vm-1", rec(a)?.exit?.attempt) });
  ok("⭐⭐ record `exiting` + attempt 2 + /2 open → attempt 2 IN FLIGHT (read Circle for c-2)", ra?.action === "read-circle" && ra?.circleId === "c-2" && ra?.attempt === 2, show(ra));
  const sa = await settle(a, T0 + 2 * H);
  ok("…settle leaves an in-flight attempt alone", sa?.ok === false && sa?.code === "attempt-in-flight" && rec(a)?.status === "exiting", show(sa));
  const ba = await begin(a, { now: () => T0 + 5 * H });
  ok("…and no new attempt begins", ba?.ok === false && ba?.code === "exit-in-flight", show(ba));

  // (b) exit-blocked, attempt 1, /1 failed, no /2
  const b = memStore(); seed(b, { ...active(), status: "exit-blocked", exit: { attempt: 1, fromStatus: "active", lastOutcome: "failed" } });
  put(b, 1, mk(1, FAILED, T0));
  const rb = XI.retryDecision?.({ record: rec(b), attempts: [{ n: 1, read: await xAdapter(b).read(OWNER, "vm-1", 1) }], now: T0 + H + 1 });
  ok("⭐⭐ record `exit-blocked` + attempt 1 + /1 failed → attempt 1 FAILED, attempt 2 NEVER STARTED: a retry may begin as n = 2", rb?.ok === true && rb?.next === 2, show(rb));

  // (c) exiting, attempt 2, /2 ABSENT (crashed after the CAS, before the intent)
  const c = memStore(); seed(c, { ...active(), status: "exiting", exit: { attempt: 2, fromStatus: "exit-blocked", lastOutcome: "failed" } });
  put(c, 1, mk(1, FAILED, T0));
  const rc = XI.resolveExitState?.({ record: rec(c), read: await xAdapter(c).read(OWNER, "vm-1", 2) });
  ok("⭐ record `exiting` + attempt 2 + /2 ABSENT → nothing submitted for attempt 2", rc?.action === "nothing-submitted", show(rc));
  const sc = await settle(c, T0 + 2 * H);
  ok("⭐⭐ settle writes a create-only NEVER-SUBMITTED record at /2 and hands back the prior status (exit-blocked)",
    sc?.ok === true && stored(c, key(2))?.state === "failed" && stored(c, key(2))?.neverSubmitted === true && rec(c)?.status === "exit-blocked" && rec(c)?.exit?.attempt === 2, show({ sc, i2: stored(c, key(2)), status: rec(c)?.status }));
  const d3 = XI.retryDecision?.({ record: rec(c), attempts: [1, 2].map((n) => ({ n, read: { readable: true, intent: stored(c, key(n)) } })), now: T0 + 4 * H });
  ok("…a never-submitted attempt is NOT counted as a failure (1 failure so far) and a retry may begin as n = 3", d3?.ok === true && d3?.next === 3 && d3?.failures === 1, show(d3));
  // (c') the late intent: begin's write lands before settle's tombstone → the tombstone is refused and nothing is overwritten
  const c2 = memStore(); seed(c2, { ...active(), status: "exiting", exit: { attempt: 1, fromStatus: "active" } });
  const x2 = xAdapter(c2); const late = { ...x2, async read(o, i, n) { const r0 = await x2.read(o, i, n); if (!stored(c2, key(1))) put(c2, 1, mk(1, [], T0)); return r0; } };
  const sl = await call(EX.settleExitAttempt, { owner: OWNER, id: "vm-1", deps: depsFor(c2, { exitIntents: late, now: () => T0 + H }) });
  ok("⭐ an intent that lands between settle's read and its tombstone → the tombstone is REFUSED (create-only); the real intent stays, status stays exiting",
    sl?.ok === false && sl?.code === "intent-appeared" && stored(c2, key(1))?.state === "submitting" && rec(c2)?.status === "exiting", show({ sl, i1: stored(c2, key(1))?.state }));
}

section("4c — the CAPS: 3 failures, 6 attempts");
{
  const three = memStore(); seed(three, { ...active(), status: "exit-blocked", exit: { attempt: 3, fromStatus: "exit-blocked", lastOutcome: "failed" } });
  [1, 2, 3].forEach((n) => put(three, n, mk(n, FAILED, T0)));
  const r3 = await begin(three, { now: () => T0 + 5 * H });
  ok("⭐ three FAILED attempts → refused attempts-exhausted (a human looks); nothing written", r3?.ok === false && r3?.code === "attempts-exhausted" && !stored(three, key(4)), show(r3));
  const six = memStore(); seed(six, { ...active(), status: "exit-blocked", exit: { attempt: 6, fromStatus: "exit-blocked", lastOutcome: "exit-partial" } });
  [1, 2, 3, 4, 5, 6].forEach((n) => put(six, n, mk(n, PARTIAL("1", "499"), T0)));
  const r6 = await begin(six, { now: () => T0 + 5 * H });
  ok("⭐ six attempts (partials dribbling) → refused attempts-exhausted", r6?.ok === false && r6?.code === "attempts-exhausted" && !stored(six, key(7)), show(r6));
  const mixed = memStore(); seed(mixed, { ...active(), status: "exit-blocked", exit: { attempt: 3, fromStatus: "exit-blocked", lastOutcome: "failed" } });
  put(mixed, 1, mk(1, FAILED, T0)); put(mixed, 2, XI.buildNeverSubmittedIntent?.({ record: active(), attempt: 2, now: T0, why: "crashed before the intent" })); put(mixed, 3, mk(3, FAILED, T0));
  const rm = await begin(mixed, { now: () => T0 + 5 * H });
  ok("2 failures + 1 never-submitted → still allowed (attempt 4)", rm?.ok === true && rm?.key === key(4), show(rm));
}

section("4c — every past attempt is READ, and an unreadable or missing one BLOCKS");
{
  const u = memStore(); seed(u, { ...active(), status: "exit-blocked", exit: { attempt: 2, fromStatus: "exit-blocked", lastOutcome: "failed" } });
  put(u, 1, mk(1, FAILED, T0)); put(u, 2, mk(2, FAILED, T0)); u.fault.get = (k) => k === key(1);
  const ru = await begin(u, { now: () => T0 + 5 * H });
  ok("⭐ attempt 1 UNREADABLE → blocked (never 'no failures'), nothing written", ru?.ok === false && ru?.code === "exit-intent-unreadable" && !stored(u, key(3)), show(ru));
  const m = memStore(); seed(m, { ...active(), status: "exit-blocked", exit: { attempt: 2, fromStatus: "exit-blocked", lastOutcome: "failed" } });
  put(m, 2, mk(2, FAILED, T0));
  const rmiss = await begin(m, { now: () => T0 + 5 * H });
  ok("⭐ attempt 1 MISSING while the record names attempt 2 → blocked inconsistent (every number ≤ n has a record)", rmiss?.ok === false && rmiss?.code === "exit-intent-inconsistent", show(rmiss));
  const st = memStore(); seed(st, { ...active(), status: "exiting", exit: { attempt: 1, fromStatus: "active" } }); st.fault.get = (k) => k.startsWith("x/");
  const su = await settle(st);
  ok("settle with the intent UNREADABLE → blocked, nothing written", su?.ok === false && su?.code === "exit-intent-unreadable" && rec(st)?.status === "exiting", show(su));
  const na = memStore(); seed(na, active());
  const sn = await settle(na);
  ok("settle on a mandate that is not exiting → refused, nothing written", sn?.ok === false && rec(na)?.status === "active", show(sn));
}

section("4c — the record's `exit` field");
{
  const liveShape = active();
  ok("⭐ a record with NO exit field (every stored record today, incl. the operator mandate) still verifies and may deposit", !("exit" in liveShape) && REC.verifyMandateRecord(liveShape).mayDeposit === true);
  for (const [label, r] of [
    ["exiting with no exit field", { ...active(), status: "exiting" }],
    ["exit-blocked with no exit field", { ...active(), status: "exit-blocked" }],
    ["exit.attempt 0", { ...active(), status: "exiting", exit: { attempt: 0, fromStatus: "active" } }],
    ["exit.attempt 1.5", { ...active(), status: "exiting", exit: { attempt: 1.5, fromStatus: "active" } }],
    ["exit.attempt as a string", { ...active(), status: "exiting", exit: { attempt: "1", fromStatus: "active" } }],
    ["exit.fromStatus unknown", { ...active(), status: "exiting", exit: { attempt: 1, fromStatus: "exiting" } }],
    ["exit.lastOutcome unknown", { ...active(), status: "exit-blocked", exit: { attempt: 1, fromStatus: "active", lastOutcome: "unconfirmed" } }],
  ]) ok(`⛔ ${label} → the record is inconsistent`, REC.verifyMandateRecord(r).ok === false, show(REC.verifyMandateRecord(r).errors.slice(-1)));
  const fp = REC.mandateFingerprint(active()) === REC.mandateFingerprint({ ...active(), status: "exiting", exit: { attempt: 1, fromStatus: "active" } });
  ok("exit is OUTSIDE the fingerprint (like status): an attempt never stales the acknowledgement", fp);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-vault-mandate-exit-intent — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
