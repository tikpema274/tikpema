// bridgeReceiptCollapse.ts — WHICH BRIDGE ROWS MAY BE HIDDEN. Pure: no hooks, no I/O, no clock.
//
// ═══ ⛔⛔ THIS IS A WHITELIST, AND THAT IS THE WHOLE DESIGN ════════════════════════════════════
// A row is hidden ONLY if it positively matches every clause below. Everything else — every state
// this file does not name, every state added later, every row with a field missing or unparseable —
// stays VISIBLE.
//
// 🚨 THE BLACKLIST VERSION ("hide unless it needs review") IS THE BUG. It hides anything nobody
// classified, which means a state added six months from now is hidden on the day it ships, silently,
// by code written before it existed. The failing direction has to be "shown for no reason", never
// "hidden for no reason". [[absence-must-never-read-as-safe]]
//
// ⭐ The list a user must never lose is the one that asks them to act. `provisionalStatus`'s
// `unresolved` band — "reconcile this transaction against Circle's record by hand" — is the only row
// that does, and it is kept visible here not by being named but by FAILING the whitelist, which is
// the stronger reason: naming it would mean a future needs-review state has to be remembered.

import { KNOWN_RECEIPT_STATES } from "../components/bridgeReceiptStatus";

export interface CollapsibleReceipt {
  burnHash?: string | null;
  txId?: string | null;
  state?: string | null;
  delivery?: string | null;
  amountDelivered?: number | null;
  burnedAt?: string | null;
  submittedAt?: string | null;
  feeReconciliation?: { verdict?: string | null } | null;
  /** ⚠️ NOT EMITTED BY THE SERVER TODAY — see the note on `FEE_JOIN_UNREADABLE` below. */
  feeVerdictReadable?: boolean;
}

/**
 * ⭐⭐ ONE STRUCTURE HOLDS BOTH THE PREDICATE AND THE SUMMARY LINE.
 *
 * The predicate is the AND of every clause's `test`. The summary line is composed from the clauses'
 * `prose`. They cannot drift, because there is only one list — and a guard that pinned the SENTENCE
 * instead would either keep it true or keep it FROZEN. Both happened in this repo on 2026-09-04:
 * `verify-bridge-batch-atomicity` pinned an atomicity overclaim AND pinned "No batched burn has
 * landed on chain" months after two had. A guard must bind the derivation, never the wording.
 *
 * ⛔ EVERY CLAUSE MUST DECLARE `prose` OR `whyNoProse`. A clause with neither is a predicate change
 * that nobody decided how to describe — and the guard fails on it, before it can hide a row under a
 * sentence that does not cover it.
 */
export interface CollapseClause {
  id: string;
  test: (r: CollapsibleReceipt) => boolean;
  /** The claim this clause licenses the summary line to make. */
  prose: string | null;
  /** Required when `prose` is null: why this clause makes no claim a reader needs. */
  whyNoProse?: string;
}

export const COLLAPSE_CLAUSES: readonly CollapseClause[] = Object.freeze([
  {
    id: "minted",
    test: (r) => r.state === "minted",
    prose: "each arrived",
  },
  {
    // ⭐ BOTH HALVES. `delivery: "measured"` without an `amountDelivered` is the panel's own
    // defensive branch ("mint reported, but no measured amount was recorded") — an anomaly, and
    // anomalies are not hidden.
    id: "measured",
    test: (r) => r.delivery === "measured" && r.amountDelivered != null,
    prose: "each amount was read from the destination chain",
  },
  {
    // ⭐⭐ THE ONE NON-STATE CLAUSE, AND IT IS LOAD-BEARING. A bridge can be `minted` and `measured`
    // — fully arrived, right amount — and still have moved a fee DIFFERENT from the one the user was
    // shown. That is a money-claim discrepancy with its own alert path (`shoutFeeMismatch`), and a
    // state-only rule would bury it. Requirement 1 keeps needs-review rows visible; THIS is what
    // remains after it.
    // ⚠️ `unreadable` and absent (`null`) stay collapsible ON PURPOSE: neither asserts a
    // discrepancy, and absent is the norm on every pre-migration receipt. Pinned both directions.
    id: "fee-not-mismatched",
    test: (r) => r.feeReconciliation?.verdict !== "mismatched",
    prose: null,
    whyNoProse:
      "the summary line makes NO fee claim at all, so this clause licenses no wording. It exists to " +
      "keep a discrepancy out of the hidden set, not to let the line say anything about fees.",
  },
  {
    // ⛔ DEGRADE TOWARD SHOWING MORE. A row whose verdict could not be READ is not a row whose
    // verdict is absent, and it must not be hidden on an unchecked claim.
    // 🚨 UNREACHABLE TODAY, DELIBERATELY BUILT ANYWAY: `readFeeVerdict` returns `null` on a miss AND
    // on a store error, so `bridge-receipts.mjs` cannot tell the client which it got. The branch is
    // defined and tested here; making it REACH production needs that reader to return a tri-state
    // ({record, readable}) the way `readHealth` already does, and to project it. Until then no row
    // ever sets this field. Recorded rather than silently omitted — a branch nothing reaches is
    // untested by default, and this one says so out loud.
    id: "fee-join-readable",
    test: (r) => r.feeVerdictReadable !== false,
    prose: null,
    whyNoProse:
      "an unreadable check is the absence of an answer, not an answer. It withholds a row from the " +
      "hidden set; it does not add a claim to the line.",
  },
]);

/** ⭐ THE PREDICATE IS THE CLAUSES, NOT A SECOND COPY OF THEM. */
export function matchesCollapsePredicate(r: CollapsibleReceipt): boolean {
  return COLLAPSE_CLAUSES.every((c) => c.test(r));
}

/**
 * ⭐ THE ORDER KEY IS THE ROW'S OWN TIMESTAMP, not its position in the list.
 *
 * Neither `bridge-receipts.mjs` nor the panel sorts — the order is whatever `listByOwner` returns,
 * i.e. Blobs key order. So "newest" cannot be read off position and is derived here instead.
 * A durable receipt carries `burnedAt`; a provisional one carries `submittedAt`.
 *
 * ⛔ AN UNDATEABLE ROW RETURNS null AND IS THEREFORE NEVER COLLAPSED — matching
 * `provisionalStatus`, which calls a record with no readable `submittedAt` `unresolved` on exactly
 * this reasoning: a record nobody can date can never age out on its own.
 */
export function receiptOrderKey(r: CollapsibleReceipt): number | null {
  const raw = r.burnedAt ?? r.submittedAt ?? "";
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/** The identity the list keys on — a provisional receipt has no burnHash. */
export const receiptIdentity = (r: CollapsibleReceipt): string => String(r.burnHash ?? r.txId ?? "");

/**
 * Split the list into what is rendered and what hides behind the summary line.
 *
 * ⛔ `degraded` FORCES EVERYTHING VISIBLE. If the receipts read itself was degraded the set is not
 * known to be complete, and collapsing an unknown set under a sentence about "earlier bridges" would
 * describe rows we did not see.
 *
 * ⭐ ORDER IS PRESERVED EXACTLY. Nothing is hoisted — a needs-review row stays where it sits. The
 * requirement is that it is never HIDDEN, which is a different property from being moved, and moving
 * it would change what "the newest row" means.
 */
export function partitionReceipts(
  receipts: readonly CollapsibleReceipt[],
  { degraded = false }: { degraded?: boolean } = {}
): { shown: CollapsibleReceipt[]; hidden: CollapsibleReceipt[] } {
  if (degraded) return { shown: [...receipts], hidden: [] };

  // The newest row stays expanded whatever its state. Undateable rows cannot win, and cannot be
  // hidden either — they fail the whitelist by way of `receiptOrderKey` returning null.
  let newestId = "";
  let newestAt = -Infinity;
  for (const r of receipts) {
    const t = receiptOrderKey(r);
    if (t !== null && t > newestAt) { newestAt = t; newestId = receiptIdentity(r); }
  }

  const shown: CollapsibleReceipt[] = [];
  const hidden: CollapsibleReceipt[] = [];
  for (const r of receipts) {
    const collapsible =
      receiptOrderKey(r) !== null &&
      receiptIdentity(r) !== newestId &&
      matchesCollapsePredicate(r);
    (collapsible ? hidden : shown).push(r);
  }
  return { shown, hidden };
}

/**
 * ⭐⭐ THE SUMMARY LINE IS THE PREDICATE RENDERED AS PROSE — composed from the clauses, never typed.
 *
 * If the predicate gains a clause that makes a claim, the line gains it too. If it loses one, the
 * line loses it. There is no wording to keep in sync, which is the only version of this that cannot
 * go stale.
 *
 * ⚠️ IT SAYS NOTHING ABOUT FEES, and that is not an oversight — the hidden set carries NO fee claim.
 * Absent and `unreadable` verdicts are both collapsible, so a sentence mentioning fees would be
 * describing a check that, for most hidden rows, never ran.
 */
export function collapseSummaryLine(count: number): string {
  const claims = COLLAPSE_CLAUSES.map((c) => c.prose).filter((p): p is string => !!p);
  return `${count} earlier ${count === 1 ? "bridge" : "bridges"} — ${claims.join(", and ")}.`;
}

/** Exported for the guard: every state the panel knows, plus the fact that unknowns exist. */
export const COLLAPSIBLE_STATE = "minted";
export { KNOWN_RECEIPT_STATES };
