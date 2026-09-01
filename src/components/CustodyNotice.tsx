// CustodyNotice — the ONE statement of the custody position, rendered by every self-signed panel.
//
// ═══ 🚨 WHY THIS EXISTS: THREE COPIES OF ONE SENTENCE HAD ALREADY DRIFTED ══════════════════════
// ManualSendPanel and ManualBridgePanel carried a BYTE-IDENTICAL sentence. ManualSwapPanel, added
// 2026-08-30, said something different — and the suites drifted with it: two asserted
// /Agent spending caps do not apply here/i while the third weakened to
// /spending caps do not apply here/i, which passes against EITHER wording and therefore detects
// neither. A third variant would have gone unnoticed by all three.
// [[duplicate-source-of-truth-is-the-recurring-bug]]
//
// ═══ ⭐⭐ A COMPONENT, NOT A STRING CONSTANT — AND THE DIFFERENCE IS THE ASSERTION ═══════════════
// A constant can be imported and never rendered; the panel would still compile and the claim would
// simply be absent. A component is asserted by RENDERING it, which is the only form of evidence
// this repo accepts for user-facing copy. [[assert-on-rendered-output-not-source-regex]]
//
// ⭐ AND IT IS WHAT MAKES THE PANEL SUITES DRIFT-PROOF. They do not restate this sentence. They
// render THIS component and assert the panel's output CONTAINS it, so the expected text is composed
// from the same source that produces the real text. Change the wording here and all three panel
// suites keep passing CORRECTLY, while the one suite that asserts the wording goes red — the
// property is demonstrated in verify-custody-notice.tsx §3, not assumed.
//
// ═══ 🚨 A WRONG MONEY CLAIM, FOUND BY UNIFYING — NOT BY REVIEW ═════════════════════════════════
// The shared sentence said "spending your own USDC". That is FALSE on a EURC→USDC swap, where the
// funds being spent are EURC. It had been read many times and reviewed past; it surfaced only when
// three copies were laid side by side to merge them, because that is when the sentence had to be
// stated once for ALL THREE operations and the USDC assumption stopped fitting.
// ⭐ The fix is `token`: the notice names the asset it was given, and says "funds" when given none.
// ⚠️ Recorded as a defect the unification FOUND, not as a copy tidy it included.
import type { ReactNode } from "react";

/** The tokens a self-signed operation can spend today. `undefined` → the generic wording. */
export type CustodyToken = "USDC" | "EURC" | undefined;

/**
 * ⛔ RENDER THIS ONLY IN THE STATE WHERE THE CONTROL IS ACTUALLY OFFERED.
 *
 * A standing "caps do not apply" beside no control is a claim about a path the user cannot take —
 * the reason each panel keeps its own negative assertion that this notice is ABSENT from its
 * non-MetaMask state. That is a property of three different guards, not of this sentence, so it is
 * deliberately NOT centralised here.
 */
export default function CustodyNotice({ token }: { token?: CustodyToken }): ReactNode {
  // ⚠️ "your own funds" when the operation can spend more than one asset. Naming USDC
  // unconditionally is the defect this component was written to remove.
  const what = token ? `your own ${token}` : "your own funds";
  return (
    // ⭐ --warn, matching the six rails in the manual panels this renders inside — it carries the
    // same claim they do. ⛔ NOT --accent: that token is defined nowhere, and an unresolvable var()
    // makes the border-left shorthand invalid at computed-value time, so the rail rendered as
    // border-style:none — an accent stripe that was never on screen. [[absence-must-never-read-as-safe]]
    <div className="status" style={{ borderLeft: "3px solid var(--warn)", paddingLeft: ".9rem" }}>
      You sign this yourself, with your own key, spending {what}.{" "}
      <b>Agent spending caps do not apply here</b> — they bound what the agent may move
      unattended, and they are not a limit on your own funds.
    </div>
  );
}
