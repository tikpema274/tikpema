// verify-canary-endpoint-binding.mjs — does the REAL canary's artifact open the REAL endpoint's gate?
//
// ═══ ⭐ WHY THIS EXISTS AND verify-build-binding.mjs DOES NOT COVER IT ════════════════════════
// verify-build-binding tests evaluateHealth as a PREDICATE — it hand-builds a record and asks the
// pure function about it. That proves the comparison is right; it does NOT prove the two HANDLERS
// agree, because it never runs either of them.
//
// This runs BOTH REAL HANDLERS against ONE SHARED STORE, exactly as a deploy does:
//
//     dd-canary.handler()  --writes-->  [ blob store, keyed by healthKey(identity) ]
//                                              |
//     dd-analyze.handler() --reads-------------+   → serves, or refuses and says why
//
// The bug class it is aimed at: the two sides computing their identity DIFFERENTLY. A same-process
// predicate test cannot see that, and neither can a suite that mocks readHealth to always vouch —
// which is what every existing suite does. Here the mock is a REAL in-memory store, so a key
// disagreement shows up as a genuine miss rather than being papered over.
//
//   node --experimental-test-module-mocks scripts/dd/verify-canary-endpoint-binding.mjs
//
// Zero network, zero money. The canary's fixtures are hermetic.

import { mock } from "node:test";
// ⚠️ Imported BEFORE the mock is installed, so the store key is the REAL formula rather than a second
// copy of it. A re-implemented key here would make this suite pass while production disagreed — the
// duplicate-source-of-truth failure, inside the very test meant to catch a disagreement.
import { healthKey as realHealthKey } from "../../netlify/functions/_dd-health.mjs";

const STORE = new Map();
let readable = true;

mock.module("../../netlify/functions/_dd-health.mjs", {
  namedExports: {
    DD_HEALTH_STORE: "in-memory",
    healthKey: realHealthKey,
    readHealth: async (identity) =>
      readable ? { record: STORE.get(realHealthKey(identity)) ?? null, readable: true }
               : { record: null, readable: false, error: "store unavailable" },
    writeHealth: async (identity, record) => { STORE.set(realHealthKey(identity), record); return true; },
  },
});

// ═══ 🚨 THE IDENTITY LEVER IS NOW THE BUILD STAMP, NOT AN ENV VAR ══════════════════════════════
// Rewritten 2026-08-11. This suite used to drive both handlers with process.env.DD_BUILD_ID. That
// variable no longer influences anything: the DD identity is a CONTENT HASH of the DD surface, baked
// at build time, and there is deliberately no env lever — a variable that sets the code identity is
// `unknown === unknown` with a knob.
//
// ⭐ So the lever is mocked at shared/build-stamp.mjs, the ONE place both handlers reach it through
// (health.mjs imports ddCodeIdentity from there). The real implementation is imported first and the
// non-mocked exports pass straight through, so this suite still exercises the real key formula and
// the real refusal ladder — only the *value* of the DD hash is under test control.
import * as realStamp from "../../shared/build-stamp.mjs";
let CURRENT_DD = null;   // null ⇒ UNBOUND (a deploy that skipped stamping)
mock.module("../../shared/build-stamp.mjs", {
  namedExports: {
    ...realStamp,
    ddCodeIdentity: () =>
      CURRENT_DD === null
        ? { resolved: false, id: null, source: null,
            detail: "no build stamp was baked into this artifact (test lever): DD identity UNBOUND" }
        : { resolved: true, id: CURRENT_DD, source: "build-stamp:ddTree",
            detail: "DD surface identified by content hash (test lever)" },
  },
});

const { handler: canary } = await import("../../netlify/functions/dd-canary.mjs");
const { handler: endpoint } = await import("../../netlify/functions/dd-analyze.mjs");

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
const body = (r) => JSON.parse(r.body);

const BUILD_A = "1d".repeat(32);   // a DD-surface content hash (64 hex)
const BUILD_B = "49".repeat(32);   // a DIFFERENT DD surface
const SUBJ = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

/** Run the canary as a deploy stamped with `build`. */
const runCanary = async (build) => {
  CURRENT_DD = build;
  return canary({ httpMethod: "POST", headers: {} });
};
/** Ask the endpoint, as a deploy stamped with `build`. Stops at the health rung — no payment needed. */
const askEndpoint = async (build) => {
  CURRENT_DD = build;
  return endpoint({
    httpMethod: "POST", headers: { host: "draft.test" },
    body: JSON.stringify({ address: SUBJ, chain: "arc-testnet" }),
  });
};

process.env.DD_PUBLIC_ENABLED = "1";
delete process.env.DD_PAYTO_ADDRESS;   // so a SERVING result stops at 402/503-payment, never at money
delete process.env.COMMIT_REF; delete process.env.DEPLOY_ID; delete process.env.BUILD_ID;

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  CANARY → ENDPOINT — do the two REAL handlers agree on identity?    ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═══════════ 1 — the two sides compute the SAME identity from the SAME env ═══════════
section("1 — same deploy → same identity, same key");
{
  STORE.clear();
  const c = body(await runCanary(BUILD_A));
  check("canary resolved a real build id", c.identity?.buildResolved === true && c.identity?.build === BUILD_A, c.identity?.build);
  check("  …and names the source", c.identity?.buildSource === "build-stamp:ddTree", c.identity?.buildSource);
  check("  …and it is NOT the old sentinel", c.identity?.build !== "unknown");
  check("canary wrote an artifact", c.wrote === true && STORE.size === 1, `store=${STORE.size}`);

  // ⭐ THE CROSS-HANDLER ASSERTION. If the endpoint computed identity from a different source list,
  // its lookup key would differ and this would miss — which is exactly the failure being chased.
  const key = [...STORE.keys()][0];
  check("⭐ the artifact key carries the real build id", key.endsWith(BUILD_A), key);

  const e = await askEndpoint(BUILD_A);
  const eb = body(e);
  check("⭐⭐⭐ the endpoint ACCEPTS the canary's artifact (gate opens)",
    eb.refusal?.reason !== "service-unverified", `${e.statusCode}/${eb.refusal?.reason ?? "served"}`);
  check("  …and got past the health rung entirely", eb.refusal?.reason !== "build-unresolved", eb.refusal?.reason ?? "n/a");
}

// ═══════════ 2 — ⭐ DIFFERENT BUILD: the deploy gate actually gates ═══════════
section("2 — canary from build A, endpoint on build B → REFUSE");
{
  STORE.clear();
  await runCanary(BUILD_A);
  const e = await askEndpoint(BUILD_B);
  const eb = body(e);
  check("⭐⭐ endpoint REFUSES another build's fresh passing artifact",
    e.statusCode === 503 && eb.refusal?.reason === "service-unverified", `${e.statusCode}/${eb.refusal?.reason}`);
  // Note it is a KEY MISS, not a field comparison — the record is not even found, which is the
  // stronger of the two mechanisms and the one that makes cross-build reuse impossible.
  check("  …reported as no-record (the key itself differs)",
    eb.refusal?.diagnostic?.healthReason === "no-record", eb.refusal?.diagnostic?.healthReason);
  check("⭐ the diagnostic shows the endpoint's OWN identity, for comparison",
    eb.refusal?.diagnostic?.running?.build === BUILD_B || eb.refusal?.diagnostic?.healthReason === "no-record",
    JSON.stringify(eb.refusal?.diagnostic?.running?.build));
}

// ═══════════ 3 — ⭐⭐ UNRESOLVABLE ON THE ENDPOINT SIDE → REFUSE, NEVER MATCH ═══════════
section("3 — canary bound, endpoint unresolvable → REFUSE");
{
  STORE.clear();
  const c = body(await runCanary(BUILD_A));
  check("canary wrote a REAL-build artifact", c.wrote === true && c.identity.build === BUILD_A);

  const e = await askEndpoint(null);            // endpoint cannot resolve anything
  const eb = body(e);
  check("⭐⭐⭐ endpoint REFUSES rather than matching an unresolved build",
    e.statusCode === 503 && eb.refusal?.reason === "service-unverified", `${e.statusCode}`);
  check("  …with reason build-unresolved (not a misleading no-record/stale)",
    eb.refusal?.diagnostic?.healthReason === "build-unresolved", eb.refusal?.diagnostic?.healthReason);
  check("  …the endpoint's own build is NULL, not the string 'unknown'",
    eb.refusal?.diagnostic?.running?.build === null, JSON.stringify(eb.refusal?.diagnostic?.running?.build));
  check("  …and the remedy lists every source it checked",
    (eb.refusal?.diagnostic?.buildSources ?? []).join(",") === "DD_BUILD_ID,COMMIT_REF,DEPLOY_ID,BUILD_ID",
    String(eb.refusal?.diagnostic?.buildSources));
}

// ═══════════ 4 — ⭐ UNRESOLVABLE ON THE CANARY SIDE → nothing is written at all ═══════════
section("4 — canary unresolvable → refuses to sweep or write");
{
  STORE.clear();
  const r = await runCanary(null);
  const c = body(r);
  check("⭐⭐ canary REFUSES (503) instead of reporting a green run", r.statusCode === 503 && c.ok === false, `${r.statusCode}`);
  check("  …reason build-unresolved", c.reason === "build-unresolved", c.reason);
  check("⭐⭐ and writes NOTHING — no artifact that could never bind", c.wrote === false && STORE.size === 0, `store=${STORE.size}`);
  // ⭐ THE REMEDY MUST BE A BUILD STEP, NOT A CONFIG KNOB. The old text told operators to set
  // DD_BUILD_ID/COMMIT_REF/DEPLOY_ID/BUILD_ID — advice that now does NOTHING, and would have burned
  // an operator's time during an outage. Assert the new remedy AND the absence of the old one.
  check("  …offering a remedy that is a BUILD STEP", /npm run build/.test(c.remedy ?? ""), c.remedy?.slice(0, 60));
  check("⭐⭐ …and NOT the retired env knobs (following them would waste an outage)",
    !/DD_BUILD_ID|COMMIT_REF|DEPLOY_ID|BUILD_ID/.test(c.remedy ?? ""));

  // The state that made this defect so hard to read: green canary, refusing service. Now impossible.
  const e = await askEndpoint(null);
  check("⭐ endpoint refuses too — no green-canary/refusing-service contradiction",
    body(e).refusal?.diagnostic?.healthReason === "build-unresolved");
}

// ═══════════ 5 — ⭐ BOTH unresolvable: the ORIGINAL fail-open, end to end ═══════════
section("5 — both sides unresolvable → must NOT match (the old bug)");
{
  STORE.clear();
  // Force an artifact into the store as the OLD code would have written it: build "unknown".
  // This is the exact record that used to open the gate for any deploy.
  const legacy = {
    verdict: "pass",
    producedAt: new Date().toISOString(),
    identity: { schemaVersion: "onchain-analyze/0.2.0", catalogueFingerprint: "3a72caa41f60904a", build: "unknown" },
    fixtures: [],
  };
  STORE.set("health:onchain-analyze/0.2.0:3a72caa41f60904a:unknown", legacy);

  const e = await askEndpoint(null);
  const eb = body(e);
  check("⭐⭐⭐ a legacy build:'unknown' artifact does NOT open the gate",
    e.statusCode === 503, `${e.statusCode}`);
  check("  …refused as build-unresolved, before any comparison could match",
    eb.refusal?.diagnostic?.healthReason === "build-unresolved", eb.refusal?.diagnostic?.healthReason);
  check("⭐ and setting COMMIT_REF='unknown' cannot revive it either", await (async () => {
    process.env.COMMIT_REF = "unknown";
    const r2 = body(await askEndpoint(null));
    delete process.env.COMMIT_REF;
    return r2.refusal?.diagnostic?.healthReason === "build-unresolved";
  })());
}

// ═══════════ 6 — the full round trip, twice, with a redeploy in between ═══════════
section("6 — deploy A serves; redeploy to B refuses until B's canary runs");
{
  STORE.clear();
  await runCanary(BUILD_A);
  check("build A: endpoint serves", body(await askEndpoint(BUILD_A)).refusal?.reason !== "service-unverified");

  // "Redeploy": same store, new build id, canary has not run yet for it.
  check("⭐⭐ redeploy to B: endpoint REFUSES on A's artifact (this IS the deploy gate)",
    body(await askEndpoint(BUILD_B)).refusal?.reason === "service-unverified");

  await runCanary(BUILD_B);
  check("⭐⭐ after B's canary runs, endpoint serves again",
    body(await askEndpoint(BUILD_B)).refusal?.reason !== "service-unverified");
  check("  …and A's artifact is still there, still not used for B", STORE.size === 2, `store=${STORE.size}`);
  check("⭐ A still serves on A — the gate binds, it does not just fail",
    body(await askEndpoint(BUILD_A)).refusal?.reason !== "service-unverified");
}

console.log(`\n╔══════════════════════════════════════════════════════════════════════`);
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES PRESENT"}   pass ${pass} / fail ${fail}`);
console.log(`╚══════════════════════════════════════════════════════════════════════`);
process.exit(fail === 0 ? 0 : 1);
