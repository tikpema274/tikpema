import { useState } from "react";
import AddressDisplay from "./AddressDisplay";
import SignInPrompt from "./SignInPrompt";
import { useGatewayBalance } from "../lib/useGatewayBalance";
import type { useWallet } from "../wallet/useWallet";
import { readJson } from "../lib/readJson";
import UbExitStatus from "./UbExitStatus";

type UnifiedWallet = ReturnType<typeof useWallet>;

const go = (id: string) => {
  window.location.hash = "/" + id;
};

// UnifiedBalancePanel — a first-class page for YOUR OWN Unified Balance. Reached nav-less
// via #/unified (from the Dashboard "Your unified balance" card), mirroring #/bridge and
// #/nanopay: the 5-item nav stays reserved for working tools.
//
// READ: /api/gateway-balance — now AUTH-GATED and PER-USER (it used to be a public read of
// the SHARED agent wallet). useGatewayBalance handles the three states this creates:
// signed-out, provisioning (202, first-login race), and ready. A ready total of "0" is an
// HONEST value for a new user, so we present it as "fund me", never as a failure.
//
// WRITE: the FUNDING control posts /api/agent-ub-deposit (auth-gated, cap-enforced
// server-side BEFORE any tx). The user's OWN SCA funds its OWN unified balance from its own
// plain Arc USDC. That deposit ALSO performs the one-time delegate grant (server-side,
// inside ubDeposit, after the funds check) — which is why the SCA must hold USDC first
// (hop A, on the My Agent page).
//
// The COPY on this page is load-bearing, so treat it as such. "Nothing is sent to a third
// party" is true of a deposit and is NOT the fact that matters here — the unified balance is
// the one pocket THE USER CANNOT EXIT AT ALL. agent-withdraw returns balanceOf(SCA) (plain
// USDC); Gateway funds are not in that number, and NOTHING in this codebase returns them.
// (Comments here used to claim they "need initiateWithdrawal + withdrawalDelay + withdraw,
// server-side" — describing a mechanism that IS NOT IMPLEMENTED. No such endpoint exists.)
// So this page ranks the three pockets by what the
// user can reclaim ALONE, and warns AT the deposit control, not below it. Reversibility is
// the fact a user needs before committing money — never let reassurance crowd it out.
export default function UnifiedBalancePanel({ wallet: w }: { wallet: UnifiedWallet }) {
  // ⭐ THE EVIDENCE DISCLOSURE. Collapsed by DEFAULT, never OMITTED — the node always
  //    renders and is toggled with `hidden`, so a copy guard that reads rendered output
  //    still sees it. A conditional that omits it would hide the claim from the guard
  //    as well as the reader, which is how a load-bearing sentence disappears unnoticed.
  const [showEvidence, setShowEvidence] = useState(false);
  // Funding form state.
  const [amount, setAmount] = useState("");
  const [funding, setFunding] = useState(false);
  const [fundError, setFundError] = useState("");
  const [fundOk, setFundOk] = useState<{ amountUsdc: number; tx: string } | null>(null);
  const [fundStage, setFundStage] = useState(""); // async progress: the deposit now polls
  const [reloadKey, setReloadKey] = useState(0);

  const bal = useGatewayBalance(w, reloadKey);
  const data = bal.status === "ready" ? bal : null;
  // A brand-new user reads a true 0 — the signal to fund, not an error.
  const isEmpty = data != null && Number(data.total) === 0;

  // Poll a background deposit until it settles. The deposit is ~6s+ of real chain time, so
  // the window is generous — but bounded, so a wedged worker surfaces as an error rather
  // than a spinner that never resolves.
  async function pollDeposit(depositId: string, token: string) {
    const DEADLINE_MS = 120_000;
    const INTERVAL_MS = 2_000;
    const giveUpAt = Date.now() + DEADLINE_MS;

    while (Date.now() < giveUpAt) {
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
      const r = await fetch(`/api/agent-ub-deposit-status?depositId=${depositId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await readJson(r);
      if (!r.ok) throw new Error(d?.error || "Could not read the deposit status");
      if (d.status === "completed" || d.status === "failed") return d;
      if (d.status === "executing") setFundStage("Depositing on-chain…");
    }
    throw new Error(
      "The deposit is taking longer than expected. It may still land — check your balance shortly."
    );
  }

  // Fund — a money-path write, now ASYNC. /api/agent-ub-deposit is a fast front door: it
  // enforces auth + cap + the funds check and answers every REJECTION immediately (400/402),
  // then returns 202 { depositId } and runs the on-chain half in a background function. We
  // poll agent-ub-deposit-status until it settles.
  //
  // The deposit takes ~6s+ on-chain (approve → deposit, plus a one-time delegate grant on
  // your first one), which is why it can't be a single sync request — see netlify.toml.
  async function fund() {
    const amountNum = Number(amount);
    if (!(amountNum > 0)) {
      setFundError("Enter an amount greater than 0.");
      return;
    }
    setFunding(true);
    setFundError("");
    setFundOk(null);
    setFundStage("Checking your wallet…");
    try {
      const token = await w.ensureSession();
      const r = await fetch("/api/agent-ub-deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ amountUsdc: amountNum }),
      });
      const d = await readJson(r);
      // Synchronous rejections (over-cap 400, insufficient funds 402, auth 401) — nothing
      // was kicked off, so report and stop.
      if (!r.ok) throw new Error(d?.error || "Deposit failed");
      if (!d?.depositId) {
        // ⚠️ NOT the provisioning case any more — that is now a 503 caught by `!r.ok` above, with
        // its own message. This is the residual "2xx with no depositId" guard: a success-shaped
        // response that names nothing to poll is not a started deposit.
        throw new Error(d?.message || "The deposit did not start — nothing to track, so nothing moved.");
      }

      setFundStage("Depositing on-chain…");
      const done = await pollDeposit(d.depositId, token);

      if (done.status === "failed") {
        // A failed delegate grant is a CLEAN state: it runs before any approve, so no funds
        // moved. Say so plainly rather than leaving the user wondering where their USDC went.
        //
        // ⚠️ THREE OUTCOMES, NOT TWO. The server now distinguishes "the chain said no"
        // (delegateAuthFailed) from "the chain didn't answer" (transient / delegateAuthUnknown
        // — Arc rate-limited us). Both are safe and retryable, but they are NOT the same claim,
        // and flattening the second into the first would re-create the bug this fixes on the
        // client side. The server already words each one honestly; don't second-guess it here.
        //
        // The server's `error` is now always a short line — the raw viem dump lives in
        // `errorDetail`, which nothing renders. Never surface errorDetail to a user.
        const noFundsMoved = done.fundsMoved === false;
        throw new Error(
          noFundsMoved && !/no funds moved/i.test(done.error ?? "")
            ? `${done.error} (no funds moved — your USDC is still in your wallet)`
            : done.error || "Deposit failed"
        );
      }
      setFundOk({ amountUsdc: done.amountUsdc, tx: done.tx });
      setAmount("");
      setReloadKey((k) => k + 1); // re-read the balance we just changed
    } catch (e) {
      setFundError(e instanceof Error ? e.message : "Deposit failed");
    } finally {
      setFunding(false);
      setFundStage("");
    }
  }

  return (
    <div className="plane">
      <div className="panel-eyebrow">Unified balance</div>
      <h2>One USDC balance, across chains.</h2>
      {/* ⭐ THE "WHAT IS THIS" PARAGRAPH IS GONE. It described the float, the route into
          Gateway, and the multi-chain read — exactly what steps 1 and 2 of "How this works" now
          say, at the end of the page where an explanation belongs. Two paragraphs answering the
          same question is the clutter this restructure exists to remove; the heading above
          already names the thing. */}
      <div className="sub">
        Read live across Arc Testnet and Base Sepolia.
      </div>

      {/* Balance card — same surface as the Dashboard "Agent unified balance" card.
          Degrades gracefully to an "unavailable" line if the read fails. */}
      <div
        className="status"
        style={{
          marginTop: 14,
          padding: "14px 16px",
          background: "var(--field)",
          border: "1px solid var(--line)",
          borderRadius: 12,
        }}
      >
        <div
          style={{
            color: "var(--muted)",
            fontSize: "0.72rem",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            marginBottom: 6,
          }}
        >
          Your unified balance · across chains
        </div>

        {/* THE THREE STATES. Each is a distinct, honest message — none of them is a
            broken card, a leaked shared number, or a raw 401. */}
        {bal.status === "signed-out" && (
          <SignInPrompt
            wallet={w}
            message="Sign in to see your balance."
            onSignedIn={() => setReloadKey((k) => k + 1)}
          />
        )}

        {bal.status === "provisioning" && (
          <div className="sub" style={{ margin: 0 }}>
            Setting up your wallet… this takes a few seconds.
          </div>
        )}

        {bal.status === "loading" && (
          <div className="sub" style={{ margin: 0 }}>
            Reading your balance…
          </div>
        )}

        {bal.status === "error" && (
          <div className="sub" style={{ margin: 0 }}>
            Unified balance unavailable.
          </div>
        )}

        {data && (
          <>
            <span style={{ fontSize: "1.6rem", fontWeight: 600, color: "var(--paper)" }}>
              <span className="mono">{data.total}</span>{" "}
              <span style={{ fontSize: "0.85rem", color: "var(--muted)", fontWeight: 400 }}>USDC</span>
            </span>
            <div className="sub" style={{ marginTop: 8, display: "flex", gap: 16, flexWrap: "wrap" }}>
              {data.perChain.map((p) => (
                <span key={p.chain}>
                  {p.chain}:{" "}
                  {p.ok ? (
                    <span className="mono">{p.usdc} USDC</span>
                  ) : (
                    <span style={{ color: "var(--muted)" }}>unavailable</span>
                  )}
                </span>
              ))}
            </div>
            {/* A true 0 is the signal to FUND, not a failure. Say so. */}
            {isEmpty && (
              <div className="sub" style={{ marginTop: 8 }}>
                Your unified balance is empty. Deposit below to fund it — your agent's wallet
                needs USDC in it first (
                <button className="linkbtn" onClick={() => go("agent")}>
                  fund your agent
                </button>
                ).
              </div>
            )}
          </>
        )}

      </div>

      {/* ═══ ⛔ THE REVERSIBILITY LADDER WAS REMOVED — 2026-09-05, and it was MEASURED first ══
          It ranked three pockets by what the user can reclaim alone: your wallet, the agent's
          plain balance, the unified balance. Its comment said "Do not soften this to make the
          deposit easier", and that instruction was right — so it was not softened, it was moved
          out as a DUPLICATE.

          ⭐ YourMoney ALREADY RANKS THE SAME THREE POCKETS, on the page where all three live:
              Your wallet      badge "You hold the key"
              Agent's wallet   badge "Withdraw any time"
              Unified balance  badge "Exit built · about seven days"
          A comparison of three pockets belongs where the three pockets are, not on the page for
          one of them. This was the cross-page repetition the record has been carrying.

          ⚠️ THE ONE CLAIM THAT WAS ONLY HERE — "Withdraw doesn't move it", i.e. the agent-withdraw
          button does not return unified funds — is covered where it actually matters: YourMoney's
          amber "Not included: N USDC is in your unified balance" line sits ON that button. Here it
          was context about a control the reader cannot see.

          ⛔ WHAT DID NOT MOVE: custody. It is still stated at this page's own deposit button,
          because that is a press-time disclosure and has no other home on this page. */}

      {/* Funding — a MONEY-PATH WRITE. The agent SCA deposits its own plain Arc USDC
          into its own unified balance. Auth + per-deposit cap are enforced server-side
          before any transaction; this form is a thin caller. */}
      <div
        className="status"
        style={{
          marginTop: 12,
          padding: "14px 16px",
          background: "var(--field)",
          border: "1px solid var(--line)",
          borderRadius: 12,
        }}
      >
        <div
          style={{
            color: "var(--muted)",
            fontSize: "0.72rem",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            marginBottom: 8,
          }}
        >
          Fund the unified balance
        </div>
        {/* ⚠️ THIS COPY HAS BEEN WRONG THREE TIMES. Get it right.
            v1: "the funds stay owned by your agent — not a transfer to anyone else." True and
                MISLEADING: it answered "is anyone stealing this?" when the question the user
                needs answered is "CAN I GET IT BACK?"
            v2: said the money could be released, just slowly, via the server. FALSE in the
                other direction — it implied a built release path EXISTS and merely costs you
                patience.
            v3: "not by you, not by us. There is no path that returns it." Overcorrected from
                v2 into a DIFFERENT falsehood. The first clause was right, the second wasn't.
                v3 reasoned from OUR codebase ("no initiateWithdrawal anywhere in the repo",
                which is still true) to a claim about THE PROTOCOL. Those are not the same
                question, and the repo cannot answer the second one. Resolved by reading the
                chain, not the docs: Gateway 0x0077777d…19B9 is a proxy whose implementation
                0xa33d52b4…76e28 carries initiateWithdrawal(address,uint256) [c8393ba9],
                withdraw(address) [51cff8d9] and withdrawalDelay() [a7ab6961] — all present.
                availableBalance(USDC, <the user's agent SCA>) returns exactly the balance the
                UI shows, and withdraw() takes no beneficiary, so the releasing account is
                msg.sender = that SCA. So "not by us" was false; only "not by you" survived.
            The honest answer is: the path exists, and we haven't built it. Say both parts.

            ✅ "Tikpema controls that account" is MEASURED (2026-07-31), no longer withheld.
            Agent SCAs are DEV-CONTROLLED: _agent-wallets.mjs createWallets({accountType:
            "SCA"}) under CIRCLE_ENTITY_SECRET — the passkey is the IDENTITY key used to map
            owner→wallet, NOT the signer. getInstalledPlugins() == 0 on all three SCAs
            (incl. the one we demonstrably drive, which signs ERC-1271 attestations today),
            so there is NO permission module and NO selector allowlist. Impl 0xd206ac7f…
            exposes native execute(address,uint256,bytes). Owner directly + unrestricted ⇒
            withdraw() is available BY CONSTRUCTION. ⚠️ The DELEGATE question was MIS-FRAMED:
            the delegate is a GATEWAY-level grant for spends and gates nothing here — we
            drive the SCA as OWNER via contractExecution and never need it.

            🚨 THE BOUNDARY MOVED AGAIN, THIS TIME OUTWARD — AND IT STILL IS NOT A PROMISE.
            ⭐ EXECUTION IS NOW MEASURED, ONCE: initiateWithdrawal → delay → withdraw ran end to
            end on withdrawal 16be509f — 1 USDC, initiated 2026-08-12T20:49Z, completed UNATTENDED
            by the half-hourly sweeper at 2026-08-20T01:01:02Z (tx 0xc51ae011…), the first tick after a
            maturity that itself landed 80 minutes later than the estimate. So "it works" is no
            longer UNVERIFIED — it is VERIFIED ONCE, which is a different and much weaker claim
            than "it works reliably", and the copy must keep saying so. Still untested: how a
            pending withdrawal interacts with a balance being spent concurrently. The old danger
            (implying a recovery never once exercised) is gone; the NEW one is treating a single
            run as a track record. Say control, say one run, say floor-not-ceiling. See
            PROGRESS.md, "MEASURED vs INFERRED".
            ⚠️ "about seven days" is DERIVED — see the note on the balance bullet above.
            Never state it as a fixed number. */}
        <div className="sub" style={{ margin: "0 0 10px" }}>
          Move USDC from your agent's plain balance into its unified balance.{" "}
          {/* ⭐⭐ THE COST LEADS, and "about seven days" IS THE AFFORDANCE — pressing the
              seven-day claim is what reveals the evidence for it. NOT a "Learn more" beside
              it: a detached link can be missed by a reader who has already read the number,
              and the constraint is that the evidence stays reachable wherever the number
              renders.
              ⚠️ THE PHRASE STAYS APPROXIMATE PROSE. `withdrawalDelay()` returns a BLOCK COUNT
              (1,209,600 ≈ 7.14 days at ~0.5097 s/block); reading it as seconds gives 14 days,
              a tidy-looking wrong answer. The DERIVED figure and its provenance render on this
              same page from <UbExitStatus/> below, which fetches them. This sentence must never
              harden into a promised number. */}
          {/* ⭐ TWO SENTENCES, NOT ONE. "Money goes in instantly." is the cheerful half and it
              reads better alone; the cost then lands as its own statement rather than as a
              subordinate clause a skimmer can drop.
              ⛔ THE COST STAYS IN THE LEAD. Removing it would recreate the defect fixed in
              06d3a94, where this card led with copy that contradicted the paragraph beneath it —
              "the lead is what gets read". A user funding the balance decides here, before they
              ever scroll to the withdraw section, so the seven days must be readable here. */}
          {/* ⭐ CUT: the seven-day clause and "It is built now / you do not have to come back".
              MEASURED before cutting — "about seven days" renders 3× in the How-this-works card,
              2× in the withdraw block directly below, and once in the ladder; "you do not have to
              come back" renders in the withdraw block. Both were genuinely redundant here.
              ⛔ CUSTODY IS NOT. "the exit runs through us" and "Tikpema controls that account"
              render NOWHERE ELSE on this page — zero occurrences in the card, the withdraw block
              and the ladder. Cutting it would remove the claim from the page entirely, at the one
              place a user commits money. It stays, compressed.
              ⭐ THE PHRASE IS KEPT VERBATIM ON PURPOSE: YourMoney says it in exactly these words,
              and the file's rule is "one fact, one voice, wherever the user meets it". */}
          <b>Money goes in instantly.</b> Getting it out runs through us: the balance belongs to
          your agent's account, and <b>Tikpema controls that account</b>.
        </div>
        {/* The deposit needs a session AND a provisioned wallet — the server enforces both
            (401 / 202). Disable rather than let the user fire a request that can't work. */}
        {bal.status === "signed-out" ? (
          <SignInPrompt
            wallet={w}
            message="Sign in to fund your unified balance."
            onSignedIn={() => setReloadKey((k) => k + 1)}
          />
        ) : bal.status === "provisioning" ? (
          <div className="sub" style={{ margin: 0 }}>Setting up your wallet…</div>
        ) : (
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              placeholder="Amount (USDC)"
              value={amount}
              disabled={funding}
              onChange={(e) => setAmount(e.target.value)}
              style={{ maxWidth: 180 }}
            />
            <button className="emerald" disabled={funding || !amount} onClick={fund}>
              {funding ? "Depositing…" : "Fund"}
            </button>
          </div>
        )}
        {/* Async progress. The deposit is real chain time (approve → deposit, plus a
            one-time spender authorization on your first), so say what's happening rather
            than leaving a silent spinner. */}
        {funding && fundStage && (
          <div className="sub" style={{ margin: "8px 0 0" }}>
            {fundStage}
          </div>
        )}
        {fundError && (
          <div className="sub" style={{ margin: "8px 0 0", color: "var(--danger)" }}>
            {fundError}
          </div>
        )}
        {fundOk && (
          <div className="sub" style={{ margin: "8px 0 0" }}>
            Deposited <span className="mono">{fundOk.amountUsdc}</span> USDC.{" "}
            <a href={fundOk.tx} target="_blank" rel="noreferrer">
              View transaction ↗
            </a>
          </div>
        )}
      </div>


      {/* ⭐ THE WITHDRAW SECTION NOW HAS ITS OWN LABEL, matching "Fund the unified balance"
          above it, so the page reads as two named actions rather than one action and a status
          block. It also states WHERE THE MONEY LANDS in the heading itself — the agent wallet,
          not the user's — which UbExitStatus says inside its own copy but which a reader
          scanning headings would otherwise miss. */}
      {bal.status === "ready" && (
        <div className="panel-eyebrow" style={{ marginTop: 18 }}>
          Withdraw from Unified Balance to your agent wallet
        </div>
      )}

      {/* ═══ ⭐ THE EXIT — AFTER THE DEPOSIT, BECAUSE FUNDING COMES FIRST ═══════════════════
          A live withdrawal once existed for hours that NOBODY COULD SEE IN THE APP. Read-only:
          it renders what /api/ub-withdraw already returns.

          ⚠️ IT USED TO SIT INSIDE THE BALANCE CARD, and the reason given was that "what's in
          here" and "what's on its way out" are one question. That reason is still true of the
          PENDING ROWS — but this block is not only rows: it also carries the START-WITHDRAWAL
          form, and an action. Left in the balance card it put WITHDRAW above DEPOSIT, which
          reads backwards on a page whose first job is funding.
          ⛔ SO THE MOVE HAS A COST, STATED: the pending rows now sit one section away from the
          balance they belong to. That is the tradeoff, and it is resolved properly by the tab
          split (Deposit | Withdraw) that is the next slice — where the ROWS can stay with the
          balance as state and the FORM moves into the action. Until then, ordering the two
          actions correctly is worth more than keeping the rows adjacent. */}
      {bal.status === "ready" && (
        <UbExitStatus token={() => w.ensureSession()} reloadKey={reloadKey} />
      )}

      {/* Owner address — the agent wallet the unified balance is keyed to (the
          depositor). Masked + expand + copy via AddressDisplay. ONE address only;
          the delegate signer is server-side and never surfaced. */}
      {data?.depositor && (
        <div
          className="status"
          style={{
            marginTop: 12,
            padding: "12px 16px",
            background: "var(--field)",
            border: "1px solid var(--line)",
            borderRadius: 12,
          }}
        >
          <div
            style={{
              color: "var(--muted)",
              fontSize: "0.72rem",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Agent wallet · unified balance owner
          </div>
          <AddressDisplay address={data.depositor} />
        </div>
      )}

      {/* ═══ ⭐⭐ HOW THIS WORKS — THE EXPLANATION ZONE, AT THE END ══════════════════════════
          Restored from the June single-file design (TestArc/tikpema-deploy), which already had
          the shape this page had drifted away from: header -> balance -> action -> explanation,
          with the explanation as its OWN numbered card rather than dissolved into the state
          bullet and the deposit card. That dissolution is what made the page feel cluttered:
          the same three depths rendered in every place any one of them was needed.

          ⚠️ THE JUNE CARD'S CONTENT COULD NOT BE REUSED, ONLY ITS SHAPE. It said "Circle CCTP
          routes it to your unified pool in ~20 seconds" and "Spend without bridging" — true of
          the June premise, false of what ships now: a pool whose exit takes about seven days and
          runs through us. The page did not get heavier from bad writing; it accumulated three
          true things the original structure had no slot for.

          ⛔ WHAT IS NOT HERE, AND DELIBERATELY:
            · CUSTODY stays at the deposit button. A user pressing Deposit needs it AT THE PRESS,
              not in a card they may never scroll to. verify-unified-balance-copy §5 pins it there.
            · The DATED EVIDENCE stays behind the "about seven days" affordance, at the number it
              is evidence for. Moving it here would put it one scroll away from the claim, which
              is the constraint the affordance exists to satisfy. */}
      <div
        className="status"
        style={{
          marginTop: 16,
          padding: "14px 16px",
          background: "var(--field)",
          border: "1px solid var(--line)",
          borderRadius: 12,
        }}
      >
        <div className="panel-eyebrow" style={{ marginBottom: 10 }}>How this works</div>
        <ol style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 8 }}>
          <li className="sub" style={{ margin: 0 }}>
            {/* ⛔ THE "one pocket you cannot exit on your own" CLAUSE IS THE LADDER'S, NOT THIS
                CARD'S. Saying it here too put the page's central warning in two places — and the
                ladder makes it as a COMPARISON, which is the form that actually informs. */}
            <b>Deposit from your agent's own balance.</b> Your agent's plain Arc USDC moves into
            its unified balance. Nothing leaves your agent.
          </li>
          <li className="sub" style={{ margin: 0 }}>
            <b>One balance, spendable across chains.</b> The pool is visible wherever your agent
            spends, so it does not matter which chain the funds came from.
          </li>
          <li className="sub" style={{ margin: 0 }}>
            {/* ⭐ THE MECHANISM, MOVED OUT OF THE DEPOSIT CARD'S COLLAPSED SPAN AND OUT OF THE
                STATE BULLET — it now appears exactly ONCE, in the zone that explains. */}
            {/* ⭐⭐ THE AFFORDANCE MOVED HERE WITH THE NUMBER. It used to sit in the deposit
                card, because that is where the seven-day claim was. The claim now lives here, and
                the constraint is unchanged: the evidence must be reachable WHEREVER THE NUMBER
                RENDERS, and pressing the number is what reveals it — never a detached link.
                ⚠️ RESIDUAL, STATED: the withdraw block below states the wait too and carries no
                affordance. It is a separate component and out of scope for this slice; when the
                tabs land, the two should share one control. */}
            <b>Getting it out is slower.</b> You ask; Arc's Gateway holds the funds for a delay of{" "}
            <button
              type="button"
              className="linkbtn"
              aria-expanded={showEvidence}
              aria-controls="ub-exit-evidence"
              onClick={() => setShowEvidence((v) => !v)}
            >
              about seven days
            </button>
            ; it then lands in your agent's balance, which you can withdraw yourself. The wait is
            set by Arc's Gateway, not by us.{" "}
            <span id="ub-exit-evidence" hidden={!showEvidence}>
              <b>⚠️ This has now been done once, end to end</b>: 1 USDC asked for on 2026-08-12 and
              returned automatically on 2026-08-20 — one real run, not a track record, and it took
              7 days and 4 hours, longer than the estimate, so treat the wait as a floor.{" "}
              <b>It is built now:</b> we finish it automatically — <b>you do not have to come
              back</b>. Deposit only what you intend the agent to spend.
            </span>
          </li>
        </ol>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <button className="linkbtn" onClick={() => go("dashboard")}>
          ← Back to dashboard
        </button>
      </div>
    </div>
  );
}
