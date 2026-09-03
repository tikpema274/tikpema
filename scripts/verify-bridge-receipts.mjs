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
const { recordPendingBridge, bridgeReceiptRatio } = await import("../netlify/functions/_bridge-record.mjs");

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

  // ── 🚨 THE PROJECTION MUST CARRY THE CONSENT JOIN ────────────────────────────────────────────
  // `recordBridge` has always persisted quoteId/quoteStepIndex, but this endpoint omitted them, so
  // the only supported way to read a receipt showed `ackAcceptedAt` with NO WAY to reach the quote
  // that authorised it. On 2026-08-17 that produced a false finding: the first plan-path receipts
  // ever written were read here and reported as carrying no quoteId, while the stored records held
  // one the whole time.
  //
  // ⚠️ ASSERTED AS KEY-PRESENCE, NOT VALUE. An omitted field reads as `undefined`, which a client
  // renders identically to a legitimate null — and null IS correct for the direct Bridge page,
  // which has no quote. A value-only check would pass while the field was missing, which is exactly
  // the confusion this exists to prevent. `"quoteId" in row` is the property.
  await seed({
    quoteId: "q_mstest0000_0123456789abcdef", quoteStepIndex: 1,
    ackBand: "acknowledge", ackRequired: true, ackAcceptedAt: "2026-08-17T00:00:00.000Z",
  });
  const jrow = JSON.parse((await listHandler({ httpMethod: "GET", headers: { authorization: "Bearer x" } })).body).receipts[0];
  check("⭐⭐ the projection EXPOSES quoteId — an absent key renders as null and hides the join",
    jrow != null && "quoteId" in jrow);
  check("⭐⭐ …and quoteStepIndex, without which the join cannot address a STEP",
    jrow != null && "quoteStepIndex" in jrow);
  check("  …carrying the stored values rather than defaults",
    jrow?.quoteId === "q_mstest0000_0123456789abcdef" && jrow?.quoteStepIndex === 1);

  // ⚠️ STEP INDEX 0 IS FALSY — a `?? null` or `|| null` here would erase the FIRST step of every
  // plan, which is precisely the step whose null ackAcceptedAt carries the discrimination.
  await seed({ quoteId: "q_mstest0000_0123456789abcdef", quoteStepIndex: 0 });
  const zrow = JSON.parse((await listHandler({ httpMethod: "GET", headers: { authorization: "Bearer x" } })).body).receipts[0];
  check("🚨 step index 0 survives projection — a falsy index must not become null",
    zrow?.quoteStepIndex === 0, `got ${JSON.stringify(zrow?.quoteStepIndex)}`);

  // The direct Bridge page has no quote; null there is CORRECT and must stay distinguishable.
  await seed({});
  const nrow = JSON.parse((await listHandler({ httpMethod: "GET", headers: { authorization: "Bearer x" } })).body).receipts[0];
  check("  …while a receipt with no quote projects an explicit null, not an absent key",
    nrow != null && "quoteId" in nrow && nrow.quoteId === null && nrow.quoteStepIndex === null);

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
      // ⭐ THE ERROR-PATH SHAPE, POST-2026-08-30. `_actions` attaches feeCharged: null here on
      // purpose — agentBridge threw, so the SIGNED fee is genuinely unknown and must not be filled
      // in from the gated one. `netUsdc` is null for the same reason: it pairs with feeCharged.
      feeCharged: null, feeDisclosed: 0.053216, netUsdc: null, feeBand: "acknowledge",
      ackRequired: true, acknowledged: true, ackToken: "tok_abc",
    },
  });
  const out = await recordPendingBridge({ e: err, session: { address: OWNER }, amountRequested: 0.1 });
  check("⭐⭐ the pending path WRITES (it used to write nothing at all)", out.recorded === true);

  const rec = await (await import("@netlify/blobs")).getStore("x").get(pendingReceiptKey(OWNER, TXID));
  check("⭐⭐ …under a txId key, not a hash key", !!rec, pendingReceiptKey(OWNER, TXID));
  check("⭐⭐ ackAcceptedAt IS WRITTEN — the whole point", typeof rec?.ackAcceptedAt === "string" && rec.ackAcceptedAt.length > 10, rec?.ackAcceptedAt);
  check("⭐ …with the band that was accepted", rec?.ackBand === "acknowledge");
  // ⚠️ WAS `rec.feeRatio === 0.53216`. The ratio is no longer STORED — it was a duplicate of
  // feeDisclosed/amountRequested and the defect was that duplicate disagreeing with its source.
  // What must be on the record is the fee the band was computed FROM, so the band stays explicable.
  check("⭐⭐ …and the DISCLOSED fee it was computed from, so the band is explicable from the record",
    rec?.feeDisclosed === 0.053216, `${rec?.feeDisclosed}`);
  check("⭐⭐ …while feeCharged is explicitly NULL — the signing call threw, so it is unknown, not the gated fee",
    rec !== null && "feeCharged" in rec && rec.feeCharged === null,
    "this is the defect where a timed-out bridge reported a different fee than a completed one");
  check("🚨 …and no feeRatio is stored to disagree with either",
    rec !== null && !("feeRatio" in rec), Object.keys(rec ?? {}).filter((k) => /fee/i.test(k)).join(","));
  check("⭐ …and the derived ratio reproduces the accepted band",
    bridgeReceiptRatio(rec) !== null && Math.abs(bridgeReceiptRatio(rec) - 0.53216) < 1e-9,
    `${bridgeReceiptRatio(rec)}`);
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

  // ── THE COPY — NOW OWNED BY A RENDERING TEST ───────────────────────────────────────────────
  // ⭐⭐ THE SOURCE REGEXES THAT LIVED HERE ARE DELETED, NOT WEAKENED. Across four commits they
  // failed four times and caught ZERO real defects — every failure was text MOVING (JSX wrapping a
  // phrase across lines, a branch growing and pushing the match past the char window) — and each
  // failure was "fixed" by WIDENING the window, so the guard was progressively loosened by its own
  // false alarms. Then it missed a real one: `d8483f1` silently deleted "This will not resolve on
  // its own" from the unresolved row and the widened regex still passed, because it only asserted
  // the phrase that survived.
  // ⚠️ KEEPING THEM ALONGSIDE THE RENDERING TEST WOULD KEEP THE COST AND ADD NOTHING — two guards
  // on one claim, one of which cries wolf, teaches people to ignore both.
  // ⭐ `scripts/verify-bridge-copy.tsx` (npm run test:bridgecopy, chained into test:bridge) renders
  // BridgeReceiptStatus with react-dom/server and asserts on the TEXT A BROWSER PAINTS. It found
  // that deletion on its first run.
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
  // ═══ 🚨 THERE IS ONLY ONE waitForTx ON THE AGENT PATH NOW, AND THAT IS THE FIX, NOT A GAP ═════
  // This asserted BOTH tags because `agentBridge` awaited twice — an approve and a burn — and a
  // `txId` alone could not say which had stalled. The two are now ONE userOp (`executeBatch`), so
  // there is a single await and "burn" is the only truthful stage.
  // ⛔ THE TAG STILL MATTERS AND IS STILL ASSERTED. Provisional records written by earlier deploys
  // carry `approve`, and `bridge-reconcile-background` REFUSES an untagged record rather than
  // guessing — so the stage vocabulary must stay intact even though this path can no longer
  // produce the second value. ⚠️ Deleting the assertion because one branch went away would unpin
  // the tag that the reconcile job's refusal depends on.
  check("⭐⭐ the single agent-path await still tags its stage — the reconcile job refuses an untagged record",
    /e\.stage = "burn"/.test(bridgeSrc));
  check("⭐ …and the SELF-SIGNED path's stage vocabulary is unchanged, so old records still reconcile",
    PENDING_STAGES.includes("approve") && PENDING_STAGES.includes("burn"));
  // 🚨 AND THE REASON THE APPROVE STAGE CANNOT ARISE HERE ANY MORE IS ASSERTED, so a future split
  // does not quietly resurrect an untagged await.
  check("🚨 …because the agent path submits exactly one transaction",
    (bridgeSrc.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ")
      .match(/createContractExecutionTransaction\(/g) || []).length === 1);
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
    /lastVerifyFailure: chk\.reason,[\s\S]{0,2200}irisClaimedMintTxHash: status\.mintTxHash/.test(settleSrc));
  check("⭐ …as `irisClaimedMintTxHash`, never `mintTxHash` — we did not read it, IRIS asserted it",
    !/lastVerifyFailure: chk\.reason,[\s\S]{0,2200}\bmintTxHash: status\.mintTxHash/.test(settleSrc));
  check("⭐ …and increments the failed-read streak", /verifyFailureCount: \(Number\.isInteger/.test(settleSrc));

  // ── THE COPY — see §11: owned by scripts/verify-bridge-copy.tsx, which renders it. ─────────
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("14 — THE DEAD ENDPOINT: a permanent fault must not wear a transient costume");
// 🚨 THE ROOT CAUSE of the twelve-day record, measured 2026-08-15: `rpc-amoy.polygon.technology`
// HAS NO DNS RECORD (two independent resolvers agree; `polygon.technology` itself resolves fine).
// So verification failed 100% of the time — and 100% is the tell, because rate limits and flaky
// nodes are INTERMITTENT. Nothing could see it, because nothing ever asked "is this endpoint
// alive?" outside a money-path check that only runs when a bridge needs it.
{
  // ⚠️ `_receipt.mjs` is MOCKED at the top of this suite (verifyMintOnChain is stubbed so the
  // settler's branches can be driven). A plain import here would hand back that stub, so these
  // checks would silently test the mock instead of the code — the exact shape of a test that
  // proves nothing. The query suffix resolves to a DISTINCT module specifier, bypassing the mock
  // and loading the real file. Pure functions only; nothing here touches the network.
  const { classifyRpcFailure, DESTINATION_CHAINS } = await import("../netlify/functions/_receipt.mjs?real");
  const withCause = (code) => Object.assign(new Error("fetch failed"), { cause: { code } });

  check("⭐⭐ a DNS failure classifies as `unreachable` — permanent, ours, one line to fix",
    classifyRpcFailure(withCause("ENOTFOUND")).failureKind === "unreachable");
  check("  …as do refused connections and bad certs",
    classifyRpcFailure(withCause("ECONNREFUSED")).failureKind === "unreachable" &&
    classifyRpcFailure(withCause("ERR_TLS_CERT_ALTNAME_INVALID")).failureKind === "unreachable");
  check("⭐ a timeout classifies as `transient` — someone else's node, probably fine in a minute",
    classifyRpcFailure(Object.assign(new Error("The operation was aborted due to timeout"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } })).failureKind === "transient");
  check("⭐⭐ an UNKNOWN failure defaults to `transient`, not `unreachable`",
    classifyRpcFailure(new Error("something we have never seen")).failureKind === "transient");
  check("  …because calling it permanent SENDS A HUMAN to change config — permanence must be EARNED",
    classifyRpcFailure({}).failureKind === "transient");
  check("⭐ the message is carried with its code, so the record can name the actual fault",
    /ENOTFOUND/.test(classifyRpcFailure(withCause("ENOTFOUND")).detail));

  // ── THE URL ITSELF ─────────────────────────────────────────────────────────────────────────
  check("⭐⭐ the DEAD host is gone from the config — it resolved nowhere for twelve days",
    !Object.values(DESTINATION_CHAINS).some((c) => /rpc-amoy\.polygon\.technology/.test(c.rpc)));
  check("  …polygon points at hosts that answer, and the chainId pin is unchanged at 80002",
    DESTINATION_CHAINS.polygon.rpcs.every((u) => /^https:\/\//.test(u)) && DESTINATION_CHAINS.polygon.chainId === 80002);
  check("⭐ every destination still pins BOTH a chainId and a USDC address — the two things that make a read PROOF",
    Object.values(DESTINATION_CHAINS).every((c) => Number.isInteger(c.chainId) && /^0x[0-9a-fA-F]{40}$/.test(c.usdc)));

  // ── THE SETTLER MUST STOP DISCARDING THE DIAGNOSIS ─────────────────────────────────────────
  const fs3 = await import("node:fs");
  const settleSrc2 = fs3.readFileSync("netlify/functions/bridge-mint-settle-background.mjs", "utf8");
  check("⭐⭐ the rpc_error path now records the DETAIL — it was computed and thrown away ~1,730 times",
    /lastVerifyFailure: chk\.reason,[\s\S]{0,900}lastVerifyFailureDetail: chk\.detail/.test(settleSrc2));
  check("⭐⭐ …and the `unreachable`/`transient` discriminator, which is who-owns-this",
    /lastVerifyFailureKind: chk\.failureKind/.test(settleSrc2));
  check("⭐ …and WHICH endpoint failed, so a future dead URL names itself",
    /lastVerifyRpc: chk\.rpc/.test(settleSrc2));

  // ── THE GATE EXISTS AND BLOCKS DEPLOYS ─────────────────────────────────────────────────────
  const pkg = JSON.parse(fs3.readFileSync("package.json", "utf8"));
  check("⭐⭐ `gate:rpc` runs BEFORE the build in deploy:prod — a dead endpoint blocks the deploy",
    /gate:rpc/.test(pkg.scripts["deploy:prod"]) &&
    pkg.scripts["deploy:prod"].indexOf("gate:rpc") < pkg.scripts["deploy:prod"].indexOf("netlify deploy"));
  const gateSrc = fs3.readFileSync("scripts/verify-destination-rpcs.mjs", "utf8");
  check("⭐⭐ the gate fails on `unreachable` but only WARNS on transient — a gate that blocks on someone else's bad minute gets disabled",
    /kind === "unreachable"\) \|\| healthy\.length === 0 \|\| STRICT/.test(gateSrc));
  check("⭐⭐ …and a chain with only ONE endpoint is called out as the residual single point of failure",
    /single point of failure for verification/.test(gateSrc));
  check("⭐⭐ …and DEGRADED redundancy is its own headline — a dead SECONDARY is invisible at runtime",
    /REDUNDANCY DEGRADED/.test(gateSrc) && /r\.healthy >= 1/.test(gateSrc));
  check("⭐ …checks the chainId PIN, not merely liveness — a healthy RPC for the wrong chain is worse than a dead one",
    /CHAIN MISMATCH/.test(gateSrc));
  check("⭐ …checks eth_getTransactionReceipt is actually permitted, not just eth_chainId",
    /eth_getTransactionReceipt/.test(gateSrc));
  check("⭐⭐ …and that the PINNED USDC has code — proof the endpoint is that chain AND the address is real",
    /HAS NO CODE/.test(gateSrc));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("15 — TWO ENDPOINTS PER CHAIN: the single point of failure, closed");
// 🚨 Swapping the dead Amoy URL fixed ONE instance and left the architecture unchanged: every chain
// still had exactly one endpoint, so the next decommissioned host reproduces the same twelve-day
// silence elsewhere. ⚠️ FALLBACK, NOT QUORUM — integrity here is already pinned three ways (chainId,
// USDC address, recipient), so requiring AGREEMENT would turn a second endpoint being down into a
// REFUSAL: an availability fix that invents a new way to fail.
{
  const { DESTINATION_CHAINS: CH, verifyMintOnChain } = await import("../netlify/functions/_receipt.mjs?real2");
  const RECIP = "0x" + "ab".repeat(20);
  const HASH = "0x" + "d4".repeat(32);
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const padded = "0x" + "0".repeat(24) + RECIP.slice(2);

  check("⭐⭐ EVERY chain carries at least two endpoints — no chain is one dead host from silence",
    Object.values(CH).every((c) => Array.isArray(c.rpcs) && c.rpcs.length >= 2),
    Object.entries(CH).map(([k, c]) => `${k}:${c.rpcs.length}`).join(" "));
  check("⭐ …and the two are DIFFERENT hosts (a duplicate would be redundancy in name only)",
    Object.values(CH).every((c) => new Set(c.rpcs.map((u) => new URL(u).host)).size === c.rpcs.length));

  // ⚠️ `base`, NOT `polygon`: this suite mocks _bridge.mjs with a BRIDGE_DESTINATIONS containing only
  // `base`, and verifyMintOnChain refuses an unlisted destination before it ever reads a chain. The
  // fixture must live inside the mock's world or it tests the refusal instead of the fallback.
  // A fetch stub keyed on URL: each endpoint can succeed, throw, or lie about its chain.
  const realFetch = globalThis.fetch;
  const ok = (result) => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
  const receipt = { status: "0x1", blockNumber: "0x10", logs: [
    { address: CH.base.usdc, topics: [TRANSFER, padded, padded], data: "0x" + (949990).toString(16) },
  ] };
  const drive = (behaviour) => {
    globalThis.fetch = async (url, init) => {
      const m = JSON.parse(init.body).method;
      const b = behaviour[new URL(url).host];
      if (b === "dead") { const e = new Error("fetch failed"); e.cause = { code: "ENOTFOUND" }; throw e; }
      if (b === "slow") { const e = new Error("timeout"); e.cause = { code: "UND_ERR_HEADERS_TIMEOUT" }; throw e; }
      if (b === "wrongchain") return ok("0x1");
      if (m === "eth_chainId") return ok("0x" + CH.base.chainId.toString(16));
      if (m === "eth_getTransactionReceipt") return ok(receipt);
      return ok("0x00");
    };
  };
  const [P1, P2] = CH.base.rpcs.map((u) => new URL(u).host);
  const verify = () => verifyMintOnChain({ destinationKey: "base", mintTxHash: HASH, recipient: RECIP });

  drive({ [P1]: "dead", [P2]: "live" });
  let r = await verify();
  check("⭐⭐ PRIMARY DEAD, secondary alive ⇒ the mint still VERIFIES — the twelve-day silence, prevented",
    r.verified === true, JSON.stringify(r).slice(0, 90));

  drive({ [P1]: "dead", [P2]: "dead" });
  r = await verify();
  check("⭐⭐ BOTH dead ⇒ rpc_error with aggregate kind `unreachable` — ours, permanent, gate-catchable",
    r.verified === false && r.reason === "rpc_error" && r.failureKind === "unreachable");
  check("  …and it names how many endpoints were tried, so 'it failed' cannot hide 'all of them failed'",
    r.endpointsTried === 2);

  drive({ [P1]: "dead", [P2]: "slow" });
  r = await verify();
  check("⭐⭐ one dead + one TIMED OUT ⇒ aggregate is `transient`, NOT unreachable — a mixed set must not be called permanent",
    r.failureKind === "transient");

  drive({ [P1]: "wrongchain", [P2]: "live" });
  r = await verify();
  check("⭐⭐ a WRONG-CHAIN primary is NOT retried onto the sibling — that is a config fault, and falling through would hide it",
    r.verified === false && r.reason === "chain_mismatch" && r.saw === 1);

  globalThis.fetch = realFetch;
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
