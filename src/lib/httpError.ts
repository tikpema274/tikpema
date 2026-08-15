// httpError — throw an Error that KEEPS the response body.
//
// ⭐⭐ WHY THIS EXISTS. A vault gate refusal is a 409 whose body carries the FRESH `disclosure`, put
// there deliberately so the UI can show what must be acknowledged. The client did
// `throw new Error(data?.error)` — keeping a string and discarding the structure — so that
// capability had no consumer, and a user whose acknowledgement had been invalidated got a bare
// refusal with no way to see what changed.
//
// ⚠️ ADDITIVE, NEVER A REPLACEMENT. Every existing caller reads `e.message` and keeps working; the
// body rides alongside. Extracted as a function rather than written inline so the behaviour can be
// TESTED rather than grepped for — "the string appears" is not "the call happens".
export function errorWithPayload(data: any, fallback: string): Error & { payload?: any } {
  const err = new Error(data?.error || fallback) as Error & { payload?: any };
  err.payload = data;
  return err;
}
