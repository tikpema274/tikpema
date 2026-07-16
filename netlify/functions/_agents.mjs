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
  // Vault agent — inspects an allowlisted ERC-4626 vault on-chain and, on your approval,
  // deposits/withdraws your USDC. Its own agent (own kill switch, own audit attribution) because
  // it has its own failure surface: a third-party vault contract and its owner's powers.
  VAULT: "vault",
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
    // The 🔒 badge already says "cannot move your money" — so this line should carry what the
    // badge does NOT: what the agent is actually FOR. "Buys nothing" is the stronger claim
    // anyway: the Researcher moves money without sending anything, so "cannot move your funds"
    // is no longer the interesting distinction between them. Spending is.
    spends: "Reads market data and live chain prices to check the Researcher's proposals. Buys nothing.",
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
  {
    id: AGENT.VAULT,
    label: "Vault",
    movesFunds: true, // deposits your USDC into an allowlisted ERC-4626 vault — approve → deposit, _vault.mjs
    // ⚠️ THE ONLY AGENT WITH ITS OWN PAGE — hence the only one carrying a `route`.
    //
    // The roster is a monitoring view: every agent is pausable and inspectable, none was
    // enterable. Vault broke that assumption by having a 1:1 front door (#/vault), and the
    // roster had no slot to say so. It lives HERE rather than as an `id === "vault"` test in
    // the panel for the same reason `movesFunds` does: the registry owns what is true of an
    // agent, views read it. An agent with no route renders no Open control — routing the other
    // three would be nav to nowhere (the Executor is the engine behind #/send, #/swap and
    // #/bridge, so it has four surfaces and no page; Second opinion runs inside #/plan and has
    // none at all). Give an agent its own page, add its route here — that is the whole change.
    route: "vault",
    description:
      "Inspects a yield vault on-chain BEFORE you commit — is it a real ERC-4626, what is the " +
      "underlying, is it funded, and what powers does its owner hold (settable fees, an emergency " +
      "drain, upgradeability)? Then, only on your approval and only for a vault on its allowlist, " +
      "it deposits your USDC and can withdraw it back. It reads a third-party contract, so it " +
      "shows you the vault's terms — including the uncomfortable ones — before you agree to them.",
    // Deposits are capped per-transaction and per-day; a withdraw is a reclaim (always available,
    // never blocked by a pause). The card leads with the move, then the guardrail.
    spends: "Deposits your USDC into an allowlisted vault — capped per deposit and per day. Withdraw is always available. It shows the vault's owner powers before you approve.",
  },
];

const BY_ID = new Map(AGENTS.map((a) => [a.id, a]));
export const isAgent = (id) => BY_ID.has(String(id));
export const agentLabel = (id) => BY_ID.get(String(id))?.label ?? String(id);

// A ledger entry whose agent we cannot resolve is a bug, not a data point — but it must never
// break a money path. Unknown ids are recorded verbatim so the Agents page can surface them
// as "unattributed" rather than silently dropping the spend from the breakdown.
export const normalizeAgent = (id) => (isAgent(id) ? String(id) : "unattributed");
