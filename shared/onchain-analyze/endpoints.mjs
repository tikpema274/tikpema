// endpoints.mjs — the RPC endpoint set the PAID path reads through.
//
// ═══ 🚨 WHY THIS FILE EXISTS AT ALL ══════════════════════════════════════════════════════════
// `QUORUM_ENDPOINTS` lived in `scripts/dd/analyze-run.mjs` — a CLI entry point. That was correct
// while quorum was a developer tool. The moment the SOLD path reads through it, the endpoint set is
// production configuration and must live where deployed code lives.
//
// ⚠️ AND WHERE IT LIVES IS NOT COSMETIC: `shared/` is inside the build stamp's SURFACES and
// `scripts/` is not. A change to an endpoint list under `scripts/` ships to production and produces
// a BYTE-IDENTICAL tree hash — the exact defect that let two deploys pass a blind tree check on
// 2026-08-15. Putting this here means changing who the service trusts changes the artifact's
// identity, which is the only reason a stamp is worth having.
//
// 🚧 KNOWN, NOT FIXED HERE: `netlify/functions/dd-analyze.mjs` still imports `chainClient` (and
// `attest-circle.mjs`) from `scripts/dd/`, so `scripts/dd/{client,chains,rpc,attest-circle}.mjs`
// ARE deployed code outside the stamped surface today. Recorded in PROGRESS as its own item — a
// file move belongs in its own commit, not folded into a money-path behaviour change.

/**
 * ⭐⭐ TWO ENDPOINTS, AND THE SECOND ONE IS THE PRODUCT.
 *
 * The DD service SELLS A CLAIM ABOUT CHAIN STATE. A wrong read here is not a delayed bridge — it is
 * a SIGNED ATTESTATION asserting something false, which the buyer paid for and can verify against
 * nothing. Reading one endpoint and signing the answer is the failure this list exists to prevent.
 *
 * ⚠️ TWO LIMITS THAT REMAIN, and they are why every report declares `independenceVerified: false`:
 *   1. dRPC is an AGGREGATOR. A distinct backend is PROVEN for the probes that selected it, not
 *      guaranteed per call; it could route to Arc public on any given request.
 *   2. Every Arc provider syncs from the same PERMISSIONED validator set. Quorum covers PROVIDER
 *      integrity (proxy bug, stale or pruned cache, hijacked endpoint, lying aggregator) and NEVER
 *      consensus integrity.
 * ⚠️ Two mirrors of one node agree perfectly and are worth nothing. Agreement is not evidence of
 * independence; independence is an asserted property that must be re-verified out of band.
 */
export const ARC_QUORUM_ENDPOINTS = Object.freeze([
  "https://rpc.testnet.arc.network", // Arc public — direct reth/v1.11.3, no CDN
  "https://arc-testnet.drpc.org",    // dRPC — verified distinct backend
]);

/** The tags `quorumClient` throws, mapped to what they MEAN. Exported so the report, the tests and
 *  the escalation path all name the same four outcomes instead of three of them agreeing. */
export const QUORUM_OUTCOMES = Object.freeze({
  /** Nobody answered. A statement about US: our instrument failed. Carries no information about the
   *  chain or the providers. Retryable, expected to be transient. */
  UNREADABLE: "rpc-unreadable",
  /** ⭐⭐ Endpoints answered the SAME call at the SAME pinned block and returned DIFFERENT values.
   *  A statement about THEM, and a POSITIVE FINDING: at least one provider is serving something
   *  false. This is the ONLY signal that proves a single-endpoint build of this service would have
   *  SIGNED AND SOLD a false claim. ⚠️ NOT safely retryable — a retry may return agreement and erase
   *  the evidence, so it must be captured at the moment of the split. */
  DISAGREEMENT: "rpc-disagreement",
  /** A value EXISTS and is refused: too few endpoints answered to corroborate it. Neither an outage
   *  (we did read) nor a conflict (nothing disagreed). Accepting a lone survivor is a one-step
   *  downgrade attack — knock over one endpoint, be trusted alone again. */
  QUORUM_UNMET: "rpc-quorum-unmet",
});

// ⚠️ THREE MANIFEST REASONS, NOT FOUR — CHECKED, NOT ASSUMED. `quorumClient` raises FOUR tags, but
// both mappers (quorum.mjs and coverage.mjs) deliberately collapse `chain-disagreement` into
// `rpc-disagreement`. That collapse is defensible — a chain split IS a disagreement, and the chain
// guard in `assert()` catches it before any slot is read, so it fails the whole analysis rather than
// one check — but it means a fourth distinct reason does NOT exist in the manifest, and claiming one
// here would be inventing a state nothing emits.
// 🚧 The mapping is written out in BOTH files: a duplicate source of truth, recorded in PROGRESS.

/** The outcomes that mean PROVIDER INTEGRITY IS IN QUESTION, as opposed to our instrument failing.
 *  ⭐ Kept as a set rather than an inline comparison because two different call sites consume it —
 *  the report's disclosure and the escalation — and they must never drift apart on what counts. */
export const INTEGRITY_OUTCOMES = Object.freeze([QUORUM_OUTCOMES.DISAGREEMENT]);
