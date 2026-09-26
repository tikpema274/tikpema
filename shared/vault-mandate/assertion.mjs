// assertion.mjs — step 7, the POST-DEPOSIT ASSERTION: the bridge's predicted→measured rule, reused.
// Pure: the caller reads the chain and passes the facts. Scoped 2026-09-25 (PROGRESS, "POST-DEPOSIT
// ASSERTION + DISCLOSURE WORDING").
//
// ═══ NO TOLERANCE ═════════════════════════════════════════════════════════════════════════════
// ERC-4626: previewDeposit ≤ the shares actually minted IN THE SAME STATE, so rounding only favours the
// depositor. Instead of tolerating share-price drift, the prediction is re-read at the deposit's PARENT
// block — the state our deposit executed against — and the cause of any shortfall is read, not assumed:
//   1. depositFee() at the parent ≠ at the check        → mismatched: deposit-fee-changed
//   2. received < previewDeposit at the parent (exact)   → mismatched: fewer-shares-than-preview
//      (a fee raised in the deposit block AHEAD of our tx shows here; the fee at the deposit block
//       attributes it)
//   3. else matched; the quoted-at-check vs received gap is shown as a MEASURED share-price change.
// ⭐ RECEIVED IS TWO INSTRUMENTS: the vault's own Deposit event, cross-checked by the SCA's share-balance
// delta. If they disagree, something else moved shares in that block: unreadable, never matched.
// ⛔ Anything that could not be read is UNREADABLE → the mandate pauses as INCONCLUSIVE. Never matched.

export const DEPOSIT_VERDICT = Object.freeze({ MATCHED: "matched", MISMATCHED: "mismatched", UNREADABLE: "unreadable" });

const asBig = (v) => (typeof v === "bigint" ? v : typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null);
const isBps = (v) => Number.isInteger(v) && v >= 0 && v <= 10000;
const s = (v) => (v === null || v === undefined ? null : String(v));

/**
 * @param {{feeAtCheckBps:number, sharesPredictedAtCheck:bigint|string, facts:{readable:boolean, why?:string,
 *   depositBlock:number, parentBlock:number, predictedAtParent:bigint, eventShares:bigint, shareDelta:bigint,
 *   feeAtParentBps:number, feeAtDepositBlockBps:number}}} a
 */
export function depositVerdict({ feeAtCheckBps, sharesPredictedAtCheck, facts } = {}) {
  const f = facts ?? {};
  const atCheck = asBig(sharesPredictedAtCheck), atParent = asBig(f.predictedAtParent);
  const ev = asBig(f.eventShares), delta = asBig(f.shareDelta);
  const out = (verdict, reason, detail, extra = {}) => ({
    verdict, reason, detail,
    predicted: { atCheck: s(atCheck), atParent: s(atParent) },
    received: { event: s(ev), delta: s(delta) },
    fee: { atCheckBps: feeAtCheckBps ?? null, atParentBps: f.feeAtParentBps ?? null, atDepositBlockBps: f.feeAtDepositBlockBps ?? null },
    blocks: { deposit: f.depositBlock ?? null, parent: f.parentBlock ?? null },
    ...extra,
  });
  const unreadable = (why) => out(DEPOSIT_VERDICT.UNREADABLE, "unreadable", why);

  if (f.readable !== true) return unreadable(f.why ?? "the deposit's receipt could not be read");
  if (!isBps(feeAtCheckBps)) return unreadable("the check recorded no deposit fee to compare against");
  if (atParent === null) return unreadable("previewDeposit at the parent block could not be read");
  if (ev === null) return unreadable("the vault's Deposit event for our wallet could not be read");
  if (delta === null) return unreadable("the share-balance delta could not be read");
  if (!isBps(f.feeAtParentBps)) return unreadable("the deposit fee at the parent block could not be read");
  if (ev !== delta) return unreadable(`the Deposit event (${ev}) and the share-balance delta (${delta}) disagree`);

  if (f.feeAtParentBps !== feeAtCheckBps) {
    return out(DEPOSIT_VERDICT.MISMATCHED, "deposit-fee-changed",
      `the vault's deposit fee changed from ${feeAtCheckBps} to ${f.feeAtParentBps} bps between our check and your deposit`);
  }
  if (ev < atParent) {
    const shortBps = Number(((atParent - ev) * 10000n) / atParent);
    const inBlock = isBps(f.feeAtDepositBlockBps) && f.feeAtDepositBlockBps !== f.feeAtParentBps
      ? ` The deposit fee was ${f.feeAtDepositBlockBps} bps in the deposit block itself — raised in that block ahead of our deposit.` : "";
    return out(DEPOSIT_VERDICT.MISMATCHED, "fewer-shares-than-preview",
      `we expected at least ${atParent} shares and received ${ev} (${shortBps} bps fewer).${inBlock}`, { shortfallBps: shortBps });
  }
  // Matched. The gap between the quote at the check and what arrived is the share price moving between
  // the two blocks — MEASURED here, shown to the user, never tolerated as an error margin.
  // Positive = fewer shares per USDC than quoted (the price rose). Two decimals of a bps: shown, not rounded away.
  const sharePriceChangeBps = atCheck !== null && atCheck > 0n
    ? Math.round((Number(atCheck - ev) * 10000 / Number(atCheck)) * 100) / 100 : null;
  return out(DEPOSIT_VERDICT.MATCHED, "matched", "received at least what the vault quoted in the state it executed against",
    { sharePriceChangeBps, sharePriceChangeMeasured: true });
}
