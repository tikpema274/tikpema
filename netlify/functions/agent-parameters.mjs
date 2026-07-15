import {
  json,
  maxSpendUsdc,
  sendCapUsdc,
  swapCapUsdc,
  bridgeCapUsdc,
  ubSpendCapUsdc,
  ubDepositMaxPerTxUsdc,
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

// ── Per-agent authoritative-invariants CID. ─────────────────────────────────────────────────
// The IPFS CIDv1 (raw-codec, "bafkrei...") of each agent's invariants document, pinned and
// verified byte-identical to the committed agent-metadata/*.json across three independent public
// gateways (see scripts/pin-invariants.mjs). ONE CID PER AGENT — they are content-addressed and
// NOT interchangeable; crossing them would point an agent at another agent's guarantees.
//
// ⚠️ PINNED ≠ AUTHORITATIVE. These documents resolve today, but authority comes from the CHAIN:
// a CID becomes the authoritative invariants pointer only once tokenURI(agentId) records it in
// the ERC-8004 IdentityRegistry. NONE of these is recorded on-chain yet — so invariantsUriStatus
// below says exactly that, and must not be upgraded to claim on-chain authority until the
// registration actually lands.
const INVARIANTS_CID = {
  [AGENT.RESEARCHER]: "ipfs://bafkreicdicy7hhb45ayygkt457jfx4ucswey7nknhcvg2gexsp4opbminy",
  [AGENT.ANALYST_B]: "ipfs://bafkreifzi7ia4djdp7ukbnf2hwndeys5p7cwre66lrlnroqmwpyaqqo7om",
  [AGENT.EXECUTOR]: "ipfs://bafkreic5eefpf3c67l2ti2mxmgpo7qwtzao3mtrc23cmcrlrefazqgxxdi",
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

// Which dials actually bind which agent.
//
// ⚠️ CORRECTED. This endpoint originally reported the Researcher as having NO fund-movement path
// and an empty `movementCaps`. THAT WAS FALSE. An audit of the call graph found exactly one exit
// to value: _research.mjs:301 calls payX402, which signs an EIP-3009 TransferWithAuthorization
// against the user's wallet — real USDC leaves it to pay a data seller. It is bounded, but
// "bounded" is not "absent", and reporting a live spend path as no-path-at-all is the single
// worst thing a parameters endpoint can do. The x402 purchase is now listed as the movement
// surface it is.
function parametersFor(id) {
  const cfg = budgetConfig();
  const ceiling = {
    label: "Daily autonomous ceiling",
    usdc: cfg.PERIOD_CEILING_USDC,
    unit: "USDC",
    per: "rolling UTC day, per user",
    bound: "maximum",
    status: "active",
    note: "Shared across all agents for this owner — cumulative autonomous spend, whatever the action.",
  };

  if (id === AGENT.RESEARCHER) {
    return {
      spendCaps: [cap("Per-purchase spend cap", maxSpendUsdc, "single autonomous data purchase")],
      budget: [ceiling],
      // THE RESEARCHER'S ONE EXIT TO VALUE. Not empty. Every buy must pass ALL of these before
      // payX402 signs anything — they are checked in canSpend() (_budget.mjs:183), which runs
      // BEFORE the signature, so a refusal moves no money.
      movementCaps: [
        {
          label: "x402 data purchase",
          action: "Signs an EIP-3009 TransferWithAuthorization — USDC leaves your wallet to a data seller",
          callSite: "_research.mjs:301 (payX402) — the only one",
          gatedBy: "canSpend() — checked before signing",
          bound: "maximum",
          status: "active",
          limits: [
            {
              label: "Per-job data allowance",
              value: cfg.DATA_ALLOWANCE_PCT,
              unit: "fraction of job price",
              bound: "maximum",
              status: "active",
              note: "Total data spend across a job ≤ jobPrice × this.",
            },
            {
              label: "Per-purchase share of allowance",
              value: cfg.PER_PURCHASE_PCT,
              unit: "fraction of job allowance",
              bound: "maximum",
              status: "active",
              note: "Any single buy ≤ jobAllowance × this.",
            },
            ceiling,
          ],
        },
      ],
      movementCapsNote:
        "The Researcher CAN move funds — one path only: an x402 data purchase. It holds no signer " +
        "for a send, swap, bridge, Gateway spend, or escrow, and has no code path to any of them. " +
        "Every buy is gated by canSpend() before the EIP-3009 authorization is signed.",
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
      // Unified Balance (Gateway) SPEND — a separate movement surface with its own bounds. The
      // underlying executor (_ubspend.mjs) enforces nothing itself, so these are the only thing
      // standing between an instruction and the funds. Grouped apart from movementCaps because
      // a send/swap/bridge cap does NOT bound them.
      //
      // ⚠️ THE UB *DEPOSIT* BOUND USED TO BE LISTED HERE. IT WAS WRONG. A deposit is not an
      // Executor action at all — no agent path can reach it — so publishing it as an Executor
      // cap told the reader the agent is bounded when depositing, which implies the agent can
      // deposit. It cannot. Moved to `userControls` below.
      unifiedBalanceCaps: [
        cap("UB spend cap", ubSpendCapUsdc, "single cross-chain spend of the unified balance"),
        // A MINIMUM, not a maximum: the Forwarding Service fee is flat (~0.2 USDC), so a spend
        // below the floor is structurally uneconomical and is rejected. Valid: floor ≤ x ≤ cap.
        cap("UB spend floor", ubSpendFloorUsdc, "single cross-chain spend — REJECTED BELOW this", "minimum"),
      ],
      unifiedBalanceNote:
        "Valid UB spend is floor ≤ amount ≤ cap. The floor is a MINIMUM (a smaller spend is refused, " +
        "not allowed) — the flat forwarder fee makes small cross-chain spends uneconomical. These two " +
        "DO bind the Executor: it can spend the unified balance, and these bound that spend.",

      // ── NOT AN AGENT CAP. A bound on what the USER may do, listed here only because this is
      // where a reader comes looking for "what bounds the money". ──────────────────────────
      userControls: [
        {
          // cap() carries the fail-closed contract: a garbled env surfaces as
          // status:"misconfigured" + enforced:"REFUSED", never as a bare null that a reader
          // could mistake for "no limit". Same guarantee as every agent cap above.
          ...cap(
            "UB deposit — max per transaction",
            ubDepositMaxPerTxUsdc,
            "single deposit the USER makes into their own unified balance"
          ),
          boundsWhom: "THE USER, not the agent",
          isAgentCap: false,
          why: "Footgun guard on the one irreversible move in the app.",
          detail:
            "A Gateway deposit CANNOT BE UNDONE BY ANYONE. There is no implemented path that returns " +
            "unified-balance funds to the user — the only Gateway write path spends the balance " +
            "cross-chain, and the agent wallet is a dev-controlled SCA the user cannot move directly. " +
            "So a mistyped DEPOSIT is unrecoverable, where a mistyped WITHDRAWAL is simply redone. " +
            "This bounds the blast radius of an extra zero. That is all it does.",
          irreversible: true,
          canFundsBeReturnedToTheUser: "NO — no implemented path returns them. Spendable cross-chain only.",
          notAnAgentCap:
            "NO AGENT PATH CAN REACH THE DEPOSIT ENDPOINT. `ub_deposit` is not in the executor's " +
            "action vocabulary at all — _actions.mjs knows transfer_usdc / pay_for_service / " +
            "swap_tokens / bridge_usdc and throws `unknown step type` on anything else. No proposal " +
            "can propose it, no plan can contain it, agent-act cannot decide it. The sole caller is " +
            "the Fund button on the Unified Balance page, on a user clicking it with an amount they " +
            "typed. It bounds the user's own typo, never the agent's spending.",
          notAProtocolLimit:
            "It is NOT a Circle/Gateway protocol limit — no such limit exists.",
        },
      ],
    };
  }
  return null;
}

// WHICH AGENTS CAN MOVE VALUE — read from the REGISTRY (_agents.mjs), never re-derived here.
//
// This file briefly kept its own `new Set([RESEARCHER, EXECUTOR])`, which was a SECOND source of
// truth for a money claim sitting in a view — the exact pattern that let agents.mjs drift into
// telling users the Researcher could not move their funds. One registry owns it; every view
// reads it. A second copy that happens to agree today is still the bug, just not yet visible.
const movesFunds = (entry) => entry.movesFunds === true;

// The things no operator can dial. Stated as prose because they are guarantees, not values.
function invariantsFor(id) {
  const base = [
    "Every cap is enforced fail-closed: a misconfigured limit refuses the action, it never widens it.",
    "Cumulative autonomous spend is bounded by the daily ceiling regardless of any per-transaction cap.",
  ];

  if (id === AGENT.EXECUTOR) {
    return [
      "The Executor moves funds ONLY on an action you approved or an instruction you typed — it never originates a transfer.",
      "Caps are checked at the money chokepoint before any transaction is signed, never after.",
      ...base,
    ];
  }

  if (id === AGENT.RESEARCHER) {
    return [
      // The corrected statement. It says what the code does, not what we wish it did.
      "The Researcher holds no signer for a transfer, swap, bridge, Gateway spend, or escrow, and " +
        "has no code path to any of them. Its single exit to value is one x402 data purchase call " +
        "site (_research.mjs:301), which signs an EIP-3009 authorization against your wallet. That " +
        "spend is gated by canSpend() — per-job allowance and daily ceiling — before signing. There " +
        "is exactly one such call site.",
      // The escrow question, answered honestly rather than omitted.
      "On escrow: job-submit-background.mjs calls the ERC-8183 escrow, but the Researcher cannot " +
        "trigger it — those calls sit sequentially in the handler AFTER runResearch() returns, using " +
        "the handler's own client. _research.mjs holds no escrow reference and no signer. That is " +
        "shared-caller adjacency, not reachability.",
      ...base,
    ];
  }

  // analyst_b — audited and true: no executor, no signer, quotes and reads only.
  return [
    "This agent CANNOT move your funds. There is no code path from it to a transfer, swap, or bridge.",
    "It reaches only read-only pricing (estimateSwap quotes, the Circle fee API) and holds no signer.",
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
      error: requested ? `unknown agent "${requested}"` : "missing agent — use /api/v1/agent-parameters/<agent>",
      knownAgents: AGENTS.map((a) => ({ id: a.id, label: a.label })),
      aliases: Object.keys(ALIASES),
    });
  }

  const p = parametersFor(id);

  return json(200, {
    agent: {
      id: entry.id,
      label: entry.label,
      // From the registry. TRUE for the Researcher too — it signs an EIP-3009 transfer to buy
      // data. Bounded, but it moves real USDC out of your wallet, so it says so.
      movesFunds: movesFunds(entry),
    },

    // ── THE LABEL. Unmissable, and the first thing a reader hits. ──
    kind: "live-parameters",
    mutable: true,
    readAt: new Date().toISOString(),
    disclaimer:
      "LIVE AND MUTABLE. These are the agent's CURRENT operating parameters, re-read from " +
      "configuration on every request. An operator can change any of them at any time, so a " +
      "value here is true as of `readAt` and is NOT a promise about the future. They are the " +
      "same values the money paths enforce. Do NOT read them as guarantees — for the guarantees " +
      "see `invariants`, and fetch the IPFS document it points at: nothing served from this " +
      "endpoint carries any authority, including the invariant text mirrored below.",

    // Dials. Mutable.
    parameters: p,

    // ── THE INVARIANTS: A POINTER, NOT A CLAIM. ────────────────────────────────────────────
    //
    // ⚠️ THIS BLOCK USED TO SAY `mutable: false` AND `kind: "immutable-invariants"`. THAT WAS A
    // LIE — a polite one, but a lie. This is a MUTABLE endpoint. Anyone who can deploy can edit
    // these strings, and there is no hash, no signature, and nothing a reader can check them
    // against. Serving "immutable: true" from a server you control asserts a property you cannot
    // provide: the reader has no way to detect that you changed it. An unverifiable claim of
    // immutability is worse than no claim, because it invites trust it cannot earn.
    //
    // Immutability comes from the CHAIN, not from us. The authoritative invariants are the IPFS
    // document whose CID is recorded on-chain in tokenURI(agentId) on the ERC-8004 identity
    // registry. That CID is content-addressed: the bytes hash to it or they are not the document.
    // A reader verifies by fetching the IPFS bytes and hashing them against the on-chain CID —
    // that check does not involve us, and it is the only one worth anything.
    //
    // What we serve here is a CONVENIENCE COPY. It is labelled as one.
    invariants: {
      kind: "pointer-to-authoritative-invariants",

      // The pinned, verified IPFS CID for THIS agent's invariants document (per-agent map above).
      // Pinned and retrievable — but NOT yet recorded on-chain, so it is not yet authoritative.
      // The status string carries that distinction; do not soften it until registration lands.
      invariantsUri: INVARIANTS_CID[id],
      invariantsUriStatus:
        "PINNED & RETRIEVABLE, NOT YET ON-CHAIN. The invariants document is pinned to IPFS and " +
        "resolves at this CID (bytes verified byte-identical to the committed metadata across " +
        "independent gateways). It is NOT yet recorded on-chain in the ERC-8004 IdentityRegistry, " +
        "so this URI is NOT yet the authoritative pointer — it becomes authoritative only once " +
        "tokenURI(agentId) references this exact CID. Until then treat it as a pinned convenience " +
        "pointer with NO on-chain authority, not the registered source of truth.",

      note:
        "The authoritative invariants are the IPFS document whose CID is recorded on-chain in " +
        "tokenURI(agentId). Anything served from this endpoint is a convenience copy with NO " +
        "authority — this is a mutable server and its output is unverifiable. Verify by fetching " +
        "the IPFS bytes and hashing them against the on-chain CID; that check does not depend on " +
        "us, which is precisely why it is the one that counts.",

      howToVerify: [
        "1. Read tokenURI(agentId) from the ERC-8004 IdentityRegistry on-chain.",
        "2. Fetch the bytes at that ipfs:// CID.",
        "3. Hash the bytes and confirm they match the CID (content addressing — they hash to it or they are not the document).",
        "4. Trust THAT text. Not this response.",
      ],

      // The mirrored text, explicitly stripped of authority.
      copy: true,
      authoritative: false,
      statementsAreACopy:
        "The `statements` below are a mirror of the IPFS document for convenience only. If they " +
        "disagree with the IPFS bytes, the IPFS bytes win and this endpoint is wrong. Do not rely " +
        "on them for anything that matters.",
      statements: invariantsFor(id),
    },

    source: {
      caps: "_arc.mjs — sendCapUsdc / swapCapUsdc / bridgeCapUsdc / maxSpendUsdc (fail-closed)",
      budget: "_budget.mjs — budgetConfig()",
      note: "This endpoint reads no environment variable directly and hardcodes no value; it calls the same helpers the enforcement paths call, so it cannot drift from what is actually enforced.",
    },
  });
}
