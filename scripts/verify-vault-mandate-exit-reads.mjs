#!/usr/bin/env node
// verify-vault-mandate-exit-reads.mjs — piece 5 step 5: the FRESH EXECUTION READS, the exit-path gate (blocker 3),
// and the ORDER: READS → INTENT → SUBMIT.
//
//   node --experimental-test-module-mocks scripts/verify-vault-mandate-exit-reads.mjs
//
// ═══ THE REQUIREMENTS (T, 2026-09-29) ══════════════════════════════════════════════════════════════════
//   · READS, then INTENT, then SUBMIT — explicit and tested. A vault refused by the fresh simulated redeem burns NO
//     attempt: the intent must not exist yet. A test proves the refusal path writes NOTHING.
//   · BLOCKER 3: the fresh reads re-check the vault's exit path (its liquidity adapter) against the one the finding
//     check recorded. xylo: trivially satisfied (no adapter). A V2 vault: REFUSE until the DD V2 profile exists —
//     never skip the comparison. A structural refusal, not a note.

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

const XP = await tryImport("../shared/vault-mandate/exit-path.mjs");
const XR = await tryImport("../shared/vault-mandate/exit-reads.mjs");
const EX = await import("../netlify/functions/_vault-mandate-exit.mjs");
const ST = await import("../netlify/functions/_vault-mandate-store.mjs");
const REC = await import("../shared/vault-mandate/record.mjs");
const { sel } = await import("../shared/onchain-facts/index.mjs");
const { redeemSimulationOutcome } = await import("../shared/vault-mandate/redeem-sim.mjs");
const { BaseError, ContractFunctionRevertedError, encodeErrorResult, parseAbi } = await import("viem");

// ── a real, acknowledged record (the exit-intent suite's fixture) ──
const OWNER = "0xaaaa000000000000000000000000000000000001";
const WALLET = "0x3d7d4c52305ed0c394e01c7184701a522116097d";
const VADDR = "0x240Eb85458CD41361bd8C3773253a1D78054f747";
const T0 = Date.parse("2026-09-29T12:00:00Z");
const built = REC.buildMandateRecord({ owner: OWNER, walletAddress: WALLET,
  vault: { key: "xylo-usdc", address: VADDR, chainId: 31337, label: "Xylo" }, // fixture chain id
  terms: { amountPerDepositUsdc: 10, maxTotalUsdc: 100, cadence: "weekly" },
  rules: [{ kind: "state", subject: "owner-changed", onFinding: "pause" }, { kind: "state", subject: "exit-fee-above", limitBps: 50, onFinding: "pause" }],
  baseline: { ok: true, owner: { address: "0x94e0dc7ad29b94ec9819f6cec3364dd34f41b3c6", kind: "eoa" }, reportBlock: 990, reportSigned: true, signerVerified: true, maxFeeBps: 2000, vaultAckToken: "ab".repeat(32) },
  now: T0 - 86400000, id: "vm-1" });
const active = (progress = { sharesTrackedRaw: "500", sharesTrackedGaps: 0 }) => {
  const a = REC.acknowledgeMandate(built.record, built.record.fingerprint, T0 - 86400000).record;
  return { ...a, progress: { ...a.progress, ...progress } };
};

// ── fake endpoint readers ──
const XYLO_CODE = "0x6080" + sel("setFees(uint256,uint256,uint256)") + "00" + sel("emergencyWithdraw(address,uint256)") + "00";
const V2_CODE = "0x6080" + sel("setCurator(address)") + "00" + sel("setSendSharesGate(address)") + "00"; // a Morpho-V2-shaped surface
const HASH = "0x" + "12".repeat(32);
const paid = (assets) => redeemSimulationOutcome({ result: assets });
const shortfall = () => {
  const data = encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["ERC20: transfer amount exceeds balance"] });
  const inner = new ContractFunctionRevertedError({ abi: parseAbi(["error Error(string)"]), data, functionName: "redeem" });
  return redeemSimulationOutcome({ error: new BaseError("reverted", { cause: inner }) });
};
function reader(name, over = {}) {
  const calls = [];
  const state = { balance: 1009998n, withdrawFee: 10n, decimals: 6n, gross: 1000000n, net: 999000n, code: XYLO_CODE, sim: (s) => paid(s - s / 1000n), head: 1000, ...over };
  const log = (fn) => { calls.push(fn); globalLog.push(`read:${name}:${fn}`); };
  return { calls, endpoint: `https://${name}.example`,
    blockNumber: async () => { log("blockNumber"); return state.head; },
    block: async (n) => { log("block"); return state.block ?? { hash: HASH, timestamp: Math.floor(T0 / 1000) }; },
    read: async ({ fn, args }) => {
      log(fn);
      if (state.throwOn === fn) throw new Error(`${fn} down`);
      return ({ balanceOf: state.balance, withdrawFee: state.withdrawFee, decimals: state.decimals, convertToAssets: state.gross, previewRedeem: state.net })[fn];
    },
    code: async () => { log("code"); if (state.throwOn === "code") throw new Error("code down"); return state.code; },
    simulateRedeem: async ({ shares }) => { log(`simulateRedeem(${shares})`); return state.sim(shares); },
  };
}
const globalLog = [];

// ════════════════════════════════════════════════════════════════════════════════════════════════
section("BLOCKER 3 — the exit path (liquidity adapter) registry and gate");
{
  const x = XP.exitPathFromProfile?.("xylo");
  ok("xylo → a KNOWN exit path with NO adapter", x?.known === true && x?.profile === "xylo" && x?.adapter === null, show(x));
  for (const p of [null, "morpho-v2", "morpho-v1", "anything"]) {
    const u = XP.exitPathFromProfile?.(p);
    ok(`profile ${show(p)} → UNKNOWN exit path (not in the registry)`, u?.known === false, show(u));
  }
  ok("every registry entry is a recognised vault profile", Object.keys(XP.EXIT_PATHS ?? { x: 1 }).every((k) => k === "xylo"), show(Object.keys(XP.EXIT_PATHS ?? {})));
  let threw = null;
  try { XP.assertExitPathRegistry?.({ "morpho-v2": { adapter: "via-liquidityAdapter()" } }); } catch (e) { threw = e.message; }
  ok("⭐ STRUCTURAL: a registry entry WITH an adapter is refused at load (no adapter comparison is built yet — it cannot be added as a note)", /adapter/i.test(threw ?? ""), threw ?? "did not throw");
  ok("…the shipped registry passes that guard", (() => { try { XP.assertExitPathRegistry?.(XP.EXIT_PATHS); return typeof XP.assertExitPathRegistry === "function"; } catch { return false; } })());

  const g = (recorded, fresh) => XP.exitPathGate?.({ recorded, fresh });
  const XY = { readable: true, known: true, profile: "xylo", adapter: null };
  const V2 = { readable: true, known: false, profile: null, why: "unrecognised" };
  ok("⭐ xylo recorded, xylo now → ok (trivially: no adapter on either side)", g(XY, XY)?.ok === true, show(g(XY, XY)));
  ok("⭐⭐ a V2 vault (UNKNOWN path) recorded AND now → REFUSED exit-path-unverifiable — the comparison is never skipped, even when both sides agree",
    g(V2, V2)?.ok === false && g(V2, V2)?.code === "exit-path-unverifiable", show(g(V2, V2)));
  ok("xylo recorded, UNKNOWN now (the code changed) → refused", g(XY, V2)?.ok === false, show(g(XY, V2)?.code));
  ok("⭐ the finding check recorded NO exit path → refused exit-path-unrecorded (never assumed)", g(undefined, XY)?.ok === false && g(undefined, XY)?.code === "exit-path-unrecorded", show(g(undefined, XY)));
  ok("recorded unreadable → refused", g({ readable: false, why: "x" }, XY)?.ok === false);
  ok("fresh unreadable → refused, retry", g(XY, { readable: false, why: "x" })?.ok === false && g(XY, { readable: false, why: "x" })?.then === "retry", show(g(XY, { readable: false, why: "x" })));
  ok("a different KNOWN profile now than at the finding → refused exit-path-changed", g(XY, { ...XY, profile: "other" })?.code === "exit-path-changed");
  ok("xylo with an adapter claimed on either side → refused (inconsistent with the registry)", g({ ...XY, adapter: "0x" + "11".repeat(20) }, XY)?.ok === false && g(XY, { ...XY, adapter: "0x" + "11".repeat(20) })?.ok === false);

  const rx = await call(XP.readExitPath, { reader: reader("a"), vault: { address: VADDR }, anchor: { blockHash: HASH } });
  ok("readExitPath: xylo bytecode (by block hash) → readable, known, xylo, no adapter", rx?.readable === true && rx?.known === true && rx?.profile === "xylo" && rx?.adapter === null, show(rx));
  const rv = await call(XP.readExitPath, { reader: reader("a", { code: V2_CODE }), vault: { address: VADDR }, anchor: { blockHash: HASH } });
  ok("readExitPath: a V2-shaped surface → readable, UNKNOWN (unrecognised)", rv?.readable === true && rv?.known === false, show(rv));
  const rt = await call(XP.readExitPath, { reader: reader("a", { throwOn: "code" }), vault: { address: VADDR }, anchor: { blockHash: HASH } });
  ok("readExitPath: the code read fails → UNREADABLE (never 'no adapter')", rt?.readable === false, show(rt));
  const rn = await call(XP.readExitPath, { reader: { ...reader("a"), code: undefined }, vault: { address: VADDR }, anchor: { blockHash: HASH } });
  ok("readExitPath: a reader with no code() at all → UNREADABLE", rn?.readable === false, show(rn));
  const ag = XP.agreedExitPath?.([rx, { ...rx }]), dis = XP.agreedExitPath?.([rx, rv]), one = XP.agreedExitPath?.([rx]);
  ok("agreedExitPath: both endpoints xylo → that; disagreeing → unreadable; one endpoint → unreadable", ag?.readable === true && ag?.profile === "xylo" && dis?.readable === false && one?.readable === false, show({ ag, dis, one }));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
section("FRESH EXECUTION READS — both endpoints, one fresh anchor, all agreed");
const reads = (record, a = {}, b = {}) => call(XR.readExitExecution, { record, readers: [reader("a", a), reader("b", b)] });
{
  const r = await reads(active());
  ok("⭐ agreed: live 1009998, limit min(500, 1009998) = 500, declared exit fee 10 bps, exit path xylo, simulation PAID",
    r?.ok === true && r?.liveShares === "1009998" && r?.limit?.shares === "500" && r?.exitFeeBps === 10 && r?.exitPath?.profile === "xylo" && r?.simulation?.class === "paid", show(r));
  ok("…the fresh anchor carries its chain time", r?.anchor?.blockHash === HASH && Number.isInteger(r?.anchor?.timestamp), show(r?.anchor));
  const ra = reader("a"), rb = reader("b");
  await call(XR.readExitExecution, { record: active(), readers: [ra, rb] });
  ok("⭐ the SIMULATED redeem is of the LIMIT (500), never the whole live balance", ra.calls.includes("simulateRedeem(500)") && rb.calls.includes("simulateRedeem(500)") && !ra.calls.some((c) => c === "simulateRedeem(1009998)"), show(ra.calls));

  const z = memo(); const rz = await call(XR.readExitExecution, { record: active({ sharesTrackedRaw: "0", sharesTrackedGaps: 0 }), readers: [z.a, z.b] });
  ok("⭐ today's live case (tracked 0) → refused nothing-to-redeem, and NO simulation is run", rz?.ok === false && rz?.code === "nothing-to-redeem" && !z.a.calls.some((c) => c.startsWith("simulateRedeem")), show(rz));
  const gap = await reads(active({ sharesTrackedRaw: "500", sharesTrackedGaps: 1 }));
  ok("a gapped tracked figure → refused with the limit's code", gap?.ok === false && gap?.code === "tracked-has-gaps", show(gap?.code));

  const dis = await reads(active(), {}, { balance: 1009997n });
  ok("the endpoints disagree on the live balance → refused reads-unagreed (retry)", dis?.ok === false && dis?.code === "reads-unagreed" && dis?.then === "retry", show(dis));
  const feeDis = await reads(active(), {}, { withdrawFee: 11n });
  ok("the endpoints disagree on the exit fee → refused reads-unagreed", feeDis?.ok === false && feeDis?.code === "reads-unagreed", show(feeDis?.code));
  const down = await reads(active(), { throwOn: "balanceOf" });
  ok("a read fails on one endpoint → refused (retry), never read as 0", down?.ok === false && down?.then === "retry", show(down));
  const noAnchor = await reads(active(), {}, { block: { hash: "0x" + "34".repeat(32), timestamp: Math.floor(T0 / 1000) } });
  ok("no agreed anchor (the endpoints name different blocks) → refused", noAnchor?.ok === false && noAnchor?.code === "no-anchor", show(noAnchor));

  const sf = await reads(active(), { sim: shortfall }, { sim: shortfall });
  ok("⭐ the simulated redeem SHORTFALLS on both → refused vault-cannot-pay (a later tick retries; no attempt exists to burn)", sf?.ok === false && sf?.code === "vault-cannot-pay" && sf?.then === "retry", show(sf));
  const mixed = await reads(active(), {}, { sim: shortfall });
  ok("paid on one endpoint, shortfall on the other → refused (disagreement, retry)", mixed?.ok === false && mixed?.then === "retry", show(mixed?.code));
  const odd = await reads(active(), { sim: () => redeemSimulationOutcome({ result: 0n }) }, { sim: () => redeemSimulationOutcome({ result: 0n }) });
  ok("an UNRECOGNISED simulation (returned 0) → refused, never a pass", odd?.ok === false && odd?.code === "simulation-unrecognised", show(odd?.code));
  const amt = await reads(active(), {}, { sim: (s) => paid(s - s / 1000n - 1n) });
  ok("paid on both but DIFFERENT amounts → refused (the endpoints disagree)", amt?.ok === false && amt?.code === "reads-unagreed", show(amt?.code));
  const v2 = await reads(active(), { code: V2_CODE }, { code: V2_CODE });
  ok("a V2-shaped vault: the reads still complete — the refusal is the GATE's (next section), recorded as an UNKNOWN exit path", v2?.ok === true && v2?.exitPath?.known === false, show(v2?.exitPath));
}
function memo() { return { a: reader("a"), b: reader("b") }; }

// ════════════════════════════════════════════════════════════════════════════════════════════════
section("⭐⭐ THE ORDER: READS → INTENT → SUBMIT (runMandateExit)");
function memStore() {
  const m = new Map(); const ops = []; let n = 0;
  return { m, ops,
    async setJSON(key, value, o = {}) { ops.push(["set", key]); globalLog.push(`write:${key.split("/")[0]}`); const cur = m.get(key);
      if (o.onlyIfNew && cur) return { modified: false }; if (o.onlyIfMatch !== undefined && (!cur || cur.etag !== o.onlyIfMatch)) return { modified: false };
      const etag = `e${++n}`; m.set(key, { data: JSON.parse(JSON.stringify(value)), etag }); return { modified: true, etag }; },
    async getWithMetadata(key) { ops.push(["get", key]); const cur = m.get(key); return cur ? { data: JSON.parse(JSON.stringify(cur.data)), etag: cur.etag } : null; },
    async get(key) { const r = await this.getWithMetadata(key); return r?.data ?? null; },
    async list({ prefix }) { ops.push(["list", prefix]); return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
  };
}
const MKEY = ST.vaultMandateKey(OWNER, "vm-1");
const seed = (st, r) => st.m.set(MKEY, { data: JSON.parse(JSON.stringify(r)), etag: "e0" });
const XY_FINDING = { exitPath: { readable: true, known: true, profile: "xylo", adapter: null }, check: {}, anchor: {} };
const goDecide = (a) => { globalLog.push("decide"); return { go: true, feeBps: a.execution.exitFeeBps, capBps: 2000, anchor: {} }; };
const notHalted = { async read() { return { readable: true, halted: false, open: [], cleared: [], unparseable: [], why: null }; } };
const submitter = () => { const calls = []; return { calls, submit: async (a) => { calls.push(a); globalLog.push("submit"); await a.onSubmitted?.({ stage: "redeem", circleId: "c-77" }); return { circleId: "c-77", redeemHash: "0x" + "ee".repeat(32) }; } }; };
const run = async (st, { readers = [reader("a"), reader("b")], finding = XY_FINDING, decide = goDecide, sub = submitter(), over = {} } = {}) => {
  globalLog.length = 0;
  const deps = { mandates: ST.mandateAdapter(st), depositIntents: ST.intentAdapter(st), exitIntents: ST.exitIntentAdapter(st), halt: notHalted,
    // ⚠️ `decide: null` = the PRODUCTION default. (undefined would re-trigger this helper's default parameter, goDecide —
    // the default-parameter trap PROGRESS records from step 1.)
    now: () => T0, readers, decide: decide === null ? undefined : decide, pauseCheck: async () => ({ checked: true, reason: null }), submit: sub.submit, ...over };
  const r = await call(EX.runMandateExit, { owner: OWNER, id: "vm-1", finding, deps });
  return { r, sub, log: [...globalLog] };
};
const writes = (st) => st.ops.filter((o) => o[0] === "set");
{
  const st = memStore(); seed(st, active());
  const { r, sub, log } = await run(st);
  const lastRead = Math.max(...log.map((l, i) => (l.startsWith("read:") ? i : -1)));
  const firstWrite = log.findIndex((l) => l.startsWith("write:"));
  const iSubmit = log.indexOf("submit"), iIntent = log.indexOf("write:x"), iDecide = log.indexOf("decide");
  ok("⭐⭐ happy path → ok: attempt 1 submitted and redeemed", r?.ok === true && r?.attempt === 1 && r?.redeemHash === "0x" + "ee".repeat(32), show(r));
  ok("⭐⭐ ORDER: every chain READ happens before the FIRST store write", lastRead >= 0 && firstWrite > lastRead, show(log));
  ok("⭐⭐ ORDER: decide after the reads, the INTENT before the SUBMIT", iDecide > lastRead && iIntent > iDecide && iSubmit > iIntent, show({ lastRead, iDecide, iIntent, iSubmit }));
  ok("the submit redeems the intent's shares (500), with the intent's idempotency key", sub.calls[0]?.shares === "500" && sub.calls[0]?.idempotencyKey === st.m.get(`x/${OWNER}/vm-1/1`)?.data?.idempotencyKey, show(sub.calls[0]?.shares));
  const it = st.m.get(`x/${OWNER}/vm-1/1`)?.data;
  ok("…the intent advanced submitted (Circle id c-77, via onSubmitted) → redeemed (the hash)", it?.state === "redeemed" && it?.circleId === "c-77" && it?.txHash === "0x" + "ee".repeat(32), show({ state: it?.state, history: it?.history?.map((h) => h.state) }));
  ok("…the mandate exiting, attempt 1", st.m.get(MKEY)?.data?.status === "exiting" && st.m.get(MKEY)?.data?.exit?.attempt === 1);
}
{
  // THE REFUSAL PATHS WRITE NOTHING
  const cases = [
    ["⭐⭐ the fresh simulated redeem SHORTFALLS (a cash-short vault)", { readers: [reader("a", { sim: shortfall }), reader("b", { sim: shortfall })] }, "vault-cannot-pay"],
    ["the endpoints disagree", { readers: [reader("a"), reader("b", { balance: 7n })] }, "reads-unagreed"],
    ["⭐ a V2 vault (unknown exit path)", { readers: [reader("a", { code: V2_CODE }), reader("b", { code: V2_CODE })], finding: { ...XY_FINDING, exitPath: { readable: true, known: false, profile: null } } }, "exit-path-unverifiable"],
    ["the finding recorded no exit path", { finding: { check: {}, anchor: {} } }, "exit-path-unrecorded"],
    ["the decision refuses", { decide: () => ({ go: false, code: "disarmed", why: "disarmed", then: "none", wouldExit: true }) }, "disarmed"],
    ["the pause is on", { decide: (a) => (a.pause?.reason ? { go: false, code: "paused", why: a.pause.reason, then: "exit-due-paused" } : goDecide(a)), over: { pauseCheck: async () => ({ checked: true, reason: "Your Vault agent is paused." }) } }, "paused"],
  ];
  for (const [label, opts, code] of cases) {
    const st = memStore(); seed(st, active());
    const { r, sub } = await run(st, opts);
    ok(`${label} → refused ${code}: ZERO store writes (no exiting, no intent, no attempt), submit NOT called`,
      r?.ok === false && r?.code === code && writes(st).length === 0 && sub.calls.length === 0 && !("exit" in (st.m.get(MKEY)?.data ?? {})), show({ r, writes: writes(st) }));
  }
  const st = memStore(); seed(st, active());
  const { r } = await run(st, { readers: [reader("a", { sim: shortfall }), reader("b", { sim: shortfall })] });
  const again = await run(st, {});
  ok("⭐⭐ after a shortfall, the next run is attempt 1 — the refusal BURNED NO ATTEMPT", r?.code === "vault-cannot-pay" && again.r?.ok === true && again.r?.attempt === 1, show({ first: r?.code, second: again.r?.attempt }));
}
{
  // production default decide: decideExit with NO config (disarmed) — nothing written
  const st = memStore(); seed(st, active());
  const { r, sub } = await run(st, { decide: null });
  ok("⭐ the PRODUCTION default (decideExit, shipped DISARMED, no config) → refused at the decision, before any write", r?.ok === false && r?.stage === "decide" && writes(st).length === 0 && sub.calls.length === 0, show({ stage: r?.stage, code: r?.code }));
  // the limit moves between the reads and the intent → refused before writing (the simulation was for another amount)
  const st2 = memStore(); seed(st2, active());
  const moving = { ...ST.mandateAdapter(st2) }; let reads = 0;
  moving.read = async (a) => { const x = await ST.mandateAdapter(st2).read(a); reads++; if (reads >= 2 && x.record) { x.record = { ...x.record, progress: { ...x.record.progress, sharesTrackedRaw: "400" } }; } return x; };
  const { r: r2, sub: s2 } = await run(st2, { over: { mandates: moving } });
  ok("⭐ the tracked figure MOVES after the reads (500 simulated, 400 now) → refused limit-moved, nothing written, nothing submitted",
    r2?.ok === false && r2?.code === "limit-moved" && writes(st2).length === 0 && s2.calls.length === 0, show(r2));
  // halted
  const st3 = memStore(); seed(st3, active());
  const { r: r3 } = await run(st3, { over: { halt: { async read() { return { readable: true, halted: true, open: ["i"] }; } } } });
  ok("halted → refused, nothing written", r3?.ok === false && r3?.code === "halted" && writes(st3).length === 0, show(r3?.code));
  // a submit that THROWS after the intent: the intent stays OPEN for recovery (never marked failed on an exception)
  const st4 = memStore(); seed(st4, active());
  const { r: r4 } = await run(st4, { sub: { calls: [], submit: async () => { throw new Error("Circle timeout"); } } });
  ok("⭐ the submit THROWS → the intent stays OPEN (submitting) for recovery; an exception is never a failed exit",
    r4?.ok === false && r4?.code === "submit-outcome-unknown" && st4.m.get(`x/${OWNER}/vm-1/1`)?.data?.state === "submitting", show({ r4, state: st4.m.get(`x/${OWNER}/vm-1/1`)?.data?.state }));
}

section("SOURCE GUARDS");
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("netlify/functions/_vault-mandate-exit.mjs", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  ok("runMandateExit never passes `config` to decideExit (the seam stays test-only)", !/decideExit\s*\(\s*\{[^}]*\bconfig\s*:/s.test(src));
  const body = src.slice(src.indexOf("export async function runMandateExit"));
  const at = (s) => body.indexOf(s);
  ok("⭐ in runMandateExit's source: readExitExecution, then exitPathGate, then decide, then beginMandateExit, then submitMandateExitRedeem",
    [at("readExitExecution("), at("exitPathGate("), at("decide("), at("beginMandateExit("), at("submitMandateExitRedeem(")].every((v, i, a) => v > 0 && (i === 0 || v > a[i - 1])), show([at("readExitExecution("), at("exitPathGate("), at("decide("), at("beginMandateExit("), at("submitMandateExitRedeem(")]));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-vault-mandate-exit-reads — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
