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
import { usdcDecimalToMinorExact } from "../netlify/functions/_fee-reconcile.mjs";

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

// ⭐ A REAL CIRCLE QUOTE — the run-2 one, whose signed bytes, mode byte and deadline are genuine.
// Its expiry is long past in wall-clock terms, which is exactly what makes it the right fixture for
// "the external deadline refuses while ours would not".
const EXPIRED_CIRCLE_QUOTE = JSON.parse(
  readFileSync(new URL("./spikes/erc20-fee-burn-run2-quote-2026-09-03.json", import.meta.url), "utf8"));

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

  // ═══ ⛔⛔ THIS INSTRUMENT DISAPPEARS UNDER UPFRONT FEES — ARMED, NOT YET FIRED ════════════════
  //
  // Everything above binds the shown fee to `maxFee` IN THE BURN CALLDATA. Under CCTP upfront fees
  // `_depositForBurn` hardcodes `BurnMessageV2Lib.EMPTY_MAX_FEE` — and run 2's real `DepositForBurn`
  // confirmed it on chain: `maxFee = 0`. So there will be NOTHING in the burn calldata to bind to,
  // and the falsifier above (`!== FRESH.maxFee`) goes VACUOUS with both figures at zero: two
  // assertions that keep printing ✅ while measuring nothing.
  //
  // ⭐ SO THE TRIPWIRE IS ARMED HERE RATHER THAN THE SECTION BEING PRE-EMPTIVELY REWRITTEN. Today
  // the calldata really does carry the fee, and asserting a future shape would be asserting
  // something untrue. The day `bridgeCallData` stops emitting `maxFee`, this fails and says what to
  // re-point at.
  const cdSrc = readFileSync(new URL("../netlify/functions/_bridge.mjs", import.meta.url), "utf8");
  const buildsMaxFee = /export function bridgeCallData\(\{[\s\S]{0,400}?maxFee,/.test(cdSrc);
  check(
    buildsMaxFee
      ? "⭐ the burn calldata still carries `maxFee` — this section's instrument is still real"
      : "⛔ THE CALLDATA NO LONGER CARRIES `maxFee` — re-point this section",
    buildsMaxFee,
    "Under upfront fees maxFee is EMPTY_MAX_FEE (0, measured on chain). Bind instead to the " +
    "SUBMITTED QUOTE's feeTotalAmount, and to the post-burn verdict from bridge-fee-reconcile " +
    "(_fee-reconcile.mjs), which reads what actually moved. Do NOT leave the maxFee assertions in " +
    "place comparing 0 to 0.");

  // ⭐⭐ AND THE SUCCESSOR CLAIM, ASSERTED TODAY BECAUSE IT ALREADY CAN BE. The post-burn
  // reconciliation compares against `feeDisclosedMinor`, so that field must be the same quantity as
  // the decimal beside it — the fee that will actually move. This is the binding that stops the
  // migration inverting the detector into a permanent false alarm.
  check("⭐⭐ the disclosed fee's two units agree on this very execution — the reconciliation's input",
    usdcDecimalToMinorExact(r.feeDisclosed) === BigInt(String(SEALED_MAXFEE)),
    `feeDisclosed ${r.feeDisclosed} -> ${usdcDecimalToMinorExact(r.feeDisclosed)} minor, sealed ${SEALED_MAXFEE}`);
}

section("2 — ⛔ THE SEAL IS FAIL-CLOSED, AND A TAMPERED FEE CANNOT REACH CALLDATA");
{
  const cases = [
    ["a forged token", "notatoken.notamac"],
    ["a token for a DIFFERENT amount", REAL_BRIDGE.sealBridgeQuote({ owner: OWNER, destinationKey: "base", amountUsdc: 999, fee: { amountMinor: 1n, maxFee: 1n, feeUsdc: 1, netUsdc: 1 } })],
    ["a token for a DIFFERENT owner", REAL_BRIDGE.sealBridgeQuote({ owner: "0x" + "22".repeat(20), destinationKey: "base", amountUsdc: AMOUNT, fee: { amountMinor: 1_000_000n, maxFee: SEALED_MAXFEE, feeUsdc: 0.054147, netUsdc: 0.945853 } })],
    ["a token past OUR OWN TTL", REAL_BRIDGE.sealBridgeQuote({ owner: OWNER, destinationKey: "base", amountUsdc: AMOUNT, fee: { amountMinor: 1_000_000n, maxFee: SEALED_MAXFEE, feeUsdc: 0.054147, netUsdc: 0.945853 }, now: Date.now() - REAL_BRIDGE.QUOTE_TTL_MS - 1000 })],
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
      fee: { amountMinor: 1_000_000n, maxFee: SEALED_MAXFEE, feeUsdc: 0.054147, netUsdc: 0.945853,
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
  const approveIdx = code.indexOf('abiFunctionSignature: "approve(address,uint256)"');
  const recheckIdx = code.indexOf("boundFee?.reCheckExpiry");
  const burnIdx = code.indexOf("contractAddress: BRIDGE_CONTRACT");
  check("⭐⭐ the deadline is re-checked AFTER the approve and BEFORE the burn",
    approveIdx > 0 && burnIdx > 0 && recheckIdx > approveIdx && recheckIdx < burnIdx,
    `approve@${approveIdx} < recheck@${recheckIdx} < burn@${burnIdx}`);
  check("⛔ …and no submission-margin literal was introduced instead of a second check",
    !/SUBMIT_MARGIN|submissionMargin|MARGIN_MS/.test(code));
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0`);
console.log(`⭐ The figure shown is the figure signed — decoded from the calldata, with a re-read`);
console.log(`  build failing by construction.\n`);
