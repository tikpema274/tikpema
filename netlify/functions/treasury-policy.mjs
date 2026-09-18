// treasury-policy.mjs — GET the signed-in user's treasury targets; POST to replace them; DELETE to clear.
// Targets are percentages of the user's USDC total across the pockets the console reads. Nothing here
// moves money; the planner (treasury-snapshot) turns targets into PROPOSALS the user confirms elsewhere.
import { connectBlobs } from "./_blobs.mjs";
import { json, parseBody } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { readTreasuryPolicy, writeTreasuryPolicy, clearTreasuryPolicy, ALLOWED_DEST_CHAINS } from "./_treasury-policy.mjs";

export async function handler(event) {
  if (event.blobs) connectBlobs(event);
  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });
  const owner = session.address;

  if (event.httpMethod === "GET") {
    const r = await readTreasuryPolicy(owner);
    if (!r.readable) return json(503, { error: r.error });
    return json(200, { policy: r.policy, storedAt: r.storedAt, allowedChains: ALLOWED_DEST_CHAINS, ...(r.error ? { warning: r.error } : {}) });
  }
  if (event.httpMethod === "POST") {
    const body = parseBody(event);
    const w = await writeTreasuryPolicy(owner, body.policy ?? body);
    if (!w.ok) return json(/store/.test(w.error) ? 503 : 400, { error: w.error });
    return json(200, { policy: w.policy });
  }
  if (event.httpMethod === "DELETE") {
    const c = await clearTreasuryPolicy(owner);
    return c.ok ? json(200, { cleared: true }) : json(503, { error: c.error });
  }
  return json(405, { error: "GET, POST or DELETE" });
}
