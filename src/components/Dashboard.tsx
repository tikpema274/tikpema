import ConsequenceCard from "./ConsequenceCard";
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
          <ConsequenceCard title="Deposit to unified balance" onClick={() => go("unified")}>
              <span style={{ color: "var(--warn)" }}>⚠ Committed</span> — releasing it is
              delayed and goes through us. The one pocket you can't pull back alone.
            </ConsequenceCard>
          {/* ⭐ RECEIVE — IN THIS GROUP, NOT "Move money out". Money arriving is not money leaving,
              and this block's own sub says "Nothing leaves you", which is exactly true of receiving.
              🚨 I first placed this beside Vault, inside "Move money out" — under a heading reading
              "This leaves you." Presence is not enough: POSITION decides which claim a card sits
              under, and verify-dashboard-copy asserts that grouping with indexOf for this reason.
              [[a-category-label-became-a-position]] */}
          <ConsequenceCard title="Receive" onClick={() => go("receive")}>
              Your address and a QR to scan. <span style={{ color: "var(--warn)" }}>USDC on Arc
              only</span> — from another chain it will not arrive.
            </ConsequenceCard>
        </div>
      </div>

      <div className="plane">
        <div className="panel-eyebrow">Move money out</div>
        <div className="sub">
          <b>This leaves you.</b> Both of these send USDC somewhere you don't control.
        </div>
        <div className="quick">
          <ConsequenceCard title="Send" onClick={() => go("send")}>
              <span style={{ color: "var(--warn)" }}>❗ Goes to someone else.</span> Gone —
              there is no undo.
            </ConsequenceCard>
          <ConsequenceCard title="Bridge" onClick={() => go("bridge")}>
              <span style={{ color: "var(--warn)" }}>❗ Leaves Arc</span> for another chain.
              Bridging back costs a fee.
            </ConsequenceCard>
          {/* The Vault agent (#/vault, nav-less). Leads with the third-party risk, not the yield.
              🚨 THIS CARD SAID "Withdraw any time, minus a fee" AND NOTHING MADE THAT TRUE. It was
              a finding about XyloVault written as a property of vaults, on a surface that never
              inspects one — read BEFORE the disclosure, and inherited silently by any vault added
              later. ERC-4626 does not mandate instant redemption: a vault may queue, cooldown or
              lock, and maxRedeem may legitimately return 0.
              ⭐ SO IT NOW PROMISES THE MEASUREMENT, NOT THE OUTCOME. "Exit terms are measured and
              shown" stays true for a vault that cannot be exited at all, which is exactly the case
              the old sentence got wrong. The figures live on the panel, which reads the chain.
              [[human-facing-field-ships-with-its-render-assertion]] */}
          <ConsequenceCard title="Vault" onClick={() => go("vault")}>
              <span style={{ color: "var(--warn)" }}>❗ Into a third-party vault.</span> Exit terms
              — the fee, and whether you can withdraw at all right now — are measured and shown, and
              so are the owner's powers: read the owner's powers first.
            </ConsequenceCard>
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
          <ConsequenceCard title="Recurring swaps" onClick={() => go("dca")}>
              <span style={{ color: "var(--warn)" }}>❗ Runs while you're offline</span>, signed by
              our key — not your passkey. Cancel anytime; a swap already sent still lands.
            </ConsequenceCard>
        </div>
      </div>

      <div className="plane">
        <div className="panel-eyebrow">Ask your agent</div>
        <div className="quick">
          <ConsequenceCard title="AI Agent" onClick={() => go("agent")}>
              Give your agent a task in plain language — research, send, swap,
              bridge, or a multi-step plan.
            </ConsequenceCard>
          <ConsequenceCard title="Research" onClick={() => go("research")}>
              Commission a cited research brief, settled on-chain in USDC.
            </ConsequenceCard>
          {/* The proposal loop's entry. Nav-less #/plan — distinct from Research, whose
              guardrail correctly declines "should I…" questions. Framing leads with the
              user deciding, because the agent proposes and only the user approves. */}
          <ConsequenceCard title="Plan an action" onClick={() => go("plan")}>
              Describe an on-chain action; your agent researches it and proposes a plan
              you approve.
            </ConsequenceCard>

          {/* The AGENTS ROSTER (#/agents, nav-less). Leads with the trust distinction, because
              that is the thing worth knowing — but states NO COUNT.
              This card used to end "Only one can move your money." It was false (three of the
              four do: the Researcher buys data with your USDC, plus the Executor and the Vault)
              and it was false in the reassuring direction. The roster's own headline counts its
              cards, but this card never fetches the roster — it has nothing to count, so it
              must not imply a number. The roster page itself does the counting. */}
          <ConsequenceCard title="Your agents" onClick={() => go("agents")}>
              See who acts for you, what each one spent, and stop any of them instantly. Each
              one says whether it can move your money.
            </ConsequenceCard>
          {/* ⭐ THE PAGE'S OTHER WAY IN. The three self-signed operations are NOT in the nav, on purpose,
              so this card and the agent panels' twin links are the entry points. The blurb carries the
              CONTRAST, because a reader arriving here has not necessarily seen a capped panel first. */}
          <ConsequenceCard title="Sign it yourself" onClick={() => go("self-signed")}>
              Send, bridge or swap from your own wallet, signed with your own key —
              your agent's spending caps do not bound these.
            </ConsequenceCard>

          <ConsequenceCard title="Nanopayments" onClick={() => go("nanopay")}>
              {/* ⚠️ SECOND PRODUCER OF A CLAIM THAT LIVES ON NanopaymentPanel. It has now been
                  wrong in BOTH directions: first "your agent PAYS" for a step that had never
                  fired, then "has not needed to yet" for 20 days after it did. Neither survived
                  its own page's fix, because a fix to one producer does not reach the other.
                  Keep the two in step: this is the card, that is the page. */}
              How your agent can pay a fraction of a cent for fresh data mid-research —
              and why it rarely needs to.
            </ConsequenceCard>
          {/* ⭐ THE ONLY CARD THAT LEAVES THE APP. /built is a plain page outside the SPA, for a
              human arriving from Discord or GitHub who should not have to load a wallet app to
              read a list. An <a> and not go(), because it is not a hash route.
              🚨 THIS LINK IS THE POINT OF THE PAGE. App.tsx:85 records #/dca sitting live and
              unlinked for 22 days, reachable only by typing the hash. A page nobody can reach
              from anywhere is the same defect with better copy. */}
          <a className="quick-card" href="/built">
            <div className="qt">What else is built →</div>
            <div className="qd">
              DD, two live x402 sellers, a seller census, a standalone Arc x402 reference — each
              with what it actually is right now. Everything on it is Arc testnet or a document.
            </div>
          </a>
        </div>
      </div>
    </>
  );
}
