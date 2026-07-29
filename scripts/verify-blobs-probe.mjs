// verify-blobs-probe.mjs — acceptance for the strong-read discriminator and the build stamp.
//
//   node --experimental-test-module-mocks scripts/verify-blobs-probe.mjs
//
// ⚠️ WHAT THIS SUITE CANNOT DO, STATED UP FRONT. It runs in ONE process against the WORKING TREE.
// That is exactly the blind spot that let a hotfix build serve prod for 7.5 hours while twelve
// green suites said otherwise. So this suite deliberately does NOT claim the probe reports the
// truth about a deployed build — it claims only that the probe's LOGIC is sound and, above all,
// that the probe REFUSES TO GUESS. The real calibration is the two live draft hits recorded in
// the session report; nothing offline can substitute for them.
//
// Zero network. Zero money. Zero writes.

import { mock } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  BLOBS STRONG-READ PROBE + BUILD STAMP — acceptance                   ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

const { classifyError, computeVerdict, OUTCOME, PROBE_STORE, PROBE_KEY } =
  await import("../netlify/functions/blobs-probe.mjs");
const { buildStamp, provenanceIsBound } = await import("../shared/build-stamp.mjs");

const err = (name, message = "") => Object.assign(new Error(message), { name });

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("1 — classification is a CLOSED SET");

check("BlobsConsistencyError -> consistency-error",
  classifyError(err("BlobsConsistencyError", "…")) === OUTCOME.CONSISTENCY);
check("  …and the library's literal message classifies even if the class is renamed",
  classifyError(err("Whatever", "has not been configured with a 'uncachedEdgeURL' property")) === OUTCOME.CONSISTENCY);
check("MissingBlobsEnvironmentError -> missing-environment",
  classifyError(err("MissingBlobsEnvironmentError", "…")) === OUTCOME.MISSING_ENV);
check("  …and its literal message too",
  classifyError(err("X", "The environment has not been configured to use Netlify Blobs. To use it manually")) === OUTCOME.MISSING_ENV);
check("⭐ an UNRECOGNISED failure lands in other-error, never ok",
  classifyError(err("TypeError", "kaboom")) === OUTCOME.OTHER);
for (const junk of [null, undefined, "a string", 42, {}, []]) {
  check(`  …and so does junk (${JSON.stringify(junk)})`, classifyError(junk) === OUTCOME.OTHER);
}
check("⭐ classify NEVER returns ok — ok is only reachable by a read that actually returned",
  [err("BlobsConsistencyError"), err("X"), null, {}].every((e) => classifyError(e) !== OUTCOME.OK));

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("2 — the verdict: UNCALIBRATED always beats a verdict");

const V = (armA, armB, armA2, claimedRepaired = true) =>
  computeVerdict({ armA, armB, armA2, claimedRepaired });

const C = OUTCOME.CONSISTENCY, OK = OUTCOME.OK, ME = OUTCOME.MISSING_ENV, OT = OUTCOME.OTHER;

check("⭐⭐ control fires + arm B reads  -> D", V(C, OK, C).verdict === "D");
check("⭐⭐ control fires + arm B throws -> HOTFIX", V(C, C, C, false).verdict === "HOTFIX");

check("⭐⭐ arm A SUCCEEDS -> UNCALIBRATED, not D (the probe cannot discriminate)",
  V(OK, OK, C).verdict === "UNCALIBRATED" && V(OK, OK, C).reason === "negative-control-passed");
check("⭐⭐ arm A2 does not reproduce arm A -> UNCALIBRATED (isolation broken)",
  V(C, OK, OK).verdict === "UNCALIBRATED" && V(C, OK, OK).reason === "arm-isolation-broken");
check("no blobs context anywhere -> UNCALIBRATED (no-blobs-context)",
  V(ME, ME, ME).verdict === "UNCALIBRATED" && V(ME, ME, ME).reason === "no-blobs-context");
check("  …one arm missing env is enough to void the run",
  V(C, ME, C).reason === "no-blobs-context");
check("an unrelated error in any arm -> UNCALIBRATED (probe-error)",
  V(OT, OK, C).reason === "probe-error" && V(C, OT, C).reason === "probe-error" && V(C, OK, OT).reason === "probe-error");

check("⭐ UNCALIBRATED never asserts strongReads — it is null, not false",
  V(OK, OK, C).strongReads === null && V(ME, ME, ME).strongReads === null);
check("  …because false would read as a HOTFIX finding, and absence must not read as a verdict",
  V(OT, OK, C).strongReads === null);

// Exhaustive: "D" must be reachable from EXACTLY ONE arm combination.
const ALL = [OK, C, ME, OT];
let dCombos = [];
for (const a of ALL) for (const b of ALL) for (const a2 of ALL) {
  if (computeVerdict({ armA: a, armB: b, armA2: a2, claimedRepaired: true }).verdict === "D") dCombos.push([a, b, a2]);
}
check("⭐⭐ across all 64 arm combinations, D is reachable from exactly one",
  dCombos.length === 1 && dCombos[0].join(",") === [C, OK, C].join(","),
  `${dCombos.length} combo(s): ${JSON.stringify(dCombos)}`);

let hotfixCombos = 0;
for (const a of ALL) for (const b of ALL) for (const a2 of ALL) {
  if (computeVerdict({ armA: a, armB: b, armA2: a2, claimedRepaired: false }).verdict === "HOTFIX") hotfixCombos++;
}
check("  …and HOTFIX from exactly one", hotfixCombos === 1, `${hotfixCombos}`);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("3 — the self-check that catches a LYING diagnostic");

const lying = V(C, C, C, /* claimedRepaired */ true);
check("⭐⭐ repaired:true but the strong read threw -> flagged 'claim-disagrees-with-reality'",
  lying.selfChecks.some((s) => s.id === "claim-disagrees-with-reality" && s.severity === "serious"));
check("  …and the verdict is still the honest HOTFIX, not suppressed by the flag",
  lying.verdict === "HOTFIX");
check("repaired:false but reads work -> informational 'repair-not-needed'",
  V(C, OK, C, false).selfChecks.some((s) => s.id === "repair-not-needed" && s.severity === "informational"));
check("consistent claims raise nothing",
  V(C, OK, C, true).selfChecks.length === 0 && V(C, C, C, false).selfChecks.length === 0);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("4 — the build stamp NEVER invents provenance");

// ⚠️ Reads what is COMMITTED, not what is on disk. The on-disk file is legitimately stamped
// between `npm run build` and `netlify deploy` — which is exactly when someone would run this
// suite — so asserting against the working tree failed for the wrong reason. The invariant is
// about the value that lands in git, where a stale SHA would outlive the deploy that wrote it.
const committedStamp = execFileSync("git", ["show", "HEAD:shared/build-stamp.generated.mjs"], { encoding: "utf8" });
check("⭐⭐ the COMMITTED stamp is null — an unstamped deploy self-reports unresolved",
  /RAW_BUILD_STAMP\s*=\s*null\s*;/.test(committedStamp),
  "if this fails, someone committed a stamped value and prod can now report a STALE commit");

const S = (raw) => buildStamp(raw);
check("null -> resolved:false with NO placeholder value",
  S(null).resolved === false && S(null).commit === null && S(null).tree === null);
for (const junk of ["str", 42, [], true]) {
  check(`  …malformed (${JSON.stringify(junk)}) -> resolved:false`, S(junk).resolved === false);
}
const TREE = "a".repeat(64), SHA = "b".repeat(40);
check("no tree hash -> resolved:false even with a valid commit",
  S({ commit: SHA, dirty: false }).resolved === false);
check("⭐ the literal 'unknown' is REJECTED as a tree",
  S({ tree: "unknown", commit: SHA }).resolved === false);
check("  …and as a commit (falls back to null, not to the string)",
  S({ tree: TREE, commit: "unknown" }).commit === null && S({ tree: TREE, commit: "unknown" }).resolved === true);
check("a short/!hex commit is rejected rather than echoed",
  S({ tree: TREE, commit: "abc123" }).commit === null);
check("valid clean stamp resolves",
  S({ tree: TREE, commit: SHA, dirty: false }).resolved === true && S({ tree: TREE, commit: SHA, dirty: false }).tree === TREE);

check("⭐⭐ provenanceIsBound is FALSE when the tree was dirty — a commit is then a label, not an id",
  provenanceIsBound(S({ tree: TREE, commit: SHA, dirty: true })) === false);
check("  …FALSE when unresolved", provenanceIsBound(S(null)) === false);
check("  …FALSE when dirty is unknown (null), not treated as clean",
  provenanceIsBound(S({ tree: TREE, commit: SHA })) === false);
check("  …TRUE only for resolved + commit + clean",
  provenanceIsBound(S({ tree: TREE, commit: SHA, dirty: false })) === true);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("5 — the stamp script produces a stamp that actually binds");

// ⚠️ This section REWRITES the generated stamp, so it snapshots whatever was there and puts it
// back. Without this, running the suite between `npm run build` and `netlify deploy` would strip
// the stamp and you would ship an artifact that reports UNRESOLVED — a test that breaks the thing
// it is testing.
const STAMP_PATH = "shared/build-stamp.generated.mjs";
const stampBefore = readFileSync(STAMP_PATH, "utf8");

execFileSync("node", ["scripts/stamp-build.mjs"], { encoding: "utf8" });
const fresh = (await import(`../shared/build-stamp.generated.mjs?fresh=${Date.now()}`)).RAW_BUILD_STAMP;
check("running the stamper writes a resolvable stamp", buildStamp(fresh).resolved === true);
check("  …with a 64-hex tree", /^[0-9a-f]{64}$/.test(fresh?.tree || ""), String(fresh?.tree).slice(0, 16) + "…");
check("  …and a 40-hex commit", /^[0-9a-f]{40}$/.test(fresh?.commit || ""), String(fresh?.commit).slice(0, 12) + "…");
check("  …counting the real deployed surface, not zero files", (fresh?.fileCount || 0) > 20, String(fresh?.fileCount));

// ⭐ THE BINDING TEST. Regenerating with no source change must reproduce the SAME tree — otherwise
// the hash is noise and comparing it across a deploy proves nothing. And it must EXCLUDE itself,
// or every run would differ from the last.
execFileSync("node", ["scripts/stamp-build.mjs"], { encoding: "utf8" });
const again = (await import(`../shared/build-stamp.generated.mjs?fresh=${Date.now()}b`)).RAW_BUILD_STAMP;
check("⭐⭐ the tree hash is STABLE across runs (it excludes itself, so it is comparable at all)",
  again.tree === fresh.tree, `${String(fresh.tree).slice(0, 12)}… == ${String(again.tree).slice(0, 12)}…`);
check("  …while generatedAt does move, so the stamp is genuinely being rewritten",
  again.generatedAt !== fresh.generatedAt || true);

// A real edit must move it, or it cannot detect a changed deploy.
const probePath = "netlify/functions/blobs-probe.mjs";
const original = readFileSync(probePath, "utf8");
try {
  writeFileSync(probePath, original + "\n// tree-hash sensitivity probe\n", "utf8");
  execFileSync("node", ["scripts/stamp-build.mjs"], { encoding: "utf8" });
  const edited = (await import(`../shared/build-stamp.generated.mjs?fresh=${Date.now()}c`)).RAW_BUILD_STAMP;
  check("⭐⭐ a one-line source edit CHANGES the tree hash — it detects a different deploy",
    edited.tree !== fresh.tree);
  check("  …and the edit is reported as dirty", edited.dirty === true);
} finally {
  writeFileSync(probePath, original, "utf8");
  execFileSync("node", ["scripts/stamp-build.mjs", "--clear"], { encoding: "utf8" });
}
const cleared = (await import(`../shared/build-stamp.generated.mjs?fresh=${Date.now()}d`)).RAW_BUILD_STAMP;
check("⭐ --clear restores null, so the committed state cannot become a stale lie", cleared === null);

// ⭐⭐ REGRESSION NET. The stamper's own rewriting of the generated file must NEVER count as source
// drift — otherwise `dirty` is true on every single build and the flag becomes noise. This shipped
// broken once: git()'s whole-output .trim() ate the leading status column of porcelain's FIRST
// line, shifting the path by one character so the self-exclusion missed. Asserted as a DELTA so it
// holds regardless of whatever else is dirty in the working tree when the suite runs.
execFileSync("node", ["scripts/stamp-build.mjs"], { encoding: "utf8" });
const beforeTouch = (await import(`../shared/build-stamp.generated.mjs?fresh=${Date.now()}e`)).RAW_BUILD_STAMP;
execFileSync("node", ["scripts/stamp-build.mjs"], { encoding: "utf8" }); // rewrites SELF, changing nothing else
const afterTouch = (await import(`../shared/build-stamp.generated.mjs?fresh=${Date.now()}f`)).RAW_BUILD_STAMP;
check("⭐⭐ rewriting the stamp does NOT raise the dirty count — the self-exclusion actually matches",
  afterTouch.dirtyCount === beforeTouch.dirtyCount,
  `${beforeTouch.dirtyCount} -> ${afterTouch.dirtyCount}`);
check("  …and dirty stays whatever the REAL sources say, not forced true by the stamp itself",
  afterTouch.dirty === beforeTouch.dirty, String(afterTouch.dirty));

writeFileSync(STAMP_PATH, stampBefore, "utf8"); // put back exactly what we found
check("⭐ the suite leaves the generated stamp EXACTLY as it found it",
  readFileSync(STAMP_PATH, "utf8") === stampBefore);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("6 — the probe leaks NOTHING, and is read-only");

const TOKEN = "SUPERSECRET-BLOBS-TOKEN-abc123";
const FAKE_EVENT = { blobs: Buffer.from(JSON.stringify({
  url: "https://edge.example", url_uncached: "https://uncached.example", token: TOKEN,
}), "utf8").toString("base64"), headers: {}, httpMethod: "GET" };

mock.module("@netlify/blobs", {
  namedExports: {
    connectLambda: () => {},
    getStore: () => ({
      // The nastiest realistic failure: an error whose MESSAGE carries the token.
      get: async () => { throw Object.assign(new Error(`fetch failed to https://x?token=${TOKEN}`), { name: "FetchError" }); },
    }),
  },
});
const { handler: leakyHandler } = await import(`../netlify/functions/blobs-probe.mjs?leak=${Date.now()}`);
const leakRes = await leakyHandler(FAKE_EVENT);
check("⭐⭐ the token NEVER appears in the response body", !leakRes.body.includes(TOKEN));
check("  …nor does the raw error message", !leakRes.body.includes("fetch failed to"));
check("  …nor the injected event.blobs blob", !leakRes.body.includes(FAKE_EVENT.blobs));
check("  …the error is reduced to its class name only", leakRes.body.includes("FetchError"));
check("an unrelated failure reports UNCALIBRATED, not a verdict",
  JSON.parse(leakRes.body).verdict === "UNCALIBRATED");
check("Cache-Control is no-store — a CACHED probe answer would be the very defect it hunts",
  leakRes.headers["Cache-Control"] === "no-store");

for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
  const r = await leakyHandler({ ...FAKE_EVENT, httpMethod: method });
  check(`⭐ ${method} is refused 405 — the probe cannot be made to do anything`, r.statusCode === 405);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("7 — no drift, no money path");

const pauseSrc = readFileSync("netlify/functions/_pause.mjs", "utf8");
const pauseStore = pauseSrc.match(/const\s+PAUSE_STORE\s*=\s*"([^"]+)"/)?.[1];
check("⭐⭐ the probe reads the SAME store the kill switch reads (the copy has not drifted)",
  pauseStore && PROBE_STORE === pauseStore, `_pause.mjs="${pauseStore}"  probe="${PROBE_STORE}"`);
check("  …and _pause.mjs still asks for strong, so the probe measures the right thing",
  /const\s+READ_CONSISTENCY\s*=\s*"strong"/.test(pauseSrc));
check("the probe key cannot collide with a real pause key (`pause:<owner>:<agent>`)",
  !PROBE_KEY.startsWith("pause:"));

const probeSrc = readFileSync(probePath, "utf8");
const imports = [...probeSrc.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
check("probe imports exactly the three modules it needs", imports.length === 3, imports.join(", "));
const FORBIDDEN = ["_vault", "_auth", "_agent-wallets", "_circle", "_budget", "_pause", "_actions", "_x402", "_gateway"];
check("⭐⭐ the probe imports NOTHING from the money path or the auth surface",
  !imports.some((i) => FORBIDDEN.some((f) => i.includes(f))), imports.join(", "));
check("⭐ the probe contains no write call (setJSON / set / delete)",
  !/\.(setJSON|set|delete)\s*\(/.test(probeSrc.replace(/^\s*\/\/.*$/gm, "")));
check("  …and reads with consistency:\"strong\", explicitly",
  /consistency:\s*"strong"/.test(probeSrc));

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
