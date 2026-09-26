#!/usr/bin/env node
// verify-vault-mandate-deposit.mjs — piece 4: the PRE-DEPOSIT path, the first mandate piece that moves money.
// It ships DISARMED; this suite proves what disarmed means, and what arming would still refuse.
//
//   node scripts/verify-vault-mandate-deposit.mjs
//
// ═══ THE TWO THINGS THIS SUITE EXISTS TO PROVE (T, 2026-09-26) ══════════════════════════════════
//   1. A DISARMED run touches NEITHER the intent store NOR the executor — and still produces a SIGNED
//      check. (Decision 3: the disarmed tick signs, so the signing leg is proven at ~0 USDC.) Proven on
//      the REAL runMandateCheck against the shared mock chain and a throwaway key, with both adapters
//      counting every call they receive.
//   2. An ARMED run with the freshness window UNSET REFUSES, by that rule and no other. The suite then
//      EXCISES the rule from a copy of the module and re-runs the case: it must go RED. A rule whose
//      removal the suite cannot see is not a rule the suite tests.
//
// ═══ THE DESIGN'S OWN CASES (PROGRESS, "VAULT MANDATE — PIECE 4") ═══════════════════════════════
// off-surface caps (R1) · off by a code constant, checked AT THE WRITE (R2) · the decided values · the
// record's new fields inside the fingerprint · exit refused at creation until piece 5 · the order of
// operations · the mutations: no check, stale check, unsigned report, a passed-in "deposit" decision,
// disarmed deposit · the daily limit SKIPS and never pauses · recovery reads the chain, never resubmits,
// and "unreadable" is never "not deposited" · the post-deposit assertion has no tolerance.
//
// ⚠️ Offline. The functions under test are the real ones; the boundaries (stores, executor, chain
// readers, Circle) are fakes that record every call.

import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { recoverAddress } from "viem";
import { quorumClient } from "../shared/onchain-analyze/quorum.mjs";
import { DOMAIN } from "../shared/onchain-analyze/attest.mjs";
import { analyze } from "../shared/onchain-analyze/index.mjs";
import { EIP1967_IMPL_SLOT } from "../shared/onchain-facts/index.mjs";
import { SUBJ, OWNER, ZERO_WORD, word, codeWith, mkc } from "./dd/_mock-chain.mjs";
import { runMandateCheck, productionDeps } from "../netlify/functions/_vault-mandate-check.mjs";
import {
  buildMandateRecord, acknowledgeMandate, verifyMandateRecord, amendMandateRules, mandateFingerprint,
  MANDATE_SCHEMA, MANDATE_STATUS,
} from "../shared/vault-mandate/record.mjs";
import {
  MANDATE_DEPOSIT_MAX_USDC, MANDATE_TOTAL_MAX_USDC, MANDATE_DAY_SHARE, MANDATE_AUTONOMOUS_MAX_SHARE,
  MANDATE_MIN_CADENCE_MS, CADENCE_MS, DEFAULT_CADENCE, EXIT_AVAILABLE,
  validateMandateTerms, mandateDayRoom, effectiveDepositUsdc,
} from "../shared/vault-mandate/limits.mjs";
import { depositVerdict, DEPOSIT_VERDICT } from "../shared/vault-mandate/assertion.mjs";
import { classifyIntent, RECOVERY_NOT_DEPOSITED_AFTER_MS } from "../shared/vault-mandate/recovery.mjs";
import {
  MANDATE_DEPOSIT_ARMED, MANDATE_ARMED_FROM, MANDATE_CHECK_FRESHNESS_MS,
  depositForMandate, runMandateTick, dueState, REFUSED, productionTickDeps,
} from "../netlify/functions/_vault-mandate-deposit.mjs";
import { mandateDaySpend, recordMandateSpend, dcaDaySpend } from "../netlify/functions/_budget.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const attempt = (fn) => { try { return fn(); } catch (e) { return { threw: String(e?.message ?? e) }; } };
const attemptAsync = async (fn) => { try { return await fn(); } catch (e) { return { threw: String(e?.message ?? e) }; } };
const big = (k, v) => (typeof v === "bigint" ? v.toString() : v);
const show = (o) => JSON.stringify(o ?? null, big)?.slice(0, 200);
const clone = (o) => JSON.parse(JSON.stringify(o, big));

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  VAULT MANDATE — piece 4: the pre-deposit path (ships DISARMED)      ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("0 — R1 + R2: the caps live off the DD surface; the gate is a code constant");
{
  const stamp = readFileSync("scripts/stamp-build.mjs", "utf8");
  const dirs = JSON.parse(stamp.match(/const DD_SURFACE_DIRS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  const filesBlock = stamp.match(/const DD_SURFACE_FILES = \[([\s\S]*?)\n\];/)[1];
  const files = [...filesBlock.matchAll(/^\s*"([^"]+)"/gm)].map((m) => m[1]);
  ok("the DD surface lists were parsed (dirs + files)", dirs.length >= 4 && files.includes("netlify/functions/_arc.mjs"), `${dirs.length} dirs, ${files.length} files`);
  const NEW = ["shared/vault-mandate/limits.mjs", "shared/vault-mandate/assertion.mjs", "shared/vault-mandate/recovery.mjs",
    "netlify/functions/_vault-mandate-deposit.mjs", "netlify/functions/vault-mandate-tick.mjs"];
  for (const f of NEW) {
    ok(`⭐ ${f} is NOT on the DD surface`, existsSync(f) && !dirs.some((d) => f.startsWith(`${d}/`)) && !files.includes(f));
  }
  const limitsSrc = existsSync("shared/vault-mandate/limits.mjs") ? readFileSync("shared/vault-mandate/limits.mjs", "utf8") : "";
  ok("⭐ limits.mjs reads NO env var (an env cap would pull in _arc.mjs / _env-assert.mjs)", limitsSrc.length > 0 && !/process\.env/.test(limitsSrc));
  ok("  …and imports nothing (pure code constants)", limitsSrc.length > 0 && !/^\s*import\s/m.test(limitsSrc));
  // No DD-surface file may reach the mandate: a mandate edit must never rotate ddTree.
  const surface = [...files, ...dirs.flatMap((d) => walk(d))];
  const reaching = surface.filter((f) => existsSync(f) && /vault-mandate/.test(readFileSync(f, "utf8")));
  ok("no DD-surface file mentions vault-mandate", reaching.length === 0, reaching.join(", "));
  let arcClean = true;
  try { execFileSync("git", ["diff", "--quiet", "HEAD", "--", "netlify/functions/_arc.mjs", "netlify/functions/_env-assert.mjs"]); } catch { arcClean = false; }
  ok("⭐ _arc.mjs and _env-assert.mjs are unchanged against HEAD (no second refusal window)", arcClean);

  ok("⭐ MANDATE_DEPOSIT_ARMED ships false", MANDATE_DEPOSIT_ARMED === false);
  ok("⭐ MANDATE_ARMED_FROM ships null", MANDATE_ARMED_FROM === null);
  ok("⭐ MANDATE_CHECK_FRESHNESS_MS ships null (unset until the signing latency is measured)", MANDATE_CHECK_FRESHNESS_MS === null);
  ok("⭐ EXIT_AVAILABLE ships false (piece 5 flips it)", EXIT_AVAILABLE === false);

  // ⭐ ONE function issues a mandate deposit. Any other file that knows about mandates and reaches the
  // executor would be a second path around the write gate.
  const src = ["netlify/functions", "shared", "src"].flatMap((d) => walk(d)).filter((f) => /\.(mjs|js|ts|tsx|jsx)$/.test(f));
  // "Knows the mandate" = IMPORTS a vault-mandate module (statically or dynamically); a comment naming one does not count.
  const importsMandate = (s) => /(from\s*|import\s*\(\s*)["'][^"']*vault-mandate[^"']*["']/.test(s);
  const both = src.filter((f) => { const s = readFileSync(f, "utf8"); return importsMandate(s) && /\bexecuteAction\b/.test(s); });
  ok("  (the import detector sees the tick handler's import)", importsMandate(existsSync("netlify/functions/vault-mandate-tick.mjs") ? readFileSync("netlify/functions/vault-mandate-tick.mjs", "utf8") : ""));
  ok("⭐ only _vault-mandate-deposit.mjs both imports the mandate and calls executeAction", both.length === 1 && both[0] === "netlify/functions/_vault-mandate-deposit.mjs", both.join(", "));
  // The test seam (`config`) exists so this suite can arm a run. No production caller may pass it.
  const seam = src.filter((f) => f !== "netlify/functions/_vault-mandate-deposit.mjs" &&
    /(runMandateTick|depositForMandate)\s*\(\s*\{[^}]*\bconfig\s*:/s.test(readFileSync(f, "utf8")));
  ok("⭐ no production caller passes `config` (the arming seam) to the tick or the deposit", seam.length === 0, seam.join(", "));
  // The record's `exitAvailable` seam keeps piece 5's shapes testable. Only record.mjs itself may name it.
  const exitSeam = src.filter((f) => f !== "shared/vault-mandate/record.mjs" && /\bexitAvailable\b/.test(readFileSync(f, "utf8")));
  ok("⭐ no production file passes `exitAvailable` (creation cannot be talked into an exit rule)", exitSeam.length === 0, exitSeam.join(", "));
  const tick = existsSync("netlify/functions/vault-mandate-tick.mjs") ? readFileSync("netlify/functions/vault-mandate-tick.mjs", "utf8") : "";
  ok("⭐ depositForMandate REFUSES a passed `now` (a second clock) — it throws",
    (await attemptAsync(() => depositForMandate({ record: {}, etag: '"e0"', checked: {}, amountUsdc: 1, deps: {}, now: 0 })))?.threw?.includes("second clock") === true);
  ok("the scheduled handler calls runMandateTick without a config", /runMandateTick\(/.test(tick) && !/config\s*:/.test(tick));
  const toml = readFileSync("netlify.toml", "utf8");
  ok("netlify.toml schedules vault-mandate-tick", /\[functions\."vault-mandate-tick"\]\s*\n\s*schedule\s*=\s*"[^"]+"/.test(toml));
}
function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = `${dir}/${n}`;
    if (n === "node_modules" || n.startsWith(".")) return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — the decided values (T, 2026-09-26)");
{
  ok("per deposit: at most 10 USDC", MANDATE_DEPOSIT_MAX_USDC === 10);
  ok("total budget: at most 100 USDC", MANDATE_TOTAL_MAX_USDC === 100);
  ok("the mandate's own day share: 0.25 × ceiling", MANDATE_DAY_SHARE === 0.25);
  ok("mandate + DCA together: 0.5 × ceiling", MANDATE_AUTONOMOUS_MAX_SHARE === 0.5);
  ok("cadence floor 24 h", MANDATE_MIN_CADENCE_MS === 24 * 3600 * 1000);
  ok("cadences: daily and weekly only", JSON.stringify(Object.keys(CADENCE_MS).sort()) === '["daily","weekly"]');
  ok("  every cadence is at or above the floor", Object.values(CADENCE_MS).every((ms) => ms >= MANDATE_MIN_CADENCE_MS));
  ok("  default weekly", DEFAULT_CADENCE === "weekly" && CADENCE_MS.weekly === 7 * 24 * 3600 * 1000);

  const t = (x) => validateMandateTerms(x);
  const d = t({ amountPerDepositUsdc: 10, maxTotalUsdc: 80 });
  ok("no cadence sent → weekly, STORED explicitly", d.ok === true && d.terms.cadence === "weekly", show(d));
  ok("10 per deposit, 100 total, daily → ok", t({ amountPerDepositUsdc: 10, maxTotalUsdc: 100, cadence: "daily" }).ok === true);
  ok("10.01 per deposit → refused", t({ amountPerDepositUsdc: 10.01, maxTotalUsdc: 100 }).ok === false);
  ok("0 per deposit → refused", t({ amountPerDepositUsdc: 0, maxTotalUsdc: 100 }).ok === false);
  ok("a negative amount → refused", t({ amountPerDepositUsdc: -1, maxTotalUsdc: 100 }).ok === false);
  ok("an amount finer than 6 decimals → refused (it would round on chain)", t({ amountPerDepositUsdc: 1.0000001, maxTotalUsdc: 100 }).ok === false);
  ok("a string amount → refused", t({ amountPerDepositUsdc: "10", maxTotalUsdc: 100 }).ok === false);
  ok("⭐ the total budget is REQUIRED", t({ amountPerDepositUsdc: 5 }).ok === false);
  ok("a total below one deposit → refused", t({ amountPerDepositUsdc: 5, maxTotalUsdc: 4 }).ok === false);
  ok("a total of exactly one deposit → ok", t({ amountPerDepositUsdc: 5, maxTotalUsdc: 5 }).ok === true);
  ok("100.01 total → refused", t({ amountPerDepositUsdc: 5, maxTotalUsdc: 100.01 }).ok === false);
  ok("an hourly cadence → refused", t({ amountPerDepositUsdc: 5, maxTotalUsdc: 50, cadence: "hourly" }).ok === false);
  ok("a cadence in ms → refused (named cadences only)", t({ amountPerDepositUsdc: 5, maxTotalUsdc: 50, cadence: 86400000 }).ok === false);

  // The day share, on the deployed numbers: ceiling 60, DCA reserve 0.5 → mandate 15/day, mandate+DCA 30/day.
  const room = (o) => mandateDayRoom({ ceilingUsdc: 60, userReserveFraction: 0.5, mandateTodayUsdc: 0, dcaTodayUsdc: 0, amountUsdc: 10, ...o });
  ok("an empty day → room for 10", room({}).ok === true, show(room({})));
  ok("⭐ mandate already 10 today + 10 → 20 > 15 → no room (its own share)", room({ mandateTodayUsdc: 10 }).ok === false);
  ok("mandate 5 + 10 = 15 → exactly its share → room", room({ mandateTodayUsdc: 5 }).ok === true);
  ok("⭐ DCA 25 + mandate 10 = 35 > 30 → no room (the combined autonomous share)", room({ dcaTodayUsdc: 25 }).ok === false);
  ok("DCA 15 + mandate 5 + 10 = 30 → exactly the combined share → room", room({ dcaTodayUsdc: 15, mandateTodayUsdc: 5 }).ok === true);
  ok("a reserve of 0.8 narrows the combined share to 0.2 × 60 = 12", room({ userReserveFraction: 0.8, dcaTodayUsdc: 3 }).ok === false && room({ userReserveFraction: 0.8, dcaTodayUsdc: 2 }).ok === true);
  ok("⭐ a reserve of 0.1 does NOT widen it past 0.5 (30)", room({ userReserveFraction: 0.1, dcaTodayUsdc: 21 }).ok === false);
  ok("an unreadable counter (NaN) → no room", room({ dcaTodayUsdc: NaN }).ok === false);
  ok("a non-finite ceiling → no room", room({ ceilingUsdc: undefined }).ok === false);

  const eff = (o) => effectiveDepositUsdc({ recordAmountUsdc: 10, vaultCapUsdc: 25, remainingUsdc: 100, ...o });
  ok("effective = the record's amount when nothing binds", eff({}) === 10);
  ok("…the remaining budget binds (4)", eff({ remainingUsdc: 4 }) === 4);
  ok("…the vault cap binds (3)", eff({ vaultCapUsdc: 3 }) === 3);
  ok("⭐ …MANDATE_DEPOSIT_MAX binds a record that somehow says 50", eff({ recordAmountUsdc: 50 }) === 10);
  ok("nothing remaining → 0", eff({ remainingUsdc: 0 }) === 0);
  ok("an unreadable cap → 0 (never the record's amount)", eff({ vaultCapUsdc: NaN }) === 0);
  ok("no float drift: 0.1 + 0.2 remaining = 0.3", eff({ remainingUsdc: 0.1 + 0.2 }) === 0.3);
}

// ── the record fixture ─────────────────────────────────────────────────────────────────────────
const SESSION = "0xaaaa000000000000000000000000000000000001";
const HOLDER = "0x3d7d4c52305ed0c394e01c7184701a522116097d";
const ACK = "ab".repeat(32);
const MOCK_CHAIN_ID = (await analyze(SUBJ, { client: mkc("https://a.example", {
  [`code@${SUBJ}`]: codeWith(["upgradeTo(address)", "setFees(uint256,uint256,uint256)"]),
  [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD, ["call@0x8da5cb5b"]: word(OWNER), [`code@${OWNER}`]: "0x" }) })).subject.chainId;
const VAULT = { key: "xylo-usdc", address: SUBJ, chainId: MOCK_CHAIN_ID, label: "Xylo" };
const ASSET = "0x" + "36".repeat(20);
const BASELINE = { ok: true, owner: { address: OWNER, kind: "eoa" }, reportBlock: 990, reportSigned: true, signerVerified: true, maxFeeBps: 2000, vaultAckToken: ACK };
const RULES = [
  { kind: "power", subject: "pausable", onFinding: "pause" },
  { kind: "state", subject: "owner-changed", onFinding: "pause" },
  { kind: "state", subject: "exit-fee-above", limitBps: 50, onFinding: "pause" },
  { kind: "state", subject: "vault-cannot-pay", onFinding: "pause" },
];
const TERMS = { amountPerDepositUsdc: 10, maxTotalUsdc: 100, cadence: "weekly" };
const T0 = Date.parse("2026-09-26T12:00:00Z");
const DAY = 24 * 3600 * 1000;
const build = (over = {}) => attempt(() => buildMandateRecord({
  owner: SESSION, walletAddress: HOLDER, vault: VAULT, terms: TERMS, rules: RULES, baseline: BASELINE, now: T0 - DAY, id: "vm-1", ...over }));
const activeRecord = (over = {}) => {
  const b = build(over);
  if (!b?.ok) throw new Error(`fixture: ${JSON.stringify(b)}`);
  const a = acknowledgeMandate(b.record, b.record.fingerprint, T0 - DAY);
  if (!a.ok) throw new Error(`fixture ack: ${JSON.stringify(a)}`);
  return a.record;
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — the record (vault-mandate/2): terms, the stored vault ack, exit refused until piece 5");
{
  const b = build();
  const r = b?.record;
  ok("builds, schema vault-mandate/2", b?.ok === true && MANDATE_SCHEMA === "vault-mandate/2" && r?.schema === "vault-mandate/2", show(b?.errors ?? b?.threw));
  ok("the terms are stored explicitly", r?.terms?.amountPerDepositUsdc === 10 && r?.terms?.maxTotalUsdc === 100 && r?.terms?.cadence === "weekly");
  ok("⭐ the vault disclosure token the user acknowledged is stored in the baseline", r?.baseline?.vaultAckToken === ACK);
  ok("progress starts at zero, seq 1, nothing due yet recorded", r?.progress?.depositedUsdc === 0 && r?.progress?.depositCount === 0 && r?.progress?.nextSeq === 1 && r?.progress?.nextDueAt === null, show(r?.progress));
  ok("the disclosure states the amount, the cadence and the total", /10 USDC/.test(r?.disclosure?.text ?? "") && /week/.test(r?.disclosure?.text ?? "") && /100 USDC/.test(r?.disclosure?.text ?? ""));
  ok("…and that a changed vault disclosure pauses the mandate", /disclosure/i.test(r?.disclosure?.text ?? "") && /pause/i.test(r?.disclosure?.text ?? ""));

  const fp = r?.fingerprint;
  const amt = clone(r); amt.terms.amountPerDepositUsdc = 9;
  ok("⭐ the amount is inside the fingerprint", mandateFingerprint(amt) !== fp);
  const tot = clone(r); tot.terms.maxTotalUsdc = 99;
  ok("⭐ the total is inside the fingerprint", mandateFingerprint(tot) !== fp);
  const cad = clone(r); cad.terms.cadence = "daily";
  ok("⭐ the cadence is inside the fingerprint", mandateFingerprint(cad) !== fp);
  const tok = clone(r); tok.baseline.vaultAckToken = "cd".repeat(32);
  ok("⭐ the vault ack token is inside the fingerprint", mandateFingerprint(tok) !== fp);
  const a = activeRecord();
  const edited = clone(a); edited.terms.amountPerDepositUsdc = 9;
  ok("⭐ an acknowledged record whose amount is edited in the store may NOT act", verifyMandateRecord(edited).mayAct === false);
  const moved = clone(a); moved.progress = { depositedUsdc: 30, depositCount: 3, nextSeq: 4, nextDueAt: T0 + DAY, lastDepositAt: T0 };
  ok("progress is NOT in the fingerprint (every deposit advances it; the ack stays valid)", verifyMandateRecord(moved).mayAct === true, show(verifyMandateRecord(moved).errors));
  const paused = clone(a); paused.status = "paused"; paused.pause = { flags: ["FINDING"], reason: "x", at: new Date(T0).toISOString() };
  const pv = verifyMandateRecord(paused);
  ok("⭐ a PAUSED record is consistent but may not act", pv.ok === true && pv.mayAct === false, show(pv.errors));
  ok("an unknown status may not act", verifyMandateRecord({ ...clone(a), status: "exited" }).mayAct === false);

  ok("no terms → refused", build({ terms: undefined })?.ok === false);
  ok("terms over the cap → refused", build({ terms: { ...TERMS, amountPerDepositUsdc: 11 } })?.ok === false);
  ok("⭐ no vault ack token in the baseline → refused", build({ baseline: { ...BASELINE, vaultAckToken: undefined } })?.ok === false);
  ok("a malformed vault ack token → refused", build({ baseline: { ...BASELINE, vaultAckToken: "zz" } })?.ok === false);

  const ex = build({ rules: [{ kind: "state", subject: "exit-fee-above", limitBps: 50, onFinding: "exit" }] });
  ok("⭐⭐ an EXIT rule at creation → REFUSED while EXIT_AVAILABLE is false", ex?.ok === false && /exit/i.test((ex?.errors ?? []).join(" ")), show(ex?.errors));
  ok("  …and the refusal says why (nothing can exit until piece 5 ships)", /cannot exit yet|not available/i.test((ex?.errors ?? []).join(" ")), show(ex?.errors));
  const am = attempt(() => amendMandateRules(a, [{ kind: "power", subject: "upgradeable", onFinding: "exit" }], T0));
  ok("⭐ amending TO an exit rule → refused", am?.ok === false, show(am));
  const am2 = attempt(() => amendMandateRules(moved, [{ kind: "power", subject: "upgradeable", onFinding: "pause" }], T0));
  ok("amending to pause rules → ok, AWAITING a fresh ack", am2?.ok === true && am2.record.status === MANDATE_STATUS.AWAITING_ACK, show(am2?.errors));
  ok("⭐ amending CARRIES progress (a reset would re-open the spent budget)", am2?.record?.progress?.depositedUsdc === 30 && am2?.record?.progress?.nextSeq === 4, show(am2?.record?.progress));
  ok("amending carries the terms and the vault ack token", am2?.record?.terms?.amountPerDepositUsdc === 10 && am2?.record?.baseline?.vaultAckToken === ACK);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — the mandate-day sub-counter (_budget.mjs)");
{
  const m = new Map();
  const store = { async getJSON(k) { return m.has(k) ? clone(m.get(k)) : null; }, async setJSON(k, v) { m.set(k, clone(v)); } };
  const at = T0;
  await recordMandateSpend({ owner: HOLDER, amountUsdc: 10, at, store, chargeId: "vm:1" });
  ok("records the mandate's own daily spend", (await mandateDaySpend({ owner: HOLDER, at, store })) === 10);
  await recordMandateSpend({ owner: HOLDER, amountUsdc: 10, at, store, chargeId: "vm:1" });
  ok("⭐ the same chargeId twice counts once (recovery may re-charge)", (await mandateDaySpend({ owner: HOLDER, at, store })) === 10);
  await recordMandateSpend({ owner: HOLDER, amountUsdc: 2.5, at, store, chargeId: "vm:2" });
  ok("a second charge adds", (await mandateDaySpend({ owner: HOLDER, at, store })) === 12.5);
  ok("it is a SEPARATE counter from DCA's", (await dcaDaySpend({ owner: HOLDER, at, store })) === 0);
  ok("keyed per UTC day", (await mandateDaySpend({ owner: HOLDER, at: at + DAY, store })) === 0);
  ok("key shape mandate-day:<owner>:<date>", [...m.keys()].every((k) => /^mandate-day:0x[0-9a-f]{40}:\d{4}-\d{2}-\d{2}$/.test(k)), [...m.keys()].join(","));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — the post-deposit assertion: predicted at the PARENT block, received by two instruments");
{
  const facts = (o = {}) => ({ readable: true, depositBlock: 1001, parentBlock: 1000, predictedAtParent: 9_999_000n,
    eventShares: 9_999_000n, shareDelta: 9_999_000n, feeAtParentBps: 0, feeAtDepositBlockBps: 0, ...o });
  const v = (o = {}, f = {}) => depositVerdict({ feeAtCheckBps: 0, sharesPredictedAtCheck: 9_999_500n, facts: facts(f), ...o });
  const m = v();
  ok("received == preview at parent, fee unchanged → matched", m.verdict === DEPOSIT_VERDICT.MATCHED, show(m));
  ok("  …both figures travel with the verdict", m.predicted?.atParent === "9999000" && m.received?.event === "9999000" && m.received?.delta === "9999000");
  ok("  …and the quoted-vs-received gap is shown as a MEASURED share-price change", typeof m.sharePriceChangeBps === "number" && m.sharePriceChangeBps > 0, show(m.sharePriceChangeBps));
  ok("more shares than the parent preview → matched (4626 rounding favours the depositor)", v({}, { eventShares: 9_999_001n, shareDelta: 9_999_001n }).verdict === "matched");
  const fc = v({}, { feeAtParentBps: 30 });
  ok("⭐ the deposit fee at the parent ≠ at the check → mismatched: deposit-fee-changed", fc.verdict === "mismatched" && fc.reason === "deposit-fee-changed", show(fc));
  const fs = v({}, { eventShares: 9_998_999n, shareDelta: 9_998_999n });
  ok("⭐ one share fewer than the parent preview → mismatched (NO tolerance)", fs.verdict === "mismatched" && fs.reason === "fewer-shares-than-preview", show(fs));
  const fb = v({}, { eventShares: 9_000_000n, shareDelta: 9_000_000n, feeAtDepositBlockBps: 100 });
  ok("  …a fee raised IN the deposit block ahead of ours is attributed", fb.verdict === "mismatched" && /deposit block/i.test(fb.detail ?? ""), show(fb));
  ok("the event and the balance delta disagree → unreadable, never matched", v({}, { shareDelta: 9_999_100n }).verdict === "unreadable");
  ok("no Deposit event read → unreadable", v({}, { eventShares: null }).verdict === "unreadable");
  ok("the parent preview could not be read → unreadable", v({}, { predictedAtParent: null }).verdict === "unreadable");
  ok("the receipt could not be read → unreadable", v({}, { readable: false, why: "receipt pruned" }).verdict === "unreadable");
  ok("no fee reading at the check → unreadable (nothing to compare)", v({ feeAtCheckBps: null }).verdict === "unreadable");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — recovery reads the chain; 'unreadable' is never 'not deposited'");
{
  const intent = (o = {}) => ({ status: "submitting", createdAt: new Date(T0 - 2 * RECOVERY_NOT_DEPOSITED_AFTER_MS).toISOString(),
    sharesBefore: "100", anchor: { blockNumber: 999 }, circleIds: { deposit: "c-dep" }, ...o });
  const f = (o = {}) => ({ circle: { state: "FAILED" }, event: { found: false }, shares: 100n, ...o });
  const c = (i, fx) => classifyIntent({ intent: i, facts: fx, now: T0 });
  ok("Circle COMPLETE → deposited, with its hash", c(intent(), f({ circle: { state: "COMPLETE", txHash: "0xabc" } })).state === "deposited" && c(intent(), f({ circle: { state: "COMPLETE", txHash: "0xabc" } })).txHash === "0xabc");
  ok("a Deposit event for our SCA after the anchor → deposited", c(intent(), f({ event: { found: true, txHash: "0xdef" } })).state === "deposited");
  ok("shares above sharesBefore → deposited (even with no hash)", c(intent(), f({ shares: 150n })).state === "deposited");
  ok("⭐ FAILED + no event + no delta + older than the deadline → not-deposited", c(intent(), f()).state === "not-deposited");
  ok("  …no Circle id recorded (crash before the hook) + all negative + old → not-deposited", c(intent({ circleIds: {} }), f({ circle: { state: "NONE" } })).state === "not-deposited");
  ok("all negative but YOUNGER than the deadline → pending", c(intent({ createdAt: new Date(T0 - 60_000).toISOString() }), f()).state === "pending");
  ok("Circle still PENDING → pending", c(intent(), f({ circle: { state: "PENDING" } })).state === "pending");
  ok("⭐ the event scan failed → unreadable, NOT not-deposited", c(intent(), f({ event: null })).state === "unreadable");
  ok("⭐ the share balance could not be read → unreadable", c(intent(), f({ shares: null })).state === "unreadable");
  ok("⭐ Circle unreadable → unreadable", c(intent(), f({ circle: null })).state === "unreadable");
}

// ── fakes for the executor path ────────────────────────────────────────────────────────────────
function counting(name, impl) {
  const calls = [];
  const proxy = new Proxy(impl, { get(t, k) {
    const v = t[k];
    if (typeof v !== "function") return v;
    return (...a) => { calls.push({ fn: String(k), args: a }); return v.apply(t, a); };
  } });
  return { proxy, calls, name };
}
function fakeMandates(records) {
  const m = new Map(records.map((r) => [`${r.owner}/${r.id}`, { data: clone(r), etag: '"e0"' }])); let n = 0;
  return { _m: m,
    async list() { return [...m.values()].map((x) => ({ owner: x.data.owner, id: x.data.id })); },
    async read({ owner, id }) { const x = m.get(`${owner}/${id}`); return x ? { readable: true, record: clone(x.data), etag: x.etag, verdict: verifyMandateRecord(x.data) } : { readable: true, record: null }; },
    async update({ owner, id, record, etag }) {
      const x = m.get(`${owner}/${id}`);
      if (!x || x.etag !== etag) return { ok: false, conflict: true };
      const v = verifyMandateRecord(record); if (!v.ok) return { ok: false, errors: v.errors };
      m.set(`${owner}/${id}`, { data: clone(record), etag: `"e${++n}"` }); return { ok: true };
    } };
}
function fakeIntents({ openReadable = true, preset = [] } = {}) {
  const m = new Map(preset.map(([k, v]) => [k, { data: clone(v), etag: '"i0"' }])); let n = 0;
  return { _m: m,
    async create(key, intent) { if (m.has(key)) return { ok: false, exists: true }; m.set(key, { data: clone(intent), etag: `"i${++n}"` }); return { ok: true, etag: `"i${n}"` }; },
    async update(key, intent, etag) { const x = m.get(key); if (!x || x.etag !== etag) return { ok: false, conflict: true }; m.set(key, { data: clone(intent), etag: `"i${++n}"` }); return { ok: true, etag: `"i${n}"` }; },
    async listOpen() { if (!openReadable) return { readable: false, why: "store down", intents: [] }; return { readable: true, intents: [...m.entries()].filter(([, x]) => !["asserted", "refused", "not-deposited"].includes(x.data.status)).map(([key, x]) => ({ key, intent: clone(x.data), etag: x.etag })) }; },
  };
}
function fakeReceipts() {
  const m = new Map();
  return { _m: m, async exists(key) { return m.has(key); }, async write(key, receipt, { onlyIfNew = false } = {}) { if (onlyIfNew && m.has(key)) return { ok: false, exists: true }; m.set(key, clone(receipt)); return { ok: true }; } };
}
const CLEAR_OBS = { r1: { status: "clear" }, r2: { status: "clear" }, r3: { status: "clear" }, r4: { status: "clear" } };
const ANCHOR = { blockNumber: 999, blockHash: "0x" + "11".repeat(32) };
const reading = (endpoint) => ({ endpoint, ok: true, blockHash: ANCHOR.blockHash, exitFee: { declaredBps: 10, measuredBps: 10 }, depositFeeBps: 0, redemption: { state: "full", positionShares: "100" }, payability: {} });
// ⭐ ONE clock function for the fixtures. A check records WHICH clock timed it (runMandateCheck attaches it to
// `timing`, non-enumerable) and the write refuses any other — so the fixtures must share this one function.
const FIXED_CLOCK = () => T0;
const withClock = (timing, clk) => (timing ? Object.defineProperty({ ...timing }, "clock", { value: clk, enumerable: false }) : timing);
const checked = ({ clock = FIXED_CLOCK, ...o } = {}) => {
  const c = { anchor: ANCHOR, check: { outage: null, observations: CLEAR_OBS, anchor: ANCHOR },
    report: { subject: { address: SUBJ, blockNumber: 999, chainId: MOCK_CHAIN_ID }, attestation: { status: "signed" } },
    verification: { valid: true }, reportFailure: null, readings: [reading("a"), reading("b")], cost: { signCalls: 1 },
    timing: { anchoredAt: T0 - 5_000, verifiedAt: T0 - 1_000 }, ...o };
  c.timing = withClock(c.timing, clock);
  return c;
};
const LIMITS = (o = {}) => ({ ceilingUsdc: () => 60, userReserveFraction: () => 0.5, vaultCapUsdc: () => 25,
  canSpendDay: async () => ({ allowed: true }), mandateDaySpend: async () => 0, dcaDaySpend: async () => 0,
  scaUsdcBalanceMinor: async () => 50_000_000n, ...o });
function execDeps({ record, exec, intents, mandates, receipts, facts, over = {} } = {}) {
  const executor = counting("executor", { async executeAction(step, ctx) {
    await ctx.onVaultSubmitted?.({ stage: "approve", circleId: "c-ap" });
    await ctx.onVaultSubmitted?.({ stage: "deposit", circleId: "c-dep" });
    return exec ? exec(step, ctx) : { ok: true, kind: "vault_deposit", depositHash: "0x" + "de".repeat(32), sharesReceivedRaw: "9999000" };
  } });
  const intentsC = counting("intents", intents ?? fakeIntents());
  const spends = [];
  return { executor, intentsC, spends, mandates: mandates ?? fakeMandates([record]), receipts: receipts ?? fakeReceipts(),
    deps: {
      executeAction: (...a) => executor.proxy.executeAction(...a),
      intents: intentsC.proxy, mandates: mandates ?? undefined, limits: LIMITS(),
      now: FIXED_CLOCK, // the write reads its clock from deps, at the write — the SAME function the fixture checks carry
      previewAtAnchor: async () => 9_999_500n,
      readDepositFacts: async () => facts ?? { readable: true, depositBlock: 1001, parentBlock: 1000, predictedAtParent: 9_999_000n, eventShares: 9_999_000n, shareDelta: 9_999_000n, feeAtParentBps: 0, feeAtDepositBlockBps: 0 },
      recordMandateSpend: async (x) => { spends.push({ kind: "mandate-day", ...x }); },
      recordAgentSpend: async (x) => { spends.push({ kind: "agent", ...x }); },
      ...over,
    } };
}
const ARMED = { armed: true, armedFrom: T0 - DAY, freshnessMs: 60_000 };

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — ⭐⭐ the WRITE gate: disarmed, and armed with the freshness window unset");
{
  const record = activeRecord();
  const x = execDeps({ record });
  x.deps.mandates = x.mandates;
  const d = await attemptAsync(() => depositForMandate({ record, etag: '"e0"', checked: checked(), amountUsdc: 10, deps: x.deps }));
  ok("⭐⭐ disarmed (the shipped constants) → REFUSED at the write", d?.ok === false && d?.code === REFUSED.DISARMED, show(d));
  ok("  …it says what it WOULD have deposited", d?.wouldDeposit?.amountUsdc === 10, show(d?.wouldDeposit));
  ok("⭐⭐ …the INTENT STORE was not touched (0 calls)", x.intentsC.calls.length === 0, show(x.intentsC.calls.map((c) => c.fn)));
  ok("⭐⭐ …the EXECUTOR was not touched (0 calls)", x.executor.calls.length === 0);
  ok("  …no ledger was written", x.spends.length === 0);

  const y = execDeps({ record }); y.deps.mandates = y.mandates;
  const u = await attemptAsync(() => depositForMandate({ record, etag: '"e0"', checked: checked(), amountUsdc: 10, deps: y.deps,
    config: { armed: true, armedFrom: T0 - DAY, freshnessMs: null } }));
  ok("⭐⭐ ARMED with the freshness window UNSET → REFUSED, by that rule", u?.ok === false && u?.code === REFUSED.FRESHNESS_UNSET, show(u));
  ok("  …nothing written, nothing executed", y.intentsC.calls.length === 0 && y.executor.calls.length === 0);
  for (const bad of [0, -1, NaN, "60000", Infinity]) {
    const z = execDeps({ record }); z.deps.mandates = z.mandates;
    const r = await attemptAsync(() => depositForMandate({ record, etag: '"e0"', checked: checked(), amountUsdc: 10, deps: z.deps,
      config: { armed: true, armedFrom: T0 - DAY, freshnessMs: bad } }));
    ok(`  a window of ${JSON.stringify(bad) ?? String(bad)} is not a window → refused, nothing executed`, r?.ok === false && r?.code === REFUSED.FRESHNESS_UNSET && z.executor.calls.length === 0, show(r));
  }

  // ⭐⭐ THE RED STATE: excise the rule from a copy of the module; the same case must stop refusing by it.
  const SRC = "netlify/functions/_vault-mandate-deposit.mjs";
  const real = readFileSync(SRC, "utf8");
  const START = "/* ⟦rule:freshness-unset⟧ */", END = "/* ⟦/rule:freshness-unset⟧ */";
  const i0 = real.indexOf(START), i1 = real.indexOf(END);
  ok("the rule is marked in the source, exactly once", i0 > 0 && i1 > i0 && real.indexOf(START, i0 + 1) === -1);
  if (i0 > 0 && i1 > i0) {
    const mutantPath = `netlify/functions/.mutant-vault-mandate-deposit-${process.pid}.mjs`;
    let mutant;
    try {
      writeFileSync(mutantPath, real.slice(0, i0) + real.slice(i1 + END.length));
      mutant = await import(`../${mutantPath}`);
    } finally { if (existsSync(mutantPath)) unlinkSync(mutantPath); }
    const w = execDeps({ record }); w.deps.mandates = w.mandates;
    const mu = await attemptAsync(() => mutant.depositForMandate({ record, etag: '"e0"', checked: checked(), amountUsdc: 10, deps: w.deps,
      config: { armed: true, armedFrom: T0 - DAY, freshnessMs: null } }));
    const caught = !(mu?.ok === false && mu?.code === REFUSED.FRESHNESS_UNSET);
    ok("⭐⭐ RED WITHOUT THE RULE: the excised module no longer refuses as FRESHNESS_UNSET (the case above would fail)", caught, `mutant → ${show(mu)}`);
    console.log(`     (mutant result: code=${mu?.code ?? "none"}, executor calls=${w.executor.calls.length}, intents calls=${w.intentsC.calls.length})`);
  }

  const af = execDeps({ record }); af.deps.mandates = af.mandates;
  const a = await attemptAsync(() => depositForMandate({ record, etag: '"e0"', checked: checked(), amountUsdc: 10, deps: af.deps,
    config: { armed: true, armedFrom: null, freshnessMs: 60_000 } }));
  ok("armed with no ARMED_FROM → refused (the two are flipped together)", a?.ok === false && a?.code === REFUSED.ARMED_FROM_UNSET && af.executor.calls.length === 0, show(a));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — the check cannot be skipped: the mutations the design names");
{
  const record = activeRecord();
  const run = async ({ c = checked(), amount = 10, rec = record, cfg = ARMED, extra = {}, over = {} } = {}) => {
    const x = execDeps({ record: rec, over }); x.deps.mandates = x.mandates;
    const r = await attemptAsync(() => depositForMandate({ record: rec, etag: '"e0"', checked: c, amountUsdc: amount, deps: x.deps, config: cfg, ...extra }));
    return { r, x };
  };
  const refusedBy = ({ r, x }, code) => r?.ok === false && (!code || r?.code === code) && x.executor.calls.length === 0 && x.intentsC.calls.filter((c) => c.fn !== "listOpen").length === 0;
  ok("no check → refused, nothing executed", refusedBy(await run({ c: null }), REFUSED.NO_CHECK));
  ok("⭐ a STALE check (anchored 61 s ago, window 60 s) → refused", refusedBy(await run({ c: checked({ timing: { anchoredAt: T0 - 61_000, verifiedAt: T0 - 60_500 } }) }), REFUSED.STALE_CHECK));
  const noT = await run({ c: checked({ timing: undefined }) });
  ok("a check with no timing → THROWS (it carries no clock, so it cannot prove it shares the write's)", /no clock/i.test(noT.r?.threw ?? "") && noT.x.executor.calls.length === 0, show(noT.r));
  // ⭐ A NEGATIVE AGE IS A BUG, NOT A STALE CHECK: the anchor cannot be later than the write that reads it unless
  // two clocks are being compared. It must be refused LOUDLY and under its own code, never filed as "stale".
  const loud = []; const origErr = console.error; console.error = (...a) => { loud.push(a.join(" ")); };
  let fut; try { fut = await run({ c: checked({ timing: { anchoredAt: T0 + 5_000, verifiedAt: T0 + 6_000 } }) }); } finally { console.error = origErr; }
  ok("⭐ a check timed AFTER the write (negative age) → refused as a CLOCK BUG, not as stale", refusedBy(fut, REFUSED.CLOCK_BUG) && fut.r?.code !== REFUSED.STALE_CHECK, show(fut.r));
  ok("  …and it is LOUD: console.error names the bug and both times", loud.some((l) => /CLOCK BUG/.test(l) && /negative/i.test(l) && l.includes(String(T0 + 5_000))), JSON.stringify(loud).slice(0, 200));
  // Fresh at the gate (age 5 s), stale by the time the preview + limit reads finish and the intent would be written.
  const reads = [T0, T0 + 56_000]; let ri = 0;
  const seqClock = () => reads[Math.min(ri++, reads.length - 1)];
  const slow = await run({ c: checked({ clock: seqClock }), over: { now: seqClock } });
  ok("⭐ fresh at the gate but past the window AT THE WRITE → refused as stale, before the intent", refusedBy(slow, REFUSED.STALE_CHECK) && /at the write/.test(slow.r?.reason ?? ""), show(slow.r));
  ok("⭐ an UNSIGNED report (verification invalid) → refused", refusedBy(await run({ c: checked({ verification: { valid: false, reason: "owner-key-mismatch" } }) }), REFUSED.UNSIGNED));
  ok("no report at all → refused", refusedBy(await run({ c: checked({ report: null, verification: null }) }), REFUSED.UNSIGNED));
  ok("a report for ANOTHER address → refused", refusedBy(await run({ c: checked({ report: { ...checked().report, subject: { ...checked().report.subject, address: "0x" + "99".repeat(20) } } }) }), REFUSED.UNSIGNED));
  ok("a report at another block than the anchor → refused", refusedBy(await run({ c: checked({ report: { ...checked().report, subject: { ...checked().report.subject, blockNumber: 998 } } }) }), REFUSED.UNSIGNED));
  const found = { ...CLEAR_OBS, r1: { status: "violated", evidence: { power: "pausable" } } };
  ok("⭐ a passed-in 'deposit' decision over a check whose rules FIND something → refused (it re-decides)",
    refusedBy(await run({ c: checked({ check: { outage: null, observations: found, anchor: ANCHOR } }), extra: { decision: { action: "deposit", depositAllowed: true } } }), REFUSED.DECISION));
  ok("an OUTAGE check → refused (re-decided: pause)", refusedBy(await run({ c: checked({ check: { outage: { reason: "rpc" }, observations: {}, anchor: ANCHOR } }) }), REFUSED.DECISION));
  ok("11 USDC (> MANDATE_DEPOSIT_MAX) → refused", refusedBy(await run({ amount: 11 }), REFUSED.AMOUNT));
  ok("more than the record's own amount → refused", refusedBy(await run({ rec: activeRecord({ terms: { ...TERMS, amountPerDepositUsdc: 5 } }), amount: 6 }), REFUSED.AMOUNT));
  const spent = clone(record); spent.progress.depositedUsdc = 95;
  ok("more than the remaining budget → refused", refusedBy(await run({ rec: spent, amount: 10 }), REFUSED.AMOUNT));
  const stale = clone(record); stale.terms.amountPerDepositUsdc = 9;
  ok("⭐ a record that may not act (edited after the ack) → refused", refusedBy(await run({ rec: stale, amount: 9 }), REFUSED.RECORD));
  ok("before ARMED_FROM → refused (no deposit for a window before arming)", refusedBy(await run({ cfg: { ...ARMED, armedFrom: T0 + 1 } }), REFUSED.NOT_YET_ARMED));
  ok("readings the two endpoints disagree on → refused before any intent (the assertion needs the check's fee)",
    refusedBy(await run({ c: checked({ readings: [reading("a"), { ...reading("b"), depositFeeBps: 5 }] }) }), REFUSED.READINGS));
  ok("the preview at the anchor unreadable → refused before any intent", refusedBy(await run({ over: { previewAtAnchor: async () => null } }), REFUSED.PREVIEW));
  ok("⭐ the daily ceiling has no room at the write → refused, no intent, no execution",
    refusedBy(await run({ over: { limits: LIMITS({ canSpendDay: async () => ({ allowed: false, reason: "daily agent-spend ceiling" }) }) } }), REFUSED.NO_ROOM));
  ok("the mandate day share has no room at the write → refused", refusedBy(await run({ over: { limits: LIMITS({ mandateDaySpend: async () => 10 }) } }), REFUSED.NO_ROOM));
  ok("the SCA holds less than the deposit → refused", refusedBy(await run({ over: { limits: LIMITS({ scaUsdcBalanceMinor: async () => 9_999_999n }) } }), REFUSED.NO_ROOM));
  ok("a limit that cannot be read → refused", refusedBy(await run({ over: { limits: LIMITS({ vaultCapUsdc: () => { throw new Error("garbled cap"); } }) } }), REFUSED.NO_ROOM));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("8 — an ARMED deposit, end to end (fakes at every boundary)");
{
  const record = activeRecord();
  const x = execDeps({ record }); x.deps.mandates = x.mandates;
  const r = await attemptAsync(() => depositForMandate({ record, etag: '"e0"', checked: checked(), amountUsdc: 10, deps: x.deps, config: ARMED }));
  ok("deposited + asserted matched", r?.ok === true && r?.verdict?.verdict === "matched", show(r));
  const ex = x.executor.calls[0]?.args?.[0], ctx = x.executor.calls[0]?.args?.[1];
  ok("ONE executeAction call, type vault_deposit, the record's vault, 10 USDC", x.executor.calls.length === 1 && ex?.type === "vault_deposit" && ex?.vault === "xylo-usdc" && ex?.amountUsdc === 10, show(ex));
  ok("⭐ the ack token is the STORED one (never minted from today's inspection)", ex?.ackToken === ACK);
  ok("the executor runs as the record's agent wallet", ctx?.walletAddress === HOLDER);
  ok("⭐ the day-ceiling charge is keyed by the intent (idempotent for recovery)", typeof ctx?.chargeId === "string" && ctx.chargeId === r?.intentKey, show(ctx?.chargeId));
  const intentKeys = [...x.intentsC.proxy._m.keys()];
  const intent = x.intentsC.proxy._m.get(intentKeys[0])?.data;
  ok("one intent, keyed d/<owner>/<id>/<seq>", intentKeys.length === 1 && intentKeys[0] === `d/${SESSION}/vm-1/1`, intentKeys.join(","));
  ok("⭐ the intent was CREATED before the executor ran", x.intentsC.calls[0]?.fn === "create" && x.intentsC.calls[0]?.args?.[1]?.status === "submitting");
  const created = x.intentsC.calls[0]?.args?.[1];
  ok("  …carrying the anchor, the report digest, amount, sharesPredicted, sharesBefore, usdcBefore, the check's deposit fee",
    created?.anchor?.blockHash === ANCHOR.blockHash && /^[0-9a-f]{64}$/.test(created?.reportDigest ?? "") && created?.amountUsdc === 10 &&
    created?.sharesPredicted === "9999500" && created?.sharesBefore === "100" && created?.usdcBeforeMinor === "50000000" && created?.depositFeeBpsAtCheck === 0, show(created));
  ok("the Circle ids reached the intent through the onSubmitted hook", x.intentsC.calls.some((c) => c.fn === "update" && c.args[1]?.status === "submitted" && c.args[1]?.circleIds?.deposit === "c-dep"));
  ok("the intent ends ASSERTED with the verdict and the hash", intent?.status === "asserted" && intent?.verdict?.verdict === "matched" && /^0x/.test(intent?.txHash ?? ""), show(intent));
  const after = x.mandates._m.get(`${SESSION}/vm-1`)?.data;
  ok("⭐ the record: deposited total 10, count 1, seq 2, next due = now + one week (no backlog)",
    after?.progress?.depositedUsdc === 10 && after?.progress?.depositCount === 1 && after?.progress?.nextSeq === 2 && after?.progress?.nextDueAt === T0 + 7 * DAY, show(after?.progress));
  ok("  …still active and still able to act", after?.status === "active" && verifyMandateRecord(after).mayAct === true);
  ok("the mandate-day counter was charged once, by the intent key", x.spends.filter((s) => s.kind === "mandate-day").length === 1 && x.spends[0].chargeId === r?.intentKey);
  ok("the receipt carries the signed report, the anchor hash, the readings, the decision, the tx and the assertion",
    r?.receipt?.report?.attestation?.status === "signed" && r?.receipt?.anchor?.blockHash === ANCHOR.blockHash && r?.receipt?.readings?.length === 2 &&
    r?.receipt?.decision?.action === "deposit" && /^0x/.test(r?.receipt?.txHash ?? "") && r?.receipt?.assertion?.verdict === "matched", show(Object.keys(r?.receipt ?? {})));

  // no double deposit: the seq is create-only
  const pre = fakeIntents({ preset: [[`d/${SESSION}/vm-1/1`, { status: "submitting" }]] });
  const y = execDeps({ record, intents: pre }); y.deps.mandates = y.mandates;
  const dd = await attemptAsync(() => depositForMandate({ record, etag: '"e0"', checked: checked(), amountUsdc: 10, deps: y.deps, config: ARMED }));
  ok("⭐ an intent already exists for this seq → refused, the executor NOT called (no double deposit)", dd?.ok === false && dd?.code === REFUSED.INTENT_EXISTS && y.executor.calls.length === 0, show(dd));

  // the executor refuses on the disclosure → pause DISCLOSURE_CHANGED
  const z = execDeps({ record, exec: async () => ({ ok: false, blocked: "your acknowledgment does not match the vault's current disclosure", disclosure: { level: "WARN" } }) }); z.deps.mandates = z.mandates;
  const dc = await attemptAsync(() => depositForMandate({ record, etag: '"e0"', checked: checked(), amountUsdc: 10, deps: z.deps, config: ARMED }));
  const zr = z.mandates._m.get(`${SESSION}/vm-1`)?.data;
  ok("⭐ a changed vault disclosure → the mandate PAUSES with DISCLOSURE_CHANGED", dc?.ok === false && zr?.status === "paused" && zr?.pause?.flags?.includes("DISCLOSURE_CHANGED"), show(zr?.pause));
  ok("  …the intent is marked refused", [...z.intentsC.proxy._m.values()][0]?.data?.status === "refused");

  // the executor refuses on the day ceiling (a race) → skip, never pause
  const w = execDeps({ record, exec: async () => ({ ok: false, blocked: "daily agent-spend ceiling: 70 > 60 USDC" }) }); w.deps.mandates = w.mandates;
  const dl = await attemptAsync(() => depositForMandate({ record, etag: '"e0"', checked: checked(), amountUsdc: 10, deps: w.deps, config: ARMED }));
  const wr = w.mandates._m.get(`${SESSION}/vm-1`)?.data;
  ok("⭐ the daily limit refuses at the executor → 'checked, not deposited', the mandate stays ACTIVE", dl?.ok === false && dl?.code === REFUSED.EXECUTOR && wr?.status === "active" && wr?.progress?.depositedUsdc === 0, show(dl));
  ok("  …the intent is refused, the receipt keeps the signed check", [...w.intentsC.proxy._m.values()][0]?.data?.status === "refused" && dl?.receipt?.report?.attestation?.status === "signed");

  // the executor throws mid-flight → the intent stays open for recovery; nothing is declared
  const t = execDeps({ record, exec: async () => { throw new Error("socket hang up"); } }); t.deps.mandates = t.mandates;
  const th = await attemptAsync(() => depositForMandate({ record, etag: '"e0"', checked: checked(), amountUsdc: 10, deps: t.deps, config: ARMED }));
  const ti = [...t.intentsC.proxy._m.values()][0]?.data;
  ok("⭐ the executor throws → the intent stays OPEN (submitted), never 'not-deposited'", th?.ok === false && th?.code === REFUSED.OUTCOME_UNKNOWN && ti?.status === "submitted", show({ th, ti }));
  ok("  …the record is untouched (recovery reads the chain next tick)", t.mandates._m.get(`${SESSION}/vm-1`)?.data?.progress?.depositedUsdc === 0);

  // mismatched assertion → pause; the deposit stays counted
  const mm = execDeps({ record, facts: { readable: true, depositBlock: 1001, parentBlock: 1000, predictedAtParent: 9_999_000n, eventShares: 9_000_000n, shareDelta: 9_000_000n, feeAtParentBps: 0, feeAtDepositBlockBps: 0 } }); mm.deps.mandates = mm.mandates;
  const mr = await attemptAsync(() => depositForMandate({ record, etag: '"e0"', checked: checked(), amountUsdc: 10, deps: mm.deps, config: ARMED }));
  const mrec = mm.mandates._m.get(`${SESSION}/vm-1`)?.data;
  ok("⭐ fewer shares than quoted → the mandate PAUSES, the deposit is still counted (no autonomous withdrawal)",
    mr?.verdict?.verdict === "mismatched" && mrec?.status === "paused" && mrec?.progress?.depositedUsdc === 10, show(mrec?.pause));
  const ur = execDeps({ record, facts: { readable: false, why: "receipt unreadable" } }); ur.deps.mandates = ur.mandates;
  await attemptAsync(() => depositForMandate({ record, etag: '"e0"', checked: checked(), amountUsdc: 10, deps: ur.deps, config: ARMED }));
  const urec = ur.mandates._m.get(`${SESSION}/vm-1`)?.data;
  ok("an unreadable assertion → pause INCONCLUSIVE, never matched", urec?.status === "paused" && urec?.pause?.flags?.includes("INCONCLUSIVE"), show(urec?.pause));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("9 — ⭐⭐ the DISARMED TICK: a real signed check, no intent, no executor");
// The real transport: the shared mock chain, a throwaway key standing in for the DD wallet, an ERC-1271
// mock that recovers the signer (the stand-ins verify-vault-mandate-transport uses).
const A = "https://a.example", B = "https://b.example";
const HANDLERS = { [`code@${SUBJ}`]: codeWith(["upgradeTo(address)", "setFees(uint256,uint256,uint256)"]),
  [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD, ["call@0x8da5cb5b"]: word(OWNER), [`code@${OWNER}`]: "0x" };
const key = privateKeyToAccount(generatePrivateKey());
const REG = "0x" + "44".repeat(20), VC = "0x" + "55".repeat(20);
const IDENTITY = { agentId: "851891", registry: REG, verifyingContract: VC, chainId: String(MOCK_CHAIN_ID), domain: DOMAIN.prod, keyId: "test", keyClass: "registered" };
function verifyClient() {
  const wrap = (hex) => ({ result: hex, query: {}, evidence: { httpStatus: 200 } });
  return { async call({ method, params }) {
    if (method === "eth_chainId") return wrap("0x" + BigInt(IDENTITY.chainId).toString(16));
    const to = String(params?.[0]?.to ?? "").toLowerCase(), data = String(params?.[0]?.data ?? "");
    if (to === REG && data.startsWith("0x6352211e")) return wrap("0x" + BigInt(VC).toString(16).padStart(64, "0"));
    if (to === VC && data.startsWith("0x1626ba7e")) {
      const body = data.slice(10), digest = "0x" + body.slice(0, 64);
      const len = Number(BigInt("0x" + body.slice(128, 192))), sig = "0x" + body.slice(192, 192 + len * 2);
      let r; try { r = await recoverAddress({ hash: digest, signature: sig }); } catch { return wrap("0xffffffff" + "0".repeat(56)); }
      return wrap((r.toLowerCase() === key.address.toLowerCase() ? "0x1626ba7e" : "0xffffffff") + "0".repeat(56));
    }
    throw new Error(`mock verify: unexpected ${to} ${data.slice(0, 10)}`);
  } };
}
function stubReader(endpoint) {
  const vals = { withdrawFee: 10n, depositFee: 0n, decimals: 6n, balanceOf: 0n, maxRedeem: 0n,
    convertToAssets: 1000000n, previewRedeem: 999000n, totalAssets: 200n, assetBalanceOf: 300n, MAX_FEE: 2000n };
  return { endpoint, blockNumber: async () => 1000, blockHash: async () => ANCHOR.blockHash,
    async read({ address, fn }) { return vals[fn === "balanceOf" && String(address).toLowerCase() === ASSET ? "assetBalanceOf" : fn]; },
    async simulateRedeem() { return { outcome: "returned", assetsRaw: "0" }; } };
}
let signs = 0;
const checkDeps = () => ({ health: async () => ({ serving: true }), analyzeClient: quorumClient([mkc(A, HANDLERS), mkc(B, HANDLERS)]),
  signOptions: { sign: (message) => { signs++; return key.signMessage({ message }); }, ...IDENTITY }, verifyClient: verifyClient(), identity: IDENTITY,
  anchorReaders: [stubReader(A), stubReader(B)], stateReaders: [stubReader(A), stubReader(B)],
  resolveVault: (k) => (k === "xylo-usdc" ? { ...VAULT, assetAddress: ASSET } : null), cashOnly: () => true });
function tickDeps(record, { intents, over = {}, clock = T0 } = {}) {
  const x = execDeps({ record, intents });
  // ONE clock for the tick and its checks (production wires the same function into both). At T0 it is the
  // fixtures' FIXED_CLOCK, so checks built by `checked()` in runCheck overrides share it too.
  const clk = clock === T0 ? FIXED_CLOCK : () => clock;
  const mandates = counting("mandates", fakeMandates([record]));
  const receipts = fakeReceipts();
  return { x, mandates, receipts, deps: {
    ...x.deps, mandates: mandates.proxy, receipts, now: clk,
    isPaused: async () => null,
    runCheck: (rec) => runMandateCheck({ record: rec, deps: { ...checkDeps(), now: clk } }),
    ...over,
  } };
}
{
  const record = activeRecord();
  signs = 0;
  const t = tickDeps(record);
  const res = await attemptAsync(() => runMandateTick({ deps: t.deps }));
  const one = res?.results?.[0];
  ok("the tick ran one mandate", Array.isArray(res?.results) && res.results.length === 1, show(res));
  ok("⭐⭐ disarmed → the outcome is WOULD-DEPOSIT 10 USDC", one?.outcome === "would-deposit" && one?.amountUsdc === 10, show(one));
  ok("⭐⭐ …a SIGNED check was produced (one signMessage), and its signer VERIFIED", signs === 1 && one?.receipt?.report?.attestation?.status === "signed" && one?.receipt?.verification?.valid === true, `signs=${signs} ${show(one?.receipt?.verification)}`);
  ok("⭐⭐ …the INTENT STORE received 0 calls (not even the recovery read)", t.x.intentsC.calls.length === 0, show(t.x.intentsC.calls.map((c) => c.fn)));
  ok("⭐⭐ …the EXECUTOR received 0 calls", t.x.executor.calls.length === 0);
  ok("  …no ledger was written", t.x.spends.length === 0);
  ok("  …the record was never written (read only)", t.mandates.calls.every((c) => c.fn !== "update"), show(t.mandates.calls.map((c) => c.fn)));
  ok("⭐ the receipt carries the SIGNING LATENCY (decision 4's measurement)", Number.isFinite(one?.receipt?.timing?.signingLatencyMs) && one.receipt.timing.signingLatencyMs >= 0, show(one?.receipt?.timing));
  ok("  …and the anchor, the readings and the decision", one?.receipt?.anchor?.blockHash === ANCHOR.blockHash && one?.receipt?.readings?.length === 2 && one?.receipt?.decision?.action === "deposit");
  ok("the receipt was written once (create-only, per window)", t.receipts._m.size === 1, [...t.receipts._m.keys()].join(","));

  signs = 0;
  const again = await attemptAsync(() => runMandateTick({ deps: { ...t.deps } }));
  ok("⭐ a second disarmed tick in the SAME window signs nothing (one observation per window)", signs === 0 && again?.results?.[0]?.outcome === "observed-this-window" && t.receipts._m.size === 1, show(again?.results?.[0]));
  signs = 0;
  const t2 = tickDeps(record, { clock: T0 + 7 * DAY });
  t2.receipts._m = t.receipts._m; // same receipt store, next window
  Object.assign(t2.receipts, { exists: async (k) => t.receipts._m.has(k), write: async (k, v, o = {}) => { if (o.onlyIfNew && t.receipts._m.has(k)) return { ok: false }; t.receipts._m.set(k, v); return { ok: true }; } });
  const next = await attemptAsync(() => runMandateTick({ deps: t2.deps }));
  ok("the next cadence window → a fresh signed observation", signs === 1 && next?.results?.[0]?.outcome === "would-deposit", show(next?.results?.[0]));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("10 — the tick's order of operations");
{
  const record = activeRecord();
  signs = 0;
  const notDue = clone(record); notDue.progress.nextDueAt = T0 + 1000;
  const a = tickDeps(notDue);
  const r1 = await attemptAsync(() => runMandateTick({ deps: a.deps }));
  ok("not due → nothing checked, nothing signed", r1?.results?.[0]?.outcome === "not-due" && signs === 0, show(r1?.results?.[0]));

  signs = 0;
  const b = tickDeps(record, { over: { limits: LIMITS({ mandateDaySpend: async () => 10 }) } });
  const r2 = await attemptAsync(() => runMandateTick({ deps: b.deps }));
  ok("⭐ the mandate day share has no room → SKIPPED at preflight, NO check run, NO signature spent", r2?.results?.[0]?.outcome === "skipped" && signs === 0, show(r2?.results?.[0]));
  ok("  …and the mandate is NOT paused (the user's own budget, not a vault finding)", b.mandates.calls.every((c) => c.fn !== "update"));
  signs = 0;
  const c = tickDeps(record, { over: { limits: LIMITS({ canSpendDay: async () => ({ allowed: false, reason: "daily agent-spend ceiling: 70 > 60" }) }) } });
  const r3 = await attemptAsync(() => runMandateTick({ deps: c.deps }));
  ok("the daily ceiling has no room → skipped, no signature", r3?.results?.[0]?.outcome === "skipped" && /ceiling/.test(r3?.results?.[0]?.reason ?? "") && signs === 0, show(r3?.results?.[0]));
  signs = 0;
  const d = tickDeps(record, { over: { limits: LIMITS({ scaUsdcBalanceMinor: async () => 1n }) } });
  const r4 = await attemptAsync(() => runMandateTick({ deps: d.deps }));
  ok("the SCA cannot fund it → skipped, no signature", r4?.results?.[0]?.outcome === "skipped" && signs === 0, show(r4?.results?.[0]));
  signs = 0;
  const e = tickDeps(record, { over: { isPaused: async () => "Your Vault agent is paused." } });
  const r5 = await attemptAsync(() => runMandateTick({ deps: e.deps }));
  ok("the Vault agent's kill switch → skipped before anything is read", r5?.results?.[0]?.outcome === "skipped" && /paused/i.test(r5?.results?.[0]?.reason ?? "") && signs === 0, show(r5?.results?.[0]));
  const spent = clone(record); spent.progress.depositedUsdc = 100;
  const f = tickDeps(spent);
  const r6 = await attemptAsync(() => runMandateTick({ deps: f.deps }));
  ok("the total budget is spent → skipped (budget exhausted)", r6?.results?.[0]?.outcome === "skipped" && /budget/i.test(r6?.results?.[0]?.reason ?? ""), show(r6?.results?.[0]));
  const waiting = build().record;
  const g = tickDeps(waiting);
  const r7 = await attemptAsync(() => runMandateTick({ deps: g.deps }));
  ok("a mandate awaiting acknowledgement never acts", r7?.results?.[0]?.outcome === "may-not-act", show(r7?.results?.[0]));

  // ARMED: recovery first; an unreadable open intent blocks the mandate
  signs = 0;
  const h = tickDeps(record, { intents: fakeIntents({ openReadable: false }) });
  const r8 = await attemptAsync(() => runMandateTick({ deps: h.deps, config: ARMED }));
  ok("⭐ armed: the intent store unreadable → the mandate is BLOCKED (recover first), nothing signed", r8?.results?.[0]?.outcome === "blocked-by-recovery" && signs === 0 && h.x.executor.calls.length === 0, show(r8?.results?.[0]));
  signs = 0;
  const open = [[`d/${SESSION}/vm-1/1`, { status: "submitted", createdAt: new Date(T0 - 60_000).toISOString(), sharesBefore: "0", amountUsdc: 10, seq: 1, anchor: ANCHOR, circleIds: { deposit: "c-dep" } }]];
  const i = tickDeps(record, { intents: fakeIntents({ preset: open }), over: { recovery: { circleState: async () => ({ state: "PENDING" }), findDepositEvent: async () => ({ found: false }), shareBalance: async () => 0n } } });
  const r9 = await attemptAsync(() => runMandateTick({ deps: i.deps, config: ARMED }));
  ok("⭐ armed: an intent still in flight → the mandate waits; one intent in flight per mandate", r9?.results?.[0]?.outcome === "blocked-by-recovery" && i.x.executor.calls.length === 0 && signs === 0, show(r9?.results?.[0]));
  const j = tickDeps(record, { intents: fakeIntents({ preset: open }), over: { recovery: {
    circleState: async () => ({ state: "COMPLETE", txHash: "0x" + "ab".repeat(32) }), findDepositEvent: async () => ({ found: true, txHash: "0x" + "ab".repeat(32) }), shareBalance: async () => 9_999_000n } } });
  const r10 = await attemptAsync(() => runMandateTick({ deps: j.deps, config: ARMED }));
  const jr = [...j.mandates.proxy._m.values()][0]?.data;
  ok("⭐ armed: recovery finds the deposit LANDED → it asserts and commits, and NEVER resubmits", j.x.executor.calls.length === 0 && jr?.progress?.depositedUsdc === 10 && jr?.progress?.nextSeq === 2, show({ r: r10?.results?.[0]?.recovery, p: jr?.progress }));
  ok("  …the day-ceiling ledger row is (re)written by the intent key, idempotently", j.x.spends.some((s) => s.kind === "agent" && s.chargeId === `d/${SESSION}/vm-1/1`) && j.x.spends.some((s) => s.kind === "mandate-day"));
  const k = tickDeps(record, { intents: fakeIntents({ preset: [[open[0][0], { ...open[0][1], createdAt: new Date(T0 - 2 * RECOVERY_NOT_DEPOSITED_AFTER_MS).toISOString() }]] }), over: { recovery: {
    circleState: async () => ({ state: "FAILED" }), findDepositEvent: async () => ({ found: false }), shareBalance: async () => 0n } } });
  const r11 = await attemptAsync(() => runMandateTick({ deps: k.deps, config: ARMED }));
  const kr = [...k.mandates.proxy._m.values()][0]?.data;
  ok("armed: recovery establishes NOT deposited → the intent closes, the budget is untouched", [...k.x.intentsC.proxy._m.values()][0]?.data?.status === "not-deposited" && kr?.progress?.depositedUsdc === 0, show(r11?.results?.[0]?.recovery));

  // EXIT decisions are pauses until piece 5 (a record carrying an exit rule can only exist through the test seam)
  signs = 0;
  const exitRec = (() => { const b2 = buildMandateRecord({ owner: SESSION, walletAddress: HOLDER, vault: VAULT, terms: TERMS, baseline: BASELINE, now: T0 - DAY, id: "vm-1",
    rules: [{ kind: "power", subject: "upgradeable", onFinding: "exit" }], exitAvailable: true }); return acknowledgeMandate(b2.record, b2.record.fingerprint, T0 - DAY).record; })();
  const l = tickDeps(exitRec, { over: { runCheck: async () => checked({ check: { outage: null, anchor: ANCHOR, observations: { r1: { status: "violated", evidence: { power: "upgradeable" } } } } }) } });
  const r12 = await attemptAsync(() => runMandateTick({ deps: l.deps, config: ARMED }));
  const lr = [...l.mandates.proxy._m.values()][0]?.data;
  ok("⭐ an EXIT decision is treated as a PAUSE (EXIT_UNAVAILABLE), nothing executed", lr?.status === "paused" && lr?.pause?.flags?.includes("EXIT_UNAVAILABLE") && l.x.executor.calls.length === 0, show(lr?.pause ?? r12));
  const m = tickDeps(record, { over: { runCheck: async () => checked({ check: { outage: { reason: "rpc down" }, observations: {}, anchor: ANCHOR } }) } });
  await attemptAsync(() => runMandateTick({ deps: m.deps }));
  ok("disarmed: a PAUSE decision is recorded as would-pause; the record is not written", m.mandates.calls.every((c) => c.fn !== "update") && [...m.receipts._m.values()][0]?.outcome === "would-pause");
  const n = tickDeps(record, { over: { runCheck: async () => checked({ check: { outage: { reason: "rpc down" }, observations: {}, anchor: ANCHOR } }) } });
  await attemptAsync(() => runMandateTick({ deps: n.deps, config: ARMED }));
  const nr = [...n.mandates.proxy._m.values()][0]?.data;
  ok("armed: an OUTAGE pauses (never exits, never deposits)", nr?.status === "paused" && nr?.pause?.flags?.includes("OUTAGE") && n.x.executor.calls.length === 0, show(nr?.pause));

  // no catch-up
  const ds = dueState({ record: activeRecord(), now: T0, config: { armed: true, armedFrom: T0 + 3 * DAY } });
  ok("⭐ no catch-up: armed later than the first due → next due is the ARMING moment", ds.due === false && ds.dueAt === T0 + 3 * DAY, show(ds));
  const ds2 = dueState({ record: activeRecord(), now: T0 + 30 * DAY, config: { armed: true, armedFrom: T0 } });
  ok("  …a month overdue is ONE deposit, not a backlog of four", ds2.due === true && ds2.windowsOverdue === undefined, show(ds2));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("11 — ⭐⭐ the clock: an ADVANCING clock, as in production (tick and check both read Date.now)");
// Until 2026-09-26 every test here used ONE fixed clock for the tick start, the check and the write, so the
// age at the write was always exactly 0. Production reads the clock at different moments, and the tick passed
// its START time to the write while the check stamped its anchor LATER: age = tickStart − anchoredAt < 0, and
// every armed deposit was refused as stale. A clock that advances on every read reproduces that.
{
  const advancing = (start, step) => { let t = start; return () => (t += step); };
  const armedTick = async (records, clock) => {
    const x = execDeps({ record: records[0] });
    const mandates = fakeMandates(records);
    const deps = { ...x.deps, mandates, receipts: fakeReceipts(), now: clock, isPaused: async () => null,
      runCheck: (rec) => runMandateCheck({ record: rec, deps: { ...checkDeps(), now: clock } }) };
    const res = await attemptAsync(() => runMandateTick({ deps, config: { ...ARMED, armedFrom: T0 - DAY } }));
    return { res, x, mandates };
  };
  const loud = []; const origErr = console.error; console.error = (...a) => { loud.push(a.join(" ")); };
  let one, three;
  try {
    one = await armedTick([activeRecord()], advancing(T0, 1_000));
    three = await armedTick([activeRecord({ id: "vm-1" }), activeRecord({ id: "vm-2" }), activeRecord({ id: "vm-3" })], advancing(T0, 7_000));
  } finally { console.error = origErr; }
  const r1 = one.res?.results?.[0];
  ok("⭐⭐ ONE armed mandate, advancing clock → DEPOSITED (not refused as stale)", r1?.outcome === "deposited" && one.x.executor.calls.length === 1, show({ outcome: r1?.outcome, code: r1?.code, reason: r1?.receipt?.reason ?? r1?.reason }));
  ok("  …the age at the write is recorded, and it is NOT negative", Number.isFinite(r1?.receipt?.checkAgeMs) && r1.receipt.checkAgeMs >= 0, show(r1?.receipt?.checkAgeMs));
  // Clock reads between the anchor and the write: verifiedAt, the early gate, then the write itself = 3 steps.
  ok("  …and it is measured from the check's OWN anchor to a clock read AT the write (3 reads later = 3000 ms)", r1?.receipt?.checkAgeMs === 3_000, show(r1?.receipt?.checkAgeMs));
  const rs = three.res?.results ?? [];
  ok("⭐⭐ THREE mandates in one tick → all three deposited", rs.length === 3 && rs.every((r) => r.outcome === "deposited") && three.x.executor.calls.length === 3, show(rs.map((r) => [r.id, r.outcome, r.code])));
  const ages = rs.map((r) => r.receipt?.checkAgeMs);
  ok("⭐⭐ …the later mandates do NOT accumulate a larger apparent age (each is its own anchor → its own write)", ages.length === 3 && ages.every((a) => a === ages[0]) && ages[0] === 21_000, JSON.stringify(ages));
  ok("  …no age is negative", ages.every((a) => Number.isFinite(a) && a >= 0), JSON.stringify(ages));
  ok("  …and nothing on this path logged a CLOCK BUG", !loud.some((l) => /CLOCK BUG/.test(l)), JSON.stringify(loud).slice(0, 200));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("12 — ⭐⭐ ONE clock: the check and the write cannot diverge");
// The stale gate compares the check's anchoredAt with the write's clock. That is only meaningful if both came
// from the SAME clock. It used to hold by coincidence (both defaulted to Date.now); now it is checked by identity.
{
  const record = activeRecord();
  const two = execDeps({ record }); two.deps.mandates = two.mandates;
  const other = () => T0; // the SAME value, a DIFFERENT clock
  const d2 = await attemptAsync(() => depositForMandate({ record, etag: '"e0"', checked: checked({ clock: other }), amountUsdc: 10, deps: two.deps, config: ARMED }));
  ok("⭐⭐ two different clocks (even returning the same time) → THROWS, nothing written or executed",
    /two clocks/i.test(d2?.threw ?? "") && two.executor.calls.length === 0 && two.intentsC.calls.length === 0, show(d2));
  const dis = execDeps({ record }); dis.deps.mandates = dis.mandates;
  const d3 = await attemptAsync(() => depositForMandate({ record, etag: '"e0"', checked: checked({ clock: other }), amountUsdc: 10, deps: dis.deps }));
  ok("⭐ …it throws while DISARMED too, so the deployed disarmed tick proves the wiring before anything is armed", /two clocks/i.test(d3?.threw ?? ""), show(d3));

  // runMandateCheck records the clock that timed it — and keeps it out of anything serialised.
  const mine = () => T0;
  const c1 = await attemptAsync(() => runMandateCheck({ record, deps: { ...checkDeps(), now: mine } }));
  ok("runMandateCheck stamps timing.clock with the clock it used", c1?.timing?.clock === mine, show(c1?.timing));
  ok("  …non-enumerable: a stored receipt never carries a function", !Object.keys(c1?.timing ?? {}).includes("clock") && !/clock/.test(JSON.stringify(c1?.timing ?? {})));
  const c2 = await attemptAsync(() => runMandateCheck({ record, deps: checkDeps() }));
  ok("  …with no clock given it falls back to Date.now, and says so", c2?.timing?.clock === Date.now);

  // ⭐ THE PRODUCTION WIRING, built offline and inspected: the check's clock IS the tick's clock.
  const fakeStore = () => ({ get: async () => null, getWithMetadata: async () => null, setJSON: async () => ({}), list: async () => ({ blobs: [] }) });
  const prod = await attemptAsync(() => productionTickDeps({ getStore: fakeStore }));
  ok("⭐⭐ production: the check deps' clock is the SAME function as the tick's (wired, not defaulted)",
    typeof prod?.now === "function" && typeof prod?.checkDepsFor === "function" && prod.checkDepsFor().now === prod.now, show(prod?.threw ?? Object.keys(prod ?? {})));
  const pd = productionDeps({ health: async () => ({}), resolveVault: () => null, now: mine });
  ok("  …productionDeps carries the `now` it is given", pd.now === mine);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
