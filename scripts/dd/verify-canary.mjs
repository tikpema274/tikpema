// verify-canary.mjs — acceptance for the DD canary and its stop-serving mechanism.
//
// ⭐ THE LOAD-BEARING TEST IS #2: CANARY-ITSELF-BROKEN. A canary that catches fixture regressions but
// keeps the service answering when the canary ITSELF dies is worse than none — it manufactures
// confidence. The last safety layer must not itself fail open, so every way the canary can fail
// (never ran, crashed, timed out, its record deleted, stale, unreadable, from another build) must
// land on REFUSE. Absence of a pass must never read as "no alarm, carry on".
//
//   node --experimental-test-module-mocks scripts/dd/verify-canary.mjs          # offline
//   node --experimental-test-module-mocks --env-file=.env scripts/dd/verify-canary.mjs --live
//
// The module-mocks flag is required: proving the ENDPOINT refuses means substituting its health
// reader, which is the same pattern scripts/verify-vault.mjs already uses for _pause.mjs.

import { mock } from "node:test";
import { analyze } from "../../shared/onchain-analyze/index.mjs";
import { SCHEMA_VERSION } from "../../shared/onchain-analyze/schema.mjs";
import { POWER_SIGS } from "../../shared/onchain-facts/index.mjs";
import { runFixtures, FIXTURES } from "../../shared/dd-canary/fixtures.mjs";
import { codeIdentity, evaluateHealth, HEALTH_REASON, DEFAULT_TTL_MS } from "../../shared/dd-canary/health.mjs";

// ⚠️ dd-analyze's exposure gate (RUNG -1, unset = DISABLED) sits before every other rung. This suite
// exercises the rungs BEHIND it, so open it explicitly rather than letting a 503 masquerade as a
// failure of the logic under test. The gate's own coverage is scripts/dd/verify-dd-exposure.mjs.
process.env.DD_PUBLIC_ENABLED = "1";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

const IDENTITY = codeIdentity({ schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS });
const NOW = Date.now();
const freshPass = () => ({
  verdict: "pass", producedAt: new Date(NOW - 60_000).toISOString(),
  identity: { ...IDENTITY }, fixtures: FIXTURES.map((f) => ({ id: f.id, ok: true, problems: [] })),
  live: { status: "not-run" },
});

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  DD CANARY — stop serving on regression, and fail closed when the    ║");
console.log("║  canary itself cannot run                                           ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═══════════ FIXTURES ═══════════
section("FIXTURES — the detector is correct on known shapes");
{
  const suite = await runFixtures(analyze);
  check("all fixtures pass against the real detector", suite.passed,
    suite.results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.problems[0]}`).join(" | ") || `${suite.results.length} fixtures`);
  for (const r of suite.results) check(`  ${r.id}`, r.ok, r.problems[0] ?? "");
  check("the suite covers diamond / UUPS / clone / fee-vault / eoa",
    ["eip2535-diamond", "uups-empty-admin-slot", "eip1167-clone", "fee-settable-vault", "eoa-unobservable"]
      .every((id) => FIXTURES.some((f) => f.id === id)));
}

// ═══════════ CASE 1 — REGRESSION CAUGHT ═══════════
section("CASE 1 — a broken detector is CAUGHT by the suite");
{
  // Fault injection: a detector that misreads the empty admin slot as "not upgradeable" — the exact
  // wrong answer the mirror README warns readers about. Injected by corrupting analyze()'s output
  // rather than editing shape.mjs, so the real detector is never left broken on disk.
  const brokenUups = async (addr, opts) => {
    const r = await analyze(addr, opts);
    if (r.shape?.variant === "uups") return { ...r, shape: { ...r.shape, variant: "not-upgradeable", class: "plain-contract" } };
    return r;
  };
  const suite = await runFixtures(brokenUups);
  check("⭐ suite FAILS when the UUPS detector regresses", suite.passed === false);
  const uups = suite.results.find((r) => r.id === "uups-empty-admin-slot");
  check("  the failing fixture is identified", uups?.ok === false, uups?.id);
  check("  and it names the misread", uups?.problems.some((p) => /empty admin slot was misread|not-upgradeable/i.test(p)),
    uups?.problems[0]?.slice(0, 70));
  check("  the OTHER fixtures still report individually (one break does not hide the rest)",
    suite.results.filter((r) => r.ok).length === FIXTURES.length - 1,
    `${suite.results.filter((r) => r.ok).length}/${FIXTURES.length} still ok`);

  const rec = { verdict: suite.passed ? "pass" : "fail", producedAt: new Date(NOW).toISOString(), identity: IDENTITY, fixtures: suite.results };
  const h = evaluateHealth({ record: rec, readable: true, now: NOW, expect: IDENTITY });
  check("⭐ the health artifact goes NOT-PASSING", h.serve === false && h.reason === HEALTH_REASON.NOT_PASSING, h.reason);
  check("  and it names which fixture broke", h.evidence.failures?.includes("uups-empty-admin-slot"), String(h.evidence.failures));
}

// ═══════════ CASE 2 — ⭐ THE CANARY ITSELF IS BROKEN ═══════════
section("CASE 2 ⭐ — canary itself broken → STILL REFUSE (never 'no news is good news')");
{
  const cases = [
    ["canary NEVER RAN (no record at all)", { record: null, readable: true }, HEALTH_REASON.NO_RECORD],
    ["canary CRASHED before writing (still no record)", { record: undefined, readable: true }, HEALTH_REASON.NO_RECORD],
    ["health store UNREADABLE (Blobs down)", { record: null, readable: false }, HEALTH_REASON.UNREADABLE],
    ["record DELETED between runs", { record: null, readable: true }, HEALTH_REASON.NO_RECORD],
    ["record STALE (canary stopped reporting)", { record: { ...freshPass(), producedAt: new Date(NOW - DEFAULT_TTL_MS - 60_000).toISOString() }, readable: true }, HEALTH_REASON.STALE],
    ["record from ANOTHER BUILD", { record: { ...freshPass(), identity: { ...IDENTITY, build: "some-older-deploy" } }, readable: true }, HEALTH_REASON.VERSION_MISMATCH],
    ["record with a CHANGED CATALOGUE", { record: { ...freshPass(), identity: { ...IDENTITY, catalogueFingerprint: "deadbeefdeadbeef" } }, readable: true }, HEALTH_REASON.VERSION_MISMATCH],
    ["record MALFORMED (no verdict)", { record: { producedAt: new Date(NOW).toISOString(), identity: IDENTITY }, readable: true }, HEALTH_REASON.MALFORMED],
    ["record is not an object", { record: "pass", readable: true }, HEALTH_REASON.MALFORMED],
    ["verdict is an UNRECOGNISED string", { record: { ...freshPass(), verdict: "probably-fine" }, readable: true }, HEALTH_REASON.NOT_PASSING],
    ["producedAt is garbage", { record: { ...freshPass(), producedAt: "soon" }, readable: true }, HEALTH_REASON.MALFORMED],
    ["record dated in the FUTURE (clock skew or forgery)", { record: { ...freshPass(), producedAt: new Date(NOW + 3600_000).toISOString() }, readable: true }, HEALTH_REASON.STALE],
  ];
  for (const [label, input, expected] of cases) {
    const h = evaluateHealth({ ...input, now: NOW, expect: IDENTITY });
    check(`${label} → REFUSE`, h.serve === false && h.reason === expected, `${h.reason}`);
  }
  check("⭐ NOT ONE of these paths returns serve:true", cases.every(([, i]) => evaluateHealth({ ...i, now: NOW, expect: IDENTITY }).serve === false));
  check("serve is a strict boolean, never truthy-by-accident", evaluateHealth({ record: freshPass(), readable: true, now: NOW, expect: IDENTITY }).serve === true);
}

// ═══════════ CASE 3 — HEALTHY ═══════════
section("CASE 3 — all fixtures pass, artifact fresh → serve");
{
  const h = evaluateHealth({ record: freshPass(), readable: true, now: NOW, expect: IDENTITY });
  check("healthy → serve", h.serve === true && h.reason === HEALTH_REASON.OK, h.reason);
  check("  evidence carries freshness", typeof h.evidence.ageMs === "number" && h.evidence.ageMs < DEFAULT_TTL_MS);
  const edge = evaluateHealth({ record: { ...freshPass(), producedAt: new Date(NOW - DEFAULT_TTL_MS + 5000).toISOString() }, readable: true, now: NOW, expect: IDENTITY });
  check("  just inside the TTL still serves", edge.serve === true, edge.reason);
}

// ═══════════ THE ENDPOINT ACTUALLY STOPS ANSWERING ═══════════
section("THE ENDPOINT — same request, two health states, two outcomes");
{
  let health = { record: freshPass(), readable: true };
  mock.module("../../netlify/functions/_dd-health.mjs", {
    namedExports: {
      readHealth: async () => health,
      writeHealth: async () => true,
      DD_HEALTH_STORE: "mock",
      healthKey: () => "mock",
    },
  });
  const { handler } = await import("../../netlify/functions/dd-analyze.mjs");
  const call = async (body) => {
    const res = await handler({ httpMethod: "POST", body: JSON.stringify(body) });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };

  // The SAME malformed request under both health states. Offline: it never reaches analysis.
  const REQ = { address: "0xZZZZ", chain: "arc-testnet" };

  health = { record: freshPass(), readable: true };
  let r = await call(REQ);
  check("HEALTHY: the request reaches validation (400 invalid-address)", r.status === 400 && r.body.refusal?.reason === "invalid-address", `${r.status}/${r.body.refusal?.reason}`);

  for (const [label, h] of [
    ["fixture regression (verdict fail)", { record: { ...freshPass(), verdict: "fail", fixtures: [{ id: "uups-empty-admin-slot", ok: false, problems: ["misread"] }] }, readable: true }],
    ["canary never ran (no record)", { record: null, readable: true }],
    ["health store unreadable", { record: null, readable: false }],
    ["record stale", { record: { ...freshPass(), producedAt: new Date(NOW - DEFAULT_TTL_MS - 1).toISOString() }, readable: true }],
    ["record from another build", { record: { ...freshPass(), identity: { ...IDENTITY, build: "old" } }, readable: true }],
  ]) {
    health = h;
    r = await call(REQ);
    check(`⭐ ${label}: endpoint REFUSES (503)`, r.status === 503 && r.body.refusal?.reason === "service-unverified", `${r.status}/${r.body.refusal?.reason}`);
    check(`  …and says it is NO result, not a degraded one`, /not a degraded result|REFUSING TO SERVE/i.test(r.body.refusal?.detail ?? ""));
    check(`  …still a structured report, not an error page`, ["subject", "coverage", "refusal", "attestation"].every((k) => k in r.body));
    check(`  …unsigned, and nothing was scanned`, r.body.attestation.status === "unsigned" && r.body.coverage.totals.checked === 0);
  }

  // A well-formed request must ALSO be refused — the gate is not a validation quirk.
  health = { record: null, readable: true };
  r = await call({ address: "0x240Eb85458CD41361bd8C3773253a1D78054f747", chain: "arc-testnet" });
  check("⭐ a VALID request is refused too — the service is uniformly unavailable", r.status === 503 && r.body.refusal?.reason === "service-unverified", `${r.status}`);
  check("  the gate fires BEFORE any analysis (nothing was scanned)", r.body.coverage.totals.checked === 0);

  // …and money cannot move for a refused request: the settle gate keys on refusal === null.
  const { settleDecision } = await import("../../shared/x402/settle-gate.mjs");
  check("⭐ a service-unverified refusal can NEVER settle (composes with the payment gate)",
    settleDecision(r.body).settle === false, settleDecision(r.body).reason);

  if (process.argv.includes("--live")) {
    section("LIVE — healthy artifact → the service answers for real");
    health = { record: freshPass(), readable: true };
    const live = await call({ address: "0x240Eb85458CD41361bd8C3773253a1D78054f747", chain: "arc-testnet" });
    check("healthy + valid request → 200 with a real report", live.status === 200 && live.body.refusal === null, `${live.status}`);
    check("  analysis actually ran", live.body.coverage.totals.checked > 0, `checked=${live.body.coverage.totals.checked}`);
    check("  and it is signed", live.body.attestation.status === "signed", live.body.attestation.status);
  } else {
    console.log("\n  (add --live to prove a healthy artifact serves a real signed report)");
  }
}

console.log(`\n╔══════════════════════════════════════════════════════════════════════`);
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES PRESENT"}   pass ${pass} / fail ${fail}`);
console.log(`╚══════════════════════════════════════════════════════════════════════`);
process.exit(fail === 0 ? 0 : 1);
