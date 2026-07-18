// _retry.mjs — bounded retry for the TRANSIENT class of chain-read failure, and nothing else.
//
// ── WHY THIS EXISTS (evidence, not theory) ───────────────────────────────────────────
// On 2026-07-17 three consecutive unified-balance deposits failed in prod (ub-deposits
// records dep:07960ec2, dep:1533b09c, dep:648c1c0b — one user, 09:08:31→09:10:01). All
// three carried the SAME error, straight from Arc's public RPC:
//
//   RPC Request failed.
//   ...
//   Contract Call:
//     function:  isAuthorizedForBalance(address token, address depositor, address addr)
//   Details: request limit reached
//   Version: viem@2.52.2
//
// ⚠️ VIEM DOES NOT RETRY THIS, and the reason is specific — do not "simplify" it away.
// viem's own transport retry (retryCount: 3) is gated by shouldRetry(), which for an error
// carrying a numeric `code` retries ONLY -1, -32005 (LimitExceeded), -32603 (Internal), or
// 429, and returns false for anything else. Arc answers a throttle with a JSON-RPC ERROR
// BODY — the message is "RPC Request failed." (viem's RpcRequestError, built only from a
// parsed JSON-RPC error object), NOT "HTTP request failed." + "Status: 429" (HttpRequestError).
// There is no HTTP status on it at all, so viem's `error.status === 429` branch is
// unreachable, and Arc's code is not in the retry set. Proof it never retried: viem's
// backoff would force >= 1.05s of sleep (150/300/600ms), yet two of those three failures
// completed the WHOLE background function in ~0.61s.
//
// Hence: retry HERE, explicitly. Raising viem's retryCount or retryDelay would do nothing,
// because the retry never triggers in the first place.
//
// ── THE PATTERN IS BORROWED, NOT INVENTED ────────────────────────────────────────────
// scripts/dd/rpc.mjs already solved this exact problem against this exact RPC (its README:
// check 2's first real run came back 4/6 INDETERMINATE from this throttle alone). The regex
// and the 250·2^n backoff are ITS, reproduced rather than imported: scripts/dd is the
// operator's standalone audit instrument with its own transport (raw fetch, pinned blocks,
// no viem by design), and a Netlify function must not depend on it. Two copies of a rule is
// a duplication risk — so if you change the transient class here, change it there too.
//
// ── THE RULE THAT MATTERS ────────────────────────────────────────────────────────────
// ONLY the transient class is retried. A genuine `execution reverted` is a REAL ANSWER about
// the chain and must surface immediately — retrying it would paper over a true failure,
// which is the exact trap this file is built to avoid on the other side.

/**
 * The transient class. Verbatim from scripts/dd/rpc.mjs:53 — keep them in step.
 * `request limit` is what Arc actually says (see the prod error above); the rest cover the
 * neighbouring transport failures that are equally not-an-answer-about-the-chain.
 */
export const TRANSIENT =
  /request limit|rate limit|too many requests|429|timeout|ETIMEDOUT|ECONNRESET|fetch failed|502|503|504/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Is this error the transient class — i.e. "the chain did not answer", as opposed to "the
 * chain answered, and the answer is no"?
 *
 * Matches against the FULL error text, walking the cause chain. viem nests the useful string:
 * a ContractFunctionExecutionError's own message carries the "Details: request limit reached"
 * line, but a caller that only read e.shortMessage would miss it. Belt and braces.
 */
export function isTransient(e) {
  if (!e) return false;
  let text = "";
  for (let cur = e, depth = 0; cur && depth < 5; cur = cur.cause, depth++) {
    text += ` ${cur.message ?? ""} ${cur.details ?? ""} ${cur.shortMessage ?? ""}`;
    if (typeof cur.status === "number") text += ` ${cur.status}`;
    if (typeof cur.code === "number") text += ` ${cur.code}`;
  }
  return TRANSIENT.test(text);
}

/**
 * The Netlify Blobs TRANSIENT class — a request-scoped Blobs token that expired MID-INVOCATION
 * (the injected `event.blobs` token is short-lived; a tick that spends seconds in throttled chain
 * I/O between token acquisition and a Blobs WRITE can outlive it), or a transient Blobs-service
 * internal error. Kept SEPARATE from the chain TRANSIENT regex above on purpose: this is retryable
 * ACROSS ticks (the next scheduled invocation gets a FRESH injected token — re-acquiring within the
 * same invocation does NOT, since `event.blobs` is fixed), and must never be conflated with a
 * chain-read throttle. The observed prod text is "Netlify Blobs has generated an internal error
 * (Failed to decode token: Token expired)".
 *
 * ⚠️ This classifies a BLOBS write, which is idempotent (same key, same value) and safe to redo on
 * a later tick. It must NEVER be used to retry a CHAIN submit — see dca-tick, where a Blobs-transient
 * DEFERS (leaves durable state untouched so the next tick redoes it), it does not resubmit.
 */
export const BLOBS_TRANSIENT =
  /failed to decode token|token expired|blobs.*internal error|internal error.*token|BlobsInternalError/i;
export function isBlobsTransient(e) {
  if (!e) return false;
  let text = "";
  for (let cur = e, depth = 0; cur && depth < 5; cur = cur.cause, depth++) {
    text += ` ${cur.name ?? ""} ${cur.message ?? ""} ${cur.details ?? ""} ${cur.shortMessage ?? ""}`;
  }
  return BLOBS_TRANSIENT.test(text);
}

/**
 * Run `fn` with bounded exponential backoff over the transient class ONLY.
 *
 * Delays: 250/500/1000/2000ms + jitter (scripts/dd/rpc.mjs:81), ~3.75s worst case over 4
 * retries. Jitter matters because several deposits can be in flight at once and a fixed
 * schedule would sync them into the same throttle window.
 *
 * ⚠️ BOUNDED, and the bound is honest. On exhaustion this RETHROWS the last error with
 * `.transient = true` stamped on it. It does NOT return a fallback, and it must never learn
 * to: a caller that cannot tell "I could not read" from "I read, and it was false" is the
 * bug this whole change exists to fix.
 *
 * ⚠️ READ-ONLY CALLERS ONLY. Every retry re-runs `fn` from scratch, so `fn` must be
 * idempotent. Do not wrap a tx submission in this — a retried write is a double-spend.
 */
export async function withRetry(fn, { retries = 4, baseMs = 250, label = "chain read" } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isTransient(e) || attempt === retries) break;
      await sleep(baseMs * 2 ** attempt + Math.floor(Math.random() * 100));
    }
  }
  if (isTransient(last)) {
    throw Object.assign(new TransientChainError(label), { cause: last });
  }
  throw last;
}

/**
 * Exhausted retries against the transient class: we still do not know the answer.
 *
 * Carries a SHORT, human message. The raw viem text (a ~15-line dump of the eth_call, its
 * hex calldata and a docs link) is kept ONLY on `.cause` for operators — it is not for a
 * user, who was shown exactly that wall of hex on 2026-07-17 and could do nothing with it.
 */
export class TransientChainError extends Error {
  constructor(label) {
    super(
      `Arc's network is rate-limiting requests right now, so we couldn't ${label}. ` +
        `Nothing was changed — try again in a moment.`
    );
    this.name = "TransientChainError";
    this.transient = true;
    this.recoverable = true;
  }
}
