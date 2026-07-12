import { getStore } from "@netlify/blobs";
import { AGENT, AGENTS, isAgent, agentLabel } from "./_agents.mjs";

// PAUSE / STOP — the kill switch.
//
// ⚠️ THE CHOKEPOINT MATTERS MORE THAN THE BUTTON. A pause that one code path routes around is
// not a pause. executeAction is the MAIN chokepoint but it is NOT the only one — these move
// money without ever touching it:
//
//   EXECUTOR   · executeAction        (agent-act, agent-execute-plan, agent-bridge,
//                                      job-swap-approve, job-bridge-approve)
//              · agent-send           — direct transfer(), never calls executeAction
//              · agent-ub-spend       — direct ubSpend(), never calls executeAction
//   RESEARCHER · job-run              — starts a job whose research buys data
//              · maybeBuyData         — the x402 purchase itself, mid-research
//
// Every one of those calls assertNotPaused(). Adding a new spend path means adding the call;
// there is no ambient enforcement that will catch you if you forget.
//
// ⚠️ FAIL CLOSED, TWICE OVER.
//   1. If the pause flag CANNOT BE READ, we treat the agent as PAUSED. A kill switch whose
//      failure mode is "keep spending" is not a kill switch. A transient Blobs hiccup
//      therefore blocks spending — that is the safe direction, and it is deliberate.
//   2. If AGENT_HALT is set to anything we do not recognise, we HALT. Same discipline as the
//      fail-closed caps in _arc.mjs: a typo must never widen what the agent may do.

const PAUSE_STORE = "agent-pause";

// `*` pauses EVERY agent for this owner — the "stop everything" switch, distinct from
// pausing one agent. Kept as a real key rather than a loop so a global pause is a single
// atomic write.
export const ALL_AGENTS = "*";

const ownerKey = (owner) => String(owner || "").toLowerCase();
const pauseKey = (owner, agent) => `pause:${ownerKey(owner)}:${agent}`;

// ── GLOBAL HALT (operator switch, env-driven) ────────────────────────────────
// Unset/empty → running. "1"/"true"/"on"/"yes" → halted. ANYTHING ELSE → HALTED, because we
// cannot tell whether the operator meant to halt and typed it wrong. Fail closed.
export function globalHalt() {
  const raw = process.env.AGENT_HALT;
  if (raw === undefined || raw === "") return null; // running
  const v = String(raw).trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(v)) {
    return "All agents are halted by the operator (AGENT_HALT). No action will run.";
  }
  if (["0", "false", "off", "no"].includes(v)) return null; // explicitly running
  // Unrecognised value — we do NOT get to guess that it meant "keep spending".
  return `AGENT_HALT is set to an unrecognised value (${JSON.stringify(raw)}); halting to be safe.`;
}

// ── Per-owner, per-agent pause ───────────────────────────────────────────────
// Returns a REASON string when the agent must not act, or null when it may.
//
// The caller must have run connectLambda(event) if it is a classic-Lambda handler; a Blobs
// failure here is treated as PAUSED (see the fail-closed note above), so a missing
// connectLambda would block spending loudly rather than let it through silently.
export async function pauseReason({ owner, agent }) {
  const halt = globalHalt();
  if (halt) return halt;

  if (!owner) {
    // No owner ⇒ we cannot tell whose pause flag to read ⇒ we cannot prove it is running.
    return "Cannot verify whether this agent is paused (no owner resolved) — refusing to act.";
  }

  const id = isAgent(agent) ? agent : null;
  if (!id) return `Unknown agent "${agent}" — refusing to act.`;

  try {
    const store = getStore(PAUSE_STORE);
    const [all, mine] = await Promise.all([
      store.get(pauseKey(owner, ALL_AGENTS), { type: "json" }),
      store.get(pauseKey(owner, id), { type: "json" }),
    ]);
    if (all?.paused) return "All of your agents are paused. Resume them to act again.";
    if (mine?.paused) return `Your ${agentLabel(id)} is paused. Resume it to act again.`;
    return null;
  } catch (e) {
    // FAIL CLOSED. We could not read the switch, so we cannot prove the agent is running.
    return `Could not verify the pause switch (${e.message}) — refusing to act.`;
  }
}

// Convenience for the money paths: throws nothing, returns a block reason or null. Callers
// return `{ ok: false, blocked: reason }` / a 409, exactly as they do for a cap.
export const assertNotPaused = pauseReason;

// ── Read / write the switch (used by the Agents page) ────────────────────────
export async function setPaused({ owner, agent, paused }) {
  if (!owner) throw new Error("owner required");
  const id = agent === ALL_AGENTS ? ALL_AGENTS : agent;
  if (id !== ALL_AGENTS && !isAgent(id)) throw new Error(`unknown agent "${agent}"`);
  const store = getStore(PAUSE_STORE);
  await store.setJSON(pauseKey(owner, id), {
    paused: !!paused,
    agent: id,
    owner: ownerKey(owner),
    at: new Date().toISOString(),
  });
  return { agent: id, paused: !!paused };
}

// The pause state of every agent for one owner, for the roster. A read failure here is NOT
// fail-closed — this is a VIEW, and showing "unknown" is honest; the ENFORCEMENT path above
// is the one that must fail closed.
export async function pauseStates({ owner }) {
  // ⚠️ DERIVED FROM THE REGISTRY, never a hardcoded list. The first cut hardcoded
  // [ALL, RESEARCHER, EXECUTOR] — so the moment Analyst B was added, its pause state came back
  // `undefined` and the roster could not show or toggle it. The whole point of _agents.mjs is
  // that adding an agent needs no change anywhere else; a hardcoded list quietly breaks that.
  const ids = [ALL_AGENTS, ...AGENTS.map((a) => a.id)];
  try {
    const store = getStore(PAUSE_STORE);
    const recs = await Promise.all(
      ids.map((id) => store.get(pauseKey(owner, id), { type: "json" }).catch(() => null))
    );
    return Object.fromEntries(ids.map((id, i) => [id, !!recs[i]?.paused]));
  } catch {
    return Object.fromEntries(ids.map((id) => [id, null])); // unknown, not "running"
  }
}
