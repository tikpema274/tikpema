// redeem-sim.mjs — sort a SIMULATED redeem (eth_call from the holder, their exact shares, at the
// anchor block) into what it establishes about "can this vault pay you right now". Pure.
//
// ═══ THE CLASSIFICATION IS THE WHOLE SAFETY PROPERTY OF `vault-cannot-pay` (T, 2026-09-25) ═════
// A naive "it reverted, so the vault cannot pay" counts our own errors and RPC failures as findings.
//   SHORTFALL     decoded Error(string), a recognised cash / USDC-refusal reason → FINDING (pause)
//   OUR_ERROR     decoded Error(string), the vault rejecting OUR inputs (the share figure is wrong) → OUTAGE
//   RPC_FAILURE   not a revert at all: the call never got an answer from the EVM → OUTAGE
//   UNRECOGNISED  anything else that looks like a revert: an unknown reason, no reason, a custom error,
//                 a Panic, or revert text with no decoded data → INCONCLUSIVE, NEVER a finding
//   PAID          the call returned a positive amount → clear, as of that block only
//
// ⭐⭐ THE VIEM TRAP (read in viem 2.52.2: utils/errors/getContractError.js, errors/contract.js).
// getContractError turns ANY InternalRpcError (-32603), whatever its message, into a
// ContractFunctionRevertedError. When there is no revert DATA, that error copies the RPC's MESSAGE into
// `.reason`. So a node failure arrives shaped like a revert, and a node message reading "execution
// reverted: ERC20: transfer amount exceeds balance" arrives shaped like a shortfall. Therefore:
// `decoded` is true ONLY when viem decoded revert data (`.data.errorName`), and only a decoded
// Error(string) can be SHORTFALL or OUR_ERROR. Text is never evidence.
// MEASURED 2026-09-25: BOTH configured Arc testnet endpoints return decodable Error(string)
// data for the shortfall revert and for XyloVault: INSUFFICIENT_BALANCE.
//
// ⚠️ A PAID result is "at block B", never a promise: the owner's emergencyWithdraw can empty the vault
// in the next block. The disclosure says so (copy.mjs EXIT_NOT_GUARANTEED).

import { BaseError, ContractFunctionRevertedError } from "viem";

export const REDEEM_SIM_CLASS = Object.freeze({
  PAID: "paid", SHORTFALL: "shortfall", OUR_ERROR: "our-error", RPC_FAILURE: "rpc-failure", UNRECOGNISED: "unrecognised",
});

/**
 * Reasons that mean the vault's cash, or USDC itself, cannot pay. EXACT strings only.
 * - "ERC20: transfer amount exceeds balance": the vault's USDC transfer to you or its fee recipient
 *   failed. MEASURED on both Arc endpoints 2026-09-25 (vault cash overridden to 0 / 0.5 USDC).
 * - "Pausable: paused", "Blacklistable: account is blacklisted": USDC refusing the transfer.
 *   ⚠️ FiatToken source strings, NOT measured on Arc. If Arc's native USDC words them differently they
 *   fall to UNRECOGNISED (inconclusive, still a pause), never to a silent clear.
 */
export const SHORTFALL_REASONS = Object.freeze([
  "ERC20: transfer amount exceeds balance",
  "Pausable: paused",
  "Blacklistable: account is blacklisted",
]);

/**
 * XyloVault rejecting what WE asked for (verified source, redeem()): the shares we simulated are not
 * the holder's, or the call was malformed. Our figure is wrong, so the vault told us nothing about its
 * cash. Per-vault vocabulary: another vault's words fall to UNRECOGNISED.
 */
export const OUR_ERROR_REASONS = Object.freeze([
  "XyloVault: INSUFFICIENT_BALANCE",
  "XyloVault: ZERO_SHARES",
  "XyloVault: ZERO_ADDRESS",
  "XyloVault: INSUFFICIENT_ALLOWANCE",
]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * viem result or error → a normalised outcome. The ONLY place a viem error is interpreted.
 * @returns {{outcome:"returned", assetsRaw:string} |
 *           {outcome:"reverted", decoded:boolean, errorName:string|null, reason:string|null} |
 *           {outcome:"transport-error", message:string}}
 */
export function redeemSimulationOutcome({ result, error } = {}) {
  if (error === undefined) {
    return typeof result === "bigint" ? { outcome: "returned", assetsRaw: result.toString() }
      : { outcome: "transport-error", message: "the call returned no amount" };
  }
  const reverted = error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : null;
  if (!reverted) {
    return { outcome: "transport-error", message: String(error?.shortMessage ?? error?.message ?? error) };
  }
  const decoded = isObj(reverted.data) && typeof reverted.data.errorName === "string";
  return {
    outcome: "reverted",
    decoded,
    errorName: decoded ? reverted.data.errorName : null,
    // Only a DECODED Error(string) argument is a reason. `reverted.reason` alone may be the RPC's message.
    reason: decoded && reverted.data.errorName === "Error" && typeof reverted.data.args?.[0] === "string" ? reverted.data.args[0] : null,
  };
}

/** @returns {{class:string, why:string, reason?:string|null}} */
export function classifyRedeemSimulation(o) {
  const c = (cls, why, extra = {}) => ({ class: cls, why, ...extra });
  if (!isObj(o)) return c(REDEEM_SIM_CLASS.OUR_ERROR, "our normaliser produced no outcome");
  if (o.outcome === "returned") {
    return /^[0-9]+$/.test(String(o.assetsRaw)) && BigInt(o.assetsRaw) > 0n
      ? c(REDEEM_SIM_CLASS.PAID, "the simulated redeem returned a positive amount at this block")
      : c(REDEEM_SIM_CLASS.UNRECOGNISED, `the simulated redeem returned ${JSON.stringify(o.assetsRaw)}, not a positive amount`);
  }
  if (o.outcome === "transport-error") return c(REDEEM_SIM_CLASS.RPC_FAILURE, `the call did not reach an answer: ${o.message ?? "unknown"}`);
  if (o.outcome !== "reverted") return c(REDEEM_SIM_CLASS.OUR_ERROR, `unknown outcome ${JSON.stringify(o.outcome)}`);

  if (o.decoded !== true || o.errorName !== "Error" || typeof o.reason !== "string") {
    return c(REDEEM_SIM_CLASS.UNRECOGNISED,
      o.decoded !== true ? "it looked like a revert, but no revert data was decoded (a node failure can look like this)"
        : `the revert was ${o.errorName ?? "unnamed"}, not a recognised Error(string)`, { reason: null });
  }
  if (SHORTFALL_REASONS.includes(o.reason)) return c(REDEEM_SIM_CLASS.SHORTFALL, `the vault could not pay: "${o.reason}"`, { reason: o.reason });
  if (OUR_ERROR_REASONS.includes(o.reason)) return c(REDEEM_SIM_CLASS.OUR_ERROR, `the vault rejected our inputs: "${o.reason}"`, { reason: o.reason });
  return c(REDEEM_SIM_CLASS.UNRECOGNISED, `unrecognised revert reason "${o.reason}"`, { reason: o.reason });
}
