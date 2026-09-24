// plan-capabilities.mjs — WHAT THE AGENT CAN PLAN, AND WHERE IT CAN BRIDGE. ONE SOURCE.
//
// ⛔ PURE DATA, NO IMPORTS. It is read by the server (_bridge.mjs, _swap-tokens.mjs, plan-quote.mjs)
// AND by the client bundle (PlanPanel, BridgePanel, TreasuryPanel), so it must never import server code.
//
// ═══ WHY THIS EXISTS ══════════════════════════════════════════════════════════════════════════
// These lists were hand-written in FIVE places: PlanPanel's intro, the plan refusal examples,
// plan-quote's classifier prompt, BridgePanel's picker and TreasuryPanel's picker. They drifted once
// already — when swap was added, the classifier prompt kept saying "the agent can only bridge" and
// silently declined every swap task. verify-plan-capabilities.tsx fails when any surface disagrees.
//
// ⚠️ Not on the DD surface (scripts/stamp-build.mjs DD_SURFACE_*): editing this rotates no ddTree.

// Moved VERBATIM from _bridge.mjs, which re-exports it (the server's resolution logic stays there).
export const BRIDGE_DESTINATIONS = {
  ethereum: { label: "Ethereum (Sepolia)", cctpDomain: 0, explorerTx: "https://sepolia.etherscan.io/tx/", aliases: ["ethereum", "eth", "sepolia", "ethereum sepolia", "l1", "mainnet"] },
  base: { label: "Base (Sepolia)", cctpDomain: 6, explorerTx: "https://sepolia.basescan.org/tx/", aliases: ["base", "base sepolia"] },
  arbitrum: { label: "Arbitrum (Sepolia)", cctpDomain: 3, explorerTx: "https://sepolia.arbiscan.io/tx/", aliases: ["arbitrum", "arb", "arbitrum sepolia"] },
  optimism: { label: "Optimism (Sepolia)", cctpDomain: 2, explorerTx: "https://sepolia-optimism.etherscan.io/tx/", aliases: ["optimism", "op", "optimism sepolia"] },
  avalanche: { label: "Avalanche (Fuji)", cctpDomain: 1, explorerTx: "https://testnet.snowtrace.io/tx/", aliases: ["avalanche", "avax", "fuji"] },
  polygon: { label: "Polygon (Amoy)", cctpDomain: 7, explorerTx: "https://amoy.polygonscan.com/tx/", aliases: ["polygon", "matic", "amoy", "polygon amoy"] },
  unichain: { label: "Unichain (Sepolia)", cctpDomain: 10, explorerTx: "https://sepolia.uniscan.xyz/tx/", aliases: ["unichain"] },
  linea: { label: "Linea (Sepolia)", cctpDomain: 11, explorerTx: "https://sepolia.lineascan.build/tx/", aliases: ["linea", "linea sepolia"] },
};

// ⭐ DISPLAY ORDER IS DATA, NOT AN ACCIDENT OF OBJECT KEY ORDER. Two user-facing orders exist and
// both are preserved exactly as they were before this module:
//   prose  — how the PlanPanel intro and the classifier prompt list the chains (Ethereum first)
//   picker — how BridgePanel and TreasuryPanel order their <select> (Base first)
// Each must be an exact permutation of the destination keys (asserted by the guard).
export const DESTINATION_ORDER = Object.freeze({
  prose: Object.freeze(["ethereum", "base", "arbitrum", "optimism", "avalanche", "polygon", "unichain", "linea"]),
  picker: Object.freeze(["base", "ethereum", "arbitrum", "optimism", "avalanche", "polygon", "unichain", "linea"]),
});

/** The only two tokens the Arc swap venue supports. Moved from _swap-tokens.mjs, which re-exports it. */
export const SWAP_TOKENS = ["USDC", "EURC"];

/** The actions the PLAN path (plan-quote → job-run → proposal) can propose. A subset of STEP_TYPES
 *  (_actions.mjs); the chat agent can do more (vault, send, pay) — the Plan page cannot. */
export const PLAN_ACTIONS = Object.freeze(["bridge_usdc", "swap_tokens"]);

/** "Ethereum (Sepolia)" → "Ethereum": the name prose uses. */
export const destinationShortName = (key) => String(BRIDGE_DESTINATIONS[key]?.label ?? key).replace(/\s*\(.*\)\s*$/, "");
