// spike-find-swap-spender.mjs — READ-ONLY. Derives the swap approve-target from a REAL on-chain swap.
//
// Ground truth, not inference: given one real kit.swap() tx hash, it reads the tx + receipt from Arc,
// finds the wallet's USDC out-leg, then scans USDC Approval(owner=wallet) events in a bounded window
// around that block to recover the SPENDER the real swap actually approved. That spender — a real
// contract that is NOT the Gateway proxy trap and NOT the BridgingKit — is the only trustworthy
// approve target. Cross-checks code size and explicitly rules out the known-bad addresses.
//
// All reads via the independent dd/rpc stack (raw fetch, chain-id asserted, throttle-backoff). NO writes.
//
// RUN:
//   node scripts/spikes/spike-find-swap-spender.mjs --tx 0x<realSwapTxHash>
//   # optional: --wallet 0x<agentSCA> if the out-leg from-address isn't auto-detected
//   # optional: --window 8000  (blocks to scan back for the Approval; default 8000, ≤ Arc's 10k cap)

import { rpcCall, assertChain } from "../../shared/dd/rpc.mjs";
import { getChain } from "../../shared/dd/chains.mjs";
import { CONTRACTS } from "../../netlify/functions/_arc.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const TX = arg("--tx");
let WALLET = (arg("--wallet") || "").toLowerCase();
const WINDOW = Number(arg("--window", "8000"));
const USDC = CONTRACTS.USDC.toLowerCase();
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925"; // Approval(address,address,uint256)
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"; // Transfer(address,address,uint256)
const topicAddr = (t) => "0x" + String(t).slice(26).toLowerCase();
const pad = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const hx = (n) => "0x" + n.toString(16);

// Known-BAD spenders (must never be an approve target). Full addresses where known.
const RULED_OUT = {
  "0x0077777d7eba4688bdef3e311b846f25870a19b9": "Gateway proxy TRAP (163-byte stub; EOA owner can pause/denylist/upgrade — DD-confirmed)",
  "0xc5567a5e3370d4dbfb0540025078e283e36a363d": "BridgingKit contract (the BRIDGE adapter — wrong operation for a swap)",
};

const log = (s = "") => console.log(s);
if (!TX || !/^0x[0-9a-fA-F]{64}$/.test(TX)) {
  console.error("Need --tx 0x<64-hex real swap tx hash>. Get one from arcscan history of your agent wallet,\nor a DCA mandate fill record / a swap job receipt. This is the ground truth we won't infer around.");
  process.exit(2);
}

log(`\n════ FIND SWAP SPENDER from real tx ${TX.slice(0, 12)}… · READ-ONLY ════\n`);
const chain = getChain("arc-testnet");
await assertChain(chain);
const rpc = (method, params) => rpcCall({ endpoint: chain.rpc, method, params }).then((r) => r.result);

// 1) the swap tx + receipt
const tx = await rpc("eth_getTransactionByHash", [TX]);
const rcpt = await rpc("eth_getTransactionReceipt", [TX]);
if (!tx || !rcpt) { console.error("tx/receipt not found on Arc — wrong hash or chain?"); process.exit(1); }
const block = parseInt(rcpt.blockNumber, 16);
log(`tx.to (contract the swap was sent to): ${tx.to}`);
log(`block: ${block}  ·  status: ${rcpt.status}  ·  logs: ${rcpt.logs.length}`);

// 2) the USDC out-leg → the wallet that spent USDC (from-address of the USDC Transfer out)
const usdcTransfers = rcpt.logs.filter((l) => l.address.toLowerCase() === USDC && l.topics[0] === TRANSFER);
for (const t of usdcTransfers) {
  const from = topicAddr(t.topics[1]), to = topicAddr(t.topics[2]);
  log(`  USDC Transfer: ${from} → ${to}  (value ${BigInt(t.data).toString()})`);
  if (!WALLET) WALLET = from; // first out-leg = the swapping wallet (best-effort; override with --wallet)
}
if (!WALLET) { console.error("Could not detect the swapping wallet from USDC transfers — pass --wallet 0x…"); process.exit(1); }
log(`\nswapping wallet: ${WALLET}`);

// 3) bounded Approval scan: what spender did THIS wallet approve on USDC, around this swap?
const from = hx(Math.max(0, block - WINDOW));
log(`\nScanning USDC Approval(owner=${WALLET.slice(0, 10)}…) over blocks ${parseInt(from, 16)}..${block} …`);
let logs = [];
try {
  logs = await rpc("eth_getLogs", [{ address: CONTRACTS.USDC, topics: [APPROVAL, pad(WALLET)], fromBlock: from, toBlock: hx(block) }]);
} catch (e) { console.error(`getLogs failed (Arc throttle/range?): ${e.message}\nTry a smaller --window, or pass the approve tx directly as --tx.`); process.exit(1); }

const spenders = new Map(); // spender -> latest value
for (const l of logs) spenders.set(topicAddr(l.topics[2]), BigInt(l.data));
if (!spenders.size) {
  log("  (no Approval by this wallet in the window — widen --window, or the approve is older/newer than the swap)");
}

// 4) classify each spender: ruled-out? real contract? → the ground-truth swap target
log(`\nSpenders this wallet approved (ground truth), classified:`);
let target = null;
for (const [addr, val] of spenders) {
  const bad = RULED_OUT[addr];
  let bytes = "?";
  try { const code = await rpc("eth_getCode", [addr, "latest"]); bytes = (code.length - 2) / 2; } catch {}
  const tag = bad ? `❌ RULED OUT — ${bad}` : (bytes > 100 ? "✅ candidate swap spender (real contract)" : "⚠️ small/EOA — unlikely the adapter");
  log(`  ${addr}  [${bytes} bytes, approved ${val}]  ${tag}${addr === tx.to?.toLowerCase() ? "  ← matches tx.to" : ""}`);
  if (!bad && bytes > 100) target = target || addr;
}

log(`\n════════════════════════════ RESULT ════════════════════════════`);
if (target) {
  log(`Ground-truth swap approve-target = ${target}`);
  log(`  • derived from a REAL swap's on-chain USDC Approval by the swapping wallet`);
  log(`  • NOT the Gateway proxy trap, NOT the BridgingKit`);
  log(`  • ${target === tx.to?.toLowerCase() ? "matches the contract the swap tx was sent to (tx.to) — strong corroboration" : "differs from tx.to — inspect (tx.to may be an EntryPoint/router; the Approval spender is the pull contract)"}`);
  log(`\nPaste this + your 0d candidate list; I'll confirm the mapping and ONLY THEN write the approve step against this exact address.`);
} else {
  log(`No clean ground-truth target found in the window. Options: widen --window, pass the APPROVE tx`);
  log(`hash directly as --tx, or give me the agent wallet + an approximate block and I'll walk the`);
  log(`window back. We do NOT proceed to an approve until this returns one real contract address.`);
}
log(`\nNo writes. eth_getTransactionByHash/getReceipt/getLogs/getCode only.\n`);
