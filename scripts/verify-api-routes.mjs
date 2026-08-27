import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// verify-api-routes — every /api path the front end calls must actually route somewhere.
//
// ═══ 🚨 THE BUG THIS WOULD HAVE CAUGHT ON DAY ONE ════════════════════════════════════════════
// `agentClient.ts` called `/api/dca-create`, `/api/dca-cancel` and `/api/dca-list` from 19405ad
// (2026-07-22). netlify.toml never had a redirect for any of them. All three returned 404 for
// **22 DAYS**, so every action on the DCA page — list, create, cancel — was dead. It was never a
// regression: the client was born pointing at routes that did not exist.
//
// ⚠️ AND IT WAS RECORDED AS WORKING. The refactor note says "SHIPPED + FULLY VERIFIED — BACKEND AND
// UI… live in prod and IDLE — the correct resting state". The UI check was of the MANUAL SWAP
// render, not of DCA creation. ⭐⭐ "IDLE" WAS GUARANTEED: a panel that cannot create anything is
// indistinguishable from one with nothing to do. An absence read as health — the same family as a
// zero balance from an unreadable chain.
//
// ═══ ⭐ WHY THIS IS DERIVED AND THE SMOKE LIST IS NOT ════════════════════════════════════════
// smoke-endpoints.mjs holds a HAND-WRITTEN list of 20 paths. A hand list answers "did I remember
// this one?"; this answers "is there anything I did not remember?" — which is the question that
// found the DCA routes. The /api convention has now failed THREE times (job-run and job-run-status
// deliberately, DCA accidentally), so it must never be assumed.
//
// ⚠️ SCOPE, STATED: this proves a path RESOLVES to a function. It does not prove the function works,
// nor that a deployed netlify.toml matches this one. Post-deploy smoke is what covers the second.

// ═══ ⭐⭐ AND THE AUDIT RUNS BOTH WAYS, BECAUSE BOTH DIRECTIONS HAVE FAILED IN PRODUCTION ══════
// This file was written for ONE direction — referenced → redirect — and that is HALF A GUARD:
//
//   · a REFERENCE WITH NO ROUTE  → the DCA bug: three paths 404'd for 22 days (above).
//   · a ROUTE WITH NO REFERENCE  → 2026-08-16: `/api/agent-dd-report` was deployed with a redirect
//     and nothing calling it, and this suite passed. The mirror image, and it passed BECAUSE the
//     audit only looked one way.
//
// ⚠️ THE SECOND IS THE CHEAPER FAILURE — a dangling redirect 404s nobody — but it is the one that
// lets a route be BELIEVED SHIPPED when no code path reaches it. That is the same shape as "live and
// IDLE": a surface nobody calls is indistinguishable from one with nothing to do.
//
// ⭐ AN EXEMPTION MUST BE STATED, NOT ASSUMED. Several routes legitimately have no front-end caller
// — the DD service is sold to strangers, some endpoints are operator-only. So the reverse check is
// not "ignore unknowns"; it is an allowlist where EVERY entry carries a REASON, and anything not on
// it fails. The reason string is the mechanism: you cannot silence a route without saying why, and a
// wrong reason is reviewable in a way that a missing entry never was.
//
// ⚠️ AND THE ALLOWLIST ITSELF IS AUDITED — an entry for a route that no longer exists fails too,
// otherwise it rots into permanent cover for a path nobody checks.
const NO_FRONTEND_CALLER = new Map([
  // ── sold to strangers: the whole point is that OUR app is not the caller ──
  ["/api/dd-analyze", "PUBLIC x402 endpoint. Buyers are external agents; the SPA never calls it."],
  ["/api/dd-openapi", "the machine-readable descriptor `howToCall.openApiUrl` points at, fetched by external clients."],
  ["/api/dd-identity", "the mutable companion the ERC-8004 identity document (agentId 851891) names as its correction AND availability path. Fetched by outside verifiers following tokenURI, never by the SPA — and v1.0.0's companion was unreachable precisely because nothing external could resolve it."],
  // ⭐ These two are the REASON this reverse audit's sibling defect existed: both endpoints were
  // LIVE and settling real Arc testnet USDC with NO /api redirect at all, and nothing noticed
  // because a GET to the missing path returned 200 with the SPA shell. The redirects added
  // 2026-08-27 give them a front door the /built page can name. The SPA is not and should not be
  // their caller — like /api/dd-analyze, the buyers are external agents.
  ["/api/x402-vanilla-seller", "PUBLIC x402 seller (vanilla EIP-3009, Arc testnet, 0.01 USDC). Buyers are external agents; the SPA never calls it. Front door added 2026-08-27 so /built can name a real URL — it had none, and the missing route was invisible because GET returned the SPA shell at 200."],
  ["/api/x402-quote", "PUBLIC x402 seller (Gateway batched, Arc testnet, 0.001 USDC). Same as above: external buyers only, front door added 2026-08-27."],
  // ── operator / bootstrap, deliberately never wired to a button ──
  ["/api/agent-init", "ONE-TIME bootstrap that mints a new agent wallet and ERC-8004 identity. Deliberately not reachable from the UI — a stray click would create a brand new agent."],
  ["/api/agent-status", "read-only operator diagnostic (wallet + identity), curled by hand."],
  ["/api/agent-parameters", "read-only cap/parameter dump for operators and smoke checks."],
  ["/api/agent-ub-spend", "agent-facing spend endpoint, exercised by scripts/smoke-endpoints.mjs rather than by a panel."],
  // ⭐ `/api/agent-dd-report` WAS HERE and is deliberately gone: DdReportCard now calls it, so the
  // exemption's own claim ("nothing calls this") became false and the suite FAILED on it — the
  // expires-when-contradicted check doing its job on the very entry it was written for. The route is
  // now covered by the ordinary referenced→redirect pass like every other live path.
]);

const SRC = "src";
const TOML = readFileSync("netlify.toml", "utf8");

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
});

// ⭐ BOTH QUOTE STYLES. A grep for `"` alone misses template literals like `/api/x-status?id=${id}`,
// and that is exactly where a path would hide from a careless audit.
const referenced = new Map();               // path -> [files]
for (const file of walk(SRC)) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/["'`](\/api\/[a-z0-9-]+)/gi)) {
    const p = m[1];
    if (!referenced.has(p)) referenced.set(p, []);
    if (!referenced.get(p).includes(file)) referenced.get(p).push(file);
  }
}

// ⭐ CAPTURE THE PAIR, NOT JUST THE `from`. My first version checked the FROM path's name against
// the function list — which silently assumes from and to always match. A typo in the TO target was
// invisible, and a mutation test caught it. The `to` is what actually resolves.
const routes = [...TOML.matchAll(/from\s*=\s*"(\/api\/[a-z0-9-]+)"\s*\n\s*to\s*=\s*"([^"]+)"/g)]
  .map((m) => ({ from: m[1], to: m[2] }));
const declared = new Set(routes.map((r) => r.from));
const functions = new Set(
  readdirSync("netlify/functions").filter((f) => f.endsWith(".mjs") && !f.startsWith("_"))
    .map((f) => f.replace(/\.mjs$/, "")));

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.error(`  ❌ ${name}\n     ${e.message}`); } };

console.log("\n── every /api path the front end calls must route ──────────────");

t("⭐⭐ no referenced /api path is missing a redirect", () => {
  const missing = [...referenced.entries()]
    .filter(([p]) => !declared.has(p))
    .map(([p, files]) => `${p}   called from ${files.map((f) => f.replace("src/", "")).join(", ")}`);
  assert.deepEqual(missing, [],
    "these resolve to the SPA catch-all — a 404 on POST, or 200-with-HTML on GET:\n       " +
    missing.join("\n       "));
});

t("⭐⭐ every redirect's TARGET is a function that exists", () => {
  // ⚠️ THE TARGET, not the source name. A redirect whose `to` has a typo is a 404 that LOOKS
  // configured — worse than a missing redirect, because the config reads as correct.
  const dangling = routes
    .filter((r) => !functions.has(r.to.replace("/.netlify/functions/", "")))
    .map((r) => `${r.from} → ${r.to}   (no such function)`);
  assert.deepEqual(dangling, [], "dangling redirect target:\n       " + dangling.join("\n       "));
});

t("⭐ …and every route was parsed as a from/to PAIR, not just a from", () => {
  // Pins the matcher: if the regex stops capturing `to`, `routes` empties and the check above
  // passes vacuously — the shape of failure that let the typo through in the first place.
  assert.equal(routes.length, declared.size,
    "some redirects parsed without a target — the from/to matcher has drifted");
  assert.ok(routes.length >= 25, `only ${routes.length} routes parsed — the matcher is missing some`);
});

t("⭐ the paths found include template literals, not just quoted strings", () => {
  // ⚠️ Pins the matcher itself. If someone narrows the regex to double quotes, this fails rather
  // than silently shrinking the audit — the "filtered read is not a measurement" rule, applied to
  // the audit's own input.
  assert.ok(referenced.has("/api/agent-ub-deposit-status"),
    "the known template-literal path is missing — the matcher no longer covers backticks");
});

console.log("\n── ⭐⭐ and the reverse: every redirect must have a caller, or a stated reason ──");

t("⭐⭐ no declared /api redirect is unreachable from the front end without a stated reason", () => {
  const orphans = routes
    .filter((r) => !referenced.has(r.from) && !NO_FRONTEND_CALLER.has(r.from))
    .map((r) => `${r.from} → ${r.to}   (no src/ caller, and no entry in NO_FRONTEND_CALLER)`);
  assert.deepEqual(orphans, [],
    "a route nobody calls is indistinguishable from one with nothing to do — add a caller, delete\n" +
    "       the redirect, or record WHY it has none:\n       " + orphans.join("\n       "));
});

t("⭐ …and the exemption list cannot rot — every entry names a route that still exists", () => {
  // ⚠️ Without this, an allowlist entry outlives its route and becomes permanent cover: the next
  // path to reuse that name inherits an exemption nobody granted it.
  const stale = [...NO_FRONTEND_CALLER.keys()].filter((p) => !declared.has(p));
  assert.deepEqual(stale, [], "exempted routes that no longer exist:\n       " + stale.join("\n       "));
});

t("⭐ …and an exemption expires the moment the front end DOES call it", () => {
  // ⭐ THE ENTRY IS THE CLAIM "nothing calls this". Once something does, the claim is false and the
  // line must go — otherwise the list drifts into a set of assertions nobody re-reads.
  const contradicted = [...NO_FRONTEND_CALLER.keys()].filter((p) => referenced.has(p));
  assert.deepEqual(contradicted, [],
    "these are exempted as having no front-end caller, but src/ calls them — delete the entry:\n       " +
    contradicted.join("\n       "));
});

t("⭐ every exemption states a REASON, and not a token one", () => {
  const thin = [...NO_FRONTEND_CALLER.entries()]
    .filter(([, why]) => typeof why !== "string" || why.trim().length < 25)
    .map(([p]) => p);
  assert.deepEqual(thin, [], "exemptions without a real justification:\n       " + thin.join("\n       "));
});

console.log("\n── the specific regressions this suite is named for ─────────────");

t("the DCA routes specifically — dead for 22 days, must stay declared", () => {
  for (const p of ["/api/dca-create", "/api/dca-cancel", "/api/dca-list"]) {
    assert.ok(declared.has(p), `${p} lost its redirect again`);
    assert.ok(referenced.has(p), `${p} is no longer called — if intentional, drop the redirect too`);
  }
});

t("⭐⭐ /api/agent-dd-report — the route with no caller that this reverse audit was built for", () => {
  // 🚨 THE MIRROR OF THE DCA CASE, PINNED THE SAME WAY. It shipped 2026-08-16 with a redirect and no
  // caller, and the one-directional suite passed. Whichever way it is resolved — a card that calls
  // it, or the redirect removed — this assertion must be updated deliberately rather than drift.
  assert.ok(declared.has("/api/agent-dd-report"), "the in-app DD report route lost its redirect");
  // ⭐ IT NOW HAS A REAL CALLER, and that is the resolution this assertion was waiting for. It
  // deliberately does NOT accept the exemption any more: re-adding one would mean the card stopped
  // calling it, which is precisely the regression worth failing on.
  assert.ok(referenced.has("/api/agent-dd-report"),
    "nothing in src/ calls it any more — the card regressed, or the route should be deleted");
});

console.log(`\n  audited ${referenced.size} referenced paths against ${declared.size} redirects`);
console.log(`  ${NO_FRONTEND_CALLER.size} routes exempted with a stated reason; ` +
            `${routes.filter((r) => referenced.has(r.from)).length} have a front-end caller`);
console.log(`${fail === 0 ? "✅" : "❌"} verify-api-routes: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
