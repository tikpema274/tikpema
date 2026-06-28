// Server-side mirror of Arc constants (functions can't import src/ TS cleanly).
export const ARC = {
  blockchain: "ARC-TESTNET",          // Circle SDK chain id
  chainId: 5042002,
  rpc: "https://rpc.testnet.arc.network",
  explorer: "https://testnet.arcscan.app",
};

export const CONTRACTS = {
  USDC: "0x3600000000000000000000000000000000000000",
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
