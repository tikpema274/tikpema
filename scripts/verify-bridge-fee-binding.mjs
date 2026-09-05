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
import { readFileSync, readdirSync } from "node:fs";

// The three ABIs this suite decodes with. ⚠️ Declared here rather than imported so a change to the
// production encoding is CAUGHT by a decode failure instead of silently agreeing with itself.
const BATCH_ABI = [{ name: "executeBatch", type: "function", stateMutability: "payable", outputs: [{ type: "bytes[]" }],
  inputs: [{ name: "calls", type: "tuple[]", components: [
    { name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }] }];
const APPROVE_ABI = [{ name: "approve", type: "function", stateMutability: "nonpayable", outputs: [{ type: "bool" }],
  inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }] }];
const BURN_ABI = [{ name: "depositForBurnWithFees", type: "function", stateMutability: "payable", outputs: [],
  inputs: [
    { name: "amount", type: "uint256" }, { name: "destinationDomain", type: "uint32" },
    { name: "mintRecipient", type: "bytes32" }, { name: "burnToken", type: "address" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "claim", type: "tuple", components: [
      { name: "signedQuote", type: "bytes" }, { name: "refundAddress", type: "address" }] }] }];
import { usdcDecimalToMinorExact } from "../netlify/functions/_fee-reconcile.mjs";

process.env.SESSION_SECRET ||= ["bridge", "binding", "suite", "not", "a", "credential"].join("-");

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } return !!c; };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

const OWNER = "0x" + "11".repeat(20);
const AMOUNT = 1.0;

// ⭐ THE SEALED QUOTE'S FEE, and a DIFFERENT live fee. Any re-read yields FRESH, not SEALED.
// ⭐ THE SIGNED BYTES ARE BUILT, NOT TYPED. `normalizeQuoteExpiry` locates the packed expiry word
// by VALUE and cross-checks its high byte against the declared mode, so a hand-written blob is
// simply refused — as a first draft of this fixture was. Encoding it here means the fixture agrees
// with the decoder by construction rather than by luck.
const mkSignedQuote = (deadlineSec, modeByte = 0x00, filler = "ab") =>
  "0x01"
  + "00".repeat(31) + "20"                                     // an ordinary offset word
  + modeByte.toString(16).padStart(2, "0")
  + BigInt(deadlineSec).toString(16).padStart(62, "0")         // mode<<248 | deadline
  + filler.repeat(32);                                          // a trailing payload word
// ⚠️ `feeMinor`, not `maxFee` — the burn's own maxFee is EMPTY_MAX_FEE (zero) under upfront fees.
const SEALED_FEE_MINOR = 54147n;              // 0.054147 USDC — the figure the user is shown
const FRESH  = { amountMinor: 1_000_000n, feeMinor: 99_999n, feeUsdc: 0.099999, netUsdc: 1,
  quote: { signedQuote: mkSignedQuote(4102444800, 0x00, "cd"), expiry: { mode: "TIMESTAMP", expiresAt: 4102444800 } } };

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

// ⭐ A REAL CIRCLE QUOTE — the run-2 one, whose signed bytes, mode byte and deadline are genuine.
// Its expiry is long past in wall-clock terms, which is exactly what makes it the right fixture for
// "the external deadline refuses while ours would not".
const EXPIRED_CIRCLE_QUOTE = JSON.parse(
  readFileSync(new URL("./spikes/erc20-fee-burn-run2-quote-2026-09-03.json", import.meta.url), "utf8"));

// ⭐ A LIVE-WINDOWED QUOTE carrying the SEALED fee. Its signed bytes are synthetic — nothing here
// submits them — but its `feeTotalAmount` and `expiry` are the fields the binding actually reads,
// and its deadline is far enough out that this suite never fails on the clock.
const FAR_DEADLINE = 4102444800;                                // 2100-01-01, well past any clock here
const SEALED_QUOTE = {
  signedQuote: mkSignedQuote(FAR_DEADLINE),
  issuedAt: FAR_DEADLINE - 120,
  expiry: { mode: "TIMESTAMP", expiresAt: FAR_DEADLINE },
  feeTotalAmount: "54147",
  feeToken: "0x3600000000000000000000000000000000000000",
};

const sealed = REAL_BRIDGE.sealBridgeQuote({
  owner: OWNER, destinationKey: "base", amountUsdc: AMOUNT,
  fee: { amountMinor: 1_000_000n, feeMinor: SEALED_FEE_MINOR, feeUsdc: 0.054147, netUsdc: 1,
         quote: SEALED_QUOTE },
});

section("1 — ⭐⭐ THE END-TO-END CLAIM: the shown fee is the fee the CHAIN will enforce");
{
  // ═══ 🚨 THE TRIPWIRE ARMED HERE ON 2026-09-03 FIRED ON THE UPFRONT-FEE COMMIT ═════════════════
  //
  // This section used to decode `maxFee` out of the burn calldata and assert it equalled the sealed
  // figure. `depositForBurnWithFees` has no `maxFee` — `_depositForBurn` hardcodes `EMPTY_MAX_FEE`,
  // measured as **0** in run 2's real `DepositForBurn` event. So:
  //   · "the maxFee in the calldata is the SEALED figure"  had nothing left to read
  //   · its falsifier `!== FRESH.maxFee`                   would have compared 0 to 0 — VACUOUS
  //
  // ⛔ BOTH CAME OUT IN THE SAME COMMIT THAT BROKE THEM. Leaving a vacuous assertion in place is
  // worse than deleting it: it keeps printing ✅ for a property nothing checks, and the pass count
  // conceals that the section stopped measuring anything.
  //
  // ⭐⭐ AND THE CLAIM IS STRONGER NOW, NOT WEAKER. It used to rest on OUR threading — we signed the
  // figure we showed. It now rests on the chain: `_collectFees` ends in
  // `assert(feeAmount == quotedFee)`, so a burn whose collected fee differs from the submitted
  // quote's REVERTS. What this section checks is that the quote we submit is the quote we showed.
  bridgeFeeCalls = 0; capturedCallData = null;
  const r = await executeAction(
    { type: "bridge_usdc", amountUsdc: AMOUNT, destination: "base", quoteToken: sealed, reasoning: "t" },
    { walletAddress: OWNER, session: { address: OWNER } });

  check("⭐ the bridge executed", r?.ok === true, JSON.stringify(r?.blocked ?? r?.ok));
  check("⭐⭐ calldata was captured from the real batch builder", !!capturedCallData);

  // ── THE SUBMITTED QUOTE IS THE SEALED ONE ────────────────────────────────────────────────────
  const decoded = capturedCallData
    ? decodeFunctionData({ abi: BATCH_ABI, data: capturedCallData }) : null;
  const calls = decoded?.args?.[0] ?? [];
  const burnCall = calls[1];
  const burn = burnCall ? decodeFunctionData({ abi: BURN_ABI, data: burnCall.data }) : null;
  check("⭐⭐⭐ the SIGNED QUOTE in the burn is the SEALED one, not a re-read one",
    burn?.args?.[5]?.signedQuote === SEALED_QUOTE.signedQuote,
    `submitted ${String(burn?.args?.[5]?.signedQuote).slice(0, 14)}… sealed ${SEALED_QUOTE.signedQuote.slice(0, 14)}…`);
  // 🚨 THE FALSIFIER, AND IT IS NOT VACUOUS: the two blobs differ, so a re-reading build would
  // submit FRESH's bytes and this would fail.
  check("🚨 …and it is NOT the live re-read quote, which a re-pricing build would submit",
    burn?.args?.[5]?.signedQuote !== FRESH.quote.signedQuote &&
    SEALED_QUOTE.signedQuote !== FRESH.quote.signedQuote,
    "the two fixtures' signed bytes differ, so this comparison can fail");

  // ── AND THE APPROVE IN THE SAME BATCH IS BOUND TO THAT SAME QUOTE'S FEE ───────────────────────
  // ⭐ This is the binding the calldata `maxFee` used to carry: the figure shown decides how much
  // the wallet actually authorises, and it comes from the sealed quote rather than a fresh read.
  const ap = calls[0] ? decodeFunctionData({ abi: APPROVE_ABI, data: calls[0].data }) : null;
  check("⭐⭐ the APPROVE authorises amount + the SEALED fee — the shown figure decides the debit",
    ap?.args?.[1] === 1_000_000n + SEALED_FEE_MINOR,
    `${ap?.args?.[1]} vs ${1_000_000n + SEALED_FEE_MINOR} (fresh would be ${1_000_000n + FRESH.feeMinor})`);
  check("🚨 …and NOT the re-read fee", ap?.args?.[1] !== 1_000_000n + FRESH.feeMinor);

  check("⭐⭐ bridgeFee was NEVER called on the bound path — nothing re-priced",
    bridgeFeeCalls === 0, `bridgeFee calls=${bridgeFeeCalls}`);
  check("⭐ feeCharged and feeDisclosed are the SAME quote, because there is only one",
    r.feeCharged === r.feeDisclosed && r.feeCharged === 0.054147,
    `charged=${r.feeCharged} disclosed=${r.feeDisclosed}`);
  check("⭐⭐ feeCharged <= feeDisclosed — the invariant, STRUCTURAL rather than hoped for",
    r.feeCharged <= r.feeDisclosed);

  // ⭐⭐ THE SUCCESSOR TO THE OLD TRIPWIRE — the reconciliation's input, on this very execution.
  check("⭐⭐ the disclosed fee's two units agree on this execution — the reconciliation's input",
    usdcDecimalToMinorExact(r.feeDisclosed) === SEALED_FEE_MINOR,
    `feeDisclosed ${r.feeDisclosed} -> ${usdcDecimalToMinorExact(r.feeDisclosed)} minor, sealed ${SEALED_FEE_MINOR}`);

  // ⛔ AND THE OLD INSTRUMENT MUST NOT COME BACK. If `maxFee` ever reappears in the burn calldata,
  // something has re-adopted the deducted mechanic on the agent path and every net figure inverts
  // again. This is the reverse tripwire of the one that fired.
  const cdSrc = readFileSync(new URL("../netlify/functions/_bridge.mjs", import.meta.url), "utf8");
  check("⛔ the agent path's burn calldata carries NO maxFee — the deducted mechanic has not returned",
    /export function bridgeCallData\(\{ amountMinor, recipient, cctpDomain, signedQuote, refundAddress \}\)/.test(cdSrc));
}

section("1b — 🚨 THE CEILING BOUNDS THE WALLET DEBIT, NOT THE AMOUNT");
{
  // ═══ ⛔ A MONEY-SAFETY DEFECT, NOT A COPY ONE — AND IT HAD NO GUARD ═══════════════════════════
  // `valueOfStep` returned `amountUsdc` alone for a bridge. Under upfront fees the wallet parts with
  // `amount + fee`, so counting only the amount leaves THE DAY CEILING WIDER THAN CONFIGURED, BY THE
  // FEE, ON EVERY BRIDGE — the same class as a lost ledger write.
  // 🚨 IT WAS FOUND BY MUTATION, NOT BY A FAILING TEST: reverting the value to `amountUsdc` left
  // every suite green. An under-counting ceiling admits MORE than it says and nothing goes red,
  // because every individual bridge still succeeds.
  const { valueOfStep } = await import("../netlify/functions/_actions.mjs");
  const step = { type: "bridge_usdc", amountUsdc: 10, destination: "base" };
  const resolvedFee = { amountMinor: 10_000_000n, feeMinor: 54_129n, feeUsdc: 0.054129, netUsdc: 10 };

  const valued = await valueOfStep(step, { bridgeFee: resolvedFee });
  check("⭐⭐ a bridge is valued at amount + fee", Math.abs(valued - 10.054129) < 1e-9, `${valued}`);
  check("🚨 …and STRICTLY MORE than the amount — the under-count is what this catches",
    valued > 10, `${valued} > 10`);

  // ⛔ FAIL CLOSED WITHOUT A FEE. Falling back to the amount IS the under-count, so it must not be
  // reachable by omission — a caller that forgets to resolve the fee must break loudly, not quietly
  // widen the ceiling.
  let threw = null;
  try { await valueOfStep(step); } catch (e) { threw = e; }
  check("⛔ valuing a bridge with NO fee THROWS — it never falls back to the amount",
    threw !== null && /without its fee/.test(threw.message), threw?.message ?? "did not throw");

  // ⭐ AND THE CAP IS APPLIED TO THE VALUED QUANTITY, AFTER VALUATION — the swap cap's own history.
  const code = readFileSync(new URL("../netlify/functions/_actions.mjs", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const valIdx = code.indexOf("dayValue = await valueOfStep(step, resolved)");
  const capIdx = code.indexOf("const bcap = bridgeCapUsdc()");
  const dayIdx = code.indexOf("const day = await canSpendDay(");
  check("⭐⭐ the bridge cap runs AFTER valuation and BEFORE the day ceiling",
    valIdx > 0 && capIdx > valIdx && dayIdx > capIdx,
    `valueOfStep@${valIdx} < cap@${capIdx} < canSpendDay@${dayIdx}`);
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // ⛔⛔ THE CALLER SET — DERIVED, NEVER ENUMERATED
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 🚨 THE DEFECT THIS EXISTS FOR, AND THIS FILE WAS PRESENT FOR IT. f760077 made the bridge fee
  // REQUIRED and this suite proved two things about it: that the callee throws without one, and
  // that `_actions.mjs` threads it. Both were true. Meanwhile `agent-execute-plan.mjs:96` and
  // `agent-act.mjs:173` still called `valueOfStep(step)` with one argument, so EVERY plan
  // containing a bridge step was blocked in production from 2026-09-03 22:35 to 2026-09-05 —
  // roughly 38 hours — and nothing went red.
  //
  // ⭐⭐ WHY THE OLD CHECK COULD NOT SEE IT: it string-matched ONE file. A binding between a callee
  // and its callers can only be tested ACROSS THE CALLER SET; pinning one caller proves that caller.
  // [[binding-tested-across-what-it-binds]] · [[duplicate-source-of-truth-is-the-recurring-bug]]
  //
  // ⛔ AND IT IS DERIVED, SO A FOURTH CALLER FAILS WITHOUT ANYONE REMEMBERING THIS FILE. The corpus
  // is every handler on disk, discovered by reading the directory — not a list. A new file calling
  // valueOfStep is in the corpus the moment it is written.
  //
  // ⭐ WHY "EVERY CALL", NOT "EVERY CALL THAT COULD BE A BRIDGE". Classifying which sites can see a
  // `bridge_usdc` step means deciding, per site, what flows into it — which is the enumeration this
  // check exists to avoid, one level up, and it fails open on the site somebody classifies wrong.
  // Requiring the argument EVERYWHERE is strictly stronger and needs no judgement: a site that
  // genuinely has no fee writes `{}` and says so. An omission and a decision then look different.
  {
    const FN_DIR = new URL("../netlify/functions/", import.meta.url);
    const files = readdirSync(FN_DIR).filter((f) => f.endsWith(".mjs"));
    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

    /** Split a call's argument text at TOP-LEVEL commas only — `{ bridgeFee: fees[i] }` is one arg. */
    const arity = (src, openIdx) => {
      let depth = 0, args = 1, inStr = null;
      for (let i = openIdx; i < src.length; i++) {
        const c = src[i], prev = src[i - 1];
        if (inStr) { if (c === inStr && prev !== "\\") inStr = null; continue; }
        if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
        if ("([{".includes(c)) depth++;
        else if (")]}".includes(c)) { depth--; if (depth === 0) return args; }
        else if (c === "," && depth === 1) args++;
      }
      return args;
    };

    const sites = [];
    for (const f of files) {
      const raw = readFileSync(new URL(f, FN_DIR), "utf8");
      const code = strip(raw);
      const re = /valueOfStep\s*\(/g;
      let m;
      while ((m = re.exec(code))) {
        // Skip the declaration itself.
        const before = code.slice(Math.max(0, m.index - 40), m.index);
        if (/function\s+$/.test(before) || /export\s+async\s+function\s+$/.test(before)) continue;
        const open = code.indexOf("(", m.index);
        const line = code.slice(0, m.index).split("\n").length;
        sites.push({ file: f, line, args: arity(code, open) });
      }
    }

    // ⛔ NON-VACUITY FIRST. If the scan finds nothing — a rename, a moved directory, a broken regex —
    // every assertion below passes over an empty set and reports the codebase clean.
    // [[equality-passes-vacuously-on-empty]]
    check("⛔ non-vacuity — the scan actually found valueOfStep call sites", sites.length >= 3,
      `${sites.length} call site(s) across ${files.length} handler file(s)`);

    const bare = sites.filter((s) => s.args < 2);
    check("⭐⭐ EVERY valueOfStep call site passes the resolved second argument",
      bare.length === 0,
      bare.length
        ? `MISSING at ${bare.map((s) => `${s.file}:${s.line}`).join(", ")} — a bridge step reaching ` +
          `this site throws "cannot value a bridge without its fee" and blocks the whole plan`
        : sites.map((s) => `${s.file}:${s.line}`).join(", "));

    // ⭐ AND THE MECHANISM MUST ACTUALLY BE USED SOMEWHERE. If every site satisfied the rule with a
    // bare `{}`, the corpus would be "compliant" and no bridge would ever be valued correctly.
    const threading = sites.filter((s) => s.args >= 2).length;
    check("⭐ …and at least one site threads a real resolved fee, not only `{}`",
      /valueOfStep\([^)]*\{\s*bridgeFee/.test(files.map((f) => strip(readFileSync(new URL(f, FN_DIR), "utf8"))).join("\n")),
      `${threading} site(s) pass a second argument`);
  }

  check("🚨 …and it bounds `dayValue`, not `step.amountUsdc`",
    /if \(dayValue > bcap\)/.test(code) && !/Number\(step\.amountUsdc\) > bcap/.test(code));
  // ⚠️ And the ledger charges the same quantity the gate bounded.
  check("⚠️ the day ceiling is asked about the SAME value the cap bounded",
    /canSpendDay\(\{ amountUsdc: dayValue/.test(code));
}

section("2 — ⛔ THE SEAL IS FAIL-CLOSED, AND A TAMPERED FEE CANNOT REACH CALLDATA");
{
  const cases = [
    ["a forged token", "notatoken.notamac"],
    ["a token for a DIFFERENT amount", REAL_BRIDGE.sealBridgeQuote({ owner: OWNER, destinationKey: "base", amountUsdc: 999, fee: { amountMinor: 1n, feeMinor: 1n, feeUsdc: 1, netUsdc: 1 } })],
    ["a token for a DIFFERENT owner", REAL_BRIDGE.sealBridgeQuote({ owner: "0x" + "22".repeat(20), destinationKey: "base", amountUsdc: AMOUNT, fee: { amountMinor: 1_000_000n, feeMinor: SEALED_FEE_MINOR, feeUsdc: 0.054147, netUsdc: 1, quote: SEALED_QUOTE } })],
    ["a token past OUR OWN TTL", REAL_BRIDGE.sealBridgeQuote({ owner: OWNER, destinationKey: "base", amountUsdc: AMOUNT, fee: { amountMinor: 1_000_000n, feeMinor: SEALED_FEE_MINOR, feeUsdc: 0.054147, netUsdc: 1, quote: SEALED_QUOTE }, now: Date.now() - REAL_BRIDGE.QUOTE_TTL_MS - 1000 })],
    // ═══ ⭐⭐ AND THE ONE THIS SUITE COULD NOT SEE BEFORE — THE QUOTE'S OWN DEADLINE ═════════════
    // Every expiry case here used to be OURS against OUR constant, both sides ours, so the suite
    // was structurally incapable of noticing an external window. Circle's upfront-fee quote carries
    // one, and a burn past it REVERTS on chain.
    // ⛔ THE FIXTURE IS BUILT FROM THE QUOTE'S EXPIRY, NOT FROM QUOTE_TTL_MS. It is sealed at a
    // moment when OUR TTL is comfortably fine — `now` is only 1s old — and refused ANYWAY, so the
    // refusal can only be coming from the external deadline. A fixture aged past our own TTL would
    // have passed for the old reason and proved nothing about the new one.
    ["a token whose CIRCLE QUOTE expired, while ours has not", REAL_BRIDGE.sealBridgeQuote({
      owner: OWNER, destinationKey: "base", amountUsdc: AMOUNT,
      fee: { amountMinor: 1_000_000n, feeMinor: SEALED_FEE_MINOR, feeUsdc: 0.054147, netUsdc: 1,
             quote: EXPIRED_CIRCLE_QUOTE },
      now: Date.now() - 1000 })],
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

  // ═══ 🚨 THE UN-BOUND PATH NO LONGER PRICES INSIDE agentBridge, AND THAT IS THE FIX ════════════
  // It used to read `boundFee ?? await bridgeFee(...)`, so a caller that passed no fee got a fresh
  // quote SILENTLY — a SECOND quote, seconds after the one that priced the cap and the ceiling, and
  // it is the second one whose `signedQuote` the chain would have enforced. The gates would have
  // bounded one quote and the contract another.
  // ⭐ THE FEE IS NOW RESOLVED ONCE BY THE EXECUTOR and threaded in; a missing one REFUSES.
  // ⛔ THE NEGATIVE HALF READS STRIPPED SOURCE, AND THE FIRST DRAFT DID NOT — so it failed on the
  // COMMENT that explains the removal, which quotes the old expression verbatim. A negative source
  // assertion must look at code; prose about code is not code.
  const bridgeCode = bridgeSrc.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  check("⭐⭐ agentBridge does NOT price — a missing fee is a refusal, not a fresh quote",
    /const fee = boundFee;/.test(bridgeCode) &&
    /refusing to burn without one/.test(bridgeCode) &&
    !/boundFee \?\? await bridgeFee\(/.test(bridgeCode));
  check("⭐ …and the executor resolves it exactly once, for BOTH branches",
    /resolved\.bridgeFee = boundFee;/.test(actionsSrc) &&
    /resolved\.bridgeFee = await bridgeFee\(/.test(actionsSrc));
  // ⚠️ AND job-bridge-approve IS NO LONGER UN-BOUND. It seals in-request, so its balance gate and
  // its burn price from one quote. What it loses is disclosure at PROPOSAL time, not binding.
  const approveSrc = readFileSync(new URL("../netlify/functions/job-bridge-approve.mjs", import.meta.url), "utf8");
  check("⭐⭐ job-bridge-approve seals in-request — its gate and its burn share one quote",
    /sealBridgeQuote\(/.test(approveSrc) && /quoteToken,/.test(approveSrc));
  check("⭐⭐ …and the bound branch does NOT price — it opens the seal",
    /if \(step\.quoteToken\)/.test(actionsSrc) && /openBridgeQuote\(step\.quoteToken/.test(actionsSrc));
  // ⛔ THE FALLBACK THAT MUST NOT EXIST. If opening a token could fall through to pricing, "the
  // figure you saw" would silently become "some figure" on exactly the inputs an attacker controls.
  check("⛔ a FAILED open refuses — it never falls back to pricing",
    /catch \(e\) \{\s*return \{ ok: false, blocked: `\$\{e\.message\}`, quoteExpired: true \};/.test(actionsSrc),
    "a silent fallback would defeat the whole binding");
}

section("4 — ⛔ THE EXPIRY IS THE QUOTE'S OWN, BRANCHED ON ITS MODE");
{
  // ═══ 🚨 WHAT THIS SECTION USED TO SAY, AND WHY IT NO LONGER DOES ═════════════════════════════
  // It asserted the expiry was SELF-ISSUED — "measured from our own `iat` against QUOTE_TTL_MS" —
  // and armed a tripwire that would fire the moment an external quote field appeared in the seal.
  // ⭐ THE TRIPWIRE FIRED, AS DESIGNED, ON THE COMMIT THAT ADOPTED THE QUOTE'S EXPIRY. Its job is
  // done; what replaces it states the NEW design positively rather than deleting the old claim and
  // leaving a gap where an assertion used to be.
  const bridgeSrc = readFileSync(new URL("../netlify/functions/_bridge.mjs", import.meta.url), "utf8");
  const code = bridgeSrc.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const expirySrc = readFileSync(new URL("../netlify/functions/_quote-expiry.mjs", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

  // (i) POSITIVELY, WHAT THE EXPIRY IS NOW. Not "no literal is hardcoded" — that is an absence.
  //     TWO deadlines, both enforced, neither replacing the other: ours bounds the seal, theirs
  //     bounds the burn (past it the burn REVERTS on chain).
  check("⭐ OUR deadline still exists — the seal is still bounded by our own issuance stamp",
    /now - p\.iat > QUOTE_TTL_MS/.test(code) && /iat: now/.test(code));
  check("⭐⭐ …and THEIRS is read from the sealed payload and judged",
    /openQuoteExpiry\(p, now\)/.test(code) && /assertQuoteUnexpired\(\{ mode: p\.xm, expiresAtSec: p\.xe/.test(code));
  check("⭐⭐ the seal carries the MODE, not just the number — a bare value would compare a block " +
    "height against a clock",
    /xm: xp\.mode, xe: xp\.expiresAtSec/.test(code));
  check("⭐ …and validation BRANCHES on the mode rather than on the value's magnitude",
    /mode === "TIMESTAMP"/.test(expirySrc) && /mode === "BLOCK_HEIGHT"/.test(expirySrc));
  check("⛔ …and an unrecognised mode REFUSES rather than falling through to the branch we have",
    /mode_unrecognised/.test(expirySrc) && !/mode \|\| "TIMESTAMP"/.test(expirySrc));

  // (ii) THE SOURCE DISCRIMINATOR. An absence must never select the self-issued branch: a migration
  //      that dropped the expiry from the fee object would silently restore a 3-minute window over
  //      a 2-minute quote, with nothing failing and nothing to look at.
  check("⭐⭐ the payload NAMES where the price came from, so an absence cannot select a branch",
    /qs: externallyQuoted \? "circle" : "self"/.test(code) &&
    /does not say where it came from/.test(bridgeSrc));

  // (iii) THE CONTROL — DISJOINT FROM WHAT IT CONTROLS FOR.
  //   🚨 THE OLD CONTROL BROKE ON EXACTLY THIS. It injected `signedQuote` into a synthetic module
  //   and asked "is any external field read?" — which the REAL module now answers `true` for, so
  //   the control was reading the real module's good behaviour as the synthetic one's and went red
  //   the day adoption landed correctly. A control must not share a subject with the thing it
  //   controls. [[control-needs-ownership-and-stability]]
  //   ⭐ SO IT MUTATES INSTEAD OF INJECTING: delete the external-deadline call from a COPY of the
  //   source and assert the predicate goes false. The predicate is the same one used in (i), so a
  //   green (i) can never be green for a reason (iii) would not catch.
  const readsExternalDeadline = (src) => /openQuoteExpiry\(p, now\)/.test(src);
  const gutted = code.replace(/const expiry = openQuoteExpiry\(p, now\);/, "const expiry = null;");
  check("⭐⭐ the control MUTATES a copy rather than injecting a field the real module also has",
    gutted !== code, "the deletion landed");
  check("⭐⭐ …and the predicate goes FALSE on a build that stopped reading the quote's deadline",
    readsExternalDeadline(code) === true && readsExternalDeadline(gutted) === false);

  // (iv) ⚠️ NO 120_000 ANYWHERE. Circle's window is documented as APPROXIMATE and measured at 120s;
  //      a vendor constant retyped into our source, on a money path, with nobody watching it drift,
  //      is the defect this section has always existed to prevent. Adoption did NOT change that —
  //      the window is DERIVED from the quote we hold (`quoteWindowMs`), never typed.
  check("⛔ Circle's ~2-minute window is STILL not hardcoded — derived, never typed",
    !/120_000|120000/.test(code) && !/120_000|120000/.test(expirySrc),
    "a vendor's approximate constant must never become our literal");
  check("⭐ …and the window shown to a user is computed from the quote's own deadline",
    /export function quoteWindowMs/.test(code) && /Number\(q\.expiry\.expiresAt\) \* 1000\) - now/.test(code));

  // (v) ⛔⛔ OUR AMOUNT BINDING SURVIVES ADOPTION, AND IT IS NOT REDUNDANT.
  //     MEASURED, two instruments: the verified preimage (`forwardArgs` omits the amount) and a
  //     calibrated simulation (500000 and 9000000 both simulated cleanly against a quote requested
  //     for 2000000, while a wrong destinationDomain reverted). Circle's signature does NOT bind the
  //     amount — so this refusal BECOMES the only thing between a held quote and a burn of a
  //     different size, and deleting it as "covered by the signature" would be exactly wrong.
  check("⛔⛔ the amount binding is still in the opener", /p\.a !== Number\(amountUsdc\)/.test(code));
  check("⭐⭐ …and WHY it is not redundant is written AT the check, with both instruments named",
    /THE AMOUNT BINDING IS OURS, AND UNDER UPFRONT FEES IT IS THE ONLY ONE/.test(bridgeSrc) &&
    /forwardArgs` omits it/.test(bridgeSrc) && /CALIBRATED SIMULATION/.test(bridgeSrc));

  // (vi) THE RE-CHECK BEFORE THE BURN. The opener runs before an approve TRANSACTION; the deadline
  //      that matters is the one at the burn.
  // ⚠️ A REAL THREE-WAY ORDERING, anchored on code that survives comment-stripping. The burn is the
  // `createContractExecutionTransaction` carrying `callData`; the approve is the one carrying an
  // `abiFunctionSignature`. Checking only "after the approve" would pass on a re-check placed after
  // the burn too, which would prove nothing at all.
  // ⚠️ THERE IS NO SEPARATE APPROVE TO SIT AFTER ANY MORE. The approve and the burn ride in one
  // userOp, so the ordering that mattered — and the standing-allowance window it guarded — are both
  // gone. The re-check keeps a correct position (before the only submit) and it is still pinned;
  // dropping the assertion because its old wording stopped applying would leave it unpinned.
  const recheckIdx = code.indexOf("fee?.reCheckExpiry");
  const submitIdx = code.indexOf("const brTx = await client.createContractExecutionTransaction");
  check("⭐⭐ the deadline is re-checked BEFORE the only submit",
    recheckIdx > 0 && submitIdx > 0 && recheckIdx < submitIdx,
    `recheck@${recheckIdx} < submit@${submitIdx}`);
  check("⛔ …and no submission-margin literal was introduced instead of a second check",
    !/SUBMIT_MARGIN|submissionMargin|MARGIN_MS/.test(code));
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0`);
console.log(`⭐ The figure shown is the figure signed — decoded from the calldata, with a re-read`);
console.log(`  build failing by construction.\n`);
