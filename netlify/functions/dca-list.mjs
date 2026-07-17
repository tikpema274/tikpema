import { connectLambda, getStore } from "@netlify/blobs";
import { json } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { MANDATE_STORE, ownerPrefix } from "./_dca.mjs";

// GET /api/dca-list — the caller's OWN mandates, for the UI. Read-only. Owner-prefixed list,
// keyed on the verified session, so a caller only ever sees their own. No cross-user read.
export async function handler(event) {
  if (event.blobs) connectLambda(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const store = getStore(MANDATE_STORE);
  const { blobs } = await store.list({ prefix: ownerPrefix(session.address) });
  const mandates = [];
  for (const { key } of blobs) {
    const m = await store.get(key, { type: "json" }).catch(() => null);
    if (m) mandates.push(m);
  }
  // Newest first — createdAt is epoch ms.
  mandates.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return json(200, { mandates });
}
