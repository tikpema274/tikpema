// _x402-vanilla.mjs — the importable VANILLA x402 BUYER core.
//
// Mirrors _x402.mjs (the Gateway-batched buyer), but for the VANILLA EIP-3009
// scheme: the payment authorization is signed against the USDC TOKEN itself
// (verifyingContract = 0x3600…0000), not the GatewayWallet, and the seller
// settles it directly on-chain. No Gateway balance, no batching — the signed
// authorization pulls real USDC from the payer's token balance buyer→seller in
// one transfer.
//
//   1. Hit the seller with no payment → HTTP 402 + PaymentRequirements
//      (base64 PAYMENT-REQUIRED header and/or body.accepts[0]).
//   2. Guard the challenge, then build an EIP-3009 authorization and sign it
//      against the USDC EIP-712 domain (name="USDC", version="2", chainId=5042002,
//      verifyingContract=USDC) — verified to reproduce the token's on-chain
//      DOMAIN_SEPARATOR bit-for-bit. primaryType follows the seller's advertised
//      extra.eip3009Function (ReceiveWithAuthorization by default) so the signed
//      typehash matches how the seller settles.
//   3. base64-encode the PaymentPayload, retry the seller with it in the
//      X-PAYMENT header.
//   4. Seller settles on-chain and returns 200 + data + X-Payment-Receipt.
//
// WALLET / SIGNING. EIP-3009 verifies ecrecover(sig) == from, so the payer MUST
// be an EOA — an SCA's ERC-1271 signature does not ecrecover. We reuse the same
// Circle DEV-CONTROLLED EOA (DELEGATE_ADDRESS) proven in the Gateway flow: Circle
// custodies the key and signs typed data via its API, yielding a plain ECDSA
// signature that recovers to `from`. from == signer == this EOA, and here `from`
// must actually HOLD the USDC being spent (vanilla pulls the token balance, not a
// Gateway balance).
//
// RETURN SHAPE. payX402Vanilla() returns { status, body } — same convention as
// payX402(): body is { executed, seller, payer, priceUsdc, atomic, payTo,
// sellerBody, receipt } on success, or a blocked/error shape.

import { randomBytes } from "node:crypto";
import { circle } from "./_circle.mjs";
import { readCircleError, httpStatusForCircleFailure } from "./_circle-error.mjs";
import { ARC, CONTRACTS, USDC_DECIMALS, maxSpendUsdc } from "./_arc.mjs";

// Default seller — this repo's own vanilla seller endpoint. Callers override.
export const DEFAULT_SELLER_URL =
  "https://app.tikpema.xyz/.netlify/functions/x402-vanilla-seller";

// What the seller's 402 MUST declare before we sign anything. For vanilla the
// verifyingContract is the USDC token itself (implicit in the EIP-712 domain we
// build), so the guard checks asset + the EIP-712 name/version instead.
const EXPECTED_NETWORK = `eip155:${ARC.chainId}`; // CAIP-2 Arc Testnet
const EXPECTED_ASSET = CONTRACTS.USDC.toLowerCase();

const b64encode = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
const b64decode = (str) => JSON.parse(Buffer.from(str, "base64").toString("utf8"));

// The EIP-3009 authorization fields, shared by both typehashes.
const AUTH_FIELDS = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
];

// Sign EIP-712 typed data with the Circle dev-controlled EOA. Circle's API wants
// a JSON string with EIP712Domain in `types`; it returns a 65-byte ECDSA sig that
// ecrecovers to the EOA address.
async function signWithDelegate(client, { walletId, walletAddress, blockchain, domain, types, primaryType, message }) {
  const typedData = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...types,
    },
    domain,
    primaryType,
    message,
  };
  const data = JSON.stringify(typedData);
  const input = walletId ? { walletId, data } : { walletAddress, blockchain, data };
  const res = await client.signTypedData(input);
  const signature = res?.data?.signature;
  if (!signature) throw new Error("Circle signTypedData returned no signature");
  return signature;
}

// The buyer core: 402 → guard → sign (delegate EOA) → settle. Returns
// { status, body }. `jobContext` is reserved for later budget/research wiring.
export async function payX402Vanilla({ sellerUrl, jobContext } = {}) {
  const resolvedSeller = sellerUrl || DEFAULT_SELLER_URL;

  // Vanilla EIP-3009 requires ecrecover(sig) == from AND `from` to hold the USDC.
  // The delegate EOA is our EOA payer (Circle custodies the key, signs via API).
  const payer = process.env.DELEGATE_ADDRESS;
  const payerWalletId = process.env.DELEGATE_WALLET_ID || null; // optional; else resolve by address
  if (!payer) {
    return { status: 400, body: { error: "DELEGATE_ADDRESS not set — no EOA payer for vanilla x402." } };
  }

  let step = "challenge";
  try {
    // ── 1. Fetch the challenge — expect 402 ──────────────────────────────────
    const challenge = await fetch(resolvedSeller, { method: "GET" });
    if (challenge.status !== 402) {
      const text = await challenge.text();
      return {
        status: 502,
        body: { executed: false, step, error: `Expected 402 from seller, got ${challenge.status}`, sellerBody: text.slice(0, 500) },
      };
    }

    // Prefer the base64 PAYMENT-REQUIRED header; fall back to JSON body.accepts.
    const headerb64 = challenge.headers.get("payment-required");
    let x402Version = 2;
    let accepts;
    if (headerb64) {
      const decoded = b64decode(headerb64);
      x402Version = decoded.x402Version ?? 2;
      accepts = decoded.accepts;
    } else {
      const j = await challenge.json();
      accepts = j.accepts;
    }
    const requirements = Array.isArray(accepts) ? accepts[0] : null;
    if (!requirements) {
      return { status: 502, body: { executed: false, step, error: "402 had no accepts[] requirements" } };
    }

    // ── 2. Spend guard — validate the challenge BEFORE signing ───────────────
    step = "guard";
    if (requirements.scheme !== "exact")
      return { status: 200, body: { executed: false, blocked: `unexpected scheme ${requirements.scheme}` } };
    if (requirements.network !== EXPECTED_NETWORK)
      return { status: 200, body: { executed: false, blocked: `unexpected network ${requirements.network}` } };
    if (String(requirements.asset).toLowerCase() !== EXPECTED_ASSET)
      return { status: 200, body: { executed: false, blocked: `unexpected asset ${requirements.asset}` } };
    if (requirements.extra?.name !== "USDC" || String(requirements.extra?.version) !== "2")
      return { status: 200, body: { executed: false, blocked: `unexpected EIP-712 domain (${requirements.extra?.name}/${requirements.extra?.version})` } };
    if (!requirements.payTo)
      return { status: 200, body: { executed: false, blocked: "requirements missing payTo" } };

    // Price guard: atomic USDC (6dp). Refuse more than AGENT_MAX_SPEND_USDC.
    const atomic = String(requirements.maxAmountRequired ?? requirements.amount ?? "");
    if (!/^\d+$/.test(atomic) || atomic === "0")
      return { status: 200, body: { executed: false, blocked: `invalid amount "${atomic}"` } };
    const priceUsdc = Number(atomic) / 10 ** USDC_DECIMALS;
    const cap = maxSpendUsdc();
    if (priceUsdc > cap)
      return { status: 200, body: { executed: false, blocked: `price ${priceUsdc} USDC exceeds AGENT_MAX_SPEND_USDC (${cap})` } };

    // ── 3. Build + sign the EIP-3009 authorization ───────────────────────────
    step = "sign";
    const now = Math.floor(Date.now() / 1000);
    const timeout = Number(requirements.maxTimeoutSeconds) || 60;
    const authorization = {
      from: payer,
      to: requirements.payTo,
      value: atomic,
      validAfter: "0",
      validBefore: String(now + timeout),
      nonce: "0x" + randomBytes(32).toString("hex"), // unique → replay-proof
    };

    // The seller advertises which EIP-3009 function it settles with; sign the
    // matching typehash (default receiveWithAuthorization → msg.sender==payee).
    const fn = requirements.extra?.eip3009Function || "receiveWithAuthorization";
    const primaryType = fn === "transferWithAuthorization" ? "TransferWithAuthorization" : "ReceiveWithAuthorization";

    const domain = {
      name: requirements.extra.name, // "USDC"
      version: String(requirements.extra.version), // "2"
      chainId: ARC.chainId, // 5042002
      verifyingContract: CONTRACTS.USDC, // the USDC token itself (vanilla)
    };

    const client = circle();
    const signature = await signWithDelegate(client, {
      walletId: payerWalletId,
      walletAddress: payer,
      blockchain: ARC.blockchain,
      domain,
      types: { [primaryType]: AUTH_FIELDS },
      primaryType,
      message: authorization,
    });

    // ── 4. Assemble the PaymentPayload and retry with X-PAYMENT ──────────────
    step = "settle";
    const wirePayload = {
      x402Version: 2,
      scheme: "exact",
      network: EXPECTED_NETWORK,
      payload: { signature, authorization },
      accepted: requirements, // lets the seller re-check asset/price
      resource: requirements.resource,
    };

    const paid = await fetch(resolvedSeller, {
      method: "GET",
      headers: { "X-PAYMENT": b64encode(wirePayload) },
    });

    const paidText = await paid.text();
    let sellerBody;
    try {
      sellerBody = JSON.parse(paidText);
    } catch {
      sellerBody = paidText.slice(0, 1000);
    }

    if (paid.status !== 200) {
      return {
        status: paid.status === 402 ? 402 : 502,
        body: { executed: false, step, error: `Seller did not return 200 (got ${paid.status})`, sellerStatus: paid.status, sellerBody },
      };
    }

    // Settle receipt: the X-Payment-Receipt header (tx hash) and/or the base64
    // PAYMENT-RESPONSE (full receipt object).
    const txHash = paid.headers.get("x-payment-receipt");
    const respb64 = paid.headers.get("payment-response");
    let receipt = null;
    if (respb64) {
      try {
        receipt = b64decode(respb64);
      } catch {
        receipt = { txHash, decodeError: "PAYMENT-RESPONSE not base64 JSON" };
      }
    } else if (txHash) {
      receipt = { txHash };
    }

    return {
      status: 200,
      body: {
        executed: true,
        seller: resolvedSeller,
        payer,
        priceUsdc,
        atomic,
        payTo: requirements.payTo,
        nonce: authorization.nonce,
        sellerBody,
        receipt,
      },
    };
  } catch (e) {
    // ⭐ ONE READER FOR BOTH SDK ERROR SHAPES — v9 raw AxiosError, v10 typed HttpResponseError
    // (which has no `.response`). See netlify/functions/_circle-error.mjs.
    const { status, code, body: detail, message } = readCircleError(e);
    const { httpStatus, statusKnown, retrySafe } = httpStatusForCircleFailure(status);
    console.error(
      `payX402Vanilla failed at step="${step}" status=${statusKnown ? status : "UNKNOWN"} code=${code ?? "?"}:`,
      JSON.stringify(detail) || message
    );
    return {
      status: httpStatus,
      body: {
        executed: false,
        step,
        error: message,
        circleStatus: status,      // null means UNDETERMINED, never a guess
        circleCode: code,
        circleError: detail,
        // ⭐⭐ an undetermined outcome is reported as undetermined — `retrySafe:null` is not `false`
        // and must never be read as `true`.
        statusKnown,
        retrySafe,
      },
    };
  }
}
