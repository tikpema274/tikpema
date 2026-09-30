// verify-ub-withdraw-record-reads.mjs — nothing is read back before money moves, and a failed read is never
// "the record vanished".
//
//   node --experimental-test-module-mocks scripts/verify-ub-withdraw-record-reads.mjs   (npm run test:ubrecordreads)
//
// ═══ ZERO MONEY ═══ Blobs in-memory (with a read-THROWS and a read-returns-NULL switch); the chain calls are
// scripted; the REAL _ubwithdraw-record.mjs, ub-withdraw.mjs and ub-withdraw-sweep.mjs run.
//
// ═══ THE DEFECT (sweep, 2026-09-30) ══════════════════════════════════════════════════════════════════
// patchRecord read the record with `.catch(() => null)` and returned null for BOTH "unreadable" and
// "vanished"; every caller ignored the null.
//   · ub-withdraw wrote the record, then PATCHED the maturity fields on (a read-back), then initiated. A
//     failed — or merely eventually-consistent — read skipped the patch silently and the withdrawal was
//     initiated anyway, leaving a record with no maturesApprox: the overdue alert could never fire for it.
//   · the post-initiation patch (WAITING + initiateTxHash) could vanish the same way, silently.
//   · the sweeper, after a SUCCESSFUL on-chain complete, could fail its patch silently and still report
//     "completed" — the record stays WAITING, the next tick re-completes (the chain refuses: "N;O").
// ⭐ T's decisions (2026-09-30): the maturity fields go into createRecord's SINGLE write — nothing is read
//   back before money moves; a post-initiation patch that cannot land → still 202 (the withdrawal DID
//   start; saying otherwise would be worse) with a LOUD log. patchRecord THROWS on a failed read; null only
//   when the record is genuinely absent. [[absence-must-never-read-as-safe]]
import { mock } from "node:test";

let pass = 0, fail = 0;
const ck = (l, c, e = "") => { console.log(`  ${c ? "✅" : "❌"} ${l}${e ? ` — ${e}` : ""}`); c ? pass++ : fail++; };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

const MEM = new Map();
const events = [];                 // ordered: ["get", key] / ["set", key, value] / ["initiate"] / ["complete"]
let GET_THROWS = false;            // every get() throws (a Blobs outage)
const GET_NULL = new Set();        // keys whose get() returns null (eventual consistency: just written, not yet visible)
mock.module("@netlify/blobs", { namedExports: { getStore: () => ({
  setJSON: async (k, v) => { events.push(["set", k, JSON.parse(JSON.stringify(v))]); MEM.set(k, JSON.parse(JSON.stringify(v))); },
  get: async (k) => { events.push(["get", k]); if (GET_THROWS) throw new Error("store down"); if (GET_NULL.has(k)) return null; return MEM.get(k) ?? null; },
  list: async ({ prefix }) => ({ blobs: [...MEM.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }),
}) } });
mock.module("../netlify/functions/_blobs.mjs", { namedExports: { connectBlobs: () => {} } });
mock.module("../netlify/functions/_auth.mjs", { namedExports: { requireSession: () => ({ address: "0xowner", method: "passkey" }) } });
const REAL_WALLETS = await import("../netlify/functions/_agent-wallets.mjs");
const OWNER = "0xabc0000000000000000000000000000000000001";
mock.module("../netlify/functions/_agent-wallets.mjs", { namedExports: { ...REAL_WALLETS,
  ensureOwnerWallet: async () => ({ walletAddress: OWNER, pending: false }) } });
let onInitiate = () => {};
let COMPLETE = async () => ({ step: "not-yet-matured", withdrawableUsdc: "0" });
mock.module("../netlify/functions/_ubwithdraw.mjs", { namedExports: {
  readExitState: async () => ({ readable: true, availableAtomic: "5000000", availableUsdc: "5", withdrawableAtomic: "0",
    withdrawableUsdc: "0", delayBlocks: "1209600", approxDelayDays: 7.1, delayProvenance: "test" }),
  ubInitiateWithdrawal: async () => { events.push(["initiate"]); onInitiate(); return { txHash: "0xINIT", step: "initiated" }; },
  ubCompleteWithdrawal: async (a) => { events.push(["complete"]); return COMPLETE(a); },
} });

const R = await import("../netlify/functions/_ubwithdraw-record.mjs");
const { handler: withdraw } = await import("../netlify/functions/ub-withdraw.mjs");
const { handler: sweep } = await import("../netlify/functions/ub-withdraw-sweep.mjs");
const post = async () => { const r = await withdraw({ httpMethod: "POST", body: JSON.stringify({ amountUsdc: 1 }), headers: {} }); return { status: r.statusCode, body: JSON.parse(r.body) }; };
const reset = () => { MEM.clear(); events.length = 0; GET_THROWS = false; GET_NULL.clear(); onInitiate = () => {}; };
const capture = async (fn) => { const errs = [], e0 = console.error, l0 = console.log; console.error = (...a) => errs.push(a.join(" ")); console.log = () => {}; try { return { out: await fn(), errs }; } finally { console.error = e0; console.log = l0; } };

section("1 — patchRecord / readRecord: a failed read THROWS; null only when absent");
{
  reset();
  await R.createRecord({ owner: OWNER, amountUsdc: 1, withdrawalId: "w1" });
  GET_THROWS = true; events.length = 0;
  let threw = null; try { await R.patchRecord({ owner: OWNER, withdrawalId: "w1", fields: { state: "waiting" } }); } catch (e) { threw = e; }
  ck("⭐⭐ patchRecord on an UNREADABLE record → throws (not null)", !!threw, threw ? threw.message : "returned without throwing");
  ck("⭐ …and writes nothing", !events.some(([t]) => t === "set"), JSON.stringify(events));
  let threwR = null; try { await R.readRecord({ owner: OWNER, withdrawalId: "w1" }); } catch (e) { threwR = e; }
  ck("⭐ readRecord on an unreadable record → throws (not null)", !!threwR);
  GET_THROWS = false;
  ck("patchRecord on a genuinely ABSENT record → null, nothing written", (await R.patchRecord({ owner: OWNER, withdrawalId: "nope", fields: { x: 1 } })) === null && !MEM.has(R.key(OWNER, "nope")));
  ck("readRecord on an absent record → null", (await R.readRecord({ owner: OWNER, withdrawalId: "nope" })) === null);
}

section("2 — ⭐⭐ ub-withdraw: the maturity is in the ONE record write; nothing is read back before money moves");
{
  reset();
  const { out: r } = await capture(post);
  ck("202 started", r.status === 202 && r.body.status === "started", JSON.stringify(r.body));
  const iInit = events.findIndex(([t]) => t === "initiate");
  const recKey = R.key(OWNER, r.body.withdrawalId);
  const before = events.slice(0, iInit);
  const sets = before.filter(([t, k]) => t === "set" && k === recKey);
  ck("⭐⭐ exactly ONE write of the record before the chain call", sets.length === 1, `writes before initiate: ${sets.length}`);
  const created = sets[0]?.[2] ?? {};
  ck("⭐⭐ …and it already carries amountAtomic, delayBlocks, approxDelayDays and maturesApprox",
    created.amountAtomic === "1000000" && created.delayBlocks === "1209600" && created.approxDelayDays === 7.1 && !!created.maturesApprox,
    JSON.stringify({ amountAtomic: created.amountAtomic, delayBlocks: created.delayBlocks, approxDelayDays: created.approxDelayDays, maturesApprox: created.maturesApprox }));
  ck("⭐⭐ NO read of the record between its write and the chain call", !events.slice(events.findIndex(([t, k]) => t === "set" && k === recKey), iInit).some(([t, k]) => t === "get" && k === recKey),
    JSON.stringify(events.map(([t, k]) => `${t}:${k ?? ""}`)));
  ck("the response's maturesApprox is the recorded one", r.body.maturesApprox === created.maturesApprox);
  ck("after initiation the record is WAITING with the tx hash", MEM.get(recKey)?.state === "waiting" && MEM.get(recKey)?.initiateTxHash === "0xINIT", JSON.stringify(MEM.get(recKey)));

}

section("3 — the post-initiation patch cannot land → STILL 202 (it started), with a LOUD log");
for (const [label, arm] of [["the read THROWS", () => { GET_THROWS = true; }], ["the fresh record reads as NULL (eventual)", () => { for (const k of MEM.keys()) GET_NULL.add(k); }]]) {
  reset();
  onInitiate = arm;
  const { out: r, errs } = await capture(post);
  ck(`⭐⭐ ${label} → 202 started, the tx hash returned (never 'failed' — it DID start)`, r.status === 202 && r.body.status === "started" && r.body.txHash === "0xINIT", JSON.stringify({ status: r.status, body: r.body }));
  const loud = errs.find((l) => l.includes(r.body.withdrawalId) && l.includes("0xINIT"));
  ck(`⭐⭐ …and a LOUD console.error naming the withdrawal and its tx hash`, !!loud, errs.join(" | ") || "no error log");
  ck("…the record is left INITIATING (the sweeper reconciles it against the chain)", MEM.get(R.key(OWNER, r.body.withdrawalId))?.state === "initiating");
}

section("4 — the sweeper: an on-chain COMPLETE whose record patch fails is not reported as 'completed'");
{
  reset();
  await R.createRecord({ owner: OWNER, amountUsdc: 1, withdrawalId: "w9" });
  MEM.set(R.key(OWNER, "w9"), { ...MEM.get(R.key(OWNER, "w9")), state: "waiting", initiateTxHash: "0xI", maturesApprox: new Date(Date.now() + 86400e3).toISOString() });
  COMPLETE = async () => { GET_THROWS = true; return { step: "completed", txHash: "0xDONE", landedIn: "sca", movedUsdc: "1" }; };
  const { out, errs } = await capture(() => sweep({}));
  GET_THROWS = false;
  const body = JSON.parse(out.body);
  const d = (body.details ?? []).find((x) => x.withdrawalId === "w9");
  ck("⭐⭐ NOT counted as a clean 'completed' (the record says WAITING)", d?.result !== "completed", JSON.stringify(d));
  ck("⭐ …the note names the on-chain completion and its tx hash", /record/i.test(d?.result ?? "") && JSON.stringify(d).includes("0xDONE"), JSON.stringify(d));
  ck("⭐ …and a LOUD log carries the tx hash", errs.some((l) => l.includes("w9") && l.includes("0xDONE")), errs.join(" | "));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-ub-withdraw-record-reads — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
