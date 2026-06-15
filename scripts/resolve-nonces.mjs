#!/usr/bin/env node
// Resolve stuck userOp hashes -> their full 2D nonces, so they can be flushed
// (replaced at the EXACT same nonce) from the UI via flushNonce(fullNonce).
//
// Usage:
//   node scripts/resolve-nonces.mjs <hash1> <hash2> ...
//
// Reads VITE_CLIENT_URL / VITE_CLIENT_KEY from .env. Queries the Arc Testnet
// bundler's eth_getUserOperationByHash. For each op prints:
//   key       = nonce >> 64        (the 192-bit nonce key; random timestamp = pre-fix orphan)
//   seq       = nonce & 0xFFFF...   (low 64 bits)
//   fullNonce = the value to paste into the UI's flush box
//   fee       = the orphan's maxPriority/maxFee (your replacement must beat these by >10%)

import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const CLIENT_URL = env.VITE_CLIENT_URL;
const CLIENT_KEY = env.VITE_CLIENT_KEY;
const BUNDLER = `${CLIENT_URL}/arcTestnet`;

const hashes = process.argv.slice(2);
if (!hashes.length) {
  console.error("Pass the stuck userOp hashes as arguments.");
  process.exit(1);
}

async function getUserOp(hash) {
  const res = await fetch(BUNDLER, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CLIENT_KEY}`,
      "X-AppInfo": "platform=web;version=1.0.13;uri=localhost",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getUserOperationByHash",
      params: [hash],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  if (json.error) throw new Error(`${json.error.code}: ${json.error.message}`);
  return json.result;
}

const MASK64 = (1n << 64n) - 1n;
const big = (h) => (h == null ? null : BigInt(h));

console.log(`Bundler ${BUNDLER}\n`);

for (const hash of hashes) {
  try {
    const op = await getUserOp(hash);
    if (!op) {
      console.log(`${hash}\n  -> null (not found / already dropped from mempool)\n`);
      continue;
    }
    const uo = op.userOperation ?? op;
    const nonce = big(uo.nonce);
    const key = nonce >> 64n;
    const seq = nonce & MASK64;
    console.log(hash);
    console.log(`  sender    ${uo.sender}`);
    console.log(`  fullNonce ${nonce}      <- paste this into the UI flush box`);
    console.log(`  key       ${key}  (0x${key.toString(16)})`);
    console.log(`  seq       ${seq}`);
    console.log(`  maxPrio   ${big(uo.maxPriorityFeePerGas)}`);
    console.log(`  maxFee    ${big(uo.maxFeePerGas)}`);
    console.log(`  mined?    ${op.transactionHash ? op.transactionHash : "no (still pending)"}`);
    console.log("");
  } catch (e) {
    console.log(`${hash}\n  -> error: ${e.message}\n`);
  }
}
