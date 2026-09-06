// _x402-vanilla.mjs — the importable VANILLA x402 BUYER core.
//
// ═══ ⛔⛔ PARKED, NOT DEAD — DECIDED 2026-09-06. DO NOT DELETE THIS FILE. ═══════════════════════
// Nothing imports payX402Vanilla at runtime. That is a DECISION with a stated reason and a stated
// reopen condition, not an oversight, and it was taken after checking each deletion argument
// individually. If you arrived here because a dead-code sweep flagged it, read this block first —
// the record in PROGRESS.md is not what you are reading when you open this module, which is
// precisely why the reasoning lives HERE.
//
// 🚨 THE COST OF DELETING IT IS NOT THE LOSS OF DEAD CODE. `shared/x402/version.mjs:43-48`
// justifies a LIVE PRODUCTION INCONSISTENCY by naming this file: x402-vanilla-seller declares
// version 2 while reading `x-payment`, and the comment's whole argument is that "its buyer
// this buyer sends X-PAYMENT to match. The pair is internally consistent on the wire and
// proven against real money. Correcting either half alone breaks a settled path." ⛔ DELETE THIS
// BUYER AND THAT JUSTIFICATION EVAPORATES. The seller's inconsistency then reads as an unexplained
// defect on a path that settles real money, and the next editor is free to "tidy" it — which is the
// documented way to break a settled path. A deliberate defect is only safe while the reason it is
// deliberate is still legible.
//
// ⭐ IT IS NOT SUPERSEDED BY payX402, AND THE GUARDS PROVE IT STRUCTURALLY. _x402.mjs:239 filters
// accepts[] for `extra.name === "GatewayWalletBatched"`; :287 blocks "not a Gateway-batched option";
// :289 blocks "unexpected verifyingContract (not the Gateway Wallet)" — all BEFORE signing. This
// file mirrors that refusal with its own "unexpected EIP-712 domain" block. The two buyers refuse each
// other's markets by design: one signs against the GatewayWallet and spends a pre-deposited Gateway
// balance, the other signs against the USDC token domain and spends the token balance. The 2026-08-23
// census splits 1,470 offers as 975 GatewayWalletBatched / 465 vanilla `USD Coin` EIP-3009 —
// payX402 can reach NONE of the 465. Two rails, disjoint by construction. [[batched-x402-requires-from-equals-signer]]
//
// ⭐ IT IS THE ONLY CIRCLE-CUSTODIED-KEY VANILLA BUYER. No local private key anywhere in the path:
// Circle signTypedData returns a plain ECDSA signature that ecrecovers to `from`. Demonstrated
// end to end exactly ONCE, in the birth commit 1fc484f (2026-07-02) — settle tx
// 0xb7fa389638f2d64a94f2aef82456cc7a463ea68489328742664dfc9a03c551d8, status 1, selector 0xef55bec6,
// buyer 0.100000 -> 0.090000 USDC, AuthorizationUsed emitted, replay reverts. One demonstration is
// the entire evidence base for that capability; deleting the file retires it.
//
// ⭐ IT IS THE SUBJECT OF verify-circle-error-shape.mjs §9, chosen deliberately: its try{} opens at
// the challenge fetch, so a thrown `fetch` reaches the shared Circle error reader's catch with no
// seller fixture, no module mocks and no credential. §8 covers the same ground by SOURCE REGEX,
// which this repo's own rule calls blind by construction — §9 exists to backstop exactly that.
// Delete this file and the backstop goes, leaving the grep it was built to cover.
// [[assert-on-rendered-output-not-source-regex]]
//
// ⚠️ ONE ARGUMENT FOR KEEPING IT THAT DOES **NOT** HOLD, RECORDED SO IT IS NOT RE-DERIVED: "delete
// it and the live seller goes untested" is FALSE. verify-vanilla-seller-bytes.mjs and
// verify-vanilla-seller-bytes-live.mjs hand-roll their signing with a LOCAL viem account and never
// import this module. They exercise the seller perfectly well without it. What they do not exercise
// is a buyer holding no local key — that is the gap above, and it is a narrower claim than the one
// this bullet corrects.
//
// ═══ ⭐⭐ THE REFRAME, WHICH IS THE REAL FINDING: WIRE-VS-DELETE WAS THE WRONG AXIS ═════════════
// An HTTP wrapper is ~27 lines (x402-pay.mjs is the template), the spend cap is already enforced
// here by the maxSpendUsdc() / AGENT_MAX_SPEND_USDC guard, and DELEGATE_ADDRESS is already set in
// production because the live payX402
// reads it. So wiring was never blocked on cost — and doing it would still accomplish nothing,
// because ALL 465 VANILLA OFFERS ARE MAINNET AND ZERO ARE ON ARC. An Arc wrapper can only pay our
// own seller: a self-loop that re-proves the rail and reaches no market.
//
// ⭐ THE LIVE QUESTION IS WHETHER THIS FILE IS THE CHEAPEST DOOR ONTO BASE, and the asymmetry is
// the whole point. BUYING from the 465 offers that already exist needs a funded EOA and a
// chain-id/domain generalization. SELLING there needs a Base deployment, a Base payout wallet,
// Gateway settlement and a listing. Those are not the same project (PROGRESS 2026-08-23). If Base
// is ever on the roadmap, this file gets there first — which is why it is parked rather than
// deleted, and why the parking has a trigger instead of a date.
//
// ⛔ REOPEN CONDITION: Base (or any mainnet with vanilla offers) enters the roadmap. Until then this
// file is deliberately unreachable, and "unreachable" is not a defect to be fixed by wiring it up.
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
