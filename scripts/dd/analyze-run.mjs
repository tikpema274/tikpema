// analyze-run.mjs — the thin runner that wires dd/'s transport into shared/onchain-analyze.
//
// This is the ONLY place the two sides meet. The analyzer core is transport-agnostic; this file
// supplies scripts/dd/client.mjs (raw fetch, pinned block, reproducible curl, `.transient` tagging)
// and prints. Nothing here is imported by the analyzer.
//
// Usage:
//   node scripts/dd/analyze-run.mjs 0x240Eb85458CD41361bd8C3773253a1D78054f747
//   node scripts/dd/analyze-run.mjs --all            # the built-in Arc corpus
//   node scripts/dd/analyze-run.mjs --full 0x…       # full JSON instead of the digest view

import { chainClient } from "./client.mjs";
import { analyze } from "../../shared/onchain-analyze/index.mjs";

const CHAIN = "arc-testnet";

/** One-argument entry point, for humans and for the verify harness. */
export const analyzeOnArc = (address, { block } = {}) =>
  analyze(address, { client: chainClient(CHAIN, { block }) });

// Real Arc testnet addresses, each chosen to exercise a different shape branch.
const CORPUS = [
  { label: "XyloVault (the allowlisted vault _vault.mjs inspects)", address: "0x240Eb85458CD41361bd8C3773253a1D78054f747" },
  { label: "TikpemaSwap (own deployment, arc-contracts)", address: "0xd2f2f17dffda19bcbb79dee0d289a608407e31bd" },
  { label: "Arc native USDC (precompile-style address)", address: "0x3600000000000000000000000000000000000000" },
  { label: "EURC on Arc", address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" },
  { label: "Counter (own deployment, trivial contract)", address: "0x5adf071f9a87363a88c70eadd4f38c287623b529" },
  { label: "an address with nothing deployed at it", address: "0x000000000000000000000000000000000000dEaD" },
];

function digest(r, label) {
  const L = [];
  L.push(`\n${"═".repeat(92)}`);
  L.push(`${label ?? r.subject.address}`);
  L.push(`${r.subject.address}  ·  chain ${r.subject.chainId} (${r.subject.chainName})  ·  block ${r.subject.blockNumber}`);
  L.push("─".repeat(92));
  L.push(`shape      : ${r.shape.class}${r.shape.variant ? `  (variant: ${r.shape.variant})` : ""}`);
  if (r.shape.scannedAddress && r.shape.scannedAddress !== r.subject.address)
    L.push(`             ⚠️ powers scanned in ${r.shape.scannedAddress}, NOT the subject address`);
  if (r.shape.evidence?.variantBasis) L.push(`             basis: ${r.shape.evidence.variantBasis}`);
  if (r.shape.evidence?.note) L.push(`             note: ${r.shape.evidence.note}`);
  if (r.shape.evidence?.residual) L.push(`             ⚠️ residual: ${r.shape.evidence.residual}`);
  if (r.shape.evidence?.anomaly) L.push(`             ⚠️ anomaly: ${r.shape.evidence.anomaly}`);
  if (r.shape.evidence?.shapesNotTestedFor) L.push(`             shapes NOT tested for: ${r.shape.evidence.shapesNotTestedFor.join("; ")}`);
  L.push(`owner      : ${r.owner?.address ?? "—"}  [${r.owner?.kind ?? "—"}]`);

  if (r.refusal) {
    L.push(`\n🛑 REFUSAL (a valid report, not an error)`);
    L.push(`   reason : ${r.refusal.reason}`);
    L.push(`   detail : ${r.refusal.detail}`);
    if (r.refusal.problems) for (const p of r.refusal.problems) L.push(`   • ${p}`);
  }

  L.push(`\npowers (inventory — severity is SCOPE, not a rank; nothing here sums):`);
  if (r.powers.length === 0) L.push(`   (none scanned — see coverage below)`);
  for (const p of r.powers) {
    const mark = p.present ? "●" : "○";
    L.push(`   ${mark} ${p.power.padEnd(18)} ${p.present ? "PRESENT" : "absent "}  scope=${p.severity}`);
    if (p.present) for (const m of p.matched) L.push(`       ↳ ${m.signature}  ${m.selector}`);
  }

  L.push(`\ncoverage: ${r.coverage.summary}`);
  L.push(`   checked    (${r.coverage.totals.checked}): ${r.coverage.checked.map((c) => c.id).join(", ") || "—"}`);
  L.push(`   NOT checked (${r.coverage.totals.notChecked}):`);
  for (const n of r.coverage.notChecked) L.push(`       ✗ ${n.id}  [${n.reason}]  ${n.why ?? n.detail ?? ""}`);
  L.push(`\nreads: ${r.reads.length} RPC calls (each reproducible; reads[i].reproduce is a curl)`);
  return L.join("\n");
}

// ⚠️ CLI only when invoked directly. verify-analyze.mjs imports `analyzeOnArc` from here, and an
// unguarded top-level CLI would run (and process.exit) on import.
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const full = argv.includes("--full");
  const targets = argv.includes("--all")
    ? CORPUS
    : argv.filter((a) => a.startsWith("0x")).map((a) => ({ label: null, address: a }));

  if (targets.length === 0) {
    console.log("usage: node scripts/dd/analyze-run.mjs [--all] [--full] 0x…");
    process.exit(1);
  }

  for (const t of targets) {
    try {
      const r = await analyzeOnArc(t.address);
      console.log(full ? JSON.stringify(r, null, 2) : digest(r, t.label));
    } catch (e) {
      console.log(`\n${t.address}: THREW (programmer error, not a chain finding): ${e.message}`);
    }
  }
}
