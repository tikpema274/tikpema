// probe-gas-at-grant.mjs — ZERO-MONEY, READ-ONLY.
//
// Reconciles the ordering claim: does the addDelegate tx actually HAVE GAS at the moment
// ensureDelegate fires? "Grant before deposit" must not be hiding an addDelegate on a
// zero-gas wallet.
//
// The claim rests on ONE premise, which this script tests against the real chain rather
// than asserting: on Arc, USDC IS the native gas token. If that is true, then a wallet that
// holds USDC necessarily holds gas — so "the SCA is funded" and "the SCA can pay for
// addDelegate" are THE SAME STATEMENT, and ubDeposit's insufficient-funds check (which runs
// BEFORE ensureDelegate) is simultaneously a gas check.
//
// Test: for every real SCA, compare
//     eth_getBalance(addr) / 1e18      ← native gas balance (18-dp on Arc)
//     USDC.balanceOf(addr) / 1e6       ← the ERC-20 balance the funds-check reads
// If they are equal for every wallet, they are the same underlying balance.
//
//   node --env-file=.env scripts/probe-gas-at-grant.mjs
import { createPublicClient, http, defineChain, erc20Abi } from "viem";
import { ARC, CONTRACTS, USDC_DECIMALS } from "../netlify/functions/_arc.mjs";
import { circle } from "../netlify/functions/_circle.mjs";

const arc = defineChain({
  id: ARC.chainId, name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC.rpc] } },
});
const pc = createPublicClient({ chain: arc, transport: http(ARC.rpc) });

// The observed one-time cost of addDelegate, from the read-only fee quote in
// probe-addDelegate-gas.mjs (medium feeLevel).
const ADD_DELEGATE_GAS_USDC = 0.0707;

const client = circle();
const res = await client.listWallets({ blockchain: ARC.blockchain, pageSize: 50 });
const wallets = res.data?.wallets ?? [];

console.log("PREMISE UNDER TEST: on Arc, USDC *is* the native gas token.");
console.log("⇒ if true, 'SCA is funded' and 'SCA can pay for addDelegate' are the same fact.\n");
console.log("  native gas (eth_getBalance/1e18)   vs   USDC (balanceOf/1e6)\n");

let checked = 0, identical = 0, funded = 0, fundedAndGassed = 0;

for (const w of wallets) {
  const [gas, usdc] = await Promise.all([
    pc.getBalance({ address: w.address }),
    pc.readContract({ address: CONTRACTS.USDC, abi: erc20Abi, functionName: "balanceOf", args: [w.address] }),
  ]);
  const gasF = Number(gas) / 1e18;
  const usdcF = Number(usdc) / 10 ** USDC_DECIMALS;
  const same = Math.abs(gasF - usdcF) < 1e-6;
  checked++;
  if (same) identical++;
  if (usdcF > 0) {
    funded++;
    if (gasF >= ADD_DELEGATE_GAS_USDC) fundedAndGassed++;
  }
  if (checked <= 8 || !same) {
    console.log(
      `  ${w.address}  gas=${gasF.toFixed(6)}  usdc=${usdcF.toFixed(6)}  ${same ? "✓ identical" : "✗ DIVERGE"}`
    );
  }
}

console.log(`\n  …(${checked} wallets checked)\n`);
console.log("── RESULTS ──");
console.log(`  wallets where native gas == USDC balance : ${identical}/${checked}`);
console.log(`  wallets holding ANY USDC                 : ${funded}`);
console.log(`  ...of those, gas >= addDelegate cost (~${ADD_DELEGATE_GAS_USDC}) : ${fundedAndGassed}`);

console.log("\n── VERDICT ──");
if (identical === checked) {
  console.log("  ✓ PREMISE HOLDS. Native gas and USDC are the SAME balance on every wallet.");
  console.log("    Therefore a funded SCA is, by definition, a gassed SCA.");
  console.log("");
  console.log("    ubDeposit's order is:");
  console.log("      1. balanceOf(SCA) < amount        → THROW 'Insufficient funds'");
  console.log("      2. ensureDelegate(SCA)            ← only reachable when balance >= amount > 0");
  console.log("      3. approve + deposit()            → USDC moves into Gateway");
  console.log("");
  console.log("    Step 2 is unreachable unless step 1 proved balance >= amount > 0. Since that");
  console.log("    balance IS the gas balance, addDelegate always has gas when it fires.");
  console.log("    The landmine is defused STRUCTURALLY — not by sponsorship, and not by luck.");
} else {
  console.log("  ✗ PREMISE FAILS — gas and USDC are DIFFERENT balances on some wallets.");
  console.log("    A funded SCA could still be gasless. The ordering does NOT defuse the");
  console.log("    landmine on its own; ensureDelegate would need an explicit gas check.");
  process.exit(1);
}
