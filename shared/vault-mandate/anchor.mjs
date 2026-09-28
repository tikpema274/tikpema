// anchor.mjs — the ONE block a mandate check reads at, and the wrapper that makes the DD engine read
// there too. Pure over injected readers/clients.
//
// ═══ WHY A WRAPPER, NOT AN EDIT ══════════════════════════════════════════════════════════════
// analyze() takes its block from `client.pin()` and sends `blk.tag` on every read. The DD code is
// hashed into ddTree (the content hash the service publishes); editing it opens a deposit-refusal
// window. So the check imposes its block from OUTSIDE: pinToAnchor wraps the injected client and
// answers pin() with the anchor, delegating everything else.
//
// ⭐ THE QUORUM CLIENT MEMOISES ITS PIN (quorum.mjs: `let pinned`; first endpoint's head, once). The
// wrapper never calls the inner pin(), so a head memoised by some earlier caller of the same inner
// client cannot leak into a check, and two wrappers over one inner client read at their own anchors.
// The suite proves both on the real quorumClient.
//
// ⚠️ ANCHOR = NUMBER + HASH. Both endpoints must return the SAME hash for the anchor number, or one of
// them is serving something else. Arc has deterministic finality (Malachite BFT: final on commit, no
// reorgs — docs.arc.io/arc/concepts/deterministic-finality), so a number names one block forever; the
// hash is how WE know both providers are on that block. The DD engine reads by number (blk.tag).
//
// ⭐ ANCHOR = NUMBER + HASH + CHAIN TIME (piece 5 blocker 1, 2026-09-28). Exit arming compares the anchor block's
// CHAIN timestamp against MANDATE_EXIT_ARMED_FROM (exit-decision.mjs): wall-clock `anchoredAt` does not survive storage
// (C3), and a stored finding is what an exit acts on. So the timestamp is read with the hash, from the SAME block read,
// and both endpoints must agree on it too. A disagreement, or a timestamp that is not integer seconds, is NO ANCHOR —
// never a timestamp taken from whichever endpoint answered, never a clock reading in its place.

const isHash = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
/**
 * A CHAIN timestamp: integer SECONDS. The bounds refuse a millisecond value (a Date.now() in disguise) and a zero or
 * tiny one; a bigint is refused too, so every reader must normalise. The one rule exit arming and the anchor share.
 */
export const isChainSeconds = (v) => Number.isInteger(v) && v > 1_000_000_000 && v < 100_000_000_000;

/** Wrap an analyze()-shaped client so pin() is the anchor. Throws on a malformed anchor: never falls back. */
export function pinToAnchor(inner, anchor) {
  if (!inner || typeof inner.call !== "function") throw new Error("pinToAnchor: no client to wrap");
  if (!anchor || !Number.isInteger(anchor.blockNumber) || anchor.blockNumber < 0 || !isHash(anchor.blockHash)) {
    throw new Error("pinToAnchor: the anchor needs an integer blockNumber and a 32-byte blockHash; refusing rather than reading the head");
  }
  const pinned = Object.freeze({
    number: anchor.blockNumber, tag: "0x" + anchor.blockNumber.toString(16),
    hash: anchor.blockHash, pinnedBy: "mandate-anchor",
  });
  return {
    chain: inner.chain, endpoints: inner.endpoints, quorum: inner.quorum,
    assert: (...a) => inner.assert(...a),
    call: (...a) => inner.call(...a),
    pin: async () => ({ ...pinned }),
  };
}

/**
 * Choose the anchor: one block below the LOWER of the endpoints' heads (so both have it), then require
 * every endpoint to return the same hash AND the same chain timestamp for it.
 * @param {Array<{endpoint:string, blockNumber:()=>Promise<number>,
 *   block:(n:number)=>Promise<{hash:string, timestamp:number}|null>}>} readers
 * @returns {Promise<{ok:true, anchor:{blockNumber, blockHash, timestamp, endpoints}} | {ok:false, why:string}>}
 */
export async function resolveAnchor(readers, { minEndpoints = 2 } = {}) {
  if (!Array.isArray(readers)) return { ok: false, why: "no endpoints configured" };
  const distinct = new Set(readers.map((r) => r?.endpoint));
  if (readers.length < minEndpoints || distinct.size !== readers.length) {
    return { ok: false, why: `${distinct.size} distinct endpoint(s) configured; the anchor needs ${minEndpoints}` };
  }
  let heads;
  try { heads = await Promise.all(readers.map((r) => r.blockNumber())); }
  catch (e) { return { ok: false, why: `an endpoint could not report its head: ${String(e?.message ?? e)}` }; }
  if (!heads.every((h) => Number.isInteger(h) && h > 0)) return { ok: false, why: "an endpoint reported an unusable head" };
  const n = Math.min(...heads) - 1;
  let blocks;
  try { blocks = await Promise.all(readers.map((r) => r.block(n))); }
  catch (e) { return { ok: false, why: `an endpoint could not return block ${n}: ${String(e?.message ?? e)}` }; }
  const hashes = blocks.map((b) => b?.hash);
  if (!hashes.every(isHash)) return { ok: false, why: `an endpoint did not return block ${n}` };
  if (new Set(hashes.map((h) => h.toLowerCase())).size !== 1) {
    return { ok: false, why: `the endpoints return different hashes for block ${n}: ${hashes.join(" vs ")}` };
  }
  const times = blocks.map((b) => b?.timestamp);
  if (!times.every(isChainSeconds)) {
    return { ok: false, why: `an endpoint returned no usable timestamp (integer seconds) for block ${n}: ${times.map(String).join(" vs ")}` };
  }
  if (new Set(times).size !== 1) {
    return { ok: false, why: `the endpoints return different timestamps for block ${n} (same hash): ${times.join(" vs ")}` };
  }
  return { ok: true, anchor: { blockNumber: n, blockHash: hashes[0], timestamp: times[0], endpoints: readers.map((r) => r.endpoint) } };
}
