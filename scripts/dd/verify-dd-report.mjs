// verify-dd-report.mjs — the shared rung ladder, the in-app report route, and the warn supersession.
//
// ═══ WHAT THIS SUITE IS ACTUALLY DEFENDING ════════════════════════════════════════════════════
// Three claims, none of which is safe to assert in prose:
//
//   1. ⭐⭐ THE TWO ENTRY POINTS CLIMB ONE LADDER. A buyer's report and the in-app card's report
//      must be the same artifact. The failure mode is invisible: both keep returning well-formed
//      reports while one quietly stops checking something.
//   2. 🚨 HEALTH IS UNSKIPPABLE, AND THAT IS ENFORCED BY A THROW. Tested by CALLING assertSkipSet,
//      not by grepping for the constant — [assert-on-rendered-output-not-source-regex].
//   3. ⭐ THE WARN SUPERSESSION ANNOTATES AND DELETES NOTHING, and therefore does not move
//      `disclosureDigest`. A moved digest invalidates acks; a DELETED warn silently removes an ack
//      REQUIREMENT, which is worse. Both are asserted by calling the real functions.
//
// Plus the measurement the design asked for: the REAL per-render RPC load, counted rather than
// estimated, because "no cache until measured" is only a decision if somebody measures.
//
//   node --experimental-test-module-mocks scripts/dd/verify-dd-report.mjs
//
// Zero network, zero money.

import { mock } from "node:test";
import { mockBuildStamp } from "./_test-stamp.mjs";
mockBuildStamp();

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 66 - t.length))}`);
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const {
  RUNG, LADDER, UNSKIPPABLE, assertSkipSet, runLadder, makeProduceReport, isSystemicReadFailure,
} = await import("../../netlify/functions/_dd-rungs.mjs");

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("A ⭐⭐ ONE LADDER — the order is a single array, and skips are a closed set");
{
  check("the ladder is frozen (an entry point cannot mutate the shared order)", Object.isFrozen(LADDER));
  check("every ladder entry is a declared RUNG name",
    LADDER.every((r) => Object.values(RUNG).includes(r)), LADDER.join(" → "));
  check("every declared RUNG appears in the ladder exactly once",
    Object.values(RUNG).every((r) => LADDER.filter((x) => x === r).length === 1));

  // ⭐ THE ORDER ITSELF IS THE PRODUCT. Pinned so a reorder is a deliberate, reviewed act rather
  // than a diff nobody reads. Retrieve AHEAD of health is the subtle one: an already-paid report
  // must not be stranded by a canary blip that postdates its production.
  check("⭐⭐ the pinned order: exposure → retrieve → health → method → body → address → chain → payTo",
    LADDER.join(",") === "exposure,retrieve,health,method,body,address,chain,payTo", LADDER.join(","));
  check("⭐ retrieve comes BEFORE health (delivery of an old report is not production of a new one)",
    LADDER.indexOf(RUNG.RETRIEVE) < LADDER.indexOf(RUNG.HEALTH));
  check("⭐ health comes BEFORE every request-shape rung (unverified ⇒ uniformly unavailable)",
    LADDER.indexOf(RUNG.HEALTH) < LADDER.indexOf(RUNG.METHOD));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("B 🚨 UNSKIPPABLE IS A THROW, NOT A COMMENT — tested by calling");
{
  check("a valid skip set is accepted", assertSkipSet([RUNG.EXPOSURE, RUNG.RETRIEVE, RUNG.PAYTO]).size === 3);
  check("an empty skip set is accepted (the paid path skips nothing)", assertSkipSet([]).size === 0);

  // ⚠️ A TYPO MUST NOT BE SILENTLY DROPPED. A skip name that is quietly ignored is a lie in both
  // directions: either a rung the author meant to skip still runs, or — the dangerous mirror — a
  // reader believes a skip happened that never did.
  for (const bad of ["helth", "HEALTH", "expsure", "", "payto", null, 7]) {
    const e = await threw(() => assertSkipSet([bad]));
    check(`⭐ unknown skip ${JSON.stringify(bad)} THROWS (never silently ignored)`,
      !!e && /unknown rung/.test(e.message));
  }
  const notArray = await threw(() => assertSkipSet("health"));
  check("a non-array skip THROWS rather than being coerced", !!notArray && /must be an array/.test(notArray.message));

  // 🚨 THE CORE CLAIM. No entry point — including one written later — can opt out of the gate that
  // stops an unverified detector from answering questions about someone's money.
  for (const r of UNSKIPPABLE) {
    const e = await threw(() => assertSkipSet([r]));
    check(`🚨 rung "${r}" is UNSKIPPABLE — attempting it throws`, !!e && /UNSKIPPABLE/.test(e.message));
  }
  check("⭐ health is on the unskippable list", UNSKIPPABLE.includes(RUNG.HEALTH));
  check("⭐ …as are all four request-shape rungs (skipping them only moves the failure into a 500)",
    [RUNG.METHOD, RUNG.BODY, RUNG.ADDRESS, RUNG.CHAIN].every((r) => UNSKIPPABLE.includes(r)));

  // ⭐ AND THE REAL IN-APP SKIP SET IS THE ONE EXERCISED, not a hand-written stand-in — otherwise
  // this whole section proves a property of a literal in a test file.
  const routeSrc = (await import("node:fs")).readFileSync("netlify/functions/agent-dd-report.mjs", "utf8");
  const declared = [...(routeSrc.match(/skip:\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/RUNG\.(\w+)/g)].map((m) => RUNG[m[1]]);
  check("⭐⭐ the in-app route's ACTUAL skip list is valid and health-free",
    declared.length === 3 && !!assertSkipSet(declared) && !declared.includes(RUNG.HEALTH), declared.join(","));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("C ⭐ THE IN-APP ROUTE — auth replaces payment, and nothing else changes");
{
  const { handler } = await import("../../netlify/functions/agent-dd-report.mjs");
  const call = async (ev) => {
    const res = await handler({ httpMethod: "POST", headers: {}, body: "{}", ...ev });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };

  // ⚠️ AUTH IS AHEAD OF THE LADDER, so an anonymous caller never even reaches the health read.
  const anon = await call({});
  check("⭐⭐ no session → 401, before any analysis", anon.status === 401 && /Authentication required/.test(anon.body.error));

  // ⭐ EXPOSURE IS SKIPPED — with the public flag unset (the safe default), the PAID route refuses
  // and this one must not, or shipping the service disabled would silently delete the in-app
  // deposit disclosure. Proven by contrast against the real dd-analyze handler.
  delete process.env.DD_PUBLIC_ENABLED;
  const { handler: paid } = await import("../../netlify/functions/dd-analyze.mjs");
  const paidRes = JSON.parse((await paid({ httpMethod: "POST", headers: {},
    body: JSON.stringify({ address: "0x240Eb85458CD41361bd8C3773253a1D78054f747", chain: "arc-testnet" }) })).body);
  check("⭐ with DD_PUBLIC_ENABLED unset the PAID route refuses on exposure",
    paidRes.refusal?.reason === "service-not-enabled", paidRes.refusal?.reason);
  // ⚠️ The in-app route's behaviour with the flag unset is asserted in section D, where a session
  // is mocked in — here it would stop at 401 and prove nothing about the exposure rung.
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("D ⭐⭐ HEALTH IS ENFORCED ON THE IN-APP PATH (the card gates a deposit)");
{
  // A session that verifies, so the test reaches the ladder rather than stopping at 401.
  mock.module("../../netlify/functions/_auth.mjs", {
    namedExports: { requireSession: () => ({ address: "0xabc", method: "test" }), internalToken: () => "t" },
  });
  // A health record the gate must REFUSE: readable, but not a passing artifact for this build.
  mock.module("../../netlify/functions/_dd-health.mjs", {
    namedExports: { DD_HEALTH_STORE: "x", readHealth: async () => ({ record: null, readable: true }) },
  });
  const { handler } = await import("../../netlify/functions/agent-dd-report.mjs?health-refuse");
  const res = await handler({ httpMethod: "POST", headers: {},
    body: JSON.stringify({ address: "0x240Eb85458CD41361bd8C3773253a1D78054f747", chain: "arc-testnet" }) });
  const body = JSON.parse(res.body);
  check("🚨 a session-authed caller is STILL refused when the detector is not known good",
    res.statusCode === 503 && body.refusal?.reason === "service-unverified", `${res.statusCode}/${body.refusal?.reason}`);
  check("  …and it is a REPORT, not an error envelope",
    ["subject", "coverage", "refusal", "attestation"].every((k) => k in body));
  check("  …with nothing checked (the gate is before the analysis)", body.coverage.totals.checked === 0);
  check("⭐ …and it is INDETERMINATE, never a clean bill", /INDETERMINATE/.test(body.coverage.summary));
  mock.restoreAll();
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("E ⭐⭐ SAME PRODUCER — the card evaluates what a buyer could verify");
{
  const fs = await import("node:fs");
  const route = fs.readFileSync("netlify/functions/agent-dd-report.mjs", "utf8");
  const paid = fs.readFileSync("netlify/functions/dd-analyze.mjs", "utf8");

  check("⭐⭐ both entry points obtain the report from the SHARED makeProduceReport",
    /makeProduceReport\(\{ addr, chain, correlationId \}\)/.test(route) &&
    /makeProduceReport\(\{ addr, chain, correlationId \}\)/.test(paid));
  check("⭐⭐ neither entry point calls analyze() itself",
    !/\banalyze\(addr/.test(route) && !/\banalyze\(addr/.test(paid));
  check("⭐⭐ neither builds its own quorum client",
    !/quorumClient\(/.test(route) && !/quorumClient\(/.test(paid));

  // ⭐ NO "LITE" REPORT. A projection here is the first step toward two schemas and a card whose
  // verdict is derived from fields the buyer's copy does not contain.
  check("⭐⭐ the in-app route returns the FULL report object, not a projection",
    /\breport,\n/.test(route) && !/report:\s*\{/.test(route));
  check("⭐ …and the policy verdict is marked display-only in the PAYLOAD, not only in a comment",
    /authority: "display-only"/.test(route) && /MUST NOT gate anything/.test(route));

  // ⚠️ NO CACHE ON THIS CUT — asserted, because "we decided not to cache" is otherwise unfalsifiable.
  // ⚠️ BOTH COMMENT FORMS STRIPPED FIRST, and that is a bug this check HAD on its first run: the
  // producer's JSDoc *argues about caching at length* ("NO CACHE", "worth knowing before it is worth
  // hiding"), so grepping the raw text conflated "the code MENTIONS a cache" with "the code HAS one".
  // The same conflation verify-quorum-billing already recorded for the billing grep.
  const rungs = fs.readFileSync("netlify/functions/_dd-rungs.mjs", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
  check("⭐ the shared producer caches nothing (no store, no memo, on this cut)",
    !/getStore\(/.test(rungs) && !/\bcache\b/i.test(rungs) && !/memo/i.test(rungs));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("F ⭐ THE MEASURED RPC LOAD — counted, not estimated");
{
  const { analyze } = await import("../../shared/onchain-analyze/index.mjs");
  const { quorumClient } = await import("../../shared/onchain-analyze/quorum.mjs");
  const { ARC_QUORUM_ENDPOINTS } = await import("../../shared/onchain-analyze/endpoints.mjs");

  // A counting transport per endpoint. Answers are deliberately boring — the point is the COUNT,
  // and a subject with more code would only ever read the same slots.
  const wire = [];
  const fake = (rpc) => {
    const n = { rpc, calls: 0 };
    wire.push(n);
    return {
      chain: { name: "arc-testnet", rpc },
      assert: async () => { n.calls++; return 5042002; },
      pin: async () => { n.calls++; return { number: 1000, tag: "0x3e8" }; },
      call: async () => { n.calls++; return "0x"; },
    };
  };
  const client = quorumClient(ARC_QUORUM_ENDPOINTS.map(fake));
  await analyze("0x240Eb85458CD41361bd8C3773253a1D78054f747", { client });

  const total = wire.reduce((s, w) => s + w.calls, 0);
  const perEndpoint = wire.map((w) => w.calls);
  console.log(`\n     📊 MEASURED: ${total} JSON-RPC requests per render across ${wire.length} endpoints ` +
              `(${perEndpoint.join(" + ")}), quorum fan-out included.`);
  console.log(`     📊 This is the REAL cost of one in-app card render with no cache.`);
  check("⭐ the load is measured and non-zero (a zero here would mean the client was never used)", total > 0);
  check("⭐⭐ the fan-out is real — every endpoint is actually called, not just the first",
    perEndpoint.every((c) => c > 0), perEndpoint.join(","));
  // ⚠️ A CEILING, NOT AN EXPECTATION. If a change makes a card render cost dramatically more, that
  // is worth failing over on a chain whose public RPC has already throttled this repo.
  check("⭐ per-render load stays under the 40-request ceiling", total < 40, `${total} requests`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("G ⭐⭐ THE WARN SUPERSESSION — annotated, RETAINED, and the digest does not move");
{
  const { WARN_SUPERSESSION, disclosureDigest, ackTokenFor } = await import("../../netlify/functions/_vault.mjs");

  const POWER = ["emergency-withdraw", "fees-settable", "upgradeable"];
  const OWNER = ["owner-is-eoa", "owner-is-unidentified-contract", "owner-unreadable", "owner-not-exposed"];

  check("⭐ the power-scan warns are marked superseded", POWER.every((c) => !!WARN_SUPERSESSION[c]));
  check("⭐ the owner-identity warns are marked superseded", OWNER.every((c) => !!WARN_SUPERSESSION[c]));
  check("⭐⭐ `performance-fee` is NOT marked — it derives from a fee VALUE the report never reads, " +
        "so it has no replacement and must not be scheduled for deletion",
    !("performance-fee" in WARN_SUPERSESSION));
  check("⭐⭐ every marked warn carries a DELETION CONDITION at the code, not in a commit message",
    Object.values(WARN_SUPERSESSION).every((s) => typeof s.deleteWhen === "string" && /gateDeposit reads/.test(s.deleteWhen)));
  check("  …and names what supersedes it", Object.values(WARN_SUPERSESSION).every((s) => !!s.supersededBy));
  check("⭐ the owner warns point at holder/holderKind",
    OWNER.every((c) => /holder/i.test(WARN_SUPERSESSION[c].supersededBy)));
  check("⭐ the power warns point at the report's power catalogue",
    POWER.every((c) => /report\.powers/.test(WARN_SUPERSESSION[c].supersededBy)));

  // 🚨🚨 THE LOAD-BEARING ASSERTION. Annotation must not touch the digest. `disclosureDigest` reads
  // `w.code` and nothing else — so adding fields leaves every outstanding ack valid. Proven by
  // CALLING it on an annotated and an un-annotated inspection.
  const insp = (warns) => ({
    address: "0x240eb85458cd41361bd8c3773253a1d78054f747",
    verdict: { level: "WARN", blocks: [], warns },
    withdraw: { withdrawFeeBps: 25 },
    ownerPowers: { settableFees: { currentBps: { deposit: 0 } } },
  });
  const bare = insp([{ code: "owner-is-eoa", detail: "d" }, { code: "upgradeable", detail: "d" }]);
  const annotated = insp([
    { code: "owner-is-eoa", detail: "d", ...WARN_SUPERSESSION["owner-is-eoa"] },
    { code: "upgradeable", detail: "d", ...WARN_SUPERSESSION["upgradeable"] },
  ]);
  check("🚨🚨 the digest is BYTE-IDENTICAL with and without the supersession annotation",
    disclosureDigest(bare) === disclosureDigest(annotated), disclosureDigest(annotated));
  check("🚨 …so every outstanding ack token still matches — no acknowledgement is invalidated",
    ackTokenFor(bare) === ackTokenFor(annotated));

  // ⭐ AND THE COUNTERFACTUAL, which is the whole reason coexistence was chosen over deletion:
  // DELETING a superseded warn does move the digest — and, for a vault whose only warns were the
  // migrated ones, drops the level from WARN to OK and removes the ACK REQUIREMENT entirely.
  const deleted = insp([{ code: "owner-is-eoa", detail: "d" }]);
  check("⭐⭐ deleting a superseded warn WOULD move the digest (this is what was avoided)",
    disclosureDigest(bare) !== disclosureDigest(deleted));
  const onlyMigrated = insp([{ code: "upgradeable", detail: "d" }]);
  const nothingLeft = { ...onlyMigrated, verdict: { level: "OK", blocks: [], warns: [] } };
  const { gateDeposit } = await import("../../netlify/functions/_vault.mjs");
  check("🚨🚨 …and with the migrated warn RETAINED the gate still demands an acknowledgement",
    gateDeposit({ inspection: onlyMigrated, ackToken: undefined }).ok === false);
  check("🚨🚨 …whereas had it been DELETED the deposit would proceed with NO ack at all — " +
        "the silent consent removal this ordering exists to prevent",
    gateDeposit({ inspection: nothingLeft, ackToken: undefined }).ok === true);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("H ⚠️ THE BLOCK LADDER IS UNTOUCHED");
{
  const fs = await import("node:fs");
  const vault = fs.readFileSync("netlify/functions/_vault.mjs", "utf8");
  for (const code of ["not-a-contract", "not-erc4626", "empty-shell", "withdraw-fee-too-high",
                      "proxy-status-unreadable", "asset-mismatch"]) {
    check(`⚠️ BLOCK "${code}" still raised`, new RegExp(`code: "${code}"`).test(vault));
    check(`  …and it is NOT scheduled for deletion`, !new RegExp(`"${code}":\\s*Object\\.freeze`).test(vault));
  }
  // 🚨 not-a-contract specifically: it is what makes the three accidental safety mechanisms safe.
  const { gateDeposit } = await import("../../netlify/functions/_vault.mjs");
  const nc = { address: "0xdead", verdict: { level: "BLOCK", blocks: [{ code: "not-a-contract", detail: "no code" }], warns: [] },
               withdraw: {}, ownerPowers: {} };
  check("🚨 an ack cannot buy past not-a-contract — BLOCK outranks acknowledgement",
    gateDeposit({ inspection: nc, ackToken: "f".repeat(64) }).ok === false);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("I — the shared producer's honesty boundary still holds");
{
  const cov = (checked, notChecked) => ({ coverage: { checked, notChecked } });
  check("total instrument failure is systemic (never presented as a thin answer)",
    isSystemicReadFailure(cov([], [{ reason: "rpc-unreadable" }, { reason: "rpc-quorum-unmet" }])) === true);
  check("⭐ a DISAGREEMENT is not an instrument failure",
    isSystemicReadFailure(cov([], [{ reason: "rpc-quorum-split" }])) === false);
  check("something established ⇒ an answer", isSystemicReadFailure(cov([{ id: "a" }], [{ reason: "rpc-unreadable" }])) === false);
}

console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
