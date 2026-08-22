// verify-refusal-visibility.mjs — "IT TRIED, AND THE CAP STOPPED IT" MUST LEAVE A RECORD.
//
//   node --experimental-test-module-mocks scripts/verify-refusal-visibility.mjs  (npm run test:refusals)
//
// ═══ ZERO MONEY, ZERO NETWORK ═══ Blobs in-memory; pause, chain reads and pricing scripted.
//
// ═══ 🚨 THE GAP THIS CLOSES — HALF A SUBSTRATE, DARK FOR THE PATH THAT MOVES MONEY ═══════════
// Found 2026-08-22 while evaluating Circle's Agent Wallets. The ENTIRE observability chain already
// existed: recordBlocked wrote refusals; agentBreakdown tallied `blocked` and already excluded
// them from `spentUsdc`; agents.mjs shipped `blockedToday` and an `activity` trail commented
// "Includes REFUSALS"; AgentsPanel rendered "N refused" plus the reason line.
//
// ⚠️ AND ONLY _research.mjs EVER PRODUCED ONE. executeAction — send, swap, bridge, vault deposit,
// every fund-moving action — refused by RETURNING `{ok:false, blocked}` and writing nothing. So the
// EXECUTOR's `blockedToday` could only ever read 0. A number that can only be zero reads as
// "nothing was refused" and means "nothing is measured" — the same family as a canary that only
// ever writes PASS.
//
// ⭐ The `code` enum is the piece ADOPTED from Circle's substrate: their DENIED is a terminal state
// carrying an `errorReason` enum, filterable and webhook-notified. We had the record and the UI and
// lacked the enum. Nothing else of their model was taken — see [[circle-agent-wallets-vs-tikpema]].
import { mock } from "node:test";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

const maps = [];
let etagSeq = 0;
let storeThrows = false;
const memStore = (name) => {
  const nm = typeof name === "string" ? name : name?.name ?? "default";
  let m = maps.find((x) => x._n === nm);
  if (!m) { m = new Map(); m._n = nm; maps.push(m); }
  const guard = () => { if (storeThrows) throw new Error("blobs down"); };
  return {
    async get(k, o) { guard(); const e = m.get(k); if (e == null) return null; return o?.type === "json" ? e.value : JSON.stringify(e.value); },
    async getJSON(k) { guard(); return m.get(k)?.value ?? null; },
    async setJSON(k, v, o) { guard(); if (o?.onlyIfNew && m.has(k)) return { modified: false }; m.set(k, { value: v, etag: `e${++etagSeq}` }); return { modified: true }; },
    async setIfNew(k, v) { guard(); if (m.has(k)) return false; m.set(k, { value: v, etag: `e${++etagSeq}` }); return true; },
    async getWithMetadata(k) { guard(); const e = m.get(k); return e ? { data: e.value, etag: e.etag } : null; },
    async list(p) { guard(); const pre = typeof p === "string" ? p : p?.prefix ?? ""; const ks = [...m.keys()].filter((x) => x.startsWith(pre)); return typeof p === "string" ? ks : { blobs: ks.map((key) => ({ key })) }; },
  };
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: memStore } });
let paused = null;
mock.module("../netlify/functions/_pause.mjs", { namedExports: { assertNotPaused: async () => paused } });
const realArc = await import("../netlify/functions/_arc.mjs");
mock.module("../netlify/functions/_arc.mjs", { namedExports: {
  ...realArc, swapCapUsdc: () => 25, sendCapUsdc: () => 25, readTokenBalance: async () => 1000,
}});
const realSwap = await import("../netlify/functions/_swap.mjs");
mock.module("../netlify/functions/_swap.mjs", { namedExports: {
  ...realSwap, valueInUsdc: async ({ amount }) => Number(amount), agentSwap: async () => ({}),
}});

const budget = await import("../netlify/functions/_budget.mjs");
const { executeAction } = await import("../netlify/functions/_actions.mjs");
const { REFUSAL } = budget;

const OWNER = "0x" + "3c".repeat(20);
const rowsFor = () => [...(maps.find((m) => m._n === "data-budget") ?? new Map()).values()]
  .map((e) => e.value).filter((v) => v && v.allowed === false);

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  REFUSAL VISIBILITY — a refusal that is enforced and then forgotten  ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⭐⭐ AN EXECUTOR REFUSAL IS RECORDED, NOT JUST RETURNED");
{
  const r = await executeAction(
    { type: "swap_tokens", tokenIn: "USDC", tokenOut: "EURC", amountIn: 9999, reasoning: "over cap" },
    { walletAddress: OWNER });
  check("the action is still REFUSED — recording must not soften enforcement", r.ok === false && /per-swap limit/.test(r.blocked));
  const rows = rowsFor();
  check("⭐⭐ …and a refusal row now EXISTS. Before this change the executor wrote NOTHING",
    rows.length === 1, `${rows.length} row(s)`);
  const e = rows[0];
  check("⭐ it carries a STRUCTURED CODE, not only prose — the piece adopted from Circle's DENIED",
    e?.code === REFUSAL.PER_SWAP_CAP, `code=${e?.code}`);
  check("⭐ …and the human reason survives alongside it", /per-swap limit of 25 USDC/.test(e?.reason ?? ""));
  check("⭐ …attributed to the EXECUTOR and the step type", e?.agent === "executor" && e?.source === "swap_tokens");
  check("⭐ …and carries the attempted amount as EVIDENCE", Number(e?.amountUsdc) === 9999, `amountUsdc=${e?.amountUsdc}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — 🚨🚨 A REFUSAL MUST MOVE NO COUNTER AND FOOL NO READER");
{
  const day = await budget.daySpend({ owner: OWNER });
  check("🚨 the day counter did NOT advance — a refusal spent nothing", day === 0, `day=${day}`);

  const bd = await budget.agentBreakdown({ owner: OWNER });
  const ex = bd.find((b) => b.agent === "executor") ?? {};
  check("⭐⭐ agentBreakdown counts it as BLOCKED — the tally that could only ever read 0",
    ex.blocked === 1, `blocked=${ex.blocked}`);
  check("🚨🚨 …and does NOT add the attempted amount to spentUsdc — 9999 must not appear as spend",
    (ex.spentUsdc ?? 0) === 0, `spentUsdc=${ex.spentUsdc}`);
  check("⭐ …nor count it as an action performed", (ex.actions ?? 0) === 0, `actions=${ex.actions}`);

  // 🚨 THE ONE THAT COULD COST MONEY. listUnresolvedCharges feeds a REVERSER. If a refusal were
  // selected as an open charge, the sweeper could credit budget back for a spend that never
  // happened — a fail-OPEN credit for nothing. It is excluded because it carries no
  // `confirmation`, which is load-bearing rather than incidental, hence its own assertion.
  const open = await budget.listUnresolvedCharges({ olderThanMs: 0 });
  check("🚨🚨 the step-8 sweeper does NOT see a refusal as an open charge — it feeds a REVERSER",
    open.length === 0, `${open.length} open`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐ EVERY REFUSAL FAMILY IS CLASSIFIED, not just the cap");
{
  maps.forEach((m) => m.clear());
  paused = "agent paused by you";
  const p = await executeAction({ type: "send_usdc", to: "0x" + "11".repeat(20), amountUsdc: 1 }, { walletAddress: OWNER });
  paused = null;
  check("a PAUSED refusal is recorded and coded", p.ok === false && rowsFor()[0]?.code === REFUSAL.PAUSED,
    `code=${rowsFor()[0]?.code}`);

  // ⚠️ THIS ASSERTION WAS WRONG FIRST TIME AND THE CODE WAS RIGHT — kept, because the corrected
  // form documents a real ordering. An unrecognised type is rejected by SHAPE VALIDATION, which
  // runs before any handler, so it codes REFUSED_SHAPE and never reaches the fallthrough.
  // ⭐ REFUSAL.UNKNOWN_STEP is therefore NOT dead: it guards the add-a-type-to-the-validator-but-
  // forget-the-handler case, where a step passes validation and no branch claims it. That is
  // exactly the refusal you would otherwise get with no explanation at all.
  maps.forEach((m) => m.clear());
  const u = await executeAction({ type: "not_a_real_step" }, { walletAddress: OWNER });
  check("an unrecognised type is refused by SHAPE validation, before any handler — and is coded",
    u.ok === false && rowsFor()[0]?.code === REFUSAL.SHAPE, `code=${rowsFor()[0]?.code}`);

  maps.forEach((m) => m.clear());
  const b = await executeAction({ type: "bridge_usdc", amountUsdc: 9999, destination: "base" }, { walletAddress: OWNER });
  check("a per-BRIDGE cap refusal is recorded and coded", b.ok === false && /REFUSED_/.test(rowsFor()[0]?.code ?? ""),
    `code=${rowsFor()[0]?.code}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — 🚨🚨 A FAILED *RECORD* MUST NEVER BECOME AN *ALLOW*");
{
  maps.forEach((m) => m.clear());
  storeThrows = true;
  let threw = null, r = null;
  try {
    r = await executeAction({ type: "swap_tokens", tokenIn: "USDC", tokenOut: "EURC", amountIn: 9999 }, { walletAddress: OWNER });
  } catch (e) { threw = e; }
  storeThrows = false;
  check("🚨🚨 the refusal STILL holds when the audit store is down — observability cannot undo enforcement",
    threw === null && r?.ok === false && /per-swap limit/.test(r?.blocked ?? ""),
    threw ? `threw ${threw.message}` : `ok=${r?.ok}`);
  check("⭐ …and it does not throw either — a logging outage must not surface as an action error", threw === null);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — ⭐ THE READER THE UI ACTUALLY USES");
{
  maps.forEach((m) => m.clear());
  await executeAction({ type: "swap_tokens", tokenIn: "USDC", tokenOut: "EURC", amountIn: 9999 }, { walletAddress: OWNER });
  const trail = await budget.auditLog({ owner: OWNER, date: new Date().toISOString().slice(0, 10) });
  const refusal = trail.find((e) => e.allowed === false);
  check("⭐ the refusal appears in the OWNER'S audit trail — the array agents.mjs ships as `activity`",
    !!refusal, `${trail.length} entr(ies)`);
  check("⭐ …with the reason the panel renders (AgentsPanel: `{!e.allowed && e.reason}`)",
    typeof refusal?.reason === "string" && refusal.reason.length > 0);
  check("⚠️ …and `allowed:false` is present, which is what the panel branches on",
    refusal?.allowed === false);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — 🚨🚨 THE DIRECT-ACTION HANDLERS — the paths the UI's BUTTONS take");
// ═══ WHY THIS SECTION EXISTS — A PROOF THAT FAILED ═══════════════════════════════════════════
// 2026-08-22: with §1–§5 at 19/0 and deployed, an over-cap Send was triggered on prod to prove the
// producer→UI round trip. NOTHING was recorded. `data-budget` held 222 keys before and after.
//
// 🚨 THE SUITE DROVE executeAction; THE SEND BUTTON DOES NOT GO THROUGH executeAction.
// agent-send enforces its own cap and returns json(400) directly — and so do agent-ub-deposit,
// agent-ub-spend and job-run. Nine handlers hold their own enforcement; the four here have NO
// executeAction backstop at all. Testing the function instead of the path the user presses is
// [[binding-tested-across-what-it-binds]], and it cost a failed live proof.
//
// ⭐ SO THESE DRIVE THE HTTP HANDLERS. If a future refusal path is added to a handler and left
// unrecorded, §1–§5 would still be green — only this section can catch it.
{
  const OWNER2 = "0x" + "9d".repeat(20);
  let sessionOk = true;
  mock.module("../netlify/functions/_auth.mjs", { namedExports: {
    requireSession: () => (sessionOk ? { sub: "u1" } : null), requireInternal: () => true,
    internalToken: () => "t", issueSession: () => "t",
  }});
  mock.module("../netlify/functions/_agent-wallets.mjs", { namedExports: {
    ensureOwnerWallet: async () => ({ walletAddress: OWNER2, pending: false }),
    WALLET_PROVISIONING_STATUS: 503, walletProvisioningRefusal: () => ({ error: "provisioning" }),
    WALLET_UNRESOLVABLE_STATUS: 503, walletUnresolvableRefusal: () => ({ error: "unresolvable" }),
    isWalletUnresolvable: () => false,
  }});

  const { handler: sendHandler } = await import("../netlify/functions/agent-send.mjs");
  const rowsFor2 = () => [...(maps.find((m) => m._n === "data-budget") ?? new Map()).values()]
    .map((e) => e.value).filter((v) => v && v.allowed === false);

  maps.forEach((m) => m.clear());
  const res = await sendHandler({
    httpMethod: "POST", headers: {},
    body: JSON.stringify({ to: "0x" + "44".repeat(20), amountUsdc: 9999 }),
  });
  const body = JSON.parse(res.body ?? "{}");

  check("🚨 the over-cap SEND is refused — the exact request that proved nothing on prod",
    res.statusCode === 400 && /exceeds per-transaction limit/.test(body.error ?? ""),
    `${res.statusCode} ${body.error}`);

  const rows = rowsFor2();
  check("🚨🚨 …and it is now RECORDED. On 2026-08-22 this wrote NOTHING and the round trip failed",
    rows.length === 1, `${rows.length} row(s)`);
  check("⭐ coded PER_TX_CAP", rows[0]?.code === REFUSAL.PER_TX_CAP, `code=${rows[0]?.code}`);
  check("⭐ …and sourced to the HANDLER, so the trail says which surface refused",
    rows[0]?.source === "agent-send", `source=${rows[0]?.source}`);

  // ⭐⭐ THE ATTRIBUTION THAT MAKES IT VISIBLE. agents.mjs aggregates under `wallet.walletAddress`.
  // A row written under the SESSION identity instead would exist and never appear on the page —
  // a bug indistinguishable from this one, so it is pinned rather than assumed.
  check("⭐⭐ …keyed to the AGENT WALLET, the same key agents.mjs aggregates under",
    rows[0]?.owner === OWNER2.toLowerCase(), `owner=${rows[0]?.owner}`);

  const bd = await budget.agentBreakdown({ owner: OWNER2 });
  const ex = bd.find((b) => b.agent === "executor") ?? {};
  check("⭐⭐ …so blockedToday would render 1, not 0", ex.blocked === 1, `blocked=${ex.blocked}`);
  check("🚨 …and spentUsdc stays 0 — a refused send spends nothing", (ex.spentUsdc ?? 0) === 0);

  // ⚠️ THE ORDERING THAT WAS PRESERVED. The cap is checked BEFORE the wallet resolves, so an
  // over-cap request gets the CAP message rather than a wallet error. The refuser resolves the
  // owner lazily instead of forcing a reorder — pinned so a future "tidy-up" cannot silently
  // change which refusal a user sees.
  const capAt = (await import("node:fs")).readFileSync("netlify/functions/agent-send.mjs", "utf8");
  check("⚠️ …and the cap is still checked BEFORE ensureOwnerWallet — order unchanged by the logging",
    capAt.indexOf("const cap = sendCapUsdc()") < capAt.indexOf("await ensureOwnerWallet(session)"));

  // ── 🚨🚨 makeRefuser's OWN swallow, driven. ──────────────────────────────────────────────────
  // ⚠️ THIS ASSERTION EXISTS BECAUSE A MUTATION DID NOT FIRE. §4 proves executeAction's private
  // refuse() swallows a failed write — but makeRefuser is a SECOND implementation of that rule, and
  // making it re-throw left the suite fully green. A safety property held in two places needs
  // testing in two places; one of them was decorative.
  maps.forEach((m) => m.clear());
  storeThrows = true;
  let threw2 = null, res2 = null;
  try {
    res2 = await sendHandler({
      httpMethod: "POST", headers: {},
      body: JSON.stringify({ to: "0x" + "44".repeat(20), amountUsdc: 9999 }),
    });
  } catch (e) { threw2 = e; }
  storeThrows = false;
  check("🚨🚨 the SEND is still refused when the audit store is down — logging cannot undo enforcement",
    threw2 === null && res2?.statusCode === 400,
    threw2 ? `threw ${threw2.message}` : `status=${res2?.statusCode}`);
  check("⭐ …and the caller still gets the cap message, not a logging error",
    /exceeds per-transaction limit/.test(JSON.parse(res2?.body ?? "{}").error ?? ""));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
