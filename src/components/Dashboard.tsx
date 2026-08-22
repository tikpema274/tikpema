import type { useWallet } from "../wallet/useWallet";

type UnifiedWallet = ReturnType<typeof useWallet>;

const go = (id: string) => {
  window.location.hash = "/" + id;
};

// Dashboard — a landing/overview. It shows NO balance and moves NO money.
//
// ── WHAT LEFT THIS PAGE, AND WHY ─────────────────────────────────────────────────────
// The "Your money" block — the three pockets (Your wallet / Agent's wallet / Unified
// balance) with Fund, Withdraw, Max, Refresh and Deposit — used to render inline here.
// It now lives on the Wallet page (#/wallet), in YourMoney.tsx, which is the page whose
// entire subject is the user's money; this page's subject is what the agent can do.
//
// It was MOVED, not copied. Nothing here reads w.usdcBalance, w.agentWallet.balance or
// the Gateway balance any more, and nothing here should start: a money figure duplicated
// into a second view is a figure that drifts out of date, which has bitten this app
// before. The registry of truth is the Wallet page; this page links to it.
//
// The action grid below is grouped BY CONSEQUENCE, not by feature. A flat six-card grid
// gave Bridge and Deposit identical visual weight, and the author of this app clicked the
// wrong one — moving money OUT when they meant to move it between their own pockets.
// The consequence therefore lives IN THE LABEL, read BEFORE the click. Deliberately NO
// confirmation dialogs: those train people to click through.
export default function Dashboard({ wallet: w }: { wallet: UnifiedWallet }) {
  return (
    <>
      <div className="plane">
        <div className="panel-eyebrow">Overview</div>
        <h2>Your autonomous agent, on Arc.</h2>
        <div className="sub">
          One agent with its own on-chain wallet. Ask in plain language and it
          researches with cited sources, sends and swaps USDC, and bridges
          cross-chain to Ethereum, Base and more — gasless, no seed phrase, and
          kept within your per-transaction and daily spending caps.
        </div>

        {w.agentWallet ? (
          // ── WHERE THE THREE POCKETS USED TO BE. ──────────────────────────────────────
          // The "Your money" block (Your wallet / Agent's wallet / Unified balance, with
          // Fund, Withdraw, Max, Refresh and Deposit) now lives on the Wallet page — see
          // YourMoney.tsx. It is NOT duplicated here: a balance rendered in two places is
          // two balances that drift, and the money copy on this page has drifted before.
          // One number, one home; this page points at it.
          <div style={{ marginTop: 4 }}>
            <button className="emerald" onClick={() => go("wallet")}>
              Your money →
            </button>
            <div className="sub" style={{ margin: "8px 0 0" }}>
              Your balances, funding and withdrawal are on your Wallet page.
            </div>
          </div>
        ) : (
          // Three explicit entry points. Passkey/MetaMask start the connect flow
          // in THIS click (preserving the user gesture WebAuthn needs) and route
          // to the Wallet page, where status + the duplicate-wallet guard already
          // render. "Set up a new wallet" deep-links into that page's existing
          // create sub-flow (which carries the guard) via ?new.
          <div style={{ display: "grid", gap: 12, marginTop: 4 }}>
            <div>
              <button
                className="emerald"
                style={{ width: "100%" }}
                disabled={w.busy}
                onClick={() => {
                  go("wallet");
                  w.connectLogin().catch(() => {});
                }}
              >
                Connect a passkey
              </button>
              <div className="sub" style={{ margin: "6px 0 0" }}>
                Sign in with Face ID or fingerprint — no seed phrase.
              </div>
            </div>

            {(w.connectors.find((c) => c.kind === "metamask")?.isAvailable() ?? false) && (
              <div>
                <button
                  style={{ width: "100%" }}
                  disabled={w.busy}
                  onClick={() => {
                    go("wallet");
                    w.connectMetaMask().catch(() => {});
                  }}
                >
                  Connect MetaMask
                </button>
                <div className="sub" style={{ margin: "6px 0 0" }}>
                  Use your existing MetaMask wallet.
                </div>
              </div>
            )}

            <div>
              <button
                style={{ width: "100%" }}
                disabled={w.busy}
                onClick={() => go("wallet?new")}
              >
                Set up a new wallet
              </button>
              <div className="sub" style={{ margin: "6px 0 0" }}>
                New here? Create a fresh agent wallet.
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── DO SOMETHING — GROUPED BY CONSEQUENCE, NOT BY FEATURE ────────────────────────
          The old flat six-card grid gave Bridge and Deposit identical weight, which is how
          the author of this app clicked "Bridge" (money LEAVES Arc, costs a fee to undo)
          when they meant "Deposit to unified balance" (money moves between their own
          pockets). Feature-shaped grids do that: they sort by what the code does, not by
          what it costs you to be wrong.

          So: three groups, ordered by escalating consequence, and the consequence is IN THE
          LABEL where it is read BEFORE the decision — not behind a confirmation dialog,
          which only teaches people to click through. */}
      {/* NOTE — there is no "Fund your agent" or "Withdraw" CARD here, and there must not
          be one. Those forms live in the pockets they act on, which are now on the Wallet
          page. One control, one home: re-adding a card here would be the duplication that
          was already deleted from MyAgentPanel once.

          Deposit KEEPS its card, because #/unified is a genuinely different page with its
          own explanation, its own cap, and its own commitment warning. */}
      <div className="plane">
        <div className="panel-eyebrow">Move money between your accounts</div>
        <div className="sub">
          Nothing leaves you. Fund and withdraw live beside the balances they move, on your{" "}
          <button className="linkbtn" onClick={() => go("wallet")}>
            Wallet page
          </button>
          .
        </div>
        <div className="quick">
          {/* The ONE reversible-looking move that ISN'T fully reversible. It sits in this
              group because the money is still yours — but the amber warning is what stops
              it from reading like a free transfer between pockets. */}
          <button className="quick-card" onClick={() => go("unified")}>
            <div className="qt">Deposit to unified balance →</div>
            <div className="qd">
              <span style={{ color: "var(--warn)" }}>⚠ Committed</span> — releasing it is
              delayed and goes through us. The one pocket you can't pull back alone.
            </div>
          </button>
        </div>
      </div>

      <div className="plane">
        <div className="panel-eyebrow">Move money out</div>
        <div className="sub">
          <b>This leaves you.</b> Both of these send USDC somewhere you don't control.
        </div>
        <div className="quick">
          <button className="quick-card" onClick={() => go("send")}>
            <div className="qt">Send →</div>
            <div className="qd">
              <span style={{ color: "var(--warn)" }}>❗ Goes to someone else.</span> Gone —
              there is no undo.
            </div>
          </button>
          <button className="quick-card" onClick={() => go("bridge")}>
            <div className="qt">Bridge →</div>
            <div className="qd">
              <span style={{ color: "var(--warn)" }}>❗ Leaves Arc</span> for another chain.
              Bridging back costs a fee.
            </div>
          </button>
          {/* The Vault agent (#/vault, nav-less). A deposit IS reversible (withdraw), but into a
              third-party contract — the card leads with that, not with the yield. */}
          <button className="quick-card" onClick={() => go("vault")}>
            <div className="qt">Vault →</div>
            <div className="qd">
              <span style={{ color: "var(--warn)" }}>❗ Into a third-party vault.</span> Withdraw
              any time, minus a fee — but read the owner's powers first.
            </div>
          </button>
          {/* Recurring swaps (#/dca, nav-less). ⭐⭐ THIS CARD IS UNBLOCK CONDITION (4) AT THE
              CREATE_GATED CONSTANT: the route was reachable-but-unlinked for weeks, which is the
              configuration that hid a 22-day outage in this same surface. verify-dca-consent-copy
              §6 renders this Dashboard and drives its controls, so the entry point is enforced
              rather than remembered — but it asserts the TARGET, never this label or copy.
              ⚠️ It sits in "Move money out" and leads with the consequence, like its siblings.
              This one's consequence is the strongest on the page and it is stated first: the
              money moves WITH NOBODY PRESENT, signed by a key the server holds. Deliberately NOT
              sold on convenience — the panel's amber consent band says the same thing at length,
              and a card that undersold it would be the softer half of a split message.
              ⚠️ Linked WHILE CREATE IS GATED, on purpose: DcaPanel leads with the paused banner,
              and list/cancel are never gated. So this is the only way a holder of an existing
              mandate can reach Cancel without typing the hash — which is a reason to link it
              NOW, not at un-gate. */}
          <button className="quick-card" onClick={() => go("dca")}>
            <div className="qt">Recurring swaps →</div>
            <div className="qd">
              <span style={{ color: "var(--warn)" }}>❗ Runs while you're offline</span>, signed by
              our key — not your passkey. Cancel anytime; a swap already sent still lands.
            </div>
          </button>
        </div>
      </div>

      <div className="plane">
        <div className="panel-eyebrow">Ask your agent</div>
        <div className="quick">
          <button className="quick-card" onClick={() => go("agent")}>
            <div className="qt">AI Agent →</div>
            <div className="qd">
              Give your agent a task in plain language — research, send, swap,
              bridge, or a multi-step plan.
            </div>
          </button>
          <button className="quick-card" onClick={() => go("research")}>
            <div className="qt">Research →</div>
            <div className="qd">
              Commission a cited research brief, settled on-chain in USDC.
            </div>
          </button>
          {/* The proposal loop's entry. Nav-less #/plan — distinct from Research, whose
              guardrail correctly declines "should I…" questions. Framing leads with the
              user deciding, because the agent proposes and only the user approves. */}
          <button className="quick-card" onClick={() => go("plan")}>
            <div className="qt">Plan an action →</div>
            <div className="qd">
              Describe an on-chain action; your agent researches it and proposes a plan
              you approve.
            </div>
          </button>

          {/* The AGENTS ROSTER (#/agents, nav-less). Leads with the trust distinction, because
              that is the thing worth knowing — but states NO COUNT.
              This card used to end "Only one can move your money." It was false (three of the
              four do: the Researcher buys data with your USDC, plus the Executor and the Vault)
              and it was false in the reassuring direction. The roster's own headline counts its
              cards, but this card never fetches the roster — it has nothing to count, so it
              must not imply a number. The roster page itself does the counting. */}
          <button className="quick-card" onClick={() => go("agents")}>
            <div className="qt">Your agents →</div>
            <div className="qd">
              See who acts for you, what each one spent, and stop any of them instantly. Each
              one says whether it can move your money.
            </div>
          </button>
          <button className="quick-card" onClick={() => go("nanopay")}>
            <div className="qt">Nanopayments →</div>
            <div className="qd">
              {/* ⚠️ SECOND COPY OF A CLAIM CORRECTED ON NanopaymentPanel. It said "your agent
                  PAYS", present tense, for a step that has never fired in production — and it
                  survived the page's own fix because nobody grepped for the other copy. Keep the
                  two in step: this is the card, that is the page. */}
              How your agent can pay a fraction of a cent for fresh data mid-research —
              and why it has not needed to yet.
            </div>
          </button>
        </div>
      </div>
    </>
  );
}
