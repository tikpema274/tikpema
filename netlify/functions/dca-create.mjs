import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { json } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet } from "./_agent-wallets.mjs";
import { MANDATE_STORE, mandateKey, validateAndBuildMandate } from "./_dca.mjs";

// POST /api/dca-create — create a DCA mandate. THE authorization moment: this is where a user,
// present and passkey-authenticated, consents ONCE to autonomous custodial swaps that will
// later run with no session. Everything the scheduler does downstream traces back to a mandate
// written here.
//
// ⚠️ `owner` and `walletAddress` come ONLY from the verified session — never the request body.
// A client cannot create a mandate that spends someone else's wallet, because both are
// server-derived (requireSession → ensureOwnerWallet). The body supplies bounds only, and every
// bound is validated fail-closed in validateAndBuildMandate (reject, never clamp).
export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectBlobs(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  // The SCA to sign from, resolved NOW under the session and stored in the mandate — so the
  // scheduler never resolves a wallet without a session. Provisioning race → 202, retry.
  const owner = await ensureOwnerWallet(session);
  if (owner.pending) {
    return json(202, { status: "provisioning", message: "Your agent wallet is being set up — retry shortly." });
  }

  let input;
  try {
    input = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "invalid JSON body" });
  }

  const built = validateAndBuildMandate({
    owner: session.address,
    walletAddress: owner.walletAddress,
    input,
    now: Date.now(),
  });
  if (!built.ok) return json(400, { error: built.error });

  // Persist. Owner-prefixed key so a user's mandates list cheaply and stay isolated.
  const store = getStore(MANDATE_STORE);
  await store.setJSON(mandateKey(session.address, built.mandate.id), built.mandate);

  return json(201, { mandate: built.mandate });
}
