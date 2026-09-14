// verify-plan-balance-preflight.mjs — THE PLAN PATH REFUSES A PLAN THE WALLET CANNOT FUND AT PLAN
// STAGE, NAMING BOTH FIGURES, AND EXECUTES NOTHING — driven through the REAL handler under mocks.
//
// ═══ WHY A HANDLER-LEVEL SUITE ══════════════════════════════════════════════════════════════════
// 404628d put the balance pre-flight on the agent PANEL endpoint only. The plan path
// (agent-execute-plan) had the seal and the cap but no pre-flight — Circle's INSUFFICIENT_TOKEN
// was the only backstop, and it fires MID-PLAN, after steps 1..k-1 have already burned. The
// agreed rule: refuse the WHOLE plan before step 1, or not at all.
//
// ⭐ RUN AGAINST THE PRE-CHANGE HANDLER FIRST. Every section below except §4 was RED against the
// tree before the pre-flight was wired (recorded in PROGRESS); a guard validated only against fixed
// code proves nothing. [[never-mock-the-function-under-test]] — the mocks here are the handler's
// BOUNDARIES (session, wallet, chain read, IRIS quote, executor, blobs); the handler is real.
//
// ═══ THE FOUR CASES ═══════════════════════════════════════════════════════════════════════════
//   §1 refusal — balance 3.65, plan bridges 2 + 2 (fees 0.054129 each) → 402, BOTH figures at 6 dp,
//      executeAction NEVER called, "whole plan" in the sentence.
//   §2 pass — balance 10 → no refusal, both steps reach the executor.
//   §3 read fails — balanceOf throws → NOT a shortfall: no 402, executor reached, balanceChecked:false.
//   §4 ⛔ THE MONITOR'S PROBE IS UNCHANGED — a 200 USDC plan over the per-bridge cap from a poor wallet
//      must still read as the CAP refusal at results[0] (plan-path-watch judges HEALTHY on that
//      sentence), never as the balance sentence. This is the ordering that keeps the */30 monitor quiet.

import { mock } from "node:test";

let pass = 0, fail = 0;
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 66 - t.length))}`);
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
};

const OWNER = "0xc54d47211997aca90ef4fcfbc742a3b511b4e621";
const BURN = "0x" + "b1".repeat(32);
process.env.SESSION_SECRET ||= ["plan", "balance", "preflight", "suite", "not", "a", "credential"].join("-");
process.env.AGENT_BRIDGE_CAP_USDC = "50";
process.env.PERIOD_CEILING_USDC = "1000";

// ── boundaries ──
const stores = {};
const mkStore = (name) => {
  stores[name] ??= new Map();
  const m = stores[name];
  return {
    get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null),
    getWithMetadata: async (k) => (m.has(k) ? { data: JSON.parse(m.get(k)), etag: "e" } : null),
    setJSON: async (k, v) => void m.set(k, JSON.stringify(v)),
    list: async () => ({ blobs: [] }),
  };
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: mkStore } });
mock.module("../netlify/functions/_auth.mjs", { namedExports: { requireSession: () => ({ address: OWNER, method: "metamask" }), internalToken: () => "t", requireInternal: () => true } });
const REAL_WALLETS = await import("../netlify/functions/_agent-wallets.mjs");
mock.module("../netlify/functions/_agent-wallets.mjs", { namedExports: { ...REAL_WALLETS, ensureOwnerWallet: async () => ({ walletAddress: OWNER, pending: false }) } });
const REAL_BUDGET = await import("../netlify/functions/_budget.mjs");
mock.module("../netlify/functions/_budget.mjs", {
  namedExports: { ...REAL_BUDGET, daySpend: async () => 0, budgetConfig: () => ({ ...REAL_BUDGET.budgetConfig(), PERIOD_CEILING_USDC: 1000 }) },
});
mock.module("../netlify/functions/_quote-record.mjs", { namedExports: { safeQuoteId: (x) => x ?? null, markQuoteUsed: async () => true } });
mock.module("../netlify/functions/_bridge-record.mjs", { namedExports: { recordBridge: async () => {}, recordPendingBridge: async () => {} } });

// the chain read the pre-flight makes: balanceOf → minor units, or a throw
let balanceMinor = 0n;
let readThrows = false;
mock.module("../netlify/functions/_predict.mjs", {
  namedExports: { publicClient: () => ({ readContract: async () => { if (readThrows) throw new Error("rpc down"); return balanceMinor; } }) },
});

// the executor, instrumented — the whole point is whether it is reached
let execCalls = [];
const REAL_ACTIONS = await import("../netlify/functions/_actions.mjs");
mock.module("../netlify/functions/_actions.mjs", {
  namedExports: {
    ...REAL_ACTIONS,
    executeAction: async (step) => {
      execCalls.push(step);
      return { ok: true, kind: "bridge_usdc", state: "submitted", burnHash: BURN, tx: `x/${BURN}`, destination: step.destination, feeUsdc: 0.054129, netUsdc: step.amountUsdc, recipient: OWNER };
    },
  },
});

// IRIS quote — a fixture fee large enough to matter (0.054129 per bridge)
const QUOTE_FEE_MINOR = 54_129n;
const FAR_DEADLINE = 4102444800;
const SIGNED_QUOTE = "0x01" + "00".repeat(31) + "20" + "00" + BigInt(FAR_DEADLINE).toString(16).padStart(62, "0") + "ab".repeat(32);
globalThis.fetch = async (url) => {
  if (String(url).includes("/v2/quote/burn/")) {
    return { ok: true, status: 200, json: async () => ({
      signedQuote: SIGNED_QUOTE, issuedAt: FAR_DEADLINE - 120, expiry: { mode: "TIMESTAMP", expiresAt: FAR_DEADLINE },
      feeTotalAmount: QUOTE_FEE_MINOR.toString(), feeToken: "0x3600000000000000000000000000000000000000",
    }) };
  }
  return { status: 202, ok: true };
};

const { handler } = await import("../netlify/functions/agent-execute-plan.mjs");
const post = (body) => handler({ httpMethod: "POST", headers: {}, blobs: null, body: JSON.stringify(body) });
const parse = (r) => ({ status: r.statusCode, body: JSON.parse(r.body) });

// quote-then-post: seal every bridge step, then execute with the tokens (the real client's flow)
async function run(plan) {
  execCalls = [];
  const q = parse(await post({ plan, quoteOnly: true }));
  if (!q.body.requoted) return { q, r: q };
  const quoteTokens = Object.fromEntries(Object.entries(q.body.stepDisclosures).map(([i, d]) => [i, d.quoteToken]));
  const ackTokens = Object.fromEntries(Object.entries(q.body.stepDisclosures).filter(([, d]) => d.ackToken).map(([i, d]) => [i, d.ackToken]));
  const r = parse(await post({ plan, quoteTokens, ackTokens }));
  return { q, r };
}
const twoBridges = [
  { type: "bridge_usdc", amountUsdc: 2, destination: "base", reasoning: "t" },
  { type: "bridge_usdc", amountUsdc: 2, destination: "ethereum", reasoning: "t" },
];

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — 🚨 REFUSAL: balance 3.65, plan needs 4.108258 — whole plan refused, nothing executes");
{
  balanceMinor = 3_650_000n; readThrows = false;
  const { q, r } = await run(twoBridges);
  check("⭐ the quote step still seals (the refusal is at execution, plan stage)", q.body.requoted === true && !!q.body.stepDisclosures?.[0]?.quoteToken);
  check("🚨 HTTP 402", r.status === 402, `got ${r.status}`);
  check("🚨 executed:false and executeAction NEVER called", r.body.executed === false && execCalls.length === 0, `calls=${execCalls.length}`);
  const msg = String(r.body.error ?? r.body.blocked ?? "");
  console.log(`     → "${msg}"`);
  check("⭐⭐ the sentence names HAVE at full 6 dp — 3.650000", /3\.650000/.test(msg));
  check("⭐⭐ …and NEED = 2 + 2 + 0.054129 + 0.054129 = 4.108258, at full 6 dp", /4\.108258/.test(msg));
  check("⭐ it says the WHOLE PLAN is refused and nothing was executed", /whole plan/i.test(msg) && /Nothing was executed/i.test(msg));
  check("⭐ `error` and `blocked` both carry it (client throws on error; panel renders blocked)", r.body.error && r.body.blocked === r.body.error);
  check("⭐ structural: insufficient:true, have/need numbers, NOT priceUnavailable", r.body.insufficient === true && r.body.have === 3.65 && Math.abs(r.body.need - 4.108258) < 1e-9 && !r.body.priceUnavailable);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⭐ PASS: balance 10 → no refusal, both steps reach the executor");
{
  balanceMinor = 10_000_000n; readThrows = false;
  const { r } = await run(twoBridges);
  check("⭐ HTTP 200", r.status === 200, `got ${r.status}`);
  check("⭐ executeAction called for BOTH steps", execCalls.length === 2, `calls=${execCalls.length}`);
  check("⭐ no balance sentence anywhere in the body", !/Insufficient funds/.test(JSON.stringify(r.body)));
  check("⭐ balanceChecked:true is stated", r.body.balanceChecked === true, `balanceChecked=${r.body.balanceChecked}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⛔ READ FAILS: not a shortfall — the executor is reached and the body says unchecked");
{
  balanceMinor = 0n; readThrows = true;
  const { r } = await run(twoBridges);
  check("⛔ NOT a 402 — an unreadable balance must not render as 'you do not have enough'", r.status !== 402 && !/Insufficient funds/.test(JSON.stringify(r.body)), `got ${r.status}`);
  check("⭐ the executor is reached (Circle's backstop remains the last line)", execCalls.length === 2, `calls=${execCalls.length}`);
  check("⭐ balanceChecked:false is stated — an unread balance is never reported as checked", r.body.balanceChecked === false, `balanceChecked=${r.body.balanceChecked}`);
  readThrows = false;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⛔ THE MONITOR'S PROBE: 200 over a 50 cap from a 3.65 wallet reads as the CAP refusal, not the balance");
{
  balanceMinor = 3_650_000n; readThrows = false;
  const probe = [{ type: "bridge_usdc", amountUsdc: 200, destination: "base", reasoning: "plan-path-watch probe" }];
  const { r } = await run(probe);
  const capMsg = String(r.body?.results?.[0]?.blocked ?? "");
  check("⭐ results[0].blocked is the per-bridge cap sentence plan-path-watch judges HEALTHY on", /exceeds per-bridge limit of 50/.test(capMsg), capMsg || JSON.stringify(r.body).slice(0, 120));
  check("⛔ …and NOT the balance sentence at top level", !/Insufficient funds/.test(String(r.body.blocked ?? r.body.error ?? "")));
  check("⭐ nothing executed", execCalls.length === 0);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — ⛔ THE FAIL-OPEN IS CARRIED TO THE PRE-PRESS BODIES (what the render suite then shows)");
{
  // plan re-quote card (agent-execute-plan quoteOnly)
  balanceMinor = 10_000_000n; readThrows = false;
  const ok = parse(await post({ plan: twoBridges, quoteOnly: true }));
  check("⭐ requote body says balanceChecked:true when the read worked", ok.body.balanceChecked === true, `balanceChecked=${ok.body.balanceChecked}`);
  readThrows = true;
  const bad = parse(await post({ plan: twoBridges, quoteOnly: true }));
  check("⛔ requote body says balanceChecked:false when the read failed — and still quotes (a read, never a refusal here)",
    bad.body.balanceChecked === false && bad.body.requoted === true, `balanceChecked=${bad.body.balanceChecked} requoted=${bad.body.requoted}`);
  readThrows = false;

  // the panel / chat single-action CONFIRM endpoint (agent-bridge quoteOnly): the flag rides INSIDE quote
  const { handler: bridgeHandler } = await import("../netlify/functions/agent-bridge.mjs");
  const bpost = (body) => bridgeHandler({ httpMethod: "POST", headers: {}, blobs: null, body: JSON.stringify(body) });
  balanceMinor = 10_000_000n;
  const q1 = parse(await bpost({ amountUsdc: 1, destination: "base", quoteOnly: true }));
  check("⭐ agent-bridge quoted body: quote.balanceChecked:true when read", q1.body.quoted === true && q1.body.quote?.balanceChecked === true, `quoted=${q1.body.quoted} inner=${q1.body.quote?.balanceChecked}`);
  readThrows = true;
  const q2 = parse(await bpost({ amountUsdc: 1, destination: "base", quoteOnly: true }));
  check("⛔ agent-bridge quoted body: quote.balanceChecked:false when the read failed — still quoted, not refused",
    q2.body.quoted === true && q2.body.quote?.balanceChecked === false, `quoted=${q2.body.quoted} inner=${q2.body.quote?.balanceChecked}`);
  readThrows = false;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — ⭐⭐ A TERMINAL REFUSAL IS A FIELD, AND THE SENTENCE IS DERIVED FROM IT (phase 1)");
{
  const { refusalSentence, capRefusal, balanceRefusal, priceUnavailableRefusal, ceilingRefusal, REFUSAL_KIND } = await import("../netlify/functions/_refusal.mjs");
  // (a) the handler's cap refusal carries the field, and its sentence IS the derivation of that field
  balanceMinor = 3_650_000n; readThrows = false;
  const probe = [{ type: "bridge_usdc", amountUsdc: 200, destination: "base", reasoning: "plan-path-watch probe" }];
  const { r } = await run(probe);
  const res0 = r.body?.results?.[0];
  check("⭐ results[0].refusal is present on the cap refusal", !!res0?.refusal, JSON.stringify(res0?.refusal));
  check("⭐ …kind:cap with valuedUsdc, capUsdc, capLabel, feeUsdc", res0?.refusal?.kind === "cap" && res0.refusal.valuedUsdc > 200 && res0.refusal.capUsdc === 50 && res0.refusal.capLabel === "bridge" && res0.refusal.feeUsdc === 0.054129,
    JSON.stringify(res0?.refusal));
  check("⭐⭐ results[0].blocked === refusalSentence(results[0].refusal) — derived, not written beside it", res0?.blocked === refusalSentence(res0?.refusal), res0?.blocked);
  check("⭐ the sentence is byte-identical to the pre-field wording the monitor's regex reads", /^step ~200\.05 exceeds per-bridge limit of 50 USDC$/.test(res0?.blocked ?? ""), res0?.blocked);
  // (b) MUTATE THE FIELD → THE SENTENCE MUST CHANGE (a sentence written alongside would not)
  const mutated = refusalSentence({ ...res0.refusal, valuedUsdc: 300.05 });
  check("⭐⭐ mutating valuedUsdc changes the sentence", mutated !== res0.blocked && /300\.05/.test(mutated), mutated);
  check("⭐⭐ mutating capUsdc changes the sentence", /limit of 75 USDC/.test(refusalSentence({ ...res0.refusal, capUsdc: 75 })));
  // (c) the plan-level balance refusal carries its field and derives its sentence too
  const { r: bal } = await run(twoBridges);
  check("⭐ the balance refusal carries refusal:{kind:balance, have, need}", bal.body?.refusal?.kind === "balance" && bal.body.refusal.have === 3.65 && Math.abs(bal.body.refusal.need - 4.108258) < 1e-9, JSON.stringify(bal.body?.refusal));
  check("⭐⭐ its blocked === refusalSentence(refusal)", bal.body?.blocked === refusalSentence(bal.body?.refusal));
  check("⭐⭐ mutating `have` changes the balance sentence", /have 1\.000000 USDC/.test(refusalSentence({ ...bal.body.refusal, have: 1 })));
  // (d) priceUnavailable: the field is structurally distinct from balance and cap
  const pu = priceUnavailableRefusal({ step: 0, detail: "quote 503" });
  check("⭐ priceUnavailable derives its sentence and is its own kind", pu.kind === REFUSAL_KIND.PRICE_UNAVAILABLE && /step 1: cannot reach the bridge pricing service right now \(quote 503\)/.test(refusalSentence(pu)));
  check("⭐ ceiling derives its sentence", /would exceed daily agent-spend ceiling of 1000 USDC \(already committed ~2\.50 today\)/.test(refusalSentence(ceilingRefusal({ ceilingUsdc: 1000, committedUsdc: 2.5 }))));
  check("⛔ an unknown kind derives NO sentence (never a plausible label)", refusalSentence({ kind: "mystery" }) === null && refusalSentence(null) === null);
  // (e) and the handler no longer WRITES any of these sentences itself — the only producer is _refusal.mjs
  const { readFileSync } = await import("node:fs");
  const handlerSrc = readFileSync("netlify/functions/agent-execute-plan.mjs", "utf8").replace(/^\s*\/\/.*$/gm, "");
  check("⛔ agent-execute-plan writes NO cap / ceiling / pricing sentence of its own (no drift pair)",
    !/exceeds per-\$\{/.test(handlerSrc) && !/would exceed daily agent-spend ceiling of \$\{/.test(handlerSrc) && !/cannot reach the bridge pricing service right now \(\$\{/.test(handlerSrc));
  void capRefusal; void balanceRefusal;
}

console.log(`\n${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail ? 1 : 0);
