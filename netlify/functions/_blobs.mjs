// _blobs.mjs — connect Netlify Blobs WITHOUT losing the uncached edge URL.
//
// ═══ 🚨 THE INCIDENT THIS EXISTS FOR ═════════════════════════════════════════════════════════
// Deploying `consistency:"strong"` reads to prod made EVERY Executor action refuse:
//   "Netlify Blobs has failed to perform a read using strong consistency because the environment
//    has not been configured with a 'uncachedEdgeURL' property"
//
// CONFIRMED BY PROBE, not inferred: `event.blobs` DOES carry the uncached URL, under the key
// `url_uncached`. connectLambda simply never maps it. From @netlify/blobs@10.7.9:
//
//   main.js:16-26            connectLambda reads data.url -> edgeURL, and FOUR fields total
//                            {deployID, edgeURL, siteID, token}. `data.url_uncached` is ignored.
//                            It then calls setEnvironmentContext(), OVERWRITING
//                            NETLIFY_BLOBS_CONTEXT with that four-field object.
//   chunk-YAGWSQMB.js:342    the client sources uncachedEdgeURL from context.uncachedEdgeURL
//   chunk-YAGWSQMB.js:224    a strong read THROWS when it is absent
//
// So the platform provides it and the compatibility shim throws it away. This re-injects it.
//
// ⭐ WHY THE REPAIR LIVES HERE. `pauseReason({owner,agent})`, `readHealth(identity)` and the budget
// adapter's `getJSON(key)` never receive `event`. Repairing the context once, at the one place
// `event` is in scope, leaves all three of those modules BYTE-IDENTICAL — they keep calling
// getStore(NAME) with `consistency:"strong"` and the client now finds the field.
//
// 🚨 A HANDLER THAT STILL CALLS connectLambda DIRECTLY WILL THROW on a strong read. So any path
// that can reach one must use connectBlobs. That is why rollout is staged and verified on a draft
// per slice, rather than swept across all 39 handlers at once.
//
// ⚠️ NEVER LOG OR RETURN `data` — event.blobs contains the Blobs ACCESS TOKEN. This module reads
// two fields and emits none.

import { connectLambda } from "@netlify/blobs";

/** The key confirmed present in event.blobs. Pinned, not guessed — a wrong guess is
 *  indistinguishable from a missing field, which is how the original defect hid. */
export const UNCACHED_KEY = "url_uncached";

/** Diagnostics only. NEVER used as a gate: a read must not change behaviour based on this. */
export let lastConnect = { connected: false, repaired: false };

const decode = (b64) => {
  try { return JSON.parse(Buffer.from(String(b64), "base64").toString("utf8")); }
  catch { return null; }
};

/**
 * connectLambda, plus the field it drops.
 *
 * Safe when `event.blobs` is absent (no-op, same as the old guarded call). NEVER THROWS: if the
 * repair cannot be made, the context is left exactly as connectLambda wrote it — the pre-fix state,
 * not a new failure mode. A strong read would then throw as before, which is why each slice is
 * proven on a draft before it ships.
 */
export function connectBlobs(event) {
  if (!event?.blobs) { lastConnect = { connected: false, repaired: false }; return; }

  connectLambda(event);                       // unchanged: siteID / token / edgeURL / deployID

  try {
    const data = decode(event.blobs);
    const uncached = data?.[UNCACHED_KEY];
    if (typeof uncached !== "string" || !uncached) {
      lastConnect = { connected: true, repaired: false };
      return;
    }
    const ctx = decode(process.env.NETLIFY_BLOBS_CONTEXT);
    if (!ctx) { lastConnect = { connected: true, repaired: false }; return; }
    ctx.uncachedEdgeURL = uncached;           // the one field connectLambda dropped
    process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify(ctx), "utf8").toString("base64");
    lastConnect = { connected: true, repaired: true };
  } catch {
    lastConnect = { connected: true, repaired: false };
  }
}

/** Was a strong read made possible this invocation? Diagnostics and tests only. */
export const strongReadAvailable = () => lastConnect.repaired === true;
