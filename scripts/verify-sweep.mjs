// verify-sweep.mjs — ZERO-MONEY proof of the autonomous cron sweep LOGIC.
//   node --experimental-test-module-mocks scripts/verify-sweep.mjs
//
// Proves the sweep re-fires exactly the recoverable runs and NOTHING else:
//   • stalled "starting" (old enough, not re-fired recently) → RE-FIRED
//   • advanced (creating/funding/funded or has jobId)        → skipped (no double-create)
//   • young "starting" (< STALL_MS)                          → skipped
//   • re-fired within cooldown                               → skipped
//   • aged past MAX_AGE                                       → marked failed, NOT re-fired
//   • missing question/wallet                                → skipped (can't reconstruct)
//
// NOTE: this proves the sweep's DECISION logic against a stubbed store. It cannot prove
// the platform actually (a) fires the cron on schedule or (b) gives a scheduled function
// Blobs access — both are deploy-only. The handler no-ops loudly if Blobs is unavailable.
import { mock } from "node:test";

mock.module("../netlify/functions/_auth.mjs", { namedExports: { internalToken: () => "tok" } });

// In-memory job-runs store with list({prefix}).
const m = new Map();
const runsStore = {
  list: async ({ prefix }) => ({ blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }),
  get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null),
  setJSON: async (k, v) => void m.set(k, JSON.stringify(v)),
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: () => runsStore } });

let reFires = [];
globalThis.fetch = async (url, init) => {
  if (String(url).includes("job-run-background")) reFires.push(JSON.parse(init.body).runId);
  return { status: 202, ok: true };
};
process.env.URL = "https://app.tikpema.xyz";

const { handler } = await import("../netlify/functions/job-sweep.mjs");

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const seed = (runId, patch) => m.set(`run:${runId}`, JSON.stringify({
  runId, owner: "0xo", walletAddress: "0xw", question: "bridge 1 USDC to Base", budgetUsdc: 0.3,
  status: "starting", createdAt: ago(90_000), ...patch,
}));

// The full menagerie.
seed("stalled",     {});                                            // → re-fire
seed("advanced",    { status: "creating" });                       // → skip
seed("hasjob",      { status: "funding", jobId: "155999" });       // → skip
seed("young",       { createdAt: ago(5_000) });                    // → skip (< 45s)
seed("cooldown",    { reFiredAt: ago(10_000) });                   // → skip (re-fired 10s ago)
seed("recovered",   { reFiredAt: ago(120_000) });                  // → re-fire (cooldown passed)
seed("aged",        { createdAt: ago(2 * 60 * 60_000) });          // → mark failed, no re-fire
seed("noquestion",  { question: undefined });                      // → skip

const res = await handler({ blobs: null });
const body = res.body;

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

console.log("── sweep decisions ──");
check("stalled 'starting' → RE-FIRED", reFires.includes("stalled"));
check("recovered (cooldown passed) → RE-FIRED", reFires.includes("recovered"));
check("advanced 'creating' → NOT re-fired", !reFires.includes("advanced"));
check("has jobId → NOT re-fired (no double-create)", !reFires.includes("hasjob"));
check("young (<45s) → NOT re-fired", !reFires.includes("young"));
check("re-fired 10s ago (cooldown) → NOT re-fired", !reFires.includes("cooldown"));
check("aged (>1h) → NOT re-fired", !reFires.includes("aged"));
check("no question → NOT re-fired", !reFires.includes("noquestion"));
check("EXACTLY 2 re-fires (stalled + recovered)", reFires.length === 2, `[${reFires.join(", ")}]`);

console.log("\n── side effects ──");
check("aged run marked failed", JSON.parse(m.get("run:aged")).status === "failed");
check("stalled run got reFiredAt stamp", !!JSON.parse(m.get("run:stalled")).reFiredAt);
check("advanced run untouched (still creating)", JSON.parse(m.get("run:advanced")).status === "creating");
check("handler returned a summary", /listed=\d+ reFired=2/.test(body), body);

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money.`);
console.log("NOTE: decision logic proven. Cron firing + scheduled-fn Blobs access are DEPLOY-ONLY.");
process.exit(fail === 0 ? 0 : 1);
