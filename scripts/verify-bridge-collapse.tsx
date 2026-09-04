#!/usr/bin/env node
// verify-bridge-collapse.tsx — WHICH ROWS MAY HIDE, AND WHAT THE SUMMARY LINE MAY CLAIM.
//
//   npx tsx scripts/verify-bridge-collapse.tsx   (also: npm run test:collapse)
//
// ═══ ⛔⛔ THE TWO PROPERTIES THIS DEFENDS ══════════════════════════════════════════════════════
//  1. THE PREDICATE IS A WHITELIST. Asserted BEHAVIOURALLY over the whole known state space PLUS
//     invented unknown states — not by grepping for a shape. A blacklist ("hide unless X") passes
//     any source check you can write and still hides a state added next year.
//  2. THE SUMMARY LINE IS BOUND TO THE PREDICATE, NOT PINNED AS TEXT. 🚨 On 2026-09-04 this repo
//     found a guard pinning an atomicity OVERCLAIM and, in the same section, pinning "No batched
//     burn has landed on chain" months after two had — green throughout. A guard that pins wording
//     either keeps it true or keeps it FROZEN. So nothing here asserts the sentence; it asserts that
//     the sentence is COMPOSED from the clauses, and fails if a clause appears without prose or
//     prose appears without a clause.

import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import {
  COLLAPSE_CLAUSES, matchesCollapsePredicate, partitionReceipts, collapseSummaryLine,
  receiptOrderKey, KNOWN_RECEIPT_STATES,
} from "../src/lib/bridgeReceiptCollapse";
import { BridgeReceiptStatus } from "../src/components/bridgeReceiptStatus";

let pass = 0, fail = 0;
const ok = (l: string, c: boolean, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
  return c;
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

/** A row that DOES collapse — every clause satisfied. Every case below is a delta from this. */
const collapsible = (over: any = {}) => ({
  burnHash: "0x" + "a".repeat(64), state: "minted", delivery: "measured",
  amountDelivered: 1, burnedAt: "2026-09-01T00:00:00.000Z", feeReconciliation: null, ...over,
});

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  bridge receipts collapse — a whitelist, and a line bound to it      ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("0 — THE BASELINE IS COLLAPSIBLE (or every negative below is vacuous)");
{
  // ⛔ WITHOUT THIS, EVERY "does not collapse" ASSERTION PASSES FOR FREE. A predicate that returned
  // false for everything would satisfy the entire rest of this file.
  ok("⭐⭐ the control row DOES collapse", matchesCollapsePredicate(collapsible() as any));
  const { shown, hidden } = partitionReceipts([
    collapsible({ burnHash: "0x" + "1".repeat(64), burnedAt: "2026-09-02T00:00:00.000Z" }),
    collapsible({ burnHash: "0x" + "2".repeat(64), burnedAt: "2026-09-01T00:00:00.000Z" }),
  ] as any);
  ok("⭐ and a two-row list splits 1 shown (newest) / 1 hidden", shown.length === 1 && hidden.length === 1);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 ⛔⛔ WHITELIST — over the WHOLE known state space, plus unknowns");
{
  // ⭐ EXHAUSTIVE over what the panel knows. Only `minted` may collapse; every other known state
  // renders, and nobody has to remember to add it here.
  for (const st of KNOWN_RECEIPT_STATES) {
    const r = collapsible({ state: st }) as any;
    const should = st === "minted";
    ok(`state "${st}" → ${should ? "collapsible" : "VISIBLE"}`, matchesCollapsePredicate(r) === should);
  }
  // 🚨 THE MUTATION THE REQUIREMENT NAMES: a state this file has never heard of.
  for (const st of ["burn_reorged", "clawed_back", "quarantined", "", "MINTED"]) {
    ok(`🚨 UNRECOGNISED state ${JSON.stringify(st)} → VISIBLE, never collapsed`,
      matchesCollapsePredicate(collapsible({ state: st }) as any) === false);
  }
  ok("⛔ a null state is visible", matchesCollapsePredicate(collapsible({ state: null }) as any) === false);
  ok("⛔ a missing state is visible", matchesCollapsePredicate({ burnHash: "0xabc", delivery: "measured", amountDelivered: 1 } as any) === false);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — NOT-YET-MEASURED NEVER COLLAPSES");
{
  ok("delivery predicted → visible", !matchesCollapsePredicate(collapsible({ delivery: "predicted" }) as any));
  ok("delivery missing → visible", !matchesCollapsePredicate(collapsible({ delivery: null }) as any));
  // ⭐ The panel's own defensive branch: measured with no amount is an anomaly, not an arrival.
  ok("⭐ measured with NO amountDelivered → visible (the anomaly branch)",
    !matchesCollapsePredicate(collapsible({ amountDelivered: null }) as any));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 ⭐⭐ THE MISMATCHED-VERDICT PROMOTION — pinned in BOTH directions");
{
  // ⛔ The load-bearing one. A minted+measured row with a mismatched fee verdict is fully arrived
  // and still carries a money-claim discrepancy. A state-only rule would bury it.
  ok("🚨 verdict `mismatched` → VISIBLE, even though minted + measured",
    !matchesCollapsePredicate(collapsible({ feeReconciliation: { verdict: "mismatched" } }) as any));
  // ⭐ AND THE OTHER DIRECTION, so the rule is not "any verdict shows the row".
  ok("⭐ verdict `matched` → still collapsible",
    matchesCollapsePredicate(collapsible({ feeReconciliation: { verdict: "matched" } }) as any));
  ok("⭐ verdict `unreadable` → still collapsible (an unread check is not a discrepancy)",
    matchesCollapsePredicate(collapsible({ feeReconciliation: { verdict: "unreadable" } }) as any));
  ok("⭐ NO verdict at all → still collapsible (the norm on every pre-migration receipt)",
    matchesCollapsePredicate(collapsible({ feeReconciliation: null }) as any));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ORDERING: newest by burnedAt ?? submittedAt, and NOTHING is hoisted");
{
  ok("burnedAt is the key when present", receiptOrderKey({ burnedAt: "2026-09-01T00:00:00Z" } as any) === Date.parse("2026-09-01T00:00:00Z"));
  ok("submittedAt is the key when there is no burnedAt", receiptOrderKey({ submittedAt: "2026-09-02T00:00:00Z" } as any) === Date.parse("2026-09-02T00:00:00Z"));
  ok("⛔ an undateable row has NO key", receiptOrderKey({} as any) === null);
  ok("⛔ …and an unparseable one has none either", receiptOrderKey({ burnedAt: "not a date" } as any) === null);
  ok("⛔⛔ an undateable row is therefore NEVER collapsed — provisionalStatus's precedent",
    partitionReceipts([
      collapsible({ burnHash: "0xnewest", burnedAt: "2026-09-03T00:00:00Z" }),
      collapsible({ burnHash: "0xundateable", burnedAt: null, submittedAt: null }),
    ] as any).hidden.length === 0);

  // ⭐ ORDER IS PRESERVED — the needs-review row stays where it sat.
  // 🚨 THE FIXTURE ORDER IS THE ASSERTION. A first draft put the needs-review row FIRST in the
  // input — where hoisting it is a no-op — and a mutation that sorted Tier A to the front was NOT
  // CAUGHT. The row must sit AFTER something for "not hoisted" to be falsifiable at all.
  // ⭐ A control has to be able to fail; an assertion whose fixture cannot express the defect is a
  // green tick over an untested property.
  const list = [
    collapsible({ burnHash: "0xold1", burnedAt: "2026-09-01T00:00:00Z" }),
    collapsible({ burnHash: "0xnewest", burnedAt: "2026-09-03T00:00:00Z" }),
    { txId: "tx-needs-you", state: "burn_submitted", delivery: "predicted", submittedAt: "2026-09-02T00:00:00Z" },
  ];
  const { shown } = partitionReceipts(list as any);
  ok("⭐⭐ Tier A is NOT hoisted — visual order is unchanged",
    shown.map((r: any) => r.burnHash ?? r.txId).join(",") === "0xnewest,tx-needs-you",
    shown.map((r: any) => r.burnHash ?? r.txId).join(","));
  ok("⭐ the newest row is shown whatever its state", shown.some((r: any) => r.burnHash === "0xnewest"));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 ⛔ DEGRADATION IS ALWAYS TOWARD SHOWING MORE");
{
  const rows = [collapsible({ burnHash: "0xa", burnedAt: "2026-09-01T00:00:00Z" }),
                collapsible({ burnHash: "0xb", burnedAt: "2026-09-02T00:00:00Z" }),
                collapsible({ burnHash: "0xc", burnedAt: "2026-09-03T00:00:00Z" })];
  ok("⛔ degraded read → NOTHING collapses", partitionReceipts(rows as any, { degraded: true }).hidden.length === 0);
  ok("  …and every row is shown", partitionReceipts(rows as any, { degraded: true }).shown.length === 3);
  ok("⭐ CONTROL — undegraded, the same rows DO collapse", partitionReceipts(rows as any).hidden.length === 2);
  // ⛔ The verdict-join fallback. See the module note: unreachable today because readFeeVerdict
  // collapses miss and store-error into null. The branch is defined and asserted anyway.
  ok("⛔ feeVerdictReadable:false → VISIBLE, not hidden on an unchecked claim",
    !matchesCollapsePredicate(collapsible({ feeVerdictReadable: false }) as any));
  ok("⭐ …and true / absent stay collapsible",
    matchesCollapsePredicate(collapsible({ feeVerdictReadable: true }) as any) &&
    matchesCollapsePredicate(collapsible({}) as any));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 ⭐⭐ THE SUMMARY LINE IS BOUND TO THE PREDICATE, NOT PINNED AS TEXT");
{
  // ⛔ NOTHING HERE ASSERTS THE SENTENCE. It asserts the DERIVATION.
  for (const c of COLLAPSE_CLAUSES) {
    ok(`clause "${c.id}" declares prose OR why it has none`,
      (typeof c.prose === "string" && c.prose.length > 0) ||
      (c.prose === null && typeof c.whyNoProse === "string" && c.whyNoProse.length > 20));
  }
  const line = collapseSummaryLine(14);
  const claims = COLLAPSE_CLAUSES.map((c) => c.prose).filter(Boolean) as string[];
  ok("⭐⭐ every claim-bearing clause appears in the line", claims.every((p) => line.includes(p)), `${claims.length} claims`);
  // ⭐ TOTALITY: the line is the count plus the claims and nothing else, so prose cannot be typed
  //   in without a clause to license it.
  const rebuilt = `14 earlier bridges — ${claims.join(", and ")}.`;
  ok("⭐⭐ …and the line is EXACTLY the composition — no wording added by hand", line === rebuilt, line);
  ok("⭐ the count and plural are the row's, not a literal",
    collapseSummaryLine(1).startsWith("1 earlier bridge —") && collapseSummaryLine(2).startsWith("2 earlier bridges —"));

  // ⛔ THE NEGATIVE THE REQUIREMENT NAMES: the hidden set carries no fee claim, so the line makes none.
  ok("⛔⛔ the line says NOTHING about fees", !/fee|verdict|reconcil|charged/i.test(line), line);
  ok("⛔ …and nothing about the mechanic either — those rows are measured and carry no such sentence",
    !/upfront|deducted|mechanic|on top of/i.test(line));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — A SHOWN ROW IS RENDERED WHOLE, explanatory sentences included");
{
  // ⭐ RENDERED, not grepped. The collapse must not silently drop the sentences that exist because
  // the figure alone is ambiguous.
  const inflight = { state: "burn_confirmed", delivery: "predicted", feeCharged: 0.054, feeMechanic: "upfront",
                     netPredicted: 1, destinationLabel: "Base (Sepolia)", amountRequested: 1 };
  ok("⭐ an in-flight row is NOT collapsible", !matchesCollapsePredicate(inflight as any));
  const html = renderToStaticMarkup(React.createElement(BridgeReceiptStatus, { r: inflight as any }));
  ok("⭐⭐ …and it still renders its mechanic sentence when shown",
    /charged on the source chain in addition to the amount/i.test(html));

  // ⚠️ AND THE STRUCTURAL HARMONY, ASSERTED: the rows that carry an explanatory sentence are exactly
  // the ones the whitelist keeps. c8e84ad renders it only where `!measured`; only `measured` rows
  // collapse. So collapsing can never hide one.
  const measured = { state: "minted", delivery: "measured", amountDelivered: 1, feeCharged: 0.054,
                     feeMechanic: "upfront", destinationLabel: "Base (Sepolia)", amountRequested: 1 };
  const mHtml = renderToStaticMarkup(React.createElement(BridgeReceiptStatus, { r: measured as any }));
  ok("⭐⭐ a COLLAPSIBLE row carries no mechanic sentence to lose",
    matchesCollapsePredicate(measured as any) &&
    !/charged on the source chain in addition to the amount/i.test(mHtml));
  ok("  …and it still reports its chain reading", /read from\s+the destination chain/i.test(mHtml));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("8 — THE REAL CORPUS SHAPE (17 rows, as measured 2026-09-04)");
{
  const corpus = [
    ...Array.from({ length: 14 }, (_, i) => collapsible({
      burnHash: "0x" + String(i).padStart(64, "0"),
      burnedAt: new Date(Date.parse("2026-07-31T19:44:01Z") + i * 3600_000).toISOString(),
    })),
    collapsible({ burnHash: "0xpr5", burnedAt: "2026-09-04T10:00:00.096Z", feeReconciliation: { verdict: "matched" } }),
    { txId: "tx-user-mtiphw04", state: "burn_submitted", delivery: "predicted", submittedAt: "2026-09-01T13:32:00Z" },
    { txId: "tx-user-mtlru386", state: "burn_submitted", delivery: "predicted", submittedAt: "2026-09-03T17:00:41Z" },
  ];
  const { shown, hidden } = partitionReceipts(corpus as any);
  ok("⭐⭐ 17 rows → 3 shown, 14 hidden", shown.length === 3 && hidden.length === 14, `${shown.length}/${hidden.length}`);
  ok("⛔ the needs-review row is SHOWN", shown.some((r: any) => r.txId === "tx-user-mtiphw04"));
  ok("⛔ the in-flight row is SHOWN", shown.some((r: any) => r.txId === "tx-user-mtlru386"));
  ok("⭐ the newest row is SHOWN", shown.some((r: any) => r.burnHash === "0xpr5"));
  ok("⭐ every hidden row is minted + measured", hidden.every((r: any) => r.state === "minted" && r.delivery === "measured"));
  ok("⭐ the line reads for this corpus", collapseSummaryLine(hidden.length).startsWith("14 earlier bridges —"),
    collapseSummaryLine(hidden.length));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
