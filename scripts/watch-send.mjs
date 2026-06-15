#!/usr/bin/env node
// Watch a smart account on Arc Testnet confirm a userOp in real time.
//
// Usage:
//   node scripts/watch-send.mjs [scaAddress]
//
// Defaults to the passkey SCA. Polls the EntryPoint nonce + USDC balances and
// prints a line whenever they change. After you send a transfer from the UI you
// should see the nonce tick (0 -> 1 ...) and the USDC balance drop — that's the
// op going SENT -> CONFIRMED -> COMPLETE on-chain.

const RPC = process.env.ARC_RPC || "https://rpc.testnet.arc.network";
const SCA = (process.argv[2] || "0x21f997e71b2fac2ea7c43a9ef2f7df0cb71bc8b3").toLowerCase();
const USDC = "0x3600000000000000000000000000000000000000";
const EP07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const INTERVAL_MS = 3000;

const pad = SCA.replace(/^0x/, "").padStart(64, "0");

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const { result, error } = await res.json();
  if (error) throw new Error(`${method}: ${error.message}`);
  return result;
}

const hexToBig = (h) => BigInt(h ?? "0x0");

async function snapshot() {
  const [nonceRaw, usdcRaw, gasRaw, codeRaw] = await Promise.all([
    rpc("eth_call", [{ to: EP07, data: `0x35567e1a${pad}${"0".repeat(64)}` }, "latest"]),
    rpc("eth_call", [{ to: USDC, data: `0x70a08231${pad}` }, "latest"]),
    rpc("eth_getBalance", [SCA, "latest"]),
    rpc("eth_getCode", [SCA, "latest"]),
  ]);
  return {
    nonce: hexToBig(nonceRaw),
    usdc: Number(hexToBig(usdcRaw)) / 1e6,
    gas: Number(hexToBig(gasRaw)) / 1e18,
    deployed: (codeRaw ?? "0x").length > 2,
  };
}

const ts = () => new Date().toISOString().slice(11, 19);
const fmt = (s) =>
  `nonce=${s.nonce} usdc=${s.usdc.toFixed(2)} gas=${s.gas.toFixed(2)} deployed=${s.deployed}`;

console.log(`Watching ${SCA}`);
console.log(`RPC ${RPC}  (poll every ${INTERVAL_MS / 1000}s, Ctrl-C to stop)\n`);

let prev = null;
async function tick() {
  try {
    const cur = await snapshot();
    const line = fmt(cur);
    if (!prev) {
      console.log(`${ts()}  baseline  ${line}`);
    } else if (line !== fmt(prev)) {
      const nonceUp = cur.nonce > prev.nonce;
      console.log(`${ts()}  CHANGE   ${line}${nonceUp ? "   <- userOp confirmed ✅" : ""}`);
    }
    prev = cur;
  } catch (e) {
    console.error(`${ts()}  error: ${e.message}`);
  }
}

await tick();
setInterval(tick, INTERVAL_MS);
