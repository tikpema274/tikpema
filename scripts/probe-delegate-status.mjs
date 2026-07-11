// probe-delegate-status.mjs — ZERO-MONEY, READ-ONLY delegate probe.
//
// THE QUESTION: `_ubspend.mjs` / `_pay.mjs` spend the SHARED SCA's Gateway balance by
// having DELEGATE_ADDRESS sign with sourceAccount = the SCA (a Circle SCA can't sign its
// own Gateway spend — ERC-1271 is rejected by ecrecover). Nothing in this repo ever calls
// addDelegate, so the shared SCA's delegate authority was established out-of-band.
//
// Per-user Gateway hinges on ONE fact: is that same delegate ALREADY authorized on a
// freshly-provisioned per-user SCA, or does each user's SCA need its own on-chain
// addDelegate (a gas-requiring tx on a wallet that starts empty → chicken-and-egg)?
//
// Gateway v1 exposes this as a plain view:
//   isAuthorizedForBalance(address token, address depositor, address addr) -> bool
// (confirmed in @circle-fin/provider-gateway-v1/index.d.ts:2772 — the `gateway.v1.isDelegate`
// action). We call it with a bare eth_call: no adapter, no kit, no signer. This script is
// STRUCTURALLY incapable of moving money — it only reads, and only lists Circle wallets.
//
//   node --env-file=.env scripts/probe-delegate-status.mjs
import { createPublicClient, http, defineChain } from "viem";
import { ARC, CONTRACTS } from "../netlify/functions/_arc.mjs";
import { GATEWAY } from "../netlify/functions/_gateway.mjs";
import { circle } from "../netlify/functions/_circle.mjs";

const SHARED_SCA = process.env.AGENT_WALLET_ADDRESS;
const DELEGATE = process.env.DELEGATE_ADDRESS;
if (!SHARED_SCA || !DELEGATE) {
  console.error("AGENT_WALLET_ADDRESS / DELEGATE_ADDRESS missing — use --env-file=.env");
  process.exit(3);
}

const GATEWAY_ABI = [
  {
    type: "function",
    name: "isAuthorizedForBalance",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "depositor", type: "address" },
      { name: "addr", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
];

const arc = defineChain({
  id: ARC.chainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC.rpc] } },
});
const pc = createPublicClient({ chain: arc, transport: http(ARC.rpc) });

// One read: is `delegate` authorized to spend `depositor`'s Gateway USDC balance?
async function isAuthorized(depositor, delegate) {
  try {
    return await pc.readContract({
      address: GATEWAY.WALLET,
      abi: GATEWAY_ABI,
      functionName: "isAuthorizedForBalance",
      args: [CONTRACTS.USDC, depositor, delegate],
    });
  } catch (e) {
    return `ERROR: ${e.shortMessage || e.message}`;
  }
}

console.log("Gateway Wallet :", GATEWAY.WALLET);
console.log("USDC (Arc)     :", CONTRACTS.USDC);
console.log("Delegate       :", DELEGATE);
console.log("");

// ── 1. BASELINE — the shared SCA. This is the path that works in production today,
// so it MUST read true. If it reads false, our whole model of why spend works is wrong.
const baseline = await isAuthorized(SHARED_SCA, DELEGATE);
console.log("── BASELINE (shared agent SCA — the funded, working one) ──");
console.log("  depositor:", SHARED_SCA);
console.log("  isAuthorizedForBalance(USDC, sharedSCA, delegate) =", baseline);
console.log("");

// ── 2. Every OTHER Circle wallet on this entity. The per-user SCAs provisioned by
// ensureOwnerWallet live here (Blobs only maps owner→walletId; the wallets themselves
// are Circle-side). listWallets is a READ. If any per-user SCA exists, it is the exact
// subject of the question: same entity, same API key, same accountType — but never
// addDelegate'd.
const client = circle();
const res = await client.listWallets({ blockchain: ARC.blockchain, pageSize: 50 });
const wallets = res.data?.wallets ?? [];

const known = new Set(
  [SHARED_SCA, DELEGATE, process.env.VANILLA_SELLER_ADDRESS]
    .filter(Boolean)
    .map((a) => a.toLowerCase())
);
const others = wallets.filter((w) => !known.has(w.address.toLowerCase()));

console.log(`── OTHER Circle wallets on this entity (${others.length} of ${wallets.length} total) ──`);
if (!others.length) {
  console.log("  none — no per-user SCA has been provisioned yet on this entity.");
  console.log("  (A fresh one would be created by ensureOwnerWallet on first login.)");
}

for (const w of others) {
  const authed = await isAuthorized(w.address, DELEGATE);
  console.log("");
  console.log("  wallet   :", w.address);
  console.log("  type     :", w.accountType, "| created:", w.createDate);
  console.log("  isAuthorizedForBalance(USDC, thisWallet, delegate) =", authed);
}

console.log("");
console.log("── VERDICT ──");
console.log("  shared SCA authorized :", baseline);
const perUser = [];
for (const w of others) perUser.push(await isAuthorized(w.address, DELEGATE));
const anyPerUserAuthed = perUser.some((v) => v === true);
if (others.length === 0) {
  console.log("  per-user SCA          : NONE PROVISIONED — cannot empirically confirm.");
} else {
  console.log("  per-user SCA(s) authorized:", perUser.join(", "));
  console.log(
    anyPerUserAuthed
      ? "  → delegate CARRIES OVER to per-user SCAs. Contained scope."
      : "  → delegate does NOT carry over. Each SCA needs addDelegate (gas on an empty wallet)."
  );
}
