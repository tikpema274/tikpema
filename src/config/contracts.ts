// Arc Testnet contract addresses (chain 5042002).
// USDC is the native gas token; 0x3600... is the ERC-20 interface to it (6 dp).
export const CONTRACTS = {
  USDC: "0x3600000000000000000000000000000000000000",
  EURC: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
  PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",

  // TikpemaPrediction — parimutuel prediction market (USDC stakes), live on Arc Testnet.
  TIKPEMA_PREDICTION: "0xf38492403ce3f1c94ef6322b78c9024d26ed87e1",

  // AgenticCommerce — ERC-8183 job/escrow contract (proxy), live on Arc Testnet.
  AGENTIC_COMMERCE: "0x0747EEf0706327138c69792bF28Cd525089e4583",

  // ERC-8004 agent registries (the AGENT plane talks to these)
  IDENTITY_REGISTRY: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  REPUTATION_REGISTRY: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  VALIDATION_REGISTRY: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
} as const;

export const USDC_DECIMALS = 6;
