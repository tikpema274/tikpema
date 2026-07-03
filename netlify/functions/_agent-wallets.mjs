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
// winner. Requires the caller's handler to have run connectLambda(event) first.

import { getStore } from "@netlify/blobs";
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
  const existing = await readRecord(store, key);
  if (existing?.walletId) return { ...existing, provisioned: false };

  // No mapping seen — provision, then commit atomically. `onlyIfNew` is
  // server-authoritative: it succeeds only if the key is genuinely absent, so a
  // stale read above can't cause a duplicate mapping.
  const record = await provisionWallet(identity);
  const res = await store.set(key, JSON.stringify(record), { onlyIfNew: true });

  if (res && res.modified === false) {
    // We lost the race (or our read was stale): a mapping already exists — our
    // just-created wallet is abandoned (empty, never funded), NOT a duplicate
    // mapping. Try a short read for the winner; if it hasn't propagated yet,
    // signal pending so the caller returns 202 and the client retries.
    const winner = await readRecordShort(store, key);
    if (winner?.walletId) return { ...winner, provisioned: false };
    return { pending: true };
  }

  return { ...record, provisioned: true };
}
