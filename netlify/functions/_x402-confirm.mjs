// _x402-confirm.mjs — did a Gateway-batched payment ACTUALLY land, or was it merely accepted?
//
// ═══ ⭐ WHY THIS EXISTS: `success` IS NOT A PAYMENT ═══════════════════════════════════════════
// MEASURED, not assumed (scripts/dd/probe-settlement.mjs, one real 0.001 USDC settlement):
//
//   t=0     facilitator.settle() → success:true          ← the seller used to serve HERE
//           payer 4.991600   payTo(Gateway ledger) 0.007000
//   t=155s  unchanged
//   t=217s  payer 4.990600   payTo 0.008000              ← the money actually moved HERE
//
// The data was served roughly THREE MINUTES before the payment existed. That is the phantom charge
// in mirror image, and it shipped in x402-quote.mjs because `settlement.success` reads like proof.
//
// ═══ AND IT IS NOT AN ERC-20 TRANSFER ════════════════════════════════════════════════════════
// The same probe showed payTo's TOKEN balance never moves and ZERO Transfer logs are emitted —
// settlement is an INTERNAL GATEWAY LEDGER credit. So the obvious confirmation read (eth_getLogs for
// a Transfer to payTo) would find nothing FOREVER, and would have failed looking exactly like
// "payments pending". The real read is the Gateway contract's own balance view.
//
// ⚠️ WHAT THIS CAN AND CANNOT PROVE. availableBalance is an AGGREGATE, so this answers "has payTo's
// Gateway balance risen by at least this much since we snapshotted" — NOT "did THIS payment land".
// Two concurrent equal payments can cross-confirm. It is aggregate-correct, not per-payment
// attributable, and nothing that needs true attribution should inherit it. (An exact per-payment
// read does exist — authorizationState(payer,nonce) on Arc USDC — but ONLY for the token domain;
// the Gateway contract reverts on that selector.)

const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const USDC = "0x3600000000000000000000000000000000000000";
/** availableBalance(address token, address depositor) → uint256. Verified against the live contract;
 *  note balanceOf(address,address) REVERTS there, so this selector is not interchangeable. */
const AVAILABLE_BALANCE_SEL = "0x3ccb64ae";

const pad = (a) => String(a).replace(/^0x/, "").toLowerCase().padStart(64, "0");

export const CONFIRM_REASON = Object.freeze({
  CONFIRMED: "confirmed",
  PENDING: "accepted-not-yet-confirmed",
  INDETERMINATE: "unconfirmed-indeterminate",
  MALFORMED: "malformed-record",
});

/**
 * ⚠️ PROVISIONAL — n=1. The single observed settlement landed between 155s and 217s. This is set to
 * ~5x that against the TAIL, not the sample, and it is provisional until probe-settlement.mjs has
 * run enough times to give a distribution rather than a point.
 *
 * ⭐ IT IS SAFE TO BE WRONG. This bounds POLLING ADVICE ONLY — never entitlement. A timeout resolves
 * to `unconfirmed-indeterminate`, never to "failed" and never to "confirmed", and the pending record
 * OUTLIVES it, so a late-confirming payment is still redeemable by the same handle. An under-set
 * value therefore costs an extra round trip and can never void a paid entitlement or assert a
 * payment that did not happen.
 */
export const RETRIEVE_TIMEOUT_MS = 15 * 60 * 1000;
export const RETRIEVE_TIMEOUT_PROVENANCE =
  "PROVISIONAL (n=1): one measured settlement landed between 155s and 217s; this is ~5x that, set " +
  "against the tail. Bounds polling advice only — the entitlement never expires. Re-measure with " +
  "scripts/dd/probe-settlement.mjs before relying on the number.";

/** Read payTo's Gateway ledger balance. `rpcCall` is INJECTED so this is testable without a chain
 *  and so the caller owns transport. Returns a BigInt, or null — and null is INDETERMINATE, never 0. */
export async function readGatewayBalance({ rpcCall, payTo, token = USDC, gateway = GATEWAY_WALLET }) {
  try {
    const res = await rpcCall({
      method: "eth_call",
      params: [{ to: gateway, data: AVAILABLE_BALANCE_SEL + pad(token) + pad(payTo) }, "latest"],
    });
    const hex = typeof res === "string" ? res : res?.result;
    if (typeof hex !== "string" || !hex.startsWith("0x") || hex.length < 3) return null;
    return BigInt(hex);
  } catch {
    // An unreadable balance is NOT a zero balance. Arc's public RPC throttles; treating a throttled
    // read as "no payment" would refuse a paid caller, and treating it as confirmed would serve an
    // unpaid one. Both are wrong, so it returns null and the caller must call it indeterminate.
    return null;
  }
}

/**
 * The gate. CONFIRMED only on a positive reading that clears the threshold.
 *
 * @param {{balanceNow: bigint|null, baseline: bigint|string, amountAtomic: bigint|string, settledAt?: number, now?: number}} i
 * @returns {{confirmed: boolean, reason: string, detail: string, evidence: object}}
 */
export function confirmPayment({ balanceNow, baseline, amountAtomic, settledAt = null, now = null }) {
  const no = (reason, detail, evidence = {}) => ({ confirmed: false, reason, detail, evidence });

  if (baseline === undefined || baseline === null || amountAtomic === undefined || amountAtomic === null) {
    return no(CONFIRM_REASON.MALFORMED, "the pending record lacks a baseline or an amount, so nothing can be compared", {});
  }
  let base, amt;
  try { base = BigInt(baseline); amt = BigInt(amountAtomic); }
  catch { return no(CONFIRM_REASON.MALFORMED, "baseline or amount is not an integer", { baseline, amountAtomic }); }

  // ⭐ FAIL CLOSED. An unreadable balance is indeterminate — never "not paid", never "paid".
  if (balanceNow === null || balanceNow === undefined) {
    return no(CONFIRM_REASON.INDETERMINATE,
      "the Gateway balance could not be read, so whether the payment landed is UNKNOWN. That is not a negative result — the entitlement stands and the caller should retry.",
      { readable: false });
  }

  const required = base + amt;
  const aged = settledAt && now ? now - settledAt : null;
  if (balanceNow < required) {
    return no(CONFIRM_REASON.PENDING,
      "the facilitator ACCEPTED this payment into a batch, but payTo's Gateway balance has not yet risen by the amount — the chain has not witnessed it. The artifact is deliberately NOT served yet.",
      { balanceNow: balanceNow.toString(), required: required.toString(), shortfall: (required - balanceNow).toString(),
        ageMs: aged, timedOut: aged !== null && aged > RETRIEVE_TIMEOUT_MS });
  }

  return {
    confirmed: true,
    reason: CONFIRM_REASON.CONFIRMED,
    detail: "payTo's Gateway balance rose by at least the payment amount since the pre-settle snapshot",
    evidence: { balanceNow: balanceNow.toString(), baseline: base.toString(), amountAtomic: amt.toString(), ageMs: aged },
  };
}
