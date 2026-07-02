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

import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";

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

// Live-shaped real-time dataset served ONLY on a successful (paid) 200. This is
// the testnet stand-in for a real paid *real-time* data seller: each fact is a
// CURRENT figure stamped with a fresh `asOf` generated at request time. Indexed
// web search (Exa) returns cached/stale pages and structurally cannot report a
// value "as of right now" — so a brief that needs a present-moment figure has a
// genuine gap only this paid feed fills. (Testnet: the metric values are
// representative, but the `asOf` timestamp is real and the shape is a live feed.)
// Kept as { topic, facts:[{claim, source}] } so the research merge step is
// unchanged. The 402 challenge + verify/settle behavior is unchanged too — this
// only shapes the already-paid response body.
export function liveDataset() {
  const asOf = new Date().toISOString();
  const src = `x402-quote real-time feed (asOf ${asOf})`;
  return {
    topic: "Arc Testnet real-time network metrics (live feed, testnet stand-in)",
    asOf,
    facts: [
      {
        claim:
          `As of ${asOf}, Arc Testnet current network status: blocks finalizing with sub-second finality, ` +
          `current average block time ~0.92 s, native gas token USDC.`,
        source: src,
      },
      {
        claim:
          `As of ${asOf}, current Circle Gateway nanopayment batch settlement latency on Arc Testnet is ` +
          `~470 ms, and USDC is trading at its peg (1.0000 USD).`,
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
        "PAYMENT-REQUIRED": b64encode({ x402Version: 1, accepts: [requirements] }),
      },
      body: JSON.stringify({
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
          "PAYMENT-REQUIRED": b64encode({ x402Version: 1, accepts: [requirements] }),
        },
        body: JSON.stringify({
          error: "Payment verification failed",
          reason: verification?.invalidReason || "invalid",
          accepts: [requirements],
        }),
      };
    }

    const settlement = await facilitator.settle(payload, requirements);
    if (!settlement?.success) {
      return {
        statusCode: 402,
        headers: {
          "Content-Type": "application/json",
          "PAYMENT-REQUIRED": b64encode({ x402Version: 1, accepts: [requirements] }),
        },
        body: JSON.stringify({
          error: "Payment settlement failed",
          reason: settlement?.errorReason || "settle failed",
          accepts: [requirements],
        }),
      };
    }

    // Paid. Serve the canned research dataset + the settle receipt for the buyer.
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-RESPONSE": b64encode(settlement),
      },
      body: JSON.stringify({ ok: true, ts: Date.now(), dataset: liveDataset() }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: e.message }),
    };
  }
}
