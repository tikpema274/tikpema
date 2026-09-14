// verify-bridge-balance-preflight.mjs — A BRIDGE THE WALLET CANNOT PAY IS REFUSED BY US, NAMING
// BOTH FIGURES, BEFORE ANYTHING IS PRICED, SEALED, OR SENT TO CIRCLE.
//
// ═══ THE OBSERVATION (2026-09-14) ═════════════════════════════════════════════════════════════
// T asked the agent panel to bridge 5 USDC from a wallet holding 3.65. "Get quote" priced it (the
// IRIS quote never looks at a balance) and SEALED it. The Bridge press built the batched userOp and
// sent it to Circle, which refused pre-broadcast: `INSUFFICIENT_TOKEN`, no txHash. The panel then
// showed Circle's sentence — no "have", no "need" — beside three cleared "—" fields.
//
// Nothing on the agent bridge path checked the balance: not agent-bridge.mjs, not _bridge.mjs, not
// _actions.mjs (grep getBalance|balanceOf|Insufficient: empty), and the panel's amountValid is
// `amountNum > 0` with the balance rendered two lines above. Circle's refusal was the ONLY backstop
// — documented as "the final backstop" (job-bridge-approve), which had quietly become the first.
// agent-send has had the pre-flight since its first version; agent-ub-spend got it in 18c0396.
// [[refusal-reports-compared-quantity]] [[required-figure-rounds-up]]
//
// ⭐ DRIVES THE PURE FUNCTION, not a regex over the sentence. The refusal is a VALUE (status + body);
// assert the value. Wiring (that the handler calls it, on both presses) is asserted on source in §3
// because the handler's other boundaries (session, Circle wallet, IRIS) are not worth mocking for
// three call-site lines. [[assert-on-rendered-output-not-source-regex]]

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 66 - t.length))}`);
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — the pure refusal exists (a missing export is the red state, not a crash)");
let bridgeBalanceRefusal = null;
try {
  ({ bridgeBalanceRefusal } = await import("../netlify/functions/_bridge.mjs"));
} catch (e) {
  console.log(`     import failed: ${e?.message}`);
}
check("⭐ _bridge.mjs exports bridgeBalanceRefusal", typeof bridgeBalanceRefusal === "function",
  typeof bridgeBalanceRefusal);

const call = (args) => (typeof bridgeBalanceRefusal === "function" ? bridgeBalanceRefusal(args) : undefined);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⭐⭐ THE VALUE: 5 from 3.65 to Base, fee 0.0021");
{
  const r = call({ haveUsdc: 3.65, amountUsdc: 5, feeUsdc: 0.0021, destLabel: "Base (Sepolia)" });
  check("🚨 refused", !!r, r ? `status ${r.status}` : "returned nothing");
  check("⭐ status 402 — a client condition, not a fault", r?.status === 402, `status ${r?.status}`);
  check("⭐ the sentence names HAVE 3.65", /3\.65/.test(r?.body?.error ?? ""), r?.body?.error);
  check("⭐ …and NEED, which is amount + fee = 5.0021, rounded UP", /5\.0021/.test(r?.body?.error ?? ""));
  check("⭐ …and says no funds moved and nothing was quoted", /No funds moved/.test(r?.body?.error ?? "") && /not(hing was)? quoted/i.test(r?.body?.error ?? ""));
  check("⭐ `error` AND `blocked` carry the sentence (the client throws on r.body.error for a non-2xx; the panel renders blocked)",
    r?.body?.error && r?.body?.blocked === r?.body?.error);
  check("⭐ outcome is the client's known discriminator `quote_failed`, quoted:false, executed:false",
    r?.body?.outcome === "quote_failed" && r?.body?.quoted === false && r?.body?.executed === false);
  check("⭐ have / need ride as numbers", r?.body?.have === 3.65 && Math.abs(r?.body?.need - 5.0021) < 1e-9, `have ${r?.body?.have} need ${r?.body?.need}`);
}

section("2b — the boundary: exactly enough passes; a hair short does not");
{
  check("⭐ have == amount + fee → allowed (null)", call({ haveUsdc: 5.0021, amountUsdc: 5, feeUsdc: 0.0021, destLabel: "Base" }) === null);
  const r = call({ haveUsdc: 5.002099, amountUsdc: 5, feeUsdc: 0.0021, destLabel: "Base" });
  check("⭐ one micro-USDC short → refused", r?.status === 402);
  check("⭐ …and the rendered NEED is not rounded BELOW the real need (5.0021, not 5.00)", /5\.0021/.test(r?.body?.error ?? ""), r?.body?.error);
  const r2 = call({ haveUsdc: 5.0020999, amountUsdc: 5, feeUsdc: 0.0021, destLabel: "Base" });
  // ⛔ A NEGATIVE OVER AN ABSENT STRING PASSES VACUOUSLY — require the refusal first, then the absence.
  check("⭐ …and the rendered HAVE is not rounded ABOVE the real balance (5.0020, not 5.0021)",
    r2?.status === 402 && /have 5\.0020/.test(r2?.body?.error ?? "") && !/have 5\.0021/.test(r2?.body?.error ?? ""), r2?.body?.error);
}

section("2c — before pricing, the fee is unknown: amount alone is a lower bound and still refuses");
{
  const r = call({ haveUsdc: 3.65, amountUsdc: 5, feeUsdc: null, destLabel: "Base" });
  check("⭐ have < amount with no fee → refused", r?.status === 402);
  check("⭐ the sentence says 'at least' the amount, and does not invent a fee figure", /at least 5/.test(r?.body?.error ?? "") && !/\+ ~/.test(r?.body?.error ?? ""), r?.body?.error);
  check("⭐ have ≥ amount with no fee → allowed (the fee check comes after pricing)", call({ haveUsdc: 5, amountUsdc: 5, feeUsdc: null, destLabel: "Base" }) === null);
}

section("2d — ⛔ an UNREAD balance is not a refusal and not a pass — it is null, and the caller says so");
{
  check("⭐ haveUsdc null → null (caller marks balanceChecked:false; Circle's backstop remains)", call({ haveUsdc: null, amountUsdc: 5, feeUsdc: 0.0021, destLabel: "Base" }) === null);
  check("⭐ haveUsdc NaN → null too (NaN < need is false — never let it read as 'enough')", call({ haveUsdc: NaN, amountUsdc: 5, feeUsdc: 0.0021, destLabel: "Base" }) === null);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — THE WIRING: agent-bridge.mjs reads the balance and refuses on BOTH presses");
const src = readFileSync("netlify/functions/agent-bridge.mjs", "utf8");
check("⭐ the handler reads balanceOf(walletAddress) on the agent SCA (6-dp ERC-20 view, like agent-send)",
  /functionName:\s*"balanceOf"[\s\S]{0,80}args:\s*\[walletAddress\]/.test(src));
check("⭐ …at TOKEN decimals", /formatUnits\([^)]*,\s*USDC_DECIMALS\)/.test(src));
check("⭐ the quote path calls bridgeBalanceRefusal AFTER pricing with the fee (amount + fee is the debit under upfront fees)",
  /bridgeBalanceRefusal\(\{[^}]*feeUsdc:\s*fee\.feeUsdc/.test(src));
check("⭐ the quote path also refuses BEFORE pricing on amount alone (no IRIS call for a wallet that cannot pay the amount)",
  /bridgeBalanceRefusal\(\{[^}]*feeUsdc:\s*null/.test(src));
check("⭐ the execute press refuses on amount alone before executeAction",
  (() => { const i = src.indexOf("bridgeBalanceRefusal("); const j = src.indexOf("executeAction("); return i > 0 && j > 0 && i < j; })());
check("⭐ the quote body says whether the balance was checked — balanceChecked is a boolean, true in every case it is true",
  /balanceChecked:\s*[a-zA-Z!=]+/.test(src));

console.log(`\n${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail ? 1 : 0);
