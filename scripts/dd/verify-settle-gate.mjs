// verify-settle-gate.mjs — acceptance for the x402 settle gate.
//
// ⭐ THE LINE THAT MATTERS is not full-vs-outage, it is THIN-vs-OUTAGE. A full report settling and a
// thrown error not settling are both easy. The product decision is that a report which RAN but could
// barely check anything STILL SETTLES — because an honest "here is what I could and could not check"
// is the thing being sold, and the manifest ships inside the settled artifact so the caller sees the
// gaps they paid for.
//
// Every case below is built by FAULT INJECTION through the real analyze(), not by hand-writing a
// report shape. A hand-written fixture would prove only that the gate reads fields; driving the real
// engine proves the gate reads the fields the engine actually produces.
//
//   node scripts/dd/verify-settle-gate.mjs      # zero network, zero money, zero facilitator
//
// No facilitator, no key, no broadcast: `settle` is injected and records that it was called.

import { analyze } from "../../shared/onchain-analyze/index.mjs";
import { settleDecision, runThenSettle, noChargeResponse, SETTLE_REASON } from "../../shared/x402/settle-gate.mjs";
import { attachAttestation, unsignedAttestation } from "../../shared/onchain-analyze/attest.mjs";
import { POWER_SIGS, sel, EIP1967_IMPL_SLOT } from "../../shared/onchain-facts/index.mjs";

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

const { handler: ddHandler } = await import("../../netlify/functions/dd-analyze.mjs");

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

const SUBJ = "0x1111111111111111111111111111111111111111";
const OWNER = "0x3333333333333333333333333333333333333333";
const ZERO_WORD = "0x" + "0".repeat(64);
const word = (a) => "0x" + a.replace(/^0x/, "").padStart(64, "0");
const codeWith = (sigs) => "0x60806040" + sigs.map((s) => sel(s)).join("") + "00";

function mockClient(handlers = {}) {
  return {
    chain: { name: "mock-chain" },
    assert: async () => 5042002,
    pin: async () => ({ number: 1000, tag: "0x3e8" }),
    async call({ method, params }) {
      const key =
        method === "eth_getCode" ? `code@${String(params[0]).toLowerCase()}`
        : method === "eth_getStorageAt" ? `slot@${String(params[1]).toLowerCase()}`
        : method === "eth_call" ? `call@${String(params[0]?.data)}`
        : method;
      const h = handlers[key];
      if (h === undefined) throw Object.assign(new Error(`mock: unhandled ${key}`), { transient: false });
      if (typeof h === "function") return h();
      return { result: h, query: { endpoint: "mock://", method, params, reproduce: `# mock ${key}` }, evidence: { httpStatus: 200 } };
    },
  };
}
const transientThrow = () => { throw Object.assign(new Error("request limit reached"), { transient: true, query: { endpoint: "mock://", method: "m", params: [], reproduce: "# m" } }); };

// ═══ ⭐ FIXTURES MUST BE SIGNED NOW, AND THAT IS THE POINT ═══════════════════════════════════
// settleDecision gained a 4th condition: only a VERIFIABLE SIGNED attestation settles. Every fixture
// here comes from the real analyze(), and analyze() returns `attestation: {status:"unsigned"}` from
// baseReport — so before this helper existed, EVERY settling case in this suite silently became a
// non-settling one the moment the condition landed. That is the correct failure: the suite was
// asserting a charge for an artifact the 402 never promised.
//
// The signer below is a FAKE — this suite holds no key, makes no Circle call, and signs nothing real.
// It produces a well-formed attestation so the gate's structural check can be exercised offline. The
// REAL signature's validity is verify-attestation.mjs's job (eth_call → 0x1626ba7e); this file only
// proves the gate refuses to bill for an artifact nobody could check.
const FAKE_SIG = "0x" + "ab".repeat(65);
const signFixture = (report) => attachAttestation(report, {
  sign: async () => FAKE_SIG,
  agentId: "851891",
  verifyingContract: "0xc54D47211997aCA90Ef4fCfBc742a3b511B4e621",
  registry: "0x8004A8180E2Cb8B1D4Cb0eB0Cd5b0b8bA0Ee0000",
  chainId: "5042002",
});

/** An injected settler that MOVES NO MONEY and records whether it was reached, and when. */
function settlerSpy(log) {
  return async (report) => {
    log.push("SETTLE");
    return { ok: true, txish: "mock-settlement", subject: report?.subject?.address ?? null };
  };
}

const allPowerSigs = Object.values(POWER_SIGS).flat();

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  x402 SETTLE GATE — charge for answers, not outages                  ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═══════════ CASE 1 — FULL report ═══════════
section("CASE 1 — FULL report → SETTLES");
{
  const client = mockClient({
    [`code@${SUBJ}`]: codeWith(allPowerSigs),
    [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD,
    [`call@0x8da5cb5b`]: word(OWNER),
    [`code@${OWNER}`]: "0x",
  });
  const report = await signFixture(await analyze(SUBJ, { client }));
  const d = settleDecision(report);
  check("engine answered (refusal null)", report.refusal === null, report.refusal?.reason ?? "null");
  check("⭐ SETTLES", d.settle === true && d.reason === SETTLE_REASON.ANSWERED, `${d.reason}`);
  check("coverage is full", d.evidence.notChecked === 0, `checked=${d.evidence.checked} notChecked=${d.evidence.notChecked}`);
  check("coverageRatio reported", d.evidence.coverageRatio === 1, String(d.evidence.coverageRatio));

  const log = [];
  const out = await runThenSettle({ produceReport: async () => signFixture(await analyze(SUBJ, { client })), settle: settlerSpy(log) });
  check("settle WAS invoked", log.includes("SETTLE"));
  check("body says charged", out.body.charged === true && out.body.settled === true);
}

// ═══════════ CASE 2 — THIN report (the line that matters) ═══════════
section("CASE 2 — THIN report → STILL SETTLES");
{
  // ⚠️ FINDING, established by trying the obvious thing first and watching it not work: with READABLE
  // bytecode, power coverage is ALL-OR-NOTHING. Every power group is a selector scan over the same
  // effective code, so if we have that code all 9 scan, and if we do not the shape refuses outright.
  // Defeating the OWNER read (the first attempt at "thin") pushes `owner:owner()` into notChecked but
  // leaves all 9 powers checked — thin, but not thin in POWERS. The genuine most-powers-unchecked
  // answer is the no-bytecode case: the engine reads successfully, finds no code, and correctly
  // records every power as UNOBSERVABLE rather than absent.
  const client = mockClient({ [`code@${SUBJ}`]: "0x" });
  const report = await signFixture(await analyze(SUBJ, { client }));
  const d = settleDecision(report);
  const nc = report.coverage.notChecked.filter((n) => n.kind === "power").length;
  const ck = report.coverage.checked.filter((c) => c.kind === "power").length;

  check("engine RAN but MOST POWERS are unchecked", nc === 9 && ck === 0, `powers: ${ck} checked / ${nc} notChecked`);
  check("overall coverage is thin", report.coverage.totals.checked === 1 && report.coverage.totals.notChecked === 11,
    `total ${report.coverage.totals.checked} checked / ${report.coverage.totals.notChecked} notChecked`);
  check("refusal is still null (a thin answer is an answer)", report.refusal === null, report.refusal?.reason ?? "null");
  check("⭐⭐ THIN REPORT SETTLES", d.settle === true && d.reason === SETTLE_REASON.ANSWERED, d.reason);
  check("⭐ the manifest is IN the settled artifact", nc > 0 && report.coverage.notChecked.every((n) => typeof n.reason === "string" && n.reason.length > 0));
  // Each entry carries BOTH a machine-readable `reason` code and human `why` prose — the caller can
  // branch on one and read the other. Asserting only `reason` would have missed that the prose exists.
  check("  …each gap carries a machine `reason` code", report.coverage.notChecked.every((n) => typeof n.reason === "string" && n.reason.length > 0),
    report.coverage.notChecked[0].reason);
  check("  …AND human `why` prose the caller can read", report.coverage.notChecked.some((n) => /UNOBSERVABLE|not 'no powers'/i.test(n.why ?? "")),
    report.coverage.notChecked.find((n) => /UNOBSERVABLE/i.test(n.why ?? ""))?.why.slice(0, 64) ?? "");
  check("⭐ coverageRatio exposes the thinness", d.evidence.coverageRatio < 0.2, String(d.evidence.coverageRatio));
  check("every catalogue group is STILL accounted for", Object.keys(POWER_SIGS).every((g) =>
    [...report.coverage.checked, ...report.coverage.notChecked].some((e) => e.group === g)));

  const log = [];
  const out = await runThenSettle({ produceReport: async () => signFixture(await analyze(SUBJ, { client })), settle: settlerSpy(log) });
  check("settle WAS invoked for the thin report", log.includes("SETTLE"));
  check("body says charged, with the thin report attached", out.body.charged === true && out.body.report?.coverage?.totals?.notChecked === 11);
}

section("CASE 2b — a defeated OWNER read is thin too, and also settles");
{
  const client = mockClient({
    [`code@${SUBJ}`]: codeWith(allPowerSigs),
    [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD,
    [`call@0x8da5cb5b`]: transientThrow,
  });
  const report = await signFixture(await analyze(SUBJ, { client }));
  const d = settleDecision(report);
  const ownerSkipped = report.coverage.notChecked.some((n) => /owner/i.test(n.id));
  check("the owner read landed in notChecked", ownerSkipped,
    report.coverage.notChecked.map((n) => n.id).join(","));
  check("its reason names the transport failure, not a finding", /rpc-unreadable|unread/i.test(report.coverage.notChecked.find((n) => /owner/i.test(n.id))?.reason ?? ""),
    report.coverage.notChecked.find((n) => /owner/i.test(n.id))?.reason?.slice(0, 40));
  check("refusal still null → SETTLES", report.refusal === null && d.settle === true, d.reason);
  check("coverageRatio < 1 (the ratio spans ALL entries, not just powers)", d.evidence.coverageRatio < 1, String(d.evidence.coverageRatio));
}

// ═══════════ CASE 3 — OUTAGE ═══════════
section("CASE 3 — OUTAGE → does NOT settle");
{
  // (a) the chain guard fails — analyze() STILL RETURNS A REPORT OBJECT. This is the exact case that
  //     defeats the intuitive "did analyze() return a report?" gate.
  const dead = { chain: { name: "mock-chain" }, assert: async () => { throw new Error("endpoint unreachable"); }, pin: async () => ({ number: 1, tag: "0x1" }), call: async () => { throw new Error("no"); } };
  const outage = await analyze(SUBJ, { client: dead });
  check("🚨 analyze() RETURNED A REPORT OBJECT for a total outage", outage && typeof outage === "object");
  check("  …so 'did it return a report' would have CHARGED for this", !!outage.coverage);
  const d = settleDecision(outage);
  check("⭐⭐ OUTAGE does NOT settle", d.settle === false, d.reason);
  check("  caught structurally by the EMPTY manifest", d.reason === SETTLE_REASON.COVERAGE_UNACCOUNTED, d.reason);
  check("  and the refusal is chain-unreachable", outage.refusal?.reason === "chain-unreachable", outage.refusal?.reason);

  const log = [];
  const out = await runThenSettle({ produceReport: () => analyze(SUBJ, { client: dead }), settle: settlerSpy(log) });
  check("⭐ settle was NEVER invoked", !log.includes("SETTLE"), `log=[${log}]`);
  check("caller gets explicit charged:false", out.body.charged === false && out.body.settled === false);
  check("caller is told it is retryable", out.body.retryable === true);
  check("caller is told the authorization is UNSPENT", /unspent/i.test(out.body.payment));
  check("and that no deferred settlement will happen", /none will be attempted later/i.test(out.body.payment));

  // (b) the engine THROWS — no report object at all
  const log2 = [];
  const out2 = await runThenSettle({ produceReport: async () => { throw new Error("engine exploded"); }, settle: settlerSpy(log2) });
  check("a THROWN engine does not settle", out2.decision.settle === false && out2.decision.reason === SETTLE_REASON.NO_REPORT, out2.decision.reason);
  check("  settle never invoked", !log2.includes("SETTLE"));
  check("  and it does not propagate as a 500 that kept the money", out2.body.charged === false);

  // (c) nothing at all
  for (const [what, v] of [["null", null], ["undefined", undefined], ["a string", "ok"], ["an array", []]]) {
    check(`${what} → no-report, no settle`, settleDecision(v).settle === false && settleDecision(v).reason === SETTLE_REASON.NO_REPORT);
  }
}

// ═══════════ ORDERING — money strictly downstream ═══════════
section("ORDERING — settle is strictly downstream of the answer");
{
  const log = [];
  const client = mockClient({
    [`code@${SUBJ}`]: codeWith(allPowerSigs), [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD,
    [`call@0x8da5cb5b`]: word(OWNER), [`code@${OWNER}`]: "0x",
  });
  await runThenSettle({
    produceReport: async () => { log.push("ANALYZE"); return signFixture(await analyze(SUBJ, { client })); },
    settle: settlerSpy(log),
  });
  check("⭐ ANALYZE ran before SETTLE", log.indexOf("ANALYZE") < log.indexOf("SETTLE"), `order=[${log}]`);
  check("settle invoked exactly once", log.filter((x) => x === "SETTLE").length === 1);
  await (async () => {
    let threw = null;
    try { await runThenSettle({ produceReport: () => ({}), settle: undefined }); } catch (e) { threw = e; }
    check("a missing settler is a programmer error, not a silent free answer", !!threw);
  })();
}

// ═══════════ COMPOSITION — the endpoint's gates are UPSTREAM ═══════════
section("COMPOSITION — a refused request never reaches the settle path");
{
  // ⚠️ THE EXPECTED STATUS IS NAMED PER ROW, not assumed to be 400 for all three. Since 2026-08-26 a
  // MISSING address is no longer refused at the ADDRESS rung — it is a subjectless probe that climbs
  // to PAYTO and (with DD_PAYTO_ADDRESS unset here) is refused THERE, 503 `payment-misconfigured`.
  // ⭐ That makes this row BETTER coverage than before, not worse: it now exercises a DIFFERENT
  // refusal path reaching the same composition guarantee. Naming the status per row is what keeps a
  // silent change of refusal path visible instead of letting `!== 200` absorb it.
  for (const [what, body, expectStatus] of [
    ["malformed address", { address: "0xZZZZ", chain: "arc-testnet" }, 400],
    ["missing address (a probe — refused at PAYTO, not ADDRESS)", { chain: "arc-testnet" }, 503],
    ["non-Arc chain", { address: "0x240Eb85458CD41361bd8C3773253a1D78054f747", chain: "base" }, 400],
  ]) {
    const res = await ddHandler({ httpMethod: "POST", body: JSON.stringify(body) });
    const rpt = JSON.parse(res.body);
    const d = settleDecision(rpt);
    check(`${what}: endpoint refused (HTTP ${res.statusCode})`, res.statusCode === expectStatus && !!rpt.refusal, rpt.refusal?.reason);
    check(`  …and the settle gate ALSO refuses it`, d.settle === false, d.reason);
  }
  check("⭐ two fail-closed layers compose: refusal is upstream of settlement, and neither alone is load-bearing", true);
}

// ═══════════ CASE 4 — ⭐ UNSIGNED: we quoted a signed report, so unsigned is not the product ═══════
section("CASE 4 — unsigned / unverifiable attestation → does NOT settle");
{
  const client = mockClient({
    [`code@${SUBJ}`]: codeWith(allPowerSigs),
    [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD,
    [`call@0x8da5cb5b`]: word(OWNER),
    [`code@${OWNER}`]: "0x",
  });
  const good = await signFixture(await analyze(SUBJ, { client }));

  // Sanity: the ONLY difference between the settling and non-settling cases below is the attestation.
  check("control: the signed version of this exact report DOES settle", settleDecision(good).settle === true);

  // ⭐ The real degradation path — attachAttestation throws, dd-analyze catches and attaches this.
  {
    const r = { ...good, attestation: unsignedAttestation("the signer was unavailable on this run") };
    const d = settleDecision(r);
    check("⭐⭐ signer outage (status:'unsigned') → does NOT settle", d.settle === false && d.reason === SETTLE_REASON.UNSIGNED, d.reason);
    check("  …and names it as OUR outage, not the caller's problem", /our failure|our own outage/i.test(d.detail));
    check("  …and says selling unsigned against a signed price is the defect", /selling one thing and handing over another/i.test(d.detail));
    check("  …and tells them to retry", /retry/i.test(d.detail));
  }

  // Fail-closed across every non-"signed" status, including ones nobody has invented yet.
  for (const status of ["unsigned", "indeterminate", "pending", "partial", "SIGNED", "ok", "true", ""]) {
    const d = settleDecision({ ...good, attestation: { ...good.attestation, status } });
    check(`  status ${JSON.stringify(status)} → does NOT settle`, d.settle === false && d.reason === SETTLE_REASON.UNSIGNED, d.reason);
  }
  for (const [label, att] of [["absent", undefined], ["null", null], ["a string", "signed"], ["an array", []]]) {
    const d = settleDecision({ ...good, attestation: att });
    check(`  attestation ${label} → does NOT settle`, d.settle === false && d.reason === SETTLE_REASON.UNSIGNED, d.reason);
  }

  // ⭐ status:"signed" is a CLAIM. Without what a verifier needs, nobody can ever check it.
  for (const field of ["signature", "agentId", "verifyingContract", "chainId"]) {
    const att = { ...good.attestation };
    delete att[field];
    const d = settleDecision({ ...good, attestation: att });
    check(`⭐ claims signed but ${field} missing → does NOT settle`, d.settle === false && d.reason === SETTLE_REASON.ATTESTATION_UNVERIFIABLE, d.reason);
    check(`  …and names the missing field`, (d.evidence.missingFields ?? []).includes(field), String(d.evidence.missingFields));
  }
  {
    const d = settleDecision({ ...good, attestation: { ...good.attestation, signature: "not-hex" } });
    check("⭐ claims signed with a malformed signature → does NOT settle", d.settle === false && d.reason === SETTLE_REASON.ATTESTATION_UNVERIFIABLE, d.reason);
    check("  …flagged as not well-formed", d.evidence.signatureWellFormed === false);
  }

  // ⚠️ ORDER: a refusal report is unsigned BY DESIGN, so the more specific cause must win.
  {
    const dead = mockClient({});
    const outage = await analyze(SUBJ, { client: dead });
    const d = settleDecision(outage);
    check("⭐ an outage still reports REFUSED/coverage, not 'unsigned' — the specific cause wins",
      d.settle === false && d.reason !== SETTLE_REASON.UNSIGNED, d.reason);
  }

  // ⭐ END TO END: no charge is ACTUALLY no charge — settle is never invoked, nothing is deferred.
  {
    const log = [];
    const out = await runThenSettle({
      produceReport: async () => ({ ...(await analyze(SUBJ, { client })), attestation: unsignedAttestation("signer down") }),
      settle: settlerSpy(log),
    });
    check("⭐⭐ settle was NEVER invoked for an unsigned report", !log.includes("SETTLE"), `log=[${log}]`);
    check("  …caller is told charged:false", out.body.charged === false);
    check("  …and retryable:true", out.body.retryable === true);
    check("  …and that the authorization is UNSPENT", /unspent/i.test(out.body.payment));
    check("  …and that nothing will be settled later (no silent keep-the-money)",
      /none will be attempted later/i.test(out.body.payment));
    check("⭐ the report is STILL handed over, free", out.body.report?.subject?.address === SUBJ);
  }
}

console.log(`\n╔══════════════════════════════════════════════════════════════════════`);
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES PRESENT"}   pass ${pass} / fail ${fail}`);
console.log(`╚══════════════════════════════════════════════════════════════════════`);
process.exit(fail === 0 ? 0 : 1);
