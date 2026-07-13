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

// ⚠️ `movesFunds` IS AUDITED, NOT ASSERTED. It was previously derived in agents.mjs as
// `a.id === "executor"`, which was FALSE: the Researcher signs an EIP-3009
// TransferWithAuthorization to buy data (_research.mjs:301 → payX402), so real USDC leaves the
// user's wallet. It is bounded — per-job allowance, per-purchase share, daily ceiling, all
// checked by canSpend() BEFORE signing — but bounded is not the same as cannot, and the card
// told users it cannot. It now lives HERE, in the one registry, so a claim about moving money
// cannot drift from the code path that moves it. Set it by auditing the call graph:
//   an agent moves funds if ANY path reachable from it signs a transfer.
// Order here is the order the roster renders in.
export const AGENTS = [
  {
    id: AGENT.RESEARCHER,
    label: "Researcher",
    movesFunds: true, // buys data with your USDC — payX402 → EIP-3009, _research.mjs:301
    // Written for the user, not for us — this is the card copy.
    description:
      "Reads your question, retrieves real sources, and writes a cited brief. It may buy data " +
      "mid-research (paid APIs, on-chain reads) within its per-job allowance — that spend is " +
      "capped and every purchase is recorded below.",
    // WAS: "Buys data during research. Cannot move your funds." — the second sentence was FALSE.
    // It spends the user's USDC. Say so first; bound it second; keep the distinction that does hold.
    spends: "Spends your USDC to buy data. Capped per job and per day — it cannot send, swap, or bridge.",
  },
  {
    id: AGENT.ANALYST_B,
    label: "Second opinion",
    // AUDITED TRUE: reaches only estimateSwap (a quote), the Circle fee API, and valueInUsdc.
    // No executor, no signer, no payX402. Verified by call-graph audit — left unchanged.
    movesFunds: false,
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
    movesFunds: true, // sends, swaps, bridges, Gateway spends
    description:
      "Moves funds on-chain — sends, swaps, bridges, and Gateway payments. It only ever acts " +
      "on an action you approved, or a direct instruction you typed. Every action is bounded " +
      "by a per-transaction cap and your daily ceiling.",
    // WAS: "…This is the one that spends real money." — "the one" implied EXCLUSIVITY, which the
    // audit falsified: the Researcher spends real money too. The warning is preserved (this IS
    // the most dangerous agent) without the false claim that it is the only spender.
    spends: "Moves your USDC/EURC — sends, swaps, bridges. This is the one that can move funds anywhere.",
  },
];

const BY_ID = new Map(AGENTS.map((a) => [a.id, a]));
export const isAgent = (id) => BY_ID.has(String(id));
export const agentLabel = (id) => BY_ID.get(String(id))?.label ?? String(id);

// A ledger entry whose agent we cannot resolve is a bug, not a data point — but it must never
// break a money path. Unknown ids are recorded verbatim so the Agents page can surface them
// as "unattributed" rather than silently dropping the spend from the breakdown.
export const normalizeAgent = (id) => (isAgent(id) ? String(id) : "unattributed");
