#!/usr/bin/env node
// verify-vault-mandate-exit-decision.mjs — piece 5: the PURE EXIT DECISION (may this exit go, and if not, why).
//
//   node --experimental-test-module-mocks scripts/verify-vault-mandate-exit-decision.mjs
//
// ═══ THE REQUIREMENTS (T, 2026-09-28; design: PROGRESS piece 5 §4 + §7, C3, C6, finding C) ══════════════
//   · ARMING of its own: MANDATE_EXIT_ARMED + MANDATE_EXIT_ARMED_FROM, separate from the deposit pair.
//   · ARMED_FROM is compared against the anchor block's CHAIN timestamp, never wall-clock anchoredAt (the one-clock
//     identity guard does not survive storage — C3). A finding recorded while disarmed is never acted on
//     retroactively: only findings in checks anchored AFTER MANDATE_EXIT_ARMED_FROM may execute.
//   · The FEE SANITY GATE: the fee at execution must be ≤ the baseline maxFeeBps the user was shown. maxFeeBps can be
//     NULL, and null REFUSES (C6). Above the cap → the disclosure is false → pause INCONCLUSIVE, never exit.
//   · The PAUSE GATE: the Vault pause, ALL_AGENTS and AGENT_HALT all stop an exit, through the exit's OWN call —
//     never inherited from executeAction's isReclaim branch, which skips the pause by design (finding C).
//   · EXIT_AVAILABLE ⇒ MANDATE_EXIT_ARMED, enforced (a module that violates it must not load).

import { mock } from "node:test";
import { readFileSync, writeFileSync, mkdtempSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ── the pause switch, in memory (the verify-pause-enforcement pattern): { key → {paused} } or a thrown store ──
const pauseState = { flags: {}, throws: false };
mock.module("@netlify/blobs", {
  namedExports: {
    connectLambda: () => {}, // _blobs.mjs (imported by _pause.mjs) needs it; nothing here is a Lambda event
    getStore: () => ({
      async get(key) { if (pauseState.throws) throw new Error("blobs down"); return pauseState.flags[key] ?? null; },
      async setJSON() { throw new Error("not used"); },
    }),
  },
});

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const attempt = (fn) => { try { return fn(); } catch (e) { return { threw: String(e?.message ?? e) }; } };
const show = (o) => JSON.stringify(o ?? null)?.slice(0, 240);
const load = async (p) => { try { return await import(p); } catch (e) { return { __missing: String(e?.message ?? e) }; } };

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  VAULT MANDATE — piece 5: the pure EXIT DECISION                     ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

const D = await load("../shared/vault-mandate/exit-decision.mjs");
const LIM = await load("../shared/vault-mandate/limits.mjs");
const P = await load("../netlify/functions/_vault-mandate-exit.mjs");
const { buildMandateRecord, acknowledgeMandate } = await import("../shared/vault-mandate/record.mjs");

// ── fixtures: an ACKNOWLEDGED mandate with an EXIT rule (via the test seam) ──
const OWNER = "0xaaaa000000000000000000000000000000000001";
const WALLET = "0xbbbb000000000000000000000000000000000002";
const VAULT = { key: "xylo-usdc", address: "0x240Eb85458CD41361bd8C3773253a1D78054f747", chainId: 31337, label: "Xylo" }; // fixture chain id
const VAULT_OWNER = "0x94e0dc7ad29b94ec9819f6cec3364dd34f41b3c6";
const BASELINE = (o = {}) => ({ ok: true, owner: { address: VAULT_OWNER, kind: "eoa" }, reportBlock: 990, reportSigned: true, signerVerified: true, maxFeeBps: 2000, vaultAckToken: "ab".repeat(32), ...o });
const T0 = Date.parse("2026-09-28T12:00:00Z");
const record = (o = {}) => {
  const b = buildMandateRecord({ owner: OWNER, walletAddress: WALLET, vault: VAULT, terms: { amountPerDepositUsdc: 10, maxTotalUsdc: 100, cadence: "daily" },
    rules: [{ kind: "state", subject: "exit-fee-above", limitBps: 50, onFinding: "exit" }, { kind: "state", subject: "vault-cannot-pay", onFinding: "pause" }],
    baseline: BASELINE(o.baseline ?? {}), now: T0 - 86_400_000, id: "vm-x", exitAvailable: true });
  if (!b.ok) throw new Error(JSON.stringify(b.errors));
  return acknowledgeMandate(b.record, b.record.fingerprint, T0 - 86_400_000).record;
};
// The finding check: r1 (exit-fee-above, EXIT) violated; r2 clear. Anchored at a CHAIN timestamp (seconds).
const EXIT_OBS = { r1: { status: "violated", evidence: { declaredBps: 90, limitBps: 50 } }, r2: { status: "clear" } };
const finding = (o = {}) => ({ check: { outage: null, observations: EXIT_OBS, anchor: { blockNumber: 5000, blockHash: "0x" + "11".repeat(32) } },
  anchor: { blockNumber: 5000, blockHash: "0x" + "11".repeat(32), timestamp: Math.floor(T0 / 1000) }, ...o });
const execution = (o = {}) => ({ exitFeeBps: 90, ...o }); // both endpoints agreed on 90 bps at execution
const notPaused = { checked: true, reason: null };
const ARMED = { armed: true, armedFrom: T0 - 3_600_000 }; // armed an hour before the finding
const decide = (a) => (typeof D.decideExit === "function" ? attempt(() => D.decideExit(a)) : null);
const go = (o = {}) => decide({ record: record(), finding: finding(), execution: execution(), pause: notPaused, config: ARMED, ...o });

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — the arming constants ship OFF, separate from the deposit pair");
{
  ok("exit-decision.mjs exists and exports decideExit + EXIT_REFUSED", !D.__missing && typeof D.decideExit === "function" && !!D.EXIT_REFUSED, D.__missing ?? "");
  ok("⭐ MANDATE_EXIT_ARMED ships false", LIM.MANDATE_EXIT_ARMED === false, show(LIM.MANDATE_EXIT_ARMED));
  ok("⭐ MANDATE_EXIT_ARMED_FROM ships null", LIM.MANDATE_EXIT_ARMED_FROM === null, show(LIM.MANDATE_EXIT_ARMED_FROM));
  ok("EXIT_AVAILABLE still ships false", LIM.EXIT_AVAILABLE === false);
  const src = existsSync("shared/vault-mandate/exit-decision.mjs") ? readFileSync("shared/vault-mandate/exit-decision.mjs", "utf8") : "";
  ok("⭐ the exit decision never reads the DEPOSIT arming pair", src !== "" && !/MANDATE_DEPOSIT_ARMED|MANDATE_ARMED_FROM\b|MANDATE_CHECK_FRESHNESS_MS/.test(src));
  const r = go();
  ok("control: armed, after ARMED_FROM, fee under the cap, not paused, an EXIT finding → GO", r?.go === true, show(r));
  const shipped = decide({ record: record(), finding: finding(), execution: execution(), pause: notPaused });
  ok("⭐⭐ with the SHIPPED constants (no config) → refused: disarmed", shipped?.go === false && shipped?.code === "disarmed", show(shipped));
  ok("  …and the disarmed refusal still says what it WOULD have done (the disarmed tick records WOULD EXIT)", shipped?.wouldExit === true, show(shipped));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⭐⭐ ARMED_FROM against the anchor's CHAIN timestamp; never retroactive");
{
  const before = go({ config: { armed: true, armedFrom: T0 + 60_000 } });
  ok("⭐⭐ a finding anchored BEFORE ARMED_FROM (recorded while disarmed) → refused, never acted on retroactively", before?.go === false && before?.code === "before-armed-from", show(before));
  const same = go({ config: { armed: true, armedFrom: T0 } });
  ok("a finding anchored exactly AT ARMED_FROM → refused (only checks anchored AFTER it)", same?.go === false && same?.code === "before-armed-from", show(same));
  ok("armed with no ARMED_FROM → refused (they are set together)", go({ config: { armed: true, armedFrom: null } })?.code === "armed-from-unset");
  const wall = go({ finding: { ...finding(), anchor: { ...finding().anchor, timestamp: undefined }, timing: { anchoredAt: T0 + 3_600_000 } } });
  ok("⭐⭐ no CHAIN timestamp on the anchor → refused, even when a wall-clock anchoredAt is present (it does not survive storage)",
    wall?.go === false && wall?.code === "anchor-time-unknown", show(wall));
  const ms = go({ finding: { ...finding(), anchor: { ...finding().anchor, timestamp: T0 } } });
  ok("a timestamp in MILLISECONDS (a wall-clock value in disguise) → refused: the chain timestamp is seconds", ms?.go === false && ms?.code === "anchor-time-unknown", show(ms));
  ok("a non-integer timestamp → refused", go({ finding: { ...finding(), anchor: { ...finding().anchor, timestamp: "1790000000" } } })?.code === "anchor-time-unknown");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐⭐ the FEE SANITY GATE: the fee at execution ≤ the disclosed cap; NULL REFUSES");
{
  const nullCap = decide({ record: record({ baseline: { maxFeeBps: null } }), finding: finding(), execution: execution(), pause: notPaused, config: ARMED });
  ok("⭐⭐ baseline maxFeeBps NULL (the cap could not be read at creation) → REFUSED, never passed", nullCap?.go === false && nullCap?.code === "fee-cap-unknown", show(nullCap));
  const above = go({ execution: execution({ exitFeeBps: 2001 }) });
  ok("⭐ the fee at execution ABOVE the disclosed cap → refused, and the consequence is a deposits PAUSE (INCONCLUSIVE), never an exit",
    above?.go === false && above?.code === "fee-above-cap" && above?.then === "pause-inconclusive", show(above));
  const at = go({ execution: execution({ exitFeeBps: 2000 }) });
  ok("the fee exactly AT the cap → go (the user was told they may pay up to the cap)", at?.go === true, show(at));
  const unread = go({ execution: execution({ exitFeeBps: null }) });
  ok("the fee at execution UNREADABLE (endpoints disagree or failed) → refused, retried: never guessed", unread?.go === false && unread?.code === "fee-unread" && unread?.then === "retry", show(unread));
  ok("a non-integer execution fee → refused", go({ execution: execution({ exitFeeBps: 90.5 }) })?.code === "fee-unread");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — the PAUSE GATE in the decision: an UNCHECKED pause refuses");
{
  const paused = go({ pause: { checked: true, reason: "Your Vault agent is paused. Resume it to act again." } });
  ok("⭐ paused → refused, then exit-due-paused (the finding stays live and loud)", paused?.go === false && paused?.code === "paused" && paused?.then === "exit-due-paused", show(paused));
  ok("  …and it carries the pause reason", /Vault agent is paused/.test(paused?.why ?? ""));
  ok("⭐ the pause NOT CHECKED (no pause input) → refused: never assumed running", go({ pause: undefined })?.code === "pause-unchecked");
  ok("a pause input not marked checked → refused", go({ pause: { reason: null } })?.code === "pause-unchecked");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — the finding is RE-DECIDED, and the record must carry exit authority");
{
  const pauseOnly = go({ finding: { ...finding(), check: { ...finding().check, observations: { r1: { status: "clear" }, r2: { status: "violated", evidence: { shortfall: true } } } } } });
  ok("⭐ a check whose re-decided action is PAUSE (not EXIT) → refused: nothing passed in can say 'exit'", pauseOnly?.go === false && pauseOnly?.code === "not-an-exit", show(pauseOnly));
  const outage = go({ finding: { ...finding(), check: { outage: { reason: "rpc" }, observations: {}, anchor: finding().anchor } } });
  ok("an OUTAGE check → refused (exit on a finding, never on a failure to read)", outage?.code === "not-an-exit", show(outage));
  const passedIn = go({ finding: { ...finding(), decision: { action: "exit" }, check: { outage: { reason: "rpc" }, observations: {}, anchor: finding().anchor } } });
  ok("a passed-in decision saying 'exit' is IGNORED (re-decided from the check)", passedIn?.code === "not-an-exit", show(passedIn));
  const stale = record(); stale.ack = { fingerprint: "0".repeat(64), at: "x" };
  ok("⭐ a STALE acknowledgement → refused (it keeps monitoring, not exit authority)", go({ record: stale })?.code === "record");
  const cancelled = { ...record(), status: "cancelled" };
  ok("a cancelled mandate → refused", go({ record: cancelled })?.code === "record");
  const exiting = { ...record(), status: "exiting" };
  ok("⭐ a mandate already EXITING (a redeem in flight) → refused: one exit at a time", go({ record: exiting })?.code === "record");
  const blocked = { ...record(), status: "exit-blocked" };
  ok("an exit-BLOCKED mandate (a retry) → may go", go({ record: blocked })?.go === true, show(go({ record: blocked })));
  const depPaused = { ...record(), deposits: { state: "paused", flags: ["FINDING"], reason: "x", at: "2026-09-28T00:00:00.000Z" } };
  ok("⭐ deposits PAUSED (often by this very finding) does NOT block the exit", go({ record: depPaused })?.go === true, show(go({ record: depPaused })));
  const other = go({ finding: { ...finding(), anchor: { ...finding().anchor, blockHash: "0x" + "22".repeat(32) } } });
  ok("the finding's anchor ≠ the check's anchor → refused (not the check that found it)", other?.go === false && other?.code === "anchor-mismatch", show(other));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — ⭐⭐ the pause gate's OWN call: Vault pause, ALL_AGENTS, AGENT_HALT, unreadable");
{
  const f = P.exitPauseCheck;
  ok("_vault-mandate-exit.mjs exports exitPauseCheck", typeof f === "function", P.__missing ?? "");
  const run = async (setup) => { pauseState.flags = {}; pauseState.throws = false; delete process.env.AGENT_HALT; setup(); try { return await f({ walletAddress: WALLET }); } catch (e) { return { threw: String(e?.message ?? e) }; } };
  const key = (agent) => `pause:${WALLET}:${agent}`;
  const none = typeof f === "function" ? await run(() => {}) : null;
  ok("nothing paused → checked, no reason", none?.checked === true && none?.reason === null, show(none));
  const vault = typeof f === "function" ? await run(() => { pauseState.flags[key("vault")] = { paused: true }; }) : null;
  ok("⭐ the VAULT agent paused → a reason", vault?.checked === true && typeof vault?.reason === "string", show(vault));
  const all = typeof f === "function" ? await run(() => { pauseState.flags[key("*")] = { paused: true }; }) : null;
  ok("⭐ ALL_AGENTS paused → a reason", all?.checked === true && typeof all?.reason === "string", show(all));
  const halt = typeof f === "function" ? await run(() => { process.env.AGENT_HALT = "1"; }) : null;
  ok("⭐ AGENT_HALT set → a reason", halt?.checked === true && /AGENT_HALT|halted/i.test(halt?.reason ?? ""), show(halt));
  const typo = typeof f === "function" ? await run(() => { process.env.AGENT_HALT = "yess"; }) : null;
  ok("AGENT_HALT set to an unrecognised value → halted (fail closed)", typeof typo?.reason === "string", show(typo));
  const down = typeof f === "function" ? await run(() => { pauseState.throws = true; }) : null;
  ok("⭐ the pause store UNREADABLE → a reason (fail closed), never 'running'", down?.checked === true && typeof down?.reason === "string", show(down));
  const exec = typeof f === "function" ? await run(() => { pauseState.flags[key("executor")] = { paused: true }; }) : null;
  ok("the EXECUTOR agent paused (a different agent) → does not stop a Vault-agent exit", exec?.reason === null, show(exec));
  delete process.env.AGENT_HALT;

  const src = existsSync("netlify/functions/_vault-mandate-exit.mjs") ? readFileSync("netlify/functions/_vault-mandate-exit.mjs", "utf8") : "";
  ok("⭐⭐ the exit path does NOT route through executeAction (whose isReclaim branch skips the pause)",
    src !== "" && !/_actions\.mjs|executeAction|vault_withdraw|isReclaim/.test(src.replace(/\/\/.*$/gm, "")), "");
  ok("⭐ …and its pause call names the VAULT agent explicitly", /agent:\s*AGENT\.VAULT/.test(src));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — ⭐⭐ EXIT_AVAILABLE ⇒ MANDATE_EXIT_ARMED ∧ MANDATE_MONITORING_LIVE, enforced at LOAD");
{
  ok("the shipped constants satisfy it", !(LIM.EXIT_AVAILABLE === true && LIM.MANDATE_EXIT_ARMED !== true));
  // Load a COPY of limits.mjs (it has no imports) with the constants rewritten, from a temp dir outside the repo.
  const srcL = readFileSync("shared/vault-mandate/limits.mjs", "utf8");
  // monitoring defaults to TRUE in the variants that predate it, so each case isolates the guard it names.
  const variant = async (avail, armed, from, monitoring = true) => {
    const s = srcL.replace(/export const EXIT_AVAILABLE = (true|false);/, `export const EXIT_AVAILABLE = ${avail};`)
      .replace(/export const MANDATE_EXIT_ARMED = (true|false);/, `export const MANDATE_EXIT_ARMED = ${armed};`)
      .replace(/export const MANDATE_EXIT_ARMED_FROM = [^;]+;/, `export const MANDATE_EXIT_ARMED_FROM = ${from};`)
      .replace(/export const MANDATE_MONITORING_LIVE = (true|false);/, `export const MANDATE_MONITORING_LIVE = ${monitoring};`);
    const dir = mkdtempSync(join(tmpdir(), "limits-")); const p = join(dir, "limits.mjs"); writeFileSync(p, s);
    try { await import(pathToFileURL(p).href + `?v=${Math.random()}`); return "loaded"; } catch (e) { return `threw: ${String(e?.message ?? e)}`; }
  };
  const rewrites = /export const MANDATE_EXIT_ARMED = (true|false);/.test(srcL) && /export const MANDATE_EXIT_ARMED_FROM = [^;]+;/.test(srcL)
    && /export const MANDATE_MONITORING_LIVE = (true|false);/.test(srcL);
  ok("  (the variant loader can rewrite all four constants in the real source)", rewrites);
  const bad = rewrites ? await variant(true, false, "null") : "no-rewrite";
  ok("⭐⭐ EXIT_AVAILABLE true + MANDATE_EXIT_ARMED false → the module REFUSES TO LOAD", /^threw:.*EXIT_AVAILABLE/.test(bad), bad);
  const armedNoFrom = rewrites ? await variant(false, true, "null") : "no-rewrite";
  ok("⭐ MANDATE_EXIT_ARMED true + no ARMED_FROM → refuses to load (flipped together)", /^threw:/.test(armedNoFrom), armedNoFrom);
  ok("  (control: both true with an ARMED_FROM, monitoring live → loads)", rewrites && (await variant(true, true, String(T0), true)) === "loaded");
  ok("  (control: the shipped off/off/null/off → loads)", rewrites && (await variant(false, false, "null", false)) === "loaded");

  // ═══ C14 (piece 5 blocker 2): EXIT_AVAILABLE also waits for MONITORING ═══
  // A fully deposited mandate is never checked again until monitoring exists, so "if found: exit" would be mostly false.
  ok("⭐ the shipped MANDATE_MONITORING_LIVE is false (monitoring is not built)", LIM.MANDATE_MONITORING_LIVE === false, String(LIM.MANDATE_MONITORING_LIVE));
  const noMon = rewrites ? await variant(true, true, String(T0), false) : "no-rewrite";
  ok("⭐⭐ EXIT_AVAILABLE true, exits ARMED, monitoring NOT live → the module REFUSES TO LOAD", /^threw:.*MONITORING/.test(noMon), noMon);
  ok("  (control: exits armed, EXIT_AVAILABLE false, monitoring off → loads: arming without creation is allowed)",
    rewrites && (await variant(false, true, String(T0), false)) === "loaded");
  ok("  (control: monitoring live alone → loads: monitoring needs no exits)", rewrites && (await variant(false, false, "null", true)) === "loaded");
  const monTyped = rewrites ? await variant(false, false, "null", "1") : "no-rewrite";
  ok("  a non-boolean MANDATE_MONITORING_LIVE → refuses to load (only a literal true counts)", /^threw:.*MONITORING/.test(monTyped), monTyped);

  // The config seam: only the test suite may pass it (the deposit path's rule).
  const walk = (d) => { try { return readdirSync(d).flatMap((n) => { const p = `${d}/${n}`; return n === "node_modules" || n.startsWith(".") ? [] : statSync(p).isDirectory() ? walk(p) : [p]; }); } catch { return []; } };
  const seam = ["netlify/functions", "shared", "src"].flatMap(walk).filter((p) => /\.(mjs|js|ts|tsx)$/.test(p) && p !== "shared/vault-mandate/exit-decision.mjs")
    .filter((p) => /decideExit\s*\(\s*\{[^}]*\bconfig\s*:/s.test(readFileSync(p, "utf8")));
  ok("⭐ no production caller passes `config` (the exit arming seam) to decideExit", seam.length === 0, seam.join(", "));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
