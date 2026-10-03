// swap-no-route.mjs — a swap that fails BEFORE ANYTHING IS SUBMITTED, said in our words, ONCE.
//
// ═══ ⭐ WHY THIS EXISTS (2026-10-03) ═══════════════════════════════════════════════════════════
// The first external user tried a 0.2 USDC → EURC agent swap and got
//     createSwap HTTP 404: {"code":331001,"message":"No route available"}
// rendered verbatim, and concluded "agent not working". T confirmed it live on T's own wallet the same
// day: Circle offered no route for USDC↔EURC on Arc testnet at any amount, either direction. Every line
// above the swap button is careful copy; the failure was a raw provider JSON blob — the one thing on the
// page we would never write ourselves.
//
// TWO SENTENCES, and they must not read alike (T):
//   • NO ROUTE (Circle's 404 / 331001): a known condition. Says what happened and what the user can do.
//   • QUOTE FAILED (any other createSwap failure): an UNRECOGNISED fault. Says so, and carries a DETAILS
//     line with Circle's raw status / code / message and the time — something a user can quote and support
//     can look up. It never borrows the no-route wording.
//
// ⛔⛔ THE BOUNDARY: BOTH SENTENCES SAY "nothing was charged". That is TRUE ONLY AT THE QUOTE STAGE — before
// the swap is submitted (at most a standing approval has landed, and its gas is sponsored: measured on the
// first external user's wallet, 2.1 in − 2.0 out = 0.1 left, exactly). AFTER SUBMISSION WE DO NOT KNOW
// WHAT MOVED. So quoteStageError() REFUSES to build either sentence unless the caller says it is still at
// the quote stage, and agentSwap flips its `stage` to "submitted" on the line before the submit. A failure
// after that keeps its existing path; test:swapnoroute enforces the ordering in the source.
//
// ⛔ NEITHER SENTENCE promises the swap will work later (we cannot establish that: the August drought lasted
// weeks and Circle has not said why either outage happened), blames the user, or says "temporary".

/** Circle's error code for "no route" on the Stablecoin Kits swap endpoint (measured 2026-08 and 2026-10-03). */
export const SWAP_NO_ROUTE_CODE = 331001;
/** The only stage at which these sentences may be used. */
export const QUOTE_STAGE = "quote";

/** Which wallet the swap was for. "agent": the user's agent wallet (agentSwap — approves, then quotes).
 *  "user": the user's OWN wallet (buildSwapCallData → user-swap-start — we only quote; the user signs). */
export const SWAP_PATHS = Object.freeze(["agent", "user"]);

/**
 * Is this createSwap response Circle's no-route answer? Exactly 404 + code 331001. Anything else is NOT
 * no-route: an unrecognised failure must never be dressed up as the known one.
 */
export function isNoRouteResponse(status, bodyText) {
  if (status !== 404) return false;
  try {
    const j = JSON.parse(bodyText);
    return Number(j?.code) === SWAP_NO_ROUTE_CODE;
  } catch {
    return false;
  }
}

/** 6-dp base units → "25" / "0.5" / "12.345678" (no trailing zeros, never rounded). */
function human6(base) {
  const v = BigInt(base);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const utcStamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ") + " UTC";

function checkArgs({ path, approval }) {
  if (!SWAP_PATHS.includes(path)) throw new Error(`swap-no-route: unknown path ${JSON.stringify(path)}`);
  if (path === "user" && approval) throw new Error("swap-no-route: the user path never approves; an approval here is a bug");
}

/** The sentence about nothing having happened, per wallet. Shared by both messages: it is the same fact. */
function nothingHappened(path, tokenIn) {
  return path === "agent"
    ? `Nothing was swapped, nothing was charged, and no funds left your agent wallet. Your ${tokenIn} is still there and you can send or withdraw it as usual.`
    : "Nothing was signed, nothing was swapped, nothing was charged, and no funds left your wallet.";
}

function approvalSentence(approval) {
  return approval
    ? `To prepare the swap, your agent wallet approved Circle's swap contract to spend up to ${human6(approval.amountBase)} ${String(approval.token).toUpperCase()}. That approval stays in place for future swaps; no funds moved under it.`
    : null;
}

/**
 * NO ROUTE. `approval` is { amountBase, token } ONLY when an approval LANDED during THIS attempt (agentSwap
 * knows: it waited for it); null otherwise — a standing allowance from an earlier swap is not news, and an
 * approval that did not happen must never be described.
 */
export function noRouteMessage({ tokenIn, tokenOut, approval = null, path = "agent" }) {
  checkArgs({ path, approval });
  const a = String(tokenIn).toUpperCase();
  const b = String(tokenOut).toUpperCase();
  const who = path === "agent" ? "Your agent asked" : "We asked";
  return [
    `No swap route right now. ${who} Circle, which provides swaps on Arc testnet, for a ${a} → ${b} route, and none was offered.`,
    nothingHappened(path, a),
    approvalSentence(approval),
    "You can try again later. If there is still no route, you'll see this message again, and nothing will be charged.",
    `Swaps between ${a} and ${b} on Arc testnet have been unavailable before, sometimes for weeks, and we can't tell when they will return.`,
  ].filter(Boolean).join(" ");
}

/**
 * The DETAILS line: what Circle actually said, labelled as such, plus the time. Provider text is allowed
 * HERE and nowhere else in either sentence. Rendered as text by the panels (never as HTML).
 */
export function supportDetails({ status, bodyText, at }) {
  let code = null, msg = null;
  try {
    const j = JSON.parse(bodyText);
    if (j && typeof j === "object") { code = j.code ?? null; msg = typeof j.message === "string" ? j.message : null; }
  } catch {}
  const clean = (s, n) => String(s).replace(/\s+/g, " ").trim().slice(0, n);
  const parts = [status != null ? `createSwap HTTP ${status}` : "createSwap"];
  if (code !== null) parts.push(`code ${clean(code, 40)}`);
  if (msg) parts.push(`"${clean(msg, 120)}"`);
  else if (code === null && bodyText) parts.push(`"${clean(bodyText, 80)}"`);
  parts.push(utcStamp(at));
  return `Details for support: ${parts.join(" · ")}.`;
}

/** QUOTE FAILED: any createSwap failure that is not no-route. Never borrows the no-route wording. */
export function quoteFailedMessage({ tokenIn, approval = null, path = "agent", status = null, bodyText = "", at = Date.now(), malformed = false }) {
  checkArgs({ path, approval });
  const a = String(tokenIn).toUpperCase();
  return [
    malformed
      ? "The swap could not be prepared: Circle's reply to the quote request could not be read."
      : "The swap could not be prepared: Circle returned an error we don't recognise.",
    nothingHappened(path, a),
    approvalSentence(approval),
    "You can try again. If it keeps happening, quote the details below when you contact us.",
    supportDetails({ status, bodyText, at }),
  ].filter(Boolean).join(" ");
}

/** Base: a swap failure classified at the QUOTE stage. `message` IS the user-facing sentence. */
export class SwapQuoteStageError extends Error {
  constructor(message, { kind, tokenIn, tokenOut, approval, path }) {
    super(message);
    this.swapQuoteStage = true;
    this.kind = kind;
    this.path = path;
    this.tokenIn = String(tokenIn).toUpperCase();
    this.tokenOut = String(tokenOut).toUpperCase();
    this.approval = approval ? { amountBase: String(approval.amountBase), token: String(approval.token).toUpperCase() } : null;
  }
}
export class SwapNoRouteError extends SwapQuoteStageError {
  constructor({ tokenIn, tokenOut, approval = null, path = "agent" }) {
    super(noRouteMessage({ tokenIn, tokenOut, approval, path }), { kind: "no-route", tokenIn, tokenOut, approval, path });
    this.name = "SwapNoRoute";
    this.swapNoRoute = true;
  }
}
export class SwapQuoteFailedError extends SwapQuoteStageError {
  constructor({ tokenIn, tokenOut, approval = null, path = "agent", status = null, bodyText = "", at = Date.now(), malformed = false }) {
    super(quoteFailedMessage({ tokenIn, approval, path, status, bodyText, at, malformed }), { kind: "quote-failed", tokenIn, tokenOut, approval, path });
    this.name = "SwapQuoteFailed";
    this.swapQuoteFailed = true;
    this.status = status;
  }
}

/**
 * ⛔ THE ONLY WAY TO BUILD EITHER ERROR, and it refuses after submission. `stage` is the caller's live stage
 * variable; anything but "quote" is a programmer error — the sentence would claim nothing was charged when
 * nobody knows. Returns the error for the caller to throw.
 */
export function quoteStageError({ stage, status = null, bodyText = "", tokenIn, tokenOut, approval = null, path = "agent", malformed = false }) {
  if (stage !== QUOTE_STAGE) {
    // ⚠️ This refusal must not itself contain the guarded phrase: if it ever reached a user, it would say the very thing it refuses.
    throw new Error(`quoteStageError: called at stage ${JSON.stringify(stage)}; the quote-stage sentences assert that no charge was made, which is unknown once a swap is submitted`);
  }
  if (!malformed && isNoRouteResponse(status, bodyText)) return new SwapNoRouteError({ tokenIn, tokenOut, approval, path });
  return new SwapQuoteFailedError({ tokenIn, tokenOut, approval, path, status, bodyText, malformed });
}
