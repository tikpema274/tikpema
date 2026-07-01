// _x402.mjs — the importable x402 BUYER core.
//
// Extracted verbatim from x402-pay.mjs (commit 6909b64, proven closed-loop) so
// callers can drive the buyer as a FUNCTION rather than over HTTP. Phase 2's
// research engine imports payX402() directly; x402-pay.mjs is now a thin HTTP
// wrapper around this same core. Pure refactor — no behavior change.
//
// The flow (x402 protocol, Circle Gateway batching scheme):
//   1. Hit the seller with no payment → HTTP 402 + base64 PAYMENT-REQUIRED header
//      (and body.accepts) describing the requirements.
//   2. Build a BatchEvmScheme payload: sign an EIP-3009 TransferWithAuthorization
//      against the GatewayWallet contract (from extra.verifyingContract), NOT the
//      USDC token. Authorizes pulling the price from the payer's Gateway balance.
//   3. base64-encode the PaymentPayload, retry the seller with it in the
//      payment-signature header.
//   4. Seller settles via Circle Gateway and returns 200 + PAYMENT-RESPONSE.
//
// WALLET / SIGNING. The batched Gateway scheme requires ecrecover(sig) == from —
// there is NO depositor/signer split in the batched header, so the payer must be
// an EOA that both holds the Gateway balance and signs. We use a Circle
// DEV-CONTROLLED EOA (DELEGATE_ADDRESS); Circle custodies the key, so there is no
// local private key. We drive the low-level BatchEvmScheme with a custom
// BatchEvmSigner that routes signing to Circle's signTypedData API for that EOA,
// yielding a plain ECDSA signature that recovers to `from`. Unlike the swap plane
// there is no approve/permit fallback: Gateway batching authorizes against an
// ALREADY-DEPOSITED balance (the payer's own, funded via depositFor), so the
// signed authorization IS the spend — no on-chain allowance step.
//
// RETURN SHAPE. payX402() returns { status, body } — `status` is the HTTP status
// the original handler used, `body` is the exact structured result it returned
// ({executed, seller, payer, priceUsdc, atomic, payTo, sellerBody, settleReceipt}
// or the blocked/error shapes). The thin HTTP wrapper does json(status, body) to
// reproduce identical external behavior; a direct caller reads .body.

import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { circle } from "./_circle.mjs";
import { ARC, CONTRACTS, USDC_DECIMALS, maxSpendUsdc } from "./_arc.mjs";
import { GATEWAY } from "./_gateway.mjs";

// The seller this buyer pays — Tikpema's own already-live x402 endpoint. Callers
// override via sellerUrl; defaults to the deployed seller.
export const DEFAULT_SELLER_URL = "https://app.tikpema.xyz/.netlify/functions/x402-quote";

// What we REQUIRE the seller's 402 to declare before we will sign anything. A
// tampered or unexpected challenge fails the guard rather than spending.
const EXPECTED_NETWORK = `eip155:${ARC.chainId}`; // CAIP-2 Arc Testnet
const EXPECTED_ASSET = CONTRACTS.USDC.toLowerCase(); // USDC on Arc
const EXPECTED_VERIFYING_CONTRACT = GATEWAY.WALLET.toLowerCase(); // Gateway Wallet
const BATCH_NAME = "GatewayWalletBatched";

const b64encode = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
const b64decode = (str) => JSON.parse(Buffer.from(str, "base64").toString("utf8"));

// Wrap the Circle dev-controlled wallet as a BatchEvmSigner. The scheme calls
// signTypedData({ domain, types, primaryType, message }) with viem-shaped data
// (no EIP712Domain entry; bigint values). Circle's API wants a JSON string with
// EIP712Domain in types and JSON-serializable values, so we adapt here.
function circleSigner({ client, address, walletId, walletAddress, blockchain }) {
  return {
    address,
    async signTypedData({ domain, types, primaryType, message }) {
      // Reconstruct the EIP712Domain type from whichever domain fields are present.
      const domainType = [];
      if (domain.name != null) domainType.push({ name: "name", type: "string" });
      if (domain.version != null) domainType.push({ name: "version", type: "string" });
      if (domain.chainId != null) domainType.push({ name: "chainId", type: "uint256" });
      if (domain.verifyingContract != null)
        domainType.push({ name: "verifyingContract", type: "address" });

      const typedData = {
        types: { EIP712Domain: domainType, ...types },
        domain,
        primaryType,
        message,
      };
      // JSON can't serialize bigint (value/validAfter/validBefore arrive as bigint).
      const data = JSON.stringify(typedData, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v
      );

      // Prefer walletId (set by agent-init) — avoids the walletAddress+blockchain
      // pairing the SDK requires. Fall back to address+blockchain otherwise.
      const input = walletId
        ? { walletId, data }
        : { walletAddress, blockchain, data };
      const res = await client.signTypedData(input);
      const signature = res?.data?.signature;
      if (!signature) throw new Error("Circle signTypedData returned no signature");
      return signature;
    },
  };
}

// The buyer core: 402 → guard → sign (delegate EOA) → settle. Returns
// { status, body } (see RETURN SHAPE above). `jobContext` is reserved for the
// later budget/research wiring and is intentionally unused in this refactor.
export async function payX402({ sellerUrl, jobContext } = {}) {
  const resolvedSeller = sellerUrl || DEFAULT_SELLER_URL;

  // x402 BUYER wallet. The batched Gateway scheme requires ecrecover(sig) == from
  // (verified empirically) — there is NO depositor/signer split in the batched
  // header, so the payer must be an EOA that BOTH holds the Gateway balance AND
  // signs. We reuse the delegate EOA (DELEGATE_ADDRESS) as that payer; its own
  // Gateway balance is funded via depositFor from the SCA. from == signer == this
  // EOA. (An SCA can't be the payer here: its ERC-1271 sig doesn't ecrecover.)
  const payer = process.env.DELEGATE_ADDRESS;
  if (!payer) {
    return { status: 400, body: { error: "DELEGATE_ADDRESS not set — no EOA payer for x402." } };
  }

  let step = "challenge";
  try {
    // ── 1. Fetch the challenge — expect 402 + PAYMENT-REQUIRED ───────────────
    const challenge = await fetch(resolvedSeller, { method: "POST" });
    if (challenge.status !== 402) {
      const text = await challenge.text();
      return {
        status: 502,
        body: {
          executed: false,
          step,
          error: `Expected 402 from seller, got ${challenge.status}`,
          sellerBody: text.slice(0, 500),
        },
      };
    }

    // Prefer the base64 PAYMENT-REQUIRED header; fall back to the JSON body.accepts.
    const headerb64 = challenge.headers.get("payment-required");
    let x402Version = 1;
    let accepts;
    if (headerb64) {
      const decoded = b64decode(headerb64);
      x402Version = decoded.x402Version ?? 1;
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
    if (requirements.extra?.name !== BATCH_NAME)
      return { status: 200, body: { executed: false, blocked: `not a Gateway-batched option (${requirements.extra?.name})` } };
    if (String(requirements.extra?.verifyingContract).toLowerCase() !== EXPECTED_VERIFYING_CONTRACT)
      return { status: 200, body: { executed: false, blocked: "unexpected verifyingContract (not the Gateway Wallet)" } };
    if (!requirements.payTo)
      return { status: 200, body: { executed: false, blocked: "requirements missing payTo" } };

    // Price guard: maxAmountRequired is atomic USDC (6dp). Refuse to authorize
    // more than AGENT_MAX_SPEND_USDC. Fail closed on a non-integer amount.
    const atomic = String(requirements.maxAmountRequired ?? "");
    if (!/^\d+$/.test(atomic) || atomic === "0")
      return { status: 200, body: { executed: false, blocked: `invalid maxAmountRequired "${atomic}"` } };
    const priceUsdc = Number(atomic) / 10 ** USDC_DECIMALS;
    const cap = maxSpendUsdc();
    if (priceUsdc > cap)
      return { status: 200, body: { executed: false, blocked: `price ${priceUsdc} USDC exceeds AGENT_MAX_SPEND_USDC (${cap})` } };

    // ── 3. Sign the Gateway-batched payment ──────────────────────────────────
    step = "sign";
    const client = circle();
    const signer = circleSigner({
      client,
      address: payer,             // from = payer EOA → sources the payer's OWN Gateway balance
      walletId: null,             // resolve the EOA wallet by address + blockchain
      walletAddress: payer,       // Circle signs with the SAME payer EOA → ecrecover(sig) == from
      blockchain: ARC.blockchain,
    });
    const scheme = new BatchEvmScheme(signer);

    // The lib reads `amount` (not the x402 `maxAmountRequired`), so map it across.
    const schemeRequirements = {
      scheme: requirements.scheme,
      network: requirements.network,
      asset: requirements.asset,
      amount: atomic,
      payTo: requirements.payTo,
      maxTimeoutSeconds: requirements.maxTimeoutSeconds,
      extra: requirements.extra,
    };
    const paymentPayload = await scheme.createPaymentPayload(x402Version, schemeRequirements);

    // The Circle Gateway verify/settle API expects the FULL x402 payload, not just
    // { x402Version, payload }. Per the lib's high-level pay(), the base64 header
    // must also carry `resource` (the paid URL) and `accepted` (the chosen
    // requirements entry). The lib/API key off `amount` (x402 v2), while the
    // seller publishes the v1 `maxAmountRequired`, so we mirror `amount` into the
    // accepted entry the API reads.
    const wirePayload = {
      ...paymentPayload,
      x402Version: 2,
      resource: {
        url: requirements.resource,
        description: requirements.description,
        mimeType: requirements.mimeType,
      },
      accepted: { ...requirements, amount: atomic },
    };

    // ── 4. Retry the seller with the signed payment ──────────────────────────
    step = "settle";
    const paid = await fetch(resolvedSeller, {
      method: "POST",
      headers: { "payment-signature": b64encode(wirePayload) },
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
        body: {
          executed: false,
          step,
          error: `Seller did not return 200 (got ${paid.status})`,
          sellerStatus: paid.status,
          sellerBody,
        },
      };
    }

    // Decode the settle receipt from PAYMENT-RESPONSE.
    const respb64 = paid.headers.get("payment-response");
    let settleReceipt = null;
    if (respb64) {
      try {
        settleReceipt = b64decode(respb64);
      } catch {
        settleReceipt = { decodeError: "PAYMENT-RESPONSE not base64 JSON" };
      }
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
        sellerBody,
        settleReceipt,
      },
    };
  } catch (e) {
    // Circle SDK throws axios errors; the useful detail lives in e.response.data.
    const status = e.response?.status;
    const detail = e.response?.data ?? null;
    console.error(
      `payX402 failed at step="${step}" status=${status ?? "?"}:`,
      JSON.stringify(detail) || e.message
    );
    return {
      status: status && status < 500 ? 400 : 500,
      body: {
        executed: false,
        step,
        error: e.message,
        circleStatus: status,
        circleError: detail,
      },
    };
  }
}
