// verify-canary-public.mjs — is the canary SAFE to expose publicly?
//
// ⭐ THE LOAD-BEARING QUESTION: can request input reach the verdict?
//
// "Safe-public" is safe only if the endpoint is a TRIGGER, not an ORACLE. A public endpoint that
// runs the real check is fine. A public endpoint that accepts a CLAIM about health is a forge-a-pass
// hole — and the whole value of the canary is that a broken service refuses, so an anonymous caller
// who can write `pass` can UN-REFUSE a broken service, turning the last safety layer into an attack
// surface.
//
// So the decisive test is not "is hostile input ignored". It is:
//   ⭐ A GENUINELY FAILING SUITE + MAXIMALLY HOSTILE INPUT MUST STILL WRITE `fail`.
//
//   node --experimental-test-module-mocks scripts/dd/verify-canary-public.mjs
// Zero network, zero money.

import { mock } from "node:test";
import { readFile } from "node:fs/promises";
import { SCHEMA_VERSION } from "../../shared/onchain-analyze/schema.mjs";
import { POWER_SIGS } from "../../shared/onchain-facts/index.mjs";
import { codeIdentity, shouldSkipRerun, MIN_RERUN_MS, DEFAULT_TTL_MS } from "../../shared/dd-canary/health.mjs";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

const IDENTITY = codeIdentity({ schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS });

// ── every hostile shape a public caller could send ────────────────────────────────────────────
const HOSTILE = [
  ["healthy=true in the query", { queryStringParameters: { healthy: "true" } }],
  ["skip the failing fixture", { queryStringParameters: { skip: "uups-empty-admin-slot" } }],
  ["force a pass", { queryStringParameters: { force: "pass", verdict: "pass" } }],
  ["a forged verdict in the body", { body: JSON.stringify({ verdict: "pass", fixtures: [], ok: true }) }],
  ["skipFixtures in the body", { body: JSON.stringify({ skipFixtures: true, healthy: true }) }],
  ["a forged record wholesale", { body: JSON.stringify({ record: { verdict: "pass", producedAt: new Date().toISOString(), identity: IDENTITY } }) }],
  ["health headers", { headers: { "x-health": "pass", "x-canary-verdict": "pass", "x-skip": "all" } }],
  ["a forged identity (to dodge version binding)", { body: JSON.stringify({ identity: { ...IDENTITY, build: "attacker" } }) }],
  ["everything at once", {
    queryStringParameters: { healthy: "true", force: "pass", skip: "all" },
    headers: { "x-health": "pass" },
    body: JSON.stringify({ verdict: "pass", skipFixtures: true, fixtures: [] }),
  }],
];

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  DD CANARY — SAFE-PUBLIC: trigger, not oracle                       ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ⚠️ ONE mock setup and ONE import for the whole file, with behaviour steered by these shared
// variables. A previous version called mock.reset() and re-imported per section — but the module was
// already in the ESM cache, so the second import returned the FIRST section's bindings and the new
// call-counter was never incremented. That produced vacuous passes AND spurious failures at the same
// time: the tests were measuring a counter nothing touched. Shared mutable state avoids the hazard.
let written = null;
let fixtureCalls = 0;
let suiteResult = { passed: true, results: [] };
let priorHealth = { record: null, readable: true };

mock.module("../../shared/dd-canary/fixtures.mjs", {
  namedExports: { runFixtures: async () => { fixtureCalls++; return suiteResult; }, FIXTURES: [] },
});
mock.module("../../netlify/functions/_dd-health.mjs", {
  namedExports: {
    readHealth: async () => priorHealth,
    writeHealth: async (_id, rec) => { written = rec; return true; },
    DD_HEALTH_STORE: "mock", healthKey: () => "mock",
  },
});
const { handler } = await import("../../netlify/functions/dd-canary.mjs");

// ═══════════ #1 — ⭐ FORGE-A-PASS MUST FAIL ═══════════
section("#1 ⭐ FORGE-A-PASS — failing suite + hostile input → must still write `fail`");
{
  // A suite that GENUINELY fails, exactly as a real UUPS regression would.
  suiteResult = {
    passed: false,
    results: [
      { id: "uups-empty-admin-slot", ok: false, problems: ["🚨 shape.variant is not-upgradeable, expected uups"] },
      { id: "eip2535-diamond", ok: true, problems: [] },
    ],
  };
  priorHealth = { record: null, readable: true };   // no prior → never deduped
  fixtureCalls = 0;

  const records = [];
  for (const [label, ev] of HOSTILE) {
    written = null;
    const res = await handler({ httpMethod: "POST", ...ev });
    const body = JSON.parse(res.body);
    check(`⭐ "${label}" → verdict is still FAIL`, written?.verdict === "fail", `verdict=${written?.verdict}`);
    check(`   …and the endpoint reports NOT ok (503)`, res.statusCode === 503 && body.ok === false, `${res.statusCode}`);
    check(`   …and the failing fixture is still named`, written?.fixtures?.some((f) => f.id === "uups-empty-admin-slot" && !f.ok));
    records.push({ label, rec: written });
  }

  check("⭐⭐ NOT ONE hostile input produced a `pass`", records.every((r) => r.rec?.verdict === "fail"));
  check("the suite actually ran every time (a trigger, not a shortcut)", fixtureCalls === HOSTILE.length, `${fixtureCalls} runs`);

  // Differential: every hostile record must be IDENTICAL modulo the timestamp. Any divergence is an
  // input→verdict channel, however benign it looks.
  const norm = (r) => JSON.stringify({ ...r, producedAt: "<t>" });
  const first = norm(records[0].rec);
  const diverged = records.filter((r) => norm(r.rec) !== first).map((r) => r.label);
  check("⭐ every hostile request produced a BYTE-IDENTICAL record (modulo timestamp)", diverged.length === 0,
    diverged.length ? `diverged: ${diverged.join(", ")}` : `${records.length} records identical`);

  const empty = await handler({ httpMethod: "POST" });
  const emptyRec = written;
  check("…and identical to an EMPTY request — input contributes nothing at all", norm(emptyRec) === first);
  void empty;
}

// ═══════════ #1b — the seal is STRUCTURAL, not filtered ═══════════
section("#1b — the seal is absence-of-channel, verified in the source");
{
  const src = await readFile(new URL("../../netlify/functions/dd-canary.mjs", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  const reads = [...code.matchAll(/event[?.]*\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  check("⭐ the handler reads exactly ONE property of `event`", new Set(reads).size === 1, `reads: ${[...new Set(reads)].join(", ")}`);
  check("…and that property is `blobs` (platform-injected, not caller-settable)", new Set(reads).has("blobs"));
  for (const forbidden of ["queryStringParameters", "body", "headers", "path", "rawQuery", "multiValueHeaders"]) {
    check(`  no read of event.${forbidden}`, !code.includes(`event.${forbidden}`) && !code.includes(`event?.${forbidden}`));
  }
  check("runFixtures receives NO argument derived from the request", /runFixtures\(\s*analyze\s*\)/.test(code),
    (code.match(/runFixtures\([^)]*\)/) ?? [])[0]);
}

// ═══════════ #2 — DEDUPE (anti-amplification) ═══════════
section("#2 — fresh-artifact dedupe: a public hit does NOT re-sweep");
{
  suiteResult = { passed: true, results: [{ id: "x", ok: true, problems: [] }] };
  const rec = (ageMs, extra = {}) => ({
    record: { verdict: "pass", producedAt: new Date(Date.now() - ageMs).toISOString(), identity: IDENTITY, fixtures: [], ...extra },
    readable: true,
  });
  // Sanity: the counter this section measures must actually move, or every assertion below is
  // vacuous. Proven before relying on it — the exact failure the earlier mock.reset() version hid.
  priorHealth = { record: null, readable: true }; fixtureCalls = 0;
  await handler({ httpMethod: "POST" });
  check("(instrument self-check) the sweep counter moves when a sweep should happen", fixtureCalls === 1, `${fixtureCalls}`);

  let prior = rec(60_000);
  priorHealth = prior; fixtureCalls = 0;
  let res = await handler({ httpMethod: "POST" });
  let body = JSON.parse(res.body);
  check("⭐ a hit within the window does NOT re-sweep", fixtureCalls === 0, `${fixtureCalls} sweeps`);
  check("   …and says so explicitly (deduped, reran:false)", body.deduped === true && body.reran === false);
  check("   …returning the existing verdict", body.verdict === "pass" && res.statusCode === 200);

  priorHealth = rec(60_000); fixtureCalls = 0;
  for (let i = 0; i < 25; i++) await handler({ httpMethod: "POST" });
  check("⭐ 25 rapid public hits cause ZERO sweeps (anti-amplification)", fixtureCalls === 0, `${fixtureCalls} sweeps`);

  priorHealth = rec(MIN_RERUN_MS + 60_000); fixtureCalls = 0;
  await handler({ httpMethod: "POST" });
  check("an artifact older than the window DOES re-sweep", fixtureCalls === 1);

  priorHealth = rec(60_000, { identity: { ...IDENTITY, build: "another-deploy" } }); fixtureCalls = 0;
  await handler({ httpMethod: "POST" });
  check("⭐ never dedupes against ANOTHER BUILD's artifact", fixtureCalls === 1);

  priorHealth = rec(60_000, { verdict: "fail" }); fixtureCalls = 0;
  res = await handler({ httpMethod: "POST" });
  check("a fresh FAILING artifact also dedupes (no re-sweep storm while broken)", fixtureCalls === 0);
  check("   …and still reports NOT ok (503)", res.statusCode === 503 && JSON.parse(res.body).ok === false);

  priorHealth = { record: null, readable: false }; fixtureCalls = 0;
  await handler({ httpMethod: "POST" });
  check("an UNREADABLE store does not dedupe (never skip on an unknown)", fixtureCalls === 1);

  // No bypass: hostile "force" input must not defeat the dedupe either.
  priorHealth = rec(60_000); fixtureCalls = 0;
  await handler({ httpMethod: "POST", queryStringParameters: { force: "true", nocache: "1" }, body: JSON.stringify({ force: true }) });
  check("⭐ hostile `force` input cannot bypass the dedupe (no force channel exists)", fixtureCalls === 0);
}

// ═══════════ #3 — SURFACE ═══════════
section("#3 — the schedule entry is the only new surface");
{
  const toml = await readFile(new URL("../../netlify.toml", import.meta.url), "utf8");
  const block = toml.match(/\[functions\."dd-canary"\]\s*\n\s*schedule\s*=\s*"([^"]+)"/);
  check("netlify.toml registers dd-canary on a schedule", !!block, block?.[1]);
  check("no OTHER new function block was added for the DD service",
    (toml.match(/\[functions\."dd-analyze"\]/g) ?? []).length === 0);
  check("the deposit path's functions are untouched by this entry",
    !/\[functions\."(job-sweep|dca-tick)"\]\s*\n\s*schedule\s*=\s*"\*\/10/.test(toml));

  // ⭐ the ordering invariant, asserted against the REAL file
  const cron = block?.[1] ?? "";
  const everyMin = cron.match(/^\*\/(\d+) \* \* \* \*$/);
  const cronMs = everyMin ? Number(everyMin[1]) * 60_000 : null;
  check("the schedule is a plain every-N-minutes cron", !!cronMs, cron);
  check("⭐ MIN_RERUN_MS < cron period (a scheduled run can NEVER dedupe itself)", MIN_RERUN_MS < cronMs,
    `${MIN_RERUN_MS / 60000}m < ${cronMs / 60000}m`);
  check("⭐ cron period < TTL (the artifact can never age out under normal operation)", cronMs < DEFAULT_TTL_MS,
    `${cronMs / 60000}m < ${DEFAULT_TTL_MS / 60000}m`);

  // deposit path isolation, by import graph rather than by grep
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, ["-e", `
    const fs=require("fs"),path=require("path");const seen=new Set(),bad=[];
    function walk(f){f=path.resolve(f);if(seen.has(f)||!fs.existsSync(f))return;seen.add(f);
     const s=fs.readFileSync(f,"utf8");
     for(const m of s.matchAll(/^import[^"']*["'](\\.[^"']+)["']/gm)){
      let p=path.resolve(path.dirname(f),m[1]); if(!fs.existsSync(p)&&fs.existsSync(p+".mjs"))p+=".mjs";
      if(/_vault\\.mjs$|_pause\\.mjs$/.test(p))bad.push(m[1]); walk(p);}}
    walk("netlify/functions/dd-canary.mjs");
    console.log(JSON.stringify({modules:seen.size,bad}));
  `], { cwd: new URL("../../", import.meta.url).pathname }).toString();
  const graph = JSON.parse(out);
  check("⭐ dd-canary's import graph reaches _vault.mjs / _pause.mjs ZERO times", graph.bad.length === 0,
    `${graph.modules} modules, bad=${JSON.stringify(graph.bad)}`);
}

console.log(`\n╔══════════════════════════════════════════════════════════════════════`);
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES PRESENT"}   pass ${pass} / fail ${fail}`);
console.log(`╚══════════════════════════════════════════════════════════════════════`);
process.exit(fail === 0 ? 0 : 1);
