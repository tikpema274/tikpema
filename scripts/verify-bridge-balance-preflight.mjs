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
const M = (usdc) => BigInt(Math.round(usdc * 1e6));
const one = (haveUsdc, amountUsdc, feeUsdc, destLabel = "Base (Sepolia)") =>
  call({ haveMinor: haveUsdc == null ? haveUsdc : M(haveUsdc), steps: { amountMinor: M(amountUsdc), feeMinor: feeUsdc == null ? null : M(feeUsdc), destLabel } });

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⭐⭐ THE VALUE: 5 from 3.65 to Base, fee 0.0021 — compared in MINOR units, rendered at 6 dp");
{
  const r = one(3.65, 5, 0.0021);
  check("🚨 refused", !!r, r ? `status ${r.status}` : "returned nothing");
  check("⭐ status 402 — a client condition, not a fault", r?.status === 402, `status ${r?.status}`);
  check("⭐ the sentence names HAVE at full 6 dp — 3.650000", /have 3\.650000 USDC/.test(r?.body?.error ?? ""), r?.body?.error);
  check("⭐ …and NEED = amount + fee = 5.002100 at full 6 dp", /need 5\.002100 USDC/.test(r?.body?.error ?? ""));
  check("⭐ …and says no funds moved and nothing was quoted", /No funds moved/.test(r?.body?.error ?? "") && /nothing was quoted/i.test(r?.body?.error ?? ""));
  check("⭐ `error` AND `blocked` carry the sentence (client throws on r.body.error for a non-2xx; the panel renders blocked)",
    r?.body?.error && r?.body?.blocked === r?.body?.error);
  check("⭐ outcome is the client's known discriminator `quote_failed`, quoted:false, executed:false",
    r?.body?.outcome === "quote_failed" && r?.body?.quoted === false && r?.body?.executed === false);
  check("⭐ have / need ride as numbers; insufficient:true is the structural flag (NOT priceUnavailable)",
    r?.body?.have === 3.65 && Math.abs(r?.body?.need - 5.0021) < 1e-9 && r?.body?.insufficient === true && !r?.body?.priceUnavailable, `have ${r?.body?.have} need ${r?.body?.need}`);
}

section("2b — the boundary, in minor units: exactly enough passes; ONE micro-USDC short does not");
{
  check("⭐ have == amount + fee → allowed (null)", one(5.0021, 5, 0.0021) === null);
  const r = call({ haveMinor: 5_002_099n, steps: { amountMinor: 5_000_000n, feeMinor: 2_100n, destLabel: "Base" } });
  check("⭐ one micro-USDC short → refused", r?.status === 402);
  check("⭐ …and the rendered NEED is the real need at 6 dp (5.002100), never rounded below it", /need 5\.002100/.test(r?.body?.error ?? ""), r?.body?.error);
  // ⛔ A NEGATIVE OVER AN ABSENT STRING PASSES VACUOUSLY — require the refusal first, then the figure.
  check("⭐ …and the rendered HAVE is the real balance at 6 dp (5.002099), never rounded above it",
    r?.status === 402 && /have 5\.002099 USDC/.test(r?.body?.error ?? "") && !/have 5\.002100/.test(r?.body?.error ?? ""), r?.body?.error);
}

section("2c — before pricing, the fee is unknown: amount alone is a lower bound and still refuses");
{
  const r = one(3.65, 5, null);
  check("⭐ have < amount with no fee → refused", r?.status === 402);
  check("⭐ the sentence says 'at least' the amount, and does not invent a fee figure", /at least 5 USDC/.test(r?.body?.error ?? "") && !/\+ ~/.test(r?.body?.error ?? ""), r?.body?.error);
  check("⭐ have ≥ amount with no fee → allowed (the fee check comes after pricing)", one(5, 5, null) === null);
}

section("2d — ⛔ an UNREAD balance is not a refusal and not a pass — it is null, and the caller says so");
{
  check("⭐ haveMinor null → null (caller marks balanceChecked:false; Circle's backstop remains)", one(null, 5, 0.0021) === null);
  check("⭐ haveMinor undefined → null too", call({ haveMinor: undefined, steps: { amountMinor: 5_000_000n, feeMinor: 2_100n, destLabel: "Base" } }) === null);
  check("⭐ an unparsable haveMinor → null, never 'enough'", call({ haveMinor: "not-a-number", steps: { amountMinor: 5_000_000n, feeMinor: 2_100n, destLabel: "Base" } }) === null);
}

section("2e — ⭐ PLAN scope: the sum of every bridge step's debit, refused as a WHOLE");
{
  const r = call({ haveMinor: 3_650_000n, scope: "plan", steps: [
    { amountMinor: 2_000_000n, feeMinor: 54_129n, destLabel: "Base (Sepolia)" },
    { amountMinor: 2_000_000n, feeMinor: 54_129n, destLabel: "Ethereum (Sepolia)" },
  ] });
  check("⭐ refused at 402", r?.status === 402);
  check("⭐⭐ HAVE 3.650000 and NEED 4.108258 (2+2+0.054129+0.054129), both at 6 dp", /have 3\.650000 USDC/.test(r?.body?.error ?? "") && /need 4\.108258 USDC/.test(r?.body?.error ?? ""), r?.body?.error);
  check("⭐ the breakdown names the amount, the fees and BOTH destinations", /\(4 \+ ~0\.108258 in fees, to Base \(Sepolia\) and Ethereum \(Sepolia\)\)/.test(r?.body?.error ?? ""));
  check("⭐ it says the WHOLE plan is refused and nothing was executed", /whole plan is refused/.test(r?.body?.error ?? "") && /Nothing was executed/.test(r?.body?.error ?? ""));
  check("⭐ a plan the wallet CAN fund → null", call({ haveMinor: 4_108_258n, scope: "plan", steps: [
    { amountMinor: 2_000_000n, feeMinor: 54_129n, destLabel: "Base" }, { amountMinor: 2_000_000n, feeMinor: 54_129n, destLabel: "Ethereum" } ] }) === null);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — THE WIRING: every bridge-initiating surface is a CALLER of the one reader + one refusal");
const src = (f) => readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, "");
const surfaces = {
  "agent-bridge.mjs (agent panel + chat single-action CONFIRM)": src("netlify/functions/agent-bridge.mjs"),
  "agent-act.mjs (chat proposal: plan + single-action)": src("netlify/functions/agent-act.mjs"),
  "agent-execute-plan.mjs (plan execution)": src("netlify/functions/agent-execute-plan.mjs"),
  "job-bridge-approve.mjs (proposal card)": src("netlify/functions/job-bridge-approve.mjs"),
};
for (const [name, code] of Object.entries(surfaces)) {
  check(`⭐ ${name} reads via readBridgeBalanceMinor`, /readBridgeBalanceMinor\(walletAddress\)/.test(code));
  check(`⭐ ${name} refuses via bridgeBalanceRefusal`, /bridgeBalanceRefusal\(\{/.test(code));
  check(`⛔ ${name} has NO private balanceOf read left`, !/functionName:\s*"balanceOf"/.test(code));
  check(`⭐ ${name} reports balanceChecked`, /balanceChecked/.test(code));
}
check("⭐ agent-act's plan proposal refuses with scope \"plan\"", /scope:\s*"plan"/.test(surfaces["agent-act.mjs (chat proposal: plan + single-action)"]));
check("⭐ agent-execute-plan refuses with scope \"plan\" BEFORE the execution loop",
  (() => { const c = surfaces["agent-execute-plan.mjs (plan execution)"]; const i = c.indexOf('scope: "plan"'); const j = c.indexOf("const results = [];"); return i > 0 && j > 0 && i < j; })());
check("⭐ agent-execute-plan orders the balance refusal BEFORE the per-step cap (2026-09-16 reorder — the monitor's probe now reads the balance field, not the cap)",
  (() => { const c = surfaces["agent-execute-plan.mjs (plan execution)"]; const bal = c.indexOf("bridgeBalanceRefusal({"); const cap = c.indexOf("vA > capForA(step)"); return bal > 0 && cap > 0 && bal < cap; })());
check("⛔ _bridge.mjs holds exactly ONE balanceOf ABI for the pre-flight (the only copy)",
  (readFileSync("netlify/functions/_bridge.mjs", "utf8").match(/name:\s*"balanceOf"/g) || []).length === 1);

console.log(`\n${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail ? 1 : 0);
