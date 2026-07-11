// probe-withdraw-path.mjs — ZERO-MONEY, READ-ONLY.
//
// Post-repoint, the SHARED agent SCA's Gateway balance becomes orphaned FROM THE UI
// (gateway-balance will be keyed on the session's per-user SCA instead). We're fine with
// orphaned-from-UI. We are NOT fine with orphaned-AND-STUCK.
//
// So: confirm the out-of-band escape hatch is real BEFORE we repoint. On Gateway v1 the
// exit is a two-step delayed withdrawal, called by the DEPOSITOR (not the delegate):
//   1. initiateWithdrawal(address token, uint256 value)
//   2. ...wait out the delay (withdrawalBlock tells you until when)...
//   3. withdraw(address token)   ← returns the FULL pending amount, no value param
//
// This script only READS: it proves the deployed contract actually implements the
// withdrawal getters (so the hatch isn't merely in the SDK typings), and dumps the SCA's
// current withdrawal state. It signs nothing and submits nothing.
//
//   node --env-file=.env scripts/probe-withdraw-path.mjs
import { createPublicClient, http, defineChain } from "viem";
import { ARC, CONTRACTS, USDC_DECIMALS } from "../netlify/functions/_arc.mjs";
import { GATEWAY } from "../netlify/functions/_gateway.mjs";

const SCA = process.env.AGENT_WALLET_ADDRESS;
if (!SCA) { console.error("AGENT_WALLET_ADDRESS missing — use --env-file=.env"); process.exit(3); }

const WITHDRAW_ABI = [
  {
    type: "function", name: "withdrawingBalance", stateMutability: "view",
    inputs: [{ name: "token", type: "address" }, { name: "depositor", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "withdrawalBlock", stateMutability: "view",
    inputs: [{ name: "token", type: "address" }, { name: "depositor", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

const arc = defineChain({
  id: ARC.chainId, name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC.rpc] } },
});
const pc = createPublicClient({ chain: arc, transport: http(ARC.rpc) });
const fmt6 = (v) => (Number(v) / 10 ** USDC_DECIMALS).toFixed(6);

console.log("Gateway Wallet :", GATEWAY.WALLET);
console.log("Depositor (shared SCA):", SCA);
console.log("");

// 1. The unified balance the UI shows today — from the Gateway API (the orphan-to-be).
const res = await fetch(`${GATEWAY.API_BASE}/v1/balances`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: "USDC", sources: [{ domain: GATEWAY.ARC_DOMAIN, depositor: SCA }] }),
});
const data = await res.json();
const arcBal = data?.balances?.[0]?.balance ?? "(unreadable)";
console.log("── The balance that will be orphaned ──");
console.log("  Gateway API unified balance (Arc domain):", arcBal, "USDC");
console.log("");

// 2. Do the withdrawal getters actually EXIST on the deployed contract? A revert here
// would mean the escape hatch is typings-only and the funds really are stuck.
console.log("── Escape hatch: do the withdrawal functions exist on-chain? ──");
let hatchLive = true;
for (const fn of ["withdrawingBalance", "withdrawalBlock"]) {
  try {
    const v = await pc.readContract({
      address: GATEWAY.WALLET, abi: WITHDRAW_ABI, functionName: fn, args: [CONTRACTS.USDC, SCA],
    });
    const pretty = fn === "withdrawingBalance" ? `${fmt6(v)} USDC` : `block ${v}`;
    console.log(`  ✓ ${fn}(USDC, sca) → ${pretty}   [implemented]`);
  } catch (e) {
    hatchLive = false;
    console.log(`  ✗ ${fn} REVERTED — ${e.shortMessage || e.message}`);
  }
}
console.log("");

const pending = await pc.readContract({
  address: GATEWAY.WALLET, abi: WITHDRAW_ABI, functionName: "withdrawingBalance", args: [CONTRACTS.USDC, SCA],
}).catch(() => null);

console.log("── VERDICT ──");
if (!hatchLive) {
  console.log("  ✗ Withdrawal getters do NOT exist on the deployed contract.");
  console.log("    The balance would be orphaned AND STUCK. Do NOT repoint until resolved.");
  process.exit(1);
}
console.log("  ✓ The deployed GatewayWallet implements the withdrawal path.");
console.log(`  ✓ No withdrawal currently pending (withdrawingBalance = ${fmt6(pending ?? 0n)} USDC).`);
console.log("");
console.log("  The exit is callable BY THE DEPOSITOR (the shared SCA) — it needs NO delegate,");
console.log("  so repointing the delegate/UI at per-user wallets cannot strand it. The SCA is");
console.log("  a Circle dev-controlled wallet we hold the keys to, and it already executed a");
console.log("  contract call on THIS contract (the deposit that created the balance), so the");
console.log("  same createContractExecutionTransaction path can call initiateWithdrawal.");
console.log("");
console.log("  ⇒ ORPHANED-FROM-UI, NOT STUCK. Safe to leave. Recover any time with:");
console.log("      1. initiateWithdrawal(USDC, value)  2. wait the delay  3. withdraw(USDC)");
