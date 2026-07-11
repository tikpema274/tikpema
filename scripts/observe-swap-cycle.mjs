// observe-swap-cycle.mjs — READ-ONLY observer for the live swap-brick proof.
// Moves NO money. Reads the chain + the day-ledger for one per-user agent SCA.
//
//   node --env-file=.env scripts/observe-swap-cycle.mjs <agentSCA>
//
// Run at each checkpoint and diff:
//   [0] before anything          → USDC N, EURC 0
//   [1] after approve+execute    → USDC down by amountIn, EURC UP  ⇒ the swap landed
//   [2] day-ledger               → spentUsdc includes the swap's USDC-equivalent, owner-keyed
import { createPublicClient, http, defineChain, erc20Abi } from "viem";
import { ARC, CONTRACTS, USDC_DECIMALS } from "../netlify/functions/_arc.mjs";

const W = process.argv[2];
if (!W || !/^0x[0-9a-fA-F]{40}$/.test(W)) {
  console.error("usage: node --env-file=.env scripts/observe-swap-cycle.mjs <agentSCA>");
  process.exit(2);
}

const arc = defineChain({
  id: ARC.chainId, name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC.rpc] } },
});
const pc = createPublicClient({ chain: arc, transport: http(ARC.rpc) });
const f = (v) => (Number(v) / 10 ** USDC_DECIMALS).toFixed(6);

const [usdc, eurc] = await Promise.all([
  pc.readContract({ address: CONTRACTS.USDC, abi: erc20Abi, functionName: "balanceOf", args: [W] }),
  pc.readContract({ address: CONTRACTS.EURC, abi: erc20Abi, functionName: "balanceOf", args: [W] }),
]);

console.log("");
console.log("  agent SCA :", W);
console.log("  ──────────");
console.log("  USDC      :", f(usdc));
console.log("  EURC      :", f(eurc), " ← a swap USDC→EURC must move this UP");
console.log("");
console.log("  day-ledger key: day:" + W.toLowerCase() + ":" + new Date().toISOString().slice(0, 10));
console.log("  (read it with:  netlify blobs:get data-budget \"day:" + W.toLowerCase() + ":" + new Date().toISOString().slice(0, 10) + "\")");
console.log("");
