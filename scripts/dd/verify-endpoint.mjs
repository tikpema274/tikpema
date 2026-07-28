// verify-endpoint.mjs — acceptance for the dd-analyze HTTP surface.
//
// ⭐ THE GATE IS FAULT-INJECTED INPUT, NOT A HEALTHY CALL. A local module's caller is a programmer;
// an endpoint's caller is anyone. The question is not "does it work" but "does every bad input come
// back as a STRUCTURED REPORT rather than a stack trace, a 500, or a default that reads as an
// answer". A healthy call proves almost nothing on its own.
//
//   node scripts/dd/verify-endpoint.mjs                      # 3 refusals — zero network, zero Circle
//   node --env-file=.env scripts/dd/verify-endpoint.mjs --live      # + the healthy signed report
//   node --env-file=.env scripts/dd/verify-endpoint.mjs --url <URL> # the same table over the WIRE
//
// The three refusals short-circuit before analyze() is ever called, so they need no RPC and no
// signer — which is why they are the cheap, always-run half.

import { assertReportValid, SCHEMA_VERSION } from "../../shared/onchain-analyze/schema.mjs";
import { verifyAttestation } from "../../shared/onchain-analyze/attest.mjs";
import { POWER_SIGS } from "../../shared/onchain-facts/index.mjs";

// ⚠️ dd-analyze's exposure gate (RUNG -1, unset = DISABLED) sits before every other rung. This suite
// exercises the rungs BEHIND it, so open it explicitly rather than letting a 503 masquerade as a
// failure of the logic under test. The gate's own coverage is scripts/dd/verify-dd-exposure.mjs.
// ⭐ A REAL BUILD ID, because "unknown" is exactly the bug this suite failed to catch. The build
// binding used to fall back to the literal string "unknown" on BOTH the canary and the endpoint, so
// it compared equal to itself and the deploy gate silently became a no-op. Every suite here ran in
// ONE process with ONE env, where both sides are trivially identical — which is why none of them
// could ever have seen it. A binding is only testable across the thing it binds, so these now run
// with a resolvable id and the cross-build cases live in verify-build-binding.mjs.
process.env.DD_BUILD_ID = process.env.DD_BUILD_ID || "test-build-0000000000000000000000000000000000000000";

process.env.DD_PUBLIC_ENABLED = "1";

// ⚠️ dd-analyze's health gate (RUNG 0) refuses unless a fresh, version-matched canary artifact exists.
// This suite tests the rungs BEHIND it, so vouch for health the same way verify-canary.mjs does.
// (These two suites silently rotted when the health gate landed in 1f6f106 — they were not in any npm
// script, so nothing re-ran them. They are in `test:dd` now.)
import { mock } from "node:test";
import { SCHEMA_VERSION as _SV } from "../../shared/onchain-analyze/schema.mjs";
import { POWER_SIGS as _PS } from "../../shared/onchain-facts/index.mjs";
import { codeIdentity as _ci } from "../../shared/dd-canary/health.mjs";
const _identity = _ci({ schemaVersion: _SV, powerSigs: _PS });
mock.module("../../netlify/functions/_dd-health.mjs", {
  namedExports: {
    readHealth: async () => ({
      record: { verdict: "pass", producedAt: new Date().toISOString(), identity: _identity, fixtures: [] },
      readable: true,
    }),
    writeHealth: async () => true,
    DD_HEALTH_STORE: "mock",
    healthKey: () => "mock",
  },
});

const { handler } = await import("../../netlify/functions/dd-analyze.mjs");

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

const URL_IX = process.argv.indexOf("--url");
const TARGET_URL = URL_IX >= 0 ? process.argv[URL_IX + 1] : null;
const LIVE = process.argv.includes("--live") || Boolean(TARGET_URL);

const VAULT = "0x240Eb85458CD41361bd8C3773253a1D78054f747";

/** One request, either in-process or over the wire — the SAME assertions apply to both. */
async function call(body, { method = "POST" } = {}) {
  if (TARGET_URL) {
    const r = await fetch(TARGET_URL, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* left null — asserted below */ }
    return { status: r.status, body: parsed, raw: text };
  }
  const res = await handler({ httpMethod: method, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body), raw: res.body };
}

/** Every response must satisfy these, refusal or not. This is the "one parser" promise. */
function assertReportShape(label, res, { expectRefusal }) {
  const r = res.body;
  check(`${label}: body parsed as JSON`, r && typeof r === "object");
  if (!r || typeof r !== "object") return;
  check(`${label}: schemaVersion is ${SCHEMA_VERSION}`, r.schemaVersion === SCHEMA_VERSION, r.schemaVersion);
  for (const k of ["subject", "shape", "powers", "coverage", "refusal", "attestation"]) {
    check(`${label}: carries \`${k}\``, Object.prototype.hasOwnProperty.call(r, k));
  }
  check(`${label}: attestation is NEVER absent`, r.attestation && typeof r.attestation.status === "string", r.attestation?.status);
  // The completeness invariant applies to refusals too — an empty coverage block would itself
  // trip assertReportValid and turn one clean refusal into a second, confusing one.
  const revalidated = assertReportValid(r);
  check(`${label}: satisfies the completeness invariant`, revalidated.refusal?.reason !== "coverage-incomplete",
    revalidated.refusal?.reason === "coverage-incomplete" ? JSON.stringify(revalidated.refusal.problems?.slice(0, 2)) : "ok");
  check(`${label}: every catalogue power is accounted for`,
    Object.keys(POWER_SIGS).every((g) => [...r.coverage.checked, ...r.coverage.notChecked].some((e) => e.group === g)));
  if (expectRefusal) {
    check(`${label}: refusal is POPULATED (powers:[] never stands alone)`, !!r.refusal?.reason, r.refusal?.reason);
    check(`${label}: powers is empty`, Array.isArray(r.powers) && r.powers.length === 0);
  }
  // No internals. A stack frame, an absolute path, or a bare Error string is a leak.
  const leak = /\bat [A-Za-z_$][\w$]*\s*\(|\/home\/|node_modules|node:internal|TypeError:|ReferenceError:/;
  check(`${label}: leaks NO internals (no stack, no path)`, !leak.test(res.raw),
    (res.raw.match(leak) ?? [""])[0]);
}

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log(`║  dd-analyze — FAULT-INJECTED ACCEPTANCE ${TARGET_URL ? "(OVER THE WIRE)" : "(in-process)  "}            ║`);
console.log("╚══════════════════════════════════════════════════════════════════════╝");
if (TARGET_URL) console.log(`  target: ${TARGET_URL}`);

// ═══════════ GATE 1 — malformed address ═══════════
section("GATE 1 — malformed address");
for (const [what, addr] of [
  ["not hex", "0xZZZZ"],
  ["too short", "0x240Eb854"],
  ["missing 0x", "240Eb85458CD41361bd8C3773253a1D78054f747"],
  ["wrong type", 12345],
]) {
  const res = await call({ address: addr, chain: "arc-testnet" });
  check(`${what}: HTTP 400 (a bad question, not a bad answer)`, res.status === 400, `got ${res.status}`);
  check(`${what}: reason invalid-address`, res.body?.refusal?.reason === "invalid-address", res.body?.refusal?.reason);
  if (what === "not hex") assertReportShape("malformed-address", res, { expectRefusal: true });
}

// ═══════════ GATE 2 — missing / empty param ═══════════
section("GATE 2 — missing or empty parameters");
{
  let res = await call({ chain: "arc-testnet" });
  check("address missing: HTTP 400 + invalid-address", res.status === 400 && res.body?.refusal?.reason === "invalid-address", res.body?.refusal?.reason);
  assertReportShape("missing-address", res, { expectRefusal: true });

  res = await call({ address: "", chain: "arc-testnet" });
  check("address empty: refused, not defaulted", res.body?.refusal?.reason === "invalid-address");

  res = await call({ address: VAULT });
  check("chain missing: refused (an address alone names no chain)", res.status === 400 && res.body?.refusal?.reason === "chain-not-specified", res.body?.refusal?.reason);

  res = await call("{ this is not json");
  check("unparseable body: HTTP 400 + malformed-request", res.status === 400 && res.body?.refusal?.reason === "malformed-request", res.body?.refusal?.reason);
  assertReportShape("malformed-body", res, { expectRefusal: true });

  res = await call({}, { method: "GET" });
  check("wrong method: HTTP 405 as a REPORT, not an error envelope", res.status === 405 && res.body?.refusal?.reason === "unsupported-method", res.body?.refusal?.reason);
}

// ═══════════ GATE 3 — non-Arc chain ═══════════
section("GATE 3 — non-Arc chain → unsupported-chain, served as a report");
for (const c of ["base", "base-sepolia", "ethereum", "mainnet"]) {
  const res = await call({ address: VAULT, chain: c });
  check(`chain "${c}": unsupported-chain`, res.status === 400 && res.body?.refusal?.reason === "unsupported-chain", res.body?.refusal?.reason);
}
{
  const res = await call({ address: VAULT, chain: "base" });
  assertReportShape("unsupported-chain", res, { expectRefusal: true });
  check("unsupported-chain: the REASON rides in coverage, not just the refusal",
    res.body.coverage.notChecked.every((e) => /unsupported-chain/.test(e.reason)),
    res.body.coverage.notChecked[0]?.reason?.slice(0, 60));
  check("unsupported-chain: coverage summary says INDETERMINATE, not clean",
    /INDETERMINATE.*not a clean bill/.test(res.body.coverage.summary), res.body.coverage.summary?.slice(-46));
  check("unsupported-chain: nothing was scanned", res.body.coverage.totals.checked === 0);
  check("unsupported-chain: NOT signed (no on-chain claim to attest)", res.body.attestation.status === "unsigned");
}

// ═══════════ GATE 4 — healthy Arc address ═══════════
section("GATE 4 — healthy Arc address → full signed, coverage-bearing report");
if (!LIVE) {
  console.log("  ⚠️  NOT RUN — needs the real chain and Circle signer.");
  console.log("      node --env-file=.env scripts/dd/verify-endpoint.mjs --live");
  console.log("      (a skip is NOT a pass)");
} else {
  const res = await call({ address: VAULT, chain: "arc-testnet" });
  check("healthy: HTTP 200", res.status === 200, `got ${res.status}`);
  assertReportShape("healthy", res, { expectRefusal: false });
  const r = res.body;
  check("healthy: real analysis ran (checks > 0)", r.coverage.totals.checked > 0, `checked=${r.coverage.totals.checked}`);
  check("healthy: powers inventory present", Array.isArray(r.powers) && r.powers.length > 0, `${r.powers?.length} powers`);
  check("healthy: subject names the chain it was analyzed on", r.subject.chainId === 5042002 && r.subject.chainName === "arc-testnet");
  check("⭐ healthy: report is SIGNED", r.attestation.status === "signed", r.attestation.status);
  check("healthy: attestation binds agentId 851891", r.attestation.agentId === "851891", r.attestation.agentId);
  check("healthy: method is erc1271", r.attestation.method === "erc1271");

  // ⭐ The point of the whole exercise: a report fetched over the wire must verify EXACTLY as a
  // locally produced one — same canonicalization, same on-chain checks, no transport fixups.
  const { chainClient } = await import("./client.mjs");
  const v = await verifyAttestation(r, { client: chainClient("arc-testnet"), expect: { agentId: "851891" } });
  check("⭐ healthy: the WIRE report verifies on-chain (valid:true, ok)", v.valid === true && v.reason === "ok", `reason=${v.reason} ${v.detail ?? ""}`);

  // ── tampering must still be caught after a round trip through HTTP + JSON ──
  //
  // ⚠️ THE TAMPER MUST ACTUALLY TAMPER. The first version of this test emptied
  // `coverage.notChecked` on THIS subject — which has full coverage, so notChecked was ALREADY []
  // and the "attack" mutated nothing. It correctly verified as ok, and the test read that as a
  // failure to reject. A fault-injection test that injects no fault proves nothing; asserted here
  // rather than assumed.
  const cc = chainClient("arc-testnet");
  const tamper = async (label, fn, expectDifferent = true) => {
    const t = JSON.parse(JSON.stringify(r));
    fn(t);
    const changed = JSON.stringify(t) !== JSON.stringify(r);
    check(`  ${label}: the tamper genuinely changes the bytes`, changed === expectDifferent, `changed=${changed}`);
    const tv = await verifyAttestation(t, { client: cc, expect: { agentId: "851891" } });
    check(`healthy: ${label} → REJECTED`, tv.valid === false && tv.reason === "bad-signature", `reason=${tv.reason}`);
  };

  await tamper("a coverage.checked entry removed", (t) => { t.coverage.checked.pop(); });
  await tamper("a power's `present` flipped", (t) => { t.powers[0].present = !t.powers[0].present; });
  await tamper("coverage.totals inflated", (t) => { t.coverage.totals.checked = 99; });
  await tamper("sources.independenceVerified flipped to true", (t) => { t.sources.independenceVerified = true; });

  // ⭐ The laundering attack in its true form, against a subject that HAS notChecked entries: strip
  // them and the report would read as a complete clean bill.
  const noCode = await call({ address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chain: "arc-testnet" });
  const nc = noCode.body;
  check("second subject has notChecked entries to strip", nc.coverage.notChecked.length > 0, `${nc.coverage.notChecked.length} entries`);
  check("second subject is signed", nc.attestation.status === "signed");
  const stripped = JSON.parse(JSON.stringify(nc));
  stripped.coverage.notChecked = [];
  stripped.coverage.totals.notChecked = 0;
  const sv = await verifyAttestation(stripped, { client: cc, expect: { agentId: "851891" } });
  check("⭐ healthy: notChecked STRIPPED from a wire report → REJECTED", sv.valid === false && sv.reason === "bad-signature", `reason=${sv.reason}`);
}

console.log(`\n╔══════════════════════════════════════════════════════════════════════`);
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES PRESENT"}   pass ${pass} / fail ${fail}`);
console.log(`╚══════════════════════════════════════════════════════════════════════`);
process.exit(fail === 0 ? 0 : 1);
