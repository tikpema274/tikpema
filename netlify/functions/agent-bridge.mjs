import { amountFloorViolation } from "./_amount-floor.mjs";
import { TxPendingError } from "./_circle.mjs";
import { connectBlobs } from "./_blobs.mjs";
import { json, parseBody } from "./_arc.mjs";
import { executeAction } from "./_actions.mjs";
import { resolveDestination, bridgeFee, bridgeFeeBand, sealBridgeQuote, quoteWindowMs } from "./_bridge.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet, WALLET_PROVISIONING_STATUS, walletProvisioningRefusal, WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal, isWalletUnresolvable } from "./_agent-wallets.mjs";
import { recordBridge, recordPendingBridge } from "./_bridge-record.mjs";

// POST /api/agent-bridge { amountUsdc, destination }  (auth required)
//
// Turn 2 of the bridge propose→confirm→execute flow. agent-act returned a priced
// proposal (needsBridgeConfirm); the client POSTs here after the user confirms.
//
// ONE SECURE PATH — same enforcement as every other agent money action:
//   - auth-gated (401 without a session),
//   - the source wallet is the caller's OWN per-user agent wallet, resolved from
//     the SESSION (never client-supplied),
//   - guardrails (per-bridge cap, live fee-floor, day-ceiling, ledger) all live
//     inside the shared executeAction — there is NO second bridge path that
//     bypasses them.
// Returns after the Arc burn lands; the destination mint is async (poll
// /api/agent-bridge-status with the returned burnHash + destination key).
export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectBlobs(event); // Blobs for the budget-spine day ledger

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { amountUsdc, destination, ackToken, quoteToken, quoteOnly } = parseBody(event);
  const amount = Number(amountUsdc);
  const floor = amountFloorViolation(amount, { field: "amountUsdc" });
  if (floor) return json(400, { error: floor });
  const dest = resolveDestination(destination);
  if (!dest) return json(400, { error: `unsupported destination "${destination || ""}"` });

  // Resolve the caller's OWN agent wallet from the session (never client-supplied).
  let owner;
  // ⭐ A THROW HERE IS A REFUSAL, NOT A CRASH. Unwrapped it surfaced as a bare 500 that said
  // nothing about retryability or whether anything happened. See walletUnresolvableRefusal.
  try { owner = await ensureOwnerWallet(session); }
  // ⚠️ ONLY the tagged external failure earns this diagnosis. Anything else — a TypeError from
  // a bad refactor, say — RE-THROWS and surfaces unclaimed, rather than borrowing a
  // "temporary, please retry" it cannot honour.
  catch (e) {
    if (!isWalletUnresolvable(e)) throw e;
    return json(WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal(e));
  }
  if (owner.pending) {
    return json(WALLET_PROVISIONING_STATUS, walletProvisioningRefusal());
  }
  const walletAddress = owner.walletAddress;

  // ackToken is the ONLY client-supplied value that reaches the gate, and it is not
  // trusted: _actions recomputes the expected token from the destination, amount and band
  // it priced ITSELF, and compares. A forged or stale token fails the comparison — the
  // same fail-closed shape as the vault deposit gate.
  // ═══ ⭐⭐ TURN 1: PRICE AND SEAL, EXECUTE NOTHING ══════════════════════════════════════════════
  // The ordinary-band bridge used to be single-shot: press, and the burn happens. The fee was
  // priced server-side on every one of those and then discarded unless the band forced a stop, so
  // the ONLY bridges that ever showed a figure first were the ones bad enough to refuse.
  // ⭐ The quote is SEALED, not returned as a number the client posts back — `maxFee` reaches signed
  // calldata, and a caller-chosen one would let the caller choose what the burn authorises.
  // ⛔ NOTHING MOVES HERE. No wallet call, no allowance, no burn — bridgeFee is two read-only GETs.
  if (quoteOnly) {
    let fee;
    try { fee = await bridgeFee({ amountUsdc: amount, cctpDomain: dest.cctpDomain }); }
    catch (e) { return json(200, { outcome: "quote_failed", executed: false, quoted: false, blocked: `cannot price bridge to ${dest.label}: ${e.message}` }); }
    if (fee.maxFee >= fee.amountMinor) {
      return json(200, { outcome: "quote_failed", executed: false, quoted: false, blocked: `amount too small — the bridge fee to ${dest.label} is ~${fee.feeUsdc.toFixed(4)} USDC right now (≥ your ${amount} USDC), so nothing would arrive` });
    }
    // ⚠️ The band is returned so the panel can escalate at 10%/25% EXACTLY as before. The
    // thresholds are untouched; only the moment the figure appears has changed.
    const band = bridgeFeeBand({ amountUsdc: amount, feeUsdc: fee.feeUsdc, netUsdc: fee.netUsdc });
    return json(200, {
      // ⭐ AN EXPLICIT DISCRIMINATOR. `executed: false` already means four different things on this
      // endpoint; the client switches on THIS and refuses anything it does not recognise, so a
      // FIFTH shape fails loudly instead of falling through to "Bridge did not execute".
      outcome: "quoted",
      executed: false,
      quoted: true,
      quote: {
        amountUsdc: amount,
        destination: { key: dest.key, label: dest.label },
        feeUsdc: Number(fee.feeUsdc.toFixed(6)),
        netUsdc: Number(fee.netUsdc.toFixed(6)),
        band: band.band,
        feeRatio: band.feeRatio,
        // ═══ ⭐⭐ A DURATION, DERIVED — NOT OUR CONSTANT, AND NOT AN INSTANT ════════════════════
        //
        // 🚨 THIS WAS `QUOTE_TTL_MS` AND NOTHING RENDERED IT. A server field written and never read
        // is invisible when it is right and invisible when it is wrong — and it was about to become
        // wrong: under CCTP upfront fees the quote's OWN window is ~120s while this constant says
        // 180000, so the panel would have promised a minute that did not exist.
        //
        // ⭐ TWO BOUNDS, BOTH REAL, THE TIGHTER ONE SHOWN. Ours bounds the seal; Circle's bounds the
        // burn (past it the burn REVERTS). `quoteWindowMs` takes the smaller — computed from the
        // quote we just sealed, never typed.
        //
        // ⛔ AND IT IS A DURATION, NOT A DEADLINE. Sending an absolute instant would make the client
        // subtract a SERVER epoch from ITS OWN clock, so every second of device skew becomes a
        // second of wrong countdown — and a fast clock would show a live quote as expired, or worse,
        // an expired one as live. A duration plus the client's own elapsed time has no shared clock
        // to disagree about. (⚠️ ManualSwapPanel does compute `quote.deadline * 1000 - now` that
        // way; this one deliberately does not, and that panel is untouched here.)
        expiresInMs: quoteWindowMs(fee),
        // The opaque handle. The panel stores it and returns it verbatim; it never sees a fee field
        // it could alter, and the figure the gate will trust lives inside the MAC.
        quoteToken: sealBridgeQuote({ owner: session.address, destinationKey: dest.key, amountUsdc: amount, fee }),
      },
    });
  }

  const step = { type: "bridge_usdc", amountUsdc: amount, destination: dest.key, ackToken, quoteToken, reasoning: `bridge ${amount} USDC to ${dest.label}` };

  try {
    const r = await executeAction(step, { walletAddress, session });
    // A high-fee refusal carries its disclosure so the panel can render the band and
    // return the acknowledgment. The refusal is satisfiable, not terminal.
    if (!r.ok) return json(200, {
      // ⭐ needs_ack and blocked are DIFFERENT outcomes: one is satisfiable by acknowledging, the
      // other is a refusal. They were one shape distinguished by whether feeDisclosure happened to
      // carry a token — a property of the payload, not a statement of intent.
      outcome: r.feeDisclosure?.ackToken ? "needs_ack" : "blocked",
      executed: false, blocked: r.blocked, feeDisclosure: r.feeDisclosure ?? null });

    // The receipt write + settle trigger live in _bridge-record.mjs so the multi-step
    // plan path uses the SAME implementation rather than a second copy. It cannot fail
    // this request — the money has already moved — so we deliberately do not branch on it.
    await recordBridge({ r, session, event, amountRequested: amount });

    return json(200, {
      outcome: "executed",
      executed: true,
      kind: "bridge_usdc",
      state: r.state,
      burnHash: r.burnHash,
      tx: r.tx,
      destination: r.destination,
      feeUsdc: r.feeUsdc,
      netUsdc: r.netUsdc,
      recipient: r.recipient,
      // Labelled at the source so the UI cannot present arithmetic as an observation.
      delivery: "predicted",
    });
  } catch (e) {
    // A still-pending Arc burn is submitted-but-slow, not failed.
    if (e instanceof TxPendingError) {
      // ⭐ RECORD IT. This path used to answer 202 and write nothing — losing the consent
      // evidence for a disclosure the user HAD accepted, and leaving a submitted burn with
      // no key anyone could reconcile later. Same never-throws contract as the confirmed
      // write and for a stronger reason: we are already telling the caller "we don't know
      // yet", and a diagnostics failure must not turn that into an error.
      await recordPendingBridge({ e, session, amountRequested: amount });
      return json(202, { outcome: "pending", executed: true, pending: true, txId: e.txId, error: e.message });
    }
    return json(500, { error: e.message });
  }
}
