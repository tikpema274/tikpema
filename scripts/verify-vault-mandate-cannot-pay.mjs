#!/usr/bin/env node
// verify-vault-mandate-cannot-pay.mjs — the 5th rule, `vault-cannot-pay`: pause-only, and the revert
// classification that is its whole safety property.
//
//   node scripts/verify-vault-mandate-cannot-pay.mjs
//
// ═══ THE PROPERTY (T, 2026-09-25) ════════════════════════════════════════════════════════════
// A simulated redeem that fails is NOT a finding by itself. Only a DECODED revert with a recognised
// shortfall reason is. Sorted explicitly:
//   cash shortfall / USDC refusing           → FINDING (the rule pauses)
//   XyloVault: INSUFFICIENT_BALANCE          → OUTAGE  (our share figure is wrong)
//   RPC failure (not a revert at all)        → OUTAGE
//   an unrecognised revert reason            → INCONCLUSIVE, never a finding
//
// ⭐ THE TRAP THIS SUITE DRIVES THROUGH REAL VIEM ERRORS (measured in viem 2.52.2 source,
// utils/errors/getContractError.js + errors/contract.js): viem turns ANY InternalRpcError (-32603) into
// a ContractFunctionRevertedError, and when there is no revert DATA it copies the RPC's MESSAGE into
// `.reason`. So a node failure is shaped like a revert, and a node message that happens to read
// "ERC20: transfer amount exceeds balance" is shaped like a shortfall. Only decoded Error(string)
// data counts. Both Arc endpoints DO return decodable data for both reverts (measured 2026-09-25).
//
// ⭐ AND THE RULE CANNOT BE SET TO EXIT, in the validator, not the UI. An exit rule here would make
// Tikpema allocate a shortfall between its own users: whichever mandate the scheduler reaches first
// gets paid. That is the platform forming a view.

import { createPublicClient, custom, parseAbi, encodeErrorResult, encodeFunctionResult } from "viem";
import {
  classifyRedeemSimulation, redeemSimulationOutcome, REDEEM_SIM_CLASS as C, SHORTFALL_REASONS, OUR_ERROR_REASONS,
} from "../shared/vault-mandate/redeem-sim.mjs";
import { observeMandateCheck } from "../shared/vault-mandate/observe.mjs";
import { decideMandateAction, validateMandateRules, STATE_RULES, OBSERVED, CAUSE, ACTION, FLAG } from "../shared/vault-mandate/decide.mjs";
import { EXIT_NOT_GUARANTEED, EXIT_FEE_RISE, PAYOUT_NOT_GUARANTEED } from "../shared/vault-mandate/copy.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const attempt = (fn) => { try { return fn(); } catch (e) { return { threw: String(e?.message ?? e) }; } };
const attemptAsync = async (fn) => { try { return await fn(); } catch (e) { return { threw: String(e?.message ?? e) }; } };
const show = (o) => JSON.stringify(o ?? null)?.slice(0, 170);

const SHORT = "ERC20: transfer amount exceeds balance";
const OURS = "XyloVault: INSUFFICIENT_BALANCE";
const rev = (reason, over = {}) => ({ outcome: "reverted", decoded: true, errorName: "Error", reason, ...over });

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  VAULT MANDATE — vault-cannot-pay: pause-only, reverts sorted        ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⭐⭐ the rule is PAUSE-ONLY, enforced in the validator");
{
  ok("vault-cannot-pay is in the state-rule catalogue", "vault-cannot-pay" in STATE_RULES);
  ok("  …and the catalogue itself says exit is not allowed", STATE_RULES["vault-cannot-pay"]?.exitAllowed === false);
  const p = attempt(() => validateMandateRules([{ id: "r-pay", kind: "state", subject: "vault-cannot-pay", onFinding: "pause" }]));
  ok("set to pause → accepted", p?.ok === true, show(p));
  const x = attempt(() => validateMandateRules([{ id: "r-pay", kind: "state", subject: "vault-cannot-pay", onFinding: "exit" }]));
  ok("⭐⭐ a mandate storing EXIT for it → REFUSED", x?.ok === false && (x.errors ?? []).some((e) => e.includes("vault-cannot-pay")), show(x));
  ok("  …and the refusal says why: it would allocate a shortfall between users",
    (x?.errors ?? []).some((e) => /allocat/i.test(e) && /shortfall/i.test(e)), show(x?.errors));
  // The decider runs the same validator, so a stored "exit" that slipped past creation still cannot exit.
  const d = attempt(() => decideMandateAction({
    rules: [{ id: "r-pay", kind: "state", subject: "vault-cannot-pay", onFinding: "exit" }],
    check: { observations: { "r-pay": { status: OBSERVED.VIOLATED, evidence: { reading: "shortfall" } } } } }));
  ok("⭐ a stored exit + a real shortfall finding → PAUSE/MALFORMED, never EXIT",
    d?.action === ACTION.PAUSE && d?.flags?.includes(FLAG.MALFORMED), show(d?.flags ?? d?.threw));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — the four classes, on normalised outcomes");
{
  const cls = (o) => attempt(() => classifyRedeemSimulation(o))?.class;
  ok("the recognised shortfall reason is the one MEASURED on Arc", SHORTFALL_REASONS.includes(SHORT));
  ok("the vault's own share-balance revert is listed as OUR error", OUR_ERROR_REASONS.includes(OURS));
  ok("no reason is in both lists", !SHORTFALL_REASONS.some((r) => OUR_ERROR_REASONS.includes(r)));

  ok("returned assets > 0 → PAID", cls({ outcome: "returned", assetsRaw: "1998000" }) === C.PAID);
  ok("⭐ decoded '" + SHORT + "' → SHORTFALL", cls(rev(SHORT)) === C.SHORTFALL);
  ok("decoded 'Pausable: paused' (USDC refusing) → SHORTFALL", cls(rev("Pausable: paused")) === C.SHORTFALL);
  ok("decoded 'Blacklistable: account is blacklisted' (USDC refusing) → SHORTFALL", cls(rev("Blacklistable: account is blacklisted")) === C.SHORTFALL);
  ok("⭐ decoded '" + OURS + "' → OUR_ERROR", cls(rev(OURS)) === C.OUR_ERROR);
  ok("decoded 'XyloVault: ZERO_SHARES' → OUR_ERROR", cls(rev("XyloVault: ZERO_SHARES")) === C.OUR_ERROR);
  ok("⭐ a transport error → RPC_FAILURE", cls({ outcome: "transport-error", message: "rate limit exceeded" }) === C.RPC_FAILURE);
  ok("⭐ an unrecognised decoded reason → UNRECOGNISED", cls(rev("Vault: not enough liquidity")) === C.UNRECOGNISED);
  ok("⭐⭐ the shortfall TEXT without decoded data (viem copied an RPC message) → UNRECOGNISED",
    cls(rev(SHORT, { decoded: false })) === C.UNRECOGNISED);
  ok("a revert with no reason → UNRECOGNISED", cls(rev(null)) === C.UNRECOGNISED);
  ok("a custom error (not Error(string)) → UNRECOGNISED", cls(rev(SHORT, { errorName: "InsufficientBalance" })) === C.UNRECOGNISED);
  ok("a Panic → UNRECOGNISED", cls(rev(null, { errorName: "Panic" })) === C.UNRECOGNISED);
  ok("a reason that only CONTAINS the shortfall text → UNRECOGNISED (exact match only)",
    cls(rev("Wrapped: " + SHORT)) === C.UNRECOGNISED);
  ok("returned 0 assets → UNRECOGNISED, not paid", cls({ outcome: "returned", assetsRaw: "0" }) === C.UNRECOGNISED);
  ok("a malformed outcome → OUR_ERROR (our normaliser produced nothing usable)", cls(null) === C.OUR_ERROR && cls({ outcome: "maybe" }) === C.OUR_ERROR);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐⭐ through REAL viem errors (a custom transport, the real simulateContract)");
{
  const V = "0x240Eb85458CD41361bd8C3773253a1D78054f747", H = "0x3d7d4c52305ed0c394e01c7184701a522116097d";
  const abi = parseAbi(["function redeem(uint256,address,address) returns (uint256)"]);
  const errData = (reason) => encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string", name: "message" }] }], errorName: "Error", args: [reason] });
  const client = (onCall) => createPublicClient({ transport: custom({ async request({ method }) {
    if (method === "eth_chainId") return "0x7a69"; // 31337, a fixture chain
    if (method === "eth_call") return onCall();
    throw new Error(`unexpected ${method}`);
  } }, { retryCount: 0 }) });
  const run = async (onCall) => {
    const pc = client(onCall);
    try {
      const r = await pc.simulateContract({ address: V, abi, functionName: "redeem", args: [1999996n, H, H], account: H });
      return classifyRedeemSimulation(redeemSimulationOutcome({ result: r.result }));
    } catch (error) { return classifyRedeemSimulation(redeemSimulationOutcome({ error })); }
  };
  const rpcErr = (code, message, data) => { throw Object.assign(new Error(message), { code, message, ...(data ? { data } : {}) }); };

  const cases = [
    ["a successful call → PAID", () => encodeFunctionResult({ abi, functionName: "redeem", result: 1998000n }), C.PAID],
    ["code 3 + Error(shortfall) data → SHORTFALL", () => rpcErr(3, "execution reverted", errData(SHORT)), C.SHORTFALL],
    // Neither Arc endpoint answers this way (both: code 3 + data, measured 2026-09-25). viem does not
    // call this shape a revert, so it lands in OUTAGE: a retry and a pause, never a finding from an
    // error we did not decode, and never a clear. If a provider ever answers like this, a shortfall
    // reads as an outage — the safe direction — and this line says where to look.
    ["code -32000 + Error(shortfall) data (a shape Arc does not use) → RPC_FAILURE, not a finding", () => rpcErr(-32000, "execution reverted", errData(SHORT)), C.RPC_FAILURE],
    ["code 3 + Error(INSUFFICIENT_BALANCE) → OUR_ERROR", () => rpcErr(3, "execution reverted", errData(OURS)), C.OUR_ERROR],
    ["code 3 + an unknown Error(string) → UNRECOGNISED", () => rpcErr(3, "execution reverted", errData("Vault: paused")), C.UNRECOGNISED],
    ["-32005 rate limit → RPC_FAILURE", () => rpcErr(-32005, "rate limit exceeded"), C.RPC_FAILURE],
    ["a fetch-level throw (no JSON-RPC code) → RPC_FAILURE", () => { throw new TypeError("fetch failed"); }, C.RPC_FAILURE],
    ["-32000 'header not found' (no revert) → RPC_FAILURE", () => rpcErr(-32000, "header not found"), C.RPC_FAILURE],
    ["⭐⭐ -32603 'missing trie node' (viem calls it a REVERT) → never SHORTFALL", () => rpcErr(-32603, "missing trie node"), "not-shortfall"],
    ["⭐⭐ -32603 whose MESSAGE reads like the shortfall, no data → never SHORTFALL",
      () => rpcErr(-32603, "execution reverted: " + SHORT), "not-shortfall"],
    // ⭐⭐ THE EXACT TRAP (probed 2026-09-25): these two reach us as a ContractFunctionRevertedError
    // whose `.reason` IS the shortfall string, character for character, with NO decoded data. A
    // classifier that reads `.reason` instead of the decoded data calls a node's error text a finding.
    ["⭐⭐ -32603 with the BARE shortfall text as its message, no data (viem .reason === the text) → never SHORTFALL",
      () => rpcErr(-32603, SHORT), "not-shortfall"],
    ["⭐⭐ code 3 with the bare shortfall text, no data → never SHORTFALL (text is not evidence)",
      () => rpcErr(3, SHORT), "not-shortfall"],
  ];
  for (const [label, onCall, want] of cases) {
    const got = await attemptAsync(() => run(onCall));
    const cls = got?.class;
    ok(label, want === "not-shortfall" ? (cls === C.UNRECOGNISED || cls === C.RPC_FAILURE) : cls === want,
      `class=${cls ?? show(got)}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — observing the rule: two endpoints, the class decides the observation");
{
  const HASH = "0x" + "ab".repeat(32), A = "https://a.example", B = "https://b.example";
  const VAULT = { address: "0x240Eb85458CD41361bd8C3773253a1D78054f747", chainId: 31337 }; // a fixture id: no report is consulted here
  const RULES = [{ id: "r-pay", kind: "state", subject: "vault-cannot-pay", onFinding: "pause" }];
  const sim = (outcome) => ({ mode: "simulated-redeem", sharesRaw: "1999996", outcome });
  const agg = (cashRaw, counterRaw, cashOnly = true) => ({ mode: "aggregate", cashOnly, cashRaw, counterRaw });
  const reading = (endpoint, payability, positionShares = "1999996") =>
    ({ endpoint, blockHash: HASH, exitFee: { declaredBps: 10, measuredBps: 10 }, depositFeeBps: 0,
       redemption: { state: "full", positionShares }, payability });
  const o = (a, b, pos) => attempt(() => observeMandateCheck({ rules: RULES, vault: VAULT, anchor: { blockNumber: 1005, blockHash: HASH },
    maxReportAgeBlocks: 20, report: null, stateReadings: [reading(A, a, pos), reading(B, b ?? a, pos)] }))?.observations?.["r-pay"];
  const isOut = (x) => x?.status === OBSERVED.UNESTABLISHED && x?.cause === CAUSE.OUTAGE;
  const isInc = (x) => x?.status === OBSERVED.UNESTABLISHED && x?.cause === CAUSE.INCONCLUSIVE;
  const PAID = sim({ outcome: "returned", assetsRaw: "1998000" });

  const v = o(sim(rev(SHORT)));
  ok("both endpoints: decoded shortfall → VIOLATED", v?.status === OBSERVED.VIOLATED, show(v));
  ok("  the evidence: our read, unsigned, the reason, the shares simulated, the block",
    v?.evidence?.signed === false && v?.evidence?.revertReason === SHORT && v?.evidence?.sharesRaw === "1999996" && v?.evidence?.blockHash === HASH, show(v?.evidence));
  ok("both paid → CLEAR", o(PAID)?.status === OBSERVED.CLEAR);
  ok("⭐ INSUFFICIENT_BALANCE at either endpoint → OUTAGE", isOut(o(sim(rev(OURS)), sim(rev(SHORT)))), show(o(sim(rev(OURS)), sim(rev(SHORT)))));
  ok("⭐ an RPC failure at either endpoint → OUTAGE", isOut(o(sim({ outcome: "transport-error", message: "x" }), sim(rev(SHORT)))));
  ok("⭐ an unrecognised reason at either endpoint → INCONCLUSIVE", isInc(o(sim(rev("Vault: nope")), sim(rev(SHORT)))));
  ok("paid at one, shortfall at the other → INCONCLUSIVE", isInc(o(PAID, sim(rev(SHORT)))));
  ok("no payability reading → OUTAGE", isOut(o(undefined)));

  ok("no position: cash below what the vault owes → VIOLATED", o(agg("100", "200"), undefined, "0")?.status === OBSERVED.VIOLATED);
  ok("no position: cash ≥ what it owes → CLEAR", o(agg("200", "200"), undefined, "0")?.status === OBSERVED.CLEAR);
  ok("⭐ the aggregate reading on a vault NOT profiled cash-only → INCONCLUSIVE (the counter is not cash)",
    isInc(o(agg("100", "200", false), undefined, "0")));
  ok("the aggregate with an unread figure → INCONCLUSIVE", isInc(o(agg(null, "200"), undefined, "0")));
  ok("endpoints disagree on the aggregate → INCONCLUSIVE", isInc(o(agg("100", "200"), agg("300", "200"), "0")));
  ok("⭐ HOLDING shares but only the aggregate was read → OUTAGE (your own claim must be simulated)", isOut(o(agg("300", "200"))));
  ok("no position but a simulated redeem → OUTAGE (there is nothing to simulate)", isOut(o(PAID, undefined, "0")));

  const d = attempt(() => decideMandateAction({ rules: RULES, check: observeMandateCheck({ rules: RULES, vault: VAULT,
    anchor: { blockNumber: 1005, blockHash: HASH }, maxReportAgeBlocks: 20, report: null,
    stateReadings: [reading(A, sim(rev(SHORT))), reading(B, sim(rev(SHORT)))] }) }));
  ok("⭐ end to end: a real shortfall → PAUSE flagged FINDING, deposits blocked, no exit",
    d?.action === ACTION.PAUSE && d?.flags?.includes(FLAG.FINDING) && d?.depositAllowed === false && d?.exitFindings?.length === 0, show(d?.flags ?? d?.threw));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — the disclosure words T approved, pinned verbatim");
{
  ok("'An exit is not guaranteed' — exact text", EXIT_NOT_GUARANTEED ===
    "An exit is not guaranteed. When one of your rules says exit, we ask the vault to pay you. The vault may not be able to: " +
    "it may be short of USDC, its owner can move the funds out at any time, and USDC itself can refuse a transfer. We check " +
    "whether the vault could pay you at the moment we check, but that can change in the next block. If a vault can't pay, " +
    "your mandate pauses and your shares stay where they are. We can't recover them for you.", show(EXIT_NOT_GUARANTEED));
  ok("  …it ends on 'We can't recover them for you.'", EXIT_NOT_GUARANTEED.endsWith("We can't recover them for you."));
  // T, 2026-09-26: the vault-cannot-pay-only variant — a new opening, the approved ending unchanged.
  ok("'Getting your USDC back is not guaranteed' — exact text", PAYOUT_NOT_GUARANTEED ===
    "Getting your USDC back is not guaranteed. When you withdraw, the vault has to pay you, and it may not be able to: " +
    "it may be short of USDC, its owner can move the funds out at any time, and USDC itself can refuse a transfer. We check " +
    "whether the vault could pay you at the moment we check, but that can change in the next block. If a vault can't pay, " +
    "your mandate pauses and your shares stay where they are. We can't recover them for you.", show(PAYOUT_NOT_GUARANTEED));
  const TAIL_AT = "it may be short of USDC";
  const tail = (t) => (typeof t === "string" && t.includes(TAIL_AT) ? t.slice(t.indexOf(TAIL_AT)) : null);
  ok("⭐ the two share their ending EXACTLY, from 'it may be short of USDC' to 'We can't recover them for you.'",
    tail(EXIT_NOT_GUARANTEED) !== null && tail(EXIT_NOT_GUARANTEED) === tail(PAYOUT_NOT_GUARANTEED));
  ok("  …and the new opening never mentions an exit rule", typeof PAYOUT_NOT_GUARANTEED === "string" &&
    !/exit/i.test(PAYOUT_NOT_GUARANTEED.slice(0, PAYOUT_NOT_GUARANTEED.indexOf(TAIL_AT))));
  ok("the fee-rise sentence, in plain words", EXIT_FEE_RISE ===
    "If the owner raises the exit fee to its cap and your rule exits, you pay that raised fee to leave.", show(EXIT_FEE_RISE));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
