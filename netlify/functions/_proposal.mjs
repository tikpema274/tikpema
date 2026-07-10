import { bridgeCapUsdc } from "./_arc.mjs";
import { resolveDestination, bridgeFee } from "./_bridge.mjs";

// PROPOSAL VALIDATION PLANE — the model PROPOSES, the server VALIDATES and RE-DERIVES.
//
// ── THE DISCIPLINE THIS COPIES ──────────────────────────────────────────────────
// _research.mjs:419-422 already OVERWRITES the model's `sources` array with the sources
// actually fetched, discarding whatever the model wrote. The model's word is never the
// record. A bridge proposal is the same problem with money attached, so it gets the same
// treatment — only more so, because a wrong number here becomes a real transfer.
//
// What the model is ALLOWED to contribute:
//   • that a bridge is warranted at all (the decision)
//   • a destination NAME (free text — we resolve it, we don't trust it)
//   • an amount (a number — we bound it, we don't trust it)
//   • prose reasoning (display-only, never parsed, never acted on)
//
// What the model may NOT contribute:
//   • the FEE. The model's `expectedFee` is DISCARDED outright. The forwarder fee is
//     volatile (~0.2 USDC to an L2, ~1.5–14 to Ethereum L1 — _bridge.mjs:16-17) and a
//     stale or hallucinated fee is exactly how a user approves terms that no longer
//     exist. We re-price it LIVE from IRIS here, store it as INDICATIVE only, and
//     executeAction re-prices it AGAIN at execution and re-applies the fee-floor
//     (_actions.mjs:177-190). The number shown at approve time is a courtesy, never a
//     commitment.
//   • the destination KEY, the cap, or anything that gates money.
//
// REJECT, NEVER CLAMP. An out-of-range amount does not become the cap; an unknown
// destination does not become a default. Any failure → null → the brief renders with NO
// proposal, exactly as a brief does today. A missing proposal is a fine outcome; a wrong
// one is not.
//
// ── WHERE THE VETTING GATE ATTACHES (not built) ────────────────────────────────
// A future "is this destination/asset safe to move funds to" check belongs at the marked
// point below — after the destination resolves and the amount is bounded, before the
// proposal is returned. It is the single chokepoint where an unvetted target can be
// refused before a user is ever shown an approve button. Nothing downstream of here can
// re-introduce a rejected destination, because the approve endpoint reads the destination
// from THIS validated object, never from the client.

const MAX_REASONING = 600;

// Normalize the model's action name. It writes "bridge"; the executor speaks
// "bridge_usdc" (the step type in _actions.mjs). Anything else → not a bridge proposal.
function normalizeAction(a) {
  const s = String(a || "").trim().toLowerCase();
  if (s === "bridge" || s === "bridge_usdc") return "bridge_usdc";
  return null;
}

// Validate a model-emitted proposal into a server-authored one, or return null.
//
// Returns the EXACT object that gets persisted and that job-bridge-approve.mjs will
// later read its destination and amount from. Nothing the model wrote survives except
// `reasoning` (prose) and the two values we independently re-derived and bounded.
export async function validateProposal(raw) {
  if (!raw || typeof raw !== "object") return null;

  const action = normalizeAction(raw.action);
  if (!action) return null;

  // ── Destination: a NAME from the model → a KEY from our own registry. If it does not
  //    resolve to one of the 8 supported chains, there is no proposal. ──
  const dest = resolveDestination(raw.destination);
  if (!dest) return null;

  // ── Amount: must be a finite positive number within the deployed per-bridge cap.
  //    Note bridgeCapUsdc() throws on a misconfigured env (fail-closed) — we let that
  //    propagate rather than silently proposing under an unknown cap. ──
  const amountUsdc = Number(raw.amountUsdc ?? raw.amount);
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) return null;
  const cap = bridgeCapUsdc();
  if (amountUsdc > cap) return null; // reject, never clamp to the cap

  // ── Fee: the model's number is IGNORED. Price it ourselves, live. ──
  let fee;
  try {
    fee = await bridgeFee({ amountUsdc, cctpDomain: dest.cctpDomain });
  } catch {
    return null; // cannot price it → cannot honestly propose it
  }
  // Fee-floor: if the fee meets or exceeds the amount, nothing would arrive. Refuse to
  // propose an un-settleable bridge rather than let a user approve one.
  if (fee.maxFee >= fee.amountMinor) return null;

  // ┌──────────────────────────────────────────────────────────────────────────┐
  // │ VETTING GATE ATTACHES HERE (future).                                     │
  // │ Destination is resolved, amount is bounded, fee is real. A vetting check  │
  // │ would run now and `return null` to suppress the proposal. Deliberately    │
  // │ not built — with only 8 first-party CCTP destinations there is nothing    │
  // │ unvetted to refuse yet.                                                   │
  // └──────────────────────────────────────────────────────────────────────────┘

  return {
    action,                              // "bridge_usdc" — normalized, not the model's string
    destination: dest.key,               // OUR key, from OUR registry
    destinationLabel: dest.label,
    amountUsdc,                          // bounded by the deployed cap
    cap,
    // INDICATIVE ONLY. Re-priced at execution; the user is told this is not a quote.
    indicativeFeeUsdc: Number(fee.feeUsdc.toFixed(6)),
    indicativeNetUsdc: Number(fee.netUsdc.toFixed(6)),
    pricedAt: new Date().toISOString(),
    // Display-only prose. Never parsed, never acted on. Truncated so a runaway model
    // cannot bloat the deliverable.
    reasoning: String(raw.reasoning || "").slice(0, MAX_REASONING),
    validatedAt: new Date().toISOString(),
  };
}
