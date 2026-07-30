// verify-build-binding.mjs — does the canary→endpoint version binding ACTUALLY gate?
//
// ═══ 🚨 THE DEFECT THIS EXISTS TO PREVENT RECURRING ══════════════════════════════════════════
// `codeIdentity().build` used to fall back to the literal string `"unknown"`. When no build id could
// be resolved — which is ALWAYS the case on a Netlify CLI manual deploy, because that path runs no
// build and therefore sets no build-time variables — BOTH the canary and the endpoint stamped
// `"unknown"`, and `"unknown" === "unknown"` MATCHES.
//
// So the binding did not fail closed. It silently became a NO-OP: an old deploy's passing artifact
// satisfied a new deploy's gate, because the only field that distinguishes deploys had collapsed to
// a constant. The deploy gate — the entire reason a new deploy is supposed to invalidate the old
// vouch — stopped existing, and nothing anywhere said so.
//
// ⭐ WHY TEN SUITES MISSED IT, WHICH IS THE REAL LESSON. Every existing suite runs in ONE process
// with ONE environment, so the canary side and the endpoint side are trivially identical and the
// comparison always succeeds — for the WRONG reason. **A binding can only be tested across the thing
// it binds.** Same-process tests cannot see a cross-build defect no matter how many of them there
// are. This file exists to be the one that runs the comparison across two DIFFERENT builds.
//
//   node scripts/dd/verify-build-binding.mjs      # zero network, zero money
//
// ⚠️ Deliberately does NOT set DD_BUILD_ID globally. It passes `env` explicitly per case, because a
// suite that sets one process-wide id would reintroduce exactly the same-env blind spot.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  codeIdentity, evaluateHealth, shouldSkipRerun, resolveBuildId, buildIsBound,
  codeIdentityForEvent, deployIdFromEvent, DEPLOY_ID_HEADER,
  HEALTH_REASON, BUILD_ID_SOURCES, DEFAULT_TTL_MS,
} from "../../shared/dd-canary/health.mjs";
import { healthKey } from "../../netlify/functions/_dd-health.mjs";
import { SCHEMA_VERSION } from "../../shared/onchain-analyze/schema.mjs";
import { POWER_SIGS } from "../../shared/onchain-facts/index.mjs";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

const BUILD_A = "6a690473aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BUILD_B = "b2c3d4e5ffffffffffffffffffffffffffffffff";

/** Identity as a given deploy would compute it — env passed EXPLICITLY, never ambient. */
const idFor = (env) => codeIdentity({ schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS, env });

/** A passing canary record produced BY a given build. */
const recordFrom = (identity, ageMs = 0) => ({
  verdict: "pass",
  producedAt: new Date(Date.now() - ageMs).toISOString(),
  identity,
  fixtures: [{ id: "f1", ok: true }],
});

/** The endpoint's decision, given a record and the identity IT computes. */
const gate = (record, expect, now = Date.now()) =>
  evaluateHealth({ record, readable: true, now, expect });

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  BUILD BINDING — does a deploy actually invalidate the old vouch?   ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═══════════ 1 — resolution, with no placeholder anywhere ═══════════
// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("0 — THE DEPLOY-ID BINDING: one derivation, used by both sides");
// MEASURED 2026-07-30 on a real scheduled invocation: all four env sources ABSENT, while the
// request carried x-nf-deploy-id equal to the published deploy id. So the canary refused at rung 0
// and wrote nothing for days — and dd-analyze would have refused EVERYTHING once DD_PUBLIC_ENABLED
// was set. env:get could not have told us: it synthesises COMMIT_REF from local git HEAD.
{
  const DEP = "6a6b7cf6a8646a0087041f42";
  const ev = (h) => ({ headers: h });

  check("⭐⭐ reads the deploy id from the header", deployIdFromEvent(ev({ [DEPLOY_ID_HEADER]: DEP })) === DEP);
  check("  …case-insensitively", deployIdFromEvent(ev({ "X-NF-Deploy-Id": DEP })) === DEP);
  check("⭐ no headers / no key -> null, never a placeholder",
    deployIdFromEvent({}) === null && deployIdFromEvent(ev({ "content-type": "x" })) === null &&
    deployIdFromEvent(undefined) === null);
  check("⭐⭐ a MALFORMED id -> null (refusing beats binding to garbage)",
    ["", "nope", "0", "z".repeat(24), "a".repeat(23), "a".repeat(25), "unknown"]
      .every((v) => deployIdFromEvent(ev({ [DEPLOY_ID_HEADER]: v })) === null));

  // ⭐⭐ THE ACTUAL BINDING TEST — across the two sides, not on one of them.
  // dd-canary (cron) WRITES the artifact; dd-analyze (HTTP) READS it. Same event id must yield the
  // same identity, or the keys never match. This is the assertion that would have caught the
  // pre-1dd8f75 no-op, where both sides independently produced "unknown" and matched for the
  // WRONG reason.
  const cronEv = { headers: { [DEPLOY_ID_HEADER]: DEP }, blobs: "x" };          // scheduled shape
  const httpEv = { headers: { [DEPLOY_ID_HEADER]: DEP, "user-agent": "curl" }, httpMethod: "POST" };
  const a = codeIdentityForEvent(cronEv, { schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS, env: {} });
  const b = codeIdentityForEvent(httpEv, { schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS, env: {} });
  check("⭐⭐ cron-shaped and http-shaped events yield the SAME identity",
    JSON.stringify(a) === JSON.stringify(b), a.build);
  check("  …and it is BOUND, with NO env source present at all",
    buildIsBound(a) === true && a.build === DEP);

  // The header must WIN over env, or a stale DD_BUILD_ID would silently pin the binding.
  const withEnv = codeIdentityForEvent(cronEv, { schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS, env: { DD_BUILD_ID: "stale-pinned-value" } });
  check("⭐ the header WINS over env sources (resolveBuildId prefers an explicit build)",
    withEnv.build === DEP);

  // And with no header it must still fall through to env, so a git-triggered build keeps working.
  const envOnly = codeIdentityForEvent({ headers: {} }, { schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS, env: { DD_BUILD_ID: BUILD_A } });
  check("⭐ no header -> falls through to env (a git build still binds)", envOnly.build === BUILD_A);
  check("⭐⭐ neither header nor env -> UNBOUND, and the canary must refuse",
    buildIsBound(codeIdentityForEvent({ headers: {} }, { schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS, env: {} })) === false);

  // 🚨 STRUCTURAL: both handlers must call the SHARED derivation, never codeIdentity directly.
  const canary = readFileSync("netlify/functions/dd-canary.mjs", "utf8").replace(/^\s*\/\/.*$/gm, "");
  const analyze = readFileSync("netlify/functions/dd-analyze.mjs", "utf8").replace(/^\s*\/\/.*$/gm, "");
  check("⭐⭐ dd-canary uses codeIdentityForEvent and NOT bare codeIdentity",
    /codeIdentityForEvent\(event,/.test(canary) && !/[^r]codeIdentity\(\{/.test(canary));
  check("⭐⭐ dd-analyze uses codeIdentityForEvent and NOT bare codeIdentity",
    /codeIdentityForEvent\(event,/.test(analyze) && !/[^r]codeIdentity\(\{/.test(analyze));
}

section("1 — resolveBuildId never invents a value");
{
  check("explicit build wins", resolveBuildId({ build: BUILD_A, env: {} }).id === BUILD_A);
  for (const key of BUILD_ID_SOURCES) {
    const r = resolveBuildId({ env: { [key]: BUILD_A } });
    check(`resolves from ${key}`, r.resolved === true && r.id === BUILD_A && r.source === key, r.source);
  }
  check("⭐ DD_BUILD_ID takes precedence over platform vars",
    resolveBuildId({ env: { DD_BUILD_ID: BUILD_A, COMMIT_REF: BUILD_B } }).id === BUILD_A);

  const none = resolveBuildId({ env: {} });
  check("⭐⭐ nothing available → resolved:false, id NULL (not a placeholder)",
    none.resolved === false && none.id === null, JSON.stringify(none.id));
  check("  …and it names the remedy", /DD_BUILD_ID/.test(none.detail));

  // ⭐ The old sentinel must not be reintroducible through the env either.
  const literal = resolveBuildId({ env: { COMMIT_REF: "unknown" } });
  check('⭐⭐ the literal string "unknown" is REJECTED as a value', literal.resolved === false && literal.id === null);
  check('  …and so is "UNKNOWN" / whitespace', resolveBuildId({ env: { COMMIT_REF: " UNKNOWN " } }).resolved === false
    && resolveBuildId({ env: { COMMIT_REF: "   " } }).resolved === false);
}

// ═══════════ 2 — ⭐⭐ THE REGRESSION: unresolved must NEVER match itself ═══════════
section("2 — unresolved on BOTH sides → REFUSE (the old fail-open)");
{
  const idNone = idFor({});                       // a deploy with no build id
  check("identity.build is null, not 'unknown'", idNone.build === null, JSON.stringify(idNone.build));
  check("buildIsBound() says no", buildIsBound(idNone) === false);

  // This is EXACTLY the old bug: a canary and an endpoint that both failed to resolve.
  const rec = recordFrom(idNone);
  const g = gate(rec, idNone);
  check("⭐⭐⭐ a FRESH PASSING record from an unresolved build does NOT satisfy the gate",
    g.serve === false, `serve=${g.serve}`);
  check("  …and the reason is build-unresolved, not a misleading staleness/mismatch",
    g.reason === HEALTH_REASON.BUILD_UNRESOLVED, g.reason);
  check("  …and it explains that no record could vouch", /no health record can be shown to vouch/i.test(g.detail));

  // Prove the OLD behaviour would have passed here — the sentinel comparison, spelled out.
  check("⭐ demonstrating the old defect: 'unknown' === 'unknown' would have MATCHED",
    "unknown" === "unknown" && g.serve === false,
    "the sentinel compared equal to itself; null now refuses instead");

  // Dedupe must not coast either.
  const d = shouldSkipRerun(rec, { now: Date.now(), expect: idNone });
  check("⭐ dedupe also refuses to skip on an unresolved build", d.skip === false && d.reason === "build-unresolved", d.reason);
}

// ═══════════ 3 — ⭐ SAME BUILD MATCHES (the binding must still let real health through) ═══════════
section("3 — same build → SERVES");
{
  const canarySide = idFor({ DD_BUILD_ID: BUILD_A });
  const endpointSide = idFor({ DD_BUILD_ID: BUILD_A });
  check("both sides resolved a real id", buildIsBound(canarySide) && buildIsBound(endpointSide), canarySide.build);
  check("  …and it is NOT the sentinel", canarySide.build === BUILD_A && canarySide.build !== "unknown");
  check("  …recording which source it came from", canarySide.buildSource === "DD_BUILD_ID", canarySide.buildSource);

  const g = gate(recordFrom(canarySide), endpointSide);
  check("⭐⭐ a fresh pass from the SAME build SERVES", g.serve === true && g.reason === HEALTH_REASON.OK, g.reason);
  check("  …storage keys agree", healthKey(canarySide) === healthKey(endpointSide), healthKey(endpointSide));
  check("  …and the key carries the real id, not 'unknown'", healthKey(endpointSide).includes(BUILD_A));
}

// ═══════════ 4 — ⭐⭐ DIFFERENT BUILD REFUSES (the deploy gate, actually gating) ═══════════
section("4 — different build → REFUSES (this is the deploy gate)");
{
  const oldDeploy = idFor({ DD_BUILD_ID: BUILD_A });
  const newDeploy = idFor({ DD_BUILD_ID: BUILD_B });

  const g = gate(recordFrom(oldDeploy), newDeploy);
  check("⭐⭐⭐ an old build's PASSING, FRESH record does NOT vouch for the new build",
    g.serve === false, `serve=${g.serve}`);
  check("  …reason is version-mismatch", g.reason === HEALTH_REASON.VERSION_MISMATCH, g.reason);
  check("  …naming build as the differing field", (g.evidence.mismatched ?? []).includes("build"), String(g.evidence.mismatched));
  check("  …and carrying BOTH identities for diagnosis",
    g.evidence.recorded?.build === BUILD_A && g.evidence.running?.build === BUILD_B);

  check("⭐ the two builds also get DIFFERENT storage keys (it cannot even be found)",
    healthKey(oldDeploy) !== healthKey(newDeploy));
  check("⭐ dedupe refuses across builds too (never reuse another build's run)",
    shouldSkipRerun(recordFrom(oldDeploy), { now: Date.now(), expect: newDeploy }).skip === false);
}

// ═══════════ 5 — a resolved build must not paper over the OTHER identity fields ═══════════
section("5 — build is one of three bound fields, not a replacement for them");
{
  const base = idFor({ DD_BUILD_ID: BUILD_A });
  for (const [field, mutated] of [
    ["schemaVersion", { ...base, schemaVersion: "onchain-analyze/9.9.9" }],
    ["catalogueFingerprint", { ...base, catalogueFingerprint: createHash("sha256").update("different").digest("hex").slice(0, 16) }],
  ]) {
    const g = gate(recordFrom(mutated), base);
    check(`⭐ same build but different ${field} → REFUSES`, g.serve === false && g.reason === HEALTH_REASON.VERSION_MISMATCH, g.reason);
    check(`  …naming ${field}`, (g.evidence.mismatched ?? []).includes(field), String(g.evidence.mismatched));
  }
}

// ═══════════ 6 — ordering: the build check precedes everything it could be confused with ═══════════
section("6 — build-unresolved outranks staleness, absence and unreadability");
{
  const idNone = idFor({});
  // Each of these would produce a DIFFERENT refusal reason if the build check were not first — and
  // each of those reasons would have sent an operator chasing the wrong thing, which is precisely
  // what happened on the draft (a green canary, and a refusal that read like a TTL problem).
  const cases = [
    ["no record at all", { record: null, readable: true }],
    ["store unreadable", { record: null, readable: false }],
    ["record long stale", { record: recordFrom(idNone, DEFAULT_TTL_MS * 4), readable: true }],
    ["record malformed", { record: { nonsense: true }, readable: true }],
    ["verdict fail", { record: { ...recordFrom(idNone), verdict: "fail" }, readable: true }],
  ];
  for (const [label, input] of cases) {
    const g = evaluateHealth({ ...input, now: Date.now(), expect: idNone });
    check(`${label} + unresolved build → build-unresolved (not a misleading reason)`,
      g.serve === false && g.reason === HEALTH_REASON.BUILD_UNRESOLVED, g.reason);
  }
  check("⭐ every path still refuses — the ordering changes the REASON, never the answer", true);
}

// ═══════════ 7 — with a real build id, the other reasons work normally again ═══════════
section("7 — a bound build restores the normal reason ladder");
{
  const id = idFor({ DD_BUILD_ID: BUILD_A });
  check("no record → no-record", gate(null, id).reason === HEALTH_REASON.NO_RECORD);
  check("unreadable → unreadable", evaluateHealth({ record: null, readable: false, now: Date.now(), expect: id }).reason === HEALTH_REASON.UNREADABLE);
  check("stale → stale", gate(recordFrom(id, DEFAULT_TTL_MS * 4), id).reason === HEALTH_REASON.STALE);
  check("fail verdict → not-passing", gate({ ...recordFrom(id), verdict: "fail" }, id).reason === HEALTH_REASON.NOT_PASSING);
  check("⭐ and a good one still serves", gate(recordFrom(id), id).serve === true);
}

console.log(`\n╔══════════════════════════════════════════════════════════════════════`);
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES PRESENT"}   pass ${pass} / fail ${fail}`);
console.log(`╚══════════════════════════════════════════════════════════════════════`);
process.exit(fail === 0 ? 0 : 1);
