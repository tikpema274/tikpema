// disclosureDiff — WHAT CHANGED between the disclosure a user accepted and the one now in force.
//
// ═══ ⭐⭐ WHY A DIFF AND NOT A NOTICE ═════════════════════════════════════════════════════════
// When a vault's disclosure moves, the acknowledgement token derived from it stops matching and the
// deposit is refused. Telling the user "this changed, please look again" leaves them to diff two
// things they cannot see — the old disclosure is gone from the screen the moment the new one
// renders. A re-tick nobody can check is a formality, and a formality is trained click-through,
// which this codebase has already recorded as a hazard on the fee-band surface.
//
// ⭐ THE CHANGE IS COMPUTABLE, so it must be computed. `disclosureDigest` is
// `address | warn codes | withdrawFee | depositFee` — four inputs, all of them now carried on the
// disclosure itself. Every possible digest move is therefore explainable as: a warn appeared, a warn
// disappeared, or a named fee moved from X to Y.
//
// ⚠️ IF NOTHING EXPLAINS IT, SAY SO RATHER THAN IMPLY NOTHING CHANGED. A digest that moved with no
// visible delta means an input we are not showing — a schema change, a version bump in the digest
// formula, an address mismatch. `unexplained` is a first-class outcome: the honest statement is
// "it changed and we cannot show you how", never silence.

export type Warn = { code: string; detail?: string };
export type Disclosure = {
  level?: string | null;
  warns?: Warn[];
  blocks?: Warn[];
  digest?: string | null;
  withdrawFeeBps?: number | null;
  depositFeeBps?: number | null;
};

export type DisclosureDelta = {
  changed: boolean;
  /** Warn codes present now but not when the user accepted. */
  warnsAdded: Warn[];
  /** Warn codes accepted then, absent now. */
  warnsRemoved: Warn[];
  /** Named fee movements, in basis points. */
  feeChanges: Array<{ label: string; fromBps: number | null; toBps: number | null }>;
  /** ⚠️ The digest moved but nothing above explains it — an input we do not render. */
  unexplained: boolean;
  /** The verdict level, if it moved (OK → WARN → BLOCK). */
  levelChange: { from: string | null; to: string | null } | null;
};

const codes = (ws?: Warn[]) => new Set((ws ?? []).map((w) => w.code));
const feeOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * @param accepted the disclosure the user ticked (from the inspection they were shown)
 * @param current  the disclosure returned with the refusal (server-computed, authoritative)
 * @param changeIsKnown TRUE when the caller already knows something moved — e.g. the server refused
 *   an acknowledgement it had itself issued. ⚠️ THE CLIENT CANNOT COMPARE DIGESTS: it holds
 *   `ackToken`, which is a HASH of the digest, while the disclosure carries the raw string. So the
 *   authoritative "something changed" signal is the REFUSAL, not a digest comparison — and without
 *   this flag `unexplained` could never fire, which would make the honest case unreachable.
 */
export function diffDisclosure(
  accepted: Disclosure | null | undefined,
  current: Disclosure | null | undefined,
  changeIsKnown = false,
): DisclosureDelta {
  const none: DisclosureDelta = {
    changed: false, warnsAdded: [], warnsRemoved: [], feeChanges: [], unexplained: false, levelChange: null,
  };
  // ⚠️ WITHOUT BOTH SIDES THERE IS NO DIFF, AND PRETENDING OTHERWISE IS THE DEFECT AGAIN. If we
  // cannot compare, say the change is unexplained rather than reporting an empty (reassuring) delta.
  if (!accepted || !current) return { ...none, changed: !!current, unexplained: !!current };

  const a = codes(accepted.warns), c = codes(current.warns);
  const warnsAdded = (current.warns ?? []).filter((w) => !a.has(w.code));
  const warnsRemoved = (accepted.warns ?? []).filter((w) => !c.has(w.code));

  const feeChanges: DisclosureDelta["feeChanges"] = [];
  const pairs: Array<[string, unknown, unknown]> = [
    ["withdraw fee", accepted.withdrawFeeBps, current.withdrawFeeBps],
    ["deposit fee", accepted.depositFeeBps, current.depositFeeBps],
  ];
  for (const [label, from, to] of pairs) {
    const f = feeOrNull(from), t = feeOrNull(to);
    if (f !== t) feeChanges.push({ label, fromBps: f, toBps: t });
  }

  const levelChange =
    (accepted.level ?? null) !== (current.level ?? null)
      ? { from: accepted.level ?? null, to: current.level ?? null }
      : null;

  const digestMoved = changeIsKnown || (!!accepted.digest && !!current.digest && accepted.digest !== current.digest);
  const explained = warnsAdded.length > 0 || warnsRemoved.length > 0 || feeChanges.length > 0;

  return {
    changed: digestMoved || explained || !!levelChange,
    warnsAdded,
    warnsRemoved,
    feeChanges,
    // ⭐ The case that must never be silent: the digest moved and none of the four inputs we render
    // accounts for it.
    unexplained: digestMoved && !explained,
    levelChange,
  };
}

/** Basis points as a percentage string, or an honest "unknown". */
export const bps = (v: number | null) => (v === null ? "unknown" : `${(v / 100).toFixed(2)}%`);
