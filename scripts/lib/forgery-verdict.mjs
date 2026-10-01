// forgery-verdict.mjs — the DECISIONS of gate:forgery (scripts/verify-ack-forgery.mjs), pure, so a suite can call them.
//
// ═══ ⭐ WHY THE PROBE AMOUNT IS DERIVED, NOT FIXED (2026-10-01) ══════════════════════════════════════════════
// The acknowledge gate only exists for a bridge step whose fee is ≥ FEE_BAND_ACKNOWLEDGE (25%) of the amount, and
// the fee floor refuses outright when fee ≥ amount. So the probe reaches the gate only while 0.25 ≤ fee/amount < 1.
// A FIXED 0.06 held for weeks at fee ≈ 0.0543 (90%), then the Base fee moved to ≈ 0.0649 and the probe was refused
// by the floor before any band existed (deploy 6abe1aca). Any fixed amount has the same edge. So each run reads the
// LIVE fee at a reference amount (quoteOnly — executes nothing) and probes at fee / TARGET_RATIO: 60%, which
// survives a fee move of −58% / +67% between the two quotes. Bounded above by MAX_PROBE_USDC: past it the run is
// UNTESTED (red), never a bigger probe — the amount is what a BROKEN gate would spend.
//
// ═══ ⭐⭐ THREE VERDICTS, AND ONLY ONE IS GREEN ═════════════════════════════════════════════════════════════
//   PASS      the forged token reached the comparison and was refused; the served token is keyed.
//   FAIL      the property is violated or the outcome is unexplained — including the probe SPENDING.
//   UNTESTED  prod refused the probe BEFORE the comparison (fee floor, price unavailable, a cap, no seal, wrong
//             band). The gate was not examined. RED — "could not look" is never "looked and it was fine" — but a
//             DIFFERENT red from FAIL, named in the log line so a later reader of a deploy log can tell which.

export const TARGET_RATIO = 0.6;
export const BAND_ACKNOWLEDGE = 0.25;   // mirrors netlify/functions/_bridge.mjs FEE_BAND_ACKNOWLEDGE (pinned by the suite)
export const MAX_PROBE_USDC = 0.25;
export const REFERENCE_AMOUNT_USDC = 1; // fee ≈ 6% of this today → band below acknowledge → quoteOnly, nothing to ack
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, UNTESTED: 3 });

const fmt = (x) => (typeof x === "string" ? x : JSON.stringify(x));

/** The probe amount from a live fee: fee / TARGET_RATIO, rounded UP to 4 dp (the ratio only moves down, toward 60%). */
export function probeAmountFromFee(feeUsdc) {
  const fee = Number(feeUsdc);
  if (!Number.isFinite(fee) || fee <= 0) return { ok: false, why: `no usable fee from the reference quote (fee=${fmt(feeUsdc)})` };
  const amountUsdc = Math.ceil((fee / TARGET_RATIO) * 1e4) / 1e4;
  if (amountUsdc > MAX_PROBE_USDC) {
    return { ok: false, why: `fee ${fee} needs a ${amountUsdc} USDC probe, above the ${MAX_PROBE_USDC} ceiling` };
  }
  const ratio = fee / amountUsdc;
  if (!(ratio >= BAND_ACKNOWLEDGE && ratio < 1)) return { ok: false, why: `derived ratio ${ratio} is outside [${BAND_ACKNOWLEDGE}, 1)` };
  return { ok: true, amountUsdc, ratio };
}

/** The reference quote (step 0): it must be a requote with a numeric fee, and must NOT have executed. */
export function readReferenceFee(status, body) {
  if (body?.executed !== false) return { ok: false, verdict: "FAIL", why: `the reference quote did not report executed=false (executed=${fmt(body?.executed)})` };
  if (typeof body?.blocked === "string") return { ok: false, verdict: "UNTESTED", why: `reference quote refused: ${body.blocked}` };
  const fee = body?.stepDisclosures?.[0]?.feeUsdc;
  if (status !== 200 || body?.requoted !== true || !Number.isFinite(Number(fee))) {
    return { ok: false, verdict: "UNTESTED", why: `reference quote unusable: HTTP ${status}, requoted=${fmt(body?.requoted)}, fee=${fmt(fee)}` };
  }
  return { ok: true, feeUsdc: Number(fee) };
}

/** Step 1 (quoteOnly at the probe amount): step 2 may be sent ONLY on a sealed acknowledge-band quote. */
export function step1Reached(status, body) {
  const d = body?.stepDisclosures?.[0];
  if (body?.executed !== false) return { reached: false, verdict: "FAIL", why: `step 1 did not report executed=false (executed=${fmt(body?.executed)})` };
  if (typeof body?.blocked === "string") return { reached: false, verdict: "UNTESTED", why: `step 1 refused before the gate: ${body.blocked}` };
  if (status === 200 && body?.requoted === true && typeof d?.quoteToken === "string" && d?.band === "acknowledge") {
    return { reached: true, disclosure: d };
  }
  return { reached: false, verdict: "UNTESTED",
    why: `step 1 gave no sealed acknowledge-band quote: HTTP ${status}, requoted=${fmt(body?.requoted)}, band=${fmt(d?.band)}, sealed=${typeof d?.quoteToken === "string"}` };
}

/** Step 2 (the seal + the FORGED token): the property, or why it was not examined. */
export function step2Verdict(status, body, { forged, disclosure }) {
  if (body?.executed === true) return { verdict: "FAIL", why: "CRITICAL: executed=true on a FORGED token — the executor was entered past the gate (read stepsRun; `executed` is a literal, not proof money moved)" };
  if (body?.executed !== false) return { verdict: "FAIL", why: `step 2 did not report executed=false (executed=${fmt(body?.executed)}, HTTP ${status})` };
  if (body?.needsAck === true) {
    const served = (body?.stepDisclosures?.[0] ?? disclosure)?.ackToken;
    if (typeof served !== "string") return { verdict: "FAIL", why: "the forged token was refused but the server issued no token to compare" };
    if (served === forged) return { verdict: "FAIL", why: "the server-issued token EQUALS the publicly computable one — the key is not live" };
    return { verdict: "PASS", why: `forged token refused; served ${served.slice(0, 12)}… ≠ forged ${forged.slice(0, 12)}…` };
  }
  if (typeof body?.blocked === "string") return { verdict: "UNTESTED", why: `step 2 refused before the comparison: ${body.blocked}` };
  return { verdict: "FAIL", why: `step 2 neither asked for an acknowledgement nor said why (HTTP ${status})` };
}

/** The one line a deploy log keeps. Greppable: `gate:forgery VERDICT=`. */
export const verdictLine = (verdict, why) => `gate:forgery VERDICT=${verdict} — ${why}`;
