import { useCallback, useEffect, useState } from "react";
import SignInPrompt from "./SignInPrompt";
import type { useWallet } from "../wallet/useWallet";

type UnifiedWallet = ReturnType<typeof useWallet>;

// AgentsPanel — the ROSTER, as a 3-across grid (the Dashboard's `.quick` shape).
//
// WHY A GRID, NOT A STACK. Agents arrive gradually — Brick 2's Analyst B + Synthesizer, later
// an x402 hiring agent and the vetting gates. Stacked full-width cards stop being scannable at
// ~4 and would force a redesign; a grid wraps to rows of 3 and scales to N for free. It also
// makes the roster read as what it IS: agents lined up side by side.
//
// ⚠️ THE `movesFunds` BADGE IS NON-NEGOTIABLE. It must stay legible at grid width, because it
// is the most important thing on this page: the Researcher CANNOT move your money; the
// Executor CAN. Everything else on a card — the long description, that agent's own activity —
// is secondary and moves behind a tap, so the roster stays scannable at six agents, not two.
//
// Reuses `.quick` / `.quick-card` / `.qt` / `.qd` from styles.css (already 3-across, already
// collapsing to 1-across under 760px). No new classes. Note the card is a <div>, not the
// <button> the Dashboard uses — a card contains a Pause button, and a button inside a button
// is invalid HTML.

type Agent = {
  id: string;
  label: string;
  description: string;
  spends: string;
  movesFunds: boolean;
  paused: boolean | null; // null = the switch could not be read — "unknown", never "running"
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

const money = (n?: number | null) => (n === undefined || n === null ? "—" : n.toFixed(n < 1 ? 4 : 2));
const time = (ts?: string) => (ts ? new Date(ts).toLocaleTimeString() : "");

// One short line per agent for the card. The full description lives in the expanded detail —
// a roster that makes you read a paragraph per agent is not a roster.
const ONE_LINER: Record<string, string> = {
  researcher: "Retrieves sources and writes your brief. Buys data within its allowance.",
  executor: "Sends, swaps, bridges and pays — only what you approved.",
};

export default function AgentsPanel({ wallet: w }: { wallet: UnifiedWallet }) {
  const [data, setData] = useState<Roster | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");            // the agent id currently toggling
  const [expanded, setExpanded] = useState<string | null>(null); // the agent whose detail is open
  const authed = w.isAuthenticated;

  const load = useCallback(async () => {
    if (!authed) return;
    try {
      const token = await w.ensureSession();
      const r = await fetch("/api/agents", { headers: { Authorization: `Bearer ${token}` } });
      if (r.status === 202) return; // wallet still provisioning — the poll will pick it up
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
      // Optimistic: Blobs is eventually consistent (~11s), so an immediate re-read can still
      // return the OLD state and make a working switch look flaky. Enforcement is already
      // immediate server-side; this just keeps the VIEW honest until the read catches up.
      setData((prev) =>
        prev
          ? {
              ...prev,
              allPaused: agent === "*" ? paused : prev.allPaused,
              agents: prev.agents.map((a) =>
                agent === "*"
                  ? { ...a, paused: paused ? true : false, pausedByAll: paused }
                  : a.id === agent
                  ? { ...a, paused }
                  : a
              ),
            }
          : prev
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the switch");
    } finally {
      setBusy("");
    }
  }

  const open = data?.agents.find((a) => a.id === expanded) ?? null;

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
          {/* ── The daily ceiling: ONE budget, shared by every agent. ── */}
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
              <button className="linkbtn" disabled={busy === "*"} onClick={() => toggle("*", !data.allPaused)}>
                {busy === "*" ? "…" : data.allPaused ? "Resume all agents" : "Pause all agents"}
              </button>
            </div>
            <div className="sub" style={{ margin: "6px 0 0" }}>
              One daily ceiling, shared across every agent. When it's reached, they all stop.
            </div>
          </div>

          {/* ── THE ROSTER GRID. Add an agent to _agents.mjs, get a card. Wraps at 3. ── */}
          <div className="quick" style={{ marginTop: 14 }}>
            {data.agents.map((a) => (
              <RosterCard
                key={a.id}
                agent={a}
                busy={busy === a.id}
                open={expanded === a.id}
                onToggle={() => toggle(a.id, !a.paused)}
                onExpand={() => setExpanded(expanded === a.id ? null : a.id)}
              />
            ))}
          </div>

          {/* ── DETAIL: the long description + that agent's own activity, behind a tap. ── */}
          {open && (
            <AgentDetail
              agent={open}
              activity={data.activity.filter((e) => e.agent === open.id)}
              onClose={() => setExpanded(null)}
            />
          )}

          {/* ── RECENT ACTIVITY (all agents) — refusals included, deliberately. ── */}
          <div className="panel-eyebrow" style={{ marginTop: 22 }}>Recent activity</div>
          <div className="sub" style={{ margin: "2px 0 8px" }}>
            Everything your agents spent — and everything a guard refused. Refusals are shown
            too: "it tried, and the cap stopped it" is the part worth seeing.
          </div>
          {data.activity.length === 0 ? (
            <div className="sub">Nothing yet today.</div>
          ) : (
            <ActivityList entries={data.activity} showAgent />
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

// ── A compact roster card. Priority order is deliberate and fixed:
//    1. name · 2. movesFunds badge · 3. one line · 4. today's spend · 5. pause control
function RosterCard({
  agent: a, busy, open, onToggle, onExpand,
}: {
  agent: Agent; busy: boolean; open: boolean; onToggle: () => void; onExpand: () => void;
}) {
  const paused = a.paused === true;
  const unknown = a.paused === null;

  return (
    <div
      className="quick-card"
      style={{
        display: "flex", flexDirection: "column", gap: 8,
        // A paused agent is visibly, unmistakably stopped.
        borderColor: paused ? "var(--danger, #e5484d)" : undefined,
        opacity: paused ? 0.75 : 1,
      }}
    >
      {/* 1. NAME */}
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
        <div className="qt" style={{ marginBottom: 0 }}>{a.label}</div>
        <div className="qd" style={{ fontSize: "0.72rem" }}>
          {unknown ? "unknown" : paused ? "PAUSED" : "running"}
        </div>
      </div>

      {/* 2. THE BADGE — the most important thing on the page. Kept legible at grid width:
             its own line, bordered, amber when it CAN move money. Never truncated. */}
      <div
        style={{
          padding: "5px 8px", borderRadius: 7, fontSize: "0.73rem", lineHeight: 1.3,
          border: `1px solid ${a.movesFunds ? "var(--amber)" : "var(--line)"}`,
          background: a.movesFunds ? "var(--amber-soft)" : "transparent",
          color: "var(--paper)",
        }}
      >
        {a.movesFunds ? "⚠ Can move your money" : "🔒 Cannot move your money"}
      </div>

      {/* 3. ONE LINE — the long description lives in the detail view. */}
      <div className="qd">{ONE_LINER[a.id] ?? a.spends}</div>

      {/* 4. TODAY */}
      <div className="qd" style={{ color: "var(--paper)" }}>
        <span className="mono">{money(a.spentTodayUsdc)}</span> USDC ·{" "}
        {a.actionsToday} action{a.actionsToday === 1 ? "" : "s"}
        {a.blockedToday > 0 && (
          <> · <span style={{ color: "var(--danger, #e5484d)" }}>{a.blockedToday} refused</span></>
        )}
      </div>

      {/* 5. CONTROLS */}
      <div className="row" style={{ gap: 10, marginTop: "auto", paddingTop: 4, alignItems: "baseline" }}>
        <button
          className={paused ? "emerald" : "linkbtn"}
          disabled={busy || a.pausedByAll}
          onClick={onToggle}
          title={a.pausedByAll ? "All agents are paused — resume all first" : undefined}
        >
          {busy ? "…" : paused ? "Resume" : "Pause"}
        </button>
        <button className="linkbtn" onClick={onExpand}>
          {open ? "Hide details" : "Details"}
        </button>
      </div>
    </div>
  );
}

// The expanded view: the FULL description and this agent's own activity. Lives below the grid
// so the roster stays scannable however many agents there are.
function AgentDetail({
  agent: a, activity, onClose,
}: {
  agent: Agent; activity: ActivityEntry[]; onClose: () => void;
}) {
  return (
    <div
      className="status"
      style={{
        marginTop: 14, padding: "14px 16px", background: "var(--field)",
        border: "1px solid var(--amber-line, var(--line))", borderRadius: 12,
      }}
    >
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontSize: "1.05rem", color: "var(--paper)" }}>{a.label}</div>
        <button className="linkbtn" onClick={onClose}>Close</button>
      </div>

      <div className="sub" style={{ margin: "8px 0 0" }}>{a.description}</div>
      <div className="sub" style={{ margin: "8px 0 0", fontStyle: "italic" }}>{a.spends}</div>

      <div className="panel-eyebrow" style={{ marginTop: 14 }}>What {a.label} did today</div>
      {activity.length === 0 ? (
        <div className="sub" style={{ marginTop: 4 }}>Nothing yet today.</div>
      ) : (
        <ActivityList entries={activity} />
      )}
    </div>
  );
}

// Shared activity renderer — refusals are first-class, not hidden. "It tried, and the cap
// stopped it" is precisely what an observability surface exists to show.
function ActivityList({ entries, showAgent }: { entries: ActivityEntry[]; showAgent?: boolean }) {
  return (
    <div>
      {entries.map((e, i) => (
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
            </span>
            {showAgent && <span className="sub"> by {e.agent}</span>}
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
  );
}
