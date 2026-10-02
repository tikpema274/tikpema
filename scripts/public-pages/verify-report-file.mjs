#!/usr/bin/env node
// verify-report-file.mjs — the stranger's command: verify a downloaded signed report, end to end.
//
//   node scripts/public-pages/verify-report-file.mjs report.json [--rpc https://rpc.testnet.arc.io]
//
// It recomputes the canon/1 digest FROM THE FILE'S BYTES (docs/dd-attestation-canon1.md), asks the ERC-8004
// registry who owns the report's agent, and asks that account (ERC-1271) whether it signed the digest. The
// RPC is yours to choose: nothing here talks to a Tikpema server.
//
// Exit codes: 0 valid · 1 not valid · 2 could not tell (an RPC did not answer; NOT a statement either way).

import { readFileSync } from "node:fs";
import { verifyAttestation } from "../../shared/onchain-analyze/attest.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--rpc");
const rpc = args.includes("--rpc") ? args[args.indexOf("--rpc") + 1] : "https://rpc.testnet.arc.io";
if (!file) {
  console.error("usage: node scripts/public-pages/verify-report-file.mjs report.json [--rpc <Arc testnet RPC>]");
  process.exit(2);
}

const report = JSON.parse(readFileSync(file, "utf8"));
const client = {
  async call({ method, params }) {
    const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
    return j.result;
  },
};

const v = await verifyAttestation(report, { client });
console.log(`report     ${report?.subject?.address} on chain ${report?.subject?.chainId}, block ${report?.subject?.blockNumber}`);
console.log(`digest     ${v.digest ?? "(not computed)"}`);
console.log(`signer     agent ${v.agentId} via ${v.ownerOnChain ?? "(not read)"}`);
console.log(`verdict    ${v.valid === true ? "VALID" : v.valid === false ? "NOT VALID" : "COULD NOT TELL"} (${v.reason})${v.detail ? ` — ${v.detail}` : ""}`);
console.log(`bound to   block ${v.boundTo.blockNumber}${v.hashBound ? ` hash ${v.boundTo.blockHash}` : " (number only, not the block hash)"}`);
process.exit(v.valid === true ? 0 : v.valid === false ? 1 : 2);
