#!/usr/bin/env node
// verify-ub-withdraw.mjs — the UB exit sweeper, every branch driven by injection.
//
// ═══ 🚨 WHAT THIS GUARDS ═══════════════════════════════════════════════════════════════
// The exit is two on-chain calls ~7 days apart, and the SWEEPER drives the second. If the
// sweeper is wrong, the failure is not an error message — it is a user who asked for their
// money back, was told it was coming, and never receives it. Every assertion below exists
// because the corresponding silence would look exactly like success.
//
//   node --experimental-test-module-mocks scripts/verify-ub-withdraw.mjs

import { mock } from "node:test";

const MEM = new Map();
let STORE_DOWN = false;
mock.module("@netlify/blobs", { namedExports: { getStore: () => ({
  setJSON: async (k, v) => { MEM.set(k, JSON.parse(JSON.stringify(v))); },
  get: async (k) => { if (STORE_DOWN) throw new Error("store down"); return MEM.get(k) ?? null; },
  list: async ({ prefix }) => {
    if (STORE_DOWN) throw new Error("store down");
    return { blobs: [...MEM.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
  },
}) } });
mock.module("../netlify/functions/_blobs.mjs",
  { namedExports: { connectBlobs: () => {} } });

let EXIT = { readable: true, availableAtomic: "2000000", withdrawableAtomic: "0", withdrawableUsdc: "0", approxDelayDays: 7.1 };
let COMPLETE = async () => ({ step: "not-yet-matured", withdrawableUsdc: "0", approxDelayDays: 7.1 });
mock.module("../netlify/functions/_ubwithdraw.mjs", { namedExports: {
  readExitState: async () => EXIT,
  ubCompleteWithdrawal: async (a) => COMPLETE(a),
} });

const R = await import("../netlify/functions/_ubwithdraw-record.mjs");
const { handler } = await import("../netlify/functions/ub-withdraw-sweep.mjs");
const OWNER = "0xabc0000000000000000000000000000000000001";
const run = async () => JSON.parse((await handler({})).body);

let pass = 0, fail = 0;
const ck = (l, c, e = "") => { console.log(`  ${c ? "✅" : "❌"} ${l}${e ? ` — ${e}` : ""}`); c ? pass++ : fail++; };

console.log("\n── empty store ──");
let r = await run();
ck("clean tick, nothing open", r.ok === true && r.open === 0 && r.completed === 0);

console.log("\n── WAITING, nothing matured (every tick for ~7 days) ──");
await R.createRecord({ owner: OWNER, amountUsdc: "1", withdrawalId: "w1" });
await R.patchRecord({ owner: OWNER, withdrawalId: "w1", fields: { state: R.STATE.WAITING, amountAtomic: "1000000" } });
r = await run();
ck("counted as waiting, NOT an error", r.waiting === 1 && r.failed === 0, r.details[0].result);

console.log("\n── matured → completes ──");
EXIT = { ...EXIT, withdrawableAtomic: "1000000", withdrawableUsdc: "1" };
COMPLETE = async () => ({ step: "completed", txHash: "0xdead", movedUsdc: "1", landedIn: OWNER });
r = await run();
ck("completed once", r.completed === 1, r.details[0].result);
const done = await R.readRecord({ owner: OWNER, withdrawalId: "w1" });
ck("record state = completed", done.state === "completed");
ck("stillNeedsAgentWithdraw stays TRUE (completed != user has funds)", done.stillNeedsAgentWithdraw === true);
ck("landedIn records the SCA, not the user", done.landedIn === OWNER);
r = await run();
ck("next tick does NOT re-complete it", r.open === 0 && r.completed === 0);

console.log("\n── INITIATING + chain shows it landed → reconciled ──");
await R.createRecord({ owner: OWNER, amountUsdc: "1", withdrawalId: "w2" });
await R.patchRecord({ owner: OWNER, withdrawalId: "w2", fields: { amountAtomic: "1000000" } });
COMPLETE = async () => ({ step: "not-yet-matured", withdrawableUsdc: "1" });
r = await run();
ck("reconciled to waiting rather than stranded", r.reconciled === 1, r.details[0].result);

console.log("\n── INITIATING + chain UNREADABLE → must NOT be marked failed ──");
EXIT = { readable: false, detail: "rpc down" };
await R.patchRecord({ owner: OWNER, withdrawalId: "w2", fields: { state: R.STATE.INITIATING } });
r = await run();
ck("counted as failed-this-tick but record left OPEN", r.failed === 1, r.details[0].result);
const w2 = await R.readRecord({ owner: OWNER, withdrawalId: "w2" });
ck("state is still INITIATING, not failed", w2.state === "initiating", w2.state);
EXIT = { readable: true, availableAtomic: "2000000", withdrawableAtomic: "0", withdrawableUsdc: "0" };
r = await run();
ck("so a later tick still sees it", r.open >= 1);

console.log("\n── a throwing completion leaves the record open for retry ──");
await R.patchRecord({ owner: OWNER, withdrawalId: "w2", fields: { state: R.STATE.WAITING } });
COMPLETE = async () => { throw new Error("circle 500"); };
r = await run();
ck("error counted, not swallowed", r.failed === 1, r.details[0].result);
const w2b = await R.readRecord({ owner: OWNER, withdrawalId: "w2" });
ck("lastError recorded on the record", /circle 500/.test(w2b.lastError ?? ""));
ck("state STILL waiting → retried next tick", w2b.state === "waiting");

console.log("\n── ⭐⭐ STORE DOWN must not report a clean tick ──");
STORE_DOWN = true;
r = await run();
ck("ok:false with a reason, not a clean sweep", r.ok === false && r.reason === "store-unreadable");

console.log(`\n  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
