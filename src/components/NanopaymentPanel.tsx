const go = (id: string) => {
  window.location.hash = "/" + id;
};

// Nanopayment — a copy-only explainer. Reached via the Dashboard "Do something"
// card (#/nanopay), deliberately NOT a nav item: the 5-item nav is reserved for
// working tools, and this is a static how-it-works page, not a control surface.
//
// ═══ 🚨 THIS PAGE SAID THE PAID STEP HAD NEVER RUN. IT HAD — FOR 20 DAYS. ═══════════════════
// It read "so far it has not happened", "and so far they always have", and "This step has not yet
// run for a real job", in the subjunctive throughout. The buy side FIRED on 2026-08-20T11:37Z and
// twice more. ⚠️ The page was wrong in the UNDERSTATING direction, which is why nobody caught it:
// an under-claim reads as caution, and caution reads as correct.
//
// ⭐⭐ AND ITS OWN COMMENT PREDICTED THIS, THEN DID IT ANYWAY. The block here used to argue —
// correctly — that "we have never bought anything" would rot silently the moment a purchase
// landed, and that the copy must state the MECHANISM, not a tally. Directly beneath that argument
// it then wrote a tally: "across six recorded jobs it has never been chosen". ⛔ A rule stated in
// a comment does not constrain the prose under it. Only an executed assertion does.
//
// ⭐ MEASURED FROM `job-deliverables` 2026-09-09 (334 keys, re-read, not inherited):
// purchased 3 · free-source 14 · not-attempted 40 · every other code 0. All three paid QuickNode
// via DATA_SELLER_URL at 0.0001 USDC — 100× UNDER the 0.01 per-buy ceiling.
//
// ⚠️ SO THE COPY STATES THE MECHANISM AND STOPS THERE. "Only a question needing a live on-chain
// reading routes to a paid buy" was true before the first purchase and is true after it. No count
// appears on this page in either direction — not "never", and not "three times", which would rot
// the same way pointing the other way. `verify-nanopay-copy` now bans never-claims as a CLASS.
export default function NanopaymentPanel() {
  return (
    <div className="plane">
      <div className="panel-eyebrow">Nanopayments</div>
      <h2>A fraction of a cent, paid automatically — when it is ever needed.</h2>
      <div className="sub">
        Mid-research, your agent sometimes needs a fresher fact than the open web
        can give. When it does, it can buy just that one data point — for a fraction
        of a cent, settled on-chain in USDC, all within your budget.{" "}
        <b>In practice this is rare:</b> free sources answer most jobs, and only a
        question needing a live on-chain reading routes to a paid buy.
      </div>

      {/* How it works — the .process 4-step strip. Condenses the real engine
          flow (decide → price-check → pay → cite) into four user-facing beats. */}
      <div className="process">
        <div>
          <div className="step-num">01</div>
          <div className="step-title">Decide it's needed</div>
          <div className="step-body">
            Your agent checks whether the free sources can give a live, as-of-now
            figure. If they already answer the question — which is the common case
            — it skips buying entirely. Only a question needing a live on-chain
            reading (block height, gas price, or an account balance) goes further.
          </div>
        </div>
        <div>
          <div className="step-num">02</div>
          <div className="step-title">Check the price</div>
          <div className="step-body">
            It reads the seller's price up front and refuses anything above a hard
            per-buy cap or your daily budget — before any money moves.
          </div>
        </div>
        <div>
          <div className="step-num">03</div>
          <div className="step-title">Pay the nanopayment</div>
          <div className="step-body">
            It signs a tiny on-chain USDC payment for exactly that amount, and only a
            confirmed settlement counts as a purchase.
          </div>
        </div>
        <div>
          <div className="step-num">04</div>
          <div className="step-title">Cite it in your brief</div>
          <div className="step-body">
            The purchased fact folds into your answer with its source, listed
            alongside the free ones.
          </div>
        </div>
      </div>

      {/* "Fraction of a cent" callout — the inset field-bg card pattern. */}
      <div
        className="status"
        style={{
          marginTop: 26,
          padding: "16px 18px",
          background: "var(--field)",
          border: "1px solid var(--line)",
          borderRadius: 12,
        }}
      >
        <div style={{ color: "var(--paper-dim)" }}>
          How small? Each buy is capped at a fraction of a cent —{" "}
          <span className="mono" style={{ color: "var(--paper)" }}>
            $0.01
          </span>{" "}
          max by default — and every purchase still has to fit inside your
          per-job and daily spending caps.
        </div>
      </div>

      <div className="sub" style={{ marginTop: 22, marginBottom: 0 }}>
        This is wired and funded, and runs automatically <i>when</i> a question needs
        it — you are not charged for a purchase that does not happen.{" "}
        <button className="linkbtn" onClick={() => go("research")}>
          Go to Research →
        </button>
      </div>
    </div>
  );
}
