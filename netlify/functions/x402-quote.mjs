// x402-quote.mjs — an x402-protected paid endpoint for Arc Testnet.
//
// Ported from the `withGateway` middleware in circlefin/arc-nanopayments
// (lib/x402.ts) — that's a Next.js route wrapper; here it's our classic Netlify
// event → { statusCode, headers, body } handler.
//
// The flow follows the x402 protocol with Circle's Gateway batching scheme:
//   1. A request with no payment header gets HTTP 402 + a base64 PAYMENT-REQUIRED
//      header describing what to pay (the requirements object below).
//   2. The client signs a Gateway-batched payment and retries, putting a
//      base64-encoded PaymentPayload in the payment-signature header.
//   3. We base64-decode it, verify() then settle() it via the BatchFacilitatorClient
//      (Circle's Gateway facilitator), and on success return 200 with the paid
//      content plus a base64 PAYMENT-RESPONSE header carrying the settle receipt.
//
// Synchronous function (NOT -background): the buyer holds the connection open
// across the 402 → pay → 200 round trip, so settlement must finish inline.

// ═══ ⭐ THIS ENDPOINT SERVES ON CONFIRMATION, NOT ON ACCEPTANCE ═══════════════════════════════
// It used to return 200 + the dataset the moment facilitator.settle() reported success. A real
// settlement was then MEASURED (scripts/dd/probe-settlement.mjs): `success:true` came back while the
// money sat untouched for ~3 MINUTES. So the old flow served the artifact roughly three minutes
// before the payment existed — the phantom charge in mirror image, in production.
//
// The flow is therefore no longer a single round trip. It CANNOT be: this is a synchronous function
// under a 10s ceiling and confirmation takes minutes, so "wait inline" is not available at any price.
//   402 → pay → 202 + handle → retrieve(handle) → 200 once the Gateway balance reflects the payment.
//
// ⚠️ The exposure here is low — the payload is a canned testnet stand-in — and the fix is applied
// ANYWAY, deliberately. Leaving one documented "serve-on-acceptance is fine here" endpoint means the
// next person to make it serve something real inherits a serve-before-confirm design.

import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { randomUUID } from "node:crypto";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { readGatewayBalance, confirmPayment, CONFIRM_REASON, RETRIEVE_TIMEOUT_MS, RETRIEVE_TIMEOUT_PROVENANCE } from "./_x402-confirm.mjs";
import { X402_VERSION } from "../../shared/x402/version.mjs";

const PENDING_STORE = "x402-quote-pending";
const ARC_RPC = "https://rpc.testnet.arc.network";

/** Transport for the Gateway balance read. Injected into _x402-confirm so that module stays testable. */
const rpcCall = async ({ method, params }) => {
  const r = await fetch(ARC_RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
};

// --- Arc Testnet / Gateway batching constants (do not change) ---------------
const NETWORK = "eip155:5042002"; // Arc Testnet, CAIP-2
const ASSET = "0x3600000000000000000000000000000000000000"; // USDC on Arc
const VERIFYING_CONTRACT = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9"; // Gateway Wallet
const EXTRA = {
  name: "GatewayWalletBatched",
  version: "1",
  verifyingContract: VERIFYING_CONTRACT,
};

// Price: $0.001 USDC, in 6-decimal atomic units → 1000.
const PRICE_ATOMIC = "1000";

// SYNTHETIC demo payload served ONLY on a confirmed-paid 200. This endpoint is a self-loop x402
// SELLER used to exercise the payment mechanics (402 → sign → settle → confirm → serve); it is NOT a
// data product. The real paid data path in production is QuickNode (DATA_SELLER_URL); nothing in prod
// consumes this.
//
// ═══ 🚨 WHY THE LABELS BELOW ARE WORDED SO BLUNTLY ═══════════════════════════════════════════
// These values used to be phrased as present-tense measurements — "As of <now>, … ~0.92 s",
// "settlement latency … ~470 ms" — carrying `source: "x402-quote real-time feed"`. That mislabel
// escaped and did real damage: the fabricated ~470 ms figure was quoted back as EVIDENCE in a design
// discussion about Gateway settlement timing, while the probe was measuring the true value at
// anywhere from 42 SECONDS to 14.5 MINUTES (scripts/dd/probe-settlement-batch.mjs). Fiction labelled
// as fact does not stay contained — it gets cited.
//
// ⭐ AND THE HONEST LABEL WAS THE ONE BEING DISCARDED. `_research.mjs`'s extractFacts resolves
// `source: String(f.source ?? src)` — a fact's OWN source wins, and the honest fallback
// ("x402-quote (testnet stand-in)") applies only when a fact carries none. So the qualifier lived
// exactly where it was dropped and the unqualified "real-time feed" was what propagated into
// citations. The fix therefore targets the PER-FACT `source` string, not the fallback.
//
// The shape { topic, facts:[{claim, source}] } is unchanged so the merge step still works, and the
// 402 challenge is untouched (it never claimed real-time). No value here is measured.
export function liveDataset() {
  const generatedAt = new Date().toISOString();
  // ⭐ THIS is the string that propagates into citations. It must be self-evidently synthetic.
  const src = "x402-quote (Arc testnet SYNTHETIC DEMO — not a live feed, values not measured)";
  return {
    topic: "SYNTHETIC demo payload — illustrative Arc Testnet figures, NOT live measurements",
    synthetic: true,
    notMeasured: true,
    generatedAt,
    asOf: null, // deliberately null: an `asOf` on unmeasured values invites reading them as current
    facts: [
      {
        claim:
          "SYNTHETIC EXAMPLE, not a measurement: Arc Testnet is described as finalising blocks with " +
          "sub-second finality and using USDC as the native gas token. The illustrative block-time " +
          "figure that used to appear here has been removed rather than restated, because a precise " +
          "number reads as measured however it is labelled.",
        source: src,
      },
      {
        claim:
          "SYNTHETIC EXAMPLE, not a measurement: this payload previously asserted a Circle Gateway " +
          "batch settlement latency of ~470 ms. That number was invented and is WRONG — real " +
          "settlements measured on Arc Testnet ranged from ~42 s to ~14.5 min. Do not cite any " +
          "latency figure from this endpoint; measure it with scripts/dd/probe-settlement-batch.mjs.",
        source: src,
      },
    ],
  };
}

// Gateway batched settlement runs on a delay, so the payment authorization must
// stay valid for ~7 days. GatewayEvmScheme uses 604900s (7 days + buffer).
const MAX_TIMEOUT_SECONDS = 604900;

const b64encode = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
const b64decode = (str) => JSON.parse(Buffer.from(str, "base64").toString("utf8"));

// Build the x402 PaymentRequirements the buyer needs to satisfy. `resource` is
// the canonical URL of this endpoint as the buyer sees it.
function paymentRequirements(resource) {
  return {
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: PRICE_ATOMIC,
    amount: PRICE_ATOMIC,
    resource,
    description: "x402 quote (Arc Testnet, Gateway nanopayment)",
    mimeType: "application/json",
    payTo: process.env.SELLER_ADDRESS,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    asset: ASSET,
    extra: EXTRA,
  };
}

export async function handler(event) {
  if (event?.blobs) connectBlobs(event);

  // ── RETRIEVE: the second half of the round trip ────────────────────────────────────────────
  // A handle is only ever redeemable for the artifact once payTo's Gateway balance actually
  // reflects the payment. Until then this returns 202 — never the dataset.
  {
    const q = event.queryStringParameters || {};
    const handle = q.handle || (event.headers || {})["x-payment-handle"];
    if (handle) return await retrieve(handle);
  }

  if (!process.env.SELLER_ADDRESS) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing SELLER_ADDRESS (server env)" }),
    };
  }

  // Netlify lowercases incoming header names.
  const headers = event.headers || {};
  const paymentHeader = headers["payment-signature"];

  // The canonical resource URL — used in the requirements and echoed back so the
  // signed payment is bound to this exact endpoint.
  const proto = headers["x-forwarded-proto"] || "https";
  const host = headers["host"] || "";
  const resource = `${proto}://${host}${event.path || "/.netlify/functions/x402-quote"}`;

  const requirements = paymentRequirements(resource);

  // --- No payment yet → challenge with 402 + PAYMENT-REQUIRED ---------------
  if (!paymentHeader) {
    return {
      statusCode: 402,
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-REQUIRED": b64encode({ x402Version: X402_VERSION, accepts: [requirements] }),
      },
      body: JSON.stringify({
        // Mirrors the header for body-reading clients; see shared/x402/version.mjs.
        x402Version: X402_VERSION,
        error: "Payment required",
        accepts: [requirements],
      }),
    };
  }

  // --- Payment present → verify, settle, then serve ------------------------
  let payload;
  try {
    payload = b64decode(paymentHeader);
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Malformed payment-signature header (expected base64 JSON)" }),
    };
  }

  const facilitator = new BatchFacilitatorClient();

  try {
    const verification = await facilitator.verify(payload, requirements);
    if (!verification?.isValid) {
      return {
        statusCode: 402,
        headers: {
          "Content-Type": "application/json",
          "PAYMENT-REQUIRED": b64encode({ x402Version: X402_VERSION, accepts: [requirements] }),
        },
        body: JSON.stringify({
          x402Version: X402_VERSION,
          error: "Payment verification failed",
          reason: verification?.invalidReason || "invalid",
          accepts: [requirements],
        }),
      };
    }

    // ⭐ SNAPSHOT BEFORE SETTLING. The confirmation test is a threshold against this baseline, so it
    // must be read before the money can possibly move. An unreadable baseline is fatal to the whole
    // test — refuse rather than settle a payment we could never confirm.
    const baseline = await readGatewayBalance({ rpcCall, payTo: requirements.payTo });
    if (baseline === null) {
      return {
        statusCode: 503,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Cannot establish a payment baseline",
          detail: "payTo's Gateway balance could not be read, so a settled payment could never be confirmed. Refusing to settle rather than take a payment we cannot verify landed.",
        }),
      };
    }

    const settlement = await facilitator.settle(payload, requirements);
    if (!settlement?.success) {
      return {
        statusCode: 402,
        headers: {
          "Content-Type": "application/json",
          "PAYMENT-REQUIRED": b64encode({ x402Version: X402_VERSION, accepts: [requirements] }),
        },
        body: JSON.stringify({
          x402Version: X402_VERSION,
          error: "Payment settlement failed",
          reason: settlement?.errorReason || "settle failed",
          accepts: [requirements],
        }),
      };
    }

    // ⛔ ACCEPTED — NOT PAID. This is the ~3-minute window the probe measured, and it is exactly
    // where the artifact used to be handed over. Nothing is served here. The payment is recorded
    // against its baseline and the caller gets a handle to redeem once the chain agrees.
    const handle = randomUUID();
    await getStore(PENDING_STORE).setJSON(handle, {
      handle,
      payTo: requirements.payTo,
      amountAtomic: requirements.maxAmountRequired,
      baseline: baseline.toString(),
      settledAt: Date.now(),
      payer: settlement.payer ?? null,
      settleTransaction: settlement.transaction ?? null,
      settleNetwork: settlement.network ?? null,
      served: false,
    });

    return {
      statusCode: 202,
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-RESPONSE": b64encode(settlement),
        "X-PAYMENT-HANDLE": handle,
      },
      body: JSON.stringify({
        ok: false,
        served: false,
        handle,
        retrieve: `${resource}?handle=${handle}`,
        payment: {
          status: "accepted",
          confirmed: false,
          meaning:
            "Circle's facilitator accepted this authorization into a settlement batch. The chain has NOT yet witnessed the transfer, so this is not a receipt and the artifact is not served yet. Measured settlement latency was ~3 minutes (n=1).",
        },
        retrieveTimeoutMs: RETRIEVE_TIMEOUT_MS,
        retrieveTimeoutProvenance: RETRIEVE_TIMEOUT_PROVENANCE,
      }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: e.message }),
    };
  }
}

// ═══ RETRIEVE — the ONLY path that can hand over the artifact ═════════════════════════════════
// It serves if and only if confirmPayment() says the Gateway balance cleared the threshold. Every
// other outcome — pending, indeterminate, unreadable, malformed — returns 202 and no data.
//
// ⭐ THE ENTITLEMENT NEVER EXPIRES. The pending record outlives RETRIEVE_TIMEOUT_MS, so a payment
// that confirms late is still redeemable by the same handle. The timeout only stops recommending
// that the caller keep polling. That is what makes a provisional (n=1) number safe: getting it wrong
// costs a round trip, never a paid-for artifact.
async function retrieve(handle) {
  const store = getStore(PENDING_STORE);
  let rec = null;
  try {
    rec = await store.get(handle, { type: "json" });
  } catch {
    // Store unreadable ≠ no such payment. Fail closed toward the caller: tell them to retry.
    return json202({ handle, status: CONFIRM_REASON.INDETERMINATE,
      detail: "the pending-payment store could not be read; this is not a statement that you did not pay. Retry." });
  }
  if (!rec) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "unknown handle", handle }),
    };
  }

  const balanceNow = await readGatewayBalance({ rpcCall, payTo: rec.payTo });
  const verdict = confirmPayment({
    balanceNow,
    baseline: rec.baseline,
    amountAtomic: rec.amountAtomic,
    settledAt: rec.settledAt,
    now: Date.now(),
  });

  if (!verdict.confirmed) {
    return json202({
      handle,
      status: verdict.reason,
      detail: verdict.detail,
      evidence: verdict.evidence,
      payment: { status: "accepted", confirmed: false },
      retrieveTimeoutMs: RETRIEVE_TIMEOUT_MS,
      retrieveTimeoutProvenance: RETRIEVE_TIMEOUT_PROVENANCE,
      entitlement: "PERMANENT — this handle stays redeemable after the timeout. A late-settling batch is still honoured.",
    });
  }

  // Confirmed on-chain. Now, and only now, the artifact.
  try {
    await store.setJSON(handle, { ...rec, served: true, servedAt: Date.now(), confirmedEvidence: verdict.evidence });
  } catch { /* serving matters more than the bookkeeping write; a re-serve is harmless */ }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ok: true,
      served: true,
      ts: Date.now(),
      payment: { status: "confirmed", confirmed: true, evidence: verdict.evidence },
      dataset: liveDataset(),
    }),
  };
}

const json202 = (body) => ({
  statusCode: 202,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ok: false, served: false, ...body }),
});
