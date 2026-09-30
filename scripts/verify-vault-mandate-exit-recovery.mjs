#!/usr/bin/env node
// verify-vault-mandate-exit-recovery.mjs — piece 5 step 6: exit RECOVERY, the BACKGROUND executor, and the TICK wiring.
//
//   SESSION_SECRET=… node --experimental-test-module-mocks scripts/verify-vault-mandate-exit-recovery.mjs
//   (the suite sets its own test SESSION_SECRET if none is present)
//
// ═══ THE RULES (T, 2026-09-30, from the repeated-idempotency-key measurement) ══════════════════════════
//   · Recovery NEVER RE-SENDS. Key retention was measured only to 32 s; recovery runs on a later tick, so a re-send
//     could CREATE a second redeem. A `submitting` intent is LOCATED by refId (= the intent key) on the wallet's
//     listed transactions. Not found is NOT "never submitted" (the refId round trip is unmeasured): it stays loud.
//   · Each state resolves from its instrument: submitted → Circle's state; redeemed → the CHAIN (classifyExitOutcome);
//     terminal → settle. BEYOND_MANDATE_SHARES records the HALT before anything is settled; if the halt cannot be
//     recorded, nothing is settled.
//   · The background executor authenticates its trigger (requireInternal) and loads the finding from the STORE by key,
//     never from the payload.
//   · The tick recovers `exiting` mandates, and on an EXIT decision triggers the background run (disarmed: it stops at
//     the decision). The receipt now carries the check, so the run re-decides from what the tick saw.

import { mock } from "node:test";
if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef";

// ── @netlify/blobs, in memory, for the background handler (the adapters under test are the REAL ones) ──
const STORES = new Map();
function memStore(name = "x") {
  const m = new Map(); const ops = []; let n = 0; const fault = { get: null, list: null, set: null };
  const hit = (f, k) => (typeof f === "function" ? f(k) : f instanceof RegExp ? f.test(k) : !!f);
  return { name, m, ops, fault,
    async setJSON(key, value, o = {}) { ops.push(["set", key]); globalLog.push(`set:${name}:${key.split("/")[0]}`);
      if (fault.set && hit(fault.set, key)) throw new Error(`blobs down (set ${key})`);
      const cur = m.get(key); if (o.onlyIfNew && cur) return { modified: false };
      if (o.onlyIfMatch !== undefined && (!cur || cur.etag !== o.onlyIfMatch)) return { modified: false };
      const etag = `e${++n}`; m.set(key, { data: JSON.parse(JSON.stringify(value)), etag }); return { modified: true, etag }; },
    async getWithMetadata(key) { ops.push(["get", key]); if (fault.get && hit(fault.get, key)) throw new Error(`blobs down (get ${key})`);
      const cur = m.get(key); return cur ? { data: JSON.parse(JSON.stringify(cur.data)), etag: cur.etag } : null; },
    async get(key) { const r = await this.getWithMetadata(key); return r?.data ?? null; },
    async list({ prefix }) { ops.push(["list", prefix]); if (fault.list && hit(fault.list, prefix)) throw new Error("blobs down (list)");
      return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
  };
}
const globalLog = [];
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: (name) => { if (!STORES.has(name)) STORES.set(name, memStore(name)); return STORES.get(name); } } });

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const show = (v) => { try { return JSON.stringify(v, (k, x) => (typeof x === "bigint" ? `${x}n` : x)); } catch { return String(v); } };
const tryImport = async (p) => { try { return await import(p); } catch (e) { console.log(`  (import ${p} failed: ${e.message.split("\n")[0]})`); return {}; } };
const call = async (fn, ...a) => { try { if (typeof fn !== "function") return { threw: "missing" }; return await fn(...a); } catch (e) { return { threw: e.message }; } };

const XR = await tryImport("../shared/vault-mandate/exit-recovery.mjs");
const XI = await import("../shared/vault-mandate/exit-intent.mjs");
const EX = await import("../netlify/functions/_vault-mandate-exit.mjs");
const ST = await import("../netlify/functions/_vault-mandate-store.mjs");
const REC = await import("../shared/vault-mandate/record.mjs");
const DEP = await import("../netlify/functions/_vault-mandate-deposit.mjs");
const BG = await tryImport("../netlify/functions/vault-mandate-exit-background.mjs");
const { internalToken } = await import("../netlify/functions/_auth.mjs");
const { idempotencyKeyFor } = await import("../shared/circle-idempotency.mjs");

// ── fixtures ──
const OWNER = "0xaaaa000000000000000000000000000000000001";
const WALLET = "0x3d7d4c52305ed0c394e01c7184701a522116097d";
const VADDR = "0x240Eb85458CD41361bd8C3773253a1D78054f747";
const USDC = "0x3600000000000000000000000000000000000000";
const T0 = Date.parse("2026-09-30T12:00:00Z");
const H = 3600000;
const built = REC.buildMandateRecord({ owner: OWNER, walletAddress: WALLET,
  vault: { key: "xylo-usdc", address: VADDR, chainId: 31337, label: "Xylo" }, // fixture chain id
  terms: { amountPerDepositUsdc: 10, maxTotalUsdc: 100, cadence: "weekly" },
  rules: [{ kind: "state", subject: "exit-fee-above", limitBps: 0, onFinding: "exit" }, { kind: "state", subject: "owner-changed", onFinding: "pause" }],
  baseline: { ok: true, owner: { address: "0x94e0dc7ad29b94ec9819f6cec3364dd34f41b3c6", kind: "eoa" }, reportBlock: 990, reportSigned: true, signerVerified: true, maxFeeBps: 2000, vaultAckToken: "ab".repeat(32) },
  now: T0 - 86400000, id: "vm-1", exitAvailable: true });
const active = (progress = { sharesTrackedRaw: "500", sharesTrackedGaps: 0 }) => {
  const a = REC.acknowledgeMandate(built.record, built.record.fingerprint, T0 - 86400000).record;
  return { ...a, progress: { ...a.progress, ...progress } };
};
const exiting = (extra = {}) => ({ ...active(), status: "exiting", exit: { attempt: 1, fromStatus: "active" }, ...extra });
const MKEY = ST.vaultMandateKey(OWNER, "vm-1");
const XKEY = `x/${OWNER}/vm-1/1`;
const LIM = { ok: true, shares: "500", tracked: "500", live: "1009998", nothingToRedeem: false };
const intentAt = (path = []) => { let i = XI.buildExitIntent({ record: active(), limit: LIM, now: T0, attempt: 1 }).intent; for (const s of path) i = XI.advanceExitIntent(i, { at: T0 + 1000, ...s }).intent; return i; };
const HASH = "0x" + "ab".repeat(32);
const SUBMITTED = [{ to: "submitted", circleId: "c-1" }];
const REDEEMED = [...SUBMITTED, { to: "redeemed", txHash: HASH }];
const seed = (st, record, intent) => { st.m.set(MKEY, { data: JSON.parse(JSON.stringify(record)), etag: "e0" }); if (intent) st.m.set(XKEY, { data: JSON.parse(JSON.stringify(intent)), etag: "x0" }); };
const stored = (st, k) => st.m.get(k)?.data;
const writes = (st) => st.ops.filter((o) => o[0] === "set");

// chain facts for classifyExitOutcome: a Withdraw (burned) + the ERC-20 Transfer + the share delta
const t32 = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const facts = ({ burned = 500n, assets = 499n, before = 1009998n, circle = { state: "COMPLETE", txHash: HASH } } = {}) => ({
  circle, receipt: { found: true, status: "success", blockNumber: 777, logs: [
    { address: VADDR, topics: ["0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db", t32(WALLET), t32(WALLET), t32(WALLET)], data: "0x" + assets.toString(16).padStart(64, "0") + burned.toString(16).padStart(64, "0") },
    { address: USDC, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", t32(VADDR), t32(WALLET)], data: "0x" + assets.toString(16).padStart(64, "0") },
  ] }, shares: { atParent: before, atTxBlock: before - burned },
});
const notHalted = { async read() { return { readable: true, halted: false, open: [], cleared: [], unparseable: [], why: null }; } };
const circleFake = ({ txs = [], txsReadable = true, state = { state: "COMPLETE", txHash: HASH } } = {}) => {
  const calls = [];
  return { calls,
    circleTxsForWallet: async (a) => { calls.push(["list", a]); globalLog.push("circle:list"); return txsReadable ? { readable: true, txs } : { readable: false, why: "circle down" }; },
    circleState: async (id) => { calls.push(["state", id]); globalLog.push("circle:state"); return state; },
  };
};
const recDeps = (st, over = {}) => {
  const c = over.circle ?? circleFake();
  const resend = [];
  return { c, resend, deps: {
    mandates: ST.mandateAdapter(st), exitIntents: ST.exitIntentAdapter(st), halt: over.halt ?? ST.haltAdapter(st), now: () => T0 + 2 * H,
    circleTxsForWallet: c.circleTxsForWallet, circleState: c.circleState,
    exitFacts: over.exitFacts ?? (async () => facts()), usdcAddress: USDC,
    // a submit is NEVER a recovery tool — present only to prove it is not called
    submit: async (a) => { resend.push(a); throw new Error("recovery must never re-send"); },
    ...over.deps,
  } };
};
const recover = (st, over) => { const d = recDeps(st, over); return call(EX.recoverMandateExit, { owner: OWNER, id: "vm-1", deps: d.deps }).then((r) => ({ r, ...d })); };

// ════════════════════════════════════════════════════════════════════════════════════════════════
section("PURE RESOLVERS");
{
  const i0 = intentAt();
  const m1 = XR.matchByRefId?.({ intent: i0, txs: [{ id: "c-9", refId: XKEY, createDate: new Date(T0 + 5000).toISOString() }, { id: "c-8", refId: "other" }] });
  ok("matchByRefId: exactly one listed transaction carries refId = the intent key → found, its Circle id", m1?.found === true && m1?.circleId === "c-9", show(m1));
  const m0 = XR.matchByRefId?.({ intent: i0, txs: [{ id: "c-8", refId: "other" }, { id: "c-7" }] });
  ok("none carries it → not found (a same-shaped redeem WITHOUT our refId is never adopted)", m0?.found === false && !m0?.ambiguous, show(m0));
  const m2 = XR.matchByRefId?.({ intent: i0, txs: [{ id: "c-9", refId: XKEY }, { id: "c-10", refId: XKEY }] });
  ok("two carry it → AMBIGUOUS (never picks one)", m2?.ambiguous === true && m2?.found !== true, show(m2));

  const s1 = XR.resolveSubmitting?.({ intent: i0, lookup: { readable: true, match: { found: true, circleId: "c-9" } } });
  ok("submitting + found → move to submitted with that Circle id", s1?.to === "submitted" && s1?.circleId === "c-9", show(s1));
  const s2 = XR.resolveSubmitting?.({ intent: i0, lookup: { readable: true, match: { found: false } } });
  ok("⭐⭐ submitting + NOT found → STUCK (submitting-unlocated), never 'not submitted' — the refId round trip is unmeasured", s2?.action === "stuck" && s2?.code === "submitting-unlocated" && s2?.to === undefined, show(s2));
  const s3 = XR.resolveSubmitting?.({ intent: i0, lookup: { readable: false } });
  ok("submitting + the list unreadable → wait", s3?.action === "wait" && s3?.to === undefined, show(s3));
  const s4 = XR.resolveSubmitting?.({ intent: i0, lookup: { readable: true, match: { ambiguous: true } } });
  ok("submitting + ambiguous → stuck", s4?.action === "stuck" && s4?.to === undefined, show(s4));

  const i1 = intentAt(SUBMITTED);
  const c = (circle) => XR.resolveSubmitted?.({ intent: i1, circle });
  ok("submitted + Circle COMPLETE with a hash → redeemed (the hash)", c({ state: "COMPLETE", txHash: HASH })?.to === "redeemed" && c({ state: "COMPLETE", txHash: HASH })?.txHash === HASH);
  ok("submitted + Circle FAILED with NO hash → failed (rejected before broadcast; nothing on chain)", c({ state: "FAILED", txHash: null })?.to === "failed", show(c({ state: "FAILED", txHash: null })));
  ok("submitted + Circle FAILED WITH a hash → redeemed (it reached the chain; the chain decides)", c({ state: "FAILED", txHash: HASH })?.to === "redeemed");
  ok("submitted + PENDING → wait", c({ state: "PENDING" })?.action === "wait");
  ok("submitted + COMPLETE but no hash → wait (cannot be read yet)", c({ state: "COMPLETE", txHash: null })?.action === "wait");
  ok("submitted + Circle unreadable → wait", c(null)?.action === "wait");

  const r = (outcome, flags = []) => XR.resolveRedeemed?.({ classified: { outcome, flags, why: "x" } });
  ok("redeemed + exited → asserted", r("exited")?.to === "asserted");
  ok("redeemed + exit-partial → asserted", r("exit-partial")?.to === "asserted");
  ok("redeemed + failed (the chain said so) → failed", r("failed")?.to === "failed");
  ok("⭐ redeemed + unconfirmed → WAIT (never asserted, never failed)", r("unconfirmed")?.action === "wait" && r("unconfirmed")?.to === undefined);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
section("RECOVERY — end to end over the real stores");
{
  const st = memStore(); seed(st, exiting(), intentAt());
  const cf = circleFake({ txs: [{ id: "c-9", refId: XKEY }] });
  const { r, resend } = await recover(st, { circle: cf });
  const it = stored(st, XKEY);
  ok("⭐⭐ submitting → located by refId → submitted → redeemed (Circle) → asserted (chain) → SETTLED: the mandate closed, tracked 0",
    r?.ok === true && it?.state === "asserted" && it?.circleId === "c-9" && stored(st, MKEY)?.status === "closed" && stored(st, MKEY)?.progress?.sharesTrackedRaw === "0", show({ r, state: it?.state, status: stored(st, MKEY)?.status }));
  ok("⭐⭐ NEVER RE-SENT: the submit was not called", resend.length === 0);
  ok("the lookup listed the WALLET's transactions (refId has no server-side filter)", cf.calls.some((c) => c[0] === "list" && c[1]?.walletAddress === WALLET), show(cf.calls[0]));
}
{
  const st = memStore(); seed(st, exiting(), intentAt());
  const before = JSON.stringify([...st.m.entries()]);
  const { r, resend } = await recover(st, { circle: circleFake({ txs: [{ id: "c-7", refId: "someone-else" }] }) });
  ok("⭐⭐ submitting + NOT FOUND → stuck, NOTHING written, the intent stays submitting, nothing re-sent",
    r?.ok === false && r?.code === "submitting-unlocated" && JSON.stringify([...st.m.entries()]) === before && resend.length === 0, show(r));
}
{
  const st = memStore(); seed(st, exiting(), intentAt());
  const { r } = await recover(st, { circle: circleFake({ txsReadable: false }) });
  ok("submitting + the list unreadable → wait, nothing written", r?.code === "wait" && writes(st).length === 0, show(r));
}
{
  const st = memStore(); seed(st, exiting(), intentAt(SUBMITTED));
  const { r } = await recover(st, { circle: circleFake({ state: { state: "PENDING" } }) });
  ok("submitted + PENDING → wait, nothing written", r?.code === "wait" && writes(st).length === 0, show(r));
}
{
  const st = memStore(); seed(st, exiting(), intentAt(SUBMITTED));
  const { r } = await recover(st, { circle: circleFake({ state: { state: "FAILED", txHash: null } }) });
  ok("⭐ submitted + FAILED (no hash) → failed → settled exit-blocked, lastOutcome failed (a retry may follow after the hour)",
    stored(st, XKEY)?.state === "failed" && stored(st, MKEY)?.status === "exit-blocked" && stored(st, MKEY)?.exit?.lastOutcome === "failed", show({ r, i: stored(st, XKEY)?.state, m: stored(st, MKEY)?.exit }));
}
{
  const st = memStore(); seed(st, exiting(), intentAt(REDEEMED));
  const { r } = await recover(st, { exitFacts: async () => ({ ...facts(), receipt: null }) });
  ok("⭐ redeemed + the receipt unreadable → UNCONFIRMED → wait: never asserted, never failed, nothing written", r?.code === "wait" && writes(st).length === 0 && stored(st, XKEY)?.state === "redeemed", show(r));
}
{
  const st = memStore(); seed(st, exiting(), intentAt(REDEEMED));
  const { r } = await recover(st, { exitFacts: async () => facts({ burned: 200n, assets: 199n }) });
  ok("⭐ redeemed + PARTIAL (200 of 500) → asserted → exit-blocked, tracked 500 → 300 (4c)", stored(st, XKEY)?.state === "asserted" && stored(st, MKEY)?.status === "exit-blocked" && stored(st, MKEY)?.progress?.sharesTrackedRaw === "300", show({ r, m: stored(st, MKEY)?.progress }));
}
{
  // BEYOND_MANDATE_SHARES: the halt BEFORE the settle
  const st = memStore(); seed(st, exiting(), intentAt(REDEEMED));
  globalLog.length = 0;
  const { r } = await recover(st, { exitFacts: async () => facts({ burned: 600n, assets: 599n }) });
  const iHalt = globalLog.findIndex((l) => l.endsWith(":halt")), iSettle = globalLog.findIndex((l, i) => l.endsWith(":m") && i > 0);
  ok("⭐⭐ the chain burned MORE than submitted → the HALT incident is recorded", [...st.m.keys()].some((k) => k.startsWith("halt/")), show([...st.m.keys()]));
  ok("⭐⭐ …BEFORE the mandate is settled (the halt write precedes the record write)", iHalt >= 0 && (iSettle === -1 || iHalt < iSettle), show(globalLog));
  ok("…and the result says HALTED, loudly", r?.halted === true, show(r));
  const iIntent = globalLog.findIndex((l) => l.endsWith(":x"));
  ok("⭐ …recorded the moment the CHAIN shows it: the halt write precedes even the intent's asserted write", iHalt >= 0 && iIntent > iHalt, show(globalLog));
}
{
  // a crash AFTER the intent was asserted (BEYOND in its outcome) but BEFORE the halt was written: the close branch
  // must still record the halt before it settles
  const st = memStore();
  const beyond = XI.advanceExitIntent(intentAt(REDEEMED), { at: T0 + 2000, to: "asserted", outcome: { outcome: "exited", flags: ["BEYOND_MANDATE_SHARES"], txHash: HASH, blockNumber: 777, beyondMandateShares: "100", mandateSharesRedeemed: "500", usdcReceivedMinor: "599" } }).intent;
  seed(st, exiting(), beyond);
  globalLog.length = 0;
  const { r } = await recover(st);
  const iHalt = globalLog.findIndex((l) => l.endsWith(":halt")), iM = globalLog.findIndex((l) => l.endsWith(":m"));
  ok("⭐⭐ an ASSERTED intent carrying BEYOND, with no halt yet (a crash in between) → the halt is recorded BEFORE the settle",
    [...st.m.keys()].some((k) => k.startsWith("halt/")) && iHalt >= 0 && iM > iHalt && r?.halted === true, show({ r, log: globalLog }));
}
{
  const st = memStore(); seed(st, exiting(), intentAt(REDEEMED));
  const brokenHalt = { async read() { return { readable: true, halted: false }; }, async record() { throw new Error("blobs down"); } };
  const { r } = await recover(st, { exitFacts: async () => facts({ burned: 600n, assets: 599n }), halt: brokenHalt });
  ok("⭐ BEYOND + the halt CANNOT be recorded → nothing is settled (the mandate stays exiting), refused loudly",
    r?.ok === false && r?.code === "halt-unrecorded" && stored(st, MKEY)?.status === "exiting", show({ r, status: stored(st, MKEY)?.status }));
  ok("⭐ …and the intent is NOT advanced either: it stays redeemed until the incident can be recorded", stored(st, XKEY)?.state === "redeemed", stored(st, XKEY)?.state);
}
{
  const st = memStore(); seed(st, active());
  const { r } = await recover(st);
  ok("a mandate that is NOT exiting → nothing to recover, nothing written", r?.ok === true && r?.code === "not-exiting" && writes(st).length === 0, show(r));
  const st2 = memStore(); seed(st2, exiting(), intentAt()); st2.fault.get = (k) => k.startsWith("x/");
  const { r: r2 } = await recover(st2);
  ok("⭐ the intent UNREADABLE → blocked, nothing written (never 'absent')", r2?.ok === false && r2?.code === "exit-intent-unreadable" && writes(st2).length === 0, show(r2));
  const st3 = memStore(); seed(st3, exiting());
  const { r: r3 } = await recover(st3);
  ok("exiting with NO intent → nothing-submitted → the never-submitted record + the prior status (4c's settle)", stored(st3, XKEY)?.neverSubmitted === true && stored(st3, MKEY)?.status === "active", show(r3));
}
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("netlify/functions/_vault-mandate-exit.mjs", "utf8");
  const body = src.slice(src.indexOf("export async function recoverMandateExit"));
  const fn = body.slice(0, body.indexOf("\n}\n") + 2).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  ok("⭐ SOURCE: recoverMandateExit calls no submit (submitRedeem, submitMandateExitRedeem, deps.submit, createContractExecutionTransaction)",
    fn.length > 50 && !/submitRedeem\s*\(|submitMandateExitRedeem\s*\(|deps\.submit\s*\(|createContractExecutionTransaction/.test(fn), fn.length > 50 ? "" : "function not found");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
section("THE SUBMIT CARRIES THE refId (runMandateExit → submitMandateExitRedeem)");
{
  const sub = []; const st = memStore(); seed(st, active());
  const r = await call(EX.submitMandateExitRedeem, { record: active(), liveShares: 1009998n, halt: notHalted, idempotencyKey: idempotencyKeyFor(XKEY), refId: XKEY,
    submit: async (a) => { sub.push(a); return { circleId: "c", redeemHash: HASH }; } });
  ok("⭐ submitMandateExitRedeem passes the refId through to the submit", sub[0]?.refId === XKEY, show(sub[0]));
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("netlify/functions/_vault-mandate-exit.mjs", "utf8");
  const run = src.slice(src.indexOf("export async function runMandateExit"));
  ok("runMandateExit submits with refId = the intent's key", /submitMandateExitRedeem\(\{[^}]*refId:\s*b\.intent\.key/s.test(run));
  void r;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
section("THE BACKGROUND EXECUTOR — authenticated trigger, the finding from the STORE");
const WKEY = `w/${OWNER}/vm-1/${T0 - 86400000}-0`;
const RECEIPT = { at: new Date(T0).toISOString(), window: WKEY, outcome: "would-pause",
  check: { observations: {}, anchor: { blockNumber: 900, blockHash: "0x" + "cd".repeat(32), timestamp: Math.floor(T0 / 1000) } },
  anchor: { blockNumber: 900, blockHash: "0x" + "cd".repeat(32), timestamp: Math.floor(T0 / 1000) },
  exitPath: { readable: true, known: true, profile: "xylo", adapter: null } };
{
  const job = (body, deps) => call(BG.runExitJob, { body, deps });
  const receipts = memStore("r"); receipts.m.set(WKEY, { data: RECEIPT, etag: "w0" });
  const st = memStore(); seed(st, active());
  const seen = [];
  const deps = { mandates: ST.mandateAdapter(st), receipts: { read: async (k) => (await receipts.getWithMetadata(k))?.data ?? null },
    runExit: async (a) => { seen.push(["run", a]); return { ok: false, stage: "decide", code: "disarmed" }; },
    recoverExit: async (a) => { seen.push(["recover", a]); return { ok: true, code: "not-exiting" }; },
    record: async () => {} };
  const r1 = await job({ owner: OWNER, id: "vm-1", receiptKey: WKEY, check: { observations: { FORGED: 1 } }, exitPath: { profile: "forged" } }, deps);
  const f = seen.find((s) => s[0] === "run")?.[1]?.finding;
  ok("⭐⭐ the finding comes from the STORED receipt (its check, anchor, exitPath) — the payload's `check`/`exitPath` are IGNORED",
    f && f.exitPath?.profile === "xylo" && !("FORGED" in (f.check?.observations ?? {})) && f.anchor?.blockNumber === 900, show(f));
  ok("…a disarmed run stops at the decision", r1?.stage === "decide" && r1?.code === "disarmed", show(r1));
  seen.length = 0;
  const r2 = await job({ owner: OWNER, id: "vm-1", receiptKey: `w/0xbbbb000000000000000000000000000000000002/vm-9/1-0` }, deps);
  ok("⭐ a receipt key that is NOT this mandate's → refused, nothing run", r2?.ok === false && r2?.code === "receipt-not-this-mandate" && seen.length === 0, show(r2));
  const r3 = await job({ owner: OWNER, id: "vm-1", receiptKey: `w/${OWNER}/vm-1/missing-0` }, deps);
  ok("a receipt that does not exist → refused, nothing run", r3?.ok === false && r3?.code === "no-receipt" && seen.length === 0, show(r3));
  const receipts2 = memStore("r"); receipts2.m.set(WKEY, { data: { ...RECEIPT, check: undefined }, etag: "w0" });
  const r4 = await job({ owner: OWNER, id: "vm-1", receiptKey: WKEY }, { ...deps, receipts: { read: async (k) => (await receipts2.getWithMetadata(k))?.data ?? null } });
  ok("a receipt with no stored check → refused (nothing to re-decide from)", r4?.ok === false && r4?.code === "receipt-incomplete" && seen.length === 0, show(r4));
  const st2 = memStore(); seed(st2, exiting());
  const r5 = await job({ owner: OWNER, id: "vm-1", receiptKey: WKEY }, { ...deps, mandates: ST.mandateAdapter(st2) });
  ok("⭐ the mandate already EXITING → RECOVERY runs, never a new exit", seen.some((s) => s[0] === "recover") && !seen.some((s) => s[0] === "run"), show(seen.map((s) => s[0])));
  for (const [label, body] of [["no owner", { id: "vm-1", receiptKey: WKEY }], ["a non-address owner", { owner: "me", id: "vm-1", receiptKey: WKEY }], ["no body at all", undefined]]) {
    seen.length = 0;
    const r = await job(body, deps);
    ok(`${label} → refused, nothing run`, r?.ok === false && seen.length === 0, show(r?.code));
  }
}
{
  const h = (event) => call(BG.handler, event);
  STORES.clear();
  const noTok = await h({ httpMethod: "POST", headers: {}, body: JSON.stringify({ owner: OWNER, id: "vm-1", receiptKey: WKEY }) });
  ok("⭐⭐ the HANDLER with no x-internal-token → 401, and NO store was even opened", noTok?.statusCode === 401 && STORES.size === 0, show({ status: noTok?.statusCode, stores: [...STORES.keys()] }));
  const bad = await h({ httpMethod: "POST", headers: { "x-internal-token": "forged" }, body: "{}" });
  ok("a forged token → 401", bad?.statusCode === 401 && STORES.size === 0, show(bad?.statusCode));
  const get = await h({ httpMethod: "GET", headers: { "x-internal-token": internalToken() } });
  ok("a GET, even authenticated → 405", get?.statusCode === 405, show(get?.statusCode));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
section("THE TICK — recovers exiting mandates; an EXIT decision triggers the background run");
{
  const calls = [];
  const mk = (record) => ({ list: async () => [{ owner: OWNER, id: "vm-1" }], read: async () => ({ readable: true, record, etag: "e0", verdict: REC.verifyMandateRecord(record) }) });
  const base = (record, over = {}) => ({ now: () => T0, halt: notHalted, mandates: mk(record), isPaused: async () => null,
    receipts: { exists: async () => false, write: async (k, v) => { calls.push(["receipt", k, v]); return { ok: true }; } },
    limits: { vaultCapUsdc: () => 1000, ceilingUsdc: () => 1000, userReserveFraction: () => 0, canSpendDay: async () => ({ allowed: true }), mandateDaySpend: async () => 0, dcaDaySpend: async () => 0, scaUsdcBalanceMinor: async () => 100_000_000n },
    recoverExit: async (a) => { calls.push(["recover", a]); return { ok: true, code: "wait" }; },
    triggerExit: async (a) => { calls.push(["trigger", a]); return { ok: true }; },
    runCheck: async () => { calls.push(["check"]); return exitCheck(record); }, ...over });
  const exitCheck = (record) => ({ anchor: { blockNumber: 900, blockHash: "0x" + "cd".repeat(32), timestamp: Math.floor(T0 / 1000) },
    check: { observations: { [record.rules[0].id]: { status: "violated", evidence: { feeBps: 10 } }, [record.rules[1].id]: { status: "clear" } }, anchor: { blockNumber: 900, blockHash: "0x" + "cd".repeat(32), timestamp: Math.floor(T0 / 1000) } },
    report: null, verification: null, readings: [], exitPath: { readable: true, known: true, profile: "xylo", adapter: null }, timing: { anchoredAt: T0 - 1000, verifiedAt: T0, signingLatencyMs: 1000 }, cost: { signCalls: 1 } });

  calls.length = 0;
  const t1 = await call(DEP.runMandateTick, { deps: base(exiting()) });
  ok("⭐ an EXITING mandate → the tick runs RECOVERY for it, and no check", calls.some((c) => c[0] === "recover" && c[1]?.owner === OWNER) && !calls.some((c) => c[0] === "check"), show({ t1, calls: calls.map((c) => c[0]) }));

  calls.length = 0;
  const t2 = await call(DEP.runMandateTick, { deps: base(active()) });
  const trig = calls.find((c) => c[0] === "trigger")?.[1];
  const rec = calls.find((c) => c[0] === "receipt")?.[2];
  ok("⭐⭐ an EXIT decision → the tick TRIGGERS the background run with this window's receipt key", trig?.owner === OWNER && trig?.id === "vm-1" && typeof trig?.receiptKey === "string" && trig.receiptKey.startsWith(`w/${OWNER}/vm-1/`), show({ trig, outcome: t2?.results?.[0]?.outcome }));
  ok("⭐ …and the receipt it points at STORES the check (so the run re-decides from what the tick saw)", rec?.check?.observations && Object.keys(rec.check.observations).length === 2 && calls.find((c) => c[0] === "receipt")?.[1] === trig?.receiptKey, show(Object.keys(rec ?? {})));

  calls.length = 0;
  const t3 = await call(DEP.runMandateTick, { deps: base(active(), { triggerExit: async () => { throw new Error("network"); } }) });
  ok("the trigger THROWS → the tick still completes and SAYS the trigger failed (never silent)", t3?.ok === true && /trigger/i.test(show(t3?.results?.[0])), show(t3?.results?.[0]));

  calls.length = 0;
  const noTrig = base(active()); delete noTrig.triggerExit;
  const t4 = await call(DEP.runMandateTick, { deps: noTrig });
  ok("no trigger wired → the tick completes and says the exit was NOT triggered", t4?.ok === true && /not triggered|no trigger/i.test(show(t4?.results?.[0])), show(t4?.results?.[0]));

  calls.length = 0;
  const noRec = base(exiting()); delete noRec.recoverExit;
  const t5 = await call(DEP.runMandateTick, { deps: noRec });
  ok("an exiting mandate with NO recovery wired → reported unrecovered, never skipped silently", /recover/i.test(show(t5?.results?.[0])) && !calls.some((c) => c[0] === "check"), show(t5?.results?.[0]));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-vault-mandate-exit-recovery — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
