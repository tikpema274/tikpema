import assert from "node:assert/strict";
import { mock } from "node:test";

// verify-owner-wallet-provisioning — a missed read must not mint a wallet.
//
//   node --experimental-test-module-mocks scripts/verify-owner-wallet-provisioning.mjs
//
// ═══ 🚨 THE LEAK THIS CLOSES ═════════════════════════════════════════════════════════════════
// `agent-wallets` is eventually consistent. One read returning nothing does NOT mean no mapping
// exists — but the next line called `provisionWallet`, creating a real Circle wallet SET and
// WALLET. The `onlyIfNew` write then correctly refused to remap, and that wallet was abandoned.
// MEASURED 2026-08-12: the same session read `ready` at 19:59 and `pending` at 20:02.
//
// ⭐⭐ AN ABSENCE MUST BE CONFIRMED BEFORE IT AUTHORISES AN IRREVERSIBLE ACT. This repo's recurring
// failure is an absence reading as SAFE; this is its mirror — an absence reading as PERMISSION.
//
// ⚠️ NO REAL CIRCLE, NO REAL BLOBS, NO MONEY. `createWalletSet`/`createWallets` are counted, and a
// count above zero when a mapping existed IS the defect.

let blobs = {};                 // key -> json string
let reads = 0;                  // how many gets the code performed
let readsBeforeVisible = 0;     // simulate lag: the first N reads see nothing
let walletsCreated = 0;

const store = {
  get: async (k) => {
    reads++;
    if (reads <= readsBeforeVisible) return null;   // ← the lag
    return blobs[k] ? JSON.parse(blobs[k]) : null;
  },
  set: async (k, v, opts) => {
    if (opts?.onlyIfNew && blobs[k] !== undefined) return { modified: false };
    blobs[k] = v;
    return { modified: true };
  },
};

mock.module("@netlify/blobs", { namedExports: { getStore: () => store, connectLambda: () => {} } });
mock.module("../netlify/functions/_blobs.mjs", { namedExports: { connectBlobs: () => {} } });
mock.module("../netlify/functions/_circle.mjs", {
  namedExports: {
    circle: () => ({
      createWalletSet: async () => { return { data: { walletSet: { id: "ws_1" } } }; },
      createWallets: async () => {
        walletsCreated++;
        return { data: { wallets: [{ id: `w_${walletsCreated}`, address: `0xnew${walletsCreated}` }] } };
      },
    }),
  },
});
mock.module("../netlify/functions/_arc.mjs", { namedExports: { ARC: { blockchain: "ARC-SEPOLIA" } } });

const { ensureOwnerWallet } = await import("../netlify/functions/_agent-wallets.mjs");

const IDENTITY = { address: "0xAbCd000000000000000000000000000000000001", method: "passkey" };
const EXISTING = JSON.stringify({ walletId: "w_existing", walletAddress: "0xexisting", createdAt: "x" });

const reset = ({ mapped = false, lag = 0 } = {}) => {
  blobs = {};
  // ⚠️ EXACTLY the key ownerKey() produces (`owner:${address.toLowerCase()}`). Seeding extra
  // candidate keys would let a wrong-key bug pass unnoticed.
  if (mapped) blobs["owner:0xabcd000000000000000000000000000000000001"] = EXISTING;
  reads = 0; readsBeforeVisible = lag; walletsCreated = 0;
};

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.error(`  ❌ ${name}\n     ${e.message}`); }
};

console.log("\n── ensureOwnerWallet: a missed read must not mint a wallet ─────");

await t("⭐⭐ ONE lagging read on an EXISTING mapping creates NO wallet", async () => {
  reset({ mapped: true, lag: 1 });          // the fast-path read misses; the confirm read sees it
  const r = await ensureOwnerWallet(IDENTITY);
  assert.equal(walletsCreated, 0,
    "🚨 a single missed read minted a Circle wallet — this is the leak");
  assert.equal(r.walletId, "w_existing", "and it must return the REAL mapping, not a new one");
  assert.equal(r.pending, undefined, "…and not report pending either");
});

await t("⭐ TWO lagging reads still create no wallet — the confirm read retries", async () => {
  reset({ mapped: true, lag: 2 });
  const r = await ensureOwnerWallet(IDENTITY);
  assert.equal(walletsCreated, 0);
  assert.equal(r.walletId, "w_existing");
});

await t("a mapping visible immediately is the fast path — no extra reads, no wallet", async () => {
  reset({ mapped: true, lag: 0 });
  const r = await ensureOwnerWallet(IDENTITY);
  assert.equal(walletsCreated, 0);
  assert.equal(reads, 1, "the fast path must not pay the confirm cost");
  assert.equal(r.provisioned, false);
});

await t("⭐⭐ a GENUINELY new identity STILL gets a wallet — the fix must not break first login", async () => {
  reset({ mapped: false, lag: 0 });
  const r = await ensureOwnerWallet(IDENTITY);
  assert.equal(walletsCreated, 1, "a real first login must provision exactly one wallet");
  assert.equal(r.provisioned, true);
  assert.ok(r.walletId, "and return it");
});

await t("⭐ …and exactly ONE, not one per read attempt", async () => {
  reset({ mapped: false, lag: 0 });
  await ensureOwnerWallet(IDENTITY);
  assert.equal(walletsCreated, 1, "the confirm loop must not multiply provisioning");
});

await t("⭐ a second call for the same identity returns the SAME wallet, never a new one", async () => {
  reset({ mapped: false, lag: 0 });
  const a = await ensureOwnerWallet(IDENTITY);
  const before = walletsCreated;
  const b = await ensureOwnerWallet(IDENTITY);
  assert.equal(walletsCreated, before, "idempotence: no second wallet");
  assert.equal(b.walletId, a.walletId);
});

await t("⚠️ lag beyond the confirm window STILL leaks — the known, accepted bound", async () => {
  // Documented rather than hidden: eliminating this needs a placeholder claim, which risks a
  // PERMANENT lockout if provisioning throws. A bounded leak beats an unbounded lockout.
  reset({ mapped: true, lag: 99 });
  await ensureOwnerWallet(IDENTITY);
  assert.equal(walletsCreated, 1,
    "if this becomes 0, the leak was eliminated and this test should be rewritten, not deleted");
});

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-owner-wallet-provisioning: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
