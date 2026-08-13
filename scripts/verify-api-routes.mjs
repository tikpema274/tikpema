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

t("the DCA routes specifically — dead for 22 days, must stay declared", () => {
  for (const p of ["/api/dca-create", "/api/dca-cancel", "/api/dca-list"]) {
    assert.ok(declared.has(p), `${p} lost its redirect again`);
    assert.ok(referenced.has(p), `${p} is no longer called — if intentional, drop the redirect too`);
  }
});

console.log(`\n  audited ${referenced.size} referenced paths against ${declared.size} redirects`);
console.log(`${fail === 0 ? "✅" : "❌"} verify-api-routes: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
