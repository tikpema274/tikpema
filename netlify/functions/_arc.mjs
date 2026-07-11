// Server-side mirror of Arc constants (functions can't import src/ TS cleanly).
export const ARC = {
  blockchain: "ARC-TESTNET",          // Circle SDK chain id
  chainId: 5042002,
  rpc: "https://rpc.testnet.arc.network",
  explorer: "https://testnet.arcscan.app",
};

export const CONTRACTS = {
  USDC: "0x3600000000000000000000000000000000000000",
  // EURC — Circle's euro stablecoin on Arc Testnet (6 decimals, like USDC).
  // Displayed as a second wallet balance; NOT summed with USDC (different unit).
  EURC: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
  IDENTITY_REGISTRY: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  REPUTATION_REGISTRY: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  VALIDATION_REGISTRY: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
  // TikpemaPrediction — parimutuel prediction market (USDC stakes), live on Arc Testnet.
  TIKPEMA_PREDICTION: "0xf38492403ce3f1c94ef6322b78c9024d26ed87e1",
  // AgenticCommerce — ERC-8183 job/escrow contract (proxy), live on Arc Testnet.
  AGENTIC_COMMERCE: "0x0747EEf0706327138c69792bF28Cd525089e4583",
};

export const USDC_DECIMALS = 6;

export const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const parseBody = (event) => {
  try {
    return JSON.parse(event.body || "{}");
  } catch {
    return {};
  }
};

// Anchor the model to today's server date so it doesn't infer past-vs-future
// from its training cutoff. Computed at call time — never hardcoded.
export function dateAnchor() {
  const date = new Date().toISOString().slice(0, 10);
  return `Today's date is ${date}. A date on or before today has already occurred and is knowable; only dates after today are future/uncertain. Do not infer past-vs-future from your training data — use today's date as the sole reference.`;
}

// Per-transaction USDC spend cap, parsed to FAIL CLOSED:
//   - unset / blank  → default 1
//   - explicit "0"   → 0 (freeze all spending; the legacy `|| "1"` turned 0 into 1)
//   - non-numeric / negative → throws, so a typo can't silently disable the
//     guard. The legacy `Number(...)` produced NaN here, and `amount > NaN` is
//     always false — i.e. every spend slipped through. Callers run inside (or
//     guard with) try/catch, so a throw surfaces as a 500 and no funds move.
export const maxSpendUsdc = () => {
  const raw = process.env.AGENT_MAX_SPEND_USDC;
  if (raw === undefined || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `AGENT_MAX_SPEND_USDC is misconfigured (${JSON.stringify(raw)}); refusing to spend`
    );
  }
  return n;
};

// Per-transaction cap on agent SENDS/TRANSFERS specifically (both user-directed
// via agent-send and autonomous via agent-act/execute-plan). Separate from
// AGENT_MAX_SPEND_USDC so the later tiered model can raise user-directed sends
// without loosening the autonomous cap. Conservative default so a bug or bad
// instruction can't drain much on testnet. Same fail-closed parsing as above.
export const sendCapUsdc = () => {
  const raw = process.env.AGENT_SEND_CAP_USDC;
  if (raw === undefined || raw === "") return 5; // conservative testnet default
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `AGENT_SEND_CAP_USDC is misconfigured (${JSON.stringify(raw)}); refusing to send`
    );
  }
  return n;
};

// Per-BRIDGE cap (cross-chain is the highest-stakes action — funds LEAVE Arc).
// Separate from the send cap so bridges can be bounded independently. Same
// fail-closed parsing: unset → conservative default; garbled → throw (a typo can
// never silently widen the bound). Cumulative bridges ALSO count against the
// _budget.mjs day-ceiling (PERIOD_CEILING_USDC), like every other agent spend.
export const bridgeCapUsdc = () => {
  const raw = process.env.AGENT_BRIDGE_CAP_USDC;
  if (raw === undefined || raw === "") return 25; // conservative testnet default
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `AGENT_BRIDGE_CAP_USDC is misconfigured (${JSON.stringify(raw)}); refusing to bridge`
    );
  }
  return n;
};

// Per-SWAP cap (USDC↔EURC on Arc). Swap was executable with NO per-transaction bound —
// only the day-ceiling — while send and bridge each had one. That was a real hole: a single
// bad instruction could swap the whole wallet in one action. It becomes a worse hole the
// moment swap is PROPOSABLE, so this lands first.
//
// ⚠️ The bound is in USDC-EQUIVALENT, not in the input token. A swap's amountIn may be EURC,
// and EURC != $1 — so the caller MUST convert with valueInUsdc() before comparing. Bounding
// the raw amountIn would silently mis-bound every EURC→USDC swap.
//
// Same fail-closed parse as the others: unset → conservative default; garbled → throw.
export const swapCapUsdc = () => {
  const raw = process.env.AGENT_SWAP_CAP_USDC;
  if (raw === undefined || raw === "") return 25; // conservative testnet default (matches bridge)
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `AGENT_SWAP_CAP_USDC is misconfigured (${JSON.stringify(raw)}); refusing to swap`
    );
  }
  return n;
};

// Per-UB-SPEND cap (the WRITE side of Unified Balance — a cross-chain spend of the
// agent's Arc unified balance to another chain). Its own bound, same fail-closed
// parse. CRITICAL: kit.unifiedBalance.spend / _ubspend.mjs are UNCAPPED, so the
// wrapper (agent-ub-spend.mjs) MUST call this and reject BEFORE spending — reaching
// the executor unguarded would bypass the cap (the swap-cap trap).
export const ubSpendCapUsdc = () => {
  const raw = process.env.AGENT_UB_SPEND_CAP_USDC;
  if (raw === undefined || raw === "") return 50; // raised from the 1 first-proof value
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `AGENT_UB_SPEND_CAP_USDC is misconfigured (${JSON.stringify(raw)}); refusing to spend`
    );
  }
  return n;
};

// Per-UB-DEPOSIT cap (funding the agent's OWN unified balance: plain Arc USDC → the
// Gateway Wallet contract, credited to the SCA). Same fail-closed parse as the others.
// CRITICAL: _ubdeposit.mjs is UNCAPPED, so the wrapper (agent-ub-deposit.mjs) MUST call
// this and reject BEFORE approving/depositing — reaching the executor unguarded would
// bypass the cap (the swap-cap trap). No FLOOR: unlike the cross-chain spend, a deposit
// pays no flat forwarder fee, so small deposits are not uneconomical.
export const ubDepositCapUsdc = () => {
  const raw = process.env.AGENT_UB_DEPOSIT_CAP_USDC;
  if (raw === undefined || raw === "") return 25; // conservative default, matches the bridge cap
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `AGENT_UB_DEPOSIT_CAP_USDC is misconfigured (${JSON.stringify(raw)}); refusing to deposit`
    );
  }
  return n;
};

// Per-UB-SPEND FLOOR (minimum). The Forwarding Service fee is FLAT (~0.2 USDC to an L2,
// amount-independent), so small cross-chain spends are structurally uneconomical (a 0.1
// spend is ~200% fee). Reject below the floor BEFORE any spend, same fail-closed parse as
// the cap. Default 10 if unset. Valid range is floor <= amount <= cap.
export const ubSpendFloorUsdc = () => {
  const raw = process.env.AGENT_UB_SPEND_FLOOR_USDC;
  if (raw === undefined || raw === "") return 10; // conservative default (fee ~<2% at 10)
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `AGENT_UB_SPEND_FLOOR_USDC is misconfigured (${JSON.stringify(raw)}); refusing to spend`
    );
  }
  return n;
};
