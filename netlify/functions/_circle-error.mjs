// _circle-error.mjs — ONE reader for a failed Circle SDK call, across BOTH SDK error shapes.
//
// ═══ 🚨 WHY THIS EXISTS: THE SDK CHANGES THE SHAPE OF WHAT IT THROWS ════════════════════════
// @circle-fin/developer-controlled-wallets v9 does not wrap thrown errors AT ALL — the raw
// `AxiosError` propagates, and the useful detail sits at `e.response.data`. v10 wraps **43**
// client methods in `try { … } catch (e) { throw isAxiosError(e) ? fromAxiosError(e) : e }`,
// converting each one into a typed `HttpResponseError` / `HttpRequestError`. Those types carry
// `status` / `code` / `url` / `method` and keep the original Axios error behind a PRIVATE `.error`
// getter. **They have no `.response` property at all.**
//
// So the read this repo used at three call sites — `e.response?.status`, `e.response?.data` —
// silently yields `undefined` / `null` on v10. Measured against both copies on disk (9.6.0 and
// 10.7.1), all four sampled statuses diverged:
//
//     HTTP 400: v9(status=400 http=400 detail=present)  v10(status=undefined http=500 detail=null)
//     HTTP 401: v9(status=401 http=400 detail=present)  v10(status=undefined http=500 detail=null)
//     HTTP 429: v9(status=429 http=400 detail=present)  v10(status=undefined http=500 detail=null)
//     HTTP 503: v9(status=503 http=500 detail=present)  v10(status=undefined http=500 detail=null)
//
// ⚠️ IT FAILS SILENTLY. Optional chaining plus `?? null` means nothing throws, no suite goes red,
// and the buyer simply stops being told why their payment failed — while a 4xx ("your
// authorization is bad, do not retry") is reported as a 5xx ("we broke, please retry").
//
// ⭐ THIS SHIPS BEFORE THE BUMP, NOT WITH IT. Reading both shapes means it is correct on v9 today
// and correct on v10 the moment the dependency moves — so the bump becomes a dependency change
// with nothing else riding on it, and this change can be proven on its own.
//
// READ-ONLY over the error object. No network, no chain, no credential.

/**
 * The failure could not be attributed to an HTTP status. This is a THIRD state, not a 5xx:
 * see `httpStatusForCircleFailure`.
 */
export const STATUS_UNKNOWN = null;

/**
 * Is this a value we may treat as an HTTP status we actually observed?
 *
 * ⭐⭐ `0` IS A NUMBER, AND THAT IS THE TRAP. Several transports report `status: 0` to mean "no
 * response" — and a bare `typeof x === "number"` accepts it, after which `0 < 500` reads as a
 * CLIENT ERROR and the caller is told a permanently-bad request was rejected by Circle. That is
 * an absence being promoted to a confident wrong answer, which is worse than the 500 this file
 * exists to remove. The guard suite pins `0` alongside NaN and `"400"`.
 *
 * The range is the real HTTP range: 100–599. Anything outside it was not a status we saw.
 */
function isHttpStatus(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 599;
}

/**
 * Pull the meaningful fields out of whatever a Circle SDK call threw.
 *
 * Handles, in one reader:
 *   • v9  — raw `AxiosError`: detail at `e.response.data`, status at `e.status` (axios sets
 *           `this.status = response.status ? response.status : null`) and at `e.response.status`.
 *   • v10 — typed `HttpResponseError`: status at `e.status`, Circle's code at `e.code`, and the
 *           original body reachable only via the `.error` getter → `e.error.response.data`.
 *   • v10 — typed `HttpRequestError` (transport failed, no response): `e.code` is a string like
 *           "ECONNREFUSED"; there is no status and there is no body.
 *   • anything else — our own `TxPendingError`, a viem error, a plain `Error`. These are not
 *     Circle failures and must not be dressed up as one.
 *
 * ⭐ NEVER THROWS. A reader used only on the error path must not be able to produce a second
 * error; a `.error` getter that threw would otherwise turn a handled failure into a 500.
 *
 * @returns {{status: number|null, code: number|string|null, body: any, message: string,
 *            shape: "axios"|"typed"|"opaque"}}
 *   `status` is `null` — never `undefined` — when it could not be determined, so that "unknown"
 *   is a value the caller must branch on rather than a hole that falls through a truthiness test.
 */
export function readCircleError(e) {
  if (!e || typeof e !== "object") {
    return { status: STATUS_UNKNOWN, code: null, body: null, message: String(e ?? "unknown error"), shape: "opaque" };
  }

  // The body. v9 puts it on the error; v10 hides it one level down behind a getter.
  // ⚠️ The getter is on a class with a `#private` field — reading it on a NON-Circle error could
  // throw, so every access here is defensive.
  let body = null;
  let shape = "opaque";
  try {
    if (e.response && typeof e.response === "object" && "data" in e.response) {
      body = e.response.data ?? null;
      shape = "axios";
    } else if (e.error && typeof e.error === "object" && e.error.response && typeof e.error.response === "object") {
      body = e.error.response.data ?? null;
      shape = "typed";
    }
  } catch {
    body = null;
  }

  // The status. Both shapes expose a top-level numeric `.status` when a response was received;
  // `.response.status` is the fallback for an axios build that predates that field.
  // ⭐ A non-number (undefined, null, "") collapses to STATUS_UNKNOWN rather than to 0 or NaN —
  // [[nan-fail-open-cap-pattern]]: a NaN that survives into a comparison disables the branch.
  let status = STATUS_UNKNOWN;
  try {
    if (isHttpStatus(e.status)) status = e.status;
    else if (isHttpStatus(e.response?.status)) status = e.response.status;
  } catch {
    status = STATUS_UNKNOWN;
  }

  // If we found a status or a body, this came from the SDK's HTTP layer even if neither branch
  // above matched a known container — record that rather than calling it opaque.
  // ⚠️ Defensive for the same reason as above: this touches `e.status` / `e.response` again, and
  // the NEVER-THROWS contract must not depend on the guard above happening to short-circuit first.
  try {
    if (shape === "opaque" && (status !== STATUS_UNKNOWN || body !== null)) {
      shape = typeof e.status === "number" && !e.response ? "typed" : "axios";
    }
  } catch {
    /* shape is diagnostic only — leave it as-is rather than fail the read */
  }

  // Circle's own numeric error code (e.g. 155106 "Invalid signature"). v9 carries it ONLY in the
  // body — `e.code` there is an axios string like "ERR_BAD_RESPONSE". v10 lifts it onto `.code`.
  // ⭐ Reading the BODY first is what makes the two agree: it is the one place both shapes have it.
  let code = null;
  try {
    if (body && typeof body === "object" && body.code !== undefined && body.code !== null) code = body.code;
    else if (typeof e.code === "number" || typeof e.code === "string") code = e.code;
  } catch {
    code = null;
  }

  // Circle's own message beats the transport's. "Invalid signature for transferWithAuthorization"
  // tells a buyer what to fix; "Request failed with status code 400" does not.
  let message = "";
  try {
    message = (body && typeof body === "object" && typeof body.message === "string" && body.message)
      || (typeof e.message === "string" && e.message)
      || "Circle call failed";
  } catch {
    message = "Circle call failed";
  }

  return { status, code, body, message, shape };
}

/**
 * Decide what WE return to the buyer, given the status Circle gave us (or did not).
 *
 * ═══ ⭐⭐ "UNKNOWN" IS ITS OWN BRANCH, AND THAT IS THE POINT ══════════════════════════════════
 * The expression this replaces was `status && status < 500 ? 400 : 500`. That is two branches for
 * three facts, and it puts the most dangerous default in the fall-through:
 *
 *     • a 4xx  → 400. Circle refused the request; the same request will be refused again.
 *     • a 5xx  → 500. Circle's side failed; retrying is reasonable.
 *     • UNKNOWN → 500 as well — indistinguishable from "definitely a server error".
 *
 * 🚨 "I could not determine what happened" and "the server definitely failed" are DIFFERENT FACTS,
 * and collapsing them tells a buyer to retry a payment authorization that may be permanently bad —
 * or worse, one that may ALREADY HAVE SETTLED. That is the same class as the seller's headline
 * rule two files over: `e.broadcast === undefined` means "could not determine", and it is stated
 * rather than guessed. [[absence-must-never-read-as-safe]]
 *
 * ⭐ So unknown gets **502** — distinct on the wire from both 400 and 500, so a caller can tell the
 * three apart — and `retrySafe: null`, which a caller must not read as `true`.
 *
 * @returns {{httpStatus: number, statusKnown: boolean, retrySafe: boolean|null}}
 *   `retrySafe === null` means UNKNOWN. It is never `true` unless we positively know it is.
 */
export function httpStatusForCircleFailure(status) {
  if (!isHttpStatus(status)) {
    // Could not determine — including `0`, NaN and the string "400", none of which are a status
    // we observed. Say so on the wire; promise nothing about retrying.
    return { httpStatus: 502, statusKnown: false, retrySafe: null };
  }
  if (status >= 500) {
    return { httpStatus: 500, statusKnown: true, retrySafe: true };
  }
  // ⭐ 429 is a 4xx that IS retryable — it is the one status where "client error" does not mean
  // "asking again is pointless". The HTTP code we return is unchanged (400, as before) so this
  // commit alters no known-status behaviour; only the advertised `retrySafe` tells the truth.
  return { httpStatus: 400, statusKnown: true, retrySafe: status === 429 };
}
