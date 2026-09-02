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
// is the most important thing on this page: it is where a user learns that the Researcher CAN
// move their money (it buys data with their USDC) and the Second opinion cannot. Everything
// else on a card — the long description, that agent's own activity — is secondary and moves
// behind a tap, so the roster stays scannable at six agents, not two.
//
// (This comment used to read "the Researcher CANNOT move your money; the Executor CAN" — the
// same falsehood the registry audit removed from the card copy, left behind in the doc of the
// invariant. A stale comment about a money claim is how the next reader recreates the bug.)
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
  route?: string | null; // the agent's own page, from the registry. null/absent = it has none.
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
  // ⭐ BOOKKEEPING ROWS CARRY A `kind`, AND THE TRAIL MUST READ IT. The sweeper appends
  // `resolution` (a charge retired from its queue) and `reversal` (a submit-time charge undone)
  // into the SAME audit trail as real actions. They are not actions and not refusals.
  kind?: string;
  outcome?: string;       // resolution only — what the resolver actually observed
  timestamp?: string;
};
type Roster = {
  owner: string;
  agents: Agent[];
  allPaused: boolean;
  halted: string | null;
  budget: { spentTodayUsdc: number | null; ceilingUsdc: number; remainingUsdc: number | null };
  activity: ActivityEntry[];
  // ⭐ Optional: an older server that does not send it leaves the flag undefined, which renders as
  // "nothing yet" exactly as before — a missing field must not itself become a false alarm.
  activityUnreadable?: boolean;
  breakdownUnreadable?: boolean;
};

const money = (n?: number | null) => (n === undefined || n === null ? "—" : n.toFixed(n < 1 ? 4 : 2));
const time = (ts?: string) => (ts ? new Date(ts).toLocaleTimeString() : "");

// ⚠️ THE HEADLINE COUNTS THE CARDS. It never states a number of its own.
//
// It read "Only one of them can move your money" — true when the roster was Researcher +
// Executor and the Researcher was (wrongly) believed to be read-only. The registry audit then
// flipped the Researcher to movesFunds: true, and the Vault agent arrived a third mover, and
// the headline sat there asserting "only one" directly above THREE ⚠ badges saying otherwise.
// It was the reassuring claim, and it was the false one.
//
// So the summary is derived from the same `agents` array the badges render from. It cannot
// disagree with the cards, because it is counting them. Add a fifth agent and this sentence
// updates itself — no one has to remember it exists. A hand-written number here is a second
// source of truth for a money claim, and this file already has the post-mortem for that.
function moversClaim(movers: number, total: number): string {
  if (movers === 0) return "None of them can move your money";
  if (movers === total) return `All ${total} of them can move your money`;
  return `${movers} of these ${total} can move your money`;
}

// ⚠️ REMOVED: a hardcoded ONE_LINER map that rendered INSTEAD of the roster's own `spends`
// string (`ONE_LINER[a.id] ?? a.spends` — the map always won for researcher/executor).
//
// It was a SECOND source of truth for a money claim, and it went stale exactly as you would
// expect: the registry was corrected to say the Researcher spends your USDC, the API served
// that, the ⚠ badge flipped to "Can move your money" — and the card underneath still read
// "Buys data within its allowance", because it never consulted the API at all. The corrected
// copy was only visible if you expanded Details.
//
// The card now renders `a.spends` straight from the roster. One registry owns what an agent
// does with your money; every view reads it. A duplicate that agrees today is still the bug.

export default function AgentsPanel({ wallet: w }: { wallet: UnifiedWallet }) {
  const [data, setData] = useState<Roster | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");            // the agent id currently toggling
  const [expanded, setExpanded] = useState<string | null>(null); // the agent whose detail is open
  // ═══ 🚨 A TOKEN IS NOT A SIGNED-IN USER ════════════════════════════════════════════════════
  // This was `w.isAuthenticated` alone. That is derived from a sessionStorage token
  // (`!!session && session.exp*1000 > Date.now()`) INDEPENDENTLY of whether a wallet is connected
  // in the UI — so a reload straight onto #/agents with a live token skipped the prompt and showed
  // the roster and the shared daily-ceiling line to someone the rest of the app renders as signed
  // out. ⛔ A page asserting what your agents did and what they spent, to a visitor with no wallet,
  // is worse than a page with no guard line at all.
  // ⭐ `SignInPrompt` already tells the two remedies apart — no wallet → "Connect a wallet" routing
  // to #/wallet; wallet but stale session → "Sign in" in place — so the fix is the GATE, not new
  // copy. [[absence-must-never-read-as-safe]]
  const authed = w.isAuthenticated && !!w.address;

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
        Each agent has a job and a boundary.{" "}
        {/* Signed out, the roster hasn't loaded and there is nothing to count — so the claim
            drops to the cautious, uncountable one. Never "only one" on an unknown: the same
            fail-safe direction as `paused: null` rendering "unknown" and never "running". */}
        <b>{data ? moversClaim(data.agents.filter((a) => a.movesFunds).length, data.agents.length)
              : "Some of them can move your money"}</b>{" "}
        — the badge on each card says which — and you can stop any of them, instantly, at any
        time.
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
            background: "var(--field)", border: "1px solid var(--danger)",
          }}
        >
          ⚠ {data.halted}
        </div>
      )}

      {authed && data && (
        <>
          <AgentsBudgetLine budget={data.budget} allPaused={data.allPaused} busy={busy}
            onToggleAll={() => toggle("*", !data.allPaused)} />

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
          {/* ⛔ "Nothing happened" and "we could not read what happened" are DIFFERENT CLAIMS and
              rendered identically until 2026-09-02. The empty list is the same `[]` either way, so
              the server now says which one it is (agents.mjs activityUnreadable). */}
          {data.activityUnreadable ? (
            <div className="sub" style={{ color: "var(--warn)" }}>
              We could not read today's activity — this list is empty because the read failed, not
              because nothing happened.
            </div>
          ) : data.activity.length === 0 ? (
            <div className="sub">Nothing yet today.</div>
          ) : (
            <ActivityList entries={data.activity} showAgent />
          )}
        </>
      )}

      {error && (
        <div className="sub" style={{ margin: "12px 0 0", color: "var(--danger)" }}>
          {error}
        </div>
      )}
    </div>
  );
}

// ── A compact roster card. Priority order is deliberate and fixed:
//    1. name · 2. movesFunds badge · 3. one line · 4. today's spend · 5. pause control
// ── The daily ceiling: ONE budget, shared by every agent. ──────────────────────────────────────
// ⭐ EXPORTED AND PURE so the roster's absence from a signed-out render can be CALIBRATED: an
// absence asserted against a render that could never contain the string is vacuous, and under
// renderToStaticMarkup no effect runs, so `data` is null and this block could not appear anyway.
// The suite renders THIS with a fixture to prove "Spent today" is detectable, which is what makes
// the absence assertion mean something. [[equality-passes-vacuously-on-empty]]
export function AgentsBudgetLine({
  budget, allPaused, busy, onToggleAll,
}: {
  budget: { spentTodayUsdc?: number | null; ceilingUsdc: number | string };
  allPaused: boolean; busy: string; onToggleAll: () => void;
}) {
  // ═══ 🚨 THREE STATES, AND `?? 0` COLLAPSED TWO OF THEM ═════════════════════
  // This rendered `money(budget.spentTodayUsdc ?? 0)`. The server deliberately sends `null` when the
  // day-spend read fails (agents.mjs) — and `?? 0` turned "we could not read your spending" into
  // "you have spent nothing", on the panel whose button is Pause All Agents.
  // ⛔ FAIL-OPEN IN THE REASSURING DIRECTION: an unknown figure shown as ample headroom.
  // ⭐ A figure, a confirmed zero, and an unreadable figure are three different things to someone
  // deciding whether to let an agent keep spending. Never `?? 0` a money field the server nulled.
  const spendUnknown = budget.spentTodayUsdc === null || budget.spentTodayUsdc === undefined;
  return (
    <div
      className="status"
      style={{
        marginTop: 14, padding: "12px 16px", background: "var(--field)",
        border: "1px solid var(--line)", borderRadius: 12,
      }}
    >
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <div>
          {spendUnknown ? (
            <>
              Spent today <span className="mono" style={{ color: "var(--warn)" }}>unknown</span> — we
              could not read it. The remaining headroom is <b>unknown, not ample</b>; pause the
              agents if you need certainty before they spend again.
            </>
          ) : (
            <>
              Spent today{" "}
              <span className="mono" style={{ color: "var(--paper)" }}>
                {money(budget.spentTodayUsdc as number)}
              </span>{" "}
              of <span className="mono">{budget.ceilingUsdc}</span> USDC
            </>
          )}
        </div>
        <button className="linkbtn" disabled={busy === "*"} onClick={onToggleAll}>
          {busy === "*" ? "…" : allPaused ? "Resume all agents" : "Pause all agents"}
        </button>
      </div>
      <div className="sub" style={{ margin: "6px 0 0" }}>
        One daily ceiling, shared across every agent. When it's reached, they all stop.
      </div>
    </div>
  );
}

export function RosterCard({
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
        borderColor: paused ? "var(--danger)" : undefined,
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

      {/* 3. ONE LINE — from the ROSTER, never a local copy. The long description lives in the
             detail view. This is the line that told users the Researcher could not move their
             funds; it says what the code does now because it reads the same source the code does. */}
      <div className="qd">{a.spends}</div>

      {/* 4. TODAY */}
      <div className="qd" style={{ color: "var(--paper)" }}>
        <span className="mono">{money(a.spentTodayUsdc)}</span> USDC ·{" "}
        {a.actionsToday} action{a.actionsToday === 1 ? "" : "s"}
        {a.blockedToday > 0 && (
          <> · <span style={{ color: "var(--danger)" }}>{a.blockedToday} refused</span></>
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
        {/* OPEN — only for an agent the registry gives a `route`, today just the Vault (#/vault).
            It is a SEPARATE control on purpose. "Details" means the same thing on all four cards
            (expand the description + activity in place, right here); if Vault's Details had
            quietly navigated away instead, one label would mean two things and the divergence
            would be invisible until a user clicked it. The special case is worth a word. */}
        {a.route && (
          <button className="linkbtn" onClick={() => { window.location.hash = "/" + a.route; }}>
            Open →
          </button>
        )}
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

// ═══ ⭐ THE LABEL A ROW MUST NOT BORROW ══════════════════════════════════════════════════════
// Shared by every branch, so a bookkeeping row with no `source` warns exactly like an action row
// with no `source` — one rule, not three copies that can drift apart.
const NO_TYPE = "⚠️ no action type recorded for this entry";

// Shared activity renderer — refusals are first-class, not hidden. "It tried, and the cap
// stopped it" is precisely what an observability surface exists to show.
//
// ═══ 🚨 BOOKKEEPING IS CLASSIFIED FIRST, BEFORE allowed/blocked ══════════════════════════════
// `agentBreakdown` (_budget.mjs) already branches on `kind` FIRST, with the reason stated at the
// call site: "Skipped FIRST so it can never fall through to the allowed/blocked branches and be
// mis-counted as an action or a refusal." That guarantee held on the SERVER and was never applied
// in the VIEW, so the same two rows the totals deliberately excluded were rendered as the very
// things the totals refused to call them:
//
//   · `kind:"resolution"` carries `allowed:false` and NO `source` — so it rendered RED, as
//     "refused · ⚠️ no action type recorded for this entry". Two false claims in one row: a guard
//     refused something (nothing was refused — a landed charge was retired from the sweeper's
//     queue), and the type was never recorded (it WAS, as `kind`). ⚠️ A real production row of
//     exactly this shape exists: 2026-08-22, `resolution-620e455e…`, outcome COMPLETE.
//   · `kind:"reversal"` carries `allowed:true` AND the original charge's `source` — so it rendered
//     as an ordinary white spend row, byte-identical to the charge it UNDOES. The trail showed two
//     identical positive rows while the total counted one. ⭐ The worse of the two: a wrong red row
//     invites a question, a plausible duplicate does not.
//
// ⭐ The producer, the totals and the UI are one chain, and a guarantee is only worth what its
// LAST link renders. Same shape as the refusal work itself — the substrate was built and the
// consumer never read it.
export function ActivityList({ entries, showAgent }: { entries: ActivityEntry[]; showAgent?: boolean }) {
  return (
    <div>
      {entries.map((e, i) => {
        // Classified FIRST — mirroring agentBreakdown. A `kind` we do not recognise is NOT
        // silently treated as an action: it falls through to the ordinary branches, where an
        // unknown source already renders as a stated gap rather than a plausible label.
        const bookkeeping = e.kind === "resolution" || e.kind === "reversal";
        return (
        <div
          key={i}
          className="row"
          style={{
            justifyContent: "space-between", gap: 10, padding: "8px 0",
            borderBottom: "1px solid var(--line)", alignItems: "baseline", flexWrap: "wrap",
          }}
        >
          <div>
            {/* ⭐ A bookkeeping row is muted, never red and never plain white: it is neither a
                refusal nor a spend, and the two colours already carry those meanings. */}
            {bookkeeping ? (
              <span className="sub">
                {e.kind === "resolution"
                  ? `bookkeeping · charge retired${e.outcome ? ` (${e.outcome})` : ""}`
                  : `bookkeeping · reversed · ${e.source ?? NO_TYPE}`}
              </span>
            ) : (
            <span style={{ color: e.allowed ? "var(--paper)" : "var(--danger)" }}>
              {e.allowed ? "" : "refused · "}
              {/* ═══ ⭐ A MISSING SOURCE MUST NOT BORROW THE IDENTITY OF A REAL ONE ════════════════
                  `?? "action"` rendered an entry with NO recorded source as the word "action" —
                  a plausible, generic label that reads as a FACT. A user auditing their own money
                  movements would take it as a recorded action of an unremarkable kind, when what
                  actually happened is that we do not know what it was.
                  ⭐ Same rule as unclassified-vs-unwired and NOT-YET-vs-SUPERSEDED: a value we did
                  not handle must say so, not wear a handled value's name. Raw looks like a gap;
                  a plausible label looks like a fact, and the second is worse.
                  ⚠️ The audit row is still SHOWN — hiding it would be a worse absence. It is shown
                  as what it is: an entry whose action type was never recorded. */}
              {e.source ?? NO_TYPE}
            </span>
            )}
            {showAgent && <span className="sub"> by {e.agent}</span>}
            {/* The reason line follows the row's own classification: a refusal explains itself with
                `reason`, a bookkeeping row with `justification`. ⚠️ `justification` was declared on
                this type and rendered NOWHERE — the sweeper's stated grounds ("landed on-chain")
                reached the record and never reached a reader. */}
            {bookkeeping
              ? e.justification && <div className="sub" style={{ margin: "2px 0 0" }}>{e.justification}</div>
              : !e.allowed && e.reason && <div className="sub" style={{ margin: "2px 0 0" }}>{e.reason}</div>}
          </div>
          <div className="sub">
            {/* ═══ 🚨 THE AMOUNT COLUMN IS WHERE THE REVERSAL LIED ═════════════════════════════
                A reversal carries a POSITIVE amountUsdc by deliberate design — _budget.mjs keeps it
                positive plus an explicit `kind` "so the record stays legible to a human", and
                agentBreakdown SUBTRACTS it. Rendered raw, the trail therefore showed a second
                +999.00 next to the charge it cancels while the total had already netted it out.
                It is shown as the credit it is. ⭐ A resolution moves no money at all, so it shows
                NO amount — rendering 0.0000 USDC would assert a zero-value transfer occurred. */}
            {e.kind === "resolution"
              ? <span className="mono">no money moved</span>
              : <><span className="mono">{e.kind === "reversal" ? `−${money(e.amountUsdc)}` : money(e.amountUsdc)}</span> USDC</>}
            {" · "}{time(e.timestamp)}
          </div>
        </div>
        );
      })}
    </div>
  );
}
