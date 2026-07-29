// verify-pause-consistency.mjs — a cached "not paused" must never let funds move.
//
// ═══ 🚨 WHAT THIS GUARDS ═════════════════════════════════════════════════════════════════════
// `_pause.mjs` is the MONEY kill switch. Every spend path — executeAction, agent-send,
// agent-ub-spend, job-run, maybeBuyData — calls assertNotPaused() before moving funds.
//
// It already failed closed TWICE: an unreadable flag blocks, and an unrecognised AGENT_HALT halts.
// Neither covers the case this suite exists for:
//
//     operator hits STOP  ->  setPaused writes {paused:true} to ORIGIN
//     spend path reads    ->  gets the CACHED pre-pause value  ->  returns null  ->  FUNDS MOVE
//
// A cached read does NOT throw. It succeeds and returns a confident stale answer, so it sails past
// the catch that handles "could not read". The kill switch fails to stop anything during the exact
// emergency it exists for, and nothing reports a failure, because the read "worked".
//
// ═══ HOW ═════════════════════════════════════════════════════════════════════════════════════
// Mocks @netlify/blobs — NOT _pause.mjs, which is the code under test — with a store that models
// the edge cache: strong reads hit origin, everything else (including the default) hits a stale
// copy. Drop `consistency` from _pause.mjs and these go red.
//
//   node --experimental-test-module-mocks scripts/verify-pause-consistency.mjs
//
// Zero network, ZERO MONEY. Nothing here can move funds: no key, no client, no RPC.

import { mock } from "node:test";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

const origin = new Map();
const edge = new Map();
const reads = [];
let throwOnRead = false;

const fakeStore = {
  async get(key, opts = {}) {
    reads.push({ key, consistency: opts.consistency ?? "(default)" });
    if (throwOnRead) throw new Error("blobs unavailable");
    if (opts.consistency === "strong") return origin.get(key) ?? null;
    return edge.get(key) ?? null;                       // the stale edge copy
  },
  async setJSON(key, value) { origin.set(key, JSON.parse(JSON.stringify(value))); },  // edge NOT updated
};
mock.module("@netlify/blobs", {
  namedExports: { getStore: () => fakeStore, connectLambda: () => {}, getDeployStore: () => fakeStore },
});

const { pauseReason, assertNotPaused, setPaused, pauseStates, globalHalt, ALL_AGENTS } =
  await import("../netlify/functions/_pause.mjs");

const OWNER = "0xabc0000000000000000000000000000000000001";
const AGENT = "executor";
const kAll = `pause:${OWNER}:${ALL_AGENTS}`;
const kMine = `pause:${OWNER}:${AGENT}`;
const flag = (paused) => ({ paused, agent: AGENT, owner: OWNER, at: new Date().toISOString() });
const reset = () => { origin.clear(); edge.clear(); reads.length = 0; throwOnRead = false; delete process.env.AGENT_HALT; };

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  PAUSE — a cached 'not paused' must never let funds move            ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═══════════ 1 — the enforcement path asks for STRONG ═══════════
section("1 — the money gate reads with strong consistency");
{
  reset();
  await pauseReason({ owner: OWNER, agent: AGENT });
  check("two reads issued (global + per-agent)", reads.length === 2, JSON.stringify(reads.map((r) => r.consistency)));
  check("⭐⭐ BOTH ask for consistency:'strong'", reads.every((r) => r.consistency === "strong"),
    reads.map((r) => r.consistency).join(","));
  check("  …the global key", reads.some((r) => r.key === kAll), kAll);
  check("  …and the per-agent key", reads.some((r) => r.key === kMine), kMine);
  check("assertNotPaused IS pauseReason (the export the money paths call)", assertNotPaused === pauseReason);
}

// ═══════════ 2 — ⭐ instrument self-check: the cache genuinely diverges ═══════════
section("2 — the cache model diverges (else this suite proves nothing)");
{
  reset();
  edge.set(kMine, flag(false));            // edge remembers "running"
  await setPaused({ owner: OWNER, agent: AGENT, paused: true });   // origin now says PAUSED
  const strong = await fakeStore.get(kMine, { consistency: "strong" });
  const cached = await fakeStore.get(kMine);
  check("⭐ origin says PAUSED", strong?.paused === true);
  check("⭐ the stale edge still says running", cached?.paused === false);
  check("  …they genuinely disagree — there is something to catch", strong.paused !== cached.paused);
}

// ═══════════ 3 — ⭐⭐⭐ THE FAIL-OPEN: pause written, cache stale → MUST STOP ═══════════
section("3 — PAUSED written, edge cached 'running' → the gate must BLOCK");
{
  reset();
  edge.set(kMine, flag(false));
  edge.set(kAll, null);
  await setPaused({ owner: OWNER, agent: AGENT, paused: true });

  const reason = await pauseReason({ owner: OWNER, agent: AGENT });
  check("⭐⭐⭐ the gate BLOCKS — a cached 'running' did NOT let funds move",
    typeof reason === "string" && reason.length > 0, JSON.stringify(reason));
  check("  …and says which agent is paused", /paused/i.test(reason ?? ""), reason);

  // The counterfactual, asserted rather than asserted-about: this is what the OLD code returned.
  const cached = await fakeStore.get(kMine);
  check("⭐⭐ PROOF THE FIX IS LOAD-BEARING: the cached read says 'not paused' → would have ALLOWED",
    cached?.paused === false, `cached paused=${cached?.paused} → pauseReason would return null → SPEND PROCEEDS`);
}

// ═══════════ 4 — the GLOBAL stop, same test ═══════════
section("4 — 'stop everything' written, edge stale → must BLOCK");
{
  reset();
  edge.set(kAll, flag(false));
  edge.set(kMine, flag(false));
  await setPaused({ owner: OWNER, agent: ALL_AGENTS, paused: true });

  const reason = await pauseReason({ owner: OWNER, agent: AGENT });
  check("⭐⭐ global pause is seen despite a stale edge", typeof reason === "string" && /All of your agents/i.test(reason), reason);
}

// ═══════════ 5 — ⚠️ UNREADABLE-SAFETY MUST BE PRESERVED, not replaced ═══════════
// Strong consistency ADDS stale-safety. It must not cost the pre-existing fail-closed behaviour.
section("5 — unreadable still BLOCKS (rule 1 intact)");
{
  reset();
  throwOnRead = true;
  const reason = await pauseReason({ owner: OWNER, agent: AGENT });
  check("⭐⭐ a throwing read still BLOCKS", typeof reason === "string" && reason.length > 0, reason);
  check("  …with the 'could not verify' wording", /could not verify/i.test(reason ?? ""), reason);
  throwOnRead = false;

  // And the other pre-existing fail-closed paths, untouched by this change.
  check("no owner → blocks", typeof await pauseReason({ owner: null, agent: AGENT }) === "string");
  check("unknown agent → blocks", typeof await pauseReason({ owner: OWNER, agent: "nope" }) === "string");
  process.env.AGENT_HALT = "wat";
  check("unrecognised AGENT_HALT → halts", typeof globalHalt() === "string", globalHalt());
  process.env.AGENT_HALT = "1";
  check("AGENT_HALT=1 → halts before any read", typeof await pauseReason({ owner: OWNER, agent: AGENT }) === "string");
  delete process.env.AGENT_HALT;
}

// ═══════════ 6 — ⭐ RESUME must also be seen: strong wins in BOTH directions ═══════════
// A gate that always blocks is not a gate. This proves the fix reads the truth, not that it is stuck.
section("6 — resume written, edge cached 'paused' → must ALLOW");
{
  reset();
  edge.set(kMine, flag(true));                                       // edge stuck on paused
  await setPaused({ owner: OWNER, agent: AGENT, paused: false });     // origin: resumed
  const reason = await pauseReason({ owner: OWNER, agent: AGENT });
  check("⭐⭐ the resume is seen — not permanently stuck blocked", reason === null, JSON.stringify(reason));
  check("  …while the stale edge would have kept it blocked", (await fakeStore.get(kMine))?.paused === true);
}

// ═══════════ 7 — the roster VIEW reads strong too ═══════════
section("7 — the operator's feedback loop is not stale either");
{
  reset();
  edge.set(kMine, flag(false));
  await setPaused({ owner: OWNER, agent: AGENT, paused: true });
  reads.length = 0;
  const states = await pauseStates({ owner: OWNER });
  check("⭐ every roster read asks for strong", reads.length > 0 && reads.every((r) => r.consistency === "strong"),
    `${reads.length} reads`);
  check("⭐⭐ the roster shows PAUSED right after the write", states[AGENT] === true, JSON.stringify(states[AGENT]));
  check("  …so the operator can confirm the stop actually took", states[AGENT] === true);
}

// ═══════════ 7b — ⭐ UNREADABLE IS NOT "RUNNING" in the roster ═══════════
// The per-key catch used to yield null, which !!null rendered as FALSE — so ONE unreadable flag
// showed the operator a GREEN, RUNNING agent whose state was actually unknown. Wrong direction on a
// safety control, and it disagreed with the whole-store catch, which already returns null.
section("7b — one unreadable key → unknown (null), never 'running'");
{
  reset();
  await setPaused({ owner: OWNER, agent: AGENT, paused: true });
  // Fail exactly ONE key, leaving the store otherwise healthy.
  const realGet = fakeStore.get;
  fakeStore.get = async (key, opts) => {
    if (key === kMine) throw new Error("this one key is unreadable");
    return realGet(key, opts);
  };
  const states = await pauseStates({ owner: OWNER });
  fakeStore.get = realGet;

  check("⭐⭐ the unreadable agent reads as NULL (unknown), not false",
    states[AGENT] === null, JSON.stringify(states[AGENT]));
  check("  …it is NOT rendered as running", states[AGENT] !== false);
  check("  …other agents still report normally", states[ALL_AGENTS] === false, JSON.stringify(states[ALL_AGENTS]));
  check("⭐ one key failing now behaves like the whole store failing (both → null)", states[AGENT] === null);
}

// ═══════════ 8 — structural: the spend paths still route through this gate ═══════════
section("8 — the chokepoint is still wired");
{
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = "netlify/functions";
  const callers = readdirSync(dir).filter((f) => f.endsWith(".mjs"))
    .filter((f) => /assertNotPaused|pauseReason/.test(readFileSync(`${dir}/${f}`, "utf8")));
  check("⭐ multiple money paths still call the gate", callers.length >= 4, `${callers.length}: ${callers.slice(0, 6).join(", ")}…`);
  check("  …a pause that one path routes around is not a pause", callers.length >= 4);
}

console.log(`\n╔══════════════════════════════════════════════════════════════════════`);
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES PRESENT"}   pass ${pass} / fail ${fail}`);
console.log(`╚══════════════════════════════════════════════════════════════════════`);
process.exit(fail === 0 ? 0 : 1);
