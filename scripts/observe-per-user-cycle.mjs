// observe-per-user-cycle.mjs — READ-ONLY observer for the live commit-gate run.
// Moves NO money. Reads chain + Gateway state for ONE per-user SCA so we can prove the
// fund → delegate → deposit → spend cycle from ground truth rather than from our own logs.
//
// Run it at each checkpoint of the live run and diff the output:
//
//   node --env-file=.env scripts/observe-per-user-cycle.mjs <yourAgentSCA>
//
//   [0] after registering the fresh passkey (BEFORE funding)
//        expect: usdc 0 · gas 0 · delegate NOT authorized · unified 0
//   [1] after HOP A (fund the agent wallet from the login wallet)
//        expect: usdc N · gas N (same number — on Arc USDC IS gas) · delegate still NOT authorized
//   [2] after the FIRST deposit  → the grant fires here
//        expect: delegate AUTHORIZED · unified > 0 · usdc dropped by the deposit
//        ⇒ compare usdc between [1] and [2]: the gap beyond the deposit amount IS the grant's
//          gas. Zero gap ⇒ the grant was PAYMASTER-SPONSORED. That settles the question.
//   [3] after a SECOND deposit
//        expect: delegate still authorized, and the API's delegateTxHash was NULL
//        ⇒ grant-once / idempotence, proven on-chain.
//   [4] after a SPEND
//        expect: unified down by the spend; the day-ledger recorded it against THIS owner.
import { createPublicClient, http, defineChain, erc20Abi } from "viem";
import { ARC, CONTRACTS, USDC_DECIMALS } from "../netlify/functions/_arc.mjs";
import { GATEWAY } from "../netlify/functions/_gateway.mjs";

const SCA = process.argv[2];
const DELEGATE = process.env.DELEGATE_ADDRESS;
if (!SCA || !/^0x[0-9a-fA-F]{40}$/.test(SCA)) {
  console.error("usage: node --env-file=.env scripts/observe-per-user-cycle.mjs <yourAgentSCA>");
  process.exit(2);
}

const GATEWAY_ABI = [
  {
    type: "function", name: "isAuthorizedForBalance", stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "depositor", type: "address" },
      { name: "addr", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
];

const arc = defineChain({
  id: ARC.chainId, name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC.rpc] } },
});
const pc = createPublicClient({ chain: arc, transport: http(ARC.rpc) });

const [usdc, gas, authed] = await Promise.all([
  pc.readContract({ address: CONTRACTS.USDC, abi: erc20Abi, functionName: "balanceOf", args: [SCA] }),
  pc.getBalance({ address: SCA }),
  pc.readContract({
    address: GATEWAY.WALLET, abi: GATEWAY_ABI, functionName: "isAuthorizedForBalance",
    args: [CONTRACTS.USDC, SCA, DELEGATE],
  }).catch((e) => `ERROR: ${e.shortMessage || e.message}`),
]);

// The unified (Gateway) balance, straight from Circle's API — the same source the UI reads.
let unified = "(unreadable)";
try {
  const r = await fetch(`${GATEWAY.API_BASE}/v1/balances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "USDC", sources: [{ domain: GATEWAY.ARC_DOMAIN, depositor: SCA }] }),
  });
  const d = await r.json();
  unified = d?.balances?.[0]?.balance ?? "0";
} catch {}

const fmt6 = (v) => (Number(v) / 10 ** USDC_DECIMALS).toFixed(6);
const fmt18 = (v) => (Number(v) / 1e18).toFixed(6);

console.log("");
console.log("  agent SCA        :", SCA);
console.log("  delegate         :", DELEGATE);
console.log("  ─────────────────");
console.log("  plain USDC       :", fmt6(usdc), " (6-dp ERC-20 — what ubDeposit's funds-check reads)");
console.log("  native gas       :", fmt18(gas), " (18-dp — SAME balance; on Arc USDC *is* gas)");
console.log("  delegate authed  :", authed, authed === true ? "← grant has fired" : "← grant NOT yet fired");
console.log("  unified (Gateway):", unified, "USDC");
console.log("");
