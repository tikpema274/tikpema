import { defineChain } from "viem";

// Hand-rolled Arc Testnet definition.
// NOTE: we define this ourselves rather than importing from viem/chains or
// Circle's chain export. Circle's def used `rpcEndpoints` instead of viem's
// expected `rpcUrls`, which throws "Invalid URL" at transport construction.
// This shape is the one verified working on Arc.
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: {
    default: { name: "Arcscan", url: "https://testnet.arcscan.app" },
  },
  testnet: true,
});

export const ARC_CHAIN_HEX = "0x4CEF52"; // 5042002
