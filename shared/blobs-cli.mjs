// blobs-cli.mjs — reach the receipt store from a CLI tool, the way the CLI is actually configured.
//
// ⛔ WHY NOT process.env ALONE: `NETLIFY_SITE_ID` / `NETLIFY_BLOBS_TOKEN` are in NEITHER `.env` nor
// `.env.example` — they are not part of this project's env surface. A tool that reads only those
// gets `undefined`, and `getStore` throws MissingBlobsEnvironmentError. MEASURED 2026-09-07, before
// any money moved: `bridge-direct.mjs --send` would have burned real USDC and THEN failed to write
// its receipt. The deployed functions get their context from Netlify; a CLI tool must resolve it.
//
// ⭐ SO IT RESOLVES THE WAY THE CLI ITSELF DOES: the linked site id from `.netlify/state.json`, the
// token from the CLI's own config. Env vars still WIN when set, so CI can inject them.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function blobsCredentials({ env = process.env, root = process.cwd() } = {}) {
  let siteID = env.NETLIFY_SITE_ID || null, token = env.NETLIFY_BLOBS_TOKEN || env.NETLIFY_AUTH_TOKEN || null;
  const notes = [];
  if (!siteID) {
    try { siteID = JSON.parse(readFileSync(join(root, ".netlify", "state.json"), "utf8")).siteId || null;
      if (siteID) notes.push("siteID from .netlify/state.json"); } catch { notes.push("no .netlify/state.json"); }
  } else notes.push("siteID from env");
  if (!token) {
    try {
      const cfg = JSON.parse(readFileSync(join(homedir(), ".config", "netlify", "config.json"), "utf8"));
      const u = cfg.users?.[Object.keys(cfg.users || {})[0]];
      token = u?.auth?.token || null;
      if (token) notes.push("token from the Netlify CLI config");
    } catch { notes.push("no Netlify CLI config"); }
  } else notes.push("token from env");
  return { siteID, token, ok: Boolean(siteID && token), notes };
}

/**
 * ⭐⭐ PROVE THE STORE IS WRITABLE **BEFORE** THE MONEY MOVES. A post-burn failure is unrecoverable
 * in the only way that matters: the record is missing for a burn that already happened, and the
 * caller learns it too late to decide differently. Checked first, the answer is simply "do not send".
 * ⚠️ It performs a READ, never a write — a probe that writes would leave litter in the store it is
 * checking, and a failed cleanup would be worse than the thing it was testing.
 */
export async function assertStoreReachable(getStore, { name = "bridge-receipts", ...opts } = {}) {
  const c = blobsCredentials(opts);
  if (!c.ok) {
    return { ok: false, detail: `cannot reach the receipt store — ${c.notes.join("; ")}. ` +
      `Set NETLIFY_SITE_ID and NETLIFY_BLOBS_TOKEN, or run \`netlify link\` and \`netlify login\`.` };
  }
  try {
    const store = getStore({ name, siteID: c.siteID, token: c.token });
    await store.list({ prefix: "o/" });          // a READ. Nothing is written by this probe.
    return { ok: true, store, detail: c.notes.join("; ") };
  } catch (e) {
    return { ok: false, detail: `the receipt store did not answer a read: ${e?.message || e}` };
  }
}
