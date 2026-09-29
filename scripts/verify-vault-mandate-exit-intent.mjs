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
const XKEY = `x/${OWNER}/vm-1`;
const stored = (st, k) => st.m.get(k)?.data;

// ════════════════════════════════════════════════════════════════════════════════════════════════
section("RULE 1 — one exit intent per mandate, create-only, at x/<owner>/<id>");
{
  ok("the key is x/<owner lowercased>/<id>", XI.exitIntentKey?.("0xAAAA000000000000000000000000000000000001", "vm-1") === XKEY, show(XI.exitIntentKey?.("0xAAAA000000000000000000000000000000000001", "vm-1")));
  const st = memStore(); seed(st, active());
  const r = await begin(st);
  ok("⭐ begin → ok, the intent is written at x/<owner>/<id>", r?.ok === true && r?.key === XKEY && !!stored(st, XKEY), show(r));
  const it = stored(st, XKEY);
  ok("…state `submitting`, sharesToRedeem = min(tracked 500, live 1009998) = 500, with the tracked figure it used",
    it?.state === "submitting" && it?.sharesToRedeem === "500" && it?.sharesTracked === "500" && it?.sharesTrackedGaps === 0, show(it));
  ok("⭐ …a v4-format idempotency key DERIVED from the intent key (recovery can recompute it)", isV4Uuid(it?.idempotencyKey) && it?.idempotencyKey === idempotencyKeyFor(XKEY), it?.idempotencyKey);
  ok("…no Circle id, no hash, no outcome yet", it?.circleId === null && it?.txHash === null && it?.outcome === null);

  const direct = await call(() => xAdapter(st).create(XKEY, { ...it, sharesToRedeem: "1" }));
  ok("⭐ a second create at the same key → refused (exists), the first byte-for-byte", direct?.ok === false && direct?.exists === true && stored(st, XKEY)?.sharesToRedeem === "500", show(direct));
  const other = memStore(); seed(other, active()); await begin(other);
  ok("only ONE x/ record per mandate (no attempt suffix, no second key)", [...other.m.keys()].filter((k) => k.startsWith("x/")).length === 1, show([...other.m.keys()]));
}

section("RULE 2 — the state machine");
{
  const base = XI.buildExitIntent ? XI.buildExitIntent({ record: active(), limit: { ok: true, shares: "500", tracked: "500", live: "1009998", nothingToRedeem: false }, now: T0 }) : null;
  ok("buildExitIntent → a `submitting` intent", base?.ok === true && base?.intent?.state === "submitting", show(base));
  for (const lim of [{ ok: true, shares: "0", tracked: "0", live: "1009998", nothingToRedeem: true }, { ok: false, code: "tracked-has-gaps" }, null]) {
    const b = XI.buildExitIntent?.({ record: active(), limit: lim, now: T0 });
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
    const st = memStore(); seed(st, active());
    st.m.set(XKEY, { data: { schema: "vault-mandate-exit/1", state, owner: OWNER, id: "vm-1" }, etag: "x1" });
    const before = JSON.stringify([...st.m.entries()]);
    const r = await begin(st);
    ok(`⭐ an OPEN intent (${state}) → refused exit-in-flight; nothing written`, r?.ok === false && r?.code === "exit-in-flight" && JSON.stringify([...st.m.entries()]) === before, show(r));
  }
  for (const state of ["asserted", "failed"]) {
    const st = memStore(); seed(st, active());
    st.m.set(XKEY, { data: { schema: "vault-mandate-exit/1", state, owner: OWNER, id: "vm-1" }, etag: "x1" });
    const r = await begin(st);
    ok(`a TERMINAL intent (${state}) → refused (one intent per mandate; no second key)`, r?.ok === false && r?.code === "exit-intent-exists", show(r));
  }
  const st = memStore(); seed(st, { ...active(), status: "exiting" });
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
  ok("an exit-blocked mandate with NO intent may begin (a retry where nothing was ever written)", (await begin(st4))?.ok === true);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
section("CRASH BETWEEN STATES — the intent stays readable and RESOLVABLE");
{
  const R = (record, read) => XI.resolveExitState?.({ record, read });
  const exiting = { ...active(), status: "exiting" };

  // crash after `exiting`, before the intent: the intent write throws
  const st = memStore(); seed(st, active()); st.fault.set = /^x\//;
  const r = await begin(st);
  ok("⭐ the intent write THROWS after `exiting` → refused exit-intent-unwritten, the mandate left `exiting`", r?.ok === false && r?.code === "exit-intent-unwritten" && stored(st, ST.vaultMandateKey(OWNER, "vm-1"))?.status === "exiting", show(r));
  const res0 = R(exiting, await xAdapter(st).read(OWNER, "vm-1"));
  ok("⭐ …resolvable: `exiting` + NO intent → nothing-submitted (a submit only ever follows a written intent)", res0?.action === "nothing-submitted", show(res0));

  // crash after the intent is written, before Circle: submitting
  const st2 = memStore(); seed(st2, active()); await begin(st2);
  const read2 = await xAdapter(st2).read(OWNER, "vm-1");
  ok("the intent reads back after a crash (readable, state submitting)", read2?.readable === true && read2?.intent?.state === "submitting", show(read2));
  const res1 = R(exiting, read2);
  ok("⭐ submitting → locate-by-idempotency-key, carrying the key (Circle may or may not have accepted it)", res1?.action === "locate-by-idempotency-key" && res1?.idempotencyKey === read2.intent.idempotencyKey, show(res1));

  // advance through the store, crash after each state, resolve
  const x = xAdapter(st2);
  const a1 = await call(EX.advanceStoredExitIntent, { exitIntents: x, owner: OWNER, id: "vm-1", to: "submitted", circleId: "c-9", at: T0 + 1 });
  ok("advanceStoredExitIntent: submitted, persisted", a1?.ok === true && stored(st2, XKEY)?.state === "submitted", show(a1));
  const res2 = R(exiting, await x.read(OWNER, "vm-1"));
  ok("⭐ submitted → read-circle, with the recorded Circle id", res2?.action === "read-circle" && res2?.circleId === "c-9", show(res2));
  await call(EX.advanceStoredExitIntent, { exitIntents: x, owner: OWNER, id: "vm-1", to: "redeemed", txHash: "0x" + "cd".repeat(32), at: T0 + 2 });
  const res3 = R(exiting, await x.read(OWNER, "vm-1"));
  ok("⭐ redeemed → classify, with the hash (the chain decides the outcome)", res3?.action === "classify" && res3?.txHash === "0x" + "cd".repeat(32), show(res3));
  await call(EX.advanceStoredExitIntent, { exitIntents: x, owner: OWNER, id: "vm-1", to: "asserted", outcome: { outcome: "exited", flags: [] }, at: T0 + 3 });
  const res4 = R(exiting, await x.read(OWNER, "vm-1"));
  ok("asserted → close (the mandate's status is settled next)", res4?.action === "close" && res4?.state === "asserted", show(res4));

  const bad = await call(EX.advanceStoredExitIntent, { exitIntents: x, owner: OWNER, id: "vm-1", to: "failed", reason: "late", at: T0 + 4 });
  ok("⛔ a stored terminal intent cannot be advanced", bad?.ok === false && stored(st2, XKEY)?.state === "asserted", show(bad));
  const st5 = memStore(); seed(st5, active()); await begin(st5); st5.fault.get = /^x\//;
  const unr = await call(EX.advanceStoredExitIntent, { exitIntents: xAdapter(st5), owner: OWNER, id: "vm-1", to: "submitted", circleId: "c-1", at: T0 });
  ok("advancing an UNREADABLE stored intent → refused, nothing written", unr?.ok === false && stored(st5, XKEY)?.state === "submitting", show(unr));
  const lost = memStore(); seed(lost, active()); await begin(lost);
  const xl = xAdapter(lost); const lostCas = { ...xl, update: async () => ({ ok: false, conflict: true }) };
  const l = await call(EX.advanceStoredExitIntent, { exitIntents: lostCas, owner: OWNER, id: "vm-1", to: "submitted", circleId: "c-1", at: T0 });
  ok("a lost CAS on advance → refused (conflict), never silently applied", l?.ok === false && stored(lost, XKEY)?.state === "submitting", show(l));

  const inc = R({ ...active(), status: "active" }, { readable: true, intent: stored(st2, XKEY) && { ...stored(st2, XKEY), state: "submitted", circleId: "c-9" } });
  ok("⭐ an OPEN intent while the mandate is NOT `exiting` → blocked (inconsistent: a deposit could interleave)", inc?.action === "blocked" && inc?.code === "inconsistent", show(inc));
  const none = R(active(), { readable: true, intent: null });
  ok("an active mandate with no intent → none", none?.action === "none", show(none));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-vault-mandate-exit-intent — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
