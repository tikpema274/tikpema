// x402-vanilla-seller.mjs — a VANILLA x402 "exact" seller on Arc Testnet.
//
// "Vanilla" = the buyer signs a plain EIP-3009 authorization against the USDC
// TOKEN itself (verifyingContract = 0x3600…0000), and this seller settles it by
// submitting the authorization ON-CHAIN to the USDC contract. There is NO
// facilitator and NO Gateway batching here — the seller IS the facilitator, and
// funds move in one direct on-chain transfer buyer→seller. Contrast with
// x402-quote.mjs, which uses Circle's Gateway-batched scheme (verifyingContract =
// the GatewayWallet, settlement via BatchFacilitatorClient).
//
// Settlement uses receiveWithAuthorization (NOT transferWithAuthorization). Both
// live on Arc USDC (a Circle FiatTokenV2 — verified on-chain), but
// receiveWithAuthorization enforces `msg.sender == to`, so ONLY the payee can
// submit it. That means a mempool observer can't front-run/grief by relaying the
// buyer's signed auth; the seller's own wallet is the only settler. The tradeoff:
// the buyer must sign the ReceiveWithAuthorization typehash (same fields as
// TransferWithAuthorization, different EIP-712 primaryType), so seller and buyer
// must agree on which one. We advertise it via extra.eip3009Function.
//
// The flow (x402 protocol, exact scheme, EIP-3009 direct settlement):
//   1. Request with no X-PAYMENT header → HTTP 402 + spec-compliant
//      PaymentRequirements (body.accepts[0]).
//   2. Buyer signs an EIP-3009 authorization (offchain, zero gas) and retries
//      with a base64 PaymentPayload in the X-PAYMENT header.
//   3. We guard the payload (to==us, value==price, asset==Arc USDC, network,
//      not expired), then submit receiveWithAuthorization to USDC from the
//      seller's own dev-controlled wallet (msg.sender == payTo). Gas is paid in
//      USDC (Arc's native gas token).
//   4. On the settle tx confirming, return 200 + the paid data + an
//      X-Payment-Receipt header (settle tx hash) and a base64 PAYMENT-RESPONSE.
//
// Synchronous (NOT -background): the buyer holds the connection across the
// 402 → pay → 200 round trip, so settlement finishes inline.

import { circle, waitForTx, TxPendingError } from "./_circle.mjs";

// --- Arc Testnet / vanilla EIP-3009 constants (verified on-chain) ------------
const NETWORK = "eip155:5042002"; // Arc Testnet, CAIP-2
const ASSET = "0x3600000000000000000000000000000000000000"; // USDC on Arc (FiatTokenV2)
const BLOCKCHAIN = "ARC-TESTNET"; // Circle SDK chain id
const PRICE_ATOMIC = "10000"; // $0.01 USDC (6-decimal atomic units)
const MAX_TIMEOUT_SECONDS = 60; // authorization validity window we advertise

// extra.name/version are the EIP-712 domain the buyer signs against — they MUST
// match the USDC token's DOMAIN_SEPARATOR (name="USDC", version="2"), which we
// verified reproduces the on-chain separator bit-for-bit. eip3009Function tells
// the buyer which typehash to sign so it matches how we settle.
const EXTRA = {
  assetTransferMethod: "eip3009",
  name: "USDC",
  version: "2",
  eip3009Function: "receiveWithAuthorization",
};

const b64encode = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
const b64decode = (str) => JSON.parse(Buffer.from(str, "base64").toString("utf8"));

// Build the x402 "exact" PaymentRequirements. `resource` is this endpoint's URL
// as the buyer sees it, so the challenge is bound to what was requested.
function paymentRequirements(resource, payTo) {
  return {
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: PRICE_ATOMIC, // x402 v1 field name
    amount: PRICE_ATOMIC, // x402 v2 field name (mirror for compatibility)
    resource,
    description: "Vanilla x402 EIP-3009 quote (Arc Testnet, direct on-chain settlement)",
    mimeType: "application/json",
    payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    asset: ASSET,
    extra: EXTRA,
  };
}

// The paid payload — a real keyless upstream (open-meteo current weather) so this
// is a genuine "pay for data" proof, with a canned fallback if the fetch fails.
async function paidData() {
  const asOf = new Date().toISOString();
  try {
    const r = await fetch(
      "https://api.open-meteo.com/v1/forecast?latitude=51.5072&longitude=-0.1276&current=temperature_2m,wind_speed_10m",
      { signal: AbortSignal.timeout(8000) }
    );
    if (r.ok) {
      const j = await r.json();
      return {
        source: "open-meteo.com current weather (London)",
        asOf,
        current: j.current,
        units: j.current_units,
      };
    }
  } catch {
    /* fall through to canned */
  }
  return {
    source: "canned fallback (upstream unreachable)",
    asOf,
    current: { temperature_2m: 15.0, wind_speed_10m: 10.0 },
    units: { temperature_2m: "°C", wind_speed_10m: "km/h" },
  };
}

// Split a 65-byte ECDSA signature (0x + 130 hex) into the v,r,s the FiatTokenV2
// receiveWithAuthorization(...,uint8 v,bytes32 r,bytes32 s) overload expects.
function splitSignature(sig) {
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) {
    throw new Error("signature is not a 65-byte hex string");
  }
  const r = "0x" + sig.slice(2, 66);
  const s = "0x" + sig.slice(66, 130);
  let v = parseInt(sig.slice(130, 132), 16);
  if (v < 27) v += 27; // normalize 0/1 → 27/28
  return { v, r, s };
}

const jsonRes = (statusCode, body, extraHeaders = {}) => ({
  statusCode,
  headers: { "Content-Type": "application/json", ...extraHeaders },
  body: JSON.stringify(body),
});

// A 402 that also republishes the requirements, so a buyer that failed a guard
// can re-read what's expected.
const challenge402 = (requirements, error, reason) =>
  jsonRes(
    402,
    { error, ...(reason ? { reason } : {}), accepts: [requirements] },
    { "PAYMENT-REQUIRED": b64encode({ x402Version: 2, accepts: [requirements] }) }
  );

export async function handler(event) {
  // The settling wallet MUST be the payee: receiveWithAuthorization requires
  // msg.sender == to, so payTo and the wallet we submit from are the same EOA.
  const payTo = process.env.VANILLA_SELLER_ADDRESS;
  const sellerWalletId = process.env.VANILLA_SELLER_WALLET_ID;
  if (!payTo || !sellerWalletId) {
    return jsonRes(500, {
      error: "Missing VANILLA_SELLER_ADDRESS / VANILLA_SELLER_WALLET_ID (server env)",
    });
  }

  const headers = event.headers || {}; // Netlify lowercases header names
  const paymentHeader = headers["x-payment"];

  const proto = headers["x-forwarded-proto"] || "https";
  const host = headers["host"] || "";
  const resource = `${proto}://${host}${event.path || "/.netlify/functions/x402-vanilla-seller"}`;
  const requirements = paymentRequirements(resource, payTo);

  // ── No payment yet → 402 challenge ─────────────────────────────────────────
  if (!paymentHeader) {
    return jsonRes(
      402,
      { error: "Payment required", accepts: [requirements] },
      { "PAYMENT-REQUIRED": b64encode({ x402Version: 2, accepts: [requirements] }) }
    );
  }

  // ── Payment present → decode ───────────────────────────────────────────────
  let payload;
  try {
    payload = b64decode(paymentHeader);
  } catch {
    return jsonRes(400, { error: "Malformed X-PAYMENT header (expected base64 JSON)" });
  }

  const auth = payload?.payload?.authorization;
  const signature = payload?.payload?.signature;
  if (!auth || !signature) {
    return jsonRes(400, { error: "X-PAYMENT payload missing payload.authorization or payload.signature" });
  }

  // ── Guards — validate BEFORE spending gas to settle ────────────────────────
  if (payload.scheme !== "exact")
    return challenge402(requirements, "unexpected scheme", payload.scheme);
  if (payload.network !== NETWORK)
    return challenge402(requirements, "unexpected network", payload.network);
  // asset (when the buyer echoes the accepted requirements) must be Arc USDC
  const acceptedAsset = payload.accepted?.asset;
  if (acceptedAsset && String(acceptedAsset).toLowerCase() !== ASSET.toLowerCase())
    return challenge402(requirements, "unexpected asset", acceptedAsset);
  if (String(auth.to).toLowerCase() !== payTo.toLowerCase())
    return challenge402(requirements, "authorization 'to' is not the seller (payTo)", auth.to);
  // value must equal the price exactly (compare as integers, not strings)
  let valueOk = false;
  try {
    valueOk = BigInt(auth.value) === BigInt(PRICE_ATOMIC);
  } catch {
    /* non-integer value → reject below */
  }
  if (!valueOk)
    return challenge402(requirements, `authorization value != price (${PRICE_ATOMIC})`, String(auth.value));
  if (!auth.from)
    return challenge402(requirements, "authorization missing 'from'");
  // time window: not-yet-valid or expired auths would revert on-chain — reject
  // early with a clear message instead of burning gas on a guaranteed revert.
  const now = Math.floor(Date.now() / 1000);
  if (Number(auth.validAfter) > now)
    return challenge402(requirements, "authorization not yet valid (validAfter in future)", String(auth.validAfter));
  if (Number(auth.validBefore) <= now)
    return challenge402(requirements, "authorization expired (validBefore in past)", String(auth.validBefore));

  // ── Settle on-chain: receiveWithAuthorization on USDC, from the seller EOA ──
  let vrs;
  try {
    vrs = splitSignature(signature);
  } catch (e) {
    return jsonRes(400, { error: `bad signature: ${e.message}` });
  }

  try {
    const client = circle();
    const tx = await client.createContractExecutionTransaction({
      walletId: sellerWalletId, // == payTo; makes msg.sender == to
      contractAddress: ASSET,
      abiFunctionSignature:
        "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
      abiParameters: [
        auth.from,
        auth.to,
        String(auth.value),
        String(auth.validAfter),
        String(auth.validBefore),
        auth.nonce,
        vrs.v,
        vrs.r,
        vrs.s,
      ],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } }, // Arc needs >= 20 Gwei; MEDIUM clears it
    });
    const txHash = await waitForTx(client, tx.data?.id);

    // Paid & settled. Serve the data + the settle receipt.
    const receipt = {
      success: true,
      network: NETWORK,
      asset: ASSET,
      payer: auth.from,
      payTo: auth.to,
      value: String(auth.value),
      txHash,
      explorer: `https://testnet.arcscan.app/tx/${txHash}`,
    };
    return jsonRes(
      200,
      { ok: true, ts: Date.now(), data: await paidData(), receipt },
      {
        "X-Payment-Receipt": txHash,
        "PAYMENT-RESPONSE": b64encode(receipt),
      }
    );
  } catch (e) {
    // A still-pending tx is slow, not failed.
    if (e instanceof TxPendingError) {
      return jsonRes(202, { error: e.message, txId: e.txId, pending: true });
    }
    // Circle SDK throws axios errors; the on-chain revert reason (e.g.
    // "FiatTokenV2: authorization is used or canceled" on replay, or "invalid
    // signature") lives in e.response.data. Surface it so the buyer sees why.
    const status = e.response?.status;
    const detail = e.response?.data ?? null;
    console.error(
      `vanilla-seller settle failed status=${status ?? "?"}:`,
      JSON.stringify(detail) || e.message
    );
    return challenge402(
      requirements,
      "settlement failed on-chain",
      detail ? JSON.stringify(detail) : e.message
    );
  }
}
