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
      try {
        const out = await fn();
        // An RPC-shaped return carries `query`; record it once and hand back a reference, so nine
        // powers derived from one bytecode read do not carry nine copies of the same curl.
        let readId = null;
        if (out && typeof out === "object" && out.query) {
          readId = `r${reads.length}`;
          reads.push({
            readId,
            endpoint: out.query.endpoint,
            method: out.query.method,
            params: out.query.params,
            reproduce: out.query.reproduce,
            httpStatus: out.evidence?.httpStatus ?? null,
            ...(out.evidence?.retriedAttempts ? { retriedAttempts: out.evidence.retriedAttempts } : {}),
          });
        }
        checked.push({ id, ...meta, outcome: "ran", ...(readId ? { readId } : {}) });
        return { ok: true, value: out && out.query ? out.result : out, readId };
      } catch (e) {
        // `.transient` is tagged by scripts/dd/rpc.mjs:89 and is the exact discriminator between
        // "we could not ask" (retries exhausted on the transient class) and "the chain answered, and
        // the answer was an error" (e.g. execution reverted). Collapsing those is defect A's shape.
        const reason = e?.transient ? "rpc-unreadable" : e?.unreadableInput ? "input-unreadable" : "check-error";
        notChecked.push({ id, ...meta, reason, detail: String(e?.message ?? e) });
        if (e?.query) {
          reads.push({
            readId: `r${reads.length}`,
            endpoint: e.query.endpoint,
            method: e.query.method,
            params: e.query.params,
            reproduce: e.query.reproduce,
            httpStatus: null,
            failed: true,
          });
        }
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
