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
  check("⭐⭐ the pinned order: exposure → retrieve → discovery → health → method → body → address → chain → payTo",
    LADDER.join(",") === "exposure,retrieve,discovery,health,method,body,address,chain,payTo", LADDER.join(","));
  check("⭐ retrieve comes BEFORE health (delivery of an old report is not production of a new one)",
    LADDER.indexOf(RUNG.RETRIEVE) < LADDER.indexOf(RUNG.HEALTH));
  // 🚨 THE 2026-08-16 PROD DEFECT, PINNED. The page is documentation, not an answer about a subject.
  // Behind health it was unreachable during every post-deploy refusal window — exactly when a human
  // looks. Same reasoning and same placement as RETRIEVE.
  check("🚨 discovery comes BEFORE health (documentation is not an answer about a subject)",
    LADDER.indexOf(RUNG.DISCOVERY) < LADDER.indexOf(RUNG.HEALTH));
  check("⚠️ …but AFTER retrieve, so a paid redemption still wins over a marketing page",
    LADDER.indexOf(RUNG.RETRIEVE) < LADDER.indexOf(RUNG.DISCOVERY));
  check("⭐ health comes BEFORE every request-shape rung (unverified ⇒ uniformly unavailable)",
    LADDER.indexOf(RUNG.HEALTH) < LADDER.indexOf(RUNG.METHOD));
  check("⚠️ the JSON method refusal stays BEHIND health — only the HTML page moved",
    LADDER.indexOf(RUNG.METHOD) > LADDER.indexOf(RUNG.HEALTH));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("A2 🚨 THE PAGE RENDERS DURING AN OUTAGE — AND SAYS SO");
{
  const { SELF_CLEARING_HEALTH } = await import("../../netlify/functions/_dd-rungs.mjs");
  const { discoveryPage } = await import("../../netlify/functions/_dd-discovery-page.mjs");
  const { HEALTH_REASON } = await import("../../shared/dd-canary/health.mjs");

  const page = (health) => discoveryPage({ method: "GET", health });
  const curlAt = (h) => page(h).indexOf("curl -sS");
  const bannerAt = (h) => page(h).indexOf('class="down"');

  // ⭐ SERVING: no banner at all. A permanent scare line would be its own dishonesty.
  const up = page({ serving: true });
  check("⭐ health OK → the page carries NO outage banner", !up.includes('class="down"'));
  check("  …and still carries the terms it must never soften",
    /coverage manifest, not a clean bill/i.test(up) && /does not scale with coverage/i.test(up));

  // 🚨 THE CORE CLAIM: refusing → the page still renders AND names it.
  const noRec = { serving: false, reason: HEALTH_REASON.NO_RECORD, detail: "no artifact yet", selfClearing: true };
  const p1 = page(noRec);
  check("🚨🚨 health REFUSING → the page still renders (it is documentation, not an answer)",
    p1.includes("<h1>") && p1.includes("curl -sS"));
  check("🚨🚨 …and says the service is REFUSING right now", /REFUSING right now/.test(p1));
  check("🚨 …and warns the command below will 503, so a reader does not blame their own call",
    /will return <code>503<\/code>/.test(p1) && /Nothing is wrong with your call/.test(p1));
  check("⭐⭐ …and the banner is ABOVE the curl, not below it (a caveat under the command is unread)",
    bannerAt(noRec) > 0 && bannerAt(noRec) < curlAt(noRec), `banner@${bannerAt(noRec)} curl@${curlAt(noRec)}`);
  check("⭐ …and names the reason", new RegExp(HEALTH_REASON.NO_RECORD).test(p1));
  check("⭐ …and says it clears by itself within minutes", /clears by itself, usually within minutes/.test(p1));

  // 🚨🚨 THE REFINEMENT THAT MATTERS: not every refusal self-clears.
  const broken = { serving: false, reason: HEALTH_REASON.NOT_PASSING, detail: "a fixture regressed", selfClearing: false };
  const p2 = page(broken);
  check("🚨🚨 a NOT-PASSING detector must NOT be told to just wait — that would be a fresh lie",
    /will NOT clear by waiting/.test(p2) && !/clears by itself/.test(p2));
  check("⭐ …and it is the louder banner", /🚨/.test(p2));

  // ⭐ COULD-NOT-TELL IS ITS OWN BANNER — never borrows either wording.
  const unknown = { serving: null, reason: "disclosure-unreadable", detail: "blobs down", selfClearing: null };
  const p3 = page(unknown);
  check("⭐⭐ unknown health renders an EXPLICIT unknown, not silence and not reassurance",
    /could not determine whether this service is currently answering/i.test(p3));
  check("  …and does not claim it clears by itself", !/clears by itself/.test(p3));
  check("  …and does not claim it will never clear", !/will NOT clear by waiting/.test(p3));

  // ⚠️ NO CRON PERIOD ANYWHERE — netlify.toml is unreadable from here and a hardcoded number would
  // be a second source of truth that quietly goes wrong the day the schedule changes.
  for (const h of [noRec, broken, unknown])
    check("⚠️ the banner quotes NO cron period (it would be a duplicate source of truth)",
      !/\b(10|ten|five|5)\s*(-|\s)?minute/i.test(page(h)));

  // ⭐ THE SELF-CLEARING SET IS CLOSED AND CONSERVATIVE.
  check("⭐⭐ only no-record and stale are self-clearing",
    [...SELF_CLEARING_HEALTH].sort().join(",") === [HEALTH_REASON.NO_RECORD, HEALTH_REASON.STALE].sort().join(","),
    SELF_CLEARING_HEALTH.join(","));
  for (const r of [HEALTH_REASON.NOT_PASSING, HEALTH_REASON.VERSION_MISMATCH, HEALTH_REASON.MALFORMED,
                   HEALTH_REASON.UNREADABLE, HEALTH_REASON.BUILD_UNRESOLVED])
    check(`🚨 "${r}" is NOT self-clearing (waiting does not fix a broken detector)`,
      !SELF_CLEARING_HEALTH.includes(r));
  check("⭐ a health reason invented later is NOT self-clearing by default",
    !SELF_CLEARING_HEALTH.includes("some-future-reason"));

  // ⚠️ ESCAPED. health.detail is server-derived today, but the banner must not be an injection point.
  const evil = page({ serving: false, reason: "x", detail: "<script>alert(1)</script>", selfClearing: true });
  check("⚠️ the banner escapes its detail — no markup injection through health text",
    !/<script>/.test(evil) && /&lt;script&gt;/.test(evil));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("A3 ⭐ healthDisclosure — never gates, never throws, never defaults to healthy");
{
  const { healthDisclosure } = await import("../../netlify/functions/_dd-rungs.mjs");
  // No blobs bound in-process ⇒ the read fails. It must resolve to the UNKNOWN tri-state.
  const d = await healthDisclosure({ headers: {} });
  check("⭐⭐ a failed health read resolves, it does not throw (docs must survive an outage)",
    d && typeof d === "object");
  check("🚨🚨 …and NEVER to serving:true — could-not-tell is its own outcome",
    d.serving !== true, `serving=${JSON.stringify(d.serving)}`);
  check("⭐ …and selfClearing is null, not a convenient false-or-true",
    d.serving !== false ? d.selfClearing === null : typeof d.selfClearing === "boolean");
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
  // ⚠️ ASSERT THE PROPERTY, NOT THE COUNT. An earlier version pinned `length === 3` and went red the
  // moment a legitimate fourth skip was added — a test that fails on correct change teaches people
  // to edit the test, which is how a real guarantee gets weakened by a routine diff.
  check("⭐⭐ the in-app route's ACTUAL skip list parses, validates, and is health-free",
    declared.length > 0 && declared.every(Boolean) && !!assertSkipSet(declared) &&
    !declared.includes(RUNG.HEALTH), declared.join(","));
  check("🚨 …and every UNSKIPPABLE rung is absent from it",
    UNSKIPPABLE.every((r) => !declared.includes(r)));
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

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("J 🚨 THE CAPTURE'S OWN FAILURE PATHS — exercised by CALLING, against a fixture server");
{
  // ⚠️ THE BRANCHES THAT MATTER FIRE ONLY WHEN SOMETHING IS ALREADY WRONG, which is the worst
  // moment to run them for the first time. The live dry-run only ever exercises "no window"; the
  // regression and could-not-measure paths would otherwise ship untried. Same reasoning as the
  // deploy-liveness suite: two of four branches were unreachable in the live run.
  const http = await import("node:http");
  const { execFile } = await import("node:child_process");
  const { mkdtempSync } = await import("node:fs");
  const os = await import("node:os"), path = await import("node:path");

  const PAGE = (banner) => `<!doctype html><html><body>
${banner ? `<div class="down"><b>⚠️ This service is REFUSING right now — the command below will return <code>503</code></b>
Reason: <code>no-record</code>. This clears by itself, usually within minutes, when the scheduled self-check next runs.</div>` : ""}
<pre>curl -sS -X POST https://example/api/dd-analyze</pre></body></html>`;

  const serve = (handler) => new Promise((res) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => res({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
  const run = (url) => new Promise((res) => {
    // ⭐ A FRESH CWD PER CASE, so each run writes its own ledger and cannot read a prior entry's
    // ddTree — otherwise case order would silently change the discriminator branch taken.
    const cwd = mkdtempSync(path.join(os.tmpdir(), "cap-"));
    execFile(process.execPath,
      [path.resolve("scripts/dd/capture-refusal-window.mjs"), "--url", url, "--seconds", "6"],
      { cwd, timeout: 45000 },
      (err, stdout) => res({ code: err?.code ?? 0, out: stdout }));
  });

  // ✅ banner present → observed, exit 0
  {
    const { s, url } = await serve((_q, r) => { r.writeHead(405, { "content-type": "text/html" }); r.end(PAGE(true)); });
    const r = await run(url); s.close();
    check("✅ banner during a refusal → OBSERVED, exit 0", r.code === 0 && /WINDOW OBSERVED/.test(r.out), `exit ${r.code}`);
    check("  …and it names the variant it saw", /self-clearing/.test(r.out));
    check("  …and confirms the banner sits above the curl", /banner above curl : true/.test(r.out));
  }

  // 🚨 the original defect returning: html asked for, json served
  {
    const { s, url } = await serve((_q, r) => { r.writeHead(503, { "content-type": "application/json" }); r.end('{"refusal":{"reason":"service-unverified"}}'); });
    const r = await run(url); s.close();
    check("🚨🚨 an html GET answered with JSON → REGRESSION, exit 1", r.code === 1 && /REGRESSION/.test(r.out), `exit ${r.code}`);
    check("  …and it names the cause — discovery fell back behind health",
      /no longer ahead of the health gate/.test(r.out));
  }

  // ⚠️ banner rendered but BELOW the curl — a caveat readers never reach
  {
    const bad = `<!doctype html><html><body><pre>curl -sS -X POST x</pre>
<div class="down">⚠️ This service is REFUSING right now. This clears by itself, usually within minutes.</div></body></html>`;
    const { s, url } = await serve((_q, r) => { r.writeHead(405, { "content-type": "text/html" }); r.end(bad); });
    const r = await run(url); s.close();
    check("⚠️ a banner placed BELOW the curl FAILS the capture, exit 1",
      r.code === 1 && /malformed/.test(r.out), `exit ${r.code}`);
  }

  // ⚠️ nothing answering → could-not-measure, exit 2, NOT folded into "no window"
  {
    const r = await run("http://127.0.0.1:1");
    check("⚠️ nothing reachable → COULD NOT MEASURE, exit 2 (never 'saw nothing')",
      r.code === 2 && /COULD NOT MEASURE/.test(r.out), `exit ${r.code}`);
    check("⭐ …and it says why that is not the same as a clean run",
      /cannot see is not/.test(r.out));
  }

  // ⚠️ serving, no banner → NOT a pass, and it must say so in those words
  {
    const { s, url } = await serve((_q, r) => { r.writeHead(405, { "content-type": "text/html" }); r.end(PAGE(false)); });
    const r = await run(url); s.close();
    check("⚠️⚠️ no window → exit 0 but explicitly NOT reported as a pass",
      r.code === 0 && /NO WINDOW OBSERVED — and this is NOT a pass/.test(r.out), `exit ${r.code}`);
    check("⭐ …and it says the banner stays proven only in-process until a DD change ships",
      /proven only in-process/.test(r.out));
  }
}

console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
