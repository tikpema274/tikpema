// ══════════════════════════════════════════════════════════════════════════════════════════════
// CIRCLE'S QUOTE EXPIRY — A TAGGED UNION, DECODED, CROSS-CHECKED, AND BRANCHED ON
// ══════════════════════════════════════════════════════════════════════════════════════════════
// An upfront-fee quote carries its own deadline, and a burn submitted after it REVERTS. The
// deadline is NOT a number: it is a KIND and a number. Three sources say so, and one is on-chain:
//
//     API response      "expiry": { "mode": "TIMESTAMP", "expiresAt": 1788451562 }
//     packed word       0x00000000…6a999aea                      high byte 0x00
//     contract revert   QuoteExpired(0, 1788436574, 1788437066)   mode is the FIRST argument
//
// The verified source states the encoding outright: ONE packed `uint256`, the HIGH BYTE selects the
// mode — `0x00` timestamp (valid while `block.timestamp <= deadline`), `0x01` BLOCK HEIGHT (valid
// while `block.number <= deadline`), and `UnsupportedExpiryMode` for anything else. So the block
// mode is not a documentation hypothetical: it is named, encoded, and enforced.
//
// ⭐ Every layer offers the kind alongside the value. The only way to get this wrong is to take the
// number and drop the tag.

/**
 * ═══ 🚨🚨 THERE ARE TWO DIFFERENT `0x01`s IN A SIGNED QUOTE AND THEY MEAN UNRELATED THINGS ══════
 *
 * READ THIS BEFORE TOUCHING THE DECODE BELOW.
 *
 *   1. THE BLOB'S LEADING BYTE is a VERSION / TYPE PREFIX. It sits BEFORE the ABI words and is
 *      `0x01` on both real quotes we hold.
 *   2. THE EXPIRY MODE is the HIGH BYTE OF THE PACKED EXPIRY WORD, deep inside the encoding. It is
 *      `0x00` — TIMESTAMP — on both of those same quotes.
 *
 *          signedQuote = 0x 01 | 0000…0020 | 0000…00a0 | 00 000000…6a999aea | …
 *                           ^^                            ^^
 *                           version/type prefix           EXPIRY MODE (0x00 = TIMESTAMP)
 *
 * ⛔ SO READING THE MODE OFF THE FRONT OF THE BLOB RETURNS `0x01` = BLOCK HEIGHT ON EVERY QUOTE WE
 * HAVE EVER SEEN. It is the obvious mistake — the first byte is right there, and `0x01` is a real
 * mode value, so the wrong reading produces a plausible answer rather than an error.
 *
 * 🚨 AND IT FAILS OPEN. See the asymmetry beside `assertQuoteUnexpired`: a TIMESTAMP misread as a
 * block height is valid forever. This exact confusion is the one that costs money.
 */

/** The closed set. ⚠️ Keyed by the API's string, valued by the byte the CONTRACT enforces — the two
 *  renderings of one field, in one place, so nothing downstream has to know both. */
export const QUOTE_EXPIRY_MODES = Object.freeze({ TIMESTAMP: 0x00, BLOCK_HEIGHT: 0x01 });

/** ⚠️ The high byte occupies bits 248..255, so the deadline is everything below it. */
const DEADLINE_MASK = (1n << 248n) - 1n;

export class QuoteExpiryError extends Error {
  constructor(message, code) { super(message); this.name = "QuoteExpiryError"; this.code = code; }
}

/**
 * Find the packed expiry word in a signed quote and split it into (mode byte, deadline).
 *
 * ⭐⭐ IT SEARCHES BY VALUE, NEVER BY POSITION. The word sits at index 2 on both real quotes, and
 * hardcoding 2 would be an assumption about a vendor's ABI layout derived from two samples. Instead
 * this looks for the word whose low 248 bits equal the deadline the API already told us, and
 * requires EXACTLY ONE match — so the read is self-verifying: we are not trusting an index, we are
 * confirming we found the word carrying the number the response named.
 *
 * ⛔ AMBIGUITY IS A REFUSAL, NEVER A PICK. Two matching words means we cannot say which is the
 * expiry, and choosing one would be a guess about money.
 *
 * @returns {{modeByte:number, deadline:bigint, wordIndex:number}}
 * @throws  QuoteExpiryError when the blob is unusable or the word cannot be located uniquely
 */
export function decodeExpiryWord(signedQuote, expectedDeadline) {
  if (typeof signedQuote !== "string" || !/^0x[0-9a-fA-F]*$/.test(signedQuote)) {
    throw new QuoteExpiryError("the signed quote is not a hex string", "quote_unreadable");
  }
  const body = signedQuote.slice(2);
  // ⚠️ The leading byte is the version/type prefix — NOT part of the ABI words, and NOT the mode.
  // See the block comment above. Everything after it must be a whole number of 32-byte words.
  if (body.length < 2 || (body.length - 2) % 64 !== 0) {
    throw new QuoteExpiryError("the signed quote is not a prefix byte followed by whole words", "quote_unreadable");
  }
  const words = (body.slice(2).match(/.{64}/g) || []).map((w) => BigInt("0x" + w));
  if (!Number.isInteger(expectedDeadline) || expectedDeadline < 0) {
    throw new QuoteExpiryError("the quote's expiresAt is not a non-negative integer", "expiry_malformed");
  }
  const want = BigInt(expectedDeadline);
  const hits = words.map((w, i) => ({ w, i })).filter(({ w }) => (w & DEADLINE_MASK) === want);
  if (hits.length !== 1) {
    throw new QuoteExpiryError(
      `the expiry word could not be located in the signed quote (${hits.length} candidates for deadline ${expectedDeadline})`,
      "expiry_word_not_found");
  }
  return { modeByte: Number(hits[0].w >> 248n), deadline: hits[0].w & DEADLINE_MASK, wordIndex: hits[0].i };
}

/**
 * ISSUE-TIME NORMALISATION — the cross-check, run once, where a failure is CHEAP.
 *
 * ⭐⭐ THE CROSS-CHECK BELONGS AT ISSUE, NOT AT VALIDATION. A disagreement here costs a re-price
 * before anything has happened; at validation it costs a user who has already read a figure, waited,
 * and pressed confirm. Same fact, and the two placements have very different prices.
 *
 * ⚠️ THE AVAILABILITY COST IS ACCEPTED DELIBERATELY. If Circle changes the blob layout this refuses
 * to ISSUE — no quote, no bridge — until we update. That is loud and fail-closed, and it is the
 * chosen alternative to branching on a mode we never verified. A decode we cannot perform is a
 * refusal, never a fallback to "probably a timestamp".
 *
 * @param quote  the Quote API response ({ expiry: { mode, expiresAt }, signedQuote, … })
 * @returns {{mode:string, modeByte:number, expiresAtSec:number}}
 * @throws  QuoteExpiryError
 */
export function normalizeQuoteExpiry(quote) {
  const mode = quote?.expiry?.mode;
  const expiresAt = quote?.expiry?.expiresAt;
  if (typeof mode !== "string" || !Object.prototype.hasOwnProperty.call(QUOTE_EXPIRY_MODES, mode)) {
    // ⛔ An unrecognised mode refuses AT ISSUE too. Sealing a quote we could never validate would
    // guarantee a refusal later, after the user has been shown a price.
    throw new QuoteExpiryError(
      `the quote declares an expiry mode this server does not recognise (${JSON.stringify(mode)})`,
      "mode_unrecognised");
  }
  if (!Number.isInteger(expiresAt)) {
    throw new QuoteExpiryError("the quote's expiry carries no integer expiresAt", "expiry_malformed");
  }
  const { modeByte } = decodeExpiryWord(quote?.signedQuote, expiresAt);
  // 🚨 THE CROSS-CHECK ITSELF. The JSON is a convenience; the packed byte is what the CONTRACT
  // reads. If they disagree, either our decode is wrong or the response is — and in both cases the
  // one thing we must not do is pick a side and burn.
  if (modeByte !== QUOTE_EXPIRY_MODES[mode]) {
    throw new QuoteExpiryError(
      `the quote's declared mode (${mode} = 0x${QUOTE_EXPIRY_MODES[mode].toString(16).padStart(2, "0")}) ` +
      `disagrees with the mode byte in its own signed bytes (0x${modeByte.toString(16).padStart(2, "0")})`,
      "mode_disagrees");
  }
  return { mode, modeByte, expiresAtSec: expiresAt };
}

/**
 * VALIDATION — three outcomes, three distinct messages, and NEVER a magnitude sniff.
 *
 * ═══ 🚨🚨 THE TWO MIS-READINGS ARE NOT SYMMETRIC — THIS IS WHY THE MODE IS ENFORCED ═════════════
 *
 *   A BLOCK HEIGHT READ AS A TIMESTAMP.  ~60,000,000 as epoch seconds is March 1971. Every quote
 *   looks long expired, and we REFUSE. Wrong, loud, and it costs a bridge that should have run.
 *
 *   A TIMESTAMP READ AS A BLOCK HEIGHT.  ~1,788,451,562 compared against Arc's block number
 *   (~60,000,000) gives `60M <= 1.79B` — VALID, and it stays valid for decades. The quote never
 *   expires as far as we are concerned, the burn does not revert, and NOTHING LOOKS WRONG. The
 *   user is simply bound to a stale price forever.
 *
 * ⛔ SO THE BRANCH IS NEVER A MAGNITUDE SNIFF. "It is about 1.8 billion, so it must be a timestamp"
 * is the reasoning that produces the second failure the day a chain's block number grows or a
 * different source chain is added. The tag is carried inside the MAC and the branch reads the tag.
 *
 * @param mode          one of QUOTE_EXPIRY_MODES' keys
 * @param expiresAtSec  the deadline, in SECONDS (see the units note below)
 * @param nowMs         wall clock in MILLISECONDS
 * @throws QuoteExpiryError when the quote may not be used
 */
export function assertQuoteUnexpired({ mode, expiresAtSec, nowMs }) {
  // ── 1. TIMESTAMP — the only kind this path can evaluate ──────────────────────────────────────
  if (mode === "TIMESTAMP") {
    // ⛔⛔ UNITS. `expiresAtSec` is SECONDS (both the API's `expiresAt` and `issuedAt` are); our own
    // seal stamps `iat` in MILLISECONDS from Date.now(). Comparing them directly is a 1000× error,
    // and it runs in the UNSAFE direction: a seconds value read as milliseconds sits in 1970 and
    // refuses, but a milliseconds value read as seconds sits ~55,000 years out and NEVER expires.
    // ⭐ So the conversion is COMPUTED here, once, and the two quantities are named for their units
    // at the comparison so no future reader has to infer them.
    const nowSec = Math.floor(nowMs / 1000);
    if (!Number.isInteger(expiresAtSec)) {
      throw new QuoteExpiryError("the quote's deadline is not an integer — refusing rather than guessing", "expiry_malformed");
    }
    // ⚠️ `>=`, not `>`. On-chain the quote is still valid AT the deadline (`block.timestamp <=
    // deadline`), but our burn lands strictly later than this check — there is an approve and a
    // userOp between. Refusing at equality is the conservative edge and costs no literal.
    if (nowSec >= expiresAtSec) {
      throw new QuoteExpiryError(
        `the price quote expired ${nowSec - expiresAtSec}s ago — price it again`, "expired");
    }
    return { mode, secondsLeft: expiresAtSec - nowSec };
  }

  // ── 2. BLOCK HEIGHT — recognised, and honestly refused ───────────────────────────────────────
  // ⭐⭐ THIS IS A DIFFERENT STATEMENT FROM "we do not know what this is", and it gets its own
  // message. We know exactly what a block-height expiry is; evaluating it needs a SOURCE-CHAIN
  // BLOCK READ at validation time, which this path does not do — `openBridgeQuote` is pure and
  // synchronous, and Arc has a single RPC endpoint with no fallback, so a read failure would have
  // to refuse anyway.
  // ⚠️ SHIPPING A NAMED REFUSAL RATHER THAN A HALF-BUILT READ IS THE DECISION, not an oversight.
  // Every quote observed from Arc has been TIMESTAMP (two of them). If a block-height quote ever
  // arrives, this refuses instead of guessing, and the message says what would be needed.
  if (mode === "BLOCK_HEIGHT") {
    throw new QuoteExpiryError(
      "this quote expires at a source-chain BLOCK HEIGHT, and this path cannot check that — " +
      "it would need a live Arc block-number read at validation time. Price it again.",
      "block_height_unsupported");
  }

  // ── 3. ANYTHING ELSE — refused, and said differently ─────────────────────────────────────────
  // ⛔ It must NEVER fall through to the branch we happen to have. A mode we do not recognise is a
  // mode whose comparison we cannot write, and the safe answer is the one that moves no money.
  throw new QuoteExpiryError(
    `this quote uses an expiry kind this server does not recognise (${JSON.stringify(mode)}) — ` +
    "refusing rather than guessing which comparison to make",
    "mode_unrecognised");
}
