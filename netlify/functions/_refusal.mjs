// _refusal.mjs — A TERMINAL REFUSAL IS A FIELD; THE SENTENCE IS DERIVED FROM IT.
//
// ═══ WHY ═════════════════════════════════════════════════════════════════════════════════════════
// plan-path-watch judged the agent plan path HEALTHY by regex over a PROSE sentence at a POSITION:
//   /step ~([0-9.]+) exceeds per-bridge limit of ([0-9.]+)/ on body.results[0].blocked
// That put an instrument's health criterion in charge of a money path's guard order (the balance
// pre-flight had to sit AFTER the cap so the probe kept reading the cap sentence), and it is the
// failure mode this repo has hit repeatedly: a monitor reading a response body's words.
//
// ⭐ ONE PRODUCER. Each refusal is a small structured object — `{kind, …figures}` — and the human
// sentence is COMPUTED from it by `refusalSentence`. The sentence is never written beside the field:
// a field and a sentence carrying the same numbers independently are a drift pair (the balance
// rule was exactly that until b790971). Mutate the field and the sentence changes; a suite proves it.
// Same pattern as bridgeBalanceRefusal (_bridge.mjs) and balance-unverified-copy.mjs.
//
// ⛔ THE SENTENCES ARE BYTE-IDENTICAL TO WHAT THEY REPLACE. The monitor's regex fallback, four
// suites, and the chat's rendering all read these words today; phase 1 changes the SHAPE of the
// body (adds `refusal`), not one character of `blocked`. [[guard-pinned-to-location-not-behaviour]]
//
// The closed set of kinds the plan path can end on before or at a step:
//   cap              — a step's value (amount + fee for a bridge) exceeds its per-action cap
//   ceiling          — the plan would push the day's agent spend past the period ceiling
//   balance          — the wallet cannot fund the bridge/plan (field built by bridgeBalanceRefusal
//                      in _bridge.mjs from minor units; sentence derived HERE, nowhere else)
//   priceUnavailable — the bridge pricing service could not be reached (not a limit, not a shortfall)

export const REFUSAL_KIND = Object.freeze({
  CAP: "cap",
  CEILING: "ceiling",
  BALANCE: "balance",
  PRICE_UNAVAILABLE: "priceUnavailable",
});

import { availableAmount, requiredAmount } from "../../shared/amount-direction.mjs";
import { USDC_DECIMALS } from "../../shared/amount-direction.mjs";

const usd2 = (usdc) => (Math.round(Number(usdc) * 100) / 100).toFixed(2);

/** {kind:"balance", have, need, amount, fee|null, dests, scope, stepCount} — figures in USDC (from minor
 *  units, exact at 6 dp). Produced by bridgeBalanceRefusal; the sentence is derived below. */
export function balanceRefusal({ have, need, amount, fee = null, dests, scope = "single", stepCount = 1 }) {
  return { kind: REFUSAL_KIND.BALANCE, have: Number(have), need: Number(need), amount: Number(amount),
    fee: fee == null ? null : Number(fee), dests: String(dests), scope, stepCount: Number(stepCount) };
}

/** {kind:"cap", valuedUsdc, capUsdc, capLabel, feeUsdc} — valuedUsdc is amount + fee for a bridge. */
export function capRefusal({ valuedUsdc, capUsdc, capLabel, feeUsdc = null }) {
  return { kind: REFUSAL_KIND.CAP, valuedUsdc: Number(valuedUsdc), capUsdc: Number(capUsdc), capLabel: String(capLabel),
    feeUsdc: feeUsdc == null ? null : Number(feeUsdc) };
}

/** {kind:"ceiling", ceilingUsdc, committedUsdc} — committed = today's baseline + this plan so far. */
export function ceilingRefusal({ ceilingUsdc, committedUsdc }) {
  return { kind: REFUSAL_KIND.CEILING, ceilingUsdc: Number(ceilingUsdc), committedUsdc: Number(committedUsdc) };
}

/** {kind:"priceUnavailable", step, detail} — step is 0-based; detail is the transport's message. */
export function priceUnavailableRefusal({ step, detail }) {
  return { kind: REFUSAL_KIND.PRICE_UNAVAILABLE, step: Number(step), detail: String(detail ?? "") };
}

/**
 * The human sentence, DERIVED. Byte-identical to the sentences these fields replaced.
 */
export function refusalSentence(refusal) {
  switch (refusal?.kind) {
    case REFUSAL_KIND.CAP:
      return `step ~${usd2(refusal.valuedUsdc)} exceeds per-${refusal.capLabel} limit of ${refusal.capUsdc} USDC`;
    case REFUSAL_KIND.CEILING:
      return `would exceed daily agent-spend ceiling of ${refusal.ceilingUsdc} USDC (already committed ~${usd2(refusal.committedUsdc)} today)`;
    case REFUSAL_KIND.PRICE_UNAVAILABLE:
      return `step ${refusal.step + 1}: cannot reach the bridge pricing service right now (${refusal.detail}) — nothing was executed; try again shortly`;
    case REFUSAL_KIND.BALANCE: {
      // HAVE rounds down; NEED and the fee round up; all at the token's 6 dp.
      const have6 = availableAmount(refusal.have, USDC_DECIMALS);
      const need6 = requiredAmount(refusal.need, USDC_DECIMALS);
      const fee6 = refusal.fee == null ? null : requiredAmount(refusal.fee, USDC_DECIMALS);
      const { amount, dests, stepCount } = refusal;
      if (refusal.scope === "plan") {
        return `Insufficient funds in your agent wallet for this plan: have ${have6} USDC, its ${stepCount} bridge step${stepCount === 1 ? "" : "s"} need ` +
          (fee6 != null ? `${need6} USDC (${amount} + ~${fee6} in fees, to ${dests}). ` : `at least ${amount} USDC to ${dests} (the fees come on top). `) +
          `Nothing was executed — the whole plan is refused, not a step of it. Top up the agent wallet and retry.`;
      }
      return fee6 != null
        ? `Insufficient funds in your agent wallet: have ${have6} USDC, need ${need6} USDC (${amount} + ~${fee6} fee to ${dests}). No funds moved and nothing was quoted — top up the agent wallet and retry.`
        : `Insufficient funds in your agent wallet: have ${have6} USDC, need at least ${amount} USDC to bridge to ${dests} (the fee comes on top). No funds moved and nothing was quoted — top up the agent wallet and retry.`;
    }
    default:
      return null;
  }
}
