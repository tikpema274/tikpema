// AGENT REGISTRY — the single source of truth for the roster.
//
// ONE definition feeds three things, so they can never disagree:
//   1. AUDIT ATTRIBUTION — every ledger entry records WHICH agent spent (_budget.mjs).
//   2. PAUSE/STOP        — the kill switch is keyed per owner + per agent.
//   3. THE AGENTS PAGE   — the roster renders from this, so a new agent is a new entry
//                          here plus its enforcement, never a UI redesign.
//
// Adding an agent (Brick 2's second analyst + synthesizer, a vetting gate, an x402 hiring
// agent) means: add an entry here, pass `agent: AGENT.<id>` at its ledger calls, and check
// `assertNotPaused` at its money chokepoint. Nothing else.
//
// ⚠️ `agent` IS NOT `source`. `source` is the TOOL or action kind (exa, swap_tokens,
// ub_spend, a seller URL). `agent` is WHO acted. One agent uses many sources; the Agents page
// needs the former, the audit trail already had the latter.

export const AGENT = {
  RESEARCHER: "researcher",
  EXECUTOR: "executor",
  // Brick 2 — the second, INDEPENDENT opinion. Analyst A IS the Researcher (the existing
  // narrative pipeline); Analyst B is a separate agent because it has separate SOURCES,
  // separate failure modes, and can independently KILL a proposal.
  ANALYST_B: "analyst_b",
};

// Order here is the order the roster renders in.
export const AGENTS = [
  {
    id: AGENT.RESEARCHER,
    label: "Researcher",
    // Written for the user, not for us — this is the card copy.
    description:
      "Reads your question, retrieves real sources, and writes a cited brief. It may buy data " +
      "mid-research (paid APIs, on-chain reads) within its per-job allowance — that spend is " +
      "capped and every purchase is recorded below.",
    spends: "Buys data during research. Cannot move your funds.",
  },
  {
    id: AGENT.ANALYST_B,
    label: "Second opinion",
    description:
      "Independently checks every action your researcher proposes — but never reads the web. " +
      "It prices the trade against an independent market source and against the live chain, and " +
      "asks one question: is the rate you would actually get FAIR? It has no view on where " +
      "markets are heading, and it cannot be swayed by a confident article. If it refuses — no " +
      "route, or a rate far off fair value — the action is NOT proposed, whatever the first " +
      "analyst argued.",
    spends: "Reads free market data and prices the chain. Cannot move your funds.",
  },
  {
    id: AGENT.EXECUTOR,
    label: "Executor",
    description:
      "Moves funds on-chain — sends, swaps, bridges, and Gateway payments. It only ever acts " +
      "on an action you approved, or a direct instruction you typed. Every action is bounded " +
      "by a per-transaction cap and your daily ceiling.",
    spends: "Moves your USDC/EURC. This is the one that spends real money.",
  },
];

const BY_ID = new Map(AGENTS.map((a) => [a.id, a]));
export const isAgent = (id) => BY_ID.has(String(id));
export const agentLabel = (id) => BY_ID.get(String(id))?.label ?? String(id);

// A ledger entry whose agent we cannot resolve is a bug, not a data point — but it must never
// break a money path. Unknown ids are recorded verbatim so the Agents page can surface them
// as "unattributed" rather than silently dropping the spend from the breakdown.
export const normalizeAgent = (id) => (isAgent(id) ? String(id) : "unattributed");
