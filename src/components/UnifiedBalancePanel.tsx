import { useState } from "react";
import AddressDisplay from "./AddressDisplay";
import SignInPrompt from "./SignInPrompt";
import { useGatewayBalance } from "../lib/useGatewayBalance";
import type { useWallet } from "../wallet/useWallet";

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
// the one pocket the user cannot exit unilaterally. agent-withdraw returns balanceOf(SCA)
// (plain USDC); Gateway funds are not in that number and need initiateWithdrawal +
// withdrawalDelay + withdraw, server-side. So this page ranks the three pockets by what the
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
      const d = await r.json().catch(() => null);
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
      const d = await r.json().catch(() => null);
      // Synchronous rejections (over-cap 400, insufficient funds 402, auth 401) — nothing
      // was kicked off, so report and stop.
      if (!r.ok) throw new Error(d?.error || "Deposit failed");
      if (!d?.depositId) {
        // 202 "provisioning" — the wallet mapping hasn't converged yet.
        throw new Error(d?.message || "Your wallet is being set up — try again shortly.");
      }

      setFundStage("Depositing on-chain…");
      const done = await pollDeposit(d.depositId, token);

      if (done.status === "failed") {
        // A failed delegate grant is a CLEAN state: it runs before any approve, so no funds
        // moved. Say so plainly rather than leaving the user wondering where their USDC went.
        throw new Error(
          done.delegateAuthFailed
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
            unified        → NOT balanceOf(SCA). Needs initiateWithdrawal +
                             withdrawalDelay + withdraw, server-side. Not unilateral.

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
            balance is loading / signed-out — never to a "—" that reads as an error. */}
        <div className="sub" style={{ margin: "6px 0 0", color: "var(--warn, #f0b866)" }}>
          <b>Your unified balance</b>
          {data && Number(data.total) > 0 && (
            <>
              {" "}
              (<span className="mono">{data.total}</span> USDC)
            </>
          )}{" "}
          — committed to your agent's float. Withdraw does not move it: releasing it from
          Gateway is time-delayed and goes through the server. It is not lost, but it is the
          one pocket you cannot pull back on your own.
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
        {/* The old copy here read "the funds stay owned by your agent — this is a deposit,
            not a transfer to anyone else." True, and MISLEADING: it answers "is anyone
            stealing this?" when the question the user actually needs answered is "can I get
            it back?" Depositing is the one move on this page that TRADES AWAY a unilateral
            exit. Say that at the point of commitment, not in the small print. */}
        <div className="sub" style={{ margin: "0 0 10px" }}>
          Move USDC from your agent's plain balance into its unified balance. Nobody else can
          touch it — but this is a <b>commitment</b>, not a parking spot: once it is in
          Gateway you can no longer pull it back yourself with Withdraw. Releasing it is
          time-delayed and goes through the server. Deposit what you mean to give the agent
          to work with.
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
          <div className="sub" style={{ margin: "8px 0 0", color: "var(--danger, #e5484d)" }}>
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
