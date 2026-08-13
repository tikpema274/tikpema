// _agent-wallets.mjs — per-user agent wallet provisioning + ownership mapping
// (Sub-brick 2a). Each authenticated identity gets its OWN dev-controlled Circle
// wallet, recorded in a persisted Blobs map. This brick ONLY provisions + maps;
// it does NOT rewire the job lifecycle (jobs still use the shared env wallet — 2b).
//
// SECURITY: the owner key is the SERVER-VERIFIED session identity (from the
// session token), NEVER a client-supplied value. A caller can only ever resolve
// or create the wallet for the identity their session proves.
//
// IDEMPOTENCY: Blobs reads here are eventually consistent (strong consistency
// needs an uncachedEdgeURL that classic-Lambda functions don't get), so a read
// moments after another request's write can be stale. We therefore make the
// WRITE authoritative with an atomic `onlyIfNew` conditional set: only one
// record can ever exist per owner, regardless of a stale read. On a losing
// write we discard our just-created (empty, harmless) wallet and return the
// winner. Requires the caller's handler to have run connectBlobs(event) first.

import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { circle } from "./_circle.mjs";
import { ARC } from "./_arc.mjs";

const STORE = "agent-wallets";
// Eventual-read convergence measured at ~11s on this store, which exceeds a sync
// function's timeout — so we can't block-read the winner after a losing write.
// We do a SHORT best-effort read (in case it converged fast) then signal pending
// and let the caller/client retry once the mapping has propagated.
const SHORT_READS = 3;
const SHORT_DELAY_MS = 500;

// Map key derived from the verified identity address (lowercased). The address
// IS the identity — a passkey SCA and a MetaMask EOA are distinct addresses, so
// address alone is a stable, collision-free owner key.
function ownerKey(identity) {
  return `owner:${identity.address.toLowerCase()}`;
}

async function readRecord(store, key) {
  return store.get(key, { type: "json" });
}

// Short best-effort read after a losing write — bounded so we stay well under
// the function timeout. If it doesn't converge here the caller signals pending.
async function readRecordShort(store, key) {
  for (let i = 0; i < SHORT_READS; i++) {
    const rec = await readRecord(store, key);
    if (rec?.walletId) return rec;
    await new Promise((r) => setTimeout(r, SHORT_DELAY_MS));
  }
  return null;
}

// Create a fresh dev-controlled SCA wallet for this identity. Circle API only —
// no on-chain tx, no gas, no funds move.
async function provisionWallet(identity) {
  const client = circle();
  const walletSet = await client.createWalletSet({
    name: `Tikpema owner ${identity.address.slice(0, 10)}`,
  });
  const walletSetId = walletSet.data?.walletSet?.id ?? "";
  const wallets = await client.createWallets({
    blockchains: [ARC.blockchain],
    count: 1,
    walletSetId,
    accountType: "SCA",
  });
  const w = wallets.data?.wallets?.[0];
  if (!w) throw new Error("wallet creation returned no wallet");
  return {
    owner: identity.address.toLowerCase(),
    method: identity.method,
    walletId: w.id,
    walletAddress: w.address,
    walletSetId,
    createdAt: new Date().toISOString(),
  };
}

// ═══ 🚨 A DIAGNOSIS MUST BE EARNED, NOT BORROWED ═════════════════════════════════════════════
// The `wallet-unresolvable` refusal tells the user "this is temporary, retry shortly". That is TRUE
// for a Blobs outage or a Circle failure. It is FALSE for a programming error — and a catch that
// says "anything thrown here is a transient race" would hand a permanent bug a retry instruction
// that can never succeed, on 18 endpoints at once. Same shape as one headline stretched across four
// refund paths, multiplied.
//
// ⭐ SO THE FAILURE IS TAGGED AT THE SOURCE, where we know WHY it failed. Only calls to something
// EXTERNAL (the blob store, Circle) are tagged. Anything else propagates UNCLAIMED and surfaces as
// the bare 500 it deserves — loud, unexplained, and correctly so.
class WalletUnresolvable extends Error {
  constructor(cause, op) {
    super(`wallet unresolvable during ${op}`);
    this.name = "WalletUnresolvable";
    this.op = op;
    this.cause = cause;
  }
}
export const isWalletUnresolvable = (e) => e?.name === "WalletUnresolvable";

// ⚠️ PROGRAMMING ERRORS ARE NEVER "THE SERVICE IS DOWN". A TypeError from a bad refactor inside this
// module would otherwise be tagged as external and told to retry. These pass through untagged.
const PROGRAMMING = [TypeError, ReferenceError, SyntaxError, RangeError];

/** Run an EXTERNAL call, tagging its failure as unresolvable-but-retryable. */
async function attempt(op, fn) {
  try {
    return await fn();
  } catch (e) {
    if (PROGRAMMING.some((C) => e instanceof C)) throw e;   // unclaimed, on purpose
    throw new WalletUnresolvable(e, op);
  }
}

// Read this identity's mapped wallet, or null if none provisioned yet.
export async function getOwnerWallet(identity) {
  const store = getStore(STORE);
  return readRecord(store, ownerKey(identity));
}

// Return the identity's own wallet, provisioning one on first call. Idempotent:
// a second call (same identity) returns the same wallet, never a new mapping.
export async function ensureOwnerWallet(identity) {
  const store = getStore(STORE);
  const key = ownerKey(identity);

  // Fast path: an already-mapped wallet.
  const existing = await attempt("store-read", () => readRecord(store, key));
  if (existing?.walletId) return { ...existing, provisioned: false };

  // ═══ 🚨 CONFIRM THE ABSENCE BEFORE ACTING ON IT ═════════════════════════════════════════
  // ⭐ A SINGLE MISSED READ USED TO MINT A REAL CIRCLE WALLET. This store is eventually
  // consistent, so one read returning nothing does NOT mean no mapping exists — and the next
  // line creates a wallet SET and a WALLET at Circle before we ever discover otherwise. The
  // `onlyIfNew` write below then correctly refuses to remap, and that wallet is abandoned.
  // MEASURED: this happened on 2026-08-12 at 20:02, three minutes after the same session read
  // the mapping successfully at 19:59.
  //
  // ⭐⭐ AN ABSENCE MUST BE CONFIRMED BEFORE IT AUTHORISES AN IRREVERSIBLE ACT. The recurring
  // failure family in this repo is an absence READING AS SAFE; this is its mirror — an absence
  // reading as PERMISSION. Creating a wallet is not reversible, so the absence must be worth
  // more than one lagging read.
  //
  // ⚠️ THIS REDUCES THE LEAK, IT DOES NOT ELIMINATE IT. Lag longer than the short-read window
  // still provisions and abandons. Eliminating it entirely means CLAIMING the key with a
  // placeholder BEFORE provisioning — but then a provision that throws leaves a placeholder with
  // no walletId, and every later call reads it, fails the walletId test, and returns `pending`
  // FOREVER. That is a permanent lockout, the exact shape just fixed in ub-withdraw. A bounded
  // leak is strictly better than an unbounded lockout, so this stops here deliberately.
  //
  // ⚠️ COST: ~1.5s added to a GENUINE first provision (3 × 500ms). That happens ONCE per user;
  // a read-miss can happen on any cold start. The asymmetry is what makes the trade worth it.
  const confirmed = await attempt("store-read", () => readRecordShort(store, key));
  if (confirmed?.walletId) return { ...confirmed, provisioned: false };

  // No mapping seen — provision, then commit atomically. `onlyIfNew` is
  // server-authoritative: it succeeds only if the key is genuinely absent, so a
  // stale read above can't cause a duplicate mapping.
  const record = await attempt("circle-provision", () => provisionWallet(identity));
  const res = await attempt("store-write", () => store.set(key, JSON.stringify(record), { onlyIfNew: true }));

  if (res && res.modified === false) {
    // We lost the race (or our read was stale): a mapping already exists — our
    // just-created wallet is abandoned (empty, never funded), NOT a duplicate
    // mapping. Try a short read for the winner; if it hasn't propagated yet,
    // signal pending so the caller returns 202 and the client retries.
    const winner = await attempt("store-read", () => readRecordShort(store, key));
    if (winner?.walletId) return { ...winner, provisioned: false };
    return { pending: true };
  }

  return { ...record, provisioned: true };
}

// ═══ 🚨 THE PROVISIONING REFUSAL — ONE BODY, SEVEN CALLERS ═══════════════════════════════════
// `ensureOwnerWallet` can report `pending` on a first-login race. Endpoints used to answer that
// with **202**, which on every money endpoint ALSO means "your transaction is in flight". Two
// opposite meanings — "nothing happened, retry freely" and "retrying double-spends" — behind one
// status code, discriminated only by a body field.
//
// ⭐ MEASURED 2026-08-12 on ub-withdraw: a provisioning 202 was read as a started withdrawal three
// times in one session, costing ~2 hours. The obvious remedy for a 202-with-no-effect is to POST
// AGAIN — which, against a REAL 202, is a duplicate money movement.
//
// ⭐⭐ AND IT WAS ALREADY WRONG IN THE CLIENT, NOT ONLY CONFUSING. 202 passes `res.ok`, so
// agent-send, agent-withdraw, agent-bridge, agent-act and job-bridge-approve all handed this body
// back to their callers AS A SUCCESSFUL RESULT. `sendFromAgent` returned `{status:"provisioning"}`
// where a receipt belonged. The absence of a transaction was reading as a completed one — this
// repo's recurring failure family, on the money path.
//
// ⭐ 503 IS THE HONEST CODE: transient, nothing happened, retry safe. It matches the
// balance-unreadable refusals already in this codebase, and `!res.ok` makes every existing client
// throw the message instead of silently succeeding.
//
// ⚠️ ONE DEFINITION ON PURPOSE. Seven copies of a constant is the duplicate-source-of-truth failure
// this repo keeps meeting; a guard asserts every call site uses THIS.
export const WALLET_PROVISIONING_STATUS = 503;
export const walletProvisioningRefusal = () => ({
  error: "Your agent wallet is still being set up, so nothing has been started.",
  reason: "wallet-provisioning",
  retryable: true,
  retryAfterSeconds: 15,
  // ⭐ State the safe fact explicitly. This is the response most likely to be misread as "something
  // began", and the cost of that misreading is a duplicate payment.
  whatHappened: "nothing. No funds moved and no job was started. Retrying is safe.",
});

// ═══ 🚨 WHEN THE WALLET CANNOT BE RESOLVED AT ALL ════════════════════════════════════════════
// `ensureOwnerWallet` THROWS on a failed store read or a Circle failure (`createWalletSet`,
// `createWallets`, "wallet creation returned no wallet"). 18 of its 19 callers do not catch it, so
// it surfaced as a bare 500 — loud and fail-closed, but saying NOTHING about whether it is safe to
// retry or whether anything happened. Those are the two facts a caller most needs.
//
// ⭐⭐ THE THROW IS KEPT ON PURPOSE. Returning a failure VALUE instead would be strictly worse:
// callers do `const owner = wallet.walletAddress`, which would become `undefined` and flow into
// chain calls. A throw cannot be accidentally ignored; a falsy field can. So this fixes how the
// failure SURFACES, not whether it stops the request.
//
// ⭐ IT IS A REFUSAL, NOT AN ERROR REPORT: nothing was started, and a retry is safe. Same shape and
// status as walletProvisioningRefusal — both mean "we could not get you a wallet right now".
export const WALLET_UNRESOLVABLE_STATUS = 503;
export const walletUnresolvableRefusal = (e) => ({
  error: "We couldn’t reach your wallet service just now, so nothing has been started.",
  reason: "wallet-unresolvable",
  retryable: true,
  retryAfterSeconds: 20,
  whatHappened: "nothing. No funds moved and no job was started. Retrying is safe.",
  // ⚠️ NAME ONLY, never the message: a Circle error can carry request ids or key fragments, and this
  // body is returned to the browser.
  detail: String(e?.name || "Error"),
});
