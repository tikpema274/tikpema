#!/usr/bin/env node
// verify-vault-mandate-observe.mjs — the adapter from a DD report + our own vault reads to per-rule
// observations, and the shapes that would turn a failure to read into a finding (or a clear).
//
//   node scripts/verify-vault-mandate-observe.mjs
//
// ═══ WHAT THE ADAPTER DECIDES ════════════════════════════════════════════════════════════════
// The decider (decide.mjs) exits only on `violated` with evidence. So THIS file is where a failure to
// read could become a finding, or a clear. Every fixture below is one of those:
//   · an unsigned / refused / wrong-subject / stale report         → the rules it serves are OUTAGE
//   · a power group the report could not check                    → INCONCLUSIVE, never clear
//   · an owner() that could not be read                           → INCONCLUSIVE, never "unchanged"
//   · one endpoint's reading, or two readings from ONE endpoint   → OUTAGE (no quorum)
//   · a reading at a different block than the anchor              → OUTAGE (a provider served latest)
//   · two endpoints that disagree                                 → INCONCLUSIVE
//   · a fee the vault declares that its own preview contradicts   → INCONCLUSIVE
//
// ⭐ AND THE CONFIRMED RULE (T, 2026-09-25): an unreadable source does not veto a finding another
// source established. A DD engine that is down must not cancel an exit rule on a fee two endpoints
// agree was raised, and a broken fee read must not cancel an exit rule on a signed power finding.
//
// Reports are built by REAL analyze() runs over the shared mock chain and signed with a throwaway
// key through the real attachAttestation, not hand-written JSON.

import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { analyze } from "../shared/onchain-analyze/index.mjs";
import { attachAttestation } from "../shared/onchain-analyze/attest.mjs";
import { EIP1967_IMPL_SLOT } from "../shared/onchain-facts/index.mjs";
import { SUBJ, IMPL, OWNER, ZERO_WORD, word, codeWith, mockClient, transientThrow } from "./dd/_mock-chain.mjs";
import { observeMandateCheck, STATE_READ_QUORUM } from "../shared/vault-mandate/observe.mjs";
import { decideMandateAction, OBSERVED, CAUSE, ACTION, FLAG, ON_FINDING } from "../shared/vault-mandate/decide.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const attempt = (fn) => { try { return fn(); } catch (e) { return { threw: String(e?.message ?? e) }; } };

// ── fixtures: real reports ─────────────────────────────────────────────────────────────────────
const acct = privateKeyToAccount(generatePrivateKey());
const IDENT = { agentId: "851891", verifyingContract: acct.address, registry: "0x" + "44".repeat(20), chainId: "31337", keyId: "test" }; // fixture identity chain (test:literals)
const sign = (r) => attachAttestation(r, { sign: (message) => acct.signMessage({ message }), ...IDENT });
const base = (code) => ({ [`code@${SUBJ}`]: code, [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD, ["call@0x8da5cb5b"]: word(OWNER), [`code@${OWNER}`]: "0x" });
const UPG = codeWith(["upgradeTo(address)", "setFee(uint256)"]);

const rUpgradeable = await sign(await analyze(SUBJ, { client: mockClient(base(UPG)) }));        // upgradeable present, block 1000
const rNoUpgrade = await sign(await analyze(SUBJ, { client: mockClient(base(codeWith(["setFee(uint256)"]))) }));
const rPowersUnchecked = await sign(await analyze(SUBJ, { client: mockClient({ ...base(UPG),
  [`slot@${EIP1967_IMPL_SLOT}`]: word(IMPL), [`code@${IMPL.toLowerCase()}`]: transientThrow }) }));
const rOwnerUnread = await sign(await analyze(SUBJ, { client: mockClient({ ...base(UPG), ["call@0x8da5cb5b"]: transientThrow }) }));
const rUnsigned = await analyze(SUBJ, { client: mockClient(base(UPG)) });
const rRefusal = await sign(await analyze(SUBJ, { client: mockClient({ [`code@${SUBJ}`]: transientThrow }) }));

// The chain id comes from the mock chain's own report, never a literal here (test:literals).
const VAULT = { address: SUBJ, chainId: rUpgradeable.subject.chainId };
const HASH = "0x" + "ab".repeat(32);
const ANCHOR = { blockNumber: 1005, blockHash: HASH };
const OTHER_OWNER = "0x5555555555555555555555555555555555555555";

// ── fixtures: our own state reads, one per endpoint, pinned to the anchor ──────────────────────
const reading = (endpoint, over = {}) => ({
  endpoint, blockHash: HASH,
  exitFee: { declaredBps: 10, measuredBps: 10 },
  depositFeeBps: 0,
  redemption: { state: "full", positionShares: "1000000" },
  ...over,
});
const A = "https://a.example", B = "https://b.example"; // two distinct endpoints; the names are labels
const twoReads = (overA = {}, overB = overA) => [reading(A, overA), reading(B, overB)];

const RULES = [
  { id: "r-upg", kind: "power", subject: "upgradeable", onFinding: ON_FINDING.EXIT },
  { id: "r-owner", kind: "state", subject: "owner-changed", baselineOwner: OWNER, onFinding: ON_FINDING.PAUSE },
  { id: "r-exitfee", kind: "state", subject: "exit-fee-above", limitBps: 50, onFinding: ON_FINDING.EXIT },
  { id: "r-depfee", kind: "state", subject: "deposit-fee-above", limitBps: 0, onFinding: ON_FINDING.PAUSE },
  { id: "r-redeem", kind: "state", subject: "redemption-restricted", onFinding: ON_FINDING.PAUSE },
];
const observe = (over = {}) => attempt(() => observeMandateCheck({
  rules: RULES, vault: VAULT, anchor: ANCHOR, maxReportAgeBlocks: 20,
  report: rNoUpgrade, stateReadings: twoReads(), ...over,
}));
const obs = (res, id) => res?.observations?.[id];
const isOut = (o) => o?.status === OBSERVED.UNESTABLISHED && o?.cause === CAUSE.OUTAGE;
const isInc = (o) => o?.status === OBSERVED.UNESTABLISHED && o?.cause === CAUSE.INCONCLUSIVE;
const show = (o) => JSON.stringify(o ?? null)?.slice(0, 160);

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  VAULT MANDATE — observing: a failure to read is never a finding     ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("0 — the baseline: a clean check observes every rule CLEAR");
{
  const r = observe();
  ok("no whole-check outage", r?.outage === null, show(r?.outage ?? r?.threw));
  ok("every rule has an observation, and every one is clear",
    RULES.every((x) => obs(r, x.id)?.status === OBSERVED.CLEAR), RULES.map((x) => `${x.id}:${obs(r, x.id)?.status}`).join(" "));
  ok("the quorum is two independent reads", STATE_READ_QUORUM === 2);
  ok("⭐ the decider, fed this, allows the deposit", attempt(() => decideMandateAction({ rules: RULES, check: r }))?.action === ACTION.DEPOSIT);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — the report must be usable, or the rules it serves are OUTAGE");
{
  const reportRules = ["r-upg", "r-owner"], stateRules = ["r-exitfee", "r-depfee", "r-redeem"];
  const cases = [
    ["no report at all", null],
    ["an UNSIGNED report (attestation.status 'unsigned')", rUnsigned],
    ["a REFUSAL report", rRefusal],
    ["a report about a DIFFERENT address", { ...rUpgradeable, subject: { ...rUpgradeable.subject, address: OTHER_OWNER } }],
    ["a report on a DIFFERENT chain", { ...rUpgradeable, subject: { ...rUpgradeable.subject, chainId: 1 } }],
    ["a STALE report (older than maxReportAgeBlocks)", rUpgradeable, { anchor: { blockNumber: 1021, blockHash: HASH } }],
    ["a report from AFTER the anchor block", rUpgradeable, { anchor: { blockNumber: 999, blockHash: HASH } }],
  ];
  for (const [label, report, extra = {}] of cases) {
    const r = observe({ report, ...extra });
    ok(`${label} → power + owner rules OUTAGE, never violated`,
      reportRules.every((id) => isOut(obs(r, id))), reportRules.map((id) => show(obs(r, id))).join(" | "));
  }
  const r = observe({ report: rUnsigned });
  ok("⭐ …and the STATE rules are still evaluated (one source down does not blank the other)",
    stateRules.every((id) => obs(r, id)?.status === OBSERVED.CLEAR), stateRules.map((id) => obs(r, id)?.status).join(" "));
  ok("  …and it is not a whole-check outage", r?.outage === null);
  ok("  the OUTAGE says why (unsigned)", /unsigned|not signed/i.test(obs(r, "r-upg")?.why ?? ""), obs(r, "r-upg")?.why);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — power rules: from the signed report, through evaluatePolicy");
{
  const v = observe({ report: rUpgradeable });
  ok("upgradeTo present → r-upg VIOLATED", obs(v, "r-upg")?.status === OBSERVED.VIOLATED, show(obs(v, "r-upg")));
  const ev = obs(v, "r-upg")?.evidence;
  ok("  the evidence is the SIGNED report's: source dd-report, signed, at the report's block",
    ev?.source === "dd-report" && ev?.signed === true && ev?.reportBlock === 1000, show(ev));
  ok("  …and it names what matched", Array.isArray(ev?.matched) && ev.matched.some((m) => m?.signature === "upgradeTo(address)"), show(ev?.matched));

  const c = observe({ report: rNoUpgrade });
  ok("no upgradeTo selector → r-upg CLEAR", obs(c, "r-upg")?.status === OBSERVED.CLEAR);

  const u = observe({ report: rPowersUnchecked });
  ok("⭐⭐ a group the report could NOT check → INCONCLUSIVE, never clear, never outage",
    isInc(obs(u, "r-upg")), show(obs(u, "r-upg")));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — owner-changed: from the signed report's owner");
{
  const same = observe({ report: rNoUpgrade });
  ok("same owner as the baseline → CLEAR", obs(same, "r-owner")?.status === OBSERVED.CLEAR);
  const lower = observe({ rules: RULES.map((r) => r.id === "r-owner" ? { ...r, baselineOwner: OWNER.toUpperCase().replace("0X", "0x") } : r) });
  ok("the comparison ignores address case", obs(lower, "r-owner")?.status === OBSERVED.CLEAR, show(obs(lower, "r-owner")));

  const moved = observe({ rules: RULES.map((r) => r.id === "r-owner" ? { ...r, baselineOwner: OTHER_OWNER } : r) });
  ok("a different owner → VIOLATED", obs(moved, "r-owner")?.status === OBSERVED.VIOLATED, show(obs(moved, "r-owner")));
  const ev = obs(moved, "r-owner")?.evidence;
  ok("  the evidence carries both addresses and says it is signed",
    ev?.baselineOwner === OTHER_OWNER && ev?.observedOwner?.toLowerCase() === OWNER.toLowerCase() && ev?.signed === true, show(ev));

  const unread = observe({ report: rOwnerUnread });
  ok("⭐⭐ owner() UNREADABLE → INCONCLUSIVE, never 'unchanged', never 'changed'",
    isInc(obs(unread, "r-owner")), show(obs(unread, "r-owner")));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — state rules need two independent reads at the anchor block");
{
  const stateRules = ["r-exitfee", "r-depfee", "r-redeem"];
  const allOut = (r) => stateRules.every((id) => isOut(obs(r, id)));
  const one = observe({ stateReadings: [reading(A, { exitFee: { declaredBps: 900, measuredBps: 900 } })] });
  ok("⭐ ONE reading (even one that shows a fee far over the limit) → OUTAGE, not a finding", allOut(one), show(obs(one, "r-exitfee")));
  ok("two readings from the SAME endpoint → OUTAGE", allOut(observe({ stateReadings: [reading(A), reading(A)] })));
  ok("a reading at a DIFFERENT block hash than the anchor → OUTAGE (a provider served another block)",
    allOut(observe({ stateReadings: [reading(A), reading(B, { blockHash: "0x" + "cd".repeat(32) })] })));
  ok("no readings → OUTAGE", allOut(observe({ stateReadings: [] })));
  ok("readings not an array → OUTAGE", allOut(observe({ stateReadings: null })));
  ok("a reading marked ok:false does not count toward the quorum",
    allOut(observe({ stateReadings: [reading(A), { ...reading(B), ok: false }] })));
  const r = observe({ report: rUnsigned, stateReadings: [reading(A)] });
  ok("⭐ …and the report rules are unaffected by the state quorum",
    obs(r, "r-upg") && isOut(obs(r, "r-upg")) && /unsigned|not signed/i.test(obs(r, "r-upg").why ?? ""));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — fee rules: established, agreed, then compared");
{
  const fee = (d, m) => ({ exitFee: { declaredBps: d, measuredBps: m } });
  const over = observe({ stateReadings: twoReads(fee(200, 200)) });
  ok("both endpoints agree the exit fee is 200 bps, limit 50 → VIOLATED", obs(over, "r-exitfee")?.status === OBSERVED.VIOLATED, show(obs(over, "r-exitfee")));
  const ev = obs(over, "r-exitfee")?.evidence;
  ok("  the evidence is OUR read, marked unsigned, with the value, the limit, both endpoints and the block",
    ev?.source === "tikpema-read" && ev?.signed === false && ev?.valueBps === 200 && ev?.limitBps === 50 &&
    ev?.blockHash === HASH && ev?.endpoints?.length === 2, show(ev));

  ok("exactly AT the limit → CLEAR (the rule is 'above')", obs(observe({ stateReadings: twoReads(fee(50, 50)) }), "r-exitfee")?.status === OBSERVED.CLEAR);
  ok("⭐ the two endpoints DISAGREE → INCONCLUSIVE",
    isInc(obs(observe({ stateReadings: [reading(A, fee(200, 200)), reading(B, fee(10, 10))] }), "r-exitfee")));
  ok("⭐ the vault DECLARES 10 but its own preview MEASURES 300 → INCONCLUSIVE, not either figure",
    isInc(obs(observe({ stateReadings: twoReads(fee(10, 300)) }), "r-exitfee")));
  ok("declared and measured within 1 bp → agreed (rounding)",
    obs(observe({ stateReadings: twoReads(fee(100, 99)) }), "r-exitfee")?.status === OBSERVED.VIOLATED);
  ok("only the measured figure → it is used", obs(observe({ stateReadings: twoReads(fee(null, 200)) }), "r-exitfee")?.status === OBSERVED.VIOLATED);
  ok("only the declared figure → it is used", obs(observe({ stateReadings: twoReads(fee(200, null)) }), "r-exitfee")?.status === OBSERVED.VIOLATED);
  ok("⭐ NEITHER figure → INCONCLUSIVE, never a fee of zero",
    isInc(obs(observe({ stateReadings: twoReads(fee(null, null)) }), "r-exitfee")));

  ok("deposit fee 5 bps, limit 0 → VIOLATED", obs(observe({ stateReadings: twoReads({ depositFeeBps: 5 }) }), "r-depfee")?.status === OBSERVED.VIOLATED);
  ok("deposit fee null → INCONCLUSIVE", isInc(obs(observe({ stateReadings: twoReads({ depositFeeBps: null }) }), "r-depfee")));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — redemption-restricted");
{
  const red = (state, positionShares = "1000000") => ({ redemption: { state, positionShares } });
  ok("partial → VIOLATED", obs(observe({ stateReadings: twoReads(red("partial")) }), "r-redeem")?.status === OBSERVED.VIOLATED);
  ok("blocked → VIOLATED", obs(observe({ stateReadings: twoReads(red("blocked")) }), "r-redeem")?.status === OBSERVED.VIOLATED);
  ok("⭐ unknown → INCONCLUSIVE, never blocked, never full", isInc(obs(observe({ stateReadings: twoReads(red("unknown")) }), "r-redeem")));
  ok("an unrecognised state string → INCONCLUSIVE", isInc(obs(observe({ stateReadings: twoReads(red("paused")) }), "r-redeem")));
  ok("endpoints disagree (full vs blocked) → INCONCLUSIVE",
    isInc(obs(observe({ stateReadings: [reading(A, red("full")), reading(B, red("blocked"))] }), "r-redeem")));
  const none = obs(observe({ stateReadings: twoReads(red("full", "0")) }), "r-redeem");
  ok("no position yet → CLEAR, and the evidence SAYS there was nothing to restrict",
    none?.status === OBSERVED.CLEAR && /no position/i.test(none?.evidence?.note ?? ""), show(none));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — ⭐⭐ end to end through the decider");
{
  const feeUp = [reading(A, { exitFee: { declaredBps: 2000, measuredBps: 2000 } }), reading(B, { exitFee: { declaredBps: 2000, measuredBps: 2000 } })];
  const d1 = attempt(() => decideMandateAction({ rules: RULES, check: observeMandateCheck({
    rules: RULES, vault: VAULT, anchor: ANCHOR, maxReportAgeBlocks: 20, report: rUnsigned, stateReadings: feeUp }) }));
  ok("⭐ DD report unsigned + a fee rise two endpoints agree on (exit rule) → EXIT; the down engine does not veto",
    d1?.action === ACTION.EXIT && d1.exitFindings?.[0]?.ruleId === "r-exitfee", `${d1?.action} ${JSON.stringify(d1?.flags ?? d1?.threw)}`);
  ok("  …flagged FINDING and OUTAGE, deposit blocked", d1?.flags?.includes(FLAG.FINDING) && d1?.flags?.includes(FLAG.OUTAGE) && d1?.depositAllowed === false);

  const d2 = attempt(() => decideMandateAction({ rules: RULES, check: observeMandateCheck({
    rules: RULES, vault: VAULT, anchor: ANCHOR, maxReportAgeBlocks: 20, report: rUpgradeable, stateReadings: [reading(A)] }) }));
  ok("⭐ a signed upgradeable finding (exit rule) + the fee reads short of quorum → EXIT",
    d2?.action === ACTION.EXIT && d2.exitFindings?.[0]?.ruleId === "r-upg", `${d2?.action} ${JSON.stringify(d2?.flags ?? d2?.threw)}`);

  const d3 = attempt(() => decideMandateAction({ rules: RULES, check: observeMandateCheck({
    rules: RULES, vault: VAULT, anchor: ANCHOR, maxReportAgeBlocks: 20, report: rRefusal, stateReadings: [reading(A)] }) }));
  ok("⭐⭐ EVERYTHING unreadable, with exit rules set → PAUSE, never EXIT", d3?.action === ACTION.PAUSE && d3?.exitFindings?.length === 0,
    `${d3?.action} ${JSON.stringify(d3?.flags ?? d3?.threw)}`);

  const d4 = attempt(() => decideMandateAction({ rules: RULES, check: observeMandateCheck({
    rules: RULES, vault: VAULT, anchor: ANCHOR, maxReportAgeBlocks: 20, report: rPowersUnchecked,
    stateReadings: [reading(A, { exitFee: { declaredBps: 10, measuredBps: 300 } }), reading(B, { exitFee: { declaredBps: 10, measuredBps: 300 } })] }) }));
  ok("everything INCONCLUSIVE (power unchecked, fee instruments disagree) → PAUSE flagged INCONCLUSIVE",
    d4?.action === ACTION.PAUSE && d4?.flags?.includes(FLAG.INCONCLUSIVE), `${d4?.action} ${JSON.stringify(d4?.flags ?? d4?.threw)}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("8 — a malformed call is a whole-check outage, never observations");
{
  const whole = (label, over) => {
    const r = observe(over);
    ok(label, r?.outage && typeof r.outage.reason === "string", show(r?.outage ?? r?.threw));
  };
  whole("no anchor → outage", { anchor: undefined });
  whole("an anchor without a blockHash → outage", { anchor: { blockNumber: 1005 } });
  whole("maxReportAgeBlocks missing → outage (no default staleness)", { maxReportAgeBlocks: undefined });
  whole("no vault → outage", { vault: undefined });
  const r = observe({ anchor: undefined, report: rUpgradeable });
  ok("  …and a whole-check outage carries NO violated observation", !Object.values(r?.observations ?? {}).some((o) => o?.status === OBSERVED.VIOLATED));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
