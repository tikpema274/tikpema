// quorum.mjs — read every critical slot from ≥2 endpoints, require agreement, REFUSE on anything else.
//
// ═══ WHERE THIS LIVES, AND WHY IT IS NOT IN THE SHARED PRIMITIVE ══════════════════════════════
// This is a layer analyze() wraps AROUND the primitive's reads. It is emphatically NOT inside
// shared/onchain-facts, which netlify/functions/_vault.mjs also consumes.
//
// That is structural, not a matter of discipline: onchain-facts contains zero reads and zero awaits
// — every function there is pure over values the caller already fetched, and its header forbids
// adding a read. Quorum cannot go there without breaking that cut line.
//
// 🚨 AND IT MUST NOT, because the deposit path would change. More reads that can fail means a higher
// `proxy-status-unreadable` BLOCK rate on Arc's already-throttled public RPC — a user-visible refusal
// with nothing actually wrong with the vault — and it would move disclosureDigest(), invalidating
// every outstanding ack. `_vault.mjs` keeps its single-RPC viem multicall path EXACTLY as shipped.
// The composition point is the injected client: analyze(address, { client }) takes this instead of a
// single-endpoint client, and shape.mjs / powers.mjs are UNCHANGED — they never knew how many
// endpoints were behind `client.call`.
//
// ═══ THE MATRIX ═══════════════════════════════════════════════════════════════════════════════
//   both agree      → the value. The ONLY path to a value.
//   disagree        → NO value. reason "rpc-disagreement"      ← never pick a winner
//   one reads, one throws → NO value. reason "rpc-quorum-unmet" ← a surviving single source is
//                     exactly the trust quorum exists to refuse. Accepting it is fail-open and is a
//                     one-step downgrade attack: knock over one endpoint, be trusted alone again.
//   both throw      → NO value. reason "rpc-unreadable"
//
// All four non-agreement outcomes reach the caller the SAME way: a tagged throw, which
// coverage.runCheck already routes into notChecked. Never a thrown error out of analyze(), never a
// silent pick. The distinct reason strings exist so the report says WHICH failure happened.
//
// ═══ WHAT QUORUM DOES AND DOES NOT DEFEND AGAINST ═════════════════════════════════════════════
// Threat model is PROVIDER INTEGRITY: a proxy bug, a stale or pruned cache, a misconfigured or
// hijacked endpoint, a lying aggregator. NOT consensus integrity — every Arc RPC provider syncs from
// the same PERMISSIONED validator set, so no number of endpoints checks the validators themselves.
// ⚠️ And "the endpoints agreed" is NOT evidence they are independent: two mirrors of one node agree
// perfectly and are worth nothing ([[absence-must-never-read-as-safe]] pointed at the quorum design
// itself). Independence is an asserted property that must be re-verified out of band, so every report
// declares its endpoint set AND declares independence unverified rather than implying it.

/** Tag a failure so coverage.runCheck can name the reason without inspecting messages. */
const quorumError = (message, reason, extra) =>
  Object.assign(new Error(message), { quorumFailed: true, quorumReason: reason, ...extra });

const norm = (v) => (typeof v === "string" ? v.toLowerCase() : JSON.stringify(v));

/**
 * Compose N single-endpoint clients into one quorum client with the SAME interface
 * ({ chain, assert, pin, call }), so it drops straight into analyze(address, { client }).
 *
 * ⚠️ Takes CLIENTS, not URLs. This module never opens a connection — transport stays per-caller,
 * exactly as Step 1 decided. The runner supplies the endpoint list.
 */
export function quorumClient(clients, { minAgree = 2 } = {}) {
  if (!Array.isArray(clients) || clients.length < minAgree)
    throw new Error(`quorumClient: need at least ${minAgree} clients, got ${clients?.length ?? 0}`);

  let guarded = null; // the endpoints that passed their own chain guard
  let pinned = null;

  return {
    chain: clients[0].chain,
    endpoints: clients.map((c) => c.chain?.rpc ?? "unknown"),
    quorum: { required: minAgree, configured: clients.length, independenceVerified: false },

    /**
     * EVERY endpoint proves it is on the right chain BEFORE any of its answers count. An endpoint
     * that fails is EXCLUDED, not tolerated — a wrong-chain answer that happens to agree is worse
     * than one that disagrees. If fewer than `minAgree` survive, quorum is impossible and every
     * subsequent read fails as quorum-unmet rather than quietly degrading to single-source.
     */
    async assert() {
      if (guarded) return guarded.chainId;
      const results = await Promise.all(
        clients.map(async (c) => {
          try { return { c, chainId: await c.assert(), ok: true }; }
          catch (e) { return { c, ok: false, error: String(e?.message ?? e) }; }
        })
      );
      const healthy = results.filter((r) => r.ok);
      const ids = [...new Set(healthy.map((r) => r.chainId))];
      if (ids.length > 1)
        throw quorumError(`endpoints report different chain ids: ${ids.join(", ")}`, "chain-disagreement",
          { responses: results.map((r) => ({ endpoint: r.c.chain?.rpc, value: r.chainId ?? null, error: r.error ?? null })) });
      if (healthy.length < minAgree)
        throw quorumError(`only ${healthy.length} of ${clients.length} endpoints passed the chain guard; quorum needs ${minAgree}`,
          "quorum-unmet", { responses: results.map((r) => ({ endpoint: r.c.chain?.rpc, error: r.error ?? null })) });
      guarded = { clients: healthy.map((r) => r.c), chainId: ids[0] };
      return guarded.chainId;
    },

    /**
     * ⭐ THE PIN IS DELIBERATELY NOT QUORUMED. Two endpoints legitimately differ by a block or two;
     * requiring agreement on the head would refuse constantly on CORRECT behaviour. Instead the pin
     * is resolved once and the SAME block tag is sent to every endpoint — which is what makes every
     * other comparison apples-to-apples. Without it, a disagreement is indistinguishable from skew.
     */
    async pin() {
      if (pinned) return pinned;
      const src = (guarded?.clients ?? clients)[0];
      pinned = await src.pin();
      pinned.pinnedFrom = src.chain?.rpc ?? "unknown";
      return pinned;
    },

    /**
     * Fan out one read to every guarded endpoint and require agreement.
     * Returns { result, queries[], evidence } on agreement — `queries` is an ARRAY so both curls
     * land in report.reads[] and the comparison is reproducible.
     */
    async call({ method, params }) {
      const pool = guarded?.clients ?? clients;
      const settled = await Promise.all(
        pool.map(async (c) => {
          const endpoint = c.chain?.rpc ?? "unknown";
          try {
            const out = await c.call({ method, params });
            return { endpoint, ok: true, value: out.result, query: out.query, evidence: out.evidence };
          } catch (e) {
            return { endpoint, ok: false, error: String(e?.message ?? e), transient: Boolean(e?.transient), query: e?.query ?? null };
          }
        })
      );

      const queries = settled.map((s) => s.query).filter(Boolean);
      const responses = settled.map((s) => (s.ok ? { endpoint: s.endpoint, value: s.value } : { endpoint: s.endpoint, error: s.error }));
      const answered = settled.filter((s) => s.ok);

      // ── both (all) threw → nobody could tell us. The primitive's UNREADABLE case.
      if (answered.length === 0)
        throw quorumError(`no endpoint could answer ${method}`, "unreadable", {
          responses, queries, transient: settled.every((s) => s.transient),
        });

      // ── disagreement → NO value, and we do not choose. Checked BEFORE the count test so a split
      //    is always reported as a split, never as "one endpoint down".
      const distinct = [...new Set(answered.map((s) => norm(s.value)))];
      if (distinct.length > 1)
        throw quorumError(
          `endpoints disagreed on ${method}: ${distinct.length} distinct answers`, "disagreement", { responses, queries });

      // ── agreed, but too few answered → a surviving single source is not quorum-backed.
      if (answered.length < minAgree)
        throw quorumError(
          `only ${answered.length} of ${pool.length} endpoints answered ${method}; quorum needs ${minAgree}`,
          "quorum-unmet", { responses, queries });

      return {
        result: answered[0].value,
        queries,
        evidence: {
          httpStatus: answered[0].evidence?.httpStatus ?? null,
          quorum: { agreed: answered.length, of: pool.length, endpoints: answered.map((s) => s.endpoint) },
          ...(answered.some((s) => s.evidence?.retriedAttempts) ? { retriedAttempts: Math.max(...answered.map((s) => s.evidence?.retriedAttempts ?? 0)) } : {}),
        },
      };
    },
  };
}

/** Map a quorum failure onto the coverage reason string. Consumed by coverage.runCheck. */
export function quorumReasonFor(e) {
  if (!e?.quorumFailed) return null;
  return {
    disagreement: "rpc-disagreement",
    "chain-disagreement": "rpc-disagreement",
    "quorum-unmet": "rpc-quorum-unmet",
    unreadable: "rpc-unreadable",
  }[e.quorumReason] ?? "rpc-quorum-unmet";
}
