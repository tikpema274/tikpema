// verify-bridge-receipts.mjs — THE DIRECT-PATH BRIDGE RECEIPT, FAULT-INJECTED.
//
//   node --experimental-test-module-mocks scripts/verify-bridge-receipts.mjs
//
// ═══ WHY THIS SUITE EXISTS ═══════════════════════════════════════════════════════════════════
// The deadline-escalation branch fires ONLY when a forwarded mint stalls. A stall cannot be
// summoned on demand, so in normal use that branch is UNTESTED BY CONSTRUCTION — it would first
// execute in production, on the one occasion a user is already having a bad time. That is the
// same shape as the ReferenceError that could only ever have fired on a refusal path nobody
// exercised. So every branch here is reached by INJECTION rather than by luck:
//   · IRIS that never confirms          -> deadline / poll-exhaustion
//   · IRIS that confirms, chain that errors -> must NOT become "measured"
//   · IRIS that confirms, chain that disagrees -> mint_unverified, loud
//   · a Blobs store that throws on write -> the burn handler must still succeed
//
// ⭐ THE INVARIANT UNDER TEST: `delivery` advances to "measured" on EXACTLY ONE path — a
// destination-chain read that verified. Every other exit leaves it "predicted". A failed chain
// read must never let arithmetic (amount − maxFee) masquerade as an observation.
//
// Zero network. Zero money. Zero real Blobs.

import { mock } from "node:test";

// Loop knobs BEFORE the settler is imported — it reads them at module scope. 1ms polls make the
// four-minute deadline reachable in milliseconds.
process.env.BRIDGE_SETTLE_POLL_MS = "1";
process.env.BRIDGE_SETTLE_MAX_POLLS = "50";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret-for-internal-token";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

// ── a Circle whose answer we choose ──────────────────────────────────────────────────────────
// The reconcile job's entire job is acting on what Circle says about a transaction id. Mocking the
// SDK factory (rather than _circle.mjs) keeps `circle()`'s own env guard under test and leaves ONE
// definition of "landed" — COMPLETE — shared with waitForTx.
process.env.CIRCLE_API_KEY = process.env.CIRCLE_API_KEY || "test-key";
process.env.CIRCLE_ENTITY_SECRET = process.env.CIRCLE_ENTITY_SECRET || "test-entity-secret";
let circleAnswer = null; // an object -> the transaction; an Error -> the API throws
mock.module("@circle-fin/developer-controlled-wallets", {
  namedExports: {
    initiateDeveloperControlledWalletsClient: () => ({
      getTransaction: async ({ id }) => {
        if (circleAnswer instanceof Error) throw circleAnswer;
        return { data: { transaction: { id, ...(circleAnswer || {}) } } };
      },
    }),
  },
});

// ── an in-memory Blobs, with failure injection ───────────────────────────────────────────────
// Mocking the STORE rather than _bridge-receipts.mjs keeps the real key layout, the real
// owner cross-check and the real never-throw wrapper under test.
const mem = new Map();
let failMode = null; // null | "set" | "get" | "list"
mock.module("@netlify/blobs", {
  namedExports: {
    getStore: () => ({
      setJSON: async (k, v) => {
        if (failMode === "set") throw new Error("injected Blobs set failure");
        mem.set(k, JSON.stringify(v));
      },
      get: async (k) => {
        if (failMode === "get") throw new Error("injected Blobs get failure");
        const s = mem.get(k);
        return s ? JSON.parse(s) : null;
      },
      list: async ({ prefix } = {}) => {
        if (failMode === "list") throw new Error("injected Blobs list failure");
        return { blobs: [...mem.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((key) => ({ key })) };
      },
      // The reconcile job RETIRES a provisional key once its durable receipt exists. Injectable
      // like the rest, because "the write landed but the delete failed" is the state that leaves a
      // duplicate, and it is reachable only here.
      delete: async (k) => {
        if (failMode === "delete") throw new Error("injected Blobs delete failure");
        mem.delete(k);
      },
    }),
  },
});

// ── injectable IRIS + destination chain ──────────────────────────────────────────────────────
let irisResult = { state: "pending" };
let chainResult = { verified: false, reason: "receipt_not_found" };
mock.module("../netlify/functions/_bridge.mjs", {
  namedExports: {
    bridgeMintStatus: async () => irisResult,
    BRIDGE_DESTINATIONS: { base: { label: "Base (Sepolia)", cctpDomain: 6, explorerTx: "https://x/" } },
  },
});
mock.module("../netlify/functions/_receipt.mjs", {
  namedExports: { verifyMintOnChain: async () => chainResult },
});

const INTERNAL = "internal-ok";
mock.module("../netlify/functions/_auth.mjs", {
  namedExports: {
    requireInternal: (event) => (event.headers || {})["x-internal-token"] === INTERNAL,
    internalToken: () => INTERNAL,
    requireSession: (event) => ((event.headers || {}).authorization ? { address: "0xOWNER" } : null),
  },
});
mock.module("../netlify/functions/_blobs.mjs", { namedExports: { connectBlobs: () => {} } });

const { handler: settle } = await import("../netlify/functions/bridge-mint-settle-background.mjs");
const { handler: listHandler } = await import("../netlify/functions/bridge-receipts.mjs");
const { writeReceiptNeverThrows, isPastDeadline, listByOwner, readReceipt, receiptKey,
        pendingReceiptKey, isStranded, SUBMITTED_STATE } =
  await import("../netlify/functions/_bridge-receipts.mjs");
const { recordPendingBridge } = await import("../netlify/functions/_bridge-record.mjs");

const OWNER = "0xOWNER";
const BURN = "0x" + "ab".repeat(32);

const seed = async (over = {}) => {
  mem.clear();
  const r = {
    schema: "bridge-receipt/1",
    owner: OWNER,
    burnHash: BURN,
    burnedAt: new Date().toISOString(),
    state: "burn_confirmed",
    destinationKey: "base",
    recipient: "0x" + "cd".repeat(20),
    amountRequested: 1,
    feeUsdc: 0.05352,
    netPredicted: 0.94648,
    delivery: "predicted",
    amountDelivered: null,
    ...over,
  };
  mem.set(receiptKey(OWNER, BURN), JSON.stringify(r));
  return r;
};
const call = (body, internal = true) =>
  settle({
    httpMethod: "POST",
    headers: internal ? { "x-internal-token": INTERNAL } : {},
    body: JSON.stringify(body),
  });
const stored = async () => readReceipt(OWNER, BURN);

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  BRIDGE RECEIPTS — deadline branch reached by injection, not luck    ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — INTERNAL ONLY: a background function is a public URL");
await seed();
{
  const res = await call({ owner: OWNER, burnHash: BURN }, false);
  check("⭐⭐ a non-internal caller is refused 401", res.statusCode === 401);
  const r = await stored();
  check("  …and the refused call mutated NOTHING", r.state === "burn_confirmed" && !r.settlingSince);
  const noBody = await call({}, true);
  check("  …missing keys refuse 400", noBody.statusCode === 400);
  mem.clear();
  const missing = await call({ owner: OWNER, burnHash: BURN }, true);
  check("  …an absent receipt is 404, not an invented one", missing.statusCode === 404);

  // ⚠️ A background function's return value is DISCARDED — Netlify answers 202 to every
  // caller, so the 401 above never reaches the wire and an external probe cannot tell
  // "refused" from "ran". The log lines are the ONLY externally checkable evidence, so
  // they are pinned here: lose them and the guard silently becomes unverifiable again.
  const settlerSrc = await import("node:fs").then((fs) =>
    fs.readFileSync("netlify/functions/bridge-mint-settle-background.mjs", "utf8")
  );
  check("  both sides are logged (kept for a future log drain — NOT evidence today)",
    /REFUSED — no valid x-internal-token/.test(settlerSrc) && /ACCEPTED — internal token valid/.test(settlerSrc));
  check("  …and the wrong-method refusal is logged as well", /REFUSED — method/.test(settlerSrc));
  // 🚨 Measured: `netlify logs` lists the invocation but NOT the message text, so the lines above
  // cannot prove a refusal. The file must say so, or the next reader trusts a check that does not
  // work — the same trap as asserting "no /api route" and calling the guard verified.
  check("⭐⭐ the file states that logs do NOT surface content, so they are not treated as proof",
    /does not surface|never is/.test(settlerSrc) && /job-bridge-receipt-background\.mjs:50-54/.test(settlerSrc));
  check("⭐⭐ …and names the BEHAVIOURAL proof that does work (no mutation on a real receipt)",
    /unauthenticated with a REAL receipt/.test(settlerSrc) && /does NOT change/.test(settlerSrc));
  check("⭐ …and forbids writing to prove a refusal (that would put a write on the guarded path)",
    /must never WRITE anything to prove/.test(settlerSrc));
  check("⭐ requireInternal is checked BEFORE connectBlobs — no store touched on refusal",
    settlerSrc.indexOf("requireInternal(event)") < settlerSrc.indexOf("connectBlobs(event)"));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — THE DEADLINE BRANCH (untested by construction — injected here)");
{
  irisResult = { state: "pending" }; // IRIS never confirms: a true stall
  chainResult = { verified: false, reason: "receipt_not_found" };
  await seed({ burnedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() }); // 10 min old
  const res = await call({ owner: OWNER, burnHash: BURN });
  const body = JSON.parse(res.body);
  check("⭐⭐ a stall past the deadline escalates to mint_unconfirmed", body.state === "mint_unconfirmed");
  check("⭐ and says WHY — deadline, not exhaustion", body.reason === "deadline_passed");
  const r = await stored();
  check("⭐⭐ delivery STAYS 'predicted' — nothing was measured", r.delivery === "predicted");
  check("  …amountDelivered stays null", r.amountDelivered === null);
  check("  …the lease is released so it never looks in-flight", r.settlingSince === undefined);
  check("  …netPredicted survives for the UI to show as an ESTIMATE", r.netPredicted === 0.94648);
}
{
  // Fresh burn, deadline far away: the poll bound must ALSO terminate. Two independent
  // bounds — a settler restarted late must not start a fresh 4-minute budget.
  irisResult = { state: "pending" };
  await seed({ burnedAt: new Date().toISOString() });
  const res = await call({ owner: OWNER, burnHash: BURN });
  const body = JSON.parse(res.body);
  check("⭐ poll exhaustion also terminates, distinctly labelled", body.state === "mint_unconfirmed" && body.reason === "polls_exhausted");
  check("  …still 'predicted'", (await stored()).delivery === "predicted");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — PREDICTED MUST NOT SILENTLY BECOME MEASURED");
{
  // IRIS confirms, but the chain read keeps erroring. rpc_error is NOT disagreement, so it
  // keeps polling — and must fall out on the deadline as unconfirmed, never as measured.
  irisResult = { state: "minted", mintTxHash: "0x" + "11".repeat(32), mintTx: "https://x/1" };
  chainResult = { verified: false, reason: "rpc_error", detail: "injected" };
  await seed({ burnedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
  const res = await call({ owner: OWNER, burnHash: BURN });
  const body = JSON.parse(res.body);
  const r = await stored();
  check("⭐⭐ IRIS says minted + chain unreadable ⇒ NOT measured", r.delivery === "predicted");
  check("  …it lands unconfirmed, not minted", body.state === "mint_unconfirmed" && r.state === "mint_unconfirmed");
  check("⭐⭐ no mintTxHash is recorded from an unverified claim", !r.mintTxHash);
}
{
  // IRIS confirms, chain actively disagrees. This is the LOUD one.
  irisResult = { state: "minted", mintTxHash: "0x" + "22".repeat(32), mintTx: "https://x/2" };
  chainResult = { verified: false, reason: "no_usdc_transfer_to_recipient" };
  await seed();
  const res = await call({ owner: OWNER, burnHash: BURN });
  const body = JSON.parse(res.body);
  const r = await stored();
  check("⭐⭐ chain disagreement ⇒ mint_unverified", body.state === "mint_unverified" && r.state === "mint_unverified");
  check("⭐ it demands a human", body.needsHumanReview === true);
  check("⭐⭐ still 'predicted' — a disagreement measured nothing", r.delivery === "predicted");
  check("⭐⭐ the claim is stored as CLAIMED, never as mintTxHash", !!r.irisClaimedMintTxHash && !r.mintTxHash);
  check("  …with the reason kept for the human", r.verifyFailure?.reason === "no_usdc_transfer_to_recipient");
}
{
  // Re-invoking a terminal mint_unverified must NOT retry it into minted.
  irisResult = { state: "minted", mintTxHash: "0x" + "33".repeat(32) };
  chainResult = { verified: true, chainId: 84532, blockNumber: 1, usdcAddress: "0xU", usdcAmount: 0.9459 };
  const res = await call({ owner: OWNER, burnHash: BURN });
  check("⭐⭐ mint_unverified is NEVER auto-retried into minted", JSON.parse(res.body).note === "already resolved");
  check("  …and the record still reads mint_unverified", (await stored()).state === "mint_unverified");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3b — A LATE ANSWER IS STILL AN ANSWER (the foreclosure bug)");
{
  // 🚨 THE BUG. The deadline used to be evaluated BEFORE IRIS was consulted, so a receipt
  // past deadline was written `mint_unconfirmed` without anyone asking whether the mint had
  // landed — and a stranded receipt is past deadline BY DEFINITION, which is exactly what
  // recovery selects on. Real case: burn 0x0175cf7b… showed 0.946797 USDC minted on Base
  // while its receipt said "unproven". Worse, `mint_unconfirmed` counted as terminal, so the
  // mislabel was PERMANENT. The deadline bounds WAITING, never CHECKING.
  irisResult = { state: "minted", mintTxHash: "0x" + "55".repeat(32), mintTx: "https://x/5" };
  chainResult = { verified: true, chainId: 84532, blockNumber: 7, usdcAddress: "0xU", usdcAmount: 0.946797 };
  await seed({ burnedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }); // 3h stranded
  const res = await call({ owner: OWNER, burnHash: BURN });
  const r = await stored();
  check("⭐⭐ hours past deadline, but the mint LANDED ⇒ minted, not mint_unconfirmed",
    JSON.parse(res.body).state === "minted" && r.state === "minted");
  check("⭐⭐ …and it measures (the foreclosure would have left this 'predicted' forever)",
    r.delivery === "measured" && r.amountDelivered === 0.946797);
}
{
  // A provisional receipt must be re-openable, or recovery cannot heal what it mislabelled.
  irisResult = { state: "minted", mintTxHash: "0x" + "66".repeat(32), mintTx: "https://x/6" };
  chainResult = { verified: true, chainId: 84532, blockNumber: 8, usdcAddress: "0xU", usdcAmount: 0.9468 };
  await seed({
    state: "mint_unconfirmed",
    delivery: "predicted",
    burnedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    lastCheckedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // an hour ago
  });
  const res = await call({ owner: OWNER, burnHash: BURN });
  const r = await stored();
  check("⭐⭐ mint_unconfirmed is PROVISIONAL — re-checked, and resolves when the mint landed",
    JSON.parse(res.body).state === "minted" && r.delivery === "measured");

  // …but not on every page load.
  await seed({
    state: "mint_unconfirmed",
    burnedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    lastCheckedAt: new Date().toISOString(), // just now
  });
  const soon = await call({ owner: OWNER, burnHash: BURN });
  check("⭐ …rate limited, so a reload cannot hammer IRIS",
    /re-checked too recently/.test(JSON.parse(soon.body).note || ""));
}
{
  // The deadline must still fire when the mint genuinely has NOT landed.
  irisResult = { state: "pending" };
  chainResult = { verified: false, reason: "receipt_not_found" };
  await seed({ burnedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() });
  const res = await call({ owner: OWNER, burnHash: BURN });
  check("⭐ genuinely unresolved past deadline still escalates",
    JSON.parse(res.body).state === "mint_unconfirmed" && JSON.parse(res.body).reason === "deadline_passed");
  check("  …and records lastCheckedAt so the re-check can be rate limited",
    !!(await stored()).lastCheckedAt);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — THE ONE PATH THAT MAY MEASURE");
{
  irisResult = { state: "minted", mintTxHash: "0x" + "44".repeat(32), mintTx: "https://x/4" };
  // The chain says 0.9459 — deliberately DIFFERENT from netPredicted 0.94648, so a suite that
  // confused the two would fail here rather than pass by coincidence.
  chainResult = { verified: true, chainId: 84532, blockNumber: 44868072, usdcAddress: "0xUSDC", usdcAmount: 0.9459 };
  await seed();
  const res = await call({ owner: OWNER, burnHash: BURN });
  const body = JSON.parse(res.body);
  const r = await stored();
  check("⭐⭐ verified chain read ⇒ delivery 'measured'", r.delivery === "measured");
  check("⭐⭐ amountDelivered comes from the CHAIN, not from arithmetic", r.amountDelivered === 0.9459 && r.netPredicted === 0.94648);
  check("  …and the two are kept side by side, so the gap is auditable", r.amountDelivered !== r.netPredicted);
  check("  …state minted, with both verifiers named", r.state === "minted" && JSON.stringify(r.mintVerifiedBy) === JSON.stringify(["iris", "destination-rpc"]));
  check("  …response carries the measured figure", body.amountDelivered === 0.9459);
  check("  …lease released", r.settlingSince === undefined);
}
{
  irisResult = { state: "failed" };
  await seed();
  await call({ owner: OWNER, burnHash: BURN });
  const r = await stored();
  check("⭐ an explicit IRIS failure is mint_failed, still 'predicted'", r.state === "mint_failed" && r.delivery === "predicted");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — THE WRITE ON THE MONEY PATH MUST NEVER THROW");
{
  failMode = "set";
  let threw = false;
  let out;
  try {
    out = await writeReceiptNeverThrows({ owner: OWNER, burnHash: BURN, state: "burn_confirmed" });
  } catch { threw = true; }
  check("⭐⭐ a Blobs write failure does NOT throw — the burn already landed", threw === false);
  check("  …it reports written:false so the failure is visible in logs", out?.written === false);
  failMode = null;
  const ok = await writeReceiptNeverThrows({ owner: OWNER, burnHash: BURN, state: "burn_confirmed" });
  check("  …and a healthy write reports written:true", ok.written === true);
  const bad = await writeReceiptNeverThrows({ owner: null, burnHash: null });
  check("  …a receipt with no key fields is refused, not written under a junk key", bad.written === false);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — OWNER SCOPE + ABSENCE MUST NOT READ AS SAFE");
{
  mem.clear();
  await writeReceiptNeverThrows({ owner: OWNER, burnHash: BURN, burnedAt: "2026-07-31T10:00:00Z", state: "minted" });
  await writeReceiptNeverThrows({ owner: "0xSOMEONE_ELSE", burnHash: "0x" + "ff".repeat(32), burnedAt: "2026-07-31T11:00:00Z", state: "minted" });
  const mine = await listByOwner(OWNER);
  check("⭐⭐ listByOwner returns ONLY this owner's receipts", mine.receipts.length === 1 && mine.receipts[0].owner === OWNER);
  check("  …and is not degraded when the store is healthy", mine.degraded === false);

  failMode = "list";
  const broken = await listByOwner(OWNER);
  check("⭐⭐ a store failure reports degraded:true, not an empty list as certainty", broken.degraded === true && broken.receipts.length === 0);
  failMode = null;

  const res = await listHandler({ httpMethod: "GET", headers: { authorization: "Bearer x" } });
  check("  …the endpoint carries `degraded` to the client", "degraded" in JSON.parse(res.body));
  const anon = await listHandler({ httpMethod: "GET", headers: {} });
  check("  …and refuses an unauthenticated caller", anon.statusCode === 401);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — THE DEADLINE PREDICATE ITSELF");
{
  check("⭐ an unknown burnedAt NEVER auto-escalates", isPastDeadline({}) === false);
  check("  …a fresh burn is not past deadline", isPastDeadline({ burnedAt: new Date().toISOString() }) === false);
  check("  …a 5-minute-old burn is", isPastDeadline({ burnedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() }) === true);
  check("  …the boundary is 4 minutes exactly", isPastDeadline({ burnedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString() }) === true);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("8 — THE 202 PENDING-BURN PATH WRITES NO RECEIPT");
{
  const src = await import("node:fs").then((fs) => fs.readFileSync("netlify/functions/agent-bridge.mjs", "utf8"));
  // The write + trigger moved into _bridge-record.mjs so the plan path uses the SAME
  // implementation. The invariants follow them there rather than being dropped.
  const recSrc = await import("node:fs").then((fs) =>
    fs.readFileSync("netlify/functions/_bridge-record.mjs", "utf8"));
  check("⭐ the receipt write is gated on a real burnHash", /if \(!r\?\.burnHash\) return/.test(recSrc));
  check("⭐⭐ the write is awaited (an un-awaited write can be frozen away)", /await writeReceiptNeverThrows\(/.test(recSrc));
  // 🚨 THIS CHECK USED TO ASSERT THE OPPOSITE, and it passed for the whole life of the bug.
  // It read "the settler trigger is NOT awaited — no 4-min loop in a sync handler", conflating
  // two different things: not hosting the POLL (correct) and not awaiting the TRIGGER (the
  // defect). Burn 0x0175cf7b… stranded for three hours because an un-awaited fetch is frozen
  // away when the handler returns. A test can pin a bug as an invariant; when the fix landed,
  // this is the assertion that failed. ⭐ The poll is bounded by the settler being a separate
  // background function, NOT by whether the caller awaits the 202.
  check("⭐⭐ the settler trigger IS awaited — an un-awaited fetch may never be sent",
    /await triggerSettle\(\{ event, owner/.test(recSrc) && /const res = await fetch\(/.test(recSrc));
  check("  …and the 4-minute poll still lives in the background function, not the caller",
    !/MAX_POLLS|for \(let i = 0; i < 48/.test(recSrc) && !/MAX_POLLS/.test(src));
  check("  …and the handler never branches on the write result", !/writeReceiptNeverThrows\([\s\S]{0,400}?\)\s*;?\s*if\s*\(/.test(src));
  const toml = await import("node:fs").then((fs) => fs.readFileSync("netlify.toml", "utf8"));
  check("⭐⭐ the settler has NO public /api route", !/bridge-mint-settle/.test(toml.replace(/#.*$/gm, "")));
  check("  …while the owner-scoped read does", /\/api\/bridge-receipts/.test(toml));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("9 — THE SWEEPER: recovery that needs no one to be looking");
{
  const { listAllStranded, isStranded } = await import("../netlify/functions/_bridge-receipts.mjs");
  const OLD = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

  // ONE definition of "stranded", shared by the owner-scoped read and the sweeper, so the
  // two can never drift into disagreeing about what needs rescuing.
  check("⭐ a burn past deadline with no lease is stranded",
    isStranded({ state: "burn_confirmed", burnedAt: OLD }) === true);
  check("  …a fresh burn is not", isStranded({ state: "burn_confirmed", burnedAt: new Date().toISOString() }) === false);
  check("⭐⭐ a LEASED receipt is never swept — someone is already on it",
    isStranded({ state: "burn_confirmed", burnedAt: OLD, settlingSince: new Date().toISOString() }) === false);
  check("⭐ a PROVISIONAL mint_unconfirmed due a re-check is stranded",
    isStranded({ state: "mint_unconfirmed", burnedAt: OLD, lastCheckedAt: OLD }) === true);
  check("⭐⭐ a RESOLVED receipt is never swept", isStranded({ state: "minted", burnedAt: OLD }) === false &&
    isStranded({ state: "mint_unverified", burnedAt: OLD }) === false);

  // Across ALL owners — the read path only ever saw one.
  mem.clear();
  await writeReceiptNeverThrows({ owner: "0xAAA", burnHash: "0x" + "a1".repeat(32), burnedAt: OLD, state: "burn_confirmed" });
  await writeReceiptNeverThrows({ owner: "0xBBB", burnHash: "0x" + "b1".repeat(32), burnedAt: OLD, state: "burn_confirmed" });
  await writeReceiptNeverThrows({ owner: "0xCCC", burnHash: "0x" + "c1".repeat(32), burnedAt: OLD, state: "minted" });
  const all = await listAllStranded();
  check("⭐⭐ the sweep spans OWNERS — the read path saw one, this sees everyone",
    all.total === 2 && new Set(all.stranded.map((r) => r.owner)).size === 2);
  check("  …and leaves resolved receipts alone", all.scanned === 3 && all.total === 2);

  // No silent truncation: a cap must report what it deferred.
  const capped = await listAllStranded({ limit: 1 });
  check("⭐⭐ a capped sweep reports the TRUE total, not the truncated one",
    capped.stranded.length === 1 && capped.total === 2);

  failMode = "list";
  const broken = await listAllStranded();
  check("⭐⭐ an unreadable store is degraded, NOT 'nothing stranded'",
    broken.degraded === true && broken.total === 0);
  failMode = null;

  const sweepSrc = await import("node:fs").then((fs) =>
    fs.readFileSync("netlify/functions/bridge-mint-sweep.mjs", "utf8"));
  check("⭐⭐ the sweeper reports DEGRADED loudly instead of logging a clean tick",
    /this tick proves nothing/.test(sweepSrc));
  check("⭐ …names the deferred remainder rather than dropping it", /CAPPED at \$\{MAX_PER_TICK\}\/tick/.test(sweepSrc));
  check("⭐ …awaits each trigger (an un-awaited fetch may never be sent)", /await fetch\(`\$\{base\}/.test(sweepSrc));
  check("  …and writes nothing itself — the settler owns every write",
    !/saveReceipt|setJSON|writeReceipt/.test(sweepSrc));

  const toml = await import("node:fs").then((fs) => fs.readFileSync("netlify.toml", "utf8"));
  const live = toml.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  check("⭐⭐ the schedule is DECLARED and uncommented (a commented one leaves an identical tree hash)",
    /\[functions\."bridge-mint-sweep"\]\s*\n\s*schedule = "\*\/10 \* \* \* \*"/.test(live));
  check("⭐ …and it has NO public /api route", !/\/api\/bridge-mint-sweep/.test(live));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("THE PROVISIONAL RECEIPT — behaviour, not source text");
// 🚨 THE GAP, OBSERVED LIVE 2026-08-14: a userOp that had not settled raised TxPendingError,
// agent-bridge answered 202, and NOTHING was written — losing the consent evidence for a 53%
// fee the user had explicitly accepted. These drive the real writer against the real store.
//
// ⚠️ COVERAGE BOUNDARY, STATED RATHER THAN IMPLIED. What runs for real here: the writer, the key
// layout, the owner cross-check, the sort, and every field on the record. What is pinned ONLY by
// source assertion (verify-bridge-fee-band §10): that `_actions` attaches `e.consent` to the
// throw, and that the two HTTP boundaries call the recorder. Driving those needs executeAction
// with a mocked chain — a heavier harness than this suite has. Mutation-tested: removing the
// attach, or the call site, leaves THIS suite green and turns the source suite red. The two
// suites cover different halves of one chain and NEITHER ALONE COVERS IT.
{
  mem.clear();
  const TXID = "9f3a1c22-0000-4a11-9c3e-abcdefabcdef";
  const err = Object.assign(new Error("Transaction still pending after timeout"), {
    name: "TxPendingError",
    txId: TXID,
    consent: {
      destinationKey: "base", destinationLabel: "Base (Sepolia)", amountRequested: 0.1,
      feeUsdc: 0.053216, netUsdc: 0.046784, feeBand: "acknowledge", feeRatio: 0.53216,
      ackRequired: true, acknowledged: true, ackToken: "tok_abc",
    },
  });
  const out = await recordPendingBridge({ e: err, session: { address: OWNER }, amountRequested: 0.1 });
  check("⭐⭐ the pending path WRITES (it used to write nothing at all)", out.recorded === true);

  const rec = await (await import("@netlify/blobs")).getStore("x").get(pendingReceiptKey(OWNER, TXID));
  check("⭐⭐ …under a txId key, not a hash key", !!rec, pendingReceiptKey(OWNER, TXID));
  check("⭐⭐ ackAcceptedAt IS WRITTEN — the whole point", typeof rec?.ackAcceptedAt === "string" && rec.ackAcceptedAt.length > 10, rec?.ackAcceptedAt);
  check("⭐ …with the band and ratio that were accepted", rec?.ackBand === "acknowledge" && rec?.feeRatio === 0.53216);
  check("⭐⭐ burnHash is explicitly NULL, never absent", rec !== null && "burnHash" in rec && rec.burnHash === null);
  check("⭐ state is the submitted one, distinguishable from burn_confirmed", rec?.state === SUBMITTED_STATE && rec.state !== "burn_confirmed");
  check("⭐ the Circle txId is retained as the recovery hook", rec?.txId === TXID);

  // 🚨 THE COMPOSITION RISK — a new record type in a store several jobs scan.
  // ⚠️ THIS ASSERTS THE OUTCOME, NOT THE EXPLICIT GUARD. Deleting the by-name exclusion in
  // isStranded leaves this GREEN, because the fall-through also answers false. Mutation-tested
  // and confirmed. The explicitness is pinned by source assertion in verify-bridge-fee-band §10,
  // and it earns its place against a FUTURE state joining the recheckable set — not against
  // today's behaviour. Said out loud so nobody reads this line as covering it.
  check("⭐⭐ the sweeper does NOT treat it as stranded (nothing to settle without a hash)", isStranded(rec) === false);

  // Sorting: a pending row must not sink below older confirmed ones.
  mem.set(receiptKey(OWNER, BURN), JSON.stringify({
    schema: "bridge-receipt/1", owner: OWNER, burnHash: BURN, state: "burn_confirmed",
    burnedAt: "2020-01-01T00:00:00.000Z", amountRequested: 1,
  }));
  const listed = await listByOwner(OWNER);
  check("⭐ both receipts are listed for the owner", listed.receipts.length === 2);
  check("⭐⭐ the NEWER pending receipt sorts FIRST (it has submittedAt, not burnedAt)",
    listed.receipts[0]?.txId === TXID, listed.receipts.map((r) => r.state).join(" → "));

  // Missing consent context must degrade the EVIDENCE, never the write: a submitted tx
  // still needs its recovery hook even if the disclosure fields are unavailable.
  const bare = await recordPendingBridge({
    e: Object.assign(new Error("x"), { txId: "t2" }),
    session: { address: OWNER }, amountRequested: 1,
  });
  const bareRec = await (await import("@netlify/blobs")).getStore("x").get(pendingReceiptKey(OWNER, "t2"));
  check("⭐ no consent context ⇒ still recorded, with the ack fields NULL rather than invented",
    bare.recorded === true && bareRec?.ackAcceptedAt === null && bareRec?.ackBand === null);

  // ⚠️ THE GUARD IS ON THE WRITER, AND recordPendingBridge CANNOT REACH IT (it always sets
  // burnHash: null). So drive the writer DIRECTLY — otherwise this check would assert a
  // branch nothing exercises, which is how a suite ends up pinning a bug as an invariant.
  const { writePendingReceiptNeverThrows } = await import("../netlify/functions/_bridge-receipts.mjs");
  const impostor = await writePendingReceiptNeverThrows({ owner: OWNER, txId: "t3", burnHash: BURN });
  check("⭐⭐ a provisional receipt carrying a burnHash is REFUSED — it would impersonate a confirmed one",
    impostor.written === false && impostor.reason === "has_burn_hash");

  const none = await recordPendingBridge({ e: new Error("no txId"), session: { address: OWNER }, amountRequested: 1 });
  check("⭐⭐ …but with NO txId there is no key, so it declines rather than inventing one", none.recorded === false && none.reason === "no_tx_id");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("11 — THE AGE CAP: a provisional record must not be immortal");
// 🚨 THE DEFECT, AUDITED 2026-08-14: `412e8d0` shipped the provisional record with two writers, a
// by-name exclusion from the sweep, and a renderer — and NOTHING that could ever move it. No
// terminal state, no age cap, no escalation. The panel said "has not been confirmed YET" forever.
// ⭐ These drive the real predicate, the real store and the real reader; the band boundaries are
// reached by INJECTING `now`, not by waiting 24 hours — the same reason section 2 injects a stall.
{
  const {
    provisionalStatus, PROVISIONAL_BANDS, SUBMITTED_SETTLE_DEADLINE_MS, SUBMITTED_AGE_CAP_MS,
    listAllStranded, isStranded, writePendingReceiptNeverThrows,
  } = await import("../netlify/functions/_bridge-receipts.mjs");

  const aged = (agoMs) => ({ state: "burn_submitted", submittedAt: new Date(Date.now() - agoMs).toISOString() });

  check("⭐ a fresh provisional receipt is `settling` — Circle may still land it",
    provisionalStatus(aged(60_000)).band === "settling");
  check("⭐ past the settle deadline it is `unwitnessed`",
    provisionalStatus(aged(SUBMITTED_SETTLE_DEADLINE_MS + 1000)).band === "unwitnessed");
  check("  …the settle boundary is inclusive", provisionalStatus(aged(SUBMITTED_SETTLE_DEADLINE_MS)).band === "unwitnessed");

  const capped = provisionalStatus(aged(SUBMITTED_AGE_CAP_MS + 1000));
  check("⭐⭐ past the 24h CAP it is `unresolved` — TERMINAL, and it asks for a human",
    capped.band === "unresolved" && capped.terminal === true && capped.needsHuman === true);
  check("  …the cap boundary is inclusive", provisionalStatus(aged(SUBMITTED_AGE_CAP_MS)).band === "unresolved");

  // ⭐⭐ THE BUG ITSELF, PINNED. Before the cap this record reported the same thing at 30 seconds
  // and 30 days. If this check ever goes green on "settling" again, immortality is back.
  check("⭐⭐ a 30-DAY-old record is NOT still 'settling' — the immortality bug, pinned",
    provisionalStatus(aged(30 * 24 * 3600_000)).band === "unresolved");

  check("⭐ every band comes from the CLOSED set — an open status string is how an unknown wears a known name",
    [60_000, SUBMITTED_SETTLE_DEADLINE_MS, SUBMITTED_AGE_CAP_MS, 30 * 24 * 3600_000]
      .every((a) => PROVISIONAL_BANDS.includes(provisionalStatus(aged(a)).band)));

  check("  a confirmed/minted receipt is not provisional at all",
    provisionalStatus({ state: "burn_confirmed", burnedAt: new Date().toISOString() }).provisional === false &&
    provisionalStatus({ state: "minted" }).provisional === false);

  // ⚠️ THE DELIBERATE DIVERGENCE FROM isPastDeadline, asserted so nobody "fixes" it into agreement.
  check("⭐⭐ an UNDATEABLE provisional record is `unresolved`, never `settling` — it can never age out on its own",
    provisionalStatus({ state: "burn_submitted" }).band === "unresolved" &&
    provisionalStatus({ state: "burn_submitted", submittedAt: "not-a-date" }).band === "unresolved");
  check("  …while isPastDeadline still REFUSES to escalate on an unknown clock (it gates an ACTION, this gates a CLAIM)",
    isPastDeadline({}) === false);

  check("⭐⭐ capping it does NOT make it stranded — there is still no burn hash to settle or ask IRIS about",
    [60_000, SUBMITTED_SETTLE_DEADLINE_MS + 1000, SUBMITTED_AGE_CAP_MS + 1000].every((a) => isStranded(aged(a)) === false));

  // ── THE CENSUS, through the real store ─────────────────────────────────────────────────────
  mem.clear();
  await writePendingReceiptNeverThrows({ owner: "0xAAA", txId: "t-fresh", state: "burn_submitted", submittedAt: new Date().toISOString() });
  await writePendingReceiptNeverThrows({ owner: "0xBBB", txId: "t-old", state: "burn_submitted", submittedAt: new Date(Date.now() - SUBMITTED_AGE_CAP_MS - 1000).toISOString() });
  await writeReceiptNeverThrows({ owner: "0xCCC", burnHash: "0x" + "c2".repeat(32), burnedAt: new Date().toISOString(), state: "minted" });
  const census = await listAllStranded();
  check("⭐⭐ the sweep COUNTS the provisional records it deliberately does not act on",
    census.provisional.settling === 1 && census.provisional.unresolved === 1 && census.provisional.unwitnessed === 0);
  check("⭐⭐ …on a tick that reports stranded=0 — which is why the census cannot live after the 'clean' return",
    census.total === 0 && census.scanned === 3);

  failMode = "list";
  const dark = await listAllStranded();
  check("⭐⭐ a DEGRADED scan reports provisional:null, never zeros — an unreadable store must not answer 'nobody needs help'",
    dark.provisional === null && dark.degraded === true);
  failMode = null;

  // ── THE SWEEPER'S ORDERING, which is the whole escalation ───────────────────────────────────
  const sweepSrc = await import("node:fs").then((fs) => fs.readFileSync("netlify/functions/bridge-mint-sweep.mjs", "utf8"));
  check("⭐⭐ the census is logged BEFORE the clean early-return — provisional records make stranded=0 the NORMAL case",
    sweepSrc.indexOf("PAST THE 24h CAP") > 0 && sweepSrc.indexOf("PAST THE 24h CAP") < sweepSrc.indexOf("[bridge-sweep] clean"));
  check("  …and the sweeper STILL writes nothing — a census is a count, not a state machine",
    !/saveReceipt|setJSON|writeReceipt/.test(sweepSrc));

  // ── THE READER PROJECTS IT, so the panel cannot drift from the sweeper ──────────────────────
  mem.clear();
  await writePendingReceiptNeverThrows({
    owner: OWNER, txId: "t-aged", state: "burn_submitted",
    submittedAt: new Date(Date.now() - SUBMITTED_AGE_CAP_MS - 1000).toISOString(),
  });
  const body = JSON.parse((await listHandler({ httpMethod: "GET", headers: { authorization: "Bearer x" } })).body);
  const row = body.receipts.find((r) => r.txId === "t-aged");
  check("⭐⭐ the READER derives the band — ONE definition of the cap, so the panel cannot compute a second one",
    row?.provisional?.band === "unresolved" && row?.provisional?.needsHuman === true);
  check("  …and a confirmed receipt projects provisional:null rather than a fabricated band",
    provisionalStatus({ state: "minted" }).provisional === false);

  // ── THE COPY ────────────────────────────────────────────────────────────────────────────────
  // ⚠️ COVERAGE BOUNDARY, STATED: these are SOURCE checks. This suite has no React renderer, so
  // they prove the branches EXIST and that the unconditional "yet" is gone — they do not prove
  // what a browser paints. `assert-on-rendered-output` remains the standing rule and remains
  // unmet here; a rendering test belongs with the other copy suites, not bolted on to this one.
  const panelSrc = await import("node:fs").then((fs) => fs.readFileSync("src/components/BridgePanel.tsx", "utf8"));
  check("⭐⭐ 'not been confirmed yet' is no longer unconditional — it is gated on the `settling` band alone",
    /band === "settling"[\s\S]{0,240}has not been confirmed yet/.test(panelSrc));
  check("⭐ the `unwitnessed` row says nothing is checking, rather than implying someone is",
    /band === "unwitnessed"[\s\S]{0,400}nothing is checking this/.test(panelSrc));
  // ⚠️ WINDOW WIDENED WHEN THE RECONCILE JOB LANDED — the row grew an attempt-count branch and the
  // phrase moved past 400 chars. Third time a source regex has been brittle here for a reason that
  // has nothing to do with what the user sees; the boundary note above is not theoretical.
  check("⭐⭐ the `unresolved` row says it will NOT resolve on its own and names the manual step",
    /band === "unresolved"[\s\S]{0,900}econcile this transaction against Circle/.test(panelSrc));
  check("⭐⭐ …and DISTINGUISHES 'we asked N times' from 'nothing ever checked it' — different problems, different urgency",
    /reconcileAttempts > 0[\s\S]{0,300}We asked Circle[\s\S]{0,300}Nothing ever checked it automatically/.test(panelSrc));
  check("⭐ a `submit_failed` row leads with the good news — no funds left the wallet",
    /state === "submit_failed"[\s\S]{0,400}No funds left your wallet/.test(panelSrc));
  // ⚠️ `\s+` BETWEEN THE WORDS, NOT A SPACE — and this check FAILED first for exactly that reason:
  // JSX wrapped the sentence, so "could not be determined" exists on screen and not in the source
  // as one string. ⭐ That is `assert-on-rendered-output-not-source-regex` demonstrating itself
  // inside the very check whose comment above admits it cannot render. Left visible on purpose.
  check("⭐ a provisional row with NO band still renders a status — a row with an amount and no state reads as normal",
    /!r\.provisional\?\.band[\s\S]{0,300}age could not be\s+determined/.test(panelSrc));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("12 — THE RECONCILE JOB: the system does what it was telling the user to do by hand");
// ⭐ The cap made an unresolved record LOUD. It still asked a person to go ask Circle something the
// server can ask itself. This is that, and every branch below is reached by injecting Circle's
// answer — the same discipline as section 2, because "Circle eventually said FAILED" cannot be
// summoned on demand and would otherwise first execute in production.
{
  const { handler: reconcile } = await import("../netlify/functions/bridge-reconcile-background.mjs");
  const {
    writePendingReceiptNeverThrows, readPendingReceipt, pendingReceiptKey, receiptKey,
    saveReceipt: saveDurable, SUBMIT_FAILED_STATE, SUBMITTED_AGE_CAP_MS, PENDING_STAGES,
  } = await import("../netlify/functions/_bridge-receipts.mjs");
  const { internalToken } = await import("../netlify/functions/_auth.mjs");

  const HASH = "0x" + "d4".repeat(32);
  const RECIP = "0x" + "ab".repeat(20);
  const call = (body) => reconcile({
    httpMethod: "POST",
    headers: { "x-internal-token": internalToken() },
    body: JSON.stringify(body),
  });
  const seed = async (over = {}) => {
    mem.clear();
    circleAnswer = null;
    await writePendingReceiptNeverThrows({
      owner: OWNER, txId: "tx-1", state: "burn_submitted",
      submittedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      pendingStage: "burn", recipient: RECIP, destinationKey: "base", destinationLabel: "Base",
      amountRequested: 1, feeUsdc: 0.05, netPredicted: 0.95,
      ackBand: "acknowledge", ackRequired: true, ackAcceptedAt: "2026-08-14T10:00:00.000Z",
      ...over,
    });
  };
  const durable = async () => (await import("@netlify/blobs")).getStore("x").get(receiptKey(OWNER, HASH));

  // ── THE GUARD THAT STOPS A FABRICATED BURN HASH ────────────────────────────────────────────
  await seed({ pendingStage: null });
  circleAnswer = { state: "COMPLETE", txHash: HASH };
  let r = JSON.parse((await call({ owner: OWNER, txId: "tx-1" })).body);
  check("⭐⭐ an UNTAGGED record is REFUSED — guessing 'burn' would write an APPROVE's hash as a burnHash",
    r.outcome === "unknown_stage" && (await durable()) == null);
  check("  …and the provisional record is left submitted, not terminated on a guess",
    (await readPendingReceipt(OWNER, "tx-1"))?.state === "burn_submitted");
  check("  …while still counting the attempt, so a stuck record is not also a silent one",
    (await readPendingReceipt(OWNER, "tx-1"))?.reconcileAttempts === 1);

  // ⭐ THE APPROVE CASE — the whole reason the stage exists.
  await seed({ pendingStage: "approve" });
  circleAnswer = { state: "COMPLETE", txHash: HASH };
  r = JSON.parse((await call({ owner: OWNER, txId: "tx-1" })).body);
  check("⭐⭐ a COMPLETE **approve** writes NO durable receipt — the allowance landed, the burn was never submitted",
    r.outcome === "submit_failed" && (await durable()) == null);
  check("  …and the record becomes terminal with a reason naming what actually happened",
    (await readPendingReceipt(OWNER, "tx-1"))?.submitFailureReason === "approve_completed_bridge_never_submitted");

  // ── THE RECOVERY ───────────────────────────────────────────────────────────────────────────
  await seed();
  circleAnswer = { state: "COMPLETE", txHash: HASH, updateDate: "2026-08-14T11:00:00.000Z" };
  r = JSON.parse((await call({ owner: OWNER, txId: "tx-1" })).body);
  const rec = await durable();
  check("⭐⭐ a COMPLETE **burn** writes the durable receipt under its REAL hash key", r.outcome === "recovered" && rec?.burnHash === HASH);
  check("⭐⭐ …carrying the CONSENT EVIDENCE forward rather than re-deriving it",
    rec?.ackAcceptedAt === "2026-08-14T10:00:00.000Z" && rec?.ackBand === "acknowledge");
  check("⭐⭐ …and the RECIPIENT, without which verifyMintOnChain says bad_recipient and the settler re-checks forever",
    rec?.recipient === RECIP);
  check("⭐ …marked as RECOVERED, never presented as observed live", rec?.reconciledFromTxId === "tx-1" && !!rec?.reconciledAt);
  check("⭐ …with burn_confirmed so the settler can take it from here", rec?.state === "burn_confirmed");
  check("⭐⭐ …and the provisional key is RETIRED, never mutated into the confirmed one",
    (await readPendingReceipt(OWNER, "tx-1")) == null);

  // ── NEVER CLOBBER PROGRESS ─────────────────────────────────────────────────────────────────
  await seed();
  await saveDurable({ owner: OWNER, burnHash: HASH, state: "minted", delivery: "measured", amountDelivered: 0.94 });
  circleAnswer = { state: "COMPLETE", txHash: HASH };
  r = JSON.parse((await call({ owner: OWNER, txId: "tx-1" })).body);
  const kept = await durable();
  check("⭐⭐ an ALREADY-SETTLED receipt is never overwritten — a second tick must not un-prove a proven bridge",
    r.outcome === "already_recorded" && kept?.state === "minted" && kept?.amountDelivered === 0.94);
  check("  …and the provisional key is still retired", (await readPendingReceipt(OWNER, "tx-1")) == null);

  // ── THE DEAD AND THE UNKNOWN ───────────────────────────────────────────────────────────────
  await seed();
  circleAnswer = { state: "FAILED" };
  r = JSON.parse((await call({ owner: OWNER, txId: "tx-1" })).body);
  check("⭐ a FAILED transaction is terminal and writes no receipt", r.outcome === "submit_failed" && (await durable()) == null);
  check("  …and the row can say no funds moved", (await readPendingReceipt(OWNER, "tx-1"))?.state === SUBMIT_FAILED_STATE);

  await seed();
  circleAnswer = { state: "SOME_NEW_STATE_CIRCLE_INVENTED" };
  r = JSON.parse((await call({ owner: OWNER, txId: "tx-1" })).body);
  check("⭐⭐ an UNRECOGNISED Circle state is treated as pending and NAMED — never bucketed into a known outcome",
    r.outcome === "pending" && r.circleState === "SOME_NEW_STATE_CIRCLE_INVENTED" &&
    (await readPendingReceipt(OWNER, "tx-1"))?.state === "burn_submitted");

  await seed();
  circleAnswer = { state: "COMPLETE", txHash: "not-a-hash" };
  r = JSON.parse((await call({ owner: OWNER, txId: "tx-1" })).body);
  check("⭐⭐ COMPLETE with no usable txHash writes NOTHING — a hash is never invented to fill the slot",
    r.outcome === "complete_without_hash" && (await durable()) == null);

  await seed();
  circleAnswer = new Error("Circle is down");
  r = JSON.parse((await call({ owner: OWNER, txId: "tx-1" })).body);
  check("⭐⭐ an UNREACHABLE Circle never downgrades the record — 'we could not ask' is not an answer",
    r.outcome === "circle_unreachable" && (await readPendingReceipt(OWNER, "tx-1"))?.state === "burn_submitted");

  // ── BOUNDED EFFORT: the same bound as the claim ─────────────────────────────────────────────
  await seed({ submittedAt: new Date(Date.now() - SUBMITTED_AGE_CAP_MS - 1000).toISOString() });
  circleAnswer = { state: "COMPLETE", txHash: HASH };
  r = JSON.parse((await call({ owner: OWNER, txId: "tx-1" })).body);
  check("⭐⭐ past the 24h cap it STOPS ASKING — polling forever behind a row that says 'a human must look' would make that text false",
    r.outcome === "past_cap" && (await durable()) == null);

  // ── INTERNAL ONLY ──────────────────────────────────────────────────────────────────────────
  const anon = await reconcile({ httpMethod: "POST", headers: {}, body: JSON.stringify({ owner: OWNER, txId: "tx-1" }) });
  check("⭐⭐ it is INTERNAL ONLY — every file here is a public URL, and this one creates durable receipts",
    anon.statusCode === 401 || anon.statusCode === 403);

  // ── THE UPSTREAM TAG AND THE WIRING ────────────────────────────────────────────────────────
  const fs = await import("node:fs");
  const bridgeSrc = fs.readFileSync("netlify/functions/_bridge.mjs", "utf8");
  check("⭐⭐ BOTH waitForTx calls tag the stage — the approve one is the whole point",
    /e\.stage = "approve"/.test(bridgeSrc) && /e\.stage = "burn"/.test(bridgeSrc));
  const sweepSrc2 = fs.readFileSync("netlify/functions/bridge-mint-sweep.mjs", "utf8");
  check("⭐⭐ the sweep triggers reconcile BEFORE the clean early-return — a provisional record is never 'stranded'",
    sweepSrc2.indexOf("bridge-reconcile-background") < sweepSrc2.indexOf("[bridge-sweep] clean"));
  check("  …and the sweep STILL owns no writes", !/saveReceipt|setJSON|writeReceipt/.test(sweepSrc2));

  // ⭐ The stage must survive the WRITER, not just exist upstream — driven through recordPendingBridge.
  mem.clear();
  const { recordPendingBridge: rpb } = await import("../netlify/functions/_bridge-record.mjs");
  await rpb({
    e: Object.assign(new Error("pending"), { txId: "tx-staged", stage: "burn", consent: { recipient: RECIP } }),
    session: { address: OWNER }, amountRequested: 1,
  });
  const staged = await readPendingReceipt(OWNER, "tx-staged");
  check("⭐ the writer persists the stage AND the recipient — the two fields reconcile cannot work without",
    staged?.pendingStage === "burn" && staged?.recipient === RECIP);
  await rpb({
    e: Object.assign(new Error("pending"), { txId: "tx-bogus", stage: "not-a-stage" }),
    session: { address: OWNER }, amountRequested: 1,
  });
  check("⭐⭐ an out-of-set stage is stored as NULL, never passed through — the closed set is enforced at the write",
    (await readPendingReceipt(OWNER, "tx-bogus"))?.pendingStage === null && PENDING_STAGES.length === 2);

  circleAnswer = null;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("13 — THE 12-DAY RECORD: bounding unattended retry without foreclosing recovery");
// 🚨 `o/0xfd801d08…/0xccc02035…` — 1 USDC to Polygon Amoy, burned 2026-08-02, still
// `mint_unconfirmed` twelve days later, re-triggered every ~10 min (~1,730 times) with
// lastVerifyFailure "rpc_error". isRecheckable had a 5-minute FLOOR and no ceiling.
{
  const {
    isAutoRetryExhausted, mintRecoveryStatus, MINT_AUTO_RETRY_MAX_AGE_MS,
    listAllStranded: listAll, isRecheckable: recheckable,
  } = await import("../netlify/functions/_bridge-receipts.mjs");

  const old = (days, over = {}) => ({
    state: "mint_unconfirmed",
    burnedAt: new Date(Date.now() - days * 86_400_000).toISOString(),
    lastCheckedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    ...over,
  });

  check("⭐ a young unconfirmed mint is still auto-retried", isAutoRetryExhausted(old(1)) === false);
  check("⭐⭐ a 12-DAY-old one is NOT — the actual record, bounded", isAutoRetryExhausted(old(12)) === true);
  check("  …the boundary is 7 days exactly", isAutoRetryExhausted(old(7)) === true && isAutoRetryExhausted(old(6.9)) === false);
  check("⭐⭐ an UNDATEABLE burn counts as exhausted — no infinite machine effort on a record nobody can date",
    isAutoRetryExhausted({ state: "mint_unconfirmed" }) === true);
  check("  …while isPastDeadline still refuses to ESCALATE on the same unknown clock (it starts an action; this stops one)",
    isPastDeadline({}) === false);

  // ⭐⭐ THE 2026-08-01 FIX MUST SURVIVE. Bounding the cron must not make the record unresolvable.
  check("⭐⭐ a 12-day record is STILL re-checkable — the cron stops, the possibility of learning does not",
    recheckable(old(12)) === true);
  check("  …so the owner-scoped read path can still recover it when a human looks",
    isStranded(old(12)) === true);

  // ── THE CAUSE — the distinction the record could never make ────────────────────────────────
  const unreadable = mintRecoveryStatus(old(12, { lastVerifyFailure: "rpc_error", verifyFailureCount: 1730 }));
  check("⭐⭐ lastVerifyFailure ⇒ cause is `chain_unreadable` — it is written ONLY after IRIS said `minted`",
    unreadable.cause === "chain_unreadable");
  check("  …and the detail says IRIS reported it landed, not that it is pending",
    /IRIS reported this mint as landed/.test(unreadable.detail));
  check("⭐ no verify failure ⇒ `never_appeared` — a genuinely unseen mint is a DIFFERENT problem",
    mintRecoveryStatus(old(12)).cause === "never_appeared");
  check("  …and a confirmed receipt has no mint-recovery status at all",
    mintRecoveryStatus({ state: "minted" }).applicable === false);
  check("⭐ the failed-read streak is carried, so 'we could not read it N times' is EVIDENCE not inference",
    unreadable.verifyFailureCount === 1730);

  // ── STRANDED vs ABANDONED — the alert-noise fix ────────────────────────────────────────────
  mem.clear();
  await writeReceiptNeverThrows({ owner: "0xAAA", burnHash: "0x" + "e1".repeat(32), ...old(12, { lastVerifyFailure: "rpc_error" }) });
  await writeReceiptNeverThrows({ owner: "0xBBB", burnHash: "0x" + "e2".repeat(32), ...old(1) });
  const split = await listAll();
  check("⭐⭐ the 12-day record leaves the STRANDED bucket — one stale case made every `stranded>0` alert noise",
    split.total === 1 && split.stranded[0].owner === "0xBBB");
  check("⭐⭐ …and lands in ABANDONED, counted and named — leaving the queue is not leaving the system",
    split.abandonedTotal === 1 && split.abandoned[0].owner === "0xAAA");

  failMode = "list";
  const darkSplit = await listAll();
  check("⭐⭐ a degraded scan reports abandoned:null, never an empty list — 'nothing abandoned' must mean we looked",
    darkSplit.abandoned === null && darkSplit.degraded === true);
  failMode = null;

  // ── THE SWEEP REPORTS IT, AND STILL TRIGGERS NOTHING FOR IT ───────────────────────────────
  const fs2 = await import("node:fs");
  const sweepSrc3 = fs2.readFileSync("netlify/functions/bridge-mint-sweep.mjs", "utf8");
  check("⭐⭐ the abandoned census is logged BEFORE the clean early-return",
    sweepSrc3.indexOf("ABANDONED burnHash") < sweepSrc3.indexOf("[bridge-sweep] clean"));
  check("⭐ …and names the CAUSE, because it decides who owns the problem", /cause=\$\{st\.cause\}/.test(sweepSrc3));
  check("⭐⭐ …and the abandoned list is never passed to the settler trigger",
    !/for \(const r of abandoned\)[\s\S]{0,400}bridge-mint-settle-background/.test(sweepSrc3));
  check("  …the sweep STILL owns no writes", !/saveReceipt|setJSON|writeReceipt/.test(sweepSrc3));

  // ── THE SETTLER NO LONGER DISCARDS THE HASH ────────────────────────────────────────────────
  const settleSrc = fs2.readFileSync("netlify/functions/bridge-mint-settle-background.mjs", "utf8");
  check("⭐⭐ the rpc_error path RECORDS the IRIS-claimed mint hash — it was discarded ~1,730 times",
    /lastVerifyFailure: chk\.reason,[\s\S]{0,900}irisClaimedMintTxHash: status\.mintTxHash/.test(settleSrc));
  check("⭐ …as `irisClaimedMintTxHash`, never `mintTxHash` — we did not read it, IRIS asserted it",
    !/lastVerifyFailure: chk\.reason,[\s\S]{0,900}\bmintTxHash: status\.mintTxHash/.test(settleSrc));
  check("⭐ …and increments the failed-read streak", /verifyFailureCount: \(Number\.isInteger/.test(settleSrc));

  // ── THE COPY (source-pinned; see the boundary note in §11) ─────────────────────────────────
  const panelSrc2 = fs2.readFileSync("src/components/BridgePanel.tsx", "utf8");
  check('⭐⭐ the chain-unreadable row says the mint was REPORTED COMPLETE and blames our read, not the bridge',
    /cause === "chain_unreadable"[\s\S]{0,900}reported the destination mint as[\s\S]{0,400}our own read/.test(panelSrc2));
  check("⭐⭐ …and says it most likely ARRIVED, rather than 'unproven, may still land'",
    /cause === "chain_unreadable"[\s\S]{0,1400}most likely arrived/.test(panelSrc2));
  check("⭐ the never-appeared row still exists and is NOT given the same sentence",
    /cause !== "chain_unreadable"[\s\S]{0,600}has not been reported by Circle either/.test(panelSrc2));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
