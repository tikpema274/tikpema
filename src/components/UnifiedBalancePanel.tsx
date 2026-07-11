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
// plain Arc USDC — self-custody, nothing is sent to a third party. That deposit ALSO
// performs the one-time delegate grant (server-side, inside ubDeposit, after the funds
// check) — which is why the SCA must hold USDC first (hop A, on the My Agent page).
export default function UnifiedBalancePanel({ wallet: w }: { wallet: UnifiedWallet }) {
  // Funding form state.
  const [amount, setAmount] = useState("");
  const [funding, setFunding] = useState(false);
  const [fundError, setFundError] = useState("");
  const [fundOk, setFundOk] = useState<{ amountUsdc: number; tx: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const bal = useGatewayBalance(w, reloadKey);
  const data = bal.status === "ready" ? bal : null;
  // A brand-new user reads a true 0 — the signal to fund, not an error.
  const isEmpty = data != null && Number(data.total) === 0;

  // Fund — a money-path write. The server re-checks auth AND the cap before anything
  // signs; this handler only shapes the request and reports what came back.
  async function fund() {
    const amountNum = Number(amount);
    if (!(amountNum > 0)) {
      setFundError("Enter an amount greater than 0.");
      return;
    }
    setFunding(true);
    setFundError("");
    setFundOk(null);
    try {
      const token = await w.ensureSession();
      const r = await fetch("/api/agent-ub-deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ amountUsdc: amountNum }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error || "Deposit failed");
      setFundOk({ amountUsdc: d.amountUsdc, tx: d.tx });
      setAmount("");
      setReloadKey((k) => k + 1); // re-read the balance we just changed
    } catch (e) {
      setFundError(e instanceof Error ? e.message : "Deposit failed");
    } finally {
      setFunding(false);
    }
  }

  return (
    <div className="plane">
      <div className="panel-eyebrow">Unified balance</div>
      <h2>One USDC balance, across chains.</h2>
      <div className="sub">
        Your agent holds a single unified USDC balance that spans multiple chains
        via Circle Gateway. This view reads it live across Arc Testnet and Base
        Sepolia — no seed phrase, no bridging to check a total.
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
        <div className="sub" style={{ margin: "0 0 10px" }}>
          Move USDC from your agent's wallet into its unified balance. The funds stay owned
          by your agent — this is a deposit, not a transfer to anyone else. The first
          deposit also authorizes the Gateway spender for you, once.
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
