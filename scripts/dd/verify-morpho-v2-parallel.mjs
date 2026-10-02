// verify-morpho-v2-parallel.mjs — the V2 guard's reads run in PARALLEL (≤ 8 in flight), and that changes NOTHING a
// reader can see: the signed body is byte-identical run to run, and a rate-limited read is UNREADABLE, never a value.
//
//   npm run test:morphov2parallel        (offline: mock chains with random latency and injected 429s)
//
// ⭐ WHY (T, 2026-10-02): analyze() on a V2 vault took 6.6–10.4 s (71 SERIAL quorum reads per endpoint) against the
// mandate's 10 s freshness ceiling. Parallel reads fix the latency at two costs T accepted with conditions:
//   1. completion order varies run to run → coverage entries and readIds must be recorded in a FIXED order, so the
//      signed body (attest.mjs canonicalize: everything but `reads` and `attestation`) is byte-identical;
//   2. bursts invite rate limits (429) → a rate-limited read must stay UNREADABLE: never a value, never 0.

import { analyze } from "../../shared/onchain-analyze/index.mjs";
import { quorumClient } from "../../shared/onchain-analyze/quorum.mjs";
import { canonicalize } from "../../shared/onchain-analyze/attest.mjs";
import { makeCoverage } from "../../shared/onchain-analyze/coverage.mjs";
import { VAULT, world, exitWorld, client, UNIT, PROBE, X, d, S4 } from "./_morpho-v2-world.mjs";

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 70 - t.length))}`);

const H = world({ overrides: exitWorld({ idle: 100n, sims: { 100: "ok", [String(100n + UNIT)]: "revert" } }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The fixture client with RANDOM per-call latency and an in-flight counter. */
function jittery(handlers, stats) {
  const base = client(handlers);
  return { ...base, async call(q) {
    stats.inFlight++; stats.max = Math.max(stats.max, stats.inFlight); stats.calls++;
    try { await sleep(Math.floor(Math.random() * 12)); return await base.call(q); } finally { stats.inFlight--; }
  } };
}

section("0 — the recorder offers an ordered parallel batch");
{
  const cov = makeCoverage();
  ok("coverage.runChecks exists", typeof cov.runChecks === "function");
  if (typeof cov.runChecks === "function") {
    let live = 0, peak = 0;
    const tasks = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, meta: { kind: "test" }, fn: async () => { live++; peak = Math.max(peak, live); await sleep(20 - i); live--; return i; } }));
    const out = await cov.runChecks(tasks, { concurrency: 8 });
    const m = cov.manifest();
    ok("⭐ recorded in LIST order, not completion order (the later tasks finished first)", m.checked.map((c) => c.id).join(",") === tasks.map((t) => t.id).join(","), m.checked.map((c) => c.id).slice(0, 6).join(","));
    ok("⭐ at most 8 in flight, and more than 1 (it IS parallel)", peak <= 8 && peak > 1, String(peak));
    ok("values come back in list order", out.map((o) => o.value).join(",") === tasks.map((_, i) => i).join(","));
  }
}

section("1 — ⭐⭐ the signed body is BYTE-IDENTICAL across runs at the same block, whatever the completion order");
{
  const bodies = [], stats = { inFlight: 0, max: 0, calls: 0 };
  for (let i = 0; i < 6; i++) bodies.push(canonicalize(await analyze(VAULT, { client: jittery(H, stats) })));
  ok("6 runs under random per-call latency → ONE canonical body", new Set(bodies).size === 1, `${new Set(bodies).size} distinct`);
  ok("…and that body carries the confirmed exit fact (a real report, not an empty one)", /"status":"confirmed"/.test(bodies[0]));
  ok("⭐ the reads ran in parallel (peak in flight > 1) and never above 8", stats.max > 1 && stats.max <= 8, String(stats.max));
}

section("2 — ⭐⭐ a RATE-LIMITED read is UNREADABLE: never a value, never 0 (through the REAL quorum client)");
{
  const T429 = () => { throw Object.assign(new Error("429 Too Many Requests"), { transient: true, query: { endpoint: "mock://b", method: "eth_call", params: [], reproduce: "# 429" } }); };
  const tlKey = `call@${VAULT.toLowerCase()}@${d("timelock", [S4("setIsAllocator(address,bool)")])}`;
  const simKey = `call@${PROBE.toLowerCase()}@${X("probe", [VAULT, 100n])}`;
  const mk = (url, overrides) => ({ ...client({ ...H, ...overrides }), chain: { ...client(H).chain, rpc: url } });
  // Endpoint B is rate-limited on two reads; endpoint A answers everything.
  const q = quorumClient([mk("mock://a", {}), mk("mock://b", { [tlKey]: T429, [simKey]: T429 })]);
  const r = await analyze(VAULT, { client: q });
  const p = r.powersV2?.powers?.find((x) => x.power === "setIsAllocator");
  ok("⭐ the rate-limited timelock → notChecked (quorum unmet), NOT a value", r.coverage.notChecked.some((n) => n.id === "v2:timelock:setIsAllocator" && /quorum|unreadable/.test(n.reason)), JSON.stringify(r.coverage.notChecked.find((n) => n.id === "v2:timelock:setIsAllocator")));
  ok("⭐ …so setIsAllocator's delay is null and it sits in the UNREADABLE group, never immediate (0)", p?.delay?.seconds === null && r.powersV2.groups.unreadable.includes("setIsAllocator") && !r.powersV2.groups.immediate.includes("setIsAllocator"), JSON.stringify(p?.delay));
  ok("⭐ the rate-limited simulation → redeemable-now NO VALUE, never 0", r.exitPath?.redeemableNow?.status === "no-value" && r.exitPath.redeemableNow.value === null, JSON.stringify(r.exitPath?.redeemableNow));
  ok("…and the report is a no-verdict (exit-fact-no-value)", r.refusal?.reason === "exit-fact-no-value", r.refusal?.reason);
  const both = quorumClient([mk("mock://a", { [simKey]: T429 }), mk("mock://b", { [simKey]: T429 })]);
  const rb = await analyze(VAULT, { client: both });
  ok("BOTH endpoints rate-limited on the simulation → no value too", rb.exitPath?.redeemableNow?.status === "no-value" && rb.exitPath.redeemableNow.value === null);
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0\n`);
