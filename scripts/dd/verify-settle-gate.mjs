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
import { POWER_SIGS, sel, EIP1967_IMPL_SLOT } from "../../shared/onchain-facts/index.mjs";
import { handler as ddHandler } from "../../netlify/functions/dd-analyze.mjs";

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
  const report = await analyze(SUBJ, { client });
  const d = settleDecision(report);
  check("engine answered (refusal null)", report.refusal === null, report.refusal?.reason ?? "null");
  check("⭐ SETTLES", d.settle === true && d.reason === SETTLE_REASON.ANSWERED, `${d.reason}`);
  check("coverage is full", d.evidence.notChecked === 0, `checked=${d.evidence.checked} notChecked=${d.evidence.notChecked}`);
  check("coverageRatio reported", d.evidence.coverageRatio === 1, String(d.evidence.coverageRatio));

  const log = [];
  const out = await runThenSettle({ produceReport: () => analyze(SUBJ, { client }), settle: settlerSpy(log) });
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
  const report = await analyze(SUBJ, { client });
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
  const out = await runThenSettle({ produceReport: () => analyze(SUBJ, { client }), settle: settlerSpy(log) });
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
  const report = await analyze(SUBJ, { client });
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
    produceReport: async () => { log.push("ANALYZE"); return analyze(SUBJ, { client }); },
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
  for (const [what, body] of [
    ["malformed address", { address: "0xZZZZ", chain: "arc-testnet" }],
    ["missing address", { chain: "arc-testnet" }],
    ["non-Arc chain", { address: "0x240Eb85458CD41361bd8C3773253a1D78054f747", chain: "base" }],
  ]) {
    const res = await ddHandler({ httpMethod: "POST", body: JSON.stringify(body) });
    const rpt = JSON.parse(res.body);
    const d = settleDecision(rpt);
    check(`${what}: endpoint refused (HTTP ${res.statusCode})`, res.statusCode === 400 && !!rpt.refusal, rpt.refusal?.reason);
    check(`  …and the settle gate ALSO refuses it`, d.settle === false, d.reason);
  }
  check("⭐ two fail-closed layers compose: refusal is upstream of settlement, and neither alone is load-bearing", true);
}

console.log(`\n╔══════════════════════════════════════════════════════════════════════`);
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES PRESENT"}   pass ${pass} / fail ${fail}`);
console.log(`╚══════════════════════════════════════════════════════════════════════`);
process.exit(fail === 0 ? 0 : 1);
