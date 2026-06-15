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
