// exit-outcome.mjs — piece 5: what did the mandate's EXIT transaction do? Pure: the caller reads, this decides.
// Design: PROGRESS "VAULT MANDATE — PIECE 5" (point 2, outcomes from the chain) + "PIECE 5 DECISIONS + DESIGN
// CORRECTIONS" (C1, C11, Finding B), 2026-09-26/27.
//
// ═══ ⛔ THE OUTCOME IS BOUND TO THE TRANSACTION, NEVER TO THE WALLET ═══════════════════════════════════
// The exit transaction is LOCATED by its Circle id (→ its hash); its outcome is decided from THAT transaction's own
// receipt logs and the share balance across THAT transaction's block. There is deliberately no input for "Withdraw
// events for this wallet": the user's own manual reclaim produces exactly such an event, and the struck rule
// ("Circle COMPLETE ⇒ happened", C1) would have closed the mandate on it. Circle COMPLETE is the OUTER userOp: the
// inner redeem can revert under it (the ERC-4337 trap), so COMPLETE only ever LOCATES the transaction.
//
// ═══ THE THREE INSTRUMENTS, AND WHAT MUST AGREE ═══════════════════════════════════════════════════════
//   1. THE VAULT'S Withdraw event IN THIS TX, emitted by the vault, with owner = receiver = the wallet. Exactly one.
//   2. THE ERC-20 Transfer IN THIS TX, emitted by the USDC contract, vault → wallet, value = the event's assets.
//      ⛔ Arc also emits a NATIVE 18-dp mirror Transfer from a different emitter: never read (emitter filter).
//      ⛔ xylo sends the exit fee as a SEPARATE transfer, vault → feeRecipient: never ours (recipient filter).
//      ⭐ xylo's Withdraw.assets is NET of the fee (verified source, redeem(): `assets = previewRedeem(shares)`;
//         `asset.transfer(receiver, assets)`; `asset.transfer(feeRecipient, fee)`), so event.assets === the Transfer
//         to the wallet EXACTLY. No fee tolerance: a mismatch is a disagreement. (Another vault family would need its
//         own reading of this, like its redemption signal.)
//   3. THE SHARE DELTA across the tx's block (balance at block − 1 minus balance at the block) = the event's shares.
//      Other activity in the same block (a manual reclaim) breaks the equality → unconfirmed, never guessed.
//
// ═══ FINDING B: THE MANDATE'S SHARES, NOT THE WALLET ═════════════════════════════════════════════════════
// The executor redeems min(tracked, live): the mandate's OWN shares. Shares left in the WALLET afterwards (deposited by
// hand) are expected and reported apart (`otherSharesInWallet`); they never make an exit "partial". Partial means the
// tx burned fewer than the mandate asked to redeem, and it is reported with BOTH amounts, never as done.
//
// ⛔ UNREADABLE IS NEVER "DID NOT HAPPEN". Every missing fact → unconfirmed, with the reason. `failed` needs the chain
// (or Circle's terminal pre-broadcast rejection) to SAY so.

import { decodeEventLog, parseAbiItem } from "viem";
import { isKnownGapCount, SHARE_LIMIT_REFUSED, shown } from "./share-limit.mjs";

export const EXIT_OUTCOME = Object.freeze({ EXITED: "exited", PARTIAL: "exit-partial", UNCONFIRMED: "unconfirmed", FAILED: "failed" });
export const EXIT_FLAG = Object.freeze({ BEYOND_MANDATE_SHARES: "BEYOND_MANDATE_SHARES", TRACKED_LOWER_BOUND: "TRACKED_LOWER_BOUND" });

const WITHDRAW = parseAbiItem("event Withdraw(address indexed caller, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)");
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const lc = (a) => String(a ?? "").toLowerCase();
const asBig = (v) => (typeof v === "bigint" ? v : typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null);
const decode = (abi, log) => { try { return decodeEventLog({ abi: [abi], data: log.data, topics: log.topics }); } catch { return null; } };

/**
 * @param {{ config:{vault, usdc, wallet},
 *   intent:{ sharesToRedeem:string, sharesTracked?:string, sharesTrackedGaps?:number },
 *   facts:{ circle:{state:"COMPLETE"|"FAILED"|"PENDING"|"NONE", txHash?:string|null}|null,
 *           receipt:{found:false}|{found:true, status:"success"|"reverted", blockNumber:number, logs:Array}|null,
 *           shares:{atParent:bigint|null, atTxBlock:bigint|null},
 *           remainingValueMinor?:bigint|null } }} a
 * @returns {{outcome, why?, txHash?, blockNumber?, usdcReceivedMinor?, mandateSharesRedeemed?, mandateSharesRemaining?,
 *            mandateRemainingValueMinor?, walletSharesAfter?, otherSharesInWallet?, beyondMandateShares?,
 *            trackedNotRedeemable?, trackedIsLowerBound?, flags:string[]}}
 */
export function classifyExitOutcome({ config, intent, facts } = {}) {
  const flags = [];
  const unconfirmed = (why, extra = {}) => ({ outcome: EXIT_OUTCOME.UNCONFIRMED, why, flags, ...extra });
  const failed = (why, extra = {}) => ({ outcome: EXIT_OUTCOME.FAILED, why, flags, ...extra });

  const toRedeem = asBig(intent?.sharesToRedeem);
  if (toRedeem === null || toRedeem <= 0n) return unconfirmed("the intent names no shares to redeem; it is malformed and nothing can be classified against it");
  const tracked = asBig(intent?.sharesTracked);
  // ⛔ A GAP COUNT IS NEVER READ AS 0 (step 3, T 2026-09-29): the same test and the same answer as the share limit.
  // Missing or malformed → the intent is malformed and is not classified (it used to default to 0 here).
  if (!isKnownGapCount(intent?.sharesTrackedGaps)) {
    return { ...unconfirmed(`the intent's tracked-shares gap count is unknown (${shown(intent?.sharesTrackedGaps)}); an unknown count is not zero, so nothing is classified against it`), refused: SHARE_LIMIT_REFUSED.GAPS_UNKNOWN };
  }
  const gaps = intent.sharesTrackedGaps;
  // ⚠️ TRACKED_LOWER_BOUND IS UNREACHABLE FROM OUR OWN EXITS (step 3): the share limit REFUSES a tracked figure with
  // gaps, so the executor never submits against one and never writes an intent with gaps > 0. The flag stays for an
  // intent from elsewhere (or a future design that allows lower-bound exits). ⛔ Its ABSENCE on our receipts is
  // therefore NOT evidence that a tracked figure was exact: it cannot appear there at all.
  if (gaps > 0) flags.push(EXIT_FLAG.TRACKED_LOWER_BOUND);
  const f = facts ?? {};

  // ── 1. LOCATE the transaction (Circle), never decide from Circle alone ──
  const circle = f.circle;
  if (circle === null || circle === undefined) return unconfirmed("Circle's transaction state could not be read, so the exit transaction cannot be located");
  if (circle.state === "NONE") return unconfirmed("no Circle id was recorded, so the exit transaction cannot be located (recovery: the idempotency key)");
  if (circle.state === "PENDING") return unconfirmed("Circle reports the exit transaction still pending");
  if (circle.state === "FAILED" && !circle.txHash) {
    // Circle rejected it before broadcast (_circle.mjs: "FAILED without txHash — it never reached the chain").
    return failed("Circle rejected the exit transaction before broadcast; it never reached the chain", { txHash: null });
  }
  if (circle.state !== "COMPLETE" && circle.state !== "FAILED") return unconfirmed(`unrecognised Circle state ${JSON.stringify(circle.state)}`);
  const txHash = circle.txHash;
  if (!txHash) return unconfirmed("Circle reports the transaction complete but gave no hash, so it cannot be read");

  // ── 2. THE TRANSACTION'S OWN RECEIPT ──
  const rc = f.receipt;
  if (rc === null || rc === undefined) return unconfirmed("the exit transaction's receipt could not be read", { txHash });
  if (rc.found !== true) return unconfirmed("the exit transaction's receipt is not available yet", { txHash });
  const blockNumber = rc.blockNumber;
  if (rc.status === "reverted") return failed("the exit transaction reverted", { txHash, blockNumber });
  if (rc.status !== "success") return unconfirmed(`unrecognised receipt status ${JSON.stringify(rc.status)}`, { txHash, blockNumber });
  if (circle.state === "FAILED") return unconfirmed("Circle reports FAILED but the receipt reports success: the instruments disagree", { txHash, blockNumber });

  const logs = Array.isArray(rc.logs) ? rc.logs : [];
  const ours = logs.filter((l) => lc(l.address) === lc(config.vault)).map((l) => decode(WITHDRAW, l))
    .filter((e) => e?.eventName === "Withdraw" && lc(e.args.owner) === lc(config.wallet) && lc(e.args.receiver) === lc(config.wallet));
  const transfers = logs.filter((l) => lc(l.address) === lc(config.usdc)).map((l) => decode(TRANSFER, l))
    .filter((e) => e?.eventName === "Transfer" && lc(e.args.from) === lc(config.vault) && lc(e.args.to) === lc(config.wallet));

  // ── 3. THE SHARE DELTA across this block ──
  const before = f.shares?.atParent, after = f.shares?.atTxBlock;
  const sharesKnown = typeof before === "bigint" && typeof after === "bigint";

  if (ours.length === 0) {
    // The outer tx succeeded without our redeem inside it (the ERC-4337 trap) — IF nothing else moved the shares.
    if (!sharesKnown) return unconfirmed("the transaction has no Withdraw for this wallet, and the share balance around its block could not be read", { txHash, blockNumber });
    if (after < before) {
      return unconfirmed("the transaction has no Withdraw for this wallet, yet the wallet's shares fell in that block (another transaction, e.g. a manual reclaim): not attributable to the exit", { txHash, blockNumber });
    }
    return failed("the transaction succeeded but contains no redeem for this wallet, and its shares did not move (the inner redeem did not happen)", { txHash, blockNumber });
  }
  if (ours.length > 1) return unconfirmed(`the transaction contains ${ours.length} Withdraw events for this wallet; one was expected`, { txHash, blockNumber });

  const ev = ours[0].args;
  const burned = ev.shares, net = ev.assets;
  const matching = transfers.filter((t) => t.args.value === net);
  if (matching.length !== 1) {
    return unconfirmed(transfers.length === 0
      ? "no ERC-20 USDC Transfer from the vault to the wallet in the transaction (a native mirror log does not count)"
      : `the ERC-20 Transfer to the wallet (${transfers.map((t) => t.args.value).join(", ")}) does not equal the Withdraw event's assets (${net})`,
    { txHash, blockNumber });
  }
  if (!sharesKnown) return unconfirmed("the share balance around the transaction's block could not be read, so the event cannot be cross-checked", { txHash, blockNumber });
  if (before - after !== burned) {
    return unconfirmed(`the share balance fell by ${before - after} in that block but the event burned ${burned}: other activity in the same block; not attributable`, { txHash, blockNumber });
  }

  // ── 4. ALL THREE AGREE. Now: the MANDATE's shares, not the wallet's ──
  const remaining = burned >= toRedeem ? 0n : toRedeem - burned;
  const beyond = burned > toRedeem ? burned - toRedeem : 0n;
  if (beyond > 0n) flags.push(EXIT_FLAG.BEYOND_MANDATE_SHARES);
  const result = {
    txHash, blockNumber, flags,
    usdcReceivedMinor: net.toString(),
    mandateSharesRedeemed: (burned > toRedeem ? toRedeem : burned).toString(),
    mandateSharesRemaining: remaining.toString(),
    mandateRemainingValueMinor: remaining > 0n && typeof f.remainingValueMinor === "bigint" ? f.remainingValueMinor.toString() : null,
    walletSharesAfter: after.toString(),
    // What is still in the wallet and is NOT the mandate's (deposited by hand). Never a reason to call it partial.
    otherSharesInWallet: (after > remaining ? after - remaining : 0n).toString(),
    beyondMandateShares: beyond.toString(),
    trackedNotRedeemable: tracked !== null && tracked > toRedeem ? (tracked - toRedeem).toString() : "0",
    trackedIsLowerBound: gaps > 0,
    done: remaining === 0n,
  };
  if (remaining > 0n) {
    return { outcome: EXIT_OUTCOME.PARTIAL, why: `the redeem burned ${burned} of the mandate's ${toRedeem} shares; ${remaining} remain in the vault`, ...result, done: false };
  }
  return { outcome: EXIT_OUTCOME.EXITED, why: beyond > 0n
    ? `the mandate's shares are gone, and ${beyond} shares BEYOND the mandate's were redeemed too (the executor submits min(tracked, live): this should not happen)`
    : "the mandate's shares are gone: event, ERC-20 transfer and share delta agree", ...result };
}
