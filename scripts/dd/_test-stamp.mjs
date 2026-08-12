// _test-stamp.mjs — ONE deterministic build stamp for the suites, so none of them read disk.
//
// ═══ 🚨 THE COUPLING THIS REMOVES ═══════════════════════════════════════════════════════
// `shared/build-stamp.generated.mjs` is GENERATED and its committed value is deliberately
// `null`. Since f714bb9 made that stamp the DD IDENTITY, any suite that let `codeIdentity()`
// fall through to disk inherited a dependency on LOCAL BUILD RESIDUE:
//
//     npm run build       → stamp set   → suite passes
//     npm run stamp:clear → stamp null  → identity UNBOUND → dd-analyze refuses
//                                          `build-unresolved` at rung 0 and the suite fails
//
// ⭐ MEASURED 2026-08-12: SEVEN of seventeen DD suites flipped result between those two
// states, on the same commit. `test:dd` was green earlier that day only because deploys had
// been running. A suite whose verdict depends on what you last ran is not reporting on the
// code — and the failures it produced NAMED THE WRONG THING ("expected 400 invalid-address,
// got 503 service-unverified"), which is how it went unnoticed.
//
// ⭐⭐ THE FIX IS ONE SOURCE OF TRUTH, NOT SEVEN PATCHES. A per-suite inline mock would drift:
// six copies of a constant is the duplicate-source-of-truth failure this repo keeps meeting.
//
// ⚠️ MUST BE CALLED BEFORE importing anything that pulls in shared/dd-canary/health.mjs —
// that module resolves ddCodeIdentity at load time, so a later mock is too late. In practice:
// call this at the top, then `await import()` the module under test.
//
// ⚠️ DO NOT USE IN verify-dd-code-identity.mjs's live-stamp section. That suite exists to test
// the REAL resolution, and mocking it there would delete the only check that the deployed
// artifact can actually bind.

import { mock } from "node:test";

/** A fixed, obviously-synthetic identity. 64 hex so it passes the same shape gate as a real
 *  ddTree — a test value that would fail validation proves nothing about production. */
export const TEST_DD_TREE = "e".repeat(64);
export const TEST_COMMIT = "a".repeat(40);
export const TEST_TREE = "b".repeat(64);

/** Install the deterministic stamp. Call FIRST, before importing the module under test. */
export function mockBuildStamp({ ddTree = TEST_DD_TREE, resolved = true } = {}) {
  mock.module("../../shared/build-stamp.mjs", {
    namedExports: {
      ddCodeIdentity: () =>
        resolved
          ? { resolved: true, id: ddTree, source: "test-injected",
              detail: "deterministic identity injected by the suite — never the on-disk stamp" }
          : { resolved: false, id: null, source: null,
              detail: "test-injected UNBOUND stamp" },
      buildStamp: () => ({
        resolved: true, commit: TEST_COMMIT, dirty: false, tree: TEST_TREE,
        fileCount: 1, generatedAt: "2026-01-01T00:00:00.000Z", detail: "test-injected",
      }),
      provenanceIsBound: () => true,
    },
  });
}

// ═══ ⚠️ WHY THIS HELPER ONLY COVERS SOME SUITES — AND WHAT COVERS THE REST ══════════════
// ESM HOISTS ALL STATIC IMPORTS ABOVE MODULE-LEVEL CODE. So `mockBuildStamp()` runs AFTER any
// statically-imported module has already resolved `ddCodeIdentity` — the mock is simply too
// late, and it no-ops SILENTLY. Measured: it fixed verify-endpoint and
// verify-health-read-consistency (both use `await import()`), and did nothing at all for
// verify-canary, verify-canary-public and verify-settle-gate.
//
// ⭐ A MECHANISM THAT WORKS IN SOME CALLERS AND QUIETLY NOT IN OTHERS IS WORSE THAN NONE, so
// the ineffective calls were REMOVED rather than left looking like protection. Using this
// helper requires converting the module under test to a dynamic import — do that deliberately,
// per suite, not by pattern-matching.
//
// ⚠️ THE REMAINING SUITES ARE COVERED BY A RUNNER STEP, NOT BY ISOLATION: `test:dd` now runs
// `npm run stamp` first. That makes the suite reliable, but it is a MITIGATION, not a fix —
// running one of those suites ALONE against a cleared stamp still fails, and still fails with
// a misleading message ("expected 400 invalid-address, got 503 service-unverified") rather than
// "there is no build stamp". Stated so the next reader does not rediscover it the hard way.
