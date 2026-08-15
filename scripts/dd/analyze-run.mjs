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
//   node scripts/dd/analyze-run.mjs --quorum 0x…     # read every slot from >=2 endpoints

import { chainClient } from "../../shared/dd/client.mjs";
import { analyze } from "../../shared/onchain-analyze/index.mjs";
import { quorumClient } from "../../shared/onchain-analyze/quorum.mjs";

const CHAIN = "arc-testnet";

// ── The quorum endpoint set, and what was actually VERIFIED about it ──────────────────────────
// ✅ VERIFIED DIFFERENT BACKENDS (2026-07-25) by node-local values that must differ between distinct
//    nodes even when chain state is identical:
//      net_peerCount            arc=0x4          drpc=0x2a
//      eth_gasPrice             arc=0x5d21dba00  drpc=0x5e1046c80
//      eth_maxPriorityFeePerGas arc=0x12a05f200  drpc=0x138eca480
//      debug_traceBlockByNumber arc=supported    drpc=-32602 (needs tracer)
//      txpool_status            arc=-32604       drpc=-32601 (different error vocabulary)
//
// ❌ REJECTED: https://arc-testnet.rpc.thirdweb.com — byte-identical gas heuristics to Arc public AND
//    the same NON-STANDARD -32604 code with the same message string. Two independent implementations
//    do not coincide on a non-standard error string; it is very likely a gateway in front of the same
//    reth deployment. Two URLs to one backend agree perfectly and are worth nothing.
//
// ⚠️ TWO LIMITS THAT REMAIN, and they are why every report declares independenceVerified:false —
//    1. dRPC is an AGGREGATOR ("multi-provider architecture"). Different backend is proven for the
//       probes above, NOT guaranteed per call; it could route to Arc public on any given request.
//    2. Every Arc provider syncs from the same PERMISSIONED validator set. Quorum covers PROVIDER
//       integrity (proxy bug, stale/pruned cache, hijacked endpoint, lying aggregator), never
//       consensus integrity. Re-verify out of band; do not let agreement imply independence.
// ⭐ RE-EXPORTED, NOT RE-LISTED. The endpoint set moved to shared/onchain-analyze/endpoints.mjs when
// the PAID path started reading through it: `shared/` is inside the build stamp's SURFACES and
// `scripts/` is not, so production config living here would ship with a byte-identical tree hash.
// A second literal list would be the duplicate-source-of-truth bug — the CLI and the sold service
// must not be able to disagree about who they trust.
export { ARC_QUORUM_ENDPOINTS as QUORUM_ENDPOINTS } from "../../shared/onchain-analyze/endpoints.mjs";

/** One-argument entry point, for humans and for the verify harness. Single RPC. */
export const analyzeOnArc = (address, { block } = {}) =>
  analyze(address, { client: chainClient(CHAIN, { block }) });

/** Same, with the quorum layer active across QUORUM_ENDPOINTS. */
export const analyzeOnArcQuorum = (address, { block, endpoints = QUORUM_ENDPOINTS } = {}) =>
  analyze(address, {
    client: quorumClient(endpoints.map((rpc) => chainClient(CHAIN, { block, rpc }))),
  });

// Real Arc testnet addresses, each chosen to exercise a different shape branch.
const CORPUS = [
  { label: "XyloVault (the allowlisted vault _vault.mjs inspects)", address: "0x240Eb85458CD41361bd8C3773253a1D78054f747" },
  { label: "TikpemaSwap (own deployment, arc-contracts)", address: "0xd2f2f17dffda19bcbb79dee0d289a608407e31bd" },
  { label: "Arc native USDC (precompile-style address)", address: "0x3600000000000000000000000000000000000000" },
  { label: "EURC on Arc", address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" },
  { label: "Counter (own deployment, trivial contract)", address: "0x5adf071f9a87363a88c70eadd4f38c287623b529" },
  { label: "an address with nothing deployed at it", address: "0x000000000000000000000000000000000000dEaD" },
];

export function digest(r, label) {
  const L = [];
  L.push(`\n${"═".repeat(92)}`);
  L.push(`${label ?? r.subject.address}`);
  L.push(`${r.subject.address}  ·  chain ${r.subject.chainId} (${r.subject.chainName})  ·  block ${r.subject.blockNumber}`);
  L.push(`sources    : ${r.sources.mode}${r.sources.mode === "quorum" ? `  ${r.sources.agreed ?? ""}${r.sources.required}-of-${r.sources.configured} required · independenceVerified=${r.sources.independenceVerified}` : ""}`);
  for (const e of r.sources.endpoints) L.push(`             • ${e}`);
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
  for (const n of r.coverage.notChecked) {
    L.push(`       ✗ ${n.id}  [${n.reason}]  ${n.why ?? n.detail ?? ""}`);
    if (n.responses) for (const rr of n.responses) L.push(`           ↳ ${rr.endpoint}  ${rr.value !== undefined ? "→ " + String(rr.value).slice(0, 70) : "THREW: " + String(rr.error).slice(0, 60)}`);
  }
  L.push(`\nreads: ${r.reads.length} RPC calls (each reproducible; reads[i].reproduce is a curl)`);
  return L.join("\n");
}

// ⚠️ CLI only when invoked directly. verify-analyze.mjs imports `analyzeOnArc` from here, and an
// unguarded top-level CLI would run (and process.exit) on import.
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const full = argv.includes("--full");
  const useQuorum = argv.includes("--quorum");
  const targets = argv.includes("--all")
    ? CORPUS
    : argv.filter((a) => a.startsWith("0x")).map((a) => ({ label: null, address: a }));

  if (targets.length === 0) {
    console.log("usage: node scripts/dd/analyze-run.mjs [--all] [--full] 0x…");
    process.exit(1);
  }

  for (const t of targets) {
    try {
      const r = useQuorum ? await analyzeOnArcQuorum(t.address) : await analyzeOnArc(t.address);
      console.log(full ? JSON.stringify(r, null, 2) : digest(r, t.label));
    } catch (e) {
      console.log(`\n${t.address}: THREW (programmer error, not a chain finding): ${e.message}`);
    }
  }
}
