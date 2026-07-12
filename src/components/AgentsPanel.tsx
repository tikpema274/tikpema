import { useCallback, useEffect, useState } from "react";
import SignInPrompt from "./SignInPrompt";
import type { useWallet } from "../wallet/useWallet";

type UnifiedWallet = ReturnType<typeof useWallet>;

// AgentsPanel — the ROSTER. Today it renders two agents; Brick 2's analysts + synthesizer, a
// vetting gate and an x402 hiring agent become entries in _agents.mjs and appear here with no
// change to this component. The data shape is built for N, so the page never needs a redesign.
//
// ⚠️ THE TRUST DISTINCTION LEADS. The Researcher CANNOT move funds; the Executor CAN. That is
// the single most important thing a user can know about an agent that holds a wallet, so it is
// a badge at the top of each card — not a sentence buried in a description. Everything else on
// the card (what it does, what it spent, the pause switch) is secondary to that one fact.

type Agent = {
  id: string;
  label: string;
  description: string;
  spends: string;
  movesFunds: boolean;
  paused: boolean | null; // null = we could not read the switch — "unknown", never "running"
  pausedByAll: boolean;
  spentTodayUsdc: number;
  actionsToday: number;
  blockedToday: number;
};
type ActivityEntry = {
  agent: string;
  source?: string;
  amountUsdc?: number;
  allowed?: boolean;
  reason?: string;
  justification?: string;
  timestamp?: string;
};
type Roster = {
  owner: string;
  agents: Agent[];
  allPaused: boolean;
  halted: string | null;
  budget: { spentTodayUsdc: number | null; ceilingUsdc: number; remainingUsdc: number | null };
  activity: ActivityEntry[];
};

const money = (n?: number) => (n === undefined || n === null ? "—" : n.toFixed(n < 1 ? 4 : 2));
const time = (ts?: string) => (ts ? new Date(ts).toLocaleTimeString() : "");

export default function AgentsPanel({ wallet: w }: { wallet: UnifiedWallet }) {
  const [data, setData] = useState<Roster | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string>(""); // the agent id currently toggling
  const authed = w.isAuthenticated;

  const load = useCallback(async () => {
    if (!authed) return;
    try {
      const token = await w.ensureSession();
      const r = await fetch("/api/agents", { headers: { Authorization: `Bearer ${token}` } });
      if (r.status === 202) return; // wallet still provisioning — the poll will catch it
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "Could not load your agents");
      setData(d);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your agents");
    }
  }, [authed, w]);

  useEffect(() => {
    if (!authed) return;
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [authed, load]);

  async function toggle(agent: string, paused: boolean) {
    setBusy(agent);
    setError("");
    try {
      const token = await w.ensureSession();
      const r = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent, paused }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "Could not change the switch");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the switch");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="plane">
      <div className="panel-eyebrow">Your agents</div>
      <h2>Who acts for you, and what each one may touch.</h2>
      <div className="sub">
        Each agent has a job and a boundary. <b>Only one of them can move your money</b> — and
        you can stop any of them, instantly, at any time.
      </div>

      {!authed && (
        <div style={{ marginTop: 14 }}>
          <SignInPrompt wallet={w} message="Sign in to see your agents." onSignedIn={load} />
        </div>
      )}

      {/* An operator halt overrides every switch. Say so loudly rather than showing agents as
          "running" while nothing will actually run. */}
      {data?.halted && (
        <div
          className="status"
          style={{
            marginTop: 14, padding: "12px 14px", borderRadius: 12,
            background: "var(--field)", border: "1px solid var(--danger, #e5484d)",
          }}
        >
          ⚠ {data.halted}
        </div>
      )}

      {authed && data && (
        <>
          {/* Today's budget — one ceiling shared by every agent. */}
          <div
            className="status"
            style={{
              marginTop: 14, padding: "12px 16px", background: "var(--field)",
              border: "1px solid var(--line)", borderRadius: 12,
            }}
          >
            <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
              <div>
                Spent today{" "}
                <span className="mono" style={{ color: "var(--paper)" }}>
                  {money(data.budget.spentTodayUsdc ?? 0)}
                </span>{" "}
                of <span className="mono">{data.budget.ceilingUsdc}</span> USDC
              </div>
              <button
                className="linkbtn"
                disabled={busy === "*"}
                onClick={() => toggle("*", !data.allPaused)}
              >
                {busy === "*" ? "…" : data.allPaused ? "Resume all agents" : "Pause all agents"}
              </button>
            </div>
            <div className="sub" style={{ margin: "6px 0 0" }}>
              One daily ceiling, shared across every agent. When it's reached, they all stop.
            </div>
          </div>

          {/* THE ROSTER. One card per agent — add an agent, get a card. */}
          {data.agents.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              busy={busy === a.id}
              onToggle={() => toggle(a.id, !a.paused)}
            />
          ))}

          <div className="panel-eyebrow" style={{ marginTop: 22 }}>Recent activity</div>
          <div className="sub" style={{ margin: "2px 0 8px" }}>
            Everything your agents spent — and everything a guard refused. Refusals are shown
            too: "it tried, and the cap stopped it" is the part worth seeing.
          </div>
          {data.activity.length === 0 ? (
            <div className="sub">Nothing yet today.</div>
          ) : (
            <div className="status" style={{ padding: 0, background: "transparent", border: 0 }}>
              {data.activity.map((e, i) => (
                <div
                  key={i}
                  className="row"
                  style={{
                    justifyContent: "space-between", gap: 10, padding: "8px 0",
                    borderBottom: "1px solid var(--line)", alignItems: "baseline", flexWrap: "wrap",
                  }}
                >
                  <div>
                    <span style={{ color: e.allowed ? "var(--paper)" : "var(--danger, #e5484d)" }}>
                      {e.allowed ? "" : "refused · "}
                      {e.source ?? "action"}
                    </span>{" "}
                    <span className="sub">by {e.agent}</span>
                    {!e.allowed && e.reason && (
                      <div className="sub" style={{ margin: "2px 0 0" }}>{e.reason}</div>
                    )}
                  </div>
                  <div className="sub">
                    <span className="mono">{money(e.amountUsdc)}</span> USDC · {time(e.timestamp)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {error && (
        <div className="sub" style={{ margin: "12px 0 0", color: "var(--danger, #e5484d)" }}>
          {error}
        </div>
      )}
    </div>
  );
}

function AgentCard({ agent: a, busy, onToggle }: { agent: Agent; busy: boolean; onToggle: () => void }) {
  const paused = a.paused === true;
  const unknown = a.paused === null;

  return (
    <div
      className="status"
      style={{
        marginTop: 12, padding: "14px 16px", background: "var(--field)",
        border: `1px solid ${paused ? "var(--danger, #e5484d)" : "var(--line)"}`,
        borderRadius: 12,
      }}
    >
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: "1.05rem", color: "var(--paper)" }}>{a.label}</div>
        <div className="sub">
          {unknown ? "status unknown" : paused ? "PAUSED" : "running"}
          {a.pausedByAll && paused && " (all agents)"}
        </div>
      </div>

      {/* ⚠️ THE TRUST BADGE — the first thing on the card, deliberately. This is what makes an
          autonomous agent with a wallet feel safe (or correctly unsafe). */}
      <div
        style={{
          marginTop: 8, padding: "8px 10px", borderRadius: 8, display: "inline-block",
          border: `1px solid ${a.movesFunds ? "var(--amber)" : "var(--line)"}`,
          background: a.movesFunds ? "var(--amber-soft)" : "transparent",
          color: "var(--paper)", fontSize: "0.85rem",
        }}
      >
        {a.movesFunds ? "⚠ Can move your money" : "🔒 Cannot move your money"}
      </div>

      <div className="sub" style={{ margin: "10px 0 0" }}>{a.description}</div>

      <div className="row" style={{ marginTop: 10, gap: 16, flexWrap: "wrap", alignItems: "baseline" }}>
        <div className="sub">
          Today: <span className="mono">{money(a.spentTodayUsdc)}</span> USDC ·{" "}
          {a.actionsToday} action{a.actionsToday === 1 ? "" : "s"}
          {a.blockedToday > 0 && (
            <> · <span style={{ color: "var(--danger, #e5484d)" }}>{a.blockedToday} refused</span></>
          )}
        </div>
        <button
          className={paused ? "emerald" : "linkbtn"}
          disabled={busy || a.pausedByAll}
          onClick={onToggle}
          title={a.pausedByAll ? "All agents are paused — resume all first" : undefined}
        >
          {busy ? "…" : paused ? `Resume ${a.label}` : `Pause ${a.label}`}
        </button>
      </div>
    </div>
  );
}
