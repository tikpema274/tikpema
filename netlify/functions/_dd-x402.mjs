// _dd-x402.mjs — the DD service's facilitator layer: how a report gets paid for.
//
// ═══ WHAT THIS ADDS THAT settle-gate.mjs DELIBERATELY DID NOT ═════════════════════════════════
// shared/x402/settle-gate.mjs decides WHETHER a report may be charged for and enforces the ordering
// (run, then decide, then settle). It holds no key, opens no connection, and moves no money — the
// `settle` function is injected precisely so that rule could be proven without funds.
//
// THIS module is the injection site. It is where the Circle Gateway facilitator, the revenue wallet,
// the price and the pending-payment store actually meet. It still takes `facilitator`, `rpcCall` and
// `store` as PARAMETERS — the handler owns transport — so the whole payment path stays exercisable
// offline. Nothing here constructs an SDK client or reads a secret.
//
// ═══ ⭐ THE ORDERING, AND WHY IT DIFFERS FROM x402-quote ══════════════════════════════════════
// x402-quote sells a canned payload, so it can settle first and serve second. This sells the REPORT,
// so the analysis must happen BEFORE anything touches money:
//
//   402 → pay → verify → ANALYZE → settleDecision → snapshot → persist → settle → 202 + handle
//                                                                          ↓
//                                        retrieve(handle) → confirm on chain → 200 + THE SAME REPORT
//
// Two consequences worth stating outright:
//   · A slow or failing analysis burns the request budget BEFORE any settlement is attempted, so a
//     timeout costs the caller nothing. The expensive work sits on the safe side of the money.
//   · The artifact is FROZEN at settle time and stored with the handle. Retrieve serves those exact
//     bytes — it never re-runs the analysis. Re-running would hand the caller a report they did not
//     buy (chain state moves), re-spend our RPC and signing quota for free, and invalidate the
//     signature that was made over the original payload.
//
// ═══ ⭐ PERSIST BEFORE BROADCAST — the inversion that protects the caller ══════════════════════
// The pending record is written BEFORE facilitator.settle() is called, not after. If the process dies
// or the SDK throws between broadcast and bookkeeping, the caller still holds a redeemable handle.
// The natural order (settle, then persist) loses the entitlement in exactly the case where the money
// DID move — it fails in the direction that costs the caller. Same reasoning as the one-shot
// create+persist-first in scripts/create-revenue-wallet.mjs.
//
// ═══ ⚠️ WHAT CONFIRMATION CAN AND CANNOT PROVE — DO NOT OVERSTATE IT ═════════════════════════
// Confirmation is availableBalance(USDC, payTo), an AGGREGATE read. It answers "has payTo's Gateway
// balance risen by at least this much since we snapshotted", NOT "did THIS payment land". Two
// concurrent equal-amount payments cross-confirm. The exact per-payment read — authorizationState
// (payer, nonce) — exists on Arc USDC but REVERTS on GatewayWalletBatched, so it is unavailable on
// this path. This is a KNOWN, ACCEPTED limitation for testnet, and every caller-facing body below
// says so in words. Nothing that needs true per-payment attribution may inherit this.
//
// What keeps it sound at all is the dedicated revenue wallet: its entire history is DD revenue, so
// an aggregate read over it is not polluted by unrelated credits. That is why payTo must never be a
// wallet that receives anything else, and why resolvePayTo() below refuses to guess.

import { randomUUID } from "node:crypto";
import { runThenSettle, settleDecision, SETTLE_REASON, noChargeResponse } from "../../shared/x402/settle-gate.mjs";
import { readGatewayBalance, confirmPayment, CONFIRM_REASON, RETRIEVE_TIMEOUT_MS, RETRIEVE_TIMEOUT_PROVENANCE } from "./_x402-confirm.mjs";

export const PENDING_STORE = "dd-analyze-pending";

// --- Arc Testnet / Gateway batching constants (mirrored from x402-quote; do not change) ---------
export const DD_NETWORK = "eip155:5042002"; // Arc Testnet, CAIP-2
export const DD_ASSET = "0x3600000000000000000000000000000000000000"; // USDC on Arc
export const DD_VERIFYING_CONTRACT = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9"; // Gateway Wallet
export const DD_EXTRA = Object.freeze({
  name: "GatewayWalletBatched",
  version: "1",
  verifyingContract: DD_VERIFYING_CONTRACT,
});

/** $0.06 per report, in 6-decimal atomic units. Flat: thin coverage is a first-class answer and is
 *  priced the same, because an honest "here is what I could not check" IS the product. Deliberately
 *  NOT a coverage-scaled price — that would put a tunable number on the money path and give us an
 *  incentive to report more coverage than we have. */
export const DD_PRICE_ATOMIC = "60000";
export const DD_PRICE_HUMAN = "$0.06 USDC";

/** Gateway settlement is batched and delayed, so the authorization must stay valid far longer than
 *  the confirmation window. GatewayEvmScheme uses 7 days + buffer. */
export const MAX_TIMEOUT_SECONDS = 604900;

export const PAYTO_REASON = Object.freeze({
  OK: "ok",
  UNSET: "payto-unset",
  MALFORMED: "payto-malformed",
});

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Resolve the revenue address, fail-closed.
 *
 * ⭐ THERE IS NO FALLBACK, AND THAT IS THE POINT. `SELLER_ADDRESS` (x402-quote's payTo) is sitting
 * right there in the same environment and would "work" — which is exactly the hazard. Falling back
 * would route DD revenue into a wallet that already holds an unrelated float, permanently destroying
 * the zero-history property that makes aggregate reconciliation attributable at all. A missing
 * variable must never be repaired by guessing a nearby one.
 *
 * ⚠️ An unset payTo does NOT downgrade the service to free. A paid service that silently becomes a
 * free one on a misconfiguration is the absence-reads-as-safe failure on the money path: the caller
 * gets signed attestations at our cost and nothing anywhere records that it happened.
 */
export function resolvePayTo(env = process.env) {
  const raw = env?.DD_PAYTO_ADDRESS;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return {
      ok: false,
      payTo: null,
      reason: PAYTO_REASON.UNSET,
      detail:
        "DD_PAYTO_ADDRESS is not set, so there is no revenue address to be paid. The service refuses " +
        "to answer rather than serve for free: a paid service that quietly becomes free on a missing " +
        "environment variable is a misconfiguration nothing would ever surface. It is deliberately " +
        "NOT defaulted to SELLER_ADDRESS — routing DD revenue into a wallet with unrelated history " +
        "would destroy the only thing that makes payment reconciliation attributable.",
    };
  }
  const v = String(raw).trim();
  if (!ADDRESS_RE.test(v)) {
    return {
      ok: false,
      payTo: null,
      reason: PAYTO_REASON.MALFORMED,
      detail: "DD_PAYTO_ADDRESS is not a 0x-prefixed 20-byte hex address. Refusing to quote a price payable to an address we cannot parse.",
    };
  }
  return { ok: true, payTo: v.toLowerCase(), reason: PAYTO_REASON.OK, detail: "revenue address resolved" };
}

/** The x402 PaymentRequirements a buyer must satisfy. `resource` binds the signature to this exact
 *  endpoint, so an authorization signed for one resource cannot be replayed against another. */
export function ddPaymentRequirements({ resource, payTo }) {
  return {
    scheme: "exact",
    network: DD_NETWORK,
    maxAmountRequired: DD_PRICE_ATOMIC,
    amount: DD_PRICE_ATOMIC,
    resource,
    description: `DD on-chain due-diligence report (Arc Testnet) — ${DD_PRICE_HUMAN} per report`,
    mimeType: "application/json",
    payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    asset: DD_ASSET,
    extra: DD_EXTRA,
  };
}

const b64encode = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
export const b64decodePayment = (str) => JSON.parse(Buffer.from(str, "base64").toString("utf8"));

/**
 * The 402 challenge. Carries what the caller is buying AND what they are not — the coverage promise
 * is "an honest manifest", never "a clean bill", and saying so at quote time is what stops a thin
 * report reading as a bait-and-switch after payment.
 */
export function challenge402({ requirements, detail = null }) {
  return {
    statusCode: 402,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": b64encode({ x402Version: 1, accepts: [requirements] }),
    },
    body: JSON.stringify({
      error: detail ? "Payment required" : "Payment required",
      ...(detail ? { reason: detail } : {}),
      accepts: [requirements],
      whatYouAreBuying: {
        artifact: "one signed on-chain due-diligence report about the address and chain you named",
        price: DD_PRICE_HUMAN,
        attestation: "ERC-1271, verifiable against the on-chain owner of ERC-8004 agentId 851891",
        coverage:
          "an HONEST COVERAGE MANIFEST, not a clean bill. A report that could check little still " +
          "settles and is still the product — it tells you exactly what was and was not checked, " +
          "and that manifest is inside the signed payload so it cannot be stripped.",
        notCharged:
          "you are not charged if the engine could not produce an answer about the subject — an " +
          "outage, an unreachable chain, or a refusal returns the report free and leaves your " +
          "authorization unspent.",
      },
      settlement: {
        model: "402 → pay → 202 + handle → retrieve → 200",
        why:
          "Circle Gateway settles in delayed batches, so facilitator acceptance is NOT payment. The " +
          "artifact is withheld until payTo's Gateway balance actually reflects the money.",
        attribution:
          "AGGREGATE-ONLY. Confirmation reads availableBalance(USDC, payTo); it cannot distinguish " +
          "concurrent equal-amount payments. This is a known testnet limitation, not a guarantee of " +
          "per-payment attribution.",
        entitlementNeverExpires: true,
      },
    }),
  };
}

/** Why a settlement attempt was abandoned before anything was broadcast. Closed set. */
export const ABORT_REASON = Object.freeze({
  BASELINE_UNREADABLE: "baseline-unreadable",
  PERSIST_FAILED: "pending-record-not-written",
});

/** Thrown only from paths where NOTHING has been broadcast — the authorization is provably unspent. */
export class SettleAborted extends Error {
  constructor(reason, detail) {
    super(detail);
    this.name = "SettleAborted";
    this.reason = reason;
    this.detail = detail;
  }
}

/** Thrown when the broadcast MAY have happened and we cannot tell. Carries the handle, because the
 *  caller's entitlement survives even though our knowledge does not. */
export class SettleIndeterminate extends Error {
  constructor(detail, handle) {
    super(detail);
    this.name = "SettleIndeterminate";
    this.detail = detail;
    this.handle = handle;
  }
}

/**
 * Build the injected `settle` that shared/x402/settle-gate.mjs will call AT MOST ONCE, and only after
 * it has positively decided the report is chargeable.
 *
 * Everything money-adjacent lives in here, in this order, for the reasons in the header:
 *   1. snapshot the baseline   — must precede any possible movement or the threshold is meaningless
 *   2. persist the pending record with the FROZEN report — before broadcast, never after
 *   3. broadcast
 */
export function makeSettler({ facilitator, rpcCall, store, payload, requirements, now = () => Date.now() }) {
  return async function settle(report) {
    // 1 — baseline. An unreadable baseline is fatal to the entire confirmation test, so we refuse to
    //     take a payment we could never confirm. Nothing has been broadcast at this point.
    const baseline = await readGatewayBalance({ rpcCall, payTo: requirements.payTo });
    if (baseline === null) {
      throw new SettleAborted(
        ABORT_REASON.BASELINE_UNREADABLE,
        "payTo's Gateway balance could not be read, so a settled payment could never be confirmed. " +
          "Refusing to settle rather than take money we cannot prove arrived. Your authorization was " +
          "NOT broadcast and remains unspent.",
      );
    }

    const handle = randomUUID();
    const record = {
      handle,
      payTo: requirements.payTo,
      amountAtomic: requirements.maxAmountRequired,
      baseline: baseline.toString(),
      settledAt: now(),
      broadcast: "attempting",
      served: false,
      // ⭐ THE FROZEN ARTIFACT. Stored before the money moves so retrieve can never serve a report
      // other than the one the charge decision was made about.
      report,
    };

    // 2 — persist BEFORE broadcast. If this fails we have not spent anything, so abort cleanly.
    try {
      await store.setJSON(handle, record);
    } catch (e) {
      throw new SettleAborted(
        ABORT_REASON.PERSIST_FAILED,
        "the pending-payment record could not be written, so a successful payment would have had no " +
          "redeemable handle. Refusing to broadcast. Your authorization was NOT used and remains unspent.",
      );
    }

    // 3 — broadcast. From here on, "we do not know" is a possible answer and must never be reported
    //     as "you were not charged".
    let settlement;
    try {
      settlement = await facilitator.settle(payload, requirements);
    } catch (e) {
      try {
        await store.setJSON(handle, { ...record, broadcast: "indeterminate", broadcastError: String(e?.message ?? e) });
      } catch { /* the record already exists with broadcast:"attempting"; that is enough to retrieve */ }
      throw new SettleIndeterminate(
        "the settlement call failed after the authorization was submitted, so whether it was accepted " +
          "is UNKNOWN. This is not a statement that you were not charged. Poll the handle — if the " +
          "payment lands, the report is yours.",
        handle,
      );
    }

    if (!settlement?.success) {
      try {
        await store.setJSON(handle, { ...record, broadcast: "rejected", settleError: settlement?.errorReason ?? "settle failed" });
      } catch { /* best effort */ }
      return { ok: false, handle, settlement, baseline: baseline.toString() };
    }

    try {
      await store.setJSON(handle, {
        ...record,
        broadcast: "accepted",
        payer: settlement.payer ?? null,
        settleTransaction: settlement.transaction ?? null,
        settleNetwork: settlement.network ?? null,
      });
    } catch { /* the report is already stored; a missing receipt annotation does not block retrieval */ }

    return { ok: true, handle, settlement, baseline: baseline.toString() };
  };
}

/**
 * The paid path, end to end, as a pure function of its injected collaborators.
 *
 * @returns {{statusCode:number, headers:object, body:string}}
 */
export async function runPaidAnalysis({ facilitator, rpcCall, store, payload, requirements, produceReport, resource, now = () => Date.now() }) {
  // ── verify BEFORE analysing. An unverifiable authorization is not a customer, and running the
  //    engine for one would let anyone spend our RPC and signing quota by posting garbage.
  let verification;
  try {
    verification = await facilitator.verify(payload, requirements);
  } catch (e) {
    return challenge402({ requirements, detail: `payment verification could not be completed: ${e?.message ?? e}` });
  }
  if (!verification?.isValid) {
    return challenge402({ requirements, detail: verification?.invalidReason || "invalid payment authorization" });
  }

  const settle = makeSettler({ facilitator, rpcCall, store, payload, requirements, now });

  let outcome;
  try {
    outcome = await runThenSettle({ produceReport, settle });
  } catch (e) {
    // ⭐ The two throw classes mean OPPOSITE things about the caller's money, and collapsing them
    //    would be the whole bug: one is "provably unspent", the other is "we do not know".
    if (e instanceof SettleAborted) {
      return jsonResp(503, {
        settled: false,
        charged: false,
        retryable: true,
        reason: e.reason,
        detail: e.detail,
        payment: "NOT broadcast — your authorization is unspent and safe to retry.",
      });
    }
    if (e instanceof SettleIndeterminate) {
      return jsonResp(502, {
        settled: null,
        charged: null,
        retryable: false,
        reason: "settlement-indeterminate",
        detail: e.detail,
        handle: e.handle,
        retrieve: `${resource}?handle=${e.handle}`,
        entitlement: "PERMANENT — if the payment confirms, this handle serves the report you paid for.",
      });
    }
    throw e;
  }

  // ── the engine did not produce a chargeable answer → the report is free, nothing was broadcast.
  if (!outcome.decision.settle) {
    return jsonResp(200, {
      ...outcome.body,
      price: DD_PRICE_HUMAN,
      note: "This report is free because the engine did not produce an answer about the subject. Charging here would be charging for our own outage.",
    });
  }

  const s = outcome.settlement;
  if (!s?.ok) {
    return {
      statusCode: 402,
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-REQUIRED": b64encode({ x402Version: 1, accepts: [requirements] }),
      },
      body: JSON.stringify({
        error: "Payment settlement failed",
        reason: s?.settlement?.errorReason || "settle failed",
        detail: "The report was produced but the payment was rejected, so nothing is served. Your authorization was not spent.",
        accepts: [requirements],
      }),
    };
  }

  // ⛔ ACCEPTED — NOT PAID. This is the batch-flush window, and it is exactly where a naive
  //    implementation hands over the artifact. Nothing is served here.
  return {
    statusCode: 202,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-RESPONSE": b64encode(s.settlement),
      "X-PAYMENT-HANDLE": s.handle,
    },
    body: JSON.stringify({
      ok: false,
      served: false,
      handle: s.handle,
      retrieve: `${resource}?handle=${s.handle}`,
      decision: { reason: outcome.decision.reason, evidence: outcome.decision.evidence },
      payment: {
        status: "accepted",
        confirmed: false,
        meaning:
          "Circle's facilitator accepted this authorization into a settlement batch. The chain has " +
          "NOT yet witnessed the transfer, so this is not a receipt and the report is not served yet.",
        attribution:
          "AGGREGATE-ONLY — confirmation reads payTo's total Gateway balance and cannot distinguish " +
          "concurrent equal-amount payments. Known testnet limitation.",
      },
      latency:
        "Circle Gateway settles on a periodic batch flush measured at ~15.4 min on Arc Testnet. A " +
        "randomly-timed payment therefore confirms anywhere in (0, ~15.4 min). The flush interval is " +
        "Circle infrastructure and may change without notice.",
      retrieveTimeoutMs: RETRIEVE_TIMEOUT_MS,
      retrieveTimeoutProvenance: RETRIEVE_TIMEOUT_PROVENANCE,
      entitlement: "PERMANENT — the timeout bounds polling advice only. A late-settling batch is still honoured.",
    }),
  };
}

/**
 * RETRIEVE — the ONLY path that hands over the report.
 *
 * Serves if and only if confirmPayment() says payTo's Gateway balance cleared the threshold. Every
 * other outcome — pending, indeterminate, unreadable store, malformed record — returns 202 and no
 * report. The entitlement never expires: the record outlives RETRIEVE_TIMEOUT_MS, so a payment that
 * confirms late is still redeemable by the same handle. That is what makes a provisional timeout safe
 * to be wrong about — it costs a round trip, never a paid-for artifact.
 */
export async function retrievePaid({ handle, store, rpcCall, now = () => Date.now() }) {
  let rec = null;
  try {
    rec = await store.get(handle, { type: "json" });
  } catch {
    // Store unreadable ≠ no such payment. Fail closed toward the caller.
    return json202({
      handle,
      status: CONFIRM_REASON.INDETERMINATE,
      detail: "the pending-payment store could not be read; this is NOT a statement that you did not pay. Retry.",
    });
  }
  if (!rec) {
    return jsonResp(404, { error: "unknown handle", handle });
  }

  const balanceNow = await readGatewayBalance({ rpcCall, payTo: rec.payTo });
  const verdict = confirmPayment({
    balanceNow,
    baseline: rec.baseline,
    amountAtomic: rec.amountAtomic,
    settledAt: rec.settledAt,
    now: now(),
  });

  if (!verdict.confirmed) {
    return json202({
      handle,
      status: verdict.reason,
      detail: verdict.detail,
      evidence: verdict.evidence,
      payment: { status: rec.broadcast === "indeterminate" ? "indeterminate" : "accepted", confirmed: false },
      retrieveTimeoutMs: RETRIEVE_TIMEOUT_MS,
      retrieveTimeoutProvenance: RETRIEVE_TIMEOUT_PROVENANCE,
      entitlement: "PERMANENT — this handle stays redeemable after the timeout.",
    });
  }

  // ⭐ Confirmed. Serve the STORED report — the exact bytes the charge decision was made about, with
  //    the signature that was made over them. Never a fresh analysis.
  if (!rec.report) {
    return json202({
      handle,
      status: CONFIRM_REASON.MALFORMED,
      detail:
        "the payment confirmed but the stored report is missing, so there is nothing to serve. This is " +
        "our failure, not yours — the payment stands and this needs manual reconciliation.",
    });
  }

  try {
    await store.setJSON(handle, { ...rec, served: true, servedAt: now(), confirmedEvidence: verdict.evidence });
  } catch { /* serving matters more than the bookkeeping write; a re-serve is harmless and idempotent */ }

  return jsonResp(200, {
    ok: true,
    served: true,
    payment: {
      status: "confirmed",
      confirmed: true,
      evidence: verdict.evidence,
      attribution:
        "AGGREGATE-ONLY: payTo's total Gateway balance rose by at least the amount since the pre-settle " +
        "snapshot. This does not prove THIS payment specifically landed — concurrent equal-amount " +
        "payments are indistinguishable on this path.",
    },
    report: rec.report,
  });
}

const jsonResp = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const json202 = (body) => jsonResp(202, { ok: false, served: false, ...body });

export const _internals = { SETTLE_REASON, settleDecision, noChargeResponse, ADDRESS_RE };
