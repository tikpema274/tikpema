const go = (id: string) => {
  window.location.hash = "/" + id;
};

// Nanopayment — a copy-only explainer. Reached via the Dashboard "Do something"
// card (#/nanopay), deliberately NOT a nav item: the 5-item nav is reserved for
// working tools, and this is a static how-it-works page, not a control surface.
//
// ═══ 🚨 THIS PAGE DESCRIBED, IN PRESENT TENSE, SOMETHING THAT HAS NEVER RUN ═════════════════
// It said "It signs a tiny on-chain USDC payment", "Only a confirmed settlement counts as a
// purchase" and "This runs automatically when you commission research". The agent-buys-from-agent
// step has never fired in production. ⚠️ Its own header already contradicted itself in nine lines
// — "already runs server-side" above "when a LIVE version lands, this is its spec" — and both
// could be quoted in good faith.
//
// ⭐⭐ AND THE REASON IS NOT A BLOCKER, WHICH IS WHY THE HONEST VERSION IS SPECIFIC. Measured
// 2026-08-20: the seller advertises OUR chain at 0.0001 USDC (100× UNDER the 0.01 ceiling), our
// selector matches it, DATA_SELLER_BODY is set, the Researcher is unpaused, the signing path is
// proven closed-loop, and the payer holds 4.8645 USDC. Nothing stops it. `decidePurchase` simply
// routes elsewhere: of four routes — none / market (CoinGecko) / papers (arXiv) / onchain — only
// `onchain` costs anything, and across six recorded jobs it has never been chosen.
//
// ⚠️ SO THE COPY STATES THE MECHANISM, NOT A TALLY. "Only a question needing a live on-chain
// reading routes to a paid buy" stays true the day the first purchase lands; "we have never bought
// anything" would rot silently, in the understating direction, exactly like "one real run, not a
// track record" would have if it had been written as a count.
export default function NanopaymentPanel() {
  return (
    <div className="plane">
      <div className="panel-eyebrow">Nanopayments</div>
      <h2>A fraction of a cent, paid automatically — when it is ever needed.</h2>
      <div className="sub">
        Mid-research, your agent sometimes needs a fresher fact than the open web
        can give. When it does, it can buy just that one data point — for a fraction
        of a cent, settled on-chain in USDC, all within your budget.{" "}
        <b>In practice this is rare, and so far it has not happened:</b> free sources have
        answered every research job to date.
      </div>

      {/* How it works — the .process 4-step strip. Condenses the real engine
          flow (decide → price-check → pay → cite) into four user-facing beats. */}
      <div className="process">
        <div>
          <div className="step-num">01</div>
          <div className="step-title">Decide it's needed</div>
          <div className="step-body">
            Your agent checks whether the free sources can give a live, as-of-now
            figure. If they already answer the question — and so far they always have
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
            It would sign a tiny on-chain USDC payment for exactly that amount, and
            only a confirmed settlement would count as a purchase. This step has not
            yet run for a real job.
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
        This is wired and funded, and runs automatically <i>if</i> a question ever needs
        it — you are not charged for a purchase that does not happen.{" "}
        <button className="linkbtn" onClick={() => go("research")}>
          Go to Research →
        </button>
      </div>
    </div>
  );
}
