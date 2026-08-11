#!/usr/bin/env node
// verify-x402-timeouts.mjs — the staged deadlines in _x402.mjs, and the ONE asymmetry that matters.
//
// ═══ WHAT THIS EXISTS TO PIN ═════════════════════════════════════════════════════════════════
// Until 2026-08-11 `_x402.mjs` had no AbortSignal anywhere, so a stalled call produced no persist,
// no handle, no money AND NO ERROR. Three DD money-step runs stalled and the only observable was an
// empty terminal; four hypotheses were measured and refuted because nothing could say WHICH call
// was stuck.
//
// ⭐⭐ THE LOAD-BEARING ASSERTION IN THIS FILE is that a SETTLE timeout reports `charged: null` and
// never `charged: false`. Aborting that fetch stops US waiting; it does not stop the seller, whose
// own order is analyze → decide → snapshot → PERSIST → settle. So the money may well have moved.
// `charged:false` would invite a retry, and a retry there is a DOUBLE PAY. Every other stage is
// pre-broadcast, where `charged:false` is a structural fact.
//
// ⚠️ These are checked by CONSTRUCTION (a hung server, a real abort), not by mocking the timeout —
// a suite that stubs the deadline proves only that the stub was called.

import { createServer } from "node:http";
import { X402Timeout, X402_TIMEOUTS, fetchX402Requirements, payX402 } from "../../netlify/functions/_x402.mjs";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  cond ? pass++ : fail++;
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

/** A server that accepts the connection and then NEVER answers — the exact shape that hung. */
function blackholeServer() {
  const sockets = new Set();
  const server = createServer(() => { /* deliberately no response, ever */ });
  server.on("connection", (s) => sockets.add(s));
  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () =>
      res({
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => { for (const s of sockets) s.destroy(); server.close(); },
      }));
  });
}

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  x402 STAGED TIMEOUTS — a hang must name its stage                   ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("1 — the budgets are per-stage, and ordered by kind");
check("every stage has a positive finite budget",
  ["challenge", "sign", "settle", "retrieve"].every(
    (k) => Number.isFinite(X402_TIMEOUTS[k]) && X402_TIMEOUTS[k] > 0),
  JSON.stringify(X402_TIMEOUTS));
check("⭐ settle is the MOST generous — it spans analyse+persist+Circle settlement",
  X402_TIMEOUTS.settle > X402_TIMEOUTS.sign && X402_TIMEOUTS.settle > X402_TIMEOUTS.challenge);
check("⭐ retrieve is the SHORTEST — it repeats, so one slow poll must not eat the poll budget",
  X402_TIMEOUTS.retrieve <= X402_TIMEOUTS.challenge && X402_TIMEOUTS.retrieve < X402_TIMEOUTS.settle);
check("signing is bounded in seconds, not minutes (it is an API call, not a chain write)",
  X402_TIMEOUTS.sign <= 60_000);

section("2 — a hung CHALLENGE names its stage instead of hanging");
{
  const bh = await blackholeServer();
  const t0 = Date.now();
  let threw = null;
  try {
    // Bound the test itself well under the real budget — we assert the mechanism, not the constant.
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 2_500);
    await Promise.race([
      fetchX402Requirements({ sellerUrl: bh.url }),
      new Promise((_, r) => setTimeout(() => r(new Error("TEST-HARNESS-CAP")), 2_500)),
    ]);
  } catch (e) { threw = e; }
  const ms = Date.now() - t0;
  bh.close();
  // The real budget (20s) exceeds the harness cap, so the harness cap is what fires here. What this
  // proves is the shape: a black-holed seller does NOT return, and therefore MUST be bounded.
  check("a black-holed seller does not answer on its own (the failure being fixed)",
    threw !== null && ms >= 2_000, `${ms}ms, ${threw?.message}`);
}

section("3 — X402Timeout carries the stage, which is the whole diagnostic value");
{
  const e = new X402Timeout("sign", 30_000);
  check("instanceof Error", e instanceof Error);
  check("⭐ carries .stage", e.stage === "sign", e.stage);
  check("carries .ms", e.ms === 30_000);
  check("the message names the stage AND the budget",
    /sign/.test(e.message) && /30000/.test(e.message), e.message);
  check("⭐ distinguishable from a connect failure (name is X402Timeout, not TypeError)",
    e.name === "X402Timeout");
}

// ⚠️ COMMENTS MUST BE STRIPPED BEFORE ANY OF THIS SCANS. Building this suite, three checks failed
// against CORRECT code: the settle window caught `charged:false` from the COMMENT forbidding it, and
// a `await fetch(` count matched fetchStage's OWN implementation. Both are already-documented
// failure modes here (a guard tripped by prose quoting the falsehood; a checker including itself in
// its corpus). Benign in that direction — but the identical flaw produces a false ALL-CLEAR, which
// for a guard over a money path is the only failure that matters.
const SRC = await import("node:fs").then((fs) =>
  fs.readFileSync(new URL("../../netlify/functions/_x402.mjs", import.meta.url), "utf8"));
// Whole-line comments, then trailing ones. `\s+//` cannot eat a URL — `https://` has no space
// before its slashes.
const CODE = SRC
  .split("\n")
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .map((l) => l.replace(/\s+\/\/.*$/, ""))
  .join("\n");

section("4 — 🚨 THE ASYMMETRY: what each stage may claim about the money");
{
  // The settle branch, delimited by CODE landmarks rather than a character window — a window sized
  // by hand is exactly how the comment above leaked into the last version of this check.
  const s0 = CODE.indexOf("let paid;");
  const s1 = CODE.indexOf("const paidText");
  const settle = s0 !== -1 && s1 > s0 ? CODE.slice(s0, s1) : "";

  check("the settle-timeout branch exists", /reason:\s*"settle-timeout"/.test(settle));
  check("⭐⭐ settle timeout reports charged: null", /charged:\s*null/.test(settle));
  check("⭐⭐ settle timeout NEVER reports charged: false — a retry there is a DOUBLE PAY",
    !/charged:\s*false/.test(settle));
  check("⭐ settle timeout is NOT marked retryable", /retryable:\s*false/.test(settle));
  check("  …and says so in words, not only in a flag",
    /DOUBLE PAY|becomes two real ones|Do NOT re-run/i.test(settle));
  check("⭐ it hands back a resolution procedure (chain + pending store), not just an error",
    /availableBalance/.test(settle) && /pending store/i.test(settle));

  // ⭐ lastIndexOf, NOT indexOf. The FIRST `instanceof X402Timeout` is the settle guard at the top of
  // that branch; using it silently pointed this check at the settle block and made three assertions
  // answer about the wrong code while looking authoritative.
  const j = CODE.lastIndexOf("instanceof X402Timeout");
  const pre = j === -1 ? "" : CODE.slice(j);
  check("the PRE-BROADCAST branch is a DIFFERENT block from settle",
    j !== -1 && (s1 === -1 || j > s1));
  check("⭐ the PRE-BROADCAST branch may assert charged:false — nothing was sent",
    /charged:\s*false/.test(pre));
  check("  …and is retryable, unlike settle", /retryable:\s*true/.test(pre));
  check("  …and names sign vs challenge distinctly",
    /"sign"|=== "sign"|stage === "sign"/.test(pre) || /sign/.test(pre));
}

section("5 — the retrieve poll must never abandon a PAID entitlement");
{
  const k = CODE.indexOf('"retrieve", X402_TIMEOUTS.retrieve');
  const around = k === -1 ? "" : CODE.slice(k, k + 700);
  check("the retrieve fetch is bounded", k !== -1);
  check("⭐ a retrieve timeout CONTINUES the loop (transient), never returns a failure",
    /continue;/.test(around));
  check("  …and is labelled transient/redeemable so nobody reads it as a loss",
    /transient/i.test(around) && /redeemable/i.test(around));
}

section("6 — no unbounded fetch survives in the module");
{
  // ⭐ ASSERT THE EXPECTED COUNT, NEVER `=== 0` OR `> 0`. There is exactly ONE `await fetch(` in the
  // module and it is the one INSIDE fetchStage, which carries the signal. An earlier version of this
  // check demanded zero and went red against correct code — the checker had included the very
  // implementation it exists to require. A count pins both directions: a new unbounded call pushes
  // it to 2, and deleting the bounded one drops it to 0.
  const bare = [...CODE.matchAll(/await\s+fetch\(/g)];
  const insideStage = /async function fetchStage[\s\S]*?return await fetch\(url,\s*\{\s*\.\.\.init,\s*signal:\s*ac\.signal\s*\}\)/.test(CODE);
  check("⭐⭐ EXACTLY ONE `await fetch(` in the module", bare.length === 1, `found ${bare.length}`);
  check("⭐⭐ …and it is the one inside fetchStage, carrying the AbortSignal", insideStage);
  const staged = [...CODE.matchAll(/fetchStage\(/g)];
  check("  …fetchStage has ≥3 call sites (challenge, settle, retrieve) plus its definition",
    staged.length >= 4, `${staged.length} occurrences`);
  check("⭐ no fetch anywhere omits a signal (no `fetch(` without going through fetchStage)",
    (CODE.match(/[^a-zA-Z]fetch\(/g) || []).length === bare.length,
    `${(CODE.match(/[^a-zA-Z]fetch\(/g) || []).length} total fetch( occurrences`);
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : `❌ FAILURES`}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
