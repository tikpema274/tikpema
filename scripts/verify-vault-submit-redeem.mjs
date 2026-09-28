// verify-vault-submit-redeem.mjs — piece 5 step 2: submitRedeem, factored out of vaultWithdraw.
//
//   node --experimental-test-module-mocks scripts/verify-vault-submit-redeem.mjs
//
// ═══ WHY (PROGRESS: PIECE 5 DESIGN CORRECTIONS, C4; EXECUTOR BUILD ORDER step 2) ═══════════════════
// The exit executor needs a redeem it can RECOVER: the Circle id recorded the moment Circle accepts (onSubmitted),
// and a caller-supplied idempotency key derived from the intent key, so a crash between Circle accepting and the
// intent recording the id cannot lose the transaction. vaultWithdraw had neither. It is REBUILT on submitRedeem,
// and it is the LIVE manual reclaim users can reach today, so its behaviour is pinned here too.
//
// ═══ THE KEY'S FORMAT (Circle docs, read 2026-09-28) ══════════════════════════════════════════════
// developers.circle.com/w3s/idempotent-requests: "you must generate and provide an idempotency key formatted as a
// UUID version 4". The SDK's own type docs (CreateContractExecutionTransactionForDeveloperRequest): "UUID v4 … If the
// same key is reused, it will be treated as the same request and the original response will be returned." A UUIDv5
// breaks the documented format, so the key is DETERMINISTIC but v4-SHAPED (version nibble 4, RFC 4122 variant).
//
// ⭐ The REAL vaultWithdraw / submitRedeem run. Only the BOUNDARIES are faked: the Circle client and the public
// client. [[never-mock-the-function-under-test]]
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const REAL_CIRCLE = await import("../netlify/functions/_circle.mjs");
const { ARC } = await import("../netlify/functions/_arc.mjs");

const OWNER = "0x1111111111111111111111111111111111111111";
const VAULT = "0x2222222222222222222222222222222222222222";
const ASSET = "0x3333333333333333333333333333333333333333";
const HASH = "0x" + "ab".repeat(32);
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ── the fixture: every boundary call is recorded, in order ────────────────────────────────────
let W;
const reset = (over = {}) => {
  W = {
    redeemed: false, events: [], creates: [],
    usdcBefore: 100_000_000n, usdcAfter: 101_998_000n, sharesAfter: 0n,
    usdcBeforeFails: false, usdcAfterFails: false, receipt: "success", receiptThrows: false,
    circleId: "circle-tx-1", createThrows: false, waitThrows: false,
    ...over,
  };
};
const fakePc = {
  readContract: async ({ address, functionName }) => {
    const a = address.toLowerCase();
    if (functionName === "balanceOf" && a === ASSET.toLowerCase()) {
      W.events.push(`read-usdc-${W.redeemed ? "after" : "before"}`);
      if (!W.redeemed && W.usdcBeforeFails) throw new Error("fixture: rpc down (before)");
      if (W.redeemed && W.usdcAfterFails) throw new Error("fixture: rpc down (after)");
      return W.redeemed ? W.usdcAfter : W.usdcBefore;
    }
    if (functionName === "balanceOf" && a === VAULT.toLowerCase()) { W.events.push("read-shares"); return W.redeemed ? W.sharesAfter : 1_999_996n; }
    if (functionName === "decimals") return 6;
    throw new Error(`fixture: unexpected read ${functionName}`);
  },
  getTransactionReceipt: async () => { W.events.push("receipt"); if (W.receiptThrows) throw new Error("fixture: receipt rpc down"); return { status: W.receipt }; },
};
const fakeCircle = {
  createContractExecutionTransaction: async (args) => {
    W.events.push("circle-create");
    W.creates.push(args);
    if (W.createThrows) throw new Error("fixture: circle 503");
    if (String(args.abiFunctionSignature).startsWith("redeem(")) W.redeemed = true;
    return { data: { id: W.circleId } };
  },
};
mock.module("../netlify/functions/_circle.mjs", {
  namedExports: { ...REAL_CIRCLE, circle: () => fakeCircle,
    waitForTx: async (_c, id) => { W.events.push(`wait:${id}`); if (W.waitThrows) throw new Error("fixture: Circle FAILED"); return HASH; } },
});
const REAL_PREDICT = await import("../netlify/functions/_predict.mjs");
mock.module("../netlify/functions/_predict.mjs", { namedExports: { ...REAL_PREDICT, publicClient: () => fakePc } });

const V = await import("../netlify/functions/_vault.mjs");
const IK = await import("../shared/circle-idempotency.mjs").catch((e) => ({ __missing: String(e?.message ?? e) }));
const VAULT_DESC = { key: "fixture-vault", address: VAULT, assetAddress: ASSET, shareSymbol: "fxSHR", label: "Fixture Vault" };

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n       → ${detail}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t}`);
const attempt = async (fn) => { try { return await fn(); } catch (e) { return { threw: String(e?.message ?? e) }; } };
const hasSubmit = typeof V.submitRedeem === "function";
const hasKey = typeof IK.idempotencyKeyFor === "function";

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("A — the idempotency key: deterministic from the intent key, v4-SHAPED (Circle's documented format)");
check("(idempotencyKeyFor is exported from shared/circle-idempotency.mjs)", hasKey, IK.__missing ?? "");
if (hasKey) {
  const k1 = IK.idempotencyKeyFor("x/0xabc/m-1"), k2 = IK.idempotencyKeyFor("x/0xabc/m-1"), k3 = IK.idempotencyKeyFor("x/0xabc/m-2");
  check("⭐⭐ the same intent key → the SAME key (recovery can recompute it after a crash)", k1 === k2, `${k1} / ${k2}`);
  check("a different intent key → a different key", k1 !== k3);
  check("⭐ v4-SHAPED: version nibble 4, variant 8|9|a|b (never a v5)", V4.test(k1) && V4.test(k3), k1);
  // Pinned derivation: a change here changes every key an open intent will be recovered by.
  const d = createHash("sha256").update("tikpema/vault-mandate/idempotency/v1\n" + "x/0xabc/m-1").digest();
  d[6] = (d[6] & 0x0f) | 0x40; d[8] = (d[8] & 0x3f) | 0x80;
  const h = d.subarray(0, 16).toString("hex");
  const expect = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  check("⭐ the derivation is PINNED (sha256 of a versioned namespace + the intent key, first 16 bytes)", k1 === expect, `${k1} vs ${expect}`);
  for (const [label, bad] of [["empty", ""], ["not a string", 42], ["null", null], ["undefined", undefined]]) {
    check(`an intent key that is ${label} → THROWS (never a key for nothing)`, (await attempt(() => IK.idempotencyKeyFor(bad)))?.threw !== undefined);
  }
  check("isV4Uuid accepts the derived key, refuses a v5 and a free string",
    typeof IK.isV4Uuid === "function" && IK.isV4Uuid(k1) && !IK.isV4Uuid(k1.replace(/^(.{14})4/, "$15")) && !IK.isV4Uuid("x/0xabc/m-1"));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("B — submitRedeem: the key passes through; the hook fires the moment Circle accepts");
check("(submitRedeem is exported from _vault.mjs)", hasSubmit);
if (hasSubmit && hasKey) {
  const KEY = IK.idempotencyKeyFor("x/0xabc/m-1");
  reset();
  const seen = [];
  const r = await attempt(() => V.submitRedeem({ walletAddress: OWNER, vault: VAULT_DESC, shares: "1999996", idempotencyKey: KEY,
    onSubmitted: async (x) => { W.events.push("hook"); seen.push(x); } }));
  check("⭐⭐ the key reaches Circle EXACTLY (createContractExecutionTransaction.idempotencyKey)", W.creates.length === 1 && W.creates[0].idempotencyKey === KEY, JSON.stringify(W.creates[0] ?? null));
  check("⭐⭐ the hook fires with the Circle id (and the key) BEFORE the wait",
    seen.length === 1 && seen[0].circleId === "circle-tx-1" && seen[0].stage === "redeem" && seen[0].idempotencyKey === KEY &&
    W.events.indexOf("hook") > W.events.indexOf("circle-create") && W.events.indexOf("hook") < W.events.indexOf("wait:circle-tx-1"), W.events.join(" → "));
  check("it returns the Circle id AND the hash", r?.circleId === "circle-tx-1" && r?.redeemHash === HASH, JSON.stringify(r));
  const c = W.creates[0] ?? {};
  check("the call: redeem(shares, receiver=self, owner=self) on the vault, from the wallet, on Arc, MEDIUM fee",
    c.contractAddress === VAULT && c.abiFunctionSignature === "redeem(uint256,address,address)" &&
    JSON.stringify(c.abiParameters) === JSON.stringify(["1999996", OWNER, OWNER]) && c.walletAddress === OWNER &&
    c.blockchain === ARC.blockchain && JSON.stringify(c.fee) === JSON.stringify({ type: "level", config: { feeLevel: "MEDIUM" } }), JSON.stringify(c));

  // ⛔ The hook throwing must not lose the transaction.
  for (const [label, hook] of [["throws", () => { throw new Error("blobs down"); }], ["rejects", async () => { throw new Error("blobs down"); }]]) {
    reset();
    const t = await attempt(() => V.submitRedeem({ walletAddress: OWNER, vault: VAULT_DESC, shares: "5", idempotencyKey: KEY, onSubmitted: hook }));
    check(`⭐⭐ the hook ${label} → the redeem is still awaited and its id + hash RETURNED (never lost)`,
      t?.circleId === "circle-tx-1" && t?.redeemHash === HASH && W.events.includes("wait:circle-tx-1") && W.creates.length === 1, JSON.stringify(t));
  }

  reset();
  const noHook = await attempt(() => V.submitRedeem({ walletAddress: OWNER, vault: VAULT_DESC, shares: "5", idempotencyKey: KEY }));
  check("no hook → works (optional)", noHook?.redeemHash === HASH, JSON.stringify(noHook));

  // A malformed key is refused BEFORE anything is signed.
  for (const [label, bad] of [["a v5-shaped key", KEY.replace(/^(.{14})4/, "$15")], ["the raw intent key", "x/0xabc/m-1"], ["an empty string", ""]]) {
    reset();
    const b = await attempt(() => V.submitRedeem({ walletAddress: OWNER, vault: VAULT_DESC, shares: "5", idempotencyKey: bad }));
    check(`⭐ ${label} → THROWS and Circle is never called`, b?.threw !== undefined && W.creates.length === 0, JSON.stringify(b));
  }

  // Circle rejects the create → nothing to record; the error propagates; the hook never fires.
  reset({ createThrows: true });
  let fired = 0;
  const cr = await attempt(() => V.submitRedeem({ walletAddress: OWNER, vault: VAULT_DESC, shares: "5", idempotencyKey: KEY, onSubmitted: () => { fired++; } }));
  check("Circle refuses the create → it throws, and the hook NEVER fires (nothing was accepted)", cr?.threw !== undefined && fired === 0, JSON.stringify(cr));
  // The wait fails AFTER Circle accepted: the hook already has the id; the failure propagates (as before).
  reset({ waitThrows: true });
  const got = [];
  const wt = await attempt(() => V.submitRedeem({ walletAddress: OWNER, vault: VAULT_DESC, shares: "5", idempotencyKey: KEY, onSubmitted: (x) => got.push(x) }));
  check("⭐ Circle accepts, then the wait fails → the hook ALREADY holds the id; the failure propagates",
    wt?.threw !== undefined && got.length === 1 && got[0].circleId === "circle-tx-1", JSON.stringify(wt));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("C — ⛔ vaultWithdraw (the LIVE manual reclaim) is rebuilt on submitRedeem and does not change");
const run = () => V.vaultWithdraw({ walletAddress: OWNER, vault: VAULT_DESC, shares: "1999996" });
{
  const src = readFileSync(new URL("../netlify/functions/_vault.mjs", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export async function vaultWithdraw("), src.indexOf("export async function readShareBalance("));
  check("vaultWithdraw submits THROUGH submitRedeem (one redeem path, not two)", /submitRedeem\(/.test(body) && !/createContractExecutionTransaction/.test(body));
  // A CALL SITE is `abiFunctionSignature: "redeem(…)"` (the file also lists the signature in its ERC-4626 conformance set).
  check("exactly one redeem CALL SITE in _vault.mjs", (src.match(/abiFunctionSignature:\s*"redeem\(uint256,address,address\)"/g) ?? []).length === 1);

  reset();
  const r = await run();
  check("the reclaim sends NO idempotency key (unchanged: the SDK generates one, as before)", W.creates.length === 1 && !("idempotencyKey" in W.creates[0]), JSON.stringify(W.creates[0] ?? null));
  check("the reclaim's Circle call is the same call", W.creates[0]?.abiFunctionSignature === "redeem(uint256,address,address)" &&
    JSON.stringify(W.creates[0]?.abiParameters) === JSON.stringify(["1999996", OWNER, OWNER]) && W.creates[0]?.contractAddress === VAULT &&
    JSON.stringify(W.creates[0]?.fee) === JSON.stringify({ type: "level", config: { feeLevel: "MEDIUM" } }), JSON.stringify(W.creates[0]));
  check("a proven reclaim: confirmed, the measured delta, the hash, emptied",
    r.confirmed === true && r.usdcReceived === 1.998 && r.withdrawHash === HASH && r.position === "emptied" && r.sharesRedeemedRaw === "1999996" && r.verifiedBy === "usdc-balance-delta", JSON.stringify(r));
  check("⭐ order: USDC read BEFORE → submit → wait → receipt → USDC AFTER → shares",
    W.events.join(",") === ["read-usdc-before", "circle-create", "wait:circle-tx-1", "receipt", "read-usdc-after", "read-shares"].join(","), W.events.join(" → "));
}
{
  reset({ usdcBeforeFails: true });
  const r = await run();
  check("⛔ USDC-before unreadable → refused BEFORE signing: confirmed:false and Circle NEVER called", r.confirmed === false && W.creates.length === 0 && /not attempted/.test(r.reason), JSON.stringify(r));
  reset({ receipt: "reverted" });
  const r2 = await run();
  check("a reverted receipt → confirmed:false, shares still in the vault, the hash carried", r2.confirmed === false && r2.withdrawHash === HASH && /didn't confirm/.test(r2.reason), JSON.stringify(r2));
  reset({ receiptThrows: true });
  const r3 = await run();
  check("⭐ receipt UNREADABLE but USDC arrived → confirmed on the delta (the witness settles it)", r3.confirmed === true && r3.usdcReceived === 1.998, JSON.stringify(r3));
  reset({ receiptThrows: true, usdcAfter: 100_000_000n });
  const r4 = await run();
  check("⭐ receipt UNREADABLE and no USDC → confirmed:false, 'cannot tell', and it does NOT claim where the shares are",
    r4.confirmed === false && /cannot tell/.test(r4.reason) && !/still in the vault/.test(r4.reason), JSON.stringify(r4));
  reset({ usdcAfter: 100_000_000n });
  const r5 = await run();
  check("success receipt but NO USDC → confirmed:false (never a fabricated amount)", r5.confirmed === false && r5.usdcReceived === undefined, JSON.stringify(r5));
  reset({ usdcAfterFails: true });
  const r6 = await run();
  check("USDC-after unreadable → confirmed:false, the hash carried, 'check your wallet'", r6.confirmed === false && r6.withdrawHash === HASH && /check your wallet/.test(r6.reason), JSON.stringify(r6));
  reset({ waitThrows: true });
  const r7 = await attempt(run);
  check("Circle FAILED / timeout → it throws, as before (the caller's catch reports it)", r7?.threw !== undefined, JSON.stringify(r7));
}

console.log(`\n╔${"═".repeat(37)}`);
console.log(`║  ${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}`);
console.log(`╚${"═".repeat(37)}`);
process.exit(fail ? 1 : 0);
