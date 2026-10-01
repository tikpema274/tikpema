// verify-bridge-ack-sentence.mjs — THE ACKNOWLEDGEMENT SENTENCE, PINNED ON BOTH PATHS THAT SAY IT.
//
//   node --experimental-test-module-mocks scripts/verify-bridge-ack-sentence.mjs   (npm run test:acksentence)
//
// ═══ 🚨 WHY (2026-10-01) ═══════════════════════════════════════════════════════════════════════
// The agent bridge's fee is charged ON TOP (`bridgeFee()` → mechanic "upfront", net = the full amount,
// _bridge.mjs:215/:334). The plan path's acknowledgement still said, live on prod:
//   "step 1 would lose 59.9% to fees — the fee to Base (Sepolia) is ~0.0546 USDC of 0.091 USDC,
//    so only ~0.0910 would arrive."
// — deducted-fee copy on an upfront path: nothing is lost from the amount, and "only" the full amount
// arrives. Its sibling on the single-action path had been rewritten for upfront fees; this one was
// missed, because NEITHER sentence was pinned by any test. Both now come from ONE helper
// (`bridgeAckSentence`, _bridge.mjs), and this suite drives BOTH refusal paths for real — executeAction
// and the agent-execute-plan handler — with only their boundaries mocked (Blobs, Circle, the chain read,
// the budget store, the wallet registry). Neither the helper nor either caller is replaced.

import { mock } from "node:test";
import { readFileSync } from "node:fs";

process.env.SESSION_SECRET ??= "verify-bridge-ack-sentence-secret-0123456789";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 74 - t.length))}`);

const OWNER = "0x00000000000000000000000000000000000000a1";
const WALLET = "0x00000000000000000000000000000000000000b2";
const AMOUNT = 0.1;
// ⭐ T's wording (2026-10-01), with the figures this fixture produces: fee 0.054147 → 0.0541, 54.1% of 0.1,
// 0.1 + 0.054147 → 0.1541. Written out literally — a test that rebuilt it from the helper would pin nothing.
const EXPECTED = "This bridge charges a fee of 0.0541 USDC on top of the 0.1 you're sending — 54.1% of the amount. " +
  "The full 0.1 arrives; about 0.1541 leaves your wallet.";

// ── boundaries only (order is load-bearing: leaves before _bridge.mjs, _bridge.mjs before its callers) ──
const REAL_CIRCLE  = await import("../netlify/functions/_circle.mjs");
const REAL_PREDICT = await import("../netlify/functions/_predict.mjs");
const mkStore = () => ({ async get() { return null; }, async setJSON() {}, async set() { return { modified: true }; },
  async setIfNew() { return true; }, async list() { return { blobs: [] }; }, async delete() {} });
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getDeployStore: () => mkStore(), getStore: () => mkStore() } });
mock.module("../netlify/functions/_blobs.mjs", { namedExports: { connectBlobs: () => {} } });
mock.module("../netlify/functions/_pause.mjs", { namedExports: { assertNotPaused: async () => null } });
mock.module("../netlify/functions/_budget.mjs", { namedExports: {
  canSpendDay: async () => ({ allowed: true }), recordAgentSpend: async () => ({}), shoutLedgerFailure: () => {},
  recordBlocked: async () => {}, daySpend: async () => 0, budgetConfig: () => ({ PERIOD_CEILING_USDC: 60 }),
  REFUSAL: { CANNOT_VALUE: "cannot-value", PER_BRIDGE_CAP: "per-bridge-cap", DAY_CEILING: "day-ceiling", NO_WALLET: "no-wallet" } } });
mock.module("../netlify/functions/_agent-wallets.mjs", { namedExports: {
  ensureOwnerWallet: async () => ({ walletAddress: WALLET }), WALLET_PROVISIONING_STATUS: 202,
  walletProvisioningRefusal: () => ({}), WALLET_UNRESOLVABLE_STATUS: 503, walletUnresolvableRefusal: () => ({}),
  isWalletUnresolvable: () => false } });
mock.module("../netlify/functions/_quote-record.mjs", { namedExports: { safeQuoteId: (x) => x ?? null, markQuoteUsed: async () => ({}) } });
mock.module("../netlify/functions/_predict.mjs", { namedExports: { ...REAL_PREDICT,
  publicClient: () => ({ readContract: async () => 10n ** 12n }) } });
let executed = 0;
mock.module("../netlify/functions/_circle.mjs", { namedExports: { ...REAL_CIRCLE,
  circle: () => ({ createContractExecutionTransaction: async () => { executed++; return { data: { id: "tx_1" } }; } }),
  waitForTx: async () => "0x" + "ab".repeat(32) } });
const B = await import("../netlify/functions/_bridge.mjs");
mock.module("../netlify/functions/_bridge.mjs", { namedExports: { ...B,
  readBridgeBalanceMinor: async () => ({ checked: true, balanceMinor: 10n ** 12n }) } });
const { executeAction } = await import("../netlify/functions/_actions.mjs");
const { handler: planHandler } = await import("../netlify/functions/agent-execute-plan.mjs");
const { issueSession } = await import("../netlify/functions/_auth.mjs");

const FAR = 4102444800;
// The signed-quote LAYOUT the expiry decoder reads (prefix byte, offset word, mode<<248|deadline, payload) — same
// builder as verify-bridge-fee-binding. Synthetic bytes: nothing here submits them.
const mkSignedQuote = (deadlineSec) => "0x01" + "00".repeat(31) + "20" + "00" + BigInt(deadlineSec).toString(16).padStart(62, "0") + "ab".repeat(32);
const sealFor = (owner) => B.sealBridgeQuote({ owner, destinationKey: "base", amountUsdc: AMOUNT,
  fee: { amountMinor: 100_000n, feeMinor: 54_147n, feeUsdc: 0.054147, netUsdc: AMOUNT, mechanic: "upfront",
    quote: { signedQuote: mkSignedQuote(FAR), issuedAt: FAR - 120, expiry: { mode: "TIMESTAMP", expiresAt: FAR },
      feeTotalAmount: "54147", feeToken: "0x3600000000000000000000000000000000000000" } } });

section("0 — the fixture is the case: an UPFRONT fee, inside the acknowledge band");
const opened = B.openBridgeQuote(sealFor(OWNER), { owner: OWNER, destinationKey: "base", amountUsdc: AMOUNT });
check("⭐ the sealed quote declares mechanic `upfront`", opened.mechanic === "upfront", String(opened.mechanic));
check("⭐ …and net = the FULL amount (nothing deducted)", Number(opened.netUsdc) === AMOUNT, String(opened.netUsdc));
const band = B.bridgeFeeBand({ amountUsdc: AMOUNT, feeUsdc: opened.feeUsdc, netUsdc: opened.netUsdc });
check("⭐ …in the acknowledge band (so both paths must ask)", band.band === "acknowledge", `${band.band} ${(band.feeRatio * 100).toFixed(1)}%`);

section("1 — 🚨 THE SINGLE-ACTION PATH (executeAction) says the sentence");
executed = 0;
const a = await executeAction({ type: "bridge_usdc", amountUsdc: AMOUNT, destination: "base", quoteToken: sealFor(OWNER), reasoning: "t" },
  { walletAddress: WALLET, session: { address: OWNER } });
check("refused, nothing executed", a?.ok === false && executed === 0, String(a?.blocked).slice(0, 80));
check("⭐⭐ the refusal is EXACTLY the sentence + its path's instruction",
  a?.blocked === `${EXPECTED} Confirm you accept that before it runs.`, JSON.stringify(a?.blocked));

section("2 — 🚨 THE PLAN PATH (agent-execute-plan) says the SAME sentence");
executed = 0;
const { token } = issueSession({ address: OWNER, method: "siwe" });
const res = await planHandler({ httpMethod: "POST", headers: { authorization: `Bearer ${token}` },
  body: JSON.stringify({ plan: [{ type: "bridge_usdc", amountUsdc: AMOUNT, destination: "base", reasoning: "t" }], quoteTokens: { 0: sealFor(OWNER) } }) });
const p = JSON.parse(res.body || "{}");
check("needsAck, nothing executed", p.needsAck === true && p.executed === false && executed === 0, `HTTP ${res.statusCode} ${String(p.blocked).slice(0, 60)}`);
check("⭐⭐ the refusal is EXACTLY `step 1: ` + the sentence + its path's instruction",
  p.blocked === `step 1: ${EXPECTED} Nothing was executed. Confirm you accept that and run the plan again.`, JSON.stringify(p.blocked));

section("3 — ⛔ the deducted-fee vocabulary is GONE from both, and one helper says it");
const plan = readFileSync(new URL("../netlify/functions/agent-execute-plan.mjs", import.meta.url), "utf8");
const actions = readFileSync(new URL("../netlify/functions/_actions.mjs", import.meta.url), "utf8");
for (const [name, src] of [["agent-execute-plan.mjs", plan], ["_actions.mjs", actions]]) {
  check(`${name}: no "would lose"`, !/would lose/.test(src));
  check(`${name}: no "only ~… would arrive"`, !/only ~\$\{/.test(src));
  check(`⭐ ${name} calls bridgeAckSentence (no third phrasing)`, /bridgeAckSentence\(/.test(src));
}
check("⭐ the helper is exported once, from _bridge.mjs", typeof B.bridgeAckSentence === "function");
for (const [p_, s] of [[a?.blocked, "single"], [p.blocked, "plan"]]) check(`⛔ ${s}: no "lose", no "only"`, !/\blose\b|\bonly\b/i.test(String(p_)));

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-bridge-ack-sentence — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
