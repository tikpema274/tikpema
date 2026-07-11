// probe-addDelegate-gas.mjs — ZERO-MONEY, READ-ONLY.
//
// THE QUESTION: probe-delegate-status proved the delegate does NOT carry over — every
// per-user SCA reads isAuthorizedForBalance == false. So each needs a one-time on-chain
// addDelegate(token, delegate). On Arc, gas IS USDC — so if a freshly-provisioned (empty)
// SCA must pay its own gas, we have an empty-wallet chicken-and-egg.
//
// This settles it from GROUND TRUTH, not from a comment. Circle dev-controlled SCA txs are
// ERC-4337 userOps, so the EntryPoint emits:
//   UserOperationEvent(bytes32 userOpHash, address sender, address paymaster, uint256 nonce,
//                      bool success, uint256 actualGasCost, uint256 actualGasUsed)
// The `paymaster` field is the answer:
//   paymaster != 0x0  ⇒ a paymaster paid the gas ⇒ SPONSORED (Gas Station)
//   paymaster == 0x0  ⇒ the SCA paid its own gas ⇒ NOT sponsored
//
// We pull REAL confirmed txs from per-user SCAs via Circle's listTransactions (a READ),
// then decode their receipts on-chain. Nothing is signed, submitted, or estimated into
// existence. Also runs estimateContractExecutionFee on the addDelegate call itself — a
// read-only quote — to see what Circle says the call would cost from an EMPTY wallet.
//
//   node --env-file=.env scripts/probe-addDelegate-gas.mjs
import { createPublicClient, http, defineChain, parseEventLogs, erc20Abi } from "viem";
import { ARC, CONTRACTS } from "../netlify/functions/_arc.mjs";
import { GATEWAY } from "../netlify/functions/_gateway.mjs";
import { circle } from "../netlify/functions/_circle.mjs";

const SHARED_SCA = process.env.AGENT_WALLET_ADDRESS;
const DELEGATE = process.env.DELEGATE_ADDRESS;

const arc = defineChain({
  id: ARC.chainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC.rpc] } },
});
const pc = createPublicClient({ chain: arc, transport: http(ARC.rpc) });

// ERC-4337 EntryPoint event. We match by ABI, not by hardcoding an EntryPoint address,
// so this works regardless of which EntryPoint version Circle uses on Arc.
const ENTRYPOINT_ABI = [
  {
    type: "event",
    name: "UserOperationEvent",
    inputs: [
      { name: "userOpHash", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "paymaster", type: "address", indexed: true },
      { name: "nonce", type: "uint256", indexed: false },
      { name: "success", type: "bool", indexed: false },
      { name: "actualGasCost", type: "uint256", indexed: false },
      { name: "actualGasUsed", type: "uint256", indexed: false },
    ],
  },
];

const ZERO = "0x0000000000000000000000000000000000000000";
const fmt6 = (v) => (Number(v) / 1e6).toFixed(6);

const client = circle();
const wres = await client.listWallets({ blockchain: ARC.blockchain, pageSize: 50 });
const allWallets = wres.data?.wallets ?? [];
const known = new Set(
  [SHARED_SCA, DELEGATE, process.env.VANILLA_SELLER_ADDRESS].filter(Boolean).map((a) => a.toLowerCase())
);
const perUser = allWallets.filter((w) => !known.has(w.address.toLowerCase()));

console.log(`Scanning ${perUser.length} per-user SCAs for confirmed on-chain txs…\n`);

// ── 1. Find real, confirmed txs from per-user SCAs and decode who paid the gas. ──
// NOTE: listTransactions({walletIds:[id]}) does NOT filter reliably here — it threw and
// silently yielded nothing. We list the entity's txs and match on sourceAddress instead.
const perUserAddrs = new Set(perUser.map((w) => w.address.toLowerCase()));
const tres = await client.listTransactions({ blockchain: ARC.blockchain, pageSize: 30 });
const candidates = (tres.data?.transactions ?? []).filter(
  (t) =>
    t.state === "COMPLETE" &&
    t.txHash &&
    t.transactionType === "OUTBOUND" &&
    perUserAddrs.has(String(t.sourceAddress).toLowerCase())
);

const findings = [];
const seenTx = new Set();
for (const t of candidates) {
  if (findings.length >= 5) break;
  if (seenTx.has(t.txHash)) continue;
  seenTx.add(t.txHash);
  let receipt;
  try {
    receipt = await pc.getTransactionReceipt({ hash: t.txHash });
  } catch {
    continue;
  }
  const events = parseEventLogs({ abi: ENTRYPOINT_ABI, logs: receipt.logs, eventName: "UserOperationEvent" });
  // A bundle can carry several userOps — keep only the one this SCA sent.
  const mine = events.filter((e) => e.args.sender.toLowerCase() === String(t.sourceAddress).toLowerCase());
  for (const e of mine) {
    findings.push({
      wallet: t.sourceAddress,
      txHash: t.txHash,
      operation: t.abiFunctionSignature || t.transactionType,
      paymaster: e.args.paymaster,
      sponsored: e.args.paymaster !== ZERO,
      actualGasCost: e.args.actualGasCost,
      success: e.args.success,
    });
  }
}

if (!findings.length) {
  console.log("No decodable userOps found from per-user SCAs. Falling back to the shared SCA.\n");
}

console.log("── WHO PAID THE GAS (decoded from EntryPoint UserOperationEvent) ──\n");
for (const f of findings) {
  console.log(`  SCA        : ${f.wallet}`);
  console.log(`  tx         : ${f.txHash}`);
  console.log(`  call       : ${f.operation}`);
  console.log(`  paymaster  : ${f.paymaster}`);
  console.log(`  gas cost   : ${fmt6(f.actualGasCost)} (native, as reported by EntryPoint)`);
  console.log(`  ⇒ ${f.sponsored ? "SPONSORED — a paymaster paid." : "NOT SPONSORED — the SCA paid its own gas."}`);
  console.log("");
}

// ── 2. The addDelegate call SPECIFICALLY, quoted from an EMPTY per-user SCA. ──
// estimateContractExecutionFee is a READ (a quote). It does not sign or submit.
const empty = perUser.find(async () => true) && perUser[0];
let emptyCandidate = null;
for (const w of perUser) {
  const bal = await pc.readContract({ address: CONTRACTS.USDC, abi: erc20Abi, functionName: "balanceOf", args: [w.address] });
  if (bal === 0n) { emptyCandidate = w; break; }
}

console.log("── addDelegate(USDC, delegate) — read-only fee quote from an EMPTY SCA ──\n");
if (!emptyCandidate) {
  console.log("  No zero-balance per-user SCA available to quote against.");
} else {
  console.log(`  wallet (USDC balance 0): ${emptyCandidate.address}`);
  try {
    const est = await client.estimateContractExecutionFee({
      walletId: emptyCandidate.id,
      contractAddress: GATEWAY.WALLET,
      abiFunctionSignature: "addDelegate(address,address)",
      abiParameters: [CONTRACTS.USDC, DELEGATE],
    });
    console.log("  quote:", JSON.stringify(est.data, null, 2));
  } catch (e) {
    console.log("  estimate ERROR:", e?.response?.data ? JSON.stringify(e.response.data) : e.message);
    console.log("  (an 'insufficient funds' style error here would itself be the answer)");
  }
}

console.log("\n── VERDICT ──");
const sponsored = findings.filter((f) => f.sponsored);
if (findings.length === 0) {
  console.log("  Inconclusive — no per-user userOps decoded.");
} else if (sponsored.length === findings.length) {
  console.log(`  ALL ${findings.length} per-user userOps were paymaster-sponsored.`);
  console.log("  ⇒ addDelegate from an EMPTY SCA is SPONSORED. No chicken-and-egg.");
} else if (sponsored.length === 0) {
  console.log(`  NONE of ${findings.length} per-user userOps had a paymaster — each SCA paid its own gas.`);
  console.log("  ⇒ an EMPTY SCA cannot addDelegate. Must fund FIRST, then delegate.");
} else {
  console.log(`  MIXED: ${sponsored.length}/${findings.length} sponsored. Sponsorship is policy-scoped —`);
  console.log("  do NOT assume it covers the GatewayWallet contract. Treat as NOT sponsored.");
}
