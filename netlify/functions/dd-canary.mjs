// dd-canary.mjs — runs the known-shape fixtures and writes the health record the DD service needs
// in order to serve at all.
//
// ⭐ IT ONLY EVER WRITES A POSITIVE ASSERTION. It does not need to "turn the service off" on failure:
// the service refuses unless a fresh, version-matched PASS exists, so a failing run simply does not
// produce one and the previous record ages out. That means every way this function can die —
// crash, timeout, deploy skew, Blobs outage, never scheduled at all — lands on REFUSE without any
// code here having to handle it.
//
// Runs on a schedule AND is invokable directly. A new deploy changes the code identity, so the old
// record no longer matches and the service refuses until this runs again: the deploy gate falls out
// of the version binding rather than needing a build plugin, which keeps the site build uncoupled
// from the DD suite (a detector regression must not block a deploy that fixes a vault bug).
//
// ⚠️ Guards the DD SERVICE ONLY. Imports nothing from _vault.mjs and writes to its own store.

// ⭐ connectBlobs, NOT connectLambda — the shim drops event.blobs' `url_uncached`, without which
// _dd-health's strong-consistency read throws. See _blobs.mjs.
import { connectBlobs } from "./_blobs.mjs";
import { json } from "./_arc.mjs";
import { analyze } from "../../shared/onchain-analyze/index.mjs";
import { SCHEMA_VERSION } from "../../shared/onchain-analyze/schema.mjs";
import { POWER_SIGS } from "../../shared/onchain-facts/index.mjs";
import { runFixtures } from "../../shared/dd-canary/fixtures.mjs";
import { codeIdentity, shouldSkipRerun, buildIsBound, BUILD_ID_SOURCES, MIN_RERUN_MS } from "../../shared/dd-canary/health.mjs";
import { readHealth, writeHealth } from "./_dd-health.mjs";

// ═══ ⭐ SAFE-PUBLIC: A TRIGGER, NOT AN ORACLE ═════════════════════════════════════════════════
// This endpoint is publicly invocable (every file in netlify/functions is, whether scheduled or
// not — the `_` prefix is a repo convention, not protection). That is SAFE, and the reason is
// structural rather than defensive:
//
//   THE VERDICT IS SEALED FROM REQUEST INPUT BY ABSENCE OF A CHANNEL, NOT BY VALIDATION.
//
// `event` is read for exactly one thing — `event.blobs`, which Netlify's Lambda shim injects and an
// HTTP caller cannot set. No query string, no body, no headers are read anywhere. `runFixtures()`
// receives NOTHING derived from the request. There is no parameter to sanitise because there is no
// parameter, and an absent channel cannot drift the way a validator can.
//
// So the worst a public caller can do is make it RUN, and every run writes the TRUTH: a pass is
// written only when the fixtures actually pass. An anonymous caller cannot forge a pass and cannot
// force a fail. If they could write a pass, they could un-refuse a broken service — turning the last
// safety layer into an attack surface. That is the property the acceptance test attacks directly.
//
// 🚨 THE INVARIANT TO KEEP: `runFixtures` must never receive anything derived from `event`, and
// `event` must never be read except for `.blobs`. Adding a "harmless" debug flag would break the
// seal. The acceptance test enforces this by feeding hostile input to a DELIBERATELY FAILING suite
// and asserting the written verdict is still "fail".

export async function handler(event) {
  if (event?.blobs) connectBlobs(event);
  const identity = codeIdentity({ schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS });

  // ── ⭐ RUNG 0: CAN THIS RUN VOUCH FOR ANYTHING AT ALL? ───────────────────────────────────────
  // Refuse BEFORE sweeping if the build cannot be identified. Running the fixtures and writing a
  // PASS would be actively misleading: the record could never satisfy the endpoint's gate, yet this
  // handler would answer `ok:true, wrote:true` — a green canary next to a refusing service, with
  // nothing connecting the two. That exact combination is what made this defect hard to diagnose.
  //
  // ⚠️ The old code could not reach this state because `build` fell back to "unknown" on BOTH sides,
  // which MATCHED — so the binding silently became a no-op instead of failing. Refusing loudly here
  // is the whole point of the change.
  if (!buildIsBound(identity)) {
    return json(503, {
      ok: false,
      reran: false,
      wrote: false,
      reason: "build-unresolved",
      detail: identity.buildDetail,
      identity,
      remedy: `set one of ${BUILD_ID_SOURCES.join(", ")} on this deploy — DD_BUILD_ID is the explicit lever when the platform provides none (e.g. a CLI manual deploy, which runs no build and therefore sets no build-time variables).`,
    });
  }

  // ── ANTI-AMPLIFICATION: reuse a recent run rather than re-sweeping on every hit ──────────────
  // Today's fixtures are hermetic (no RPC), so a hit costs CPU and one Blobs round trip rather than
  // upstream calls. The dedupe is built now anyway because it is the STRUCTURAL place a future live
  // Arc probe stays bounded — build the guard before the thing it guards, or whoever adds the probe
  // silently creates the amplifier. Applies regardless of verdict; see shouldSkipRerun.
  const prior = await readHealth(identity);
  const dedupe = shouldSkipRerun(prior.record, { now: Date.now(), expect: identity, readable: prior.readable });
  if (dedupe.skip) {
    const passing = prior.record.verdict === "pass";
    return json(passing ? 200 : 503, {
      ok: passing,
      reran: false,
      deduped: true,
      reason: `a run for this build completed ${Math.round(dedupe.ageMs / 1000)}s ago (window ${Math.round(MIN_RERUN_MS / 1000)}s) — reusing it instead of re-sweeping`,
      identity,
      verdict: prior.record.verdict,
      failures: (prior.record.fixtures ?? []).filter((f) => !f.ok).map((f) => ({ id: f.id, problems: f.problems })),
    });
  }

  let suite;
  try {
    suite = await runFixtures(analyze);
  } catch (e) {
    // runFixtures already swallows per-fixture throws; reaching here means the suite itself could
    // not run. Do NOT write a record: absence is the correct signal, and writing a "fail" adds
    // nothing the absence does not already say.
    return json(500, { ok: false, wrote: false, error: `fixture suite could not run: ${e?.message ?? e}` });
  }

  const record = {
    verdict: suite.passed ? "pass" : "fail",
    producedAt: new Date().toISOString(),
    identity,
    fixtures: suite.results.map((r) => ({ id: r.id, ok: r.ok, problems: r.problems })),
    // The live probe is a SEPARATE question (did something change under us?) and is not built yet.
    // Declared explicitly rather than omitted, so its absence cannot read as "it passed".
    live: { status: "not-run", note: "live Arc probe not implemented — the halting gate is the hermetic fixture suite" },
  };

  // Only a PASS is worth persisting. Writing a "fail" is harmless but pointless: the service already
  // refuses on the absence of a fresh pass, and a stored fail would just be a second way to say so.
  // We write it anyway ONLY so an operator can see WHICH fixture broke without re-running.
  const wrote = await writeHealth(identity, record);

  return json(suite.passed ? 200 : 503, {
    ok: suite.passed,
    reran: true,
    deduped: false,
    wrote,
    identity,
    failures: suite.results.filter((r) => !r.ok).map((r) => ({ id: r.id, problems: r.problems })),
    fixtures: suite.results.length,
  });
}
