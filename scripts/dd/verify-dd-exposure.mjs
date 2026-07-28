// verify-dd-exposure.mjs — deploying the DD service must NOT be the same act as publishing it.
//
// ⭐ THE PROPERTY: unset = DISABLED. Before this gate existed, the safety of prod rested on nobody
// having typed `netlify deploy --prod` — `/api/dd-analyze` is committed and Netlify has no
// per-function deploy, so one routine command would have published a free public
// signed-attestation endpoint under agentId 851891. The safeguard lived in an untyped command; now
// it lives in the code.
//
//   node scripts/dd/verify-dd-exposure.mjs      # zero network, zero money
//
// No mocks needed for the gate itself: it is a pure predicate over an env string, and the endpoint
// check short-circuits before any blob or chain read.

import { evaluateExposure, EXPOSURE_REASON } from "../../netlify/functions/_dd-exposure.mjs";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  DD EXPOSURE GATE — deployed ≠ published                            ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═══════════ A — the predicate ═══════════
section("A — unset = DISABLED, and so is anything unrecognised");
{
  for (const [label, raw] of [
    ["undefined (never set)", undefined],
    ["null", null],
    ["empty string", ""],
    ["whitespace only", "   "],
  ]) {
    const v = evaluateExposure(raw);
    check(`⭐ ${label} → DISABLED`, v.enabled === false && v.reason === EXPOSURE_REASON.UNSET, v.reason);
  }

  for (const raw of ["1", "true", "TRUE", "on", "yes", "enabled", " true ", "1 "]) {
    const v = evaluateExposure(raw);
    check(`"${raw}" → enabled`, v.enabled === true && v.reason === EXPOSURE_REASON.ENABLED);
  }

  for (const raw of ["0", "false", "off", "no", "disabled"]) {
    const v = evaluateExposure(raw);
    check(`"${raw}" → explicitly disabled`, v.enabled === false && v.reason === EXPOSURE_REASON.DISABLED);
  }

  // ⭐ The typo case. An ambiguous instruction must resolve NARROW.
  // ⚠️ Whitespace is NOT in this list on purpose. " true " and "1 " ARE enabled: surrounding
  // whitespace is an artifact of how an env var was set, not a change of intent, so the module trims.
  // An earlier version of this test asserted " true " enabled AND "1 " disabled — self-contradictory.
  for (const raw of ["ture", "yes please", "maybe", "enable", "on!", "TRUEISH", "public"]) {
    const v = evaluateExposure(raw);
    check(`⭐ unrecognised "${raw}" → DISABLED (a typo must not widen exposure)`,
      v.enabled === false && v.reason === EXPOSURE_REASON.UNRECOGNISED, v.reason);
  }

  check("⭐ NOT ONE input enables by accident — only the explicit allowlist does",
    ["ture", "maybe", "", "   ", undefined, null, "off", "2", "-1"].every((r) => evaluateExposure(r).enabled === false));
  check("`enabled` is a strict boolean, never truthy-by-accident", evaluateExposure("1").enabled === true);
}

// ═══════════ B — the real endpoint ═══════════
section("B ⭐ — the REAL handler refuses when unset, even for a VALID request");
{
  const { handler } = await import("../../netlify/functions/dd-analyze.mjs");
  const call = async (body) => {
    const res = await handler({ httpMethod: "POST", body: JSON.stringify(body), headers: {} });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  const VALID = { address: "0x240Eb85458CD41361bd8C3773253a1D78054f747", chain: "arc-testnet" };

  delete process.env.DD_PUBLIC_ENABLED;
  let r = await call(VALID);
  check("⭐⭐ flag UNSET + VALID request → 503, service-not-enabled",
    r.status === 503 && r.body.refusal?.reason === "service-not-enabled", `${r.status}/${r.body.refusal?.reason}`);
  check("  …no analysis ran (gate is before everything)", r.body.coverage.totals.checked === 0);
  check("  …still a structured report, not an error page",
    ["subject", "coverage", "refusal", "attestation"].every((k) => k in r.body));
  check("  …unsigned", r.body.attestation.status === "unsigned");
  check("  …and it says how to enable it deliberately", /DD_PUBLIC_ENABLED/.test(r.body.refusal.detail));

  process.env.DD_PUBLIC_ENABLED = "ture";                 // typo
  r = await call(VALID);
  check("⭐ typo'd flag → still 503", r.status === 503 && r.body.refusal?.reason === "service-not-enabled", r.body.refusal?.reason);

  process.env.DD_PUBLIC_ENABLED = "off";
  r = await call(VALID);
  check("explicitly off → 503", r.status === 503 && r.body.refusal?.reason === "service-not-enabled");

  // Enabled: the gate opens and the NEXT rung takes over (health), proving it gates rather than blocks.
  process.env.DD_PUBLIC_ENABLED = "1";
  r = await call({ address: "0xZZZZ", chain: "arc-testnet" });
  check("⭐ enabled → the gate OPENS and the request reaches the later rungs",
    r.body.refusal?.reason !== "service-not-enabled", r.body.refusal?.reason);

  delete process.env.DD_PUBLIC_ENABLED;                   // leave the process as we found it
}

// ═══════════ C — composition ═══════════
section("C — a not-enabled refusal can never settle");
{
  const { settleDecision } = await import("../../shared/x402/settle-gate.mjs");
  const { handler } = await import("../../netlify/functions/dd-analyze.mjs");
  delete process.env.DD_PUBLIC_ENABLED;
  const res = await handler({ httpMethod: "POST", headers: {},
    body: JSON.stringify({ address: "0x240Eb85458CD41361bd8C3773253a1D78054f747", chain: "arc-testnet" }) });
  const rpt = JSON.parse(res.body);
  const d = settleDecision(rpt);
  check("⭐ service-not-enabled → settle gate REFUSES (no new code needed)", d.settle === false, d.reason);
  check("  the two gates compose on `refusal !== null`, as designed", rpt.refusal !== null);
}

console.log(`\n╔══════════════════════════════════════════════════════════════════════`);
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES PRESENT"}   pass ${pass} / fail ${fail}`);
console.log(`╚══════════════════════════════════════════════════════════════════════`);
process.exit(fail === 0 ? 0 : 1);
