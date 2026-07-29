import { json, parseBody } from "./_arc.mjs";
import { connectBlobs } from "./_blobs.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet } from "./_agent-wallets.mjs";
import { AGENTS, isAgent } from "./_agents.mjs";
import { budgetConfig, daySpend, agentBreakdown, auditLog } from "./_budget.mjs";
import { pauseStates, setPaused, globalHalt, ALL_AGENTS } from "./_pause.mjs";

// GET/POST /api/agents   (auth)  — the AGENTS PAGE, in one call.
//
// A ROSTER, not a dashboard for one agent. Today it returns two agents; Brick 2's analysts and
// synthesizer, a vetting gate, an x402 hiring agent all become entries in _agents.mjs and
// appear here with no change to this endpoint or the page. The data shape is built for N.
//
// POST { agent, paused } toggles the switch (agent may be "*" for ALL). Everything is scoped
// to the VERIFIED SESSION's own wallet — there is no read-anyone's-agents path and no
// pause-anyone-else's-agent path.
//
// ⚠️ THE TRUST DISTINCTION IS THE POINT — and it was WRONG here. This header used to read "The
// Researcher CANNOT move funds; the Executor CAN." A call-graph audit found the Researcher signs
// an EIP-3009 TransferWithAuthorization to buy data (_research.mjs:301 → payX402): real USDC
// leaves the user's wallet. The truth is a THREE-way distinction, not two:
//   Researcher    — moves funds, ONE way: buying data. No send/swap/bridge/Gateway/escrow path.
//   Second opinion— moves nothing. Quotes and reads only. (Audited.)
//   Executor      — moves funds every way: send, swap, bridge, Gateway.
// It is the single most important thing a user can know about an agent holding a wallet, so it
// is a first-class field (`movesFunds`) sourced from the registry — never re-derived in a view.
// The page leads with it.
export async function handler(event) {
  if (event.blobs) connectBlobs(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const wallet = await ensureOwnerWallet(session);
  if (wallet.pending) {
    return json(202, { status: "provisioning", message: "Your agent wallet is being set up — retry shortly." });
  }
  const owner = wallet.walletAddress;

  // ── WRITE: pause / resume ──
  if (event.httpMethod === "POST") {
    const { agent, paused } = parseBody(event);
    if (agent !== ALL_AGENTS && !isAgent(agent)) {
      return json(400, { error: `unknown agent "${agent}"` });
    }
    if (typeof paused !== "boolean") return json(400, { error: "'paused' must be a boolean" });
    try {
      const r = await setPaused({ owner, agent, paused });
      return json(200, { ...r, owner });
    } catch (e) {
      return json(500, { error: e.message });
    }
  }

  // ── READ: the roster ──
  const cfg = budgetConfig();
  const [states, spentToday, breakdown, recent] = await Promise.all([
    pauseStates({ owner }),
    daySpend({ owner }).catch(() => null),
    agentBreakdown({ owner }).catch(() => []),
    auditLog({ owner, date: new Date().toISOString().slice(0, 10) }).catch(() => []),
  ]);

  const byAgent = new Map(breakdown.map((b) => [b.agent, b]));

  // `unlisted` agents are hidden from the user-facing roster (a fund-moving agent whose live
  // rows aren't proven yet). They remain full agents server-side — isAgent()/pause/audit all
  // still resolve them, and their endpoints stay live — so this ONLY affects what the page shows.
  const agents = AGENTS.filter((a) => !a.unlisted).map((a) => {
    const stats = byAgent.get(a.id) ?? { spentUsdc: 0, actions: 0, blocked: 0 };
    return {
      id: a.id,
      label: a.label,
      description: a.description,
      spends: a.spends,
      // THE TRUST DISTINCTION, as data — now read from the registry, not re-derived here.
      // This line used to say `a.id === "executor"`, which was FALSE: the Researcher buys data
      // with the user's USDC (payX402 → EIP-3009, _research.mjs:301). Deriving a money claim in
      // the VIEW is how it drifted from the code that moves the money; the registry owns it now.
      movesFunds: a.movesFunds,
      // The agent's own page, or null if it has none (most of them). The roster renders an
      // "Open →" control only when this is set — so "has a page" stays a registry fact, not a
      // hardcoded id check in the view.
      route: a.route ?? null,
      // `paused: null` means we could not read the switch — shown as "unknown", never as
      // "running". (Enforcement fails CLOSED; this VIEW is merely honest about not knowing.)
      paused: states[ALL_AGENTS] === true ? true : states[a.id],
      pausedByAll: states[ALL_AGENTS] === true,
      spentTodayUsdc: stats.spentUsdc,
      actionsToday: stats.actions,
      blockedToday: stats.blocked,
    };
  });

  return json(200, {
    owner,
    agents,
    allPaused: states[ALL_AGENTS] === true,
    // An operator-level halt overrides every per-agent switch. Surfaced so the page can say
    // WHY nothing will run, rather than showing agents as "running" while they are halted.
    halted: globalHalt(),
    budget: {
      spentTodayUsdc: spentToday,
      ceilingUsdc: cfg.PERIOD_CEILING_USDC,
      remainingUsdc:
        spentToday === null ? null : Math.max(0, Math.round((cfg.PERIOD_CEILING_USDC - spentToday) * 1e6) / 1e6),
    },
    // Newest first — the page shows the last N. Includes REFUSALS: "your agent tried to buy X
    // and the cap stopped it" is exactly what an observability surface should show.
    activity: recent.slice(-50).reverse(),
  });
}
