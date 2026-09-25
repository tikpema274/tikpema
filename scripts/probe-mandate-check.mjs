#!/usr/bin/env node
// probe-mandate-check.mjs — READ-ONLY live run of one vault-mandate check against xylo-usdc on both
// configured Arc testnet endpoints: anchor (number + hash agreed), the DD report AT the anchor, and our
// own reads (fees, position, payability) at the anchor hash.
//
//   node scripts/probe-mandate-check.mjs [holderAddress]
//
// ⚠️ WHAT THIS DOES NOT DO, and says so in its output:
//   · SIGN. Signing uses the production DD identity through Circle; that run belongs to the deployed
//     function (the check needs the deployed build's health record anyway). Here the signer throws, so
//     the power and owner rules come back OUTAGE "signing disabled" — the expected result of this probe.
//   · CONSULT HEALTH. healthDisclosure compares the DEPLOYED build's code identity; a local run cannot
//     pass it honestly, so the probe bypasses it and labels the bypass. Never do this outside a probe.
// Moves no money, writes nothing, signs nothing.

import { resolveVault } from "../netlify/functions/_vault.mjs";
import { runMandateCheck, productionDeps } from "../netlify/functions/_vault-mandate-check.mjs";
import { decideMandateAction } from "../shared/vault-mandate/decide.mjs";

const holder = process.argv[2] ?? "0x3d7d4c52305ed0c394e01c7184701a522116097d"; // one of our agent SCAs, holds xyUSDC
const vault = resolveVault("xylo-usdc");
const record = {
  vault: { key: vault.key, address: vault.address, chainId: vault.chainId, label: vault.label },
  walletAddress: holder,
  rules: [
    { id: "r1", kind: "power", subject: "upgradeable", onFinding: "exit" },
    { id: "r2", kind: "state", subject: "exit-fee-above", limitBps: 50, onFinding: "exit" },
    { id: "r3", kind: "state", subject: "deposit-fee-above", limitBps: 0, onFinding: "pause" },
    { id: "r4", kind: "state", subject: "vault-cannot-pay", onFinding: "pause" },
  ],
};
const deps = productionDeps({
  health: async () => ({ serving: true, reason: "PROBE BYPASS — health not consulted (local run)" }),
  resolveVault, sign: false,
});

const t0 = Date.now();
const r = await runMandateCheck({ record, deps });
const ms = Date.now() - t0;
const d = decideMandateAction({ rules: record.rules, check: r.check });
const big = (k, v) => (typeof v === "bigint" ? v.toString() : v);

console.log(`⚠️ PROBE: health BYPASSED, signing DISABLED. Read-only. ${ms} ms.`);
console.log(`anchor: ${JSON.stringify(r.anchor)}`);
console.log(`report: ${r.report ? "signed" : "none"} — ${r.reportFailure ?? ""}`);
for (const x of r.readings) console.log(`reading ${x.endpoint}: ${JSON.stringify(x, big)}`);
for (const [id, o] of Object.entries(r.check.observations ?? {})) console.log(`  ${id}: ${o.status}${o.cause ? `/${o.cause}` : ""} ${o.why ?? o.evidence?.reading ?? o.evidence?.note ?? ""}`);
console.log(`whole-check outage: ${JSON.stringify(r.check.outage)}`);
console.log(`decision: ${d.action} flags=${JSON.stringify(d.flags)}  signCalls=${r.cost.signCalls}`);
