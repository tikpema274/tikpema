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
      <div className="sub">
        This is the float <b>you chose to commit</b> to your agent: USDC you moved out of
        your own wallet, into your agent's, and then into Circle Gateway — where it spans
        multiple chains at once. This view reads it live across Arc Testnet and Base
        Sepolia — no seed phrase, no bridging to check a total.
      </div>

      {/* WHAT YOU CAN GET BACK — the reversibility ladder, stated before we ask for a
          deposit rather than after.

          This block exists because the copy it replaces did the opposite of its job: it
          said the funds "stay owned by your agent — a deposit, not a transfer to anyone
          else," which READS as reassurance while describing the ONE pocket the user
          cannot exit on their own. The three pockets have genuinely different exits, and
          the unified balance has the worst one:

            wallet (MSCA)  → the user holds the key. Unilateral, always.
            agent's plain  → agent-withdraw returns balanceOf(SCA). One button, no delay.
            unified        → NOT balanceOf(SCA). NO EXIT AT ALL. No endpoint returns it, and
                             the SCA is dev-controlled so the user cannot act directly.
                             Spendable cross-chain only.

          So we rank them by what the user can get back ALONE, and the amber line is the
          same one that sits on the Withdraw button (MyAgentPanel) — one fact, one voice,
          wherever the user meets it. Do not soften this to make the deposit easier. */}
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
            marginBottom: 8,
          }}
        >
          What you can get back · and how
        </div>

        <div className="sub" style={{ margin: 0 }}>
          <b>Your wallet</b> — yours. You hold the key. Withdraw any time, even if the agent
          is paused.
        </div>
        <div className="sub" style={{ margin: "6px 0 0" }}>
          <b>Your agent's plain balance</b> — pull it back yourself with{" "}
          <button className="linkbtn" onClick={() => go("agent")}>
            Withdraw to my wallet
          </button>
          . One button, no delay, no permission needed.
        </div>
        {/* Name the ACTUAL number when we have one. "You cannot pull this back on your own"
            lands differently at 12.50 USDC than in the abstract, and the user is entitled to
            see the figure the sentence is about. Falls back to unqualified prose while the
            balance is loading / signed-out — never to a "—" that reads as an error.

            ⚠️ "about seven days" is DERIVED, never fixed. withdrawalDelay() returns 1209600
            and that is a BLOCK COUNT, not seconds — ~7.14 days at Arc's measured ~0.5097 s/block,
            which is why the SDK's own prose says "7-day" in five places. Reading it as seconds
            gives 14 days, a tidy-looking wrong answer. If block time drifts, the wall clock
            drifts with it — so this must never harden into a promised number. */}
        <div className="sub" style={{ margin: "6px 0 0", color: "var(--warn)" }}>
          <b>Your unified balance</b>
          {data && Number(data.total) > 0 && (
            <>
              {" "}
              (<span className="mono">{data.total}</span> USDC)
            </>
          )}{" "}
          — committed to your agent's float. Withdraw doesn't move it — getting it out is a
          separate, slower route, shown below. Only your agent's own account can release these funds, and{" "}
          <b>Tikpema controls that account</b> — so the exit runs through us. <b>It is built
          now:</b> you ask, Arc's Gateway holds the funds for a delay of about seven days, and
          we finish it automatically — <b>you do not have to come back</b>. It lands in your
          agent's balance, which you can then withdraw yourself. <b>⚠️ This has now been done once, end
          to end</b>: 1 USDC asked for on 2026-08-12 and returned automatically on 2026-08-20, with nobody
          watching — one real run, not a track record. It took 7 days and 4 hours, longer than the
          estimate, so treat the wait as the floor rather than the ceiling, and deposit only what you
          intend the agent to spend.
        </div>
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

        {/* ═══ ⭐ THE EXIT, VISIBLE ═══════════════════════════════════════════════════════
            A live withdrawal existed for hours that NOBODY COULD SEE IN THE APP. Read-only:
            it renders what /api/ub-withdraw already returns. Sits inside the balance card
            because "what's in here" and "what's on its way out" are one question. */}
        {bal.status === "ready" && (
          <UbExitStatus token={() => w.ensureSession()} reloadKey={reloadKey} />
        )}
      </div>

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
          <b>Money goes in instantly and takes about seven days to come back out.</b>{" "}
          You can't withdraw it yourself: the balance belongs to your agent's account, and
          only that account can release these funds.{" "}
          <b>Tikpema controls that account</b> — so the exit runs through us. <b>It is built
          now:</b> you ask, Arc's Gateway holds the funds for a delay of about seven days, and
          we finish it automatically — <b>you do not have to come back</b>. <b>⚠️ This has now been done
          once, end to end</b>: 1 USDC asked for on 2026-08-12 and returned automatically on 2026-08-20
          — one real run, not a track record, and it took 7 days and 4 hours, longer than the estimate,
          so treat the wait as a floor. Deposit only what you intend the agent to spend.
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

      <div className="row" style={{ marginTop: 16 }}>
        <button className="linkbtn" onClick={() => go("dashboard")}>
          ← Back to dashboard
        </button>
      </div>
    </div>
  );
}
