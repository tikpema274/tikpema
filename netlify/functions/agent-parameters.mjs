import {
  json,
  maxSpendUsdc,
  sendCapUsdc,
  swapCapUsdc,
  bridgeCapUsdc,
  ubSpendCapUsdc,
  ubDepositCapUsdc,
  ubSpendFloorUsdc,
} from "./_arc.mjs";
import { AGENT, AGENTS } from "./_agents.mjs";
import { budgetConfig } from "./_budget.mjs";

// GET /api/agent-parameters/<agent>  (no auth, read-only, no writes, nothing on-chain)
//
// WHAT THIS IS: the agent's CURRENT, LIVE, MUTABLE operating parameters — the caps and limits
// it is bounded by *right now*. An operator can change any of these at any time (they are env
// configuration, re-read on every request), and they may differ from what they were a minute
// ago or a minute from now.
//
// ⚠️ WHAT THIS IS NOT: the immutable invariants. "The Researcher cannot move funds" is a
// property of the system, not a number someone can raise — it is not in `parameters`, it is in
// `invariants`, and the two are deliberately kept in SEPARATE, DIFFERENTLY-NAMED blocks so a
// caller can never mistake a knob for a guarantee. A cap is a dial. An invariant is a wall.
//
// SINGLE SOURCE OF TRUTH. Every number here comes from the same fail-closed helpers the money
// paths themselves call (sendCapUsdc / swapCapUsdc / bridgeCapUsdc / maxSpendUsdc in _arc.mjs,
// budgetConfig in _budget.mjs). This endpoint reads NO env var of its own and hardcodes NO
// value — so it cannot drift from what is actually enforced. If it says the send cap is 10,
// that is because agent-send.mjs will reject 10.000001.
//
// MISCONFIGURATION IS REPORTED, NOT HIDDEN. The cap helpers THROW on a garbled env value (a
// typo must never silently widen a bound — see _arc.mjs). A parameters endpoint that 500s on
// that tells the caller nothing, and one that returns `null` invites "null means no limit".
// So each cap is read independently: a broken one comes back as
// { status: "misconfigured", enforced: "REFUSED" } — because fail-closed means that action is
// currently refused outright, which is a TIGHTER bound than any number, not a missing one.

// The registry's canonical id is `analyst_b`; "Second opinion" is its label. Accept the
// human-facing spellings so callers can use the name they see in the UI.
const ALIASES = {
  "second-opinion": AGENT.ANALYST_B,
  second_opinion: AGENT.ANALYST_B,
  secondopinion: AGENT.ANALYST_B,
  "analyst-b": AGENT.ANALYST_B,
};
const resolveAgent = (raw) => {
  const k = String(raw ?? "").trim().toLowerCase();
  return ALIASES[k] ?? k;
};

// Read one bound in isolation. A throw from the fail-closed helper is a REPORTABLE STATE, not a
// crash: it means that action is currently refused, so say exactly that.
//
// ⚠️ `bound` is NOT decoration. Every limit here is a MAXIMUM except the UB spend FLOOR, which
// is a MINIMUM — a spend BELOW it is rejected. A reader scanning a list of "caps" would read a
// floor of 10 as "at most 10" and have it exactly backwards, so the direction is carried as
// data on every entry rather than left to be inferred from the label.
const cap = (label, fn, applies, bound = "maximum") => {
  try {
    return { label, usdc: fn(), unit: "USDC", per: applies, bound, status: "active" };
  } catch (e) {
    return {
      label,
      usdc: null,
      unit: "USDC",
      per: applies,
      bound,
      status: "misconfigured",
      enforced: "REFUSED — fail-closed: this action is currently rejected outright",
      detail: e.message,
    };
  }
};

// Which dials actually bind which agent. The Researcher has no send/swap/bridge cap because it
// has no send/swap/bridge — that is an invariant, not a cap set to zero, and conflating the two
// is exactly the confusion this endpoint exists to prevent.
function parametersFor(id) {
  const cfg = budgetConfig();
  const ceiling = {
    label: "Daily autonomous ceiling",
    usdc: cfg.PERIOD_CEILING_USDC,
    unit: "USDC",
    per: "rolling UTC day, per user",
    status: "active",
    note: "Shared across all agents for this owner — cumulative autonomous spend, whatever the action.",
  };

  if (id === AGENT.RESEARCHER) {
    return {
      spendCaps: [cap("Per-purchase spend cap", maxSpendUsdc, "single autonomous data purchase")],
      budget: [
        ceiling,
        { label: "Per-job data allowance", value: cfg.DATA_ALLOWANCE_PCT, unit: "fraction of job price", status: "active" },
        { label: "Per-purchase share of allowance", value: cfg.PER_PURCHASE_PCT, unit: "fraction of job allowance", status: "active" },
      ],
      movementCaps: [],
      movementCapsNote:
        "None — the Researcher has no fund-movement path at all. This is an INVARIANT (see `invariants`), not a cap set to zero.",
    };
  }

  if (id === AGENT.ANALYST_B) {
    return {
      spendCaps: [],
      spendCapsNote:
        "None — the Second opinion reads free market data and the public chain. It buys nothing and moves nothing.",
      budget: [ceiling],
      movementCaps: [],
      movementCapsNote:
        "None — no fund-movement path. INVARIANT (see `invariants`), not a dial at zero.",
    };
  }

  if (id === AGENT.EXECUTOR) {
    return {
      spendCaps: [cap("Autonomous per-transaction spend cap", maxSpendUsdc, "single autonomous action")],
      budget: [ceiling],
      // The per-transaction bounds on actually moving money. Each is independent so one can be
      // loosened without loosening the others.
      movementCaps: [
        cap("Send cap", sendCapUsdc, "single send/transfer"),
        cap("Swap cap", swapCapUsdc, "single swap (USDC-equivalent, not raw amountIn)"),
        cap("Bridge cap", bridgeCapUsdc, "single bridge (funds leave Arc)"),
      ],
      // Unified Balance (Gateway) is a SEPARATE movement surface with its own bounds — the
      // underlying executors (_ubspend.mjs / _ubdeposit.mjs) are UNCAPPED, so these are the
      // only thing standing between an instruction and the funds. Grouped apart from
      // movementCaps because a send/swap/bridge cap does NOT bound them.
      unifiedBalanceCaps: [
        cap("UB spend cap", ubSpendCapUsdc, "single cross-chain spend of the unified balance"),
        // A MINIMUM, not a maximum: the Forwarding Service fee is flat (~0.2 USDC), so a spend
        // below the floor is structurally uneconomical and is rejected. Valid: floor ≤ x ≤ cap.
        cap("UB spend floor", ubSpendFloorUsdc, "single cross-chain spend — REJECTED BELOW this", "minimum"),
        cap("UB deposit cap", ubDepositCapUsdc, "single deposit into the agent's own unified balance"),
      ],
      unifiedBalanceNote:
        "Valid UB spend is floor ≤ amount ≤ cap. The floor is a MINIMUM (a smaller spend is refused, " +
        "not allowed) — the flat forwarder fee makes small cross-chain spends uneconomical.",
    };
  }
  return null;
}

// The things no operator can dial. Stated as prose because they are guarantees, not values.
function invariantsFor(id) {
  const movesFunds = id === AGENT.EXECUTOR;
  const base = [
    "Every cap is enforced fail-closed: a misconfigured limit refuses the action, it never widens it.",
    "Cumulative autonomous spend is bounded by the daily ceiling regardless of any per-transaction cap.",
  ];
  return movesFunds
    ? [
        "The Executor moves funds ONLY on an action you approved or an instruction you typed — it never originates a transfer.",
        "Caps are checked at the money chokepoint before any transaction is signed, never after.",
        ...base,
      ]
    : [
        "This agent CANNOT move your funds. There is no code path from it to a transfer, swap, or bridge.",
        ...base,
      ];
}

export async function handler(event) {
  if (event.httpMethod && event.httpMethod !== "GET") {
    return json(405, { error: "read-only endpoint — GET only" });
  }

  // /api/agent-parameters/<agent> — last non-empty path segment. Also accept ?agent= so the
  // endpoint works if the redirect is ever missing.
  const fromPath = String(event.path ?? "").split("/").filter(Boolean).pop();
  const fromQuery = event.queryStringParameters?.agent;
  const requested = fromQuery ?? (fromPath === "agent-parameters" ? "" : fromPath);

  const id = resolveAgent(requested);
  const entry = AGENTS.find((a) => a.id === id);
  if (!entry) {
    return json(400, {
      error: requested ? `unknown agent "${requested}"` : "missing agent — use /api/agent-parameters/<agent>",
      knownAgents: AGENTS.map((a) => ({ id: a.id, label: a.label })),
      aliases: Object.keys(ALIASES),
    });
  }

  const p = parametersFor(id);

  return json(200, {
    agent: { id: entry.id, label: entry.label, movesFunds: id === AGENT.EXECUTOR },

    // ── THE LABEL. Unmissable, and the first thing a reader hits. ──
    kind: "live-parameters",
    mutable: true,
    readAt: new Date().toISOString(),
    disclaimer:
      "LIVE AND MUTABLE. These are the agent's CURRENT operating parameters, re-read from " +
      "configuration on every request. An operator can change any of them at any time, so a " +
      "value here is true as of `readAt` and is NOT a promise about the future. They are the " +
      "same values the money paths enforce. Do NOT read them as guarantees — the guarantees " +
      "are in `invariants`, which are properties of the system that no operator can dial.",

    // Dials. Mutable.
    parameters: p,

    // Walls. Not mutable, not numbers.
    invariants: {
      kind: "immutable-invariants",
      mutable: false,
      note: "Structural properties, not configuration. Nothing in `parameters` can change these.",
      statements: invariantsFor(id),
    },

    source: {
      caps: "_arc.mjs — sendCapUsdc / swapCapUsdc / bridgeCapUsdc / maxSpendUsdc (fail-closed)",
      budget: "_budget.mjs — budgetConfig()",
      note: "This endpoint reads no environment variable directly and hardcodes no value; it calls the same helpers the enforcement paths call, so it cannot drift from what is actually enforced.",
    },
  });
}
