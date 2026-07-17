import { connectLambda, getStore } from "@netlify/blobs";
import { json } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { MANDATE_STORE, mandateKey, STATUS } from "./_dca.mjs";

// POST /api/dca-cancel { id } — kill a running mandate. ALWAYS AVAILABLE, like withdraw.
//
// ⚠️ CANCEL IS A RECLAIM-CLASS ACTION, NOT A SPEND. It must never be blocked by a pause, a
// cap, a day ceiling, or any agent state — the same principle as agent-withdraw and
// vault_withdraw (pause/cap bind what the agent may SPEND, never what the user may STOP or
// RECLAIM). So this endpoint checks ONLY that the caller owns the mandate; nothing else can
// stand between a user and stopping autonomous spending on their own wallet.
//
// TIMING INDEPENDENCE: cancellation has no dependency on the scheduler's clock. The scheduler
// reads each mandate FRESH every tick and acts only on status === "active", so flipping status
// to "cancelled" here takes hold on the very next tick with no window to miss. The user needs a
// session to prove WHO is cancelling (they are present to cancel), but the EFFECT is immediate
// and unconditional.
export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectLambda(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "invalid JSON body" });
  }
  const id = body?.id;
  if (!id || typeof id !== "string") return json(400, { error: "missing mandate id" });

  // Key is owner-derived from the SESSION, so a caller can only ever cancel their OWN mandate —
  // there is no code path to cancel by an id under another owner's prefix.
  const store = getStore(MANDATE_STORE);
  const key = mandateKey(session.address, id);
  const m = await store.get(key, { type: "json" }).catch(() => null);
  if (!m) return json(404, { error: "no such mandate" });

  // Idempotent: cancelling an already-terminal mandate is a no-op success, never an error —
  // a user hitting cancel twice, or cancelling one that just completed, must not see a failure.
  if (m.status !== STATUS.ACTIVE) {
    return json(200, { mandate: m, alreadyClosed: true });
  }

  const cancelled = { ...m, status: STATUS.CANCELLED, cancelledAt: new Date().toISOString() };
  await store.setJSON(key, cancelled);
  return json(200, { mandate: cancelled });
}
