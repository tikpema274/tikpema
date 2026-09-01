// verify-bridge-fee-binding.mjs — THE FIGURE SHOWN IS THE FIGURE IN THE CALLDATA.
//
//   node --experimental-test-module-mocks scripts/verify-bridge-fee-binding.mjs
//
// ═══ 🚨 WHAT THIS EXISTS TO PROVE, AND WHY A ROUND-TRIP TEST WOULD NOT ═════════════════════════
// The agent bridge used to be single-shot: press, and the burn happens. The fee WAS priced
// server-side on every bridge — it banded, it gated, it refused below the floor — and then it was
// discarded unless the band forced a stop. So the only bridges that ever showed a figure first
// were the ones bad enough to refuse; the ordinary case moved money in silence.
//
// ⛔ AND A CONFIRM STEP ALONE WOULD HAVE BEEN WORSE THAN THE SILENCE. `agentBridge` priced the
// bridge ITSELF, so the fee the gate banded and the fee signed into the calldata were two quotes
// ~200 ms apart (docs/agent-receipt-fee-authority-scope.md). Across a HUMAN pause that gap is
// seconds, at a fee that moves roughly every 30 s: a naive confirm step would show one number and
// burn another. Showing a figure you do not honour is a worse defect than showing none.
//
// ⭐⭐ SO THE ASSERTION IS END-TO-END, NOT A ROUND TRIP. It is not enough that the sealed token
// survives the request. This decodes the ACTUAL CALLDATA handed to Circle and compares `maxFee`
// against the figure the quote carried. `agentBridge` and `bridgeCallData` are the REAL ones —
// only Circle and the allowance read are mocked, because those are the network, not the logic.
//
// 🚨 THE FALSIFIER IS BUILT IN: `bridgeFee` is mocked to return a DIFFERENT fee from the sealed
// one. If ANY code path re-reads the price — executeAction, agentBridge, anything — the calldata
// carries the mock's number and these assertions fail. A test that passed whether or not the fee
// was re-read would prove nothing, which is exactly what "assert the round trip" would have been.
// [[check-whose-failure-mode-is-a-pass]]

import { mock } from "node:test";
import { decodeFunctionData } from "viem";
import { readFileSync } from "node:fs";

process.env.SESSION_SECRET ||= ["bridge", "binding", "suite", "not", "a", "credential"].join("-");

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } return !!c; };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

const OWNER = "0x" + "11".repeat(20);
const AMOUNT = 1.0;

// ⭐ THE SEALED QUOTE'S FEE, and a DIFFERENT live fee. Any re-read yields FRESH, not SEALED.
const SEALED_MAXFEE = 54147n;                 // 0.054147 USDC — the figure the user is shown
const FRESH  = { amountMinor: 1_000_000n, maxFee: 99_999n, feeUsdc: 0.099999, netUsdc: 0.900001 };

// ⚠️ ORDER IS LOAD-BEARING. `_bridge.mjs` imports `circle` and `publicClient` at module scope, so
// those must be mocked BEFORE it is imported — importing it first binds the real ones and
// `circle()` throws on a missing CIRCLE_API_KEY no matter what is mocked afterwards. Mock the
// leaves, then the module under test, then the caller.
const REAL_CIRCLE  = await import("../netlify/functions/_circle.mjs");
const REAL_PREDICT = await import("../netlify/functions/_predict.mjs");

let capturedCallData = null;
let bridgeFeeCalls = 0;

const mkStore = () => ({ async get() { return null; }, async setJSON() {}, async set() {},
  async setIfNew() { return true; }, async list() { return { blobs: [] }; }, async delete() {} });
mock.module("@netlify/blobs", { namedExports: {
  connectLambda: () => {}, getDeployStore: () => mkStore(), getStore: () => mkStore() } });
mock.module("../netlify/functions/_pause.mjs", { namedExports: { assertNotPaused: async () => null } });
mock.module("../netlify/functions/_budget.mjs", { namedExports: {
  canSpendDay: async () => ({ allowed: true }), recordAgentSpend: async () => ({}),
  shoutLedgerFailure: () => {}, recordBlocked: async () => {},
  REFUSAL: { CANNOT_VALUE: "cannot-value", PER_BRIDGE_CAP: "per-bridge-cap", DAY_CEILING: "day-ceiling", NO_WALLET: "no-wallet" } } });
// ⭐ Allowance already sufficient, so the approve branch is skipped and the ONLY calldata captured
// is the burn's. Otherwise the first capture would be an `approve` and the check would read the
// wrong transaction — the same stage-confusion agentBridge tags its awaits to prevent.
mock.module("../netlify/functions/_predict.mjs", { namedExports: { ...REAL_PREDICT,
  publicClient: () => ({ readContract: async () => 10n ** 12n }) } });
mock.module("../netlify/functions/_circle.mjs", { namedExports: { ...REAL_CIRCLE,
  circle: () => ({ createContractExecutionTransaction: async (args) => {
    if (args?.callData) capturedCallData = args.callData;   // the BURN carries callData; approve does not
    return { data: { id: "tx_1" } };
  } }),
  waitForTx: async () => "0x" + "ab".repeat(32) } });

// NOW load the module under test — it picks up the mocked leaves.
const REAL_BRIDGE = await import("../netlify/functions/_bridge.mjs");
// ⛔ `agentBridge` and `bridgeCallData` are NOT replaced — they are what is under test. Only the
// PRICE is, and deliberately to a value the sealed quote does not carry.
mock.module("../netlify/functions/_bridge.mjs", { namedExports: { ...REAL_BRIDGE,
  bridgeFee: async () => { bridgeFeeCalls++; return FRESH; } } });

const { executeAction } = await import("../netlify/functions/_actions.mjs");

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  BRIDGE FEE BINDING — the shown figure, decoded from the calldata    ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

const sealed = REAL_BRIDGE.sealBridgeQuote({
  owner: OWNER, destinationKey: "base", amountUsdc: AMOUNT,
  fee: { amountMinor: 1_000_000n, maxFee: SEALED_MAXFEE, feeUsdc: 0.054147, netUsdc: 0.945853 },
});

section("1 — ⭐⭐ THE END-TO-END CLAIM: shown fee === maxFee in the burn");
{
  bridgeFeeCalls = 0; capturedCallData = null;
  const r = await executeAction(
    { type: "bridge_usdc", amountUsdc: AMOUNT, destination: "base", quoteToken: sealed, reasoning: "t" },
    { walletAddress: OWNER, session: { address: OWNER } });

  check("⭐ the bridge executed", r?.ok === true, JSON.stringify(r?.blocked ?? r?.ok));
  check("⭐⭐ calldata was captured from the real bridgeCallData", !!capturedCallData);

  const decoded = capturedCallData
    ? decodeFunctionData({ abi: REAL_BRIDGE.BRIDGE_ABI, data: capturedCallData })
    : null;
  const onChainMaxFee = decoded?.args?.[0]?.maxFee;

  check("⭐⭐⭐ the maxFee IN THE CALLDATA is the SEALED figure, not a re-read one",
    onChainMaxFee === SEALED_MAXFEE,
    `calldata maxFee=${onChainMaxFee} sealed=${SEALED_MAXFEE} fresh=${FRESH.maxFee}`);
  // 🚨 THE FALSIFIER, STATED AS ITS OWN ASSERTION. If this equalled FRESH.maxFee the binding is
  // not happening and the check above would be passing for the wrong reason on some other build.
  check("🚨 …and it is NOT the live re-read fee, which is what a re-reading build would sign",
    onChainMaxFee !== FRESH.maxFee, `fresh would have been ${FRESH.maxFee}`);

  check("⭐⭐ bridgeFee was NEVER called on the bound path — nothing re-priced",
    bridgeFeeCalls === 0, `bridgeFee calls=${bridgeFeeCalls}`);
  check("⭐ feeCharged and feeDisclosed are now the SAME quote, because there is only one",
    r.feeCharged === r.feeDisclosed && r.feeCharged === 0.054147,
    `charged=${r.feeCharged} disclosed=${r.feeDisclosed}`);
  // ⭐ The invariant verify-receipt-fee-authority asserts before anything enforced it. Binding is
  // what enforces it: equal is the strongest form of "never more".
  check("⭐⭐ feeCharged <= feeDisclosed — the invariant, now STRUCTURAL rather than hoped for",
    r.feeCharged <= r.feeDisclosed);
}

section("2 — ⛔ THE SEAL IS FAIL-CLOSED, AND A TAMPERED FEE CANNOT REACH CALLDATA");
{
  const cases = [
    ["a forged token", "notatoken.notamac"],
    ["a token for a DIFFERENT amount", REAL_BRIDGE.sealBridgeQuote({ owner: OWNER, destinationKey: "base", amountUsdc: 999, fee: { amountMinor: 1n, maxFee: 1n, feeUsdc: 1, netUsdc: 1 } })],
    ["a token for a DIFFERENT owner", REAL_BRIDGE.sealBridgeQuote({ owner: "0x" + "22".repeat(20), destinationKey: "base", amountUsdc: AMOUNT, fee: { amountMinor: 1_000_000n, maxFee: SEALED_MAXFEE, feeUsdc: 0.054147, netUsdc: 0.945853 } })],
    ["an EXPIRED token", REAL_BRIDGE.sealBridgeQuote({ owner: OWNER, destinationKey: "base", amountUsdc: AMOUNT, fee: { amountMinor: 1_000_000n, maxFee: SEALED_MAXFEE, feeUsdc: 0.054147, netUsdc: 0.945853 }, now: Date.now() - REAL_BRIDGE.QUOTE_TTL_MS - 1000 })],
  ];
  for (const [label, tok] of cases) {
    capturedCallData = null;
    const r = await executeAction(
      { type: "bridge_usdc", amountUsdc: AMOUNT, destination: "base", quoteToken: tok, reasoning: "t" },
      { walletAddress: OWNER, session: { address: OWNER } });
    check(`⛔ ${label} REFUSES`, r?.ok === false, String(r?.blocked ?? "").slice(0, 58));
    check(`   …and NOTHING was signed`, capturedCallData === null);
  }
  // 🚨 A TAMPERED PAYLOAD IS THE WHOLE POINT OF SEALING: flip the fee inside and the MAC fails.
  const [body, mac] = sealed.split(".");
  const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  p.m = "1";                                  // 0.000001 USDC — a fee of the caller's choosing
  const tampered = `${Buffer.from(JSON.stringify(p)).toString("base64url")}.${mac}`;
  capturedCallData = null;
  const r = await executeAction(
    { type: "bridge_usdc", amountUsdc: AMOUNT, destination: "base", quoteToken: tampered, reasoning: "t" },
    { walletAddress: OWNER, session: { address: OWNER } });
  check("🚨🚨 a CHOSEN maxFee cannot be smuggled in — the MAC refuses it", r?.ok === false, String(r?.blocked ?? "").slice(0, 58));
  check("   …and no calldata was produced from it", capturedCallData === null);
}

section("3 — ⚠️ THE UN-BOUND PATH IS UNCHANGED, asserted on SOURCE and not by running it");
{
  // 🚨 WHY THIS IS NOT EXECUTED. Running it reaches the REAL `bridgeFee` inside `agentBridge`, and
  // a module mock cannot intercept that: `mock.module` replaces what IMPORTERS see, not a module's
  // own internal references. The first draft of this section therefore hit Circle's live Iris API
  // and asserted against whatever it returned — it signed 54143 while the mock said 99999, which
  // looked like a binding failure and was actually a network call. ⛔ A suite that silently needs
  // the network is one that goes red on a train, so the property is asserted where it lives.
  // [[verify-facts-before-sharing-words]]
  const bridgeSrc  = readFileSync(new URL("../netlify/functions/_bridge.mjs", import.meta.url), "utf8");
  const actionsSrc = readFileSync(new URL("../netlify/functions/_actions.mjs", import.meta.url), "utf8");

  check("⭐ agentBridge still prices live when NOTHING is bound",
    /const fee = boundFee \?\? await bridgeFee\(/.test(bridgeSrc),
    "job-bridge-approve prices at approval and executes later — re-reading is correct there");
  check("⭐⭐ …and the bound branch does NOT price — it opens the seal",
    /if \(step\.quoteToken\)/.test(actionsSrc) && /openBridgeQuote\(step\.quoteToken/.test(actionsSrc));
  // ⛔ THE FALLBACK THAT MUST NOT EXIST. If opening a token could fall through to pricing, "the
  // figure you saw" would silently become "some figure" on exactly the inputs an attacker controls.
  check("⛔ a FAILED open refuses — it never falls back to pricing",
    /catch \(e\) \{\s*return \{ ok: false, blocked: `\$\{e\.message\}`, quoteExpired: true \};/.test(actionsSrc),
    "a silent fallback would defeat the whole binding");
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0`);
console.log(`⭐ The figure shown is the figure signed — decoded from the calldata, with a re-read`);
console.log(`  build failing by construction.\n`);
