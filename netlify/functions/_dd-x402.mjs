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
import { X402_VERSION } from "../../shared/x402/version.mjs";
import { resourceObject } from "../../shared/x402/resource.mjs";
import { readGatewayBalance, confirmPayment, CONFIRM_REASON, RETRIEVE_TIMEOUT_MS, RETRIEVE_TIMEOUT_PROVENANCE } from "./_x402-confirm.mjs";
import { ARC, CONTRACTS } from "./_arc.mjs";
// ⭐ The power catalogue is the SOURCE OF TRUTH for the floor stated in the 402. Imported, never
// transcribed: a literal count in buyer-facing text is a second source of truth that rots silently
// the day the catalogue changes, and this repo has been bitten by exactly that before.
import { POWER_SIGS } from "../../shared/onchain-facts/index.mjs";
// ⭐ THE CALL SHAPE, IMPORTED. A hand-written copy here would be a second source of truth for the
// thing agents call us with — see _dd-descriptor.mjs.
import { DD_REQUEST_SCHEMA, DD_RESPONSE_SCHEMA, DD_OPENAPI_URL } from "./_dd-descriptor.mjs";

export const PENDING_STORE = "dd-analyze-pending";

// --- Arc Testnet / Gateway batching constants -----------------------------------------------
// ⭐ DERIVED, NOT MIRRORED. This block used to carry the comment "mirrored from x402-quote; do not
// change" beside two hand-typed literals — which is noticing a duplicate source of truth and
// writing a warning instead of removing it. The chain id and the USDC address each had THREE
// copies (here, x402-quote.mjs, and _arc.mjs), two of them PUBLISHED TO BUYERS in a 402 challenge,
// with nothing forcing them to agree. Both now derive from the one place that owns them.
export const DD_NETWORK = `eip155:${ARC.chainId}`; // CAIP-2, from ARC.chainId
export const DD_ASSET = CONTRACTS.USDC; // USDC on Arc, from CONTRACTS

// 🚨 ASSERTED AT IMPORT, same reasoning as the price guard below: these two strings are PUBLISHED
// in a payment challenge, so a silent change would advertise a different chain or a different token
// to a paying buyer. Deriving them makes drift impossible; asserting them makes an INTENDED change
// deliberate rather than incidental.
if (DD_NETWORK !== "eip155:5042002" || DD_ASSET.toLowerCase() !== "0x3600000000000000000000000000000000000000") {
  throw new Error(`_dd-x402: published chain/asset changed — network="${DD_NETWORK}" asset="${DD_ASSET}"`);
}
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

// ═══ ⭐ ONE NUMBER, THREE RENDERINGS, TWO FORMATTERS — AND THE DIFFERENCE IS LOAD-BEARING ═══════
//
//   DD_PRICE_ATOMIC             "60000"        the wire value; the only hand-written figure
//   DD_PRICE_HUMAN              "$0.06 USDC"   for people and for search; trailing zeros TRIMMED
//   x-payment-info price.amount "0.060000"     Circle's format; trailing zeros KEPT
//
// 🚨 A SINGLE FORMATTER WOULD CLOSE ONE DRIFT AND OPEN ANOTHER. Deriving everything with the human
// formatter emits "0.06" into x-payment-info, which may fail Circle's parser; deriving everything
// with the padded one puts "$0.060000 USDC" in front of buyers. The two rules are genuinely
// different requirements, so they are two functions with the difference stated, not one function
// with a flag — a boolean parameter at a call site is where this kind of distinction goes to die.
//
// ⚠️ USDC IS 6-DECIMAL. Both formatters assume that and assert their input is atomic digits, because
// passing an already-formatted string ("0.06") would silently produce "0.000000" — a free service.

const USDC_DECIMALS = 6;

function splitAtomic(atomic) {
  const a = String(atomic);
  if (!/^\d+$/.test(a)) throw new Error(`price must be atomic digits, got "${a}" — an already-formatted value here would render as a different price`);
  const padded = a.padStart(USDC_DECIMALS + 1, "0");
  return { whole: padded.slice(0, -USDC_DECIMALS), frac: padded.slice(-USDC_DECIMALS) };
}

/** Circle's `x-payment-info` amount: fixed 6 decimals, trailing zeros KEPT. "60000" → "0.060000". */
export function formatUsdcPadded(atomic) {
  const { whole, frac } = splitAtomic(atomic);
  return `${whole}.${frac}`;
}

/** Human/search rendering: trailing zeros TRIMMED, no decimal point when nothing remains.
 *  "60000" → "0.06"   ·   "1000000" → "1"   ·   "1" → "0.000001" */
export function formatUsdcTrimmed(atomic) {
  const { whole, frac } = splitAtomic(atomic);
  const t = frac.replace(/0+$/, "");
  return t ? `${whole}.${t}` : whole;
}

export const DD_PRICE_DECIMAL = formatUsdcPadded(DD_PRICE_ATOMIC); // "0.060000" — x-payment-info
export const DD_PRICE_HUMAN = `$${formatUsdcTrimmed(DD_PRICE_ATOMIC)} USDC`; // "$0.06 USDC"

// 🚨 ASSERTED AT IMPORT. These two strings are published — one to buyers and search, one to a parser
// we do not control — and a derivation that silently changed either would change the advertised
// price of a live paid service. Cheap check, and it fails at load rather than in a listing.
if (DD_PRICE_DECIMAL !== "0.060000" || DD_PRICE_HUMAN !== "$0.06 USDC") {
  throw new Error(`_dd-x402: price derivation drifted — decimal="${DD_PRICE_DECIMAL}" human="${DD_PRICE_HUMAN}" from atomic="${DD_PRICE_ATOMIC}"`);
}

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
    // ⭐ NAMED FOR THE OUTCOME, NOT THE MECHANISM. This used to read "DD on-chain due-diligence
    // report" — "DD" is our INTERNAL name for the engine, and a buyer scanning a directory does not
    // know what it means. They know whether they want a contract checked before their agent signs.
    description: `Contract safety check before an agent signs — a signed on-chain due-diligence report on any Arc Testnet address, with an honest coverage manifest. ${DD_PRICE_HUMAN} per report`,
    // ⭐⭐ WHICH MECHANISM SETTLES THIS, PUBLISHED. A buyer could previously only infer it. We run
    // TWO genuinely different schemes across live sellers — this one and x402-quote settle through
    // CIRCLE GATEWAY (GatewayWalletBatched), while x402-vanilla-seller settles EIP-3009 against the
    // token itself — and nothing in the challenge said which you were getting.
    // 🚨 "batched" IS THE LOAD-BEARING WORD: Gateway settlement is DELAYED, so facilitator
    // acceptance is not payment. ⛔ No latency figure is published here on purpose — a measured
    // range would go stale on the wire; the shape is durable, the number is not.
    settlement: "circle-gateway-batched",
    mimeType: "application/json",
    payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    asset: DD_ASSET,
    extra: DD_EXTRA,
  };
}

const b64encode = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
export const b64decodePayment = (str) => JSON.parse(Buffer.from(str, "base64").toString("utf8"));

// ═══ ⭐ SUBJECT PREVIEW — telling the buyer what THEIR purchase will look like ═══════════════════
// A stranger decides from the 402, not from the delivered report. Measured 2026-08-11: a no-bytecode
// address was sold a report covering ONE catalogue item, at full price. The terms warned that thin
// coverage still settles — but "could check little" reads as "occasionally fewer checks", not "8%",
// and the buyer had no way to know which case they were in. The seller did: eth_getCode is one call,
// and the subject is already named in the request that triggers this challenge.
//
// ⭐ THIS IS A PREDICTION, NOT A PROMISE. It reuses the bridge's `predicted` / `measured` vocabulary
// deliberately rather than inventing a second dialect for the same distinction: `predicted` here is
// exactly what `delivery: "predicted"` means there — our best statement before the authoritative
// read exists. The delivered coverage manifest is the `measured` value and is the authority.
//
// 🚨 THREE STATES, NEVER TWO. A failed read must not block the 402 (the challenge is free and
// refusing to quote over a diagnostic would be worse), and it must NEVER default to "has code" or to
// "full coverage" — that is absence-reads-as-safe arriving in a brand-new field. `null` means
// UNKNOWN and says so in words.
export const SUBJECT_CODE = Object.freeze({
  HAS_CODE: "has-code",
  NO_CODE: "no-code",
  UNREADABLE: "unreadable",
});

/**
 * One `eth_getCode` at quote time. NEVER THROWS — every failure resolves to UNREADABLE.
 * @returns {Promise<{state: string, codeLen: number|null, detail: string}>}
 */
export async function readSubjectCode({ rpcCall, address }) {
  const unreadable = (why) => ({ state: SUBJECT_CODE.UNREADABLE, codeLen: null, detail: why });
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return unreadable("no well-formed subject address was supplied with the challenge request");
  }
  try {
    const res = await rpcCall({ method: "eth_getCode", params: [address, "latest"] });
    const hex = typeof res === "string" ? res : res?.result;
    if (typeof hex !== "string" || !hex.startsWith("0x")) {
      return unreadable("the node did not return a bytecode string for this address");
    }
    const codeLen = (hex.length - 2) / 2;
    return codeLen === 0
      ? { state: SUBJECT_CODE.NO_CODE, codeLen: 0, detail: "eth_getCode returned empty — no contract code at this address" }
      : { state: SUBJECT_CODE.HAS_CODE, codeLen, detail: `eth_getCode returned ${codeLen} bytes of contract code` };
  } catch (e) {
    return unreadable(`the bytecode read failed at quote time (${e?.message ?? e})`);
  }
}

/** The buyer-facing preview. Pure — takes the tri-state, returns what goes in the 402. */
export function subjectPreview({ address = null, code } = {}) {
  const powerGroups = Object.keys(POWER_SIGS).length;
  const common = {
    address,
    basis: "predicted",
    observedAt: "quote-time",
    authority:
      "PREDICTED, not promised. This is derived from a single bytecode read taken when this quote " +
      "was issued. The coverage manifest inside the delivered report is the MEASURED value and is " +
      "the authority; if the address changes between this quote and the analysis, the manifest wins.",
  };

  if (code?.state === SUBJECT_CODE.NO_CODE) {
    return {
      ...common,
      hasCode: false,
      expectedCoverage: "MINIMAL",
      detail:
        `This address has NO CONTRACT CODE. All ${powerGroups} power groups in the catalogue are ` +
        `unobservable on it — there is no bytecode to find them in — so the report you receive will ` +
        `record nearly the whole catalogue as NOT CHECKED, with the reason for each. In a measured ` +
        `case this resolved to a single checked item out of the whole catalogue.`,
      stillCharged: true,
      stillChargedWhy:
        "You are still charged the full price, and that is deliberate — see priceIsFlat. " +
        "\"There is no contract code here, so none of these powers exist\" is an ANSWER about the " +
        "subject, not a failure to answer. If you wanted a contract analysed, check the address " +
        "before paying.",
    };
  }

  if (code?.state === SUBJECT_CODE.HAS_CODE) {
    return {
      ...common,
      hasCode: true,
      expectedCoverage: "NOT PREDICTED",
      codeLen: code.codeLen,
      detail:
        `This address has ${code.codeLen} bytes of contract code, so the powers catalogue is at ` +
        `least applicable to it. ⚠️ That is NOT a prediction of high coverage: proxies, unreadable ` +
        `slots and RPC failures can still leave much unchecked, and only the delivered manifest says ` +
        `what was actually reached.`,
      stillCharged: true,
    };
  }

  // ⭐ UNREADABLE. The dangerous branch: it must not resemble either of the above.
  return {
    ...common,
    hasCode: null,
    expectedCoverage: null,
    detail:
      "WE COULD NOT READ THIS ADDRESS'S BYTECODE AT QUOTE TIME, so we cannot tell you which case " +
      "you are in. ⚠️ Read this as UNKNOWN, not as reassurance: it is NOT a statement that the " +
      "address has code, and NOT a prediction of full coverage. A no-code address — the minimal " +
      "coverage case — is entirely consistent with this result. " +
      (code?.detail ?? ""),
    stillCharged: true,
    stillChargedWhy:
      "This failed read is a DIAGNOSTIC at quote time and has no effect on billing. It is not the " +
      "same as the engine failing during analysis, which does return the report free (see notCharged).",
  };
}

/**
 * The 402 challenge. Carries what the caller is buying AND what they are not — the coverage promise
 * is "an honest manifest", never "a clean bill", and saying so at quote time is what stops a thin
 * report reading as a bait-and-switch after payment.
 */
export function challenge402({ requirements, detail = null, preview = null }) {
  const powerGroups = Object.keys(POWER_SIGS).length;
  return {
    statusCode: 402,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": b64encode({ x402Version: X402_VERSION, accepts: [requirements] }),
    },
    body: JSON.stringify({
      // ⭐ MIRRORED FROM THE HEADER, NOT A SECOND SOURCE OF TRUTH. Under v2 the body is explicitly
      // "a server implementation concern" and the PAYMENT-REQUIRED header is the protocol surface,
      // so this field is a COMPATIBILITY AFFORDANCE for body-reading clients (10 of 15 live Base
      // sellers measured 2026-08-26 carry it), not a spec requirement. It reads X402_VERSION for
      // the same reason the header does — publishing the version in two places from two literals
      // is how they drifted apart in the first place.
      x402Version: X402_VERSION,
      // ⭐ THE v2 TOP-LEVEL `resource` — DERIVED from `requirements`, never from DD_RESOURCE_URL,
      // because THAT is the URL the payment signature is bound to. See shared/x402/resource.mjs for
      // why the two agreeing sources are not interchangeable. Any index needs this to know what is
      // being sold; it is spec-aligned, not Coinbase-specific.
      resource: resourceObject(requirements),
      error: detail ? "Payment required" : "Payment required",
      ...(detail ? { reason: detail } : {}),
      accepts: [requirements],

      // ═══ ⭐ HOW TO PHRASE THE CALL, IN THE CHALLENGE ITSELF ═══════════════════════════════════
      // Until now the 402 said what you are buying and what it costs, but not how to ask for it —
      // so an agent had to fetch /openapi.json before it could construct a valid request, and an
      // agent that could not (no network budget, no HTML/JSON tooling, a sandbox with one allowed
      // host) simply could not buy. The terms and the call shape now arrive together, in the
      // response the agent already has in hand.
      // ⚠️ THE SAME OBJECTS THE OPENAPI DOCUMENT PUBLISHES — imported, never restated. A stale copy
      // here would teach an agent to build a request this endpoint then refuses, and the agent would
      // have no way to tell which of the two descriptions was current.
      howToCall: {
        method: "POST",
        contentType: "application/json",
        request: DD_REQUEST_SCHEMA,
        response: DD_RESPONSE_SCHEMA,
        openApiUrl: DD_OPENAPI_URL,
        note:
          "Retry this exact request with an X-PAYMENT header carrying the authorization described " +
          "in `accepts[0]`. The body shape does not change between the unpaid and paid call.",
      },

      // ⭐ Present ONLY when a subject was named and a preview could be formed. Its absence is not a
      // silent "fine" — the coverage text below states the floor unconditionally.
      ...(preview ? { subjectPreview: preview } : {}),
      whatYouAreBuying: {
        artifact: "one signed on-chain due-diligence report about the address and chain you named",
        price: DD_PRICE_HUMAN,
        attestation: "ERC-1271, verifiable against the on-chain owner of ERC-8004 agentId 851891",
        coverage:
          "an HONEST COVERAGE MANIFEST, not a clean bill. A report that could check little still " +
          "settles and is still the product — it tells you exactly what was and was not checked, " +
          "and that manifest is inside the signed payload so it cannot be stripped. " +
          "⚠️ THE FLOOR IS LOW, REAL, AND PREDICTABLE: for an address with NO CONTRACT CODE, all " +
          `${powerGroups} power groups are unobservable and the report can come back with a single ` +
          "checked item out of the whole catalogue — at the same full price. That is not a " +
          "degraded case; it is the deterministic answer for such an address, and subjectPreview " +
          "above tells you in advance whether you are in it.",
        // ⭐ THE FLOOR AND THE REASON TRAVEL TOGETHER. Disclosing "you may get ~8% coverage" without
        // saying why the price does not scale makes the terms read as worse, not more honest — the
        // buyer's immediate question is "then why full price?", and the answer is the strongest
        // thing this service has to say. It lived only in a code comment where no buyer could read it.
        priceIsFlat:
          "The price does NOT scale with coverage, and that is deliberate. A coverage-scaled price " +
          "would pay us more for reporting more coverage — an incentive to overstate what we " +
          "actually checked, on the one number you cannot independently audit before you buy. A " +
          "flat price removes that incentive entirely: we gain nothing from claiming a check we did " +
          "not make, so the manifest can be believed. You are paying for a truthful account of what " +
          "is knowable about this address — including, when it is the truth, \"almost nothing is " +
          "knowable here, and here is exactly why\".",
        notCharged:
          "you are not charged if the engine could not produce an answer about the subject — an " +
          "outage, an unreachable chain, or a refusal returns the report free and leaves your " +
          "authorization unspent. " +
          "⭐ THE DISTINCTION THAT DECIDES WHETHER YOU PAY: \"there was NOTHING to check\" is an " +
          "ANSWER and IS charged — an address with no contract code has no powers to find, and " +
          "establishing that is a finding. \"We COULD NOT check\" is OUR instrument failing and is " +
          "FREE. Thin coverage by itself is never a refund reason; a broken instrument always is.",
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

// ═══ 🚨 WHAT A FAILED SETTLE DOES *NOT* TELL US ══════════════════════════════════════════════
//
// This branch used to answer a rejected settlement with: "Your authorization was not spent."
// ⛔ THAT WAS AN UNHEDGED ABSENCE CLAIM ABOUT SOMEBODY ELSE'S MONEY, derived from the facilitator's
// report of its own failure — a third party we do not own — and read by an autonomous agent with no
// other source of truth. Three lines above it, this file's own step-3 comment already said the rule:
// "From here on, 'we do not know' is a possible answer and must never be reported as 'you were not
// charged.'" The copy contradicted the comment it sat under.
//
// ═══ ⭐ WHAT THE RESPONSE ACTUALLY CARRIES — READ FROM THE VENDOR'S OWN TYPE ══════════════════
// @circle-fin/x402-batching, dist/server/index.d.ts:
//
//     interface SettleResponse {
//       success: boolean;
//       errorReason?: string;    // OPTIONAL, and a free-form string — no enum, no closed set
//       payer?: string;
//       transaction: string;
//       network: string;
//     }
//
// ⛔ NOT ONE OF THOSE FIELDS STATES WHETHER THE AUTHORIZATION WAS CONSUMED. `errorReason` is the
// facilitator's prose about its own failure, and branching on it would be exactly the class
// `verify-no-prose-state-recovery` forbids. `transaction` is declared required-but-unconstrained and
// the client returns the parsed body VERBATIM whenever it contains a `success` key — HTTP status
// discarded, no validation — so its presence or absence licenses nothing either.
//
// ⚠️ SO THE THREE STATES ARE NOT DISTINGUISHABLE HERE:
//     never consumed  ·  consumed, then settlement failed  ·  we cannot tell
// Only the third is honest, and it is what this branch now says. [[absence-must-never-read-as-safe]]
// ⭐ The neighbouring cases are already right and are the model: SettleAborted's paths CAN say
// "unspent" because WE aborted before broadcast, and retrievePaid's unreadable-store branch says
// "this is NOT a statement that you did not pay".
export const SETTLE_FATE = Object.freeze({
  UNKNOWN:      "authorization-fate-unknown",
  NOT_CONSUMED: "authorization-not-consumed",
  CONSUMED:     "authorization-consumed",
});

/**
 * ⭐⭐ THE FIELD THAT WOULD LICENSE A DEFINITE CLAIM — and it does not exist yet.
 *
 * Naming it makes the absence CHECKABLE instead of assumed: `verify-dd-facilitator` reads the
 * vendored SettleResponse type and fails if this field ever appears, because the copy below would
 * then be understating what we know. That is the binding — the sentence is licensed by a field, and
 * it fails when the field starts distinguishing.
 * ⚠️ A boolean is required, not merely a present key: a truthy string would otherwise be read as
 * "consumed" by coercion, which is how an unknown becomes an answer.
 */
export const FATE_FIELD = "authorizationConsumed";

/** @returns {string} a member of SETTLE_FATE — UNKNOWN unless the response POSITIVELY says otherwise. */
export function classifySettleFate(settlement) {
  const v = settlement?.[FATE_FIELD];
  if (typeof v !== "boolean") return SETTLE_FATE.UNKNOWN;
  return v ? SETTLE_FATE.CONSUMED : SETTLE_FATE.NOT_CONSUMED;
}

/**
 * The claim, SELECTED BY the fate rather than written at the return site. A sentence a human types
 * beside a branch is a sentence that outlives the branch's meaning; a map cannot be more specific
 * than the classifier that indexes it.
 * ⭐ BILLING AND SERVICE ARE SEPARATE FIELDS, as in the quote path's `stillCharged` / `detail` split:
 * "we are not serving you" and "we do not know what your money did" are different claims and must
 * not be readable as one.
 */
export const SETTLE_FAILURE_CLAIM = Object.freeze({
  [SETTLE_FATE.UNKNOWN]: Object.freeze({
    detail:
      "The facilitator rejected this settlement, so the report is NOT served. ⚠️ This is NOT a " +
      "statement that you were not charged. Circle's settle response carries no field saying whether " +
      "your authorization was consumed, so 'never spent' and 'spent, then settlement failed' are " +
      "indistinguishable to us here. Treat its fate as UNKNOWN.",
    billing:
      "UNKNOWN — which is not the same as zero. Re-using the SAME authorization is safe only if it " +
      "was never consumed, and that is precisely what we cannot confirm; signing a NEW one risks " +
      "paying twice if the first did land.",
    whatToDo:
      "A handle was persisted BEFORE the broadcast, so your entitlement survives our uncertainty. " +
      "Poll `retrieve`: it serves the frozen report if and only if the chain shows the payment " +
      "arrived, at no further cost. That is the only way to learn which case you are in.",
  }),
  // ── Unreachable today, and defined anyway: a map with a hole would fall back to `undefined`, and
  //    an absent claim reads as no claim at all. If Circle ever ships FATE_FIELD, these are what the
  //    caller gets — and the guard fails first, so nobody ships them unreviewed.
  [SETTLE_FATE.NOT_CONSUMED]: Object.freeze({
    detail:
      "The facilitator rejected this settlement and reported that your authorization was NOT " +
      "consumed, so the report is not served and nothing was spent.",
    billing: "NOTHING WAS SPENT — stated by the facilitator, not inferred by us.",
    whatToDo: "Retrying with the SAME authorization is safe until its validBefore.",
  }),
  [SETTLE_FATE.CONSUMED]: Object.freeze({
    detail:
      "The facilitator consumed your authorization and settlement still failed, so the report is " +
      "not served AND your authorization is spent.",
    billing: "SPENT — stated by the facilitator. Do not sign a replacement authorization.",
    whatToDo:
      "Poll `retrieve` with the handle below. If the payment reaches payTo the frozen report is " +
      "yours at no further cost; if it never does, this is a support case, not a retry.",
  }),
});

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
    // ⭐ THE CLAIM IS SELECTED BY THE FATE, never written here. See SETTLE_FATE above for why the
    //   only honest answer today is UNKNOWN.
    const fate = classifySettleFate(s?.settlement);
    const claim = SETTLE_FAILURE_CLAIM[fate];
    return {
      statusCode: 402,
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-REQUIRED": b64encode({ x402Version: X402_VERSION, accepts: [requirements] }),
      },
      body: JSON.stringify({
        x402Version: X402_VERSION,
        resource: resourceObject(requirements),
        error: "Payment settlement failed",
        // ⚠️ The facilitator's own prose, PASSED THROUGH as a diagnostic. Nothing branches on it —
        // it is the vendor's sentence about the vendor's failure, and it is not evidence about the
        // authorization. Kept because a human debugging this will want it.
        reason: s?.settlement?.errorReason || "settle failed",
        authorizationFate: fate,
        detail: claim.detail,
        billing: claim.billing,
        whatToDo: claim.whatToDo,
        // ⭐⭐ THE HANDLE WAS BEING DROPPED. `makeSettler` persists the record (and the frozen report)
        // BEFORE broadcasting and keeps it on the rejected path as `broadcast:"rejected"` — but this
        // response discarded it, so a caller whose authorization HAD been consumed was told the money
        // was safe and given no way to redeem the report if it was not. Hedged copy with no way to
        // resolve the hedge is half an answer to an agent.
        handle: s?.handle ?? null,
        retrieve: s?.handle ? `${resource}?handle=${s.handle}` : null,
        entitlement: "PERMANENT — if the payment ever lands, this handle still serves the frozen report.",
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
