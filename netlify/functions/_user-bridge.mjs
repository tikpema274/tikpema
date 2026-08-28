// _user-bridge.mjs — the USER-SIGNED bridge path: pricing, the ack refusal, and the on-chain
// burn verification. One module so the three endpoints share exactly one copy of each rule.
//
// ═══ 🚨 WHY THIS EXISTS SEPARATELY FROM _actions.mjs ══════════════════════════════════════════
// The agent path burns from a Circle-custodied SCA and enforces caps because an AGENT is spending
// unattended. Here the USER signs with their own key and spends their own funds, so:
//
//   ⛔ AGENT CAPS DO NOT APPLY — same rule already settled for agent-withdraw and ub-withdraw:
//      those bound what the agent may do; a user reclaiming or moving their OWN money must not be
//      trapped by a limit written for an unattended actor. The UI says so explicitly, because
//      sitting beside a capped panel, silence reads as "capped".
//
//   ⭐ THE ACK GATE DOES APPLY, AND MORE SO. A human signs the burn and eats the fee if the band
//      moved between quote and submit. The agent path can re-price and refuse; a user who already
//      signed cannot. So the refusal happens BEFORE the calldata is issued, not after.
//
// ═══ ⭐⭐ THE PROPERTY THIS MODULE EXISTS TO PRESERVE ═══════════════════════════════════════════
// `ackAcceptedAt` on a receipt is evidence of consent ONLY TRANSITIVELY: _bridge-record.mjs writes
// it whenever `r.acknowledged` is true, and what makes that mean "the user accepted" is that a
// REFUSAL made the line unreachable without a matching token. That refusal lives in _actions.mjs
// for the agent path. A second writer that skipped it would keep writing the field, it would keep
// reading as consent, and no test of the record module would fail.
//
// 🚨 SO `priceAndGate()` BELOW IS THAT REFUSAL FOR THIS PATH, AND IT MUST PRECEDE EVERY WRITE.
// The ordering is pinned in scripts/verify-bridge-fee-band.mjs §9 alongside the agent one — a new
// writer outside that assertion silently unpins the property it was written to protect.

import { getAddress, toFunctionSelector } from "viem";
import { publicClient } from "./_predict.mjs";
import {
  bridgeFee, bridgeFeeBand, bridgeAckToken, bridgeCallData,
  resolveDestinationStrict, BRIDGE_CONTRACT, BRIDGE_ABI,
} from "./_bridge.mjs";
import { CONTRACTS } from "./_arc.mjs";

/**
 * ⭐ SERVER-PRICED, SERVER-BANDED, SERVER-GATED — in that order, on one request.
 *
 * Returns either a REFUSAL (band requires acknowledgment and the token is absent/wrong) or an
 * authorisation carrying the calldata. The caller may not proceed on a refusal, and cannot
 * assemble the calldata itself because it never sees `maxFee` until the gate has passed.
 *
 * 🚨 EVERY MONETARY FIELD IS COMPUTED HERE. `amountUsdc` and `destination` are the ONLY caller
 * inputs that reach pricing; `maxFee`, `feeUsdc`, `netUsdc`, `feeRatio` and `band` are derived.
 * A client-supplied maxFee would let the caller choose the band its own ack is checked against.
 */
export async function priceAndGate({ session, amountUsdc, destination, recipient, ackToken }) {
  // ⭐ STRICT, NOT LOOSE. The caller passes a machine-chosen key from a dropdown, never prose —
  // and the loose matcher resolved "base-sepolia" to ETHEREUM on a real bridge (2026-08-28).
  // A key that is not exactly a key must FAIL here, not quietly become another chain.
  const dest = resolveDestinationStrict(destination);
  if (!dest) return { ok: false, code: "unsupported_destination", destination };

  const amount = Number(amountUsdc);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, code: "bad_amount", amountUsdc };

  let to;
  try { to = getAddress(recipient || session.address); }
  catch { return { ok: false, code: "bad_recipient", recipient }; }

  // Live pricing — the same call the agent path makes, so both paths quote from one source.
  const fee = await bridgeFee({ amountUsdc: amount, cctpDomain: dest.cctpDomain });
  const bandInfo = bridgeFeeBand({ amountUsdc: amount, feeUsdc: fee.feeUsdc, netUsdc: fee.netUsdc });
  const expected = bridgeAckToken({
    owner: session.address, destinationKey: dest.key, amountUsdc: amount, band: bandInfo.band,
  });

  // ══ THE REFUSAL. Fail-closed, and BEFORE any write or any calldata. ══════════════════════════
  // ⚠️ Satisfiable, not terminal: the caller acknowledges and retries with the token, exactly as
  // the agent path does. The disclosure is returned WITH the refusal so a cooperating UI can show
  // the user what they are accepting.
  if (bandInfo.band === "acknowledge" && ackToken !== expected) {
    return {
      ok: false,
      code: "acknowledgment_required",
      feeDisclosure: {
        ...bandInfo,
        destinationKey: dest.key,
        destinationLabel: dest.label,
        amountUsdc: amount,
        ackToken: expected,
      },
    };
  }

  return {
    ok: true,
    dest,
    recipient: to,
    amountUsdc: amount,
    fee,
    band: bandInfo,
    // `acknowledged` mirrors the agent path's derivation EXACTLY — from the BAND, not the token —
    // so both writers produce the same field from the same rule. Its meaning is carried by the
    // refusal above, which this line is unreachable without.
    acknowledged: bandInfo.band === "acknowledge",
    ackRequired: bandInfo.band === "acknowledge",
    ackToken: bandInfo.band === "acknowledge" ? expected : null,
    // The burn the client must sign, built HERE so it cannot drift from the agent's.
    burn: {
      bridgeContract: BRIDGE_CONTRACT,
      usdc: CONTRACTS.USDC,
      amountMinor: fee.amountMinor.toString(),
      calldata: bridgeCallData({
        amountMinor: fee.amountMinor, maxFee: fee.maxFee, recipient: to, cctpDomain: dest.cctpDomain,
      }),
    },
  };
}

/**
 * ⭐⭐ THE SECURITY CHECK OF THIS WHOLE FEATURE.
 *
 * A session holder must not be able to claim a burn they did not make. Without the `from` check,
 * anyone with a valid session could post a stranger's burnHash and have us write a receipt naming
 * THEM as owner — and then settle it, moving a record (not funds) under the wrong identity.
 *
 * Four conditions, all required:
 *   1. the tx exists on ARC and SUCCEEDED — a reverted burn is not a burn;
 *   2. it was sent BY the session address — this is the ownership proof;
 *   3. it called the BridgingKit contract — not an arbitrary transfer dressed as a bridge;
 *   4. its input is the burn selector — an `approve` to the same contract must NOT qualify.
 *
 * ⚠️ (4) IS WHY AN APPROVE CAN NEVER BECOME A burnHash. The agent path warns that recording an
 * approve's hash as a burn hash is "a fabricated money-movement record for a burn that was never
 * submitted"; here the two txs go to DIFFERENT contracts (USDC vs BridgingKit), and the selector
 * check makes the distinction explicit rather than incidental.
 */
export async function verifyBurnOnArc({ burnHash, owner }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(burnHash || "")) return { verified: false, reason: "bad_hash" };
  let ownerAddr;
  try { ownerAddr = getAddress(owner); } catch { return { verified: false, reason: "bad_owner" }; }

  const pc = publicClient();
  let receipt, tx;
  try {
    [receipt, tx] = await Promise.all([
      pc.getTransactionReceipt({ hash: burnHash }),
      pc.getTransaction({ hash: burnHash }),
    ]);
  } catch (e) {
    // ⚠️ NOT FOUND IS NOT NOT-MINED. A hash the node has never seen and one still in the mempool
    // look identical here, so this is retryable, never a verdict of "did not happen".
    return { verified: false, reason: "not_found_or_unreadable", detail: String(e?.message ?? e).slice(0, 140) };
  }
  if (!receipt) return { verified: false, reason: "receipt_not_found" };
  if (receipt.status !== "success") return { verified: false, reason: "tx_reverted", status: receipt.status };

  const from = getAddress(tx.from);
  if (from !== ownerAddr) return { verified: false, reason: "not_sent_by_session_owner", from, expected: ownerAddr };

  const to = tx.to ? getAddress(tx.to) : null;
  if (!to || to !== getAddress(BRIDGE_CONTRACT))
    return { verified: false, reason: "not_the_bridge_contract", to, expected: getAddress(BRIDGE_CONTRACT) };

  // The selector for `bridgeWithPreapprovalAndHook`. An approve (0x095ea7b3, and to USDC anyway)
  // fails both this and the contract check — two independent reasons, deliberately.
  const selector = (tx.input || "").slice(0, 10).toLowerCase();
  if (selector !== BURN_SELECTOR) return { verified: false, reason: "not_the_burn_call", selector };

  return {
    verified: true,
    from, to,
    blockNumber: Number(receipt.blockNumber),
    burnTxUrl: null, // filled by the caller from ARC.explorer
  };
}

// ⭐⭐ DERIVED FROM THE ABI, NOT WRITTEN BY HAND. The first draft of this file pinned a
// hand-written literal — and it was WRONG (`0x0d5a3c2e` vs the real `0x513e1175`), which would have
// rejected every genuine burn while looking like a working security check. A selector is exactly
// the kind of value that cannot be recalled, only computed.
// ⚠️ The suite asserts BOTH that it equals 0x513e1175 today AND that it still derives from the
// live ABI — so an ABI change fails loudly instead of silently matching a different call.
export const BURN_SELECTOR = toFunctionSelector(
  BRIDGE_ABI.find((e) => e.name === "bridgeWithPreapprovalAndHook"),
);
