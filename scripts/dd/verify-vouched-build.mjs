#!/usr/bin/env node
// verify-vouched-build.mjs — the endpoint that gives ddTree its first PRODUCTION READ.
//
//   node scripts/dd/verify-vouched-build.mjs   (also: npm run test:vouchedbuild)
//
// ═══ ⭐⭐ WHAT THIS SUITE IS ACTUALLY DEFENDING ════════════════════════════════════════════════
// Two properties, and they pull in opposite directions:
//
//   1. THE ANSWER MUST COME FROM THE HEALTH RECORD, NOT THE BUILD STAMP. If the endpoint ever
//      derives its value from the stamp it becomes option (a) wearing option (b)'s name — a second
//      reading of ONE instrument, returning agreement with itself.
//   2. THE THREE OUTCOMES MUST STAY THREE. `none` (nothing recorded), `unreadable` (we cannot tell
//      you) and `vouched` are distinct states, and collapsing any pair is this codebase's oldest
//      failure family: an absence filling the result slot and reading as something it is not.
//
// ⭐ Property 1 is only testable where the two sources DISAGREE, so most of this file constructs
// disagreements. A record that names the running build proves nothing about where the value came
// from — both sources would produce the same string. [flow-is-not-meaning]
//
// ⚠️ AND THE PAIRWISE CHECKS ARE PAIRWISE ON PURPOSE. "three outcomes exist" is satisfied by three
// names; what matters is that no two of them are the same VALUE, and that each is reachable.
// [collapse-needs-pairwise-inequality]

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  vouchedBuild, httpStatusFor, VOUCH_OUTCOME, UNREADABLE_CAUSE,
} from "../../shared/dd-vouch/vouched.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
  return !!cond;
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

const hex = (seed) => createHash("sha256").update(seed).digest("hex");
const RUNNING_TREE = hex("dd-surface-RUNNING");
const OTHER_TREE = hex("dd-surface-SOMETHING-ELSE");
const NOW = Date.parse("2026-09-04T12:00:00.000Z");

const bound = { resolved: true, id: RUNNING_TREE, source: "build-stamp:ddTree", detail: "resolved" };
const unbound = { resolved: false, id: null, source: null, detail: "no usable ddTree" };

/** A well-formed health record naming `build`. */
const recordNaming = (build, extra = {}) => ({
  verdict: "pass",
  producedAt: "2026-09-04T11:55:00.000Z",
  identity: { schemaVersion: 3, catalogueFingerprint: "abc123", build, deployId: "6a9a6c3c37947013eee03080" },
  fixtures: [{ id: "f1", ok: true }],
  ...extra,
});

const call = (over = {}) =>
  vouchedBuild({ record: null, readable: true, now: NOW, running: bound, ...over });

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  dd-vouched-build — the health record's answer, not the stamp's      ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("0 ⛔ THE MODULE IS OUTSIDE ddTree — the decision, asserted not commented");
{
  // ⭐ A read-only reporter must not rotate the health key: rotation refuses the DD service, and
  // since step 2 that BLOCKS VAULT DEPOSITS. Binding an observer to the identity of the thing it
  // observes buys no safety and spends a deposit outage on every edit.
  const stampSrc = readFileSync("scripts/stamp-build.mjs", "utf8");
  const dirs = [...stampSrc.matchAll(/const DD_SURFACE_DIRS = \[([^\]]*)\]/gs)][0]?.[1] ?? "";
  const ddDirs = [...dirs.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const ddFiles = [...(stampSrc.match(/const DD_SURFACE_FILES = \[[\s\S]*?\n\];/) ?? [""])[0].matchAll(/"([^"]+\.mjs)"/g)].map((m) => m[1]);
  const covered = (p) => ddDirs.some((d) => p.startsWith(`${d}/`)) || ddFiles.includes(p);

  ok("⭐ DD_SURFACE_DIRS was actually parsed (the check is not vacuous)", ddDirs.length >= 3, ddDirs.join(", "));
  ok("⭐ DD_SURFACE_FILES was actually parsed", ddFiles.length >= 5, `${ddFiles.length} files`);
  // The CONTROL: a file that IS in the surface, so `covered` is known to be able to return true.
  ok("⭐ control — shared/dd-canary/health.mjs IS covered", covered("shared/dd-canary/health.mjs"));
  ok("⛔ the reporter is NOT in the DD surface — an observer must not rotate the health key",
    !covered("shared/dd-vouch/vouched.mjs"));
  ok("⛔ …and neither is its handler", !covered("netlify/functions/dd-vouched-build.mjs"));
  // ⚠️ The prefix match is `startsWith(d + "/")`, so `shared/dd-vouch/` must not be caught by
  // `shared/dd`. Asserted, because a change to `shared/dd` → `shared/dd` (no slash) would silently
  // pull this module in and start rotating the key on every edit.
  ok("⭐ the dir match is slash-terminated, so shared/dd-vouch is not swallowed by shared/dd",
    /startsWith\(`\$\{d\}\/`\)/.test(stampSrc));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — THREE OUTCOMES, EACH REACHED, PAIRWISE DISTINCT");
{
  const vouched = call({ record: recordNaming(RUNNING_TREE) });
  const none = call({ record: null, readable: true });
  const unread = call({ record: null, readable: false, storeError: "blobs exploded" });

  ok("VOUCHED is reachable", vouched.outcome === VOUCH_OUTCOME.VOUCHED, vouched.outcome);
  ok("NONE is reachable", none.outcome === VOUCH_OUTCOME.NONE, none.outcome);
  ok("UNREADABLE is reachable", unread.outcome === VOUCH_OUTCOME.UNREADABLE, unread.outcome);

  // ⭐ PAIRWISE, not "there are three names". Three constants that happened to be equal would
  // satisfy a length check and fail every one of these.
  ok("⭐⭐ vouched ≠ none", vouched.outcome !== none.outcome);
  ok("⭐⭐ none ≠ unreadable — THE distinction this thread turns on", none.outcome !== unread.outcome);
  ok("⭐⭐ vouched ≠ unreadable", vouched.outcome !== unread.outcome);

  ok("⛔ NONE carries no vouched build (an absence is not a value)", none.vouched === null);
  ok("⛔ UNREADABLE carries no vouched build", unread.vouched === null);
  ok("VOUCHED carries one", typeof vouched.vouched?.build === "string");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 ⛔ NONE IS NOT A FAULT, AND UNREADABLE IS NOT AN ABSENCE");
{
  const none = call({ record: null, readable: true });
  const unread = call({ record: null, readable: false, storeError: "boom" });

  ok("⭐ NONE says the store WAS read and holds nothing", /store was read/i.test(none.detail));
  ok("⭐ NONE names itself the EXPECTED post-rotation state, in those words",
    /expected/i.test(none.detail) && /canary tick/i.test(none.detail));
  ok("⭐ NONE explicitly denies being an error", /neither an error nor a failing canary/i.test(none.detail));
  ok("⭐ NONE answers HTTP 200 — nothing failed", httpStatusFor(none) === 200, String(httpStatusFor(none)));

  ok("⭐ UNREADABLE says the store did NOT answer", /did not answer/i.test(unread.detail));
  ok("⭐ UNREADABLE distinguishes itself from an absent record in its own words",
    /absence of an answer/i.test(unread.detail));
  ok("⭐ UNREADABLE surfaces the store error rather than swallowing it", unread.storeError === "boom");
  ok("⭐ UNREADABLE answers HTTP 503", httpStatusFor(unread) === 503, String(httpStatusFor(unread)));

  ok("⛔ the two details are not the same sentence", none.detail !== unread.detail);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 ⚠️ UNREADABLE HAS THREE CAUSES, AND NONE OF THEM IS `none`");
{
  const storeErr = call({ record: null, readable: false });
  const unboundBuild = call({ record: recordNaming(RUNNING_TREE), running: unbound });
  const malformed = call({ record: recordNaming(undefined) });
  const notObject = call({ record: "a string" });

  ok("store-error is tagged", storeErr.cause === UNREADABLE_CAUSE.STORE_ERROR, storeErr.cause);
  ok("build-unbound is tagged", unboundBuild.cause === UNREADABLE_CAUSE.BUILD_UNBOUND, unboundBuild.cause);
  ok("record-malformed is tagged", malformed.cause === UNREADABLE_CAUSE.RECORD_MALFORMED, malformed.cause);
  ok("a non-object record is malformed too", notObject.cause === UNREADABLE_CAUSE.RECORD_MALFORMED, notObject.cause);

  ok("⭐⭐ all three causes are distinct values",
    new Set([storeErr.cause, unboundBuild.cause, malformed.cause]).size === 3);
  ok("⛔ none of the three is reported as outcome `none`",
    [storeErr, unboundBuild, malformed, notObject].every((r) => r.outcome === VOUCH_OUTCOME.UNREADABLE));

  // ⭐⭐ THE ONE THAT WOULD BE EASIEST TO GET WRONG. With no ddTree there is no key, so the store is
  // never asked — reporting "no record" would assert a fact about a read that never happened.
  ok("⭐⭐ build-unbound says the store was NEVER ASKED, not that nothing was found",
    /never asked/i.test(unboundBuild.detail) && /NOT `none`/.test(unboundBuild.detail));
  ok("  …and it carries a remedy naming the build step", /npm run build/.test(unboundBuild.remedy ?? ""));
  // A record was SUPPLIED here and still must not become a vouch — without a bound build we cannot
  // show it is about this code.
  ok("⛔ a record supplied alongside an unbound build does NOT become a vouch", unboundBuild.vouched === null);

  ok("⭐ record-malformed says a record IS present, so `none` would misdescribe the store",
    /a record IS present/i.test(malformed.detail));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 ⭐⭐ THE VALUE COMES FROM THE RECORD, NOT THE STAMP — provable only where they differ");
{
  // 🚨 THE CENTRAL TEST. The stamp says RUNNING_TREE; the record names OTHER_TREE. An endpoint that
  // derived its answer from the stamp would report RUNNING_TREE here and look perfectly correct.
  const r = call({ record: recordNaming(OTHER_TREE) });

  ok("⭐⭐ the reported build is the RECORD's, not the stamp's",
    r.vouched?.build === OTHER_TREE, `${r.vouched?.build?.slice(0, 12)}… (stamp is ${RUNNING_TREE.slice(0, 12)}…)`);
  ok("⛔ and it is NOT the stamp's value", r.vouched?.build !== RUNNING_TREE);
  ok("the stamp's own value is still reported, separately", r.stamp?.ddTree === RUNNING_TREE);
  ok("⭐ the two are carried in DIFFERENT fields, so a reader cannot conflate them",
    r.vouched.build !== r.stamp.ddTree && "vouched" in r && "stamp" in r);

  // The control: when they agree, the value is still the record's — same field, same source.
  const agree = call({ record: recordNaming(RUNNING_TREE) });
  ok("⭐ CONTROL — when they agree the value is still read from the record",
    agree.vouched?.build === RUNNING_TREE && agree.vouched.source === "health-record:identity.build");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 🚨 THE DISAGREEMENT IS VISIBLE, AND SAYS WHAT TO CONCLUDE");
{
  const differ = call({ record: recordNaming(OTHER_TREE) });
  const agree = call({ record: recordNaming(RUNNING_TREE) });

  ok("comparison is comparable in both directions", differ.comparison.comparable === true && agree.comparison.comparable === true);
  ok("⭐⭐ disagreement reports agree:false", differ.comparison.agree === false);
  ok("⭐⭐ …with a distinct verdict word", differ.comparison.verdict === "differ" && agree.comparison.verdict === "agree");
  ok("⭐⭐ …and the two whatThisMeans texts are not the same sentence",
    differ.comparison.whatThisMeans !== agree.comparison.whatThisMeans);

  // ⛔ The conclusion must be STATED, not left to be worked out — that was the instruction.
  ok("⛔ it says not to treat the vouch as covering the running code",
    /do NOT treat this vouch as covering the running code/i.test(differ.comparison.whatThisMeans));
  ok("⛔ it says a record vouches for the build it NAMES",
    /vouches for the build it NAMES/i.test(differ.comparison.whatThisMeans));
  ok("⭐⭐ it distinguishes a disagreement from a normal rotation",
    /NOT A NORMAL ROTATION/i.test(differ.comparison.whatThisMeans) && /produces `none`/.test(differ.comparison.whatThisMeans));

  // ⚠️ Agreement must NOT be sold as corroboration — the key contains the running build, so a found
  // record will normally name it. Saying so is the honest half of this endpoint's claim.
  ok("⚠️ agreement is explicitly marked WEAK evidence", /WEAK EVIDENCE/i.test(agree.comparison.whatThisMeans));
  ok("  …and says why: the lookup key contains the running ddTree",
    /looked up by a key containing the running ddTree/i.test(agree.comparison.whatThisMeans));

  // ⭐ The status line carries it, for a reader who never parses the body.
  ok("⭐⭐ a disagreement answers HTTP 409, not 200", httpStatusFor(differ) === 409, String(httpStatusFor(differ)));
  ok("⭐ agreement answers 200", httpStatusFor(agree) === 200);
  ok("⭐⭐ the two statuses differ — the disagreement is visible without parsing JSON",
    httpStatusFor(differ) !== httpStatusFor(agree));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — NOT-COMPARABLE IS NOT AGREEMENT");
{
  for (const [name, r] of [
    ["none", call({ record: null, readable: true })],
    ["store-error", call({ record: null, readable: false })],
    ["build-unbound", call({ record: recordNaming(RUNNING_TREE), running: unbound })],
    ["malformed", call({ record: recordNaming(null) })],
  ]) {
    ok(`${name} — comparable:false`, r.comparison.comparable === false);
    ok(`${name} — agree is null, never true`, r.comparison.agree === null);
    ok(`${name} — says not-comparable is not agreement`, /not comparable is not agreement/i.test(r.comparison.whatThisMeans));
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 ⭐ PROVENANCE IS IN THE RESPONSE, not only in the source");
{
  const r = call({ record: recordNaming(OTHER_TREE) });
  ok("the vouched value names its source", r.vouched.source === "health-record:identity.build");
  ok("⭐ …and spells out that the KEY is stamp-derived while the VALUE is not",
    /lookup KEY is derived from the running ddTree/i.test(r.vouched.sourceDetail) &&
    /this VALUE is not/i.test(r.vouched.sourceDetail));
  ok("the stamp value names its source", r.stamp.source === "build-stamp:ddTree");
  ok("⭐ the two sources are different strings", r.vouched.source !== r.stamp.source);
  ok("the stamp block is present even when unresolved",
    call({ running: unbound }).stamp && call({ running: unbound }).stamp.ddTree === null);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("8 ⛔ `vouched` IS NOT A HEALTH TICK");
{
  const failing = call({ record: recordNaming(RUNNING_TREE, { verdict: "fail" }) });
  const stale = call({ record: recordNaming(RUNNING_TREE, { producedAt: "2026-09-01T00:00:00.000Z" }) });

  ok("⭐⭐ a FAILING record still counts as vouched (it names a build)", failing.outcome === VOUCH_OUTCOME.VOUCHED);
  ok("  …and the raw verdict is reported, not hidden", failing.vouched.verdict === "fail");
  ok("⭐⭐ a STALE record still counts as vouched", stale.outcome === VOUCH_OUTCOME.VOUCHED);
  ok("  …and its age is reported against the TTL", stale.vouched.ageMs > stale.vouched.ttlMs);
  ok("⛔ the detail says outright this is not a serving claim",
    /NOT a statement that the service is serving/i.test(failing.detail));
  ok("⛔ …and that evaluateHealth owns that decision, not this module",
    /evaluateHealth/.test(failing.detail));
  // ⚠️ No serve/refuse verdict is re-derived here — a second implementation is a duplicate source
  // of truth, and this codebase has paid for those.
  ok("⛔ the module exposes no serve/refuse field at all",
    !("serve" in failing) && !("healthy" in failing) && failing.vouched.serve === undefined);

  ok("ageMs is computed from producedAt, and is null when it cannot be parsed",
    call({ record: recordNaming(RUNNING_TREE, { producedAt: "not a date" }) }).vouched.ageMs === null);
  ok("the deployId is carried for diagnosis", failing.vouched.deployId === "6a9a6c3c37947013eee03080");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("9 🚨 THE HANDLER'S SEAL — a read endpoint that can write is an amplifier");
{
  const src = readFileSync("netlify/functions/dd-vouched-build.mjs", "utf8");

  // 🚨 GREP THE CODE, NOT THE COMMENTS. The first draft of this section FAILED on its own file:
  // the handler's "THE INVARIANT TO KEEP" note names runFixtures and _pause.mjs in prose, and a
  // plain grep cannot tell a prohibition from a call. That is the source-regex blind spot this repo
  // already knows about, one level down. [assert-on-rendered-output-not-source-regex]
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // ⛔ AND THE STRIPPER NEEDS ITS OWN CONTROL. An over-eager stripper returning "" would make every
  // `!/…/.test(code)` below pass VACUOUSLY — an absence filling the result slot and reading as
  // safety, which is the exact family these suites exist to catch.
  ok("⭐⭐ the comment stripper left real code behind (the greps below are not vacuous)",
    code.length > 400 && /export async function handler/.test(code), `${code.length} chars of code`);
  ok("⭐ …and it actually removed the comments (so it is not a no-op)",
    code.length < src.length * 0.6 && !/INVARIANT TO KEEP/.test(code),
    `${src.length} -> ${code.length} chars`);

  ok("⛔ it never writes the health record", !/writeHealth|setJSON/.test(code));
  ok("⛔ it never runs the fixture sweep", !/runFixtures/.test(code));
  ok("⛔ it does not import the money path", !/_pause\.mjs|_vault/.test(code));
  // ⚠️ The prohibition is also DOCUMENTED, and that lives in the comments the grep above discards —
  // so it is asserted against the raw source, deliberately.
  ok("⭐ …and the invariant is stated in the file for whoever edits it next",
    /INVARIANT TO KEEP/.test(src) && /never write/.test(src));
  ok("⭐ it derives identity with codeIdentityForEvent — the SAME call dd-canary writes with",
    /codeIdentityForEvent\(event/.test(code));
  ok("⭐ …and does not build a second derivation of its own", !/ddCodeIdentity\(/.test(code));
  ok("⭐ it refuses to read the store without a bound build", /if \(buildIsBound\(identity\)\)/.test(code));
  ok("⭐ the read is STRONG — an eventually-consistent safety read is the defect _dd-health documents",
    /consistency: "strong"/.test(src) || /readHealth/.test(src));
  ok("GET/HEAD only", /httpMethod !== "GET" && event\?\.httpMethod !== "HEAD"/.test(src));
  ok("⭐ the response states what it is NOT", /whatThisIsNot/.test(src));
  // ⚠️ The only two things read off the request. A "harmless" debug flag would break the seal.
  const eventReads = [...code.matchAll(/event\??\.(\w+)/g)].map((m) => m[1]);
  ok("⭐⭐ `event` is read for exactly httpMethod and blobs — no request-input channel",
    [...new Set(eventReads)].every((k) => k === "httpMethod" || k === "blobs"),
    [...new Set(eventReads)].join(", "));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("10 — the route exists and is declared exempt from the front-end audit");
{
  const toml = readFileSync("netlify.toml", "utf8");
  ok("the /api route is declared", /from = "\/api\/dd-vouched-build"/.test(toml));
  ok("…and points at this function", /to = "\/\.netlify\/functions\/dd-vouched-build"/.test(toml));
  const routes = readFileSync("scripts/verify-api-routes.mjs", "utf8");
  ok("⭐ it carries a STATED reason for having no front-end caller",
    /"\/api\/dd-vouched-build", "[^"]{60,}"/.test(routes));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
