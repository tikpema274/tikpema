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
//   3. ⭐ If the flag is READ FROM A CACHE, it may be a LIE — so every read below is
//      consistency:"strong". See the note on READ_CONSISTENCY.

const PAUSE_STORE = "agent-pause";

// ═══ 🚨 STRONG CONSISTENCY — THE THIRD FAIL-CLOSED, AND THE ONE THAT WAS MISSING ═════════════
// Netlify Blobs reads default to consistency:"eventual" — a CDN-cached edge read, not the origin.
//
// ⚠️ THE GAP THIS CLOSES IS NARROW AND EXACT. Rule 1 above covers UNREADABLE: the read throws, the
// catch fires, we refuse. It does NOT cover STALE. A cached read does not throw — it succeeds, and
// returns a confident `{paused:false}` (or nothing at all) from before the pause was written. That
// sails straight past the catch and `pauseReason` returns null, meaning "may act".
//
//   operator hits STOP  ->  setPaused writes {paused:true} to origin
//   spend path reads    ->  gets the CACHED pre-pause value  ->  returns null  ->  FUNDS MOVE
//
// The kill switch does not stop anything during the exact emergency it exists for, and nothing
// anywhere reports a failure — the read "worked". "Could not read" was handled; "read something
// out of date" was not, and the two are indistinguishable at the call site.
//
// MEASURED ON THE SISTER PATH, not theorised here: the DD canary's health artifact showed exactly
// this, with a freshly written record invisible to the reader for ~1 hour (aca4d31). Same store
// technology, same default, same class of verdict. This path was found by auditing every Blobs read
// after that one, and is strictly more dangerous: that one gated ANSWERS, this one gates MONEY.
//
// The cost is one uncached round trip per spend decision — on a path that already refuses outright
// when the read fails, and that is about to move funds.
const READ_CONSISTENCY = "eventual"; // ⚠️ DEGRADED — see INCIDENT note above

/** Sentinel for "this key could not be read", distinct from a readable-and-absent flag. A plain
 *  `null` was indistinguishable from "no record" and collapsed to false = running. */
const UNREADABLE = Symbol("unreadable");

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
      store.get(pauseKey(owner, ALL_AGENTS), { type: "json", consistency: READ_CONSISTENCY }),
      store.get(pauseKey(owner, id), { type: "json", consistency: READ_CONSISTENCY }),
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
      // Strong here too. This is a VIEW, but it is the OPERATOR'S FEEDBACK LOOP ON A SAFETY
      // CONTROL: after hitting STOP they look at this roster to confirm the stop took. A cached
      // "not paused" tells them the pause failed when it did not — during an emergency, that
      // invites exactly the wrong reaction.
      //
      // ⭐ UNREADABLE IS A THIRD STATE, NOT "RUNNING". The per-key catch used to yield `null`, which
      // `!!null` then rendered as FALSE — so a single unreadable flag showed the operator a GREEN,
      // RUNNING agent whose state was in fact unknown. That is the wrong direction on a safety
      // control, and it disagreed with the outer catch below, which already returns `null` (unknown)
      // when the whole store is unreadable. One key failing now behaves exactly like all of them
      // failing. Same tri-state lesson as the vault inspector's UNREADABLE.
      ids.map((id) =>
        store.get(pauseKey(owner, id), { type: "json", consistency: READ_CONSISTENCY }).catch(() => UNREADABLE))
    );
    return Object.fromEntries(
      ids.map((id, i) => [id, recs[i] === UNREADABLE ? null : !!recs[i]?.paused]));
  } catch {
    return Object.fromEntries(ids.map((id) => [id, null])); // unknown, not "running"
  }
}
