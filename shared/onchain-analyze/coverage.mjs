// coverage.mjs — ⭐ THE LOAD-BEARING FILE. The coverage manifest is GENERATED FROM WHAT ACTUALLY RAN.
//
// ═══ WHY THIS IS NOT A LIST ═══════════════════════════════════════════════════════════════════
// scripts/dd/checks/owner-powers.mjs:72-100 has a hand-written COVERAGE const with a static
// `notCheckedFor` array. Its instinct is exactly right — "THIS IS NOT DOCUMENTATION, IT IS OUTPUT",
// because a clean bill is the one result nobody double-checks. But the mechanism is a CLAIM ABOUT
// what ran, maintained by hand, sitting next to the code that runs. Add a power group to the shared
// catalogue and forget to touch that array, and the report silently over-claims its own coverage.
// That is [[duplicate-source-of-truth]] wearing a safety jacket.
//
// So the manifest here is a SIDE-EFFECT LEDGER of the enumeration itself. Four properties make it
// generated rather than hopeful:
//
//   1. NO PATH BYPASSES IT. The enumeration loop never receives the rpc client — it receives this
//      recorder, and `runCheck` is the only door to the wire. Reaching the chain without registering
//      requires changing a function signature: a visible edit, not a silent omission.
//   2. EVERY EXIT REGISTERS. try → checked, catch → notChecked. There is no third exit from runCheck.
//   3. skip() IS MANDATORY AND REASONED. A check the shape makes invalid (diamond facets) lands in
//      notChecked WITH A REASON. It never just fails to appear.
//   4. THE COMPLETENESS INVARIANT REFUSES (see schema.mjs:assertReportValid). Every group in the
//      shared catalogue must appear in exactly one list. A group that is neither run nor skipped
//      makes the report INVALID — you get a refusal instead of a clean bill on an unscanned power.
//
// ⚠️ A CHECK THAT CANNOT CONCLUDE MUST THROW, NOT RETURN FALSE. This is where the fail-open family
// is actually defeated. `scanGroup` throws when the bytecode is UNREADABLE rather than returning
// `present: false`, so an unreadable read puts all nine groups in notChecked automatically instead of
// producing nine reassuring absences. The seam does the work; the caller cannot forget.

/**
 * A coverage recorder. One per analyze() call, threaded through BOTH the shape stage and the
 * enumeration stage — shape reads can fail too, and a failed shape read belongs in the manifest.
 */
export function makeCoverage() {
  const checked = [];
  const notChecked = [];
  const reads = [];

  return {
    /**
     * ⭐ THE ONLY DOOR. Runs one check and registers the outcome. `fn` either performs an RPC read
     * (returning the {result, query, evidence} shape scripts/dd/rpc.mjs yields) or computes over
     * already-read values. Both are "checks"; both must be accounted for.
     *
     * Returns a discriminated result — never throws for an expected failure, because a failed check
     * is DATA about coverage, not an exception. (Programmer error still throws; see index.mjs.)
     */
    async runCheck(id, meta, fn) {
      // One read, or N reads when a quorum client fanned the same call out to several endpoints.
      // Recording ALL of them is what makes a disagreement REPRODUCIBLE: the reader gets one curl
      // per endpoint and can re-run the split themselves.
      const record = (qs, { failed = false, evidence = null } = {}) =>
        (qs ?? []).map((q) => {
          const readId = `r${reads.length}`;
          reads.push({
            readId, endpoint: q.endpoint, method: q.method, params: q.params, reproduce: q.reproduce,
            httpStatus: failed ? null : evidence?.httpStatus ?? null,
            ...(failed ? { failed: true } : {}),
            ...(evidence?.retriedAttempts ? { retriedAttempts: evidence.retriedAttempts } : {}),
          });
          return readId;
        });

      try {
        const out = await fn();
        const isRpc = out && typeof out === "object" && (out.query || out.queries);
        const readIds = isRpc ? record(out.queries ?? [out.query], { evidence: out.evidence }) : [];
        checked.push({
          id, ...meta, outcome: "ran",
          ...(readIds.length ? { readId: readIds[0] } : {}),
          ...(readIds.length > 1 ? { readIds } : {}),
          ...(out?.evidence?.quorum ? { quorum: out.evidence.quorum } : {}),
        });
        return { ok: true, value: isRpc ? out.result : out, readId: readIds[0] ?? null };
      } catch (e) {
        // ⭐ THE REASON LADDER. Quorum outcomes are tested FIRST and deliberately: a disagreement
        // error can also look transient, and misclassifying a SPLIT as "rpc-unreadable" would hide
        // the single most interesting thing the quorum layer can tell you — that two endpoints gave
        // different answers about the same slot at the same block.
        //
        // `.transient` is tagged by scripts/dd/rpc.mjs:89 and is the exact discriminator between
        // "we could not ask" (retries exhausted on the transient class) and "the chain answered, and
        // the answer was an error" (e.g. execution reverted). Collapsing those is defect A's shape.
        const reason =
          e?.quorumFailed
            ? ({ disagreement: "rpc-disagreement", "chain-disagreement": "rpc-disagreement",
                 "quorum-unmet": "rpc-quorum-unmet", unreadable: "rpc-unreadable" }[e.quorumReason] ?? "rpc-quorum-unmet")
            : e?.transient ? "rpc-unreadable"
            : e?.unreadableInput ? "input-unreadable"
            : "check-error";
        const readIds = record(e?.queries ?? (e?.query ? [e.query] : []), { failed: true });
        notChecked.push({
          id, ...meta, reason, detail: String(e?.message ?? e),
          // WHAT each endpoint actually said. "Two endpoints disagreed" is useless without this,
          // and it is the part a human re-runs.
          ...(e?.responses ? { responses: e.responses } : {}),
          ...(readIds.length ? { readIds } : {}),
        });
        return { ok: false, error: e };
      }
    },

    /**
     * A check deliberately NOT run. `why` is required — an unstated skip is indistinguishable from
     * an oversight, which is the whole failure this file exists to prevent.
     */
    skip(id, meta, why) {
      if (!why) throw new Error(`coverage.skip("${id}") requires a stated reason`);
      notChecked.push({ id, ...meta, reason: "not-applicable", why });
    },

    manifest() {
      return {
        checked: [...checked],
        notChecked: [...notChecked],
        totals: { checked: checked.length, notChecked: notChecked.length },
      };
    },

    reads: () => [...reads],
  };
}

/** Thrown by a check that cannot conclude because an input was UNREADABLE. Lands in notChecked. */
export function unreadableInput(message) {
  return Object.assign(new Error(message), { unreadableInput: true });
}
