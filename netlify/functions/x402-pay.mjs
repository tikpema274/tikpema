// x402-pay.mjs — thin HTTP wrapper around the x402 BUYER core (_x402.mjs).
//
// This standalone function makes the agent pay an x402 Gateway-batched seller and
// return the 200 content + settle receipt. It is the mirror image of x402-quote.mjs
// (the seller). The buyer logic — 402 → guard → sign (delegate EOA) → settle — now
// lives in _x402.mjs so Phase 2's research engine can call payX402() directly as a
// function; this wrapper just parses the request and re-emits the result over HTTP.
//
// Synchronous (NOT -background): the buyer holds the connection open across the
// 402 → pay → 200 round trip.
//
// NOTE: not wired into agent-act.mjs / the research engine yet — this proves the
// buyer path in isolation.
//
// Input (POST body): { url? } — optional seller override; defaults to our seller.
// Output: the payX402 structured result at its HTTP status (unchanged behavior).

import { json, parseBody } from "./_arc.mjs";
import { payX402 } from "./_x402.mjs";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const body = parseBody(event);
  const { status, body: result } = await payX402({ sellerUrl: body.url });
  return json(status, result);
}
