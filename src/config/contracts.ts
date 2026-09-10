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

// ═══ ⭐⭐ ONE ASSET, TWO PRECISION VIEWS — the client half of _arc.mjs's note ═══════════════════
// On Arc, USDC is the NATIVE gas token AND an ERC-20 at the address above. Both interfaces answer
// about the SAME balance at different scales: native (eth_getBalance, msg.value) is 18 decimals,
// ERC-20 (balanceOf, transfer, allowance) is 6.
//
// ⛔ NEVER ADD THEM and never show two USDC rows — that double-counts one balance.
// ⚠️ Reusing a raw integer across the two shifts the amount by 10^12. Circle's own Arc guidance is
// blunt about it: "never compare raw values across interfaces without conversion."
// 🚨 THE 6-dp VIEW IS LOSSY: anything under 1e-6 USDC is INVISIBLE to balanceOf, so a balanceOf of
// 0 does NOT prove the balance is zero. The NATIVE balance is the canonical source for a display.
export const USDC_DECIMALS = 6;
export const USDC_NATIVE_DECIMALS = 18;
