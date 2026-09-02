// verify-bridge-response-seam.tsx — THE WIRE BETWEEN THE PANEL AND THE SERVER.
//
//   npx tsx scripts/verify-bridge-response-seam.tsx
//
// ═══ 🚨 THE GAP THIS CLOSES, AND WHY THE OTHER SUITE COULD NOT SEE IT ══════════════════════════
// verify-bridge-fee-binding.mjs proves the SERVER end to end — a sealed quote goes in, the correct
// maxFee comes out of the real calldata — and it passed while "Get quote" was completely broken in
// production. It calls executeAction directly and never crosses the client seam, so the one line
// that threw away every successful quote was invisible to it.
//
// ⭐ THE FAILURE WAS ONE LINE: `if (data?.executed === false) throw new Error(... "Bridge did not
// execute")`. A successful quote IS `executed: false` — nothing executed, deliberately — so the
// client discarded a working response and reported the EXECUTE path's error on a button that does
// not execute. Balance unchanged, no quote, no reason.
//
// ⭐⭐ SO THIS TESTS THE SHAPES, NOT THE HAPPY PATH. Every response /api/agent-bridge can return is
// fed in verbatim, including one it has never returned — because the property that matters is what
// happens to a shape the client does not know.

import { interpretBridgeResponse } from "../src/wallet/bridgeResponse";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } return !!c; };
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

const threw = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e: any) { return e?.message ?? "?"; } };

// ⭐ THE REAL SHAPE, copied from agent-bridge.mjs — a quote for 1 USDC to Base at band `none`.
const QUOTED = {
  outcome: "quoted", executed: false, quoted: true,
  quote: { amountUsdc: 1, destination: { key: "base", label: "Base (Sepolia)" },
    feeUsdc: 0.054147, netUsdc: 0.945853, band: "none", feeRatio: 0.054147,
    expiresInMs: 180000,
    // ⚠️ CONSTRUCTED, NOT A LITERAL. A sealed quote is `base64url(payload).mac`, which is the exact
    // shape of a JWT — written out it trips the pre-commit scanner as `generic-api-key`, and it did
    // (blocking the commit that carried this file). ⭐ Building it removes the FINDING rather than
    // silencing it: a .gitleaksignore entry here would also cover whatever real secret this file
    // might grow later. Same reasoning as verify-receipt-fee-authority.mjs:45.
    // ⛔ The VALUE is irrelevant to this suite — it never opens the token, only checks it survives
    // the seam intact. Nothing here verifies a MAC.
    quoteToken: [Buffer.from(JSON.stringify({ test: 1 })).toString("base64url"), "notarealmac"].join("."),
  },
};

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  BRIDGE RESPONSE SEAM — every shape the endpoint can return          ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("1 — 🚨 A SUCCESSFUL QUOTE MUST NOT THROW (the production defect)");
{
  const err = threw(() => interpretBridgeResponse(QUOTED));
  check("⭐⭐ a quote response does NOT throw", err === null, err ?? "returned cleanly");
  // 🚨 THE EXACT STRING THE USER SAW. Named so a regression is recognisable, not just red.
  check("🚨 …and specifically not with the EXECUTE path's error",
    err === null || !/did not execute/i.test(err), err ?? "-");
  // ⚠️ GUARDED. Called bare, this THREW under the old logic and killed the process — the suite
  // reported 2 reds and then died, so sections 2-4 never ran and could not be shown to
  // discriminate. A red-first validation that aborts on the first failure characterises nothing.
  // [[control-needs-ownership-and-stability]]
  let r: any = null;
  try { r = interpretBridgeResponse(QUOTED); } catch { /* reported by the checks above */ }
  check("⭐ it is classified as a QUOTE, not an execution", r?.kind === "quoted", r?.kind ?? "threw");
  check("⭐ …and the quote survives intact for the panel to render",
    r?.data?.quote?.feeUsdc === 0.054147 && r?.data?.quote?.netUsdc === 0.945853,
    r ? "fee and net reach the caller" : "nothing reached the caller");
}

section("2 — ⭐ EVERY OTHER SHAPE IS CLASSIFIED, NOT GUESSED");
{
  // ⚠️ Each wrapped for the same reason — one throwing case must not hide the others' verdicts.
  const kindOf = (d: any) => { try { return interpretBridgeResponse(d).kind; } catch (e: any) { return `threw: ${e?.message}`; } };
  check("needs_ack is returned, not thrown",
    kindOf({ outcome: "needs_ack", executed: false, feeDisclosure: { ackToken: "t" } }) === "needs_ack",
    kindOf({ outcome: "needs_ack", executed: false, feeDisclosure: { ackToken: "t" } }));
  check("an executed burn is an execution",
    kindOf({ outcome: "executed", executed: true, burnHash: "0x1" }) === "executed");
  check("a 202 pending burn is also an execution",
    kindOf({ outcome: "pending", executed: true, pending: true }) === "executed");
}

section("3 — ⚠️ THE ERROR NAMES THE FAILURE THAT HAPPENED");
{
  const qf = threw(() => interpretBridgeResponse({ outcome: "quote_failed", blocked: "amount too small — nothing would arrive" }));
  check("⭐ a failed QUOTE reports the quote's reason", /nothing would arrive/.test(qf ?? ""), qf ?? "-");
  check("⛔ …and never says a burn did not execute", !/did not execute/i.test(qf ?? ""), qf ?? "-");

  const qfBare = threw(() => interpretBridgeResponse({ outcome: "quote_failed" }));
  check("⭐ a reasonless quote failure still says the QUOTE failed", /price this bridge|no quote/i.test(qfBare ?? ""), qfBare ?? "-");

  const bl = threw(() => interpretBridgeResponse({ outcome: "blocked", blocked: "over your per-bridge cap" }));
  check("⭐ a guard refusal reports the guard's reason", /per-bridge cap/.test(bl ?? ""), bl ?? "-");
  const blBare = threw(() => interpretBridgeResponse({ outcome: "blocked" }));
  check("⭐ …and a reasonless refusal SAYS it gave no reason", /gave no reason/i.test(blBare ?? ""), blBare ?? "-");
}

section("4 — ⭐⭐ AN UNKNOWN SHAPE FAILS LOUDLY, AND DOES NOT ASSERT A NON-EVENT");
{
  // 🚨 THE WHOLE REASON FOR A DISCRIMINATOR. A fifth outcome added server-side without a client
  // branch must not be described as a burn that did not happen — the client knows nothing about it,
  // and that is the only true thing it can say. A third `if` would have produced the old lie here.
  for (const [label, shape] of [
    ["a FUTURE outcome the client has never seen", { outcome: "refunded", executed: false }],
    ["a response with NO outcome at all", { executed: false, blocked: "x" }],
    ["an empty body", {}],
    ["null", null],
  ] as [string, any][]) {
    const e = threw(() => interpretBridgeResponse(shape));
    check(`⭐ ${label} throws`, e !== null);
    check(`   …and says it is UNRECOGNISED, not that a burn failed`,
      /Unrecognised/i.test(e ?? "") && !/did not execute/i.test(e ?? ""), (e ?? "").slice(0, 70));
  }
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0`);
console.log(`⭐ A quote is a quote, a refusal names its reason, and an unknown shape says so.\n`);
