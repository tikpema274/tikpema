#!/usr/bin/env node
// verify-vault-mandate-decide.mjs — the vault mandate's decision core, and the shapes that withdraw wrongly.
//
//   node scripts/verify-vault-mandate-decide.mjs
//
// ═══ THE RULE UNDER TEST ═════════════════════════════════════════════════════════════════════
// EXIT ON A FINDING, NEVER ON A FAILURE TO READ (T, 2026-09-25).
//   · A check that could not establish something (OUTAGE or INCONCLUSIVE) blocks deposits and
//     pauses the mandate. It must NEVER withdraw.
//   · A check that succeeded and found a state or power the user's rule refuses MAY withdraw, if the
//     user chose "exit" for that rule rather than "pause".
//
// ⭐ WHERE A DECIDER LIKE THIS GOES WRONG IS BY WITHDRAWING ON NOTHING. A decider that counts every
// rule that did not come back "clear" as failed will exit on an RPC outage. That is a withdrawal the
// user never ordered, paid at a fee the vault sets, caused by our own instrument. Most fixtures below
// are shapes where "not clear" must NOT mean "found":
//   · every rule set to exit, every observation unestablished        → pause, never exit
//   · an observation missing for a rule                              → outage, never a finding
//   · an unrecognised status string                                  → outage, never a finding
//   · "violated" with no evidence attached                           → not a finding
//   · the whole check an outage, while observations say "violated"   → the outage wins
//   · a malformed rule set whose observations say "violated"+exit    → pause, never exit
//
// ⚠️ PURE. No chain, no store, no clock, no mocks: the unit under test is the only code that runs.

import {
  decideMandateAction, validateMandateRules,
  ON_FINDING, OBSERVED, CAUSE, ACTION, FLAG, STATE_RULES, MANDATE_CEILING,
} from "../shared/vault-mandate/decide.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
// A body that throws is a failed assertion, not a crashed suite: the red state must be COUNTED.
const attempt = (fn) => { try { return fn(); } catch (e) { return { threw: String(e?.message ?? e) }; } };

const OWNER_A = "0x1111111111111111111111111111111111111111";
const EV = (what) => ({ reading: what, block: 63900000, source: "fixture" });

// A rule set T could plausibly write: refuse upgradeability (exit), exit if the exit fee passes
// 0.5%, pause on an owner change, pause on restricted redemption.
const RULES = [
  { id: "r-upg", kind: "power", subject: "upgradeable", onFinding: ON_FINDING.EXIT },
  { id: "r-exitfee", kind: "state", subject: "exit-fee-above", limitBps: 50, onFinding: ON_FINDING.EXIT },
  { id: "r-owner", kind: "state", subject: "owner-changed", baselineOwner: OWNER_A, onFinding: ON_FINDING.PAUSE },
  { id: "r-redeem", kind: "state", subject: "redemption-restricted", onFinding: ON_FINDING.PAUSE },
];
const allClear = () => Object.fromEntries(RULES.map((r) => [r.id, { status: OBSERVED.CLEAR, evidence: EV("clear") }]));
const decide = (observations, { rules = RULES, check = {} } = {}) =>
  attempt(() => decideMandateAction({ rules, check: { observations, ...check } }));

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  VAULT MANDATE — exit on a finding, never on a failure to read       ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — the rule set: what the user wrote must be exactly what is enforced");
{
  const good = attempt(() => validateMandateRules(RULES));
  ok("a well-formed rule set validates", good?.ok === true, JSON.stringify(good?.errors ?? good?.threw ?? null));
  ok("the state-rule catalogue names the five scoped rules",
    ["exit-fee-above", "deposit-fee-above", "owner-changed", "redemption-restricted", "vault-cannot-pay"].every((k) => k in STATE_RULES));

  const refuses = (label, rules, needle) => {
    const v = attempt(() => validateMandateRules(rules));
    const msg = (v?.errors ?? []).join(" | ");
    ok(label, v?.ok === false && (!needle || msg.includes(needle)), msg || JSON.stringify(v));
  };
  refuses("not an array → refused", { r: RULES[0] });
  refuses("an EMPTY rule set → refused (a mandate with no rules evaluates nothing)", [], "no rules");
  refuses("a missing onFinding → refused, NOT defaulted (the creator writes the default explicitly)",
    [{ id: "x", kind: "power", subject: "upgradeable" }], "onFinding");
  refuses("an onFinding that is neither pause nor exit → refused",
    [{ id: "x", kind: "power", subject: "upgradeable", onFinding: "withdraw" }], "onFinding");
  refuses("a power group not in the catalogue → refused",
    [{ id: "x", kind: "power", subject: "upgradable", onFinding: "pause" }], "upgradable");
  refuses("a state rule not in the catalogue → refused",
    [{ id: "x", kind: "state", subject: "tvl-drop", onFinding: "pause" }], "tvl-drop");
  refuses("an unknown kind → refused", [{ id: "x", kind: "price", subject: "eurc", onFinding: "exit" }], "kind");
  refuses("a fee rule without limitBps → refused",
    [{ id: "x", kind: "state", subject: "exit-fee-above", onFinding: "exit" }], "limitBps");
  refuses("a fee rule with limitBps out of 0..10000 → refused",
    [{ id: "x", kind: "state", subject: "deposit-fee-above", limitBps: 20001, onFinding: "pause" }], "limitBps");
  refuses("a fractional limitBps → refused",
    [{ id: "x", kind: "state", subject: "exit-fee-above", limitBps: 12.5, onFinding: "pause" }], "limitBps");
  refuses("owner-changed without a baselineOwner → refused (a change from WHAT?)",
    [{ id: "x", kind: "state", subject: "owner-changed", onFinding: "pause" }], "baselineOwner");
  refuses("two rules on the same subject → refused (which one wins is not the user's statement)",
    [RULES[0], { ...RULES[0], id: "r-upg-2", onFinding: "pause" }], "upgradeable");
  refuses("two rules with the same id → refused",
    [RULES[0], { ...RULES[1], id: "r-upg" }], "r-upg");
  refuses("⭐ exit on redemption-restricted → refused in v1 (a restricted exit cannot promise an exit)",
    [{ id: "x", kind: "state", subject: "redemption-restricted", onFinding: "exit" }], "redemption-restricted");
  refuses("a market/price rule cannot be expressed — no view on markets",
    [{ id: "x", kind: "state", subject: "eurc-below", limitBps: 9800, onFinding: "exit" }], "eurc-below");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⭐⭐ A FAILURE TO READ NEVER WITHDRAWS");
{
  const exitAll = RULES.filter((r) => r.subject !== "redemption-restricted").map((r) => ({ ...r, onFinding: ON_FINDING.EXIT }));
  const unest = (cause) => Object.fromEntries(exitAll.map((r) => [r.id, { status: OBSERVED.UNESTABLISHED, cause }]));

  const outage = decide(unest(CAUSE.OUTAGE), { rules: exitAll });
  ok("every rule is EXIT, every observation an OUTAGE → PAUSE", outage?.action === ACTION.PAUSE, outage?.action ?? outage?.threw);
  ok("  … flagged OUTAGE (retry), not INCONCLUSIVE", outage?.flags?.includes(FLAG.OUTAGE) && !outage?.flags?.includes(FLAG.INCONCLUSIVE), JSON.stringify(outage?.flags));
  ok("  … no exit findings", Array.isArray(outage?.exitFindings) && outage.exitFindings.length === 0);

  const inc = decide(unest(CAUSE.INCONCLUSIVE), { rules: exitAll });
  ok("every rule is EXIT, every observation INCONCLUSIVE → PAUSE", inc?.action === ACTION.PAUSE, inc?.action ?? inc?.threw);
  ok("  … flagged INCONCLUSIVE", inc?.flags?.includes(FLAG.INCONCLUSIVE) && !inc?.flags?.includes(FLAG.OUTAGE), JSON.stringify(inc?.flags));

  const noCause = decide(Object.fromEntries(exitAll.map((r) => [r.id, { status: OBSERVED.UNESTABLISHED }])), { rules: exitAll });
  ok("unestablished with NO cause → OUTAGE (our instrument did not say why)", noCause?.action === ACTION.PAUSE && noCause?.flags?.includes(FLAG.OUTAGE), JSON.stringify(noCause?.flags ?? noCause?.threw));

  const missing = allClear(); delete missing["r-upg"];
  const m = decide(missing);
  ok("an observation MISSING for a rule → PAUSE, not deposit", m?.action === ACTION.PAUSE, m?.action ?? m?.threw);
  ok("  … the missing rule is listed as unestablished/outage, not clear",
    m?.unestablished?.some((u) => u.ruleId === "r-upg" && u.cause === CAUSE.OUTAGE), JSON.stringify(m?.unestablished));

  const junk = { ...allClear(), "r-upg": { status: "present", evidence: EV("upgradeTo found") } };
  const j = decide(junk);
  ok("an unrecognised status string ('present') → OUTAGE, never a finding",
    j?.action === ACTION.PAUSE && j?.exitFindings?.length === 0 && j?.flags?.includes(FLAG.OUTAGE), `${j?.action} ${JSON.stringify(j?.flags)}`);

  const bare = { ...allClear(), "r-upg": { status: OBSERVED.VIOLATED } };
  const b = decide(bare);
  ok("'violated' with NO evidence → not a finding (nothing to show the user, nothing to exit on)",
    b?.action === ACTION.PAUSE && b?.exitFindings?.length === 0, `${b?.action} exit=${b?.exitFindings?.length}`);

  const lying = Object.fromEntries(RULES.map((r) => [r.id, { status: OBSERVED.VIOLATED, evidence: EV("x") }]));
  const o = decide(lying, { check: { outage: { reason: "dd-engine-refused" } } });
  ok("⭐ the WHOLE check is an outage, observations say violated+exit → the outage wins, PAUSE",
    o?.action === ACTION.PAUSE && o?.exitFindings?.length === 0, `${o?.action} exit=${o?.exitFindings?.length}`);
  ok("  … flagged OUTAGE, and no FINDING is claimed from an outage",
    o?.flags?.includes(FLAG.OUTAGE) && !o?.flags?.includes(FLAG.FINDING), JSON.stringify(o?.flags));

  const notObj = decide(null);
  ok("observations not an object at all → PAUSE/OUTAGE", notObj?.action === ACTION.PAUSE && notObj?.flags?.includes(FLAG.OUTAGE), JSON.stringify(notObj?.flags ?? notObj?.threw));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — a finding, and the user's pause/exit choice for that rule");
{
  const pauseFind = decide({ ...allClear(), "r-owner": { status: OBSERVED.VIOLATED, evidence: EV("owner 0x22…") } });
  ok("a finding on a PAUSE rule → PAUSE", pauseFind?.action === ACTION.PAUSE, pauseFind?.action ?? pauseFind?.threw);
  ok("  … flagged FINDING", pauseFind?.flags?.includes(FLAG.FINDING), JSON.stringify(pauseFind?.flags));
  ok("  … the finding is listed with its evidence, and it is not an exit finding",
    pauseFind?.findings?.some((f) => f.ruleId === "r-owner" && f.evidence?.reading === "owner 0x22…") && pauseFind?.exitFindings?.length === 0);

  const exitFind = decide({ ...allClear(), "r-exitfee": { status: OBSERVED.VIOLATED, evidence: EV("withdrawFee 200 bps") } });
  ok("a finding on an EXIT rule → EXIT", exitFind?.action === ACTION.EXIT, exitFind?.action ?? exitFind?.threw);
  ok("  … the exit finding carries the rule and its evidence",
    exitFind?.exitFindings?.length === 1 && exitFind.exitFindings[0].ruleId === "r-exitfee" && exitFind.exitFindings[0].evidence?.reading === "withdrawFee 200 bps");
  ok("  … and the rule's own onFinding is echoed (the receipt names the user's choice)",
    exitFind?.exitFindings?.[0]?.onFinding === ON_FINDING.EXIT);

  // ⭐ An unreadable SIBLING does not veto a real finding. Otherwise the party being exited could
  // block every exit rule by making one unrelated getter revert.
  const mixed = decide({ ...allClear(),
    "r-upg": { status: OBSERVED.VIOLATED, evidence: EV("upgradeTo(address) selector") },
    "r-owner": { status: OBSERVED.UNESTABLISHED, cause: CAUSE.INCONCLUSIVE } });
  ok("⭐ an EXIT finding + an unreadable sibling → EXIT (a revert the vault controls cannot veto the exit)",
    mixed?.action === ACTION.EXIT, mixed?.action ?? mixed?.threw);
  ok("  … both are reported: FINDING and INCONCLUSIVE", mixed?.flags?.includes(FLAG.FINDING) && mixed?.flags?.includes(FLAG.INCONCLUSIVE), JSON.stringify(mixed?.flags));
  ok("  … the exit is justified ONLY by the finding (the unreadable rule is not in exitFindings)",
    mixed?.exitFindings?.length === 1 && mixed.exitFindings[0].ruleId === "r-upg");

  const both = decide({ ...allClear(),
    "r-owner": { status: OBSERVED.VIOLATED, evidence: EV("owner changed") },
    "r-exitfee": { status: OBSERVED.VIOLATED, evidence: EV("fee 300") } });
  ok("a pause finding + an exit finding → EXIT (the user ordered an exit for one of them)", both?.action === ACTION.EXIT);
  ok("  … both findings listed, only one is an exit finding", both?.findings?.length === 2 && both?.exitFindings?.length === 1);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — deposits: allowed only when every rule was established clear");
{
  const c = decide(allClear());
  ok("all clear → DEPOSIT", c?.action === ACTION.DEPOSIT, c?.action ?? c?.threw);
  ok("  … depositAllowed true, no flags", c?.depositAllowed === true && c?.flags?.length === 0);
  ok("  … the ceiling rides on the result (a clear is not a clearance)",
    typeof c?.ceiling === "string" && c.ceiling.length > 0 && c.ceiling === MANDATE_CEILING);
  ok("  … and the ceiling never says 'safe' as a claim", /never that/i.test(MANDATE_CEILING) && !/\bis safe\b/i.test(MANDATE_CEILING.replace(/never that[^.]*/i, "")));

  const cases = [
    decide({ ...allClear(), "r-owner": { status: OBSERVED.VIOLATED, evidence: EV("x") } }),
    decide({ ...allClear(), "r-exitfee": { status: OBSERVED.VIOLATED, evidence: EV("x") } }),
    decide({ ...allClear(), "r-upg": { status: OBSERVED.UNESTABLISHED, cause: CAUSE.OUTAGE } }),
    decide({ ...allClear(), "r-upg": { status: OBSERVED.UNESTABLISHED, cause: CAUSE.INCONCLUSIVE } }),
  ];
  ok("every non-DEPOSIT action carries depositAllowed === false (not undefined)",
    cases.every((r) => r?.action !== ACTION.DEPOSIT && r?.depositAllowed === false), cases.map((r) => `${r?.action}/${r?.depositAllowed}`).join(" "));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — a malformed rule set never moves money");
{
  const bad = [{ id: "x", kind: "power", subject: "upgradeable", onFinding: "withdraw-all" }];
  const r = decide({ x: { status: OBSERVED.VIOLATED, evidence: EV("upgradeTo") } }, { rules: bad });
  ok("malformed rules + a 'violated' observation → PAUSE, never EXIT", r?.action === ACTION.PAUSE, r?.action ?? r?.threw);
  ok("  … flagged MALFORMED, depositAllowed false", r?.flags?.includes(FLAG.MALFORMED) && r?.depositAllowed === false, JSON.stringify(r?.flags));

  const empty = decide({}, { rules: [] });
  ok("an empty rule set → PAUSE/MALFORMED, not DEPOSIT (vacuous truth is not a pass)",
    empty?.action === ACTION.PAUSE && empty?.flags?.includes(FLAG.MALFORMED), `${empty?.action} ${JSON.stringify(empty?.flags)}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — the decider does not mutate what it was handed");
{
  const rules = JSON.parse(JSON.stringify(RULES));
  const obs = { ...allClear(), "r-exitfee": { status: OBSERVED.VIOLATED, evidence: EV("fee") } };
  const before = JSON.stringify({ rules, obs });
  decide(obs, { rules });
  ok("rules and observations are unchanged after a decision", JSON.stringify({ rules, obs }) === before);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
