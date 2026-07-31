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
const { writeReceiptNeverThrows, isPastDeadline, listByOwner, readReceipt, receiptKey } =
  await import("../netlify/functions/_bridge-receipts.mjs");

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
  check("⭐⭐ the refusal is LOGGED — a 202 alone cannot prove it refused", /REFUSED — no valid x-internal-token/.test(settlerSrc));
  check("⭐⭐ acceptance is logged TOO — silence must not have to mean 'refused'", /ACCEPTED — internal token valid/.test(settlerSrc));
  check("  …and the wrong-method refusal is logged as well", /REFUSED — method/.test(settlerSrc));
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
  check("⭐⭐ mint_unverified is NEVER auto-retried into minted", JSON.parse(res.body).note === "already terminal");
  check("  …and the record still reads mint_unverified", (await stored()).state === "mint_unverified");
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
  check("⭐ the receipt write is gated on a real burnHash", /if \(r\.burnHash\)/.test(src));
  check("⭐⭐ the write is awaited (an un-awaited write can be frozen away)", /await writeReceiptNeverThrows\(/.test(src));
  check("⭐⭐ the settler trigger is NOT awaited — no 4-min loop in a sync handler", /\n\s*triggerSettle\(\{/.test(src));
  check("  …and the handler never branches on the write result", !/writeReceiptNeverThrows\([\s\S]{0,400}?\)\s*;?\s*if\s*\(/.test(src));
  const toml = await import("node:fs").then((fs) => fs.readFileSync("netlify.toml", "utf8"));
  check("⭐⭐ the settler has NO public /api route", !/bridge-mint-settle/.test(toml.replace(/#.*$/gm, "")));
  check("  …while the owner-scoped read does", /\/api\/bridge-receipts/.test(toml));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
