// verify-health-read-consistency.mjs — a cached PASS must never mask a written FAIL.
//
// ═══ ⭐⭐ THE FAIL-OPEN THIS EXISTS FOR ═══════════════════════════════════════════════════════
// Netlify Blobs reads default to `consistency: "eventual"` — a CDN-cached edge read. The symptom
// that exposed it was the SAFE direction (a fresh PASS was invisible, so the service refused), but
// the same defect runs the other way and that direction is the dangerous one:
//
//     canary detects a regression → writes verdict:"fail"
//     dd-analyze reads a CACHED PASSING artifact → KEEPS SERVING
//
// The dead-man's switch assumes the endpoint reads the LATEST artifact. An eventually consistent
// read voids that assumption silently, and a detector that fails its own fixtures goes on answering
// questions about other people's contracts.
//
// ═══ WHY THIS SUITE MOCKS @netlify/blobs AND NOT _dd-health.mjs ══════════════════════════════
// `_dd-health.mjs` IS THE CODE UNDER TEST — it is the thing that must pass `consistency:"strong"`.
// Every other suite mocks that module wholesale, which would delete the property being checked.
// Here the REAL readHealth/writeHealth run against a fake store that MODELS THE CACHE: it serves a
// stale snapshot for eventual reads and the live value for strong ones. Drop the option from
// readHealth and these tests go red.
//
//   node --experimental-test-module-mocks scripts/dd/verify-health-read-consistency.mjs
//
// Zero network, zero money.

import { mock } from "node:test";
// ⚠️ FIRST: pin the build stamp so this suite does NOT read the generated, uncommitted
// file on disk. Without it the suite passes or fails on local build residue — see
// scripts/dd/_test-stamp.mjs for the measurement (7 of 17 suites flipped).
import { mockBuildStamp } from "./_test-stamp.mjs";
mockBuildStamp();

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

// ── the fake store: an origin, plus a stale edge cache in front of it ─────────────────────────
const origin = new Map();   // what was actually written
const edge = new Map();     // what a cached (eventual) read would return
const reads = [];           // every (key, consistency) pair, so we can assert on the option itself

const fakeStore = {
  async get(key, opts = {}) {
    reads.push({ key, consistency: opts.consistency ?? "(default)" });
    // ⭐ THE MODEL: strong goes to origin, anything else (including the default) hits the cache.
    if (opts.consistency === "strong") return origin.get(key) ?? null;
    return edge.get(key) ?? null;
  },
  async setJSON(key, value) {
    origin.set(key, JSON.parse(JSON.stringify(value)));   // writes land at origin...
    // ...and the edge is NOT updated. That is the whole point: the cache goes stale on write.
  },
};
mock.module("@netlify/blobs", {
  namedExports: { getStore: () => fakeStore, connectLambda: () => {}, getDeployStore: () => fakeStore },
});

// REAL modules — this is what is under test.
const { readHealth, writeHealth, healthKey } = await import("../../netlify/functions/_dd-health.mjs");
const { codeIdentity, evaluateHealth, HEALTH_REASON } = await import("../../shared/dd-canary/health.mjs");
const { SCHEMA_VERSION } = await import("../../shared/onchain-analyze/schema.mjs");
const { POWER_SIGS } = await import("../../shared/onchain-facts/index.mjs");

const ID = codeIdentity({ schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS, env: { DD_BUILD_ID: "cafe1234" } });
const KEY = healthKey(ID);
const rec = (verdict, agoMs = 0) => ({
  verdict,
  producedAt: new Date(Date.now() - agoMs).toISOString(),
  identity: ID,
  fixtures: verdict === "fail" ? [{ id: "uups-empty-admin", ok: false, problems: ["misread empty admin slot"] }] : [{ id: "uups-empty-admin", ok: true }],
});
const gate = async () => {
  const { record, readable } = await readHealth(ID);
  return evaluateHealth({ record, readable, now: Date.now(), expect: ID });
};

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  HEALTH READ CONSISTENCY — a cached PASS must not mask a FAIL       ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═══════════ 1 — the fix itself: readHealth asks for STRONG ═══════════
section("1 — readHealth requests strong consistency");
{
  reads.length = 0;
  await readHealth(ID);
  check("exactly one read was issued", reads.length === 1, JSON.stringify(reads));
  check("⭐⭐ it asked for consistency:'strong', not the cached default",
    reads[0]?.consistency === "strong", reads[0]?.consistency);
  check("  …against the right key", reads[0]?.key === KEY, reads[0]?.key);
}

// ═══════════ 2 — ⭐ INSTRUMENT SELF-CHECK: the cache model actually diverges ═══════════
// Without this the whole suite could be vacuous — a cache that never goes stale proves nothing,
// exactly like a fault-injection test that injects no fault.
section("2 — the cache model genuinely diverges (else this suite proves nothing)");
{
  origin.clear(); edge.clear();
  const passing = rec("pass");
  await writeHealth(ID, passing);
  edge.set(KEY, JSON.parse(JSON.stringify(passing)));      // edge caught up
  await writeHealth(ID, rec("fail"));                       // origin moves on; edge does NOT

  const strong = await fakeStore.get(KEY, { consistency: "strong" });
  const cached = await fakeStore.get(KEY);
  check("⭐ origin says FAIL", strong.verdict === "fail", strong.verdict);
  check("⭐ the stale edge still says PASS", cached.verdict === "pass", cached.verdict);
  check("  …so the two genuinely disagree — the test has something to catch", strong.verdict !== cached.verdict);
}

// ═══════════ 3 — ⭐⭐⭐ THE FAIL-OPEN: a regression must not be masked ═══════════
section("3 — canary writes FAIL, edge still cached PASS → MUST REFUSE");
{
  // State from section 2: origin = fail (a real detector regression), edge = pass (stale).
  const g = await gate();
  check("⭐⭐⭐ the gate REFUSES — the cached pass did NOT mask the regression",
    g.serve === false, `serve=${g.serve}`);
  check("  …and it read the FAIL, not the cached pass", g.reason === HEALTH_REASON.NOT_PASSING, g.reason);
  check("  …naming the broken fixture", (g.evidence.failures ?? []).includes("uups-empty-admin"),
    String(g.evidence.failures));

  // The counterfactual, spelled out: this is what the OLD code would have done.
  const cached = await fakeStore.get(KEY);
  const wouldHaveServed = evaluateHealth({ record: cached, readable: true, now: Date.now(), expect: ID });
  check("⭐⭐ PROOF THE FIX IS LOAD-BEARING: the cached read WOULD have served",
    wouldHaveServed.serve === true, `cached verdict=${cached.verdict} → serve=${wouldHaveServed.serve}`);
  check("  …so removing consistency:'strong' reopens a live fail-open", wouldHaveServed.serve !== g.serve);
}

// ═══════════ 4 — the symptom that exposed it: a fresh PASS must be visible ═══════════
section("4 — canary writes PASS, edge cached something older → must SERVE");
{
  origin.clear(); edge.clear();
  edge.set(KEY, rec("pass", 60 * 60 * 1000));   // the stale hour-old artifact that caused the refusal
  await writeHealth(ID, rec("pass"));            // fresh run, origin only

  const g = await gate();
  check("⭐⭐ the FRESH pass is visible — no more phantom staleness", g.serve === true, `${g.reason}`);
  check("  …age is near zero, not ~1 hour", g.evidence.ageMs < 5000, `ageMs=${g.evidence.ageMs}`);

  const cachedGate = evaluateHealth({ record: edge.get(KEY), readable: true, now: Date.now(), expect: ID });
  check("⭐ the cached read would still have said STALE (the measured symptom)",
    cachedGate.serve === false && cachedGate.reason === HEALTH_REASON.STALE,
    `${cachedGate.reason} ageMs=${cachedGate.evidence.ageMs}`);
}

// ═══════════ 5 — a DELETED artifact must not be served from cache either ═══════════
section("5 — artifact deleted at origin, still cached → REFUSE");
{
  origin.clear(); edge.clear();
  edge.set(KEY, rec("pass"));    // cache holds a perfectly good pass
  // origin has nothing — e.g. the record was purged, or this is a build nobody vouched for
  const g = await gate();
  check("⭐⭐ absence at origin wins over a cached pass", g.serve === false, `serve=${g.serve}`);
  check("  …reported as no-record", g.reason === HEALTH_REASON.NO_RECORD, g.reason);
}

// ═══════════ 6 — every reachable verdict is decided from ORIGIN, never the edge ═══════════
section("6 — origin is authoritative for every outcome");
{
  for (const [label, originRec, expectServe, expectReason] of [
    ["pass", rec("pass"), true, HEALTH_REASON.OK],
    ["fail", rec("fail"), false, HEALTH_REASON.NOT_PASSING],
    ["stale", rec("pass", 60 * 60 * 1000), false, HEALTH_REASON.STALE],
    ["malformed", { nonsense: true }, false, HEALTH_REASON.MALFORMED],
  ]) {
    origin.clear(); edge.clear();
    edge.set(KEY, rec("pass"));            // ⭐ the edge ALWAYS holds a fresh pass — maximum pressure
    await writeHealth(ID, originRec);
    const g = await gate();
    check(`origin ${label} → serve=${expectServe} (${expectReason}) despite a cached PASS`,
      g.serve === expectServe && g.reason === expectReason, `${g.reason}`);
  }
  check("⭐ a fresh cached PASS never once overrode the origin", true);
}

console.log(`\n╔══════════════════════════════════════════════════════════════════════`);
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES PRESENT"}   pass ${pass} / fail ${fail}`);
console.log(`╚══════════════════════════════════════════════════════════════════════`);
process.exit(fail === 0 ? 0 : 1);
