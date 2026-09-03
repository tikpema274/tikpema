import { ARC, CONTRACTS, USDC_DECIMALS } from "./_arc.mjs";

// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE UPFRONT-FEE RECONCILIATION — A DETECTOR, NOT A GATE
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The burn has ALREADY HAPPENED when this runs. It cannot prevent a wrong charge; it can only make
// one visible. So the design question is never "does it pass" but WHAT HAPPENS WHEN IT DISAGREES.
//
// ═══ ⭐⭐ WHAT IT CLAIMS — AND THE CLAIM IS SMALLER THAN IT LOOKS ═══════════════════════════════
// `TokenMessengerWithFees._collectFees` ends with:
//
//     uint256 feeAmount = _FEE_MANAGER.collectFeesWithQuote{value: msg.value}(…);
//     assert(feeAmount == quotedFee);
//
// ⛔ QUOTED-VS-COLLECTED IS ENFORCED ON-CHAIN AND A MISMATCH REVERTS. This module therefore does
// NOT check Circle — that job is already done, atomically, by an assert. What is left for us is
// DISPLAYED vs SUBMITTED: that the `feeDisclosed` figure a user consented to is the one that
// actually moved. Our-side drift only. Recorded as the CORRECT claim, not a weakened one.
//
// ═══ ⭐⭐ IT PINS EMITTER AND MOVEMENT — IT NEVER COMPARES STREAM COUNTS ════════════════════════
// Arc emits every movement TWICE: natively 18-dp from `0xffff…fffe`, and as ERC-20 6-dp from the
// token. Two emitters, two precisions, one movement.
//
// 🚨 AND THE COUNTS LEGITIMATELY DIFFER. Measured on the run-2 burn (`0xd5d003c0…0f895`): the ERC-20
// stream carried 7 Transfers and the NATIVE stream 8. The extra one is the EntryPoint refunding the
// bundler for gas — native by nature, since gas is not a token movement and can never have an
// ERC-20 twin. A reconciliation comparing stream counts would fail on EVERY sponsored transaction.
// That is why nothing below counts anything: it pins (emitter, topic0, from, to, value).
//
// ═══ 🚨 `(emitter, from, to)` DOES NOT DISCRIMINATE THE FEE FROM THE AMOUNT ════════════════════
// BOTH legs are `payer → TMWF` from the same emitter — logs 51 and 63 of the run-2 receipt. The
// fee is identified instead by the leg that carries it ONWARD: only the fee moves TMWF → FeeManager
// (`forceApprove(_FEE_MANAGER)` then `collectFeesWithQuote`); the amount goes TMWF → minter → 0x0.
//
// ⭐ DELIBERATELY NOT POSITIONAL. "The fee is the first of the two" is true in source order and in
// both real receipts, and it is still an ordering assumption. The FeeManager leg is a fact about
// WHERE THE MONEY WENT, which is the thing being reconciled.
//
// ═══ ⭐ THE TOPIC0 PIN LOOKS REDUNDANT AND IS LOAD-BEARING ═════════════════════════════════════
// `Approval(address indexed owner, address indexed spender, uint256 value)` has the SAME arity and
// the SAME two indexed addresses as `Transfer`. Run-2 log 52 is `Approval(TMWF → FeeManager, 53985)`
// — identical emitter, identical from/to, identical value to the fee Transfer at log 55. Drop the
// topic0 pin and the forward leg becomes ambiguous (2 matches) rather than wrong. Measured.
//
// ═══ ⛔ AND DROPPING THE EMITTER PIN IS A FALSE ALARM, NOT A FALSE PASS ════════════════════════
// Correcting an earlier note that filed the ~1e12 dual-emission hazard as the most likely
// implementation error without saying which way it fails. Measured: reading the NATIVE stream
// instead yields MISMATCHED at `53985000000000000` against a disclosed `53985`. It is LOUD — a
// false alarm — never a silent agreement. Still a defect; just not one that can hide.

/** Arc's USDC. 6-dp ERC-20. The emitter every reading below is pinned to. */
export const ARC_USDC = CONTRACTS.USDC;

/** `Transfer(address,address,uint256)`. ⚠️ Pinned explicitly — see the Approval note above. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * TokenMessengerWithFees on Arc testnet — the upfront-fee entry point, and the `to` of both the
 * fee leg and the amount leg. Proxy verified; `tokenMessenger()` → `0x8FE6B999…2daa`.
 */
export const TMWF = "0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A";

/**
 * ⭐ THE FEE'S DESTINATION — THE DISCRIMINATOR, AND A THIRD-PARTY ADDRESS WE PIN AS A LITERAL.
 *
 * CHECKED BEFORE THIS WAS BUILT, read-only against Arc on 2026-09-03: `TMWF.feeManager()`
 * (selector `0xd0fb0203`) EXISTS and returns exactly this address. `FEE_MANAGER()`,
 * `getFeeManager()` and `_FEE_MANAGER()` all revert — `feeManager()` is the only getter.
 *
 * ⭐ THE LITERAL IS KEPT ANYWAY, AS A STATED CHOICE. Reading the getter on the reconcile path
 * would add an RPC round trip to every verdict and make the detector's correctness depend on a
 * second live call. Circle redeploying the FeeManager would make this literal stale — and a stale
 * literal DEGRADES TO `unreadable` (the forward leg stops matching), never to a false MATCHED.
 * That is the safe direction, which is the whole reason a literal is acceptable here.
 * ⚠️ `scripts/verify-fee-manager-live.mjs` (`npm run test:feemanagerlive`) asserts this literal
 * against the live getter, so the staleness is caught by a suite rather than by a wrong verdict.
 * It is deliberately OUTSIDE `test:all` — it is network-dependent, and a flaky network inside a
 * blocking aggregate manufactures tolerated red. Run it when the migration lands, and periodically.
 */
export const FEE_MANAGER = "0x08499fce2344645c72de277a16734741e507a5d8";

/**
 * ⛔⛔ ON ARC, AN ABSENCE IS ALWAYS `unreadable` — NEVER A FINDING. READ THIS BEFORE REACHING FOR
 * `rpcFallback(..., { absenceNeedsCorroboration: true })`, BECAUSE THE HELPER EXISTS AND LOOKS
 * LIKE IT SOLVES THIS.
 *
 * `ARC.rpc` is a SINGLE endpoint. Corroboration means "another endpoint was asked and agreed", and
 * on a one-endpoint chain there is nobody else to ask — so the invariant cannot be satisfied, and
 * a `null` receipt is indistinguishable from a pruned or lagging node.
 *
 * 🚨 AND THE HELPER USED TO SAY `corroborated: true` HERE. Its flag was `failures.length === 0`,
 * which is trivially true when the only endpoint answered — so a single-endpoint absence reported
 * itself as corroborated by nobody. Fixed at the helper (`absent.length >= 2`), and restated here
 * because the next person will reach for the helper before reading its body.
 *
 * The consequence for this module: a burn we cannot read is `unreadable`, always, and no amount of
 * RPC agreement can promote that to `mismatched`.
 */
export const ARC_CHAIN = Object.freeze({ rpcs: [ARC.rpc], chainId: ARC.chainId });

/** ⭐ THREE OUTCOMES, NEVER TWO. `unreadable` is FIRST-CLASS, not an error: public-RPC retention
 *  makes an older burn unreadable BY DESIGN, so at re-verification time it is the COMMON case. It
 *  is stored as a value, never coerced, and never rendered as a tick. */
export const FEE_RECON_VERDICTS = Object.freeze(["matched", "mismatched", "unreadable"]);

/**
 * ⭐ THE CLOSED REASON SET. Every `unreadable` names WHICH question could not be answered, because
 * "we could not check" is not actionable and "the FeeManager leg is missing" is.
 *
 * ⚠️ `not_upfront_fee_path` IS THE EXPECTED VERDICT UNTIL THE MIGRATION LANDS. Today's bridges burn
 * through `BridgingKitContract` with the fee taken OUT of the amount — TMWF is not involved at all,
 * so there is no fee leg to read and there never was one. It is given its own reason rather than
 * collapsing into "we could not find the fee", so a reader can tell "this bridge did not use the
 * upfront-fee path" from "this bridge used it and the reading failed". Those have different causes
 * and only the second one is a problem.
 */
export const FEE_RECON_REASONS = Object.freeze([
  "payer_unknown",
  "disclosed_unknown",
  "disclosed_not_exact",
  "disclosed_incoherent",
  "chain_unreadable",
  "burn_absent",
  "burn_reverted",
  "not_upfront_fee_path",
  "fee_forward_legs",
  "fee_charge_candidates",
]);

const lc = (s) => String(s ?? "").toLowerCase();
const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a ?? ""));
const addrOfTopic = (t) => "0x" + lc(t).slice(26);

/**
 * ⭐ COMPUTE THE CONVERSION, NEVER TYPE IT — AND NEVER MULTIPLY A FLOAT.
 *
 * Returns the exact minor-unit BigInt for a decimal USDC figure, or `null` if it cannot be
 * represented exactly. ⛔ `null` is a REFUSAL, not a zero: the caller turns it into
 * `disclosed_not_exact` rather than rounding. A reconciliation that quietly rounds its own input
 * is comparing a figure nobody ever displayed.
 *
 * ⚠️ Exponent notation (`1e-7`, `1e+21`) and more than six decimal places are refused by the
 * pattern rather than truncated — a fee with seven decimals is not a USDC amount, and silently
 * dropping the seventh is how a comparison passes on a number that was never the input.
 */
export function usdcDecimalToMinorExact(v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  const s = String(v);
  if (!new RegExp(`^\\d+(\\.\\d{1,${USDC_DECIMALS}})?$`).test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt((frac + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS));
}

/**
 * The DISCLOSED fee in minor units — the quantity the comparison is actually made in.
 *
 * @returns {{minor: bigint|null, reason: string|null}} — `minor` null ⇒ `reason` says which
 *          question could not be answered. ONE function, so the value and the explanation for its
 *          absence cannot disagree.
 *
 * ⭐⭐ PREFERS THE STORED INTEGER, WHICH IS WHY IT IS STORED. `feeDisclosedMinor` is written at burn
 * time straight from the quote's own BigInt, so on a new receipt there is NO conversion to get
 * wrong. The decimal path exists only for records written before that field, and it refuses rather
 * than rounds. ⚠️ `feeUsdc` is the pre-2026-08-30 field name.
 *
 * ═══ 🚨🚨 THE TWO STORED FIGURES ARE CROSS-CHECKED, AND THIS PREVENTS A SILENT INVERSION ═══════
 *
 * A receipt carries the disclosed fee TWICE — as a decimal (`feeDisclosed`, what the user saw) and
 * as an integer (`feeDisclosedMinor`, what this compares). They are written from ONE quote object
 * and are the same quantity in two units, so they cannot legitimately disagree.
 *
 * ⛔ THE FAILURE THIS EXISTS FOR IS CONCRETE AND IT IS AHEAD OF US, NOT BEHIND. `feeDisclosedMinor`
 * is written from the fee object's minor-unit field. Under CCTP upfront fees the burn's `maxFee`
 * becomes `EMPTY_MAX_FEE` — **zero**, measured on-chain in the run-2 `DepositForBurn` — and the real
 * fee moves to the quote's `feeTotalAmount`. If the migration leaves the writer pointed at `maxFee`,
 * every receipt would carry `feeDisclosedMinor: "0"` beside a `feeDisclosed` of ~0.054, this reader
 * would compare an observed 53985 against 0, and EVERY BRIDGE WOULD RECONCILE AS **MISMATCHED** —
 * a permanent alarm, correctly loud about the wrong thing, blaming Circle for our own field drift.
 *
 * ⭐⭐ SO A RECORD THAT CONTRADICTS ITSELF SUPPORTS NO VERDICT ABOUT AN OVERCHARGE. Disagreement
 * yields `disclosed_incoherent` — an `unreadable`, not a `mismatched`. That is the honest answer:
 * we do not know what the user was shown, so we cannot say they were shown something else.
 * ⚠️ It is deliberately a DISTINCT reason from `disclosed_not_exact` (a decimal we could not convert
 * exactly). One says the record is self-contradictory; the other says it is unrepresentable. Same
 * verdict, different causes, and only the first means a writer is wrong.
 */
export function disclosedFeeMinor(receipt) {
  const stored = receipt?.feeDisclosedMinor;
  const hasStored = typeof stored === "string" && /^\d+$/.test(stored);
  const dec = receipt?.feeDisclosed ?? receipt?.feeUsdc ?? null;
  const fromDec = dec == null ? null : usdcDecimalToMinorExact(Number(dec));

  if (hasStored) {
    const minor = BigInt(stored);
    // ⚠️ Only cross-check when the decimal is BOTH present and exactly representable. An
    // unconvertible legacy decimal is not evidence the integer is wrong, and treating it as such
    // would turn a conversion limit into an accusation about the writer.
    if (fromDec !== null && fromDec !== minor) return { minor: null, reason: "disclosed_incoherent" };
    return { minor, reason: null };
  }
  if (dec == null) return { minor: null, reason: "disclosed_unknown" };
  if (fromDec === null) return { minor: null, reason: "disclosed_not_exact" };
  return { minor: fromDec, reason: null };
}

/**
 * READ THE FEE MOVEMENT OUT OF AN ARC BURN RECEIPT'S LOGS.
 *
 * Pure: takes logs, returns a reading. No I/O, no clock, no store — so the suite exercises the
 * exact function production calls, against the two real receipts on disk.
 *
 * @returns {{read:true, feeMinor:string, feeLogIndex:number, amountLegsMinor:string[]}}
 *        | {{read:false, reason:string, detail?:string}}
 */
export function observeFeeMovement(logs, { payer } = {}) {
  if (!isAddress(payer)) return { read: false, reason: "payer_unknown" };
  const p = lc(payer);

  // ⛔ THE EMITTER PIN AND THE TOPIC0 PIN, TOGETHER, ON EVERY READ. Neither is optional; see the
  // block comment. `topics.length === 3` additionally excludes any non-standard 4-topic emitter.
  const erc20 = (logs || [])
    .filter((l) => lc(l.address) === lc(ARC_USDC) && lc(l.topics?.[0]) === TRANSFER_TOPIC && l.topics?.length === 3)
    .map((l) => ({
      index: Number(l.logIndex),
      from: addrOfTopic(l.topics[1]),
      to: addrOfTopic(l.topics[2]),
      value: BigInt(l.data),
    }));

  const inbound = erc20.filter((t) => t.to === lc(TMWF));
  if (inbound.length === 0) return { read: false, reason: "not_upfront_fee_path" };

  const forwards = erc20.filter((t) => t.from === lc(TMWF) && t.to === lc(FEE_MANAGER));
  if (forwards.length !== 1) return { read: false, reason: "fee_forward_legs", detail: String(forwards.length) };
  const feeMinor = forwards[0].value;

  // ⚠️ SCOPED TO THE PAYER, BECAUSE A BUNDLER MAY BATCH SEVERAL userOps INTO ONE TRANSACTION.
  // Run 2's receipt carried exactly one `UserOperationEvent` — one observation, not a guarantee.
  // With two payers in one tx the FeeManager leg is no longer unique and this refuses above; with
  // one payer and two candidate charges it refuses here. Ambiguity is an OUTCOME, never a guess.
  const charges = inbound.filter((t) => t.from === p);
  const feeLegs = charges.filter((t) => t.value === feeMinor);
  if (feeLegs.length !== 1) return { read: false, reason: "fee_charge_candidates", detail: String(feeLegs.length) };

  return {
    read: true,
    feeMinor: feeMinor.toString(),
    feeLogIndex: feeLegs[0].index,
    // ⭐ EVIDENCE, NOT A VERDICT. The remaining payer→TMWF legs should be the burn amount. It is
    // reported so a reader can check it and never folded into the fee verdict: "the amount leg
    // looks wrong" is a different claim with a different cause, and this module does not make it.
    amountLegsMinor: charges.filter((t) => t !== feeLegs[0]).map((t) => t.value.toString()),
  };
}

/**
 * THE VERDICT. Three outcomes, and the two figures travel WITH it.
 *
 * ⭐ A VERDICT WITHOUT ITS NUMBERS CANNOT BE ACTED ON. On `mismatched` the record carries both
 * figures and which one was charged — not "reconciliation failed". Same reason the intermediate is
 * published alongside the conclusion everywhere else here: a conclusion whose input is gone is
 * unfalsifiable the moment retention expires.
 */
export function reconcileFee({ observed, disclosedMinor }) {
  if (!observed?.read) {
    return { verdict: "unreadable", reason: observed?.reason ?? "chain_unreadable", detail: observed?.detail ?? null,
      feeObservedMinor: null, feeDisclosedMinor: disclosedMinor == null ? null : String(disclosedMinor) };
  }
  if (disclosedMinor == null) {
    return { verdict: "unreadable", reason: "disclosed_unknown", detail: null,
      feeObservedMinor: observed.feeMinor, feeDisclosedMinor: null };
  }
  const matched = BigInt(observed.feeMinor) === BigInt(disclosedMinor);
  return {
    verdict: matched ? "matched" : "mismatched",
    reason: null,
    detail: null,
    feeObservedMinor: observed.feeMinor,
    feeDisclosedMinor: String(disclosedMinor),
    feeLogIndex: observed.feeLogIndex,
    amountLegsMinor: observed.amountLegsMinor,
  };
}

/** Minor units → a decimal string, for display only. ⚠️ The COMPARISON is always in minor units;
 *  this exists so a renderer never has to do the conversion itself. */
export function minorToUsdcString(minor) {
  if (minor == null) return null;
  const n = BigInt(minor);
  const d = 10n ** BigInt(USDC_DECIMALS);
  return `${n / d}.${(n % d).toString().padStart(USDC_DECIMALS, "0")}`;
}

/**
 * 🚨 ALERT ON `mismatched` ONLY. The figure a user consented to is not the figure that moved —
 * which is exactly what the ledger-failure shout exists for, on the same service-integrity
 * channel and with the same discipline: fire-and-forget (an alerting failure must not compound
 * the finding), and the owner address TRUNCATED, because an owner address is an identity.
 *
 * ⚠️ `matched` and `unreadable` are SILENT. `unreadable` will be the common verdict — every
 * pre-migration bridge reconciles `not_upfront_fee_path` — and an alert that fires on the common
 * case is one nobody reads by the time it matters.
 */
export function shoutFeeMismatch({ owner, burnHash, observedMinor, disclosedMinor }) {
  const line =
    `charged ${minorToUsdcString(observedMinor)} USDC · shown ${minorToUsdcString(disclosedMinor)} USDC`;
  console.error(
    "[bridge-fee-reconcile][MISMATCH] " +
      JSON.stringify({
        burnHash,
        owner: String(owner ?? "").slice(0, 10) + "…",
        observedMinor: String(observedMinor),
        disclosedMinor: String(disclosedMinor),
        note: "the fee that MOVED on Arc is not the fee that was DISPLAYED. The burn is final; this is a detector, not a gate.",
      })
  );
  const url = process.env.DD_WATCH_WEBHOOK; // service-integrity channel, NOT the money siren
  if (!url) return;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content:
        `🚨 **[bridge]** FEE MISMATCH — the figure shown is not the figure that moved\n` +
        `burn \`${burnHash}\` · ${line}\n` +
        `The burn is FINAL. This is a detector, not a gate — the charge already happened.`,
    }),
  }).catch(() => {});
}
