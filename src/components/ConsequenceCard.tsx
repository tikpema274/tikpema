// ConsequenceCard — the ONE shape for a "do something" card: arrow heading, optional category,
// consequence beneath.
//
// ═══ 🚨 WHY THIS EXISTS: THE SHAPE WAS ALREADY FORKED, AND SO WERE ITS GUARDS ══════════════════
// `Dashboard.tsx:162` and `MyAgentPanel.tsx:397` carried BYTE-IDENTICAL consequence copy written
// out twice, and two independent suites pinned them separately — `verify-dashboard-copy.tsx:86`
// and `verify-agent-panel-copy.tsx:118`, each asserting the same regex against its own render.
// Neither could see the other drift. Adding a third hand-written row on #/self-signed would have
// made it three owners and three guards. [[one-claim-two-producers]]
// [[duplicate-source-of-truth-is-the-recurring-bug]]
//
// ═══ ⛔ SHAPE ONLY — THE COPY IS DELIBERATELY NOT MERGED ═══════════════════════════════════════
// The Dashboard's cards describe the OPERATION ("Goes to someone else"). The self-signed cards
// describe the operation AND WHO SIGNS IT. Those are two different claims, and a component that
// unified them would force one page to state something only true on the other. This owns the
// STRUCTURE; every page still writes what it means.
//
// ═══ ⭐⭐ WHY NOT BRIDGE_SIGNER, WHICH IS THE SAME-SOUNDING AXIS ════════════════════════════════
// `shared/bridge-mechanic.mjs` already models "who signs" as server | browser | unknown, and it was
// the right thing to check first. It does NOT fit, for three reasons worth keeping:
//
//   1. DIFFERENT SUBJECT. BRIDGE_SIGNER describes a PAST BURN recorded in a receipt — which is why
//      it needs `unknown`, for a record that does not say. This describes a ROUTE's signing model,
//      known at design time and never absent. `unknown` would be a state nothing can produce, and
//      [[probe-must-discriminate-between-states]] cuts the other way too: do not carry a value the
//      subject cannot be in.
//   2. ITS COPY IS BRIDGE-BURN TAB SAFETY. `pageInstruction` / `mustStay` are about closing the tab
//      mid-burn. Reusing the record would attach a bridge hazard sentence to Send and Swap cards.
//   3. WRONG COUPLING DIRECTION. Card layout would then change whenever bridge RECEIPT semantics
//      change. A shared noun is not a shared capability. [[reopen-trigger-names-capability-not-noun]]
//
// ⭐ What IS reused is its DISCIPLINE: a frozen value tuple, copy in one keyed record, one accessor
// so no surface indexes the map directly, and a value that earns no badge saying so explicitly
// rather than by omission.
import type { ReactNode } from "react";

/** Who signs the operation a card leads to. ⛔ Two values, both always knowable — see reason (1). */
export const CARD_SIGNERS = Object.freeze(["agent", "self"] as const);
export type CardSigner = (typeof CARD_SIGNERS)[number];

/**
 * The badge each signing model earns.
 *
 * ⭐ `agent: null` IS THE DECISION, NOT AN OMISSION. The agent-run cards are the app's default and
 * every page they sit on already frames them; a badge on all of them would mark everything and
 * therefore mark nothing. The badge exists to carry the ONE fact that distinguishes a self-signed
 * card from a dashboard card that looks exactly like it. [[absence-must-never-read-as-safe]] is
 * satisfied because the absent case is written down here as a value, not left to a missing prop.
 */
export const CARD_SIGNER_BADGE = Object.freeze({
  agent: null,
  // ⚠️ SHORT ON PURPOSE. This sits beside the heading, where the full custody sentence would be
  // noise — `CustodyNotice` carries that at length on the panel the card leads to, and
  // SelfSignedPanel's intro carries it for the page. This is the pointer, not the statement.
  self: "you sign",
} as const);

/** One accessor, so no surface indexes the map directly. Unknown/absent → no badge. */
export function cardSignerBadge(v?: CardSigner | null): string | null {
  return v && (CARD_SIGNERS as readonly string[]).includes(v) ? CARD_SIGNER_BADGE[v] : null;
}

export default function ConsequenceCard({
  title,
  onClick,
  signer,
  category,
  children,
}: {
  /** Heading text. The arrow is appended here so no caller can forget it. */
  title: string;
  onClick: () => void;
  /** Omit for the agent-run default; `"self"` earns the badge. */
  signer?: CardSigner;
  /** The optional bold category line (MyAgentPanel's per-card grouping). */
  category?: ReactNode;
  /** The consequence line. */
  children: ReactNode;
}) {
  const badge = cardSignerBadge(signer);
  return (
    <button className="quick-card" onClick={onClick}>
      <div className="qt">
        {title} →{badge ? <span className="qbadge">{badge}</span> : null}
      </div>
      {category ? <div className="qd">{category}</div> : null}
      <div className="qd">{children}</div>
    </button>
  );
}
