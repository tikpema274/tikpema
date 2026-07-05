import { json, parseBody } from "./_arc.mjs";
import { bridgeMintStatus, BRIDGE_DESTINATIONS } from "./_bridge.mjs";
import { requireSession } from "./_auth.mjs";

// POST /api/agent-bridge-status { burnHash, destinationKey }  (auth required)
//
// Read-only stage-2 poll for a forwarded bridge. Given the Arc burn tx hash, asks
// Circle's IRIS whether the relayer has minted on the destination yet. Drives the
// two-stage UI: "burn done → waiting for destination mint → minted (both links)".
// Moves no funds, holds no secret — but still session-gated so it's on the one
// authenticated agent surface (no anonymous probing of the flow).
export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { burnHash, destinationKey } = parseBody(event);
  if (!/^0x[0-9a-fA-F]{64}$/.test(burnHash || "")) {
    return json(400, { error: "valid 'burnHash' required" });
  }
  if (!BRIDGE_DESTINATIONS[destinationKey]) {
    return json(400, { error: "valid 'destinationKey' required" });
  }

  try {
    const status = await bridgeMintStatus({ burnHash, destinationKey });
    return json(200, status);
  } catch (e) {
    return json(500, { error: e.message });
  }
}
