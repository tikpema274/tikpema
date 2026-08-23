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
// ⚠️ THE TOKEN IS NOT PLAIN FiatTokenV2, AND AN EARLIER COMMENT HERE SAID IT WAS. Measured
// 2026-08-23 against the deployed proxy (0x3600… -> impl 0xc6ad664a…): the `bytes`-signature
// overloads (0x88b7ab63 / 0xcf092995) EXIST, and the contract BRANCHES on whether `from` is a
// contract — an EOA `from` goes to ECRecover, a contract `from` never does and signature length
// stops mattering. So a smart-account payer (any Circle Agent Wallet SCA) CAN settle here.
// ⚠️ `version()` returns "2" and the revert strings still say "FiatTokenV2:", so neither of those
// discriminates the version — both are traps this file previously fell into.
//
// Settlement uses receiveWithAuthorization (NOT transferWithAuthorization). Both
// live on Arc USDC, but
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

// ═══ ⭐ NORMALISE A SIGNATURE OF ANY LENGTH — the v,r,s split is gone ════════════════════════
//
// 🚨 WHAT THE OLD GUARD DID. It required /^0x[0-9a-fA-F]{130}$/ — EXACTLY 65 bytes — and threw
// otherwise. That is the ECDSA signature shape and nothing else, so it rejected every contract
// (ERC-1271) signature BEFORE the settle call was even reached. Switching the overload without
// this would have changed nothing: the payer would still be turned away one function earlier.
//
// ⭐ ARC USDC BRANCHES ON WHETHER `from` IS A CONTRACT — measured, not assumed. With an EOA `from`
// it ECRecovers (a corrupted signature fails "ECRecover: invalid signature 'v' value"); with a
// contract `from` it never reaches ECRecover and signature LENGTH stops mattering. The `bytes`
// overload is therefore strictly more general: it accepts the same real 65-byte EOA signature the
// v,r,s form does, verified against the token with a real key over the token's real domain.
//
// ⚠️ THE ONE PIECE OF THE OLD FUNCTION THAT MUST SURVIVE IS THE `v` NORMALISATION. The v,r,s path
// bumped a 0/1 recovery id to 27/28 before submitting. The token does NOT do that for us — a raw
// v=0 reverts with "ECRecover: invalid signature 'v' value". Dropping it would have silently broken
// every buyer whose signer emits 0/1, which is a legal encoding. So a 65-byte signature is still
// normalised in place; anything else is opaque and passes through untouched.
export function normalizeSignature(sig) {
  if (typeof sig !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(sig)) {
    throw new Error("signature is not a non-empty 0x-prefixed hex string of whole bytes");
  }
  if (sig.length === 132) {
    // 65 bytes: an ECDSA signature. Normalise 0/1 → 27/28, exactly as before.
    let v = parseInt(sig.slice(130, 132), 16);
    if (v < 27) v += 27;
    return sig.slice(0, 130) + v.toString(16).padStart(2, "0");
  }
  return sig; // ERC-1271 / contract signature — opaque, forwarded verbatim
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
  let sigHex;
  try {
    sigHex = normalizeSignature(signature);
  } catch (e) {
    return jsonRes(400, { error: `bad signature: ${e.message}` });
  }

  try {
    const client = circle();
    const tx = await client.createContractExecutionTransaction({
      walletId: sellerWalletId, // == payTo; makes msg.sender == to
      contractAddress: ASSET,
      // ⭐ THE `bytes` OVERLOAD (0x88b7ab63), not the v,r,s one (0xef55bec6). Same acceptance for
      // EOA payers — proven against the deployed token with a real signature — plus the contract
      // branch an SCA needs. See normalizeSignature above for why the swap is not enough on its own.
      abiFunctionSignature:
        "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)",
      abiParameters: [
        auth.from,
        auth.to,
        String(auth.value),
        String(auth.validAfter),
        String(auth.validBefore),
        auth.nonce,
        sigHex,
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
