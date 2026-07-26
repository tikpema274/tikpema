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

import { connectLambda } from "@netlify/blobs";
import { json } from "./_arc.mjs";
import { analyze } from "../../shared/onchain-analyze/index.mjs";
import { SCHEMA_VERSION } from "../../shared/onchain-analyze/schema.mjs";
import { POWER_SIGS } from "../../shared/onchain-facts/index.mjs";
import { runFixtures } from "../../shared/dd-canary/fixtures.mjs";
import { codeIdentity } from "../../shared/dd-canary/health.mjs";
import { writeHealth } from "./_dd-health.mjs";

export async function handler(event) {
  if (event?.blobs) connectLambda(event);
  const identity = codeIdentity({ schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS });

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
    wrote,
    identity,
    failures: suite.results.filter((r) => !r.ok).map((r) => ({ id: r.id, problems: r.problems })),
    fixtures: suite.results.length,
  });
}
