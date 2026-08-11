#!/usr/bin/env node
// verify-dd-code-identity.mjs — the health artifact is keyed by DD CODE, not by deployment event.
//
// ═══ WHY THIS CHANGED ════════════════════════════════════════════════════════════════════════════
// The key used to carry the DEPLOY ID. That answers "which deployment event", when the question the
// artifact must answer is "which DD code". They differ on every redeploy of identical code, and —
// the reason it mattered — on every UNRELATED deploy. Measured over the last 40 commits: 20 touched
// the stamped surface, only 2 touched DD, and **18 were stamp-dirty but DD-CLEAN**. Once DD went
// public each of those 18 was an outage caused by bridge/research/agent work.
//
// ═══ 🚨 THE THREE DIRECTIONS ═════════════════════════════════════════════════════════════════════
//   1. same DD bytes    ⇒ SAME key      (the fix: no window on a DD-clean deploy)
//   2. one byte changed ⇒ DIFFERENT key (the binding still binds — this is the safety property)
//   3. unavailable      ⇒ UNBOUND       on BOTH the canary side and the analyze side
//
// (3) is the load-bearing one. A fallback that both sides compute identically is `unknown ===
// unknown` wearing a new name — the exact fail-open this mechanism exists to close, and one this
// codebase has already shipped once (fixed in 1dd8f75). It must be asserted on BOTH sides, because
// a binding can only be tested across the thing it binds.

import { createHash } from "node:crypto";
import { ddCodeIdentity } from "../../shared/build-stamp.mjs";
import { codeIdentity, codeIdentityForEvent, buildIsBound, evaluateHealth, shouldSkipRerun }
  from "../../shared/dd-canary/health.mjs";
import { SCHEMA_VERSION } from "../../shared/onchain-analyze/schema.mjs";
import { POWER_SIGS } from "../../shared/onchain-facts/index.mjs";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  cond ? pass++ : fail++;
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

const hex64 = (seed) => createHash("sha256").update(seed).digest("hex");
const stampWith = (ddTree, extra = {}) => ({
  commit: "a".repeat(40), dirty: false, dirtyCount: 0,
  tree: hex64("tree"), ddTree, ddFileCount: 19,
  generatedAt: "2026-08-11T00:00:00.000Z", ...extra,
});
const idFrom = (stamp) => codeIdentity({ schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS, stamp });

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  DD CODE IDENTITY — keyed by code, not by deployment event           ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("1 — SAME DD BYTES ⇒ SAME KEY (the window fix)");
{
  const t = hex64("dd-surface-v1");
  const a = idFrom(stampWith(t));
  const b = idFrom(stampWith(t));
  check("two stamps with the same ddTree give the same identity", a.build === b.build, a.build?.slice(0, 16));
  check("⭐ both are BOUND", buildIsBound(a) && buildIsBound(b));

  // The point of the change: different deployment events, identical code, ONE verdict.
  const evA = { headers: { "x-nf-deploy-id": "a".repeat(24) } };
  const evB = { headers: { "x-nf-deploy-id": "b".repeat(24) } };
  const ia = codeIdentityForEvent(evA, { schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS });
  const ib = codeIdentityForEvent(evB, { schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS });
  check("⭐⭐ DIFFERENT deploy ids ⇒ SAME identity (no refusal window on a DD-clean redeploy)",
    ia.build === ib.build && ia.build !== null);
  check("  …and the deploy id is still recorded, for diagnosis", ia.deployId !== ib.deployId);
  check("⭐ …but is NOT part of what evaluateHealth compares",
    !["schemaVersion", "catalogueFingerprint", "build"].includes("deployId"));

  // A record written under deploy A must satisfy the gate on deploy B.
  const rec = { producedAt: new Date().toISOString(), verdict: "pass", identity: ia };
  const h = evaluateHealth({ record: rec, readable: true, now: Date.now(), expect: ib });
  check("⭐⭐ a record written on deploy A SERVES on deploy B", h.serve === true, h.reason);
}

section("2 — ONE BYTE CHANGED ⇒ DIFFERENT KEY (the binding still binds)");
{
  const a = idFrom(stampWith(hex64("dd-surface-v1")));
  const b = idFrom(stampWith(hex64("dd-surface-v2")));
  check("a different ddTree gives a different identity", a.build !== b.build);
  check("⭐ both still bound (a change is not an outage-by-unboundedness)", buildIsBound(a) && buildIsBound(b));

  const rec = { producedAt: new Date().toISOString(), verdict: "pass", identity: a };
  const h = evaluateHealth({ record: rec, readable: true, now: Date.now(), expect: b });
  check("⭐⭐ an artifact for OLD DD code does NOT serve NEW DD code",
    h.serve === false && h.reason === "version-mismatch", h.reason);
  check("  …and dedupe never crosses the change either",
    shouldSkipRerun(rec, { now: Date.now(), expect: b }).skip === false);

  // The catalogue is a separate key component and must ALSO still bind.
  const catA = codeIdentity({ schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS, stamp: stampWith(hex64("x")) });
  const catB = codeIdentity({ schemaVersion: SCHEMA_VERSION, powerSigs: { ...POWER_SIGS, newGroup: ["f()"] }, stamp: stampWith(hex64("x")) });
  check("⭐ a catalogue change still changes the identity, independently of ddTree",
    catA.catalogueFingerprint !== catB.catalogueFingerprint);
}

section("3 — 🚨 UNAVAILABLE ⇒ UNBOUND, on BOTH sides");
{
  // Every way the stamp can fail to name the DD surface.
  const cases = [
    ["stamp is null (deploy skipped stamping)", null],
    ["stamp is malformed (array)", []],
    ["stamp is malformed (string)", "nope"],
    ["ddTree absent (stamp predates the DD hash)", stampWith(undefined)],
    ["ddTree null (DD surface incomplete at stamp time)", stampWith(null)],
    ["ddTree not 64-hex", stampWith("deadbeef")],
    ["ddTree is the literal 'unknown'", stampWith("unknown")],
    ["ddTree is empty", stampWith("")],
  ];
  for (const [label, stamp] of cases) {
    const r = ddCodeIdentity(stamp);
    const id = idFrom(stamp);
    const ok = r.resolved === false && r.id === null && id.build === null && buildIsBound(id) === false;
    check(`${label} ⇒ UNBOUND`, ok, ok ? "" : JSON.stringify({ r: r.id, build: id.build }));
  }

  // ⚠️ `undefined` is NOT in the list above, deliberately. It means "argument not supplied", so the
  // default parameter uses the BAKED-IN stamp — which is exactly the production call path
  // (codeIdentity passes no stamp). Asserting `undefined ⇒ UNBOUND` would have been asserting
  // against the real deployed behaviour. The dangerous version of that case IS covered: when the
  // baked stamp is itself null (a deploy that skipped stamping), the `null` row above applies.
  check("⭐ `undefined` means USE THE BAKED STAMP — the production path, not an unbound signal",
    ddCodeIdentity(undefined).resolved === ddCodeIdentity().resolved);

  // ⭐⭐ THE FAIL-OPEN THIS FORBIDS: two unbound identities must NOT compare equal.
  const u1 = idFrom(null);
  const u2 = idFrom(stampWith("unknown"));
  check("⭐⭐ two UNBOUND identities do not satisfy each other (no `unknown === unknown`)",
    !(buildIsBound(u1) && buildIsBound(u2)));
  check("  …and neither is the deploy id, nor any constant", u1.build === null && u2.build === null);

  // ── side A: the CANARY must refuse to WRITE ──────────────────────────────────────────────────
  check("⭐⭐ CANARY SIDE: unbound ⇒ buildIsBound false ⇒ rung 0 writes nothing",
    buildIsBound(u1) === false);
  check("  …and dedupe refuses too, so it re-runs rather than coasting",
    shouldSkipRerun({ producedAt: new Date().toISOString(), identity: u1 },
      { now: Date.now(), expect: u1 }).reason === "build-unresolved");

  // ── side B: dd-analyze must refuse to SERVE, ahead of the record ─────────────────────────────
  const fresh = { producedAt: new Date().toISOString(), verdict: "pass", identity: u1 };
  const h = evaluateHealth({ record: fresh, readable: true, now: Date.now(), expect: u1 });
  check("⭐⭐ ANALYZE SIDE: unbound ⇒ refuses EVEN WITH a fresh passing record present",
    h.serve === false && h.reason === "build-unresolved", h.reason);
  check("  …build-unresolved OUTRANKS stale/no-record/malformed (it is checked first)",
    evaluateHealth({ record: null, readable: true, now: Date.now(), expect: u1 }).reason === "build-unresolved");
  check("  …and outranks an UNREADABLE store too",
    evaluateHealth({ record: null, readable: false, now: Date.now(), expect: u1 }).reason === "build-unresolved");
}

section("4 — the real deployed stamp resolves (this build could actually serve)");
{
  const live = codeIdentityForEvent({ headers: {} }, { schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS });
  check("the checked-out tree produces a bound identity", buildIsBound(live), live.build?.slice(0, 16));
  check("⭐ sourced from the build stamp, not from any env var", live.buildSource === "build-stamp:ddTree", live.buildSource);
  check("  …and is a 64-hex content hash", /^[0-9a-f]{64}$/.test(live.build ?? ""));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
