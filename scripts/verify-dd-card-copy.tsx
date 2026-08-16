// verify-dd-card-copy.tsx — WHAT THE DD CARD ACTUALLY SAYS, rendered.
//
//   npx tsx scripts/verify-dd-card-copy.tsx        (also: npm run test:ddcopy)
//
// ═══ ⭐⭐ WHY RENDERED AND NOT GREPPED ═══════════════════════════════════════════════════════
// Every claim this suite makes is about what a HUMAN READS, and none of them survive a source
// regex. The load-bearing one is a pair of numbers:
//
//     policy.coverage        = 9 of 9   POWER GROUPS      ← the threshold applies to THIS
//     report.coverage.totals = 13       CHECKS RUN        ← it does NOT apply to this
//
// Both are correct. Both arrive in ONE response. Both are called "coverage" by their own schema.
// ⚠️ A reader who takes the threshold to apply to 13 concludes the rules demanded far less of the
// catalogue than they did. That confusion is created by LAYOUT AND WORDING — adjacency, labels,
// which sentence sits under which number — and layout is exactly what a regex cannot see.
//
// ⭐ SO THE ASSERTIONS ARE ON TEXT CONTENT AND ON ORDER: the labels must differ, the threshold
// sentence must sit with the power-group number, and the disclaimer must sit with the other.
//
// ⚠️ PRESENT AND ABSENT ARE DIFFERENT CHECKS. A new sentence appearing does not mean an old
// falsehood left — both directions are asserted.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DdReportResult } from "../src/components/DdReportCard";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 64 - t.length))}`);

// ── the real shape, taken from the PROD response the owner ran on 2026-08-16 ──────────────────
const CEILING =
  "no-clearance: a pass means NOTHING WAS FOUND AGAINST YOUR RULES — never that this contract is safe. " +
  "Powers are detected by selector presence, and absence of a selector is not proof the power is absent; " +
  "the rules are yours and cover nine catalogue groups, not every way a contract can take your funds.";

const baseReport = (over: any = {}) => ({
  subject: { address: "0x240eb8", chainId: 5042002, blockNumber: 57256125 },
  powersPresent: ["emergencyWithdraw", "feesSettable"],
  // ⭐ 13 CHECKS — the nine power groups plus shape detection and the owner reads. The number that
  // must NOT look like it is what the threshold measures.
  coverage: { totals: { checked: 13, notChecked: 0 } },
  sources: { mode: "quorum", quorum: { required: 2, configured: 2 }, integrity: { providerDisagreement: false } },
  attestation: { status: "signed" },
  refusal: null,
  ...over,
});
const basePolicy = (over: any = {}) => ({
  passes: false,
  reason: "power-present",
  ceiling: CEILING,
  authority: "display-only",
  // ⭐ 9 POWER GROUPS — the number the threshold DOES measure.
  coverage: { checked: 9, total: 9, threshold: 9, meets: true },
  evaluated: ["upgradeable", "emergencyWithdraw"],
  failures: [
    { group: "emergencyWithdraw", scope: "fund-removal", reason: "power-present", detail: 'your rule refuses "emergencyWithdraw", and this contract has it.' },
    { group: "feesSettable", scope: "economics", reason: "power-present", detail: 'your rule refuses "feesSettable", and this contract has it.' },
  ],
  unreadableFailures: [],
  detail: "2 power(s) you refuse are present",
  ...over,
});

/** ⭐ The REAL render path — `DdReportResult` is what the card itself draws, not a test shim. */
function renderWith(data: any) {
  return renderToStaticMarkup(React.createElement(DdReportResult, { data }));
}
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/\s+/g, " ").trim();

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("A 🚨 THE TWO COVERAGE NUMBERS ARE LABELLED DISTINCTLY");
{
  const html = renderWith({ report: baseReport(), policy: basePolicy(), verifiability: { attestation: "signed" } });
  const t = text(html);

  check("both numbers actually render", /9 of 9/.test(t) && /13 of 13/.test(t), t.match(/\d+ of \d+/g)?.join(" | "));
  check("🚨🚨 they do NOT share the label 'coverage'",
    !/coverage/i.test(t), (t.match(/[Cc]overage[^.]{0,30}/) || ["(absent — good)"])[0]);
  check("⭐ the power-group number is labelled POWER GROUPS", /Power groups checked/i.test(t));
  check("⭐ the check number is labelled CHECKS RUN", /Individual checks run/i.test(t));

  // ⭐⭐ ORDER IS THE CLAIM. The threshold sentence must sit with 9-of-9, and the disclaimer with
  // 13 — a regex on either sentence alone would pass with them swapped, which is the confusion.
  const iGroups = t.indexOf("Power groups checked");
  const iThresh = t.indexOf("Your threshold is");
  const iChecks = t.indexOf("Individual checks run");
  const iDisc = t.indexOf("Your threshold does not apply to this number");
  check("⭐⭐ the threshold sentence sits UNDER the power-group number, not the check count",
    iGroups >= 0 && iThresh > iGroups && iThresh < iChecks, `groups@${iGroups} thresh@${iThresh} checks@${iChecks}`);
  check("⭐⭐ …and the 'does not apply' disclaimer sits under the CHECK count",
    iChecks >= 0 && iDisc > iChecks, `checks@${iChecks} disclaimer@${iDisc}`);
  check("⭐ the threshold value and whether it was met are both stated",
    /Your threshold is 9/.test(t) && /met\./.test(t));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("B 🚨 THE CEILING RENDERS VERBATIM — no friendlier paraphrase");
{
  const t = text(renderWith({ report: baseReport(), policy: basePolicy({ passes: true, reason: null, failures: [], detail: "every rule you set was evaluated" }) }));
  // ⚠️ SCOPED TO THE VERDICT REGION, and the first version of this check was WRONG in an instructive
  // way: it asserted "safe" appears nowhere, and went red — because POLICY_CEILING itself contains
  // "never that this contract is safe", which is the sentence we most want rendered. A blanket ban
  // on a word would have forced the ceiling to be trimmed to satisfy a test guarding the ceiling.
  // ⭐ The real claim is narrower and truer: the VERDICT must not say it; the ceiling must.
  const ceilingAt = t.indexOf("no-clearance:");
  const verdictRegion = ceilingAt > 0 ? t.slice(0, ceilingAt) : t;
  check("🚨🚨 the VERDICT region never uses the word 'safe'", !/\bsafe\b/i.test(verdictRegion),
    (verdictRegion.match(/.{0,40}safe.{0,40}/i) || ["(absent — good)"])[0]);
  check("🚨 …while the ceiling DOES say it, in the only form allowed: a denial",
    /never that this contract is safe/.test(t));
  check("⭐⭐ …and says 'Nothing was found against your rules' instead",
    /Nothing was found against your rules/.test(t));
  check("🚨 the POLICY_CEILING string renders in full, not summarised",
    t.includes("never that this contract is safe") && t.includes("absence of a selector is not proof"));
  check("⭐ display-only authority is stated in words a user reads",
    /does not gate anything/i.test(t) && /rules supplied by this browser/i.test(t));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("C ⭐ THE TWO BUCKETS NEVER MERGE");
{
  const t = text(renderWith({
    report: baseReport(),
    policy: basePolicy({
      reason: "power-unreadable",
      failures: [{ group: "emergencyWithdraw", scope: "fund-removal", detail: "your rule refuses it, and this contract has it." }],
      unreadableFailures: [{ group: "upgradeable", reason: "power-unreadable", detail: "could not establish whether the power is present." }],
    }),
  }));
  check("⭐ present-power failures have their own heading", /Powers you refuse, and this contract has/.test(t));
  check("⭐⭐ unreadable ones have a DIFFERENT heading", /could NOT be established/i.test(t));
  check("🚨 …and the page says not-established is not absent",
    /Not established is not absent/i.test(t));
  const iHas = t.indexOf("and this contract has");
  const iNot = t.indexOf("could NOT be established");
  check("⭐ the two lists are separate regions, not one merged list", iHas >= 0 && iNot > iHas);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("D ⭐ A REFUSAL IS A RESULT, NOT AN EMPTY CARD");
{
  const t = text(renderWith({ report: baseReport({ refusal: { reason: "service-unverified", detail: "the detector is not known good" } }), policy: basePolicy() }));
  check("⭐⭐ a refusal renders as INDETERMINATE, never a blank or a pass",
    /INDETERMINATE, not a clean bill/.test(t));
  check("⭐ …and names the reason", /service-unverified/.test(t));
  check("🚨 …and does NOT also paint a verdict beside it",
    !/Nothing was found against your rules/.test(t));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("E 🚨 A PROVIDER SPLIT IS SHOWN AS A POSITIVE FINDING");
{
  const t = text(renderWith({
    report: baseReport({ sources: { mode: "quorum", quorum: { required: 2, configured: 2 }, integrity: { providerDisagreement: true } } }),
    policy: basePolicy(),
  }));
  check("🚨 a split renders a warning naming that a source served something false",
    /data sources disagreed/i.test(t) && /served something false/i.test(t));
  check("⭐ …and says it bears on EVERY line, not just one check",
    /every line above as unproven/i.test(t));

  const clean = text(renderWith({ report: baseReport(), policy: basePolicy() }));
  check("⭐ …and is SILENT when they agreed (present-and-absent, both asserted)",
    !/data sources disagreed/i.test(clean));
}

console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
