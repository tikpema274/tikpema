// version.mjs — WHICH x402 PROTOCOL VERSION DO OUR SELLERS SPEAK? One constant, because the
// number was previously a literal at five call sites and drifted at every one of them.
//
// ═══ ⭐ THE NUMBER IS NOT A PREFERENCE — IT IS FORCED BY THE TRANSPORT ═══════════════════════════
// The spec pins it both ways: x402-specification-v1.md says "Protocol version identifier (must be
// 1)", v2 says "(must be 2)". So the value is decided by which transport an endpoint actually
// implements, never by what a validator wants to see. The two transports differ on the wire:
//
//               v1 (transports-v1/http.md)        v2 (transports-v2/http.md)
//   challenge   JSON body is the protocol         PAYMENT-REQUIRED header is the protocol
//               surface; NO header exists         ("response bodies are a server
//                                                  implementation concern")
//   client hdr  X-PAYMENT                         PAYMENT-SIGNATURE
//   payload     {x402Version, scheme, network,    {x402Version, resource, accepted, payload}
//                payload}
//   network     name ("base-sepolia")             CAIP-2 ("eip155:8453")
//   amount      maxAmountRequired                 amount
//
// dd-analyze and x402-quote are v2 on EVERY load-bearing axis: they emit PAYMENT-REQUIRED, they
// read `payment-signature` (dd-analyze.mjs:208, x402-quote.mjs:165), they use CAIP-2 networks, and
// the payload our own buyer sends is the v2 envelope (_x402.mjs:367).
//
// ═══ 🚨 WHY DECLARING 1 WAS A CORRECTNESS DEFECT, NOT A COSMETIC ONE ════════════════════════════
// These endpoints declared x402Version: 1 while reading only `payment-signature`. An HONEST,
// spec-compliant v1 client believes the declaration, sends X-PAYMENT — the header v1 mandates —
// and the endpoint never looks at it. It re-issues the challenge. The client reads the same
// "version 1", retries the same way, and 402-LOOPS FOREVER. It can never pay us, and nothing in
// the response tells it why. We advertised a protocol we do not implement.
//
// ⭐ MEASURED AGAINST PROD before the fix (three probes, valid subject, no money at risk —
// signature was 65 zero bytes from a burn address, so no authorization existed):
//   A  no payment header          → 402, keys [error,accepts,howToCall,subjectPreview,…]
//   B  v1 X-PAYMENT               → 402, BYTE-IDENTICAL TO A. The header was never read.
//   C  v2 PAYMENT-SIGNATURE       → 402 by a DIFFERENT PATH: it decoded, reached the facilitator,
//                                   and Circle Gateway returned
//                                   "paymentPayload.resource: Required, paymentPayload.accepted:
//                                    Required"
// B-vs-C is the discriminator: identical-to-control proves X-PAYMENT is ignored, and C proves
// `payment-signature` is the header that is honoured. ⭐⭐ C also shows CIRCLE'S OWN FACILITATOR
// REQUIRES THE v2 PAYLOAD SHAPE (`resource` + `accepted`) — so the settlement backend we actually
// pay through is v2 too. Three independent instruments, one answer.
//
// ═══ ⚠️ WHY x402-vanilla-seller.mjs DOES NOT IMPORT THIS ════════════════════════════════════════
// It is inconsistent in the OPPOSITE direction — declares 2 while reading `x-payment`
// (x402-vanilla-seller.mjs:282) — and its buyer _x402-vanilla.mjs:200 sends X-PAYMENT to match.
// The pair is internally consistent on the wire and proven against real money. Correcting either
// half alone breaks a settled path, so it is LEFT INCONSISTENT AND RECORDED, not "fixed".
// 🚨 Do not "tidy" it by importing this constant. That would change the number without changing
// the header, which is precisely the defect this file exists to describe.
export const X402_VERSION = 2;
