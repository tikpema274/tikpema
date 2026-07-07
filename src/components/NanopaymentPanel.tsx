const go = (id: string) => {
  window.location.hash = "/" + id;
};

// Nanopayment — a copy-only explainer. Reached via the Dashboard "Do something"
// card (#/nanopay), deliberately NOT a nav item: the 5-item nav is reserved for
// working tools, and this is a static how-it-works page, not a control surface.
// It takes no wallet prop and moves no money — it explains the autonomous
// mid-research purchase flow that already runs server-side in
// netlify/functions/_research.mjs (maybeBuyData → payX402 → cited fact). When a
// LIVE version lands, this is its spec: the four steps below map to that engine.
export default function NanopaymentPanel() {
  return (
    <div className="plane">
      <div className="panel-eyebrow">Nanopayments</div>
      <h2>A fraction of a cent, paid automatically.</h2>
      <div className="sub">
        Mid-research, your agent sometimes needs a fresher fact than the open web
        can give. When it does, it buys just that one data point — for a fraction
        of a cent, settled on-chain in USDC, all within your budget.
      </div>

      {/* How it works — the .process 4-step strip. Condenses the real engine
          flow (decide → price-check → pay → cite) into four user-facing beats. */}
      <div className="process">
        <div>
          <div className="step-num">01</div>
          <div className="step-title">Decide it's needed</div>
          <div className="step-body">
            Your agent checks whether the free web sources can give a live,
            as-of-now figure. If they already answer the question, it skips buying
            entirely.
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
            It signs a tiny on-chain USDC payment for exactly that amount. Only a
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
        This runs automatically when you commission research.{" "}
        <button className="linkbtn" onClick={() => go("research")}>
          Go to Research →
        </button>
      </div>
    </div>
  );
}
