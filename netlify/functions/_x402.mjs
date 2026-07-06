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

// Fetch the seller's x402 challenge (step 1 only): POST for the 402 and decode the
// advertised requirements + x402Version. Separated so a caller (maybeBuyData) can
// gate the SELLER'S advertised price via canSpend BEFORE signing, then thread this
// same challenge into payX402 — one fetch, so the price the gate saw is the price
// signed. Returns { ok:true, requirements, x402Version, resource, extensions } or, on a
// bad challenge, { ok:false, status, body } using the same shapes payX402 returned inline.
export async function fetchX402Requirements({ sellerUrl } = {}) {
  const resolvedSeller = sellerUrl || DEFAULT_SELLER_URL;
  const challenge = await fetch(resolvedSeller, { method: "POST" });
  if (challenge.status !== 402) {
    const text = await challenge.text();
    return { ok: false, status: 502, body: {
      executed: false, step: "challenge",
      error: `Expected 402 from seller, got ${challenge.status}`,
      sellerBody: text.slice(0, 500),
    } };
  }
  // Prefer the base64 PAYMENT-REQUIRED header; fall back to the JSON body.accepts.
  const headerb64 = challenge.headers.get("payment-required");
  let x402Version = 1;
  let accepts;
  let resource; // challenge's TOP-LEVEL resource {url, description, mimeType}. Multi-chain
                // sellers (QuickNode) put it here, NOT per-entry; the signed payment must
                // carry it so the facilitator can bind the payment to the resource URL.
  let extensions; // challenge's TOP-LEVEL extensions (e.g. QuickNode's sign-in-with-x
                  // nonce). When present, the seller binds the payment to it, so payX402
                  // echoes it back; sellers that don't send extensions (our self-loop)
                  // leave this undefined.
  if (headerb64) {
    const decoded = b64decode(headerb64);
    x402Version = decoded.x402Version ?? 1;
    accepts = decoded.accepts;
    resource = decoded.resource;
    extensions = decoded.extensions;
  } else {
    const j = await challenge.json();
    accepts = j.accepts;
    resource = j.resource;
    extensions = j.extensions;
  }
  // Multi-chain sellers (e.g. QuickNode) advertise a MENU across many chains/tokens;
  // accepts[0] may be a different chain. SELECT the entry matching OUR chain + batched
  // scheme (first match wins). No match → ok:false (graceful; caller degrades to
  // Exa-only) — never fall back to accepts[0]. A single-entry self-loop still selects
  // correctly (its one entry matches).
  if (!Array.isArray(accepts) || accepts.length === 0)
    return { ok: false, status: 502, body: { executed: false, step: "challenge", error: "402 had no accepts[] requirements" } };
  const requirements = accepts.find(
    (r) => r?.network === EXPECTED_NETWORK && r?.extra?.name === BATCH_NAME
  );
  if (!requirements)
    return { ok: false, status: 502, body: { executed: false, step: "challenge",
      error: `no accepts[] entry for ${EXPECTED_NETWORK} / ${BATCH_NAME}` } };
  return { ok: true, requirements, x402Version, resource, extensions };
}

// The buyer core: 402 → guard → sign (delegate EOA) → settle. Returns
// { status, body } (see RETURN SHAPE above). `approvedUsdc` is a budget-approved
// spend ceiling (decimal USDC); `requireApproved:true` (set by maybeBuyData) makes
// a data buy fail CLOSED when no valid ceiling is present. `challenge` is an
// optional pre-fetched result from fetchX402Requirements() — when supplied, payX402
// skips its own 402 fetch and uses it (so the gated price == the signed price).
// `jobContext` is reserved and intentionally unused.
export async function payX402({ sellerUrl, challenge, approvedUsdc, requireApproved, jobContext } = {}) {
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
    // ── 1. Obtain the challenge. Use the caller's PRE-FETCHED challenge when
    // supplied (maybeBuyData fetches it first to gate the advertised price, then
    // threads it here) so the gated price is exactly the price we sign — one
    // fetch, no skew. Otherwise fetch it now.
    const chal = challenge ?? (await fetchX402Requirements({ sellerUrl: resolvedSeller }));
    if (!chal.ok) return { status: chal.status ?? 502, body: chal.body };
    const { requirements, x402Version, resource: challengeResource, extensions: challengeExtensions } = chal;

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

    // Price guard: the atomic USDC price (6dp). x402 v1 sellers publish it as
    // `maxAmountRequired`; v2 sellers (e.g. QuickNode) as `amount` — prefer the
    // former, fall back to the latter. This same-fallback value is what gets SIGNED
    // (see schemeRequirements.amount below), and maybeBuyData reads the identical
    // fallback for the gate, so gate-price == signed-price. Refuse to authorize more
    // than AGENT_MAX_SPEND_USDC. Fail closed on a non-integer amount.
    const atomic = String(requirements.maxAmountRequired ?? requirements.amount ?? "");
    if (!/^\d+$/.test(atomic) || atomic === "0")
      return { status: 200, body: { executed: false, blocked: `invalid price (maxAmountRequired/amount) "${atomic}"` } };
    const priceUsdc = Number(atomic) / 10 ** USDC_DECIMALS;
    const cap = maxSpendUsdc();
    if (priceUsdc > cap)
      return { status: 200, body: { executed: false, blocked: `price ${priceUsdc} USDC exceeds AGENT_MAX_SPEND_USDC (${cap})` } };

    // Approved-amount guard. `maxAmountRequired` is the SELLER's advertised price,
    // which the budget gate (canSpend) never saw — bind the signed amount to the
    // gate-approved ceiling instead. Atomic-integer compare (micro-USDC), like
    // _budget.mjs (avoids float drift).
    //
    // FAIL-CLOSED on the data-buy path: requireApproved:true (set only by
    // maybeBuyData) means a buy MUST carry a valid budget-approved ceiling — a
    // missing/invalid one is refused, not waved through to the AGENT_MAX_SPEND
    // backstop. Callers that do NOT set requireApproved (the standalone x402-pay.mjs
    // harness) are intentionally exempt; if they pass an approvedUsdc it is still
    // enforced.
    if (requireApproved && !(Number.isFinite(approvedUsdc) && approvedUsdc > 0))
      return { status: 200, body: { executed: false,
        blocked: `fail-closed: data buy requires a budget-approved ceiling (got ${approvedUsdc})` } };
    if (Number.isFinite(approvedUsdc) && approvedUsdc > 0) {
      const approvedAtomic = Math.round(approvedUsdc * 10 ** USDC_DECIMALS);
      if (Number(atomic) > approvedAtomic)
        return { status: 200, body: { executed: false,
          blocked: `advertised price ${priceUsdc} USDC exceeds budget-approved ${approvedUsdc} USDC` } };
    }

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

    // Envelope — echo back what the challenge carried. Byte-diffing a QuickNode-accepted
    // payment (via @x402/core createPaymentPayload) proved its wire payload is ALL FIVE
    // keys: { x402Version, payload, resource, accepted, extensions } — resource/accepted
    // are ALWAYS present (not either/or with extensions). So:
    //  - `resource` + `accepted` ALWAYS (resource from the challenge's top-level object
    //    when present, else built from the per-entry fields for our self-loop seller).
    //  - `extensions` only when the challenge carried them (e.g. QuickNode's
    //    sign-in-with-x nonce); our self-loop sends none, so this key is omitted and the
    //    envelope stays byte-identical to before the extensions work.
    const wirePayload = {
      ...paymentPayload,
      x402Version: 2,
      resource: challengeResource ?? {
        url: requirements.resource,
        description: requirements.description,
        mimeType: requirements.mimeType,
      },
      accepted: { ...requirements, amount: atomic },
      ...(challengeExtensions ? { extensions: challengeExtensions } : {}),
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
