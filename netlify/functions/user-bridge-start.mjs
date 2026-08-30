// POST /api/user-bridge-start  { amountUsdc, destination, recipient?, ackToken? }
//
// Step 1 of the USER-SIGNED bridge: price it, gate it, record the intent, and hand back the
// calldata. Nothing has moved when this returns — the user has not signed yet.
//
// ═══ 🚨 THE ORDER IS THE SECURITY PROPERTY ═════════════════════════════════════════════════════
//   1. requireSession           — owner comes from the SESSION, never from the body
//   2. priceAndGate             — server prices, server bands, and REFUSES without the ack token
//   3. recordPendingBridge      — only now is anything written
//   4. return the calldata      — only now can the client build a burn
//
// ⭐ THE CALLDATA IS ISSUED LAST, ON PURPOSE. A refused caller never receives a `maxFee`, so it
// cannot assemble the burn itself and cannot choose the band its own acknowledgment is checked
// against. On the agent path the equivalent refusal sits in _actions.mjs; this is its twin, and
// scripts/verify-bridge-fee-band.mjs §9 pins that BOTH precede any write.
//
// ⛔ AGENT CAPS ARE DELIBERATELY NOT CHECKED HERE. The user is spending their own funds with their
// own key — the same reasoning already applied to agent-withdraw and ub-withdraw, where agent
// limits must not trap a user's own money. The panel states this in words rather than leaving it
// to be inferred from a missing error.

import { json, ARC } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { priceAndGate } from "./_user-bridge.mjs";
import { destinationOptions } from "./_bridge.mjs";
import { recordUserPendingBridge } from "./_bridge-record.mjs";

export async function handler(event) {
  // ⭐ GET → the destination list, DERIVED from BRIDGE_DESTINATIONS.
  // 🚨 THIS EXISTS BECAUSE A HAND-TYPED DROPDOWN SHIPPED AND MIS-ROUTED A REAL BRIDGE.
  // The panel had `base-sepolia`, which is not a key and not an alias; the loose matcher resolved
  // it to ETHEREUM and 2 USDC burned toward the wrong chain. A UI list that is typed rather than
  // served is a second source of truth for what chains exist — the recurring bug in this repo —
  // and the drift is invisible because a wrong key still resolves.
  if (event.httpMethod === "GET") {
    return json(200, { destinations: destinationOptions() });
  }
  if (event.httpMethod !== "POST") return json(405, { error: "POST or GET" });
  if (event.blobs) (await import("./_blobs.mjs")).connectBlobs(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "invalid JSON body" }); }

  const gate = await priceAndGate({
    session,
    amountUsdc: body.amountUsdc,
    destination: body.destination,
    recipient: body.recipient,
    ackToken: body.ackToken,
  });

  if (!gate.ok) {
    // 402-shaped in spirit: satisfiable, not terminal. The disclosure travels with the refusal.
    const status = gate.code === "acknowledgment_required" ? 409 : 400;
    return json(status, { error: gate.code, ...(gate.feeDisclosure ? { feeDisclosure: gate.feeDisclosure } : {}) });
  }

  // ⭐ THE PENDING RECEIPT — written BEFORE the user signs. This is what makes the burn
  // attributable at all if the tab closes later: it carries the owner, the destination, the
  // recipient and the consent evidence. ⚠️ It carries NO burnHash, and must not: nothing has
  // been submitted yet, and a receipt asserting a hash that does not exist is a fabricated
  // money-movement record.
  const pending = await recordUserPendingBridge({
    session,
    amountRequested: gate.amountUsdc,
    consent: {
      destinationKey: gate.dest.key,
      destinationLabel: gate.dest.label,
      recipient: gate.recipient,
      // ⭐ ONE QUOTE PRICED THIS. `priceAndGate` gates and builds the calldata from the SAME fee,
      // so charged == disclosed by construction here. Both are written explicitly so a reader never
      // has to infer which quote a missing field meant. No ratio is stored — it derives.
      feeCharged: gate.fee.feeUsdc,
      feeDisclosed: gate.fee.feeUsdc,
      netUsdc: gate.fee.netUsdc,
      feeBand: gate.band.band,
      ackRequired: gate.ackRequired,
      acknowledged: gate.acknowledged,
      ackToken: gate.ackToken,
    },
  });

  return json(200, {
    intentId: pending.intentId,
    recorded: pending.recorded,
    quote: {
      amountUsdc: gate.amountUsdc,
      feeUsdc: gate.fee.feeUsdc,
      netPredicted: gate.fee.netUsdc,
      feeRatio: gate.band.feeRatio,
      feeBand: gate.band.band,
      destinationKey: gate.dest.key,
      destinationLabel: gate.dest.label,
      recipient: gate.recipient,
    },
    burn: gate.burn,
    chainId: ARC.chainId,
    // ⚠️ Stated in the RESPONSE as well as the UI: a caller integrating against this endpoint
    // should not have to read the panel to learn that agent limits do not apply here.
    capsNote: "Agent spending caps do not apply to this path — you are signing with your own key and spending your own funds.",
  });
}
