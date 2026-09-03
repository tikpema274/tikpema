// BRIDGE PLANE — cross-chain USDC out of Arc via CCTP + Circle's forwarder.
//
// This is the PRODUCTIZED version of scripts/bridge-direct.mjs (proven live:
// Arc burn 0xaf6f5ba2… → Sepolia mint 0xa9fea2c8…). It drives the bridge through
// Circle's dev-controlled `createContractExecutionTransaction` + `waitForTx`
// (the same battle-tested path as send/swap), NOT App Kit's `kit.bridge()` — that
// path aborts on the Circle-SCA async-hash race (see the memory note / spike).
//
// Flow (single Arc-side signature; destination mint is done by Circle's relayer):
//   1. approve  USDC → BridgingKitContract   (only if allowance < amount)
//   2. bridgeWithPreapprovalAndHook(BridgeParams, cctp-forward hookData)
// The Orbit relayer then fetches the attestation and mints on the destination —
// no destination-chain signature. The fee (fetched live from IRIS) is taken OUT
// OF the bridged amount, so the recipient nets amount − fee.
//
// The fee is VOLATILE (destination gas priced in USDC): ~0.2 USDC to an L2,
// ~1.5–14 USDC to Ethereum L1. Callers MUST refuse a bridge where fee ≥ amount.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { encodeFunctionData, pad, getAddress } from "viem";
import { circle, waitForTx } from "./_circle.mjs";
import { ARC, CONTRACTS, USDC_DECIMALS } from "./_arc.mjs";
import { publicClient } from "./_predict.mjs";
import { normalizeQuoteExpiry, assertQuoteUnexpired } from "./_quote-expiry.mjs";
import { bridgeMechanicOf } from "../../shared/bridge-mechanic.mjs";

export const BRIDGE_CONTRACT = "0xC5567a5E3370d4DBfB0540025078e283e36A363d"; // BridgingKitContract (Arc testnet)
const IRIS = "https://iris-api-sandbox.circle.com"; // testnet IRIS
const ARC_CCTP_DOMAIN = 26;
const FAST_FINALITY = 1000; // FAST tier
const ZERO_HASH = "0x" + "00".repeat(32);
// CCTP forwarding hookData: ASCII "cctp-forward" + version=0 + length=0 (fixed
// constant — see buildForwardingHookData in @circle-fin/app-kit).
const FORWARD_HOOK = "0x636374702d666f72776172640000000000000000000000000000000000000000";

// Supported forwarded-bridge destinations (Arc → these testnets). CCTP domains
// verified against @circle-fin/app-kit chain defs; each confirmed to have a live
// IRIS forwarding tier from Arc. Natural-language aliases feed the parser. The
// fee fetch is the ultimate gate: if IRIS has no forwarding tier for a domain at
// call time, the bridge is refused — so this list can't over-promise.
export const BRIDGE_DESTINATIONS = {
  ethereum: { label: "Ethereum (Sepolia)", cctpDomain: 0, explorerTx: "https://sepolia.etherscan.io/tx/", aliases: ["ethereum", "eth", "sepolia", "ethereum sepolia", "l1", "mainnet"] },
  base: { label: "Base (Sepolia)", cctpDomain: 6, explorerTx: "https://sepolia.basescan.org/tx/", aliases: ["base", "base sepolia"] },
  arbitrum: { label: "Arbitrum (Sepolia)", cctpDomain: 3, explorerTx: "https://sepolia.arbiscan.io/tx/", aliases: ["arbitrum", "arb", "arbitrum sepolia"] },
  optimism: { label: "Optimism (Sepolia)", cctpDomain: 2, explorerTx: "https://sepolia-optimism.etherscan.io/tx/", aliases: ["optimism", "op", "optimism sepolia"] },
  avalanche: { label: "Avalanche (Fuji)", cctpDomain: 1, explorerTx: "https://testnet.snowtrace.io/tx/", aliases: ["avalanche", "avax", "fuji"] },
  polygon: { label: "Polygon (Amoy)", cctpDomain: 7, explorerTx: "https://amoy.polygonscan.com/tx/", aliases: ["polygon", "matic", "amoy", "polygon amoy"] },
  unichain: { label: "Unichain (Sepolia)", cctpDomain: 10, explorerTx: "https://sepolia.uniscan.xyz/tx/", aliases: ["unichain"] },
  linea: { label: "Linea (Sepolia)", cctpDomain: 11, explorerTx: "https://sepolia.lineascan.build/tx/", aliases: ["linea", "linea sepolia"] },
};

// Resolve a natural-language destination name to a supported destination, or null.
/**
 * ⭐⭐ STRICT resolution — EXACT key or EXACT alias, NO contains-match.
 *
 * 🚨 WHY THIS EXISTS, MEASURED 2026-08-28 ON A REAL BRIDGE. `resolveDestination` below has a loose
 * contains-match so an AGENT's natural language ("bridge to ethereum sepolia network") still
 * resolves. That is right for prose and WRONG for an identifier: the string "base-sepolia" — a
 * plausible-looking key — fails exact matching, falls into the loose pass, and matches
 * **ETHEREUM** first, because `ethereum` is iterated before `base` and "base-sepolia" contains
 * "sepolia". A user picked one chain and 2 USDC burned toward another.
 *
 * ⛔ THE FAILURE MODE IS THE PROBLEM, NOT THE MISS. A wrong identifier that RESOLVES ANYWAY is
 * worse than one that errors: nothing surfaces, the quote succeeds, the burn succeeds, and the
 * mistake is only visible on the destination chain afterwards.
 *
 * ⚠️ The loose matcher is NOT removed — the agent path depends on it for free-text input. This is
 * a second, stricter door for callers that pass a machine-chosen key.
 */
export function resolveDestinationStrict(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return null;
  for (const [key, d] of Object.entries(BRIDGE_DESTINATIONS)) {
    if (key === n || d.aliases.includes(n)) return { key, ...d };
  }
  return null;
}

/** The list a UI may offer — DERIVED, never typed. A hardcoded dropdown is the defect above. */
export function destinationOptions() {
  return Object.entries(BRIDGE_DESTINATIONS).map(([key, d]) => ({ key, label: d.label, cctpDomain: d.cctpDomain }));
}

export function resolveDestination(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return null;
  for (const [key, d] of Object.entries(BRIDGE_DESTINATIONS)) {
    if (key === n || d.aliases.includes(n)) return { key, ...d };
  }
  // Loose contains-match so "to ethereum sepolia network" still resolves.
  for (const [key, d] of Object.entries(BRIDGE_DESTINATIONS)) {
    if (d.aliases.some((a) => n.includes(a))) return { key, ...d };
  }
  return null;
}

export const SUPPORTED_DESTINATION_LABELS = Object.values(BRIDGE_DESTINATIONS).map((d) => d.label);

export const BRIDGE_ABI = [
  {
    type: "function",
    name: "bridgeWithPreapprovalAndHook",
    stateMutability: "nonpayable",
    outputs: [],
    inputs: [
      {
        name: "bridgeParams",
        type: "tuple",
        components: [
          { name: "amount", type: "uint256" },
          { name: "maxFee", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "mintRecipient", type: "bytes32" },
          { name: "destinationCaller", type: "bytes32" },
          { name: "burnToken", type: "address" },
          { name: "feeRecipient", type: "address" },
          { name: "destinationDomain", type: "uint32" },
          { name: "minFinalityThreshold", type: "uint32" },
        ],
      },
      { name: "hookData", type: "bytes" },
    ],
  },
];

const ALLOWANCE_ABI = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
];

/**
 * TokenMessengerWithFees on Arc testnet — the upfront-fee entry point, and the new approve target.
 * ⚠️ Also pinned in _fee-reconcile.mjs, which reads the fee back out of the burn's logs. The two
 * are the same address for the same reason and are asserted equal by verify-fee-reconcile.
 */
export const TMWF = "0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A";

const TMWF_ABI = [{
  name: "depositForBurnWithFees", type: "function", stateMutability: "payable", outputs: [],
  inputs: [
    { name: "amount", type: "uint256" }, { name: "destinationDomain", type: "uint32" },
    { name: "mintRecipient", type: "bytes32" }, { name: "burnToken", type: "address" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "claim", type: "tuple", components: [
      { name: "signedQuote", type: "bytes" }, { name: "refundAddress", type: "address" }] },
  ],
}];

const APPROVE_ABI = [{
  name: "approve", type: "function", stateMutability: "nonpayable", outputs: [{ type: "bool" }],
  inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }],
}];

/**
 * ⭐ The account's own batch entry point — `SingleOwnerMSCA`, selector `0x34fcd5be`, confirmed
 * present in the deployed implementation's bytecode (impl `0xd206ac7f…9ec8`) and confirmed to match
 * this encoding. `_checkAccessRuleFromEPOrAcctItself` permits `msg.sender == address(this)`, which
 * is what makes the self-call below legal.
 */
const BATCH_ABI = [{
  name: "executeBatch", type: "function", stateMutability: "payable", outputs: [{ type: "bytes[]" }],
  inputs: [{ name: "calls", type: "tuple[]", components: [
    { name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }],
}];

const toMinor = (usdc) => BigInt(Math.round(Number(usdc) * 10 ** USDC_DECIMALS));
const toUsdc = (minor) => Number(minor) / 10 ** USDC_DECIMALS;

async function irisJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`IRIS ${r.status}`);
  return r.json();
}

// ═══ ⭐⭐ WHAT `netUsdc` MEANS — ONE DEFINITION, NOT A FORMULA REPEATED IN FIXTURES ═══════════
//
// TODAY the CCTP fee is taken OUT OF the burned amount, so what lands is `amount − fee`. That is a
// CLAIM ABOUT THE FEE MECHANICS, not arithmetic, and it was written twice: here, and again inside
// `verify-bridge-fee-band` as `netUsdc: 1.0 - FEE`. A guard that recomputes the producer's formula
// tests its own arithmetic — it would keep passing while `netUsdc` came to mean something else.
//
// ⭐ SO THE MEANING LIVES HERE AND THE GUARD IMPORTS IT. The invariant `net + fee === amount` is
// then assertable in ONE place, against ONE definition, and a change to the mechanics breaks it
// loudly instead of quietly agreeing with itself. [[duplicate-source-of-truth-is-the-recurring-bug]]
//
// ⭐⭐ ADOPTED 2026-09-03, AND THE INVERSION THIS COMMENT PREDICTED HAS HAPPENED. Under
// `depositForBurnWithFees` the fee is collected on the SOURCE chain IN ADDITION to the amount, and
// the recipient receives the FULL amount — observed on Base Sepolia in PR-3, where a burn of 1
// minor unit credited exactly 1, not 1 − fee.
//
// ⛔ SO `netUsdc` IS NOW THE AMOUNT, AND THE FEE IS NOT SUBTRACTED ANYWHERE. Every surface that
// derived "what arrives" from the old formula was wrong by exactly the fee the day this landed,
// which is why the definition lives here alone and `verify-bridge-fee-band` imports it: that guard
// asserted `net + fee === amount` precisely so this change could not be made quietly.
//
// ⚠️ THE FEE DID NOT MOVE OR CHANGE SIZE — IT MOVED WHERE IT IS CHARGED. Measured against our own
// producer on 2026-09-03: the same route quoted 54121 minor either way. "Is it more expensive" is
// not one of the open questions; "what does the recipient get" is, and the answer is now: all of it.
// ═══ ⭐⭐⭐ WHEN A DEFINITION CHANGES, ENUMERATE ITS READERS AND ASK WHICH ARE PREDICATES ════════
//
// 🚨 THIS FUNCTION'S INVERSION KILLED A GUARD, AND NOTHING REPORTED IT. `_analystb`'s bridge
// fee-floor tested `net <= 0` — correct while `netUsdc` meant `amount − fee`, because a fee at or
// above the amount drove it to zero. Once `netUsdc` became the amount, that condition was
// **unreachable for any positive bridge**. The refusal did not become wrong; it became impossible,
// while still sitting in the file reading as a live economic guard.
//
// ⛔ MUTATION CANNOT FIND THIS. Mutating an unreachable branch changes nothing observable — the
// suite is green before and after, because the branch never ran either way. Neither does a failing
// test, a log line, or a user report: a dead guard produces NOTHING, and its green run is
// indistinguishable from the run of a guard that simply had nothing to refuse.
//
// ⭐⭐ SO THE METHOD IS EXPLICIT AND IT IS NOT "TEST HARDER". Changing what a value MEANS obliges
// two questions of every reader, not one:
//     1. is what it now SAYS still true?          ← the one everybody asks
//     2. can what it now TESTS still happen?      ← the one that gets skipped, because the
//                                                   reader's code looks untouched
// Enumerate the readers; the PREDICATES over the redefined value are the candidate corpses. Here
// four readers compared `netUsdc`: three compared it to a fee and stayed reachable, one compared it
// to zero and died. ⚠️ It is now `feeUsdc >= amountUsdc`, the same form the other three floors use,
// so the four share a shape and a future redefinition cannot silently orphan one of them.
export function bridgeNetUsdc({ amountMinor }) {
  return toUsdc(BigInt(amountMinor));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ⛔ THE SELF-SIGNED PATH STAYS ON THE OLD MECHANICS — A DECISION, NOT AN OMISSION
// ══════════════════════════════════════════════════════════════════════════════════════════════
// The agent path moved to `depositForBurnWithFees`, where the approve and the burn ride in ONE
// userOp so no allowance can ever stand alone. **A browser EOA cannot do that.** It signs one
// transaction at a time, so migrating the self-signed path would mean a separate approve followed
// by a separate burn — reintroducing, on the one path we cannot batch, exactly the standing
// allowance to a single-key-upgradeable proxy that batching was chosen to eliminate.
//
// ⭐ SO IT KEEPS `bridgeWithPreapprovalAndHook`, where the fee is DEDUCTED FROM the amount, and it
// keeps the pricing that mechanic needs. ⚠️ TWO FEE MECHANICS ARE THEREFORE LIVE AT ONCE, and that
// is the thing to know before reading any "what arrives" figure: on the agent path the recipient
// gets the FULL amount; on the self-signed path they get amount − fee. The two functions are named
// for their mechanics rather than their callers so no surface can pick the wrong one by habit.
//
// 🚨 NOT A DUPLICATE OF `bridgeFee`. They price two different contracts with two different fee
// models. Collapsing them into one function with a flag would be the real duplicate — one body
// answering two questions, with the caller's flag deciding which answer is true.

/** What the recipient nets when the fee is DEDUCTED from the burn (self-signed path only). */
export function bridgeNetDeducted({ amountMinor, maxFee }) {
  return toUsdc(BigInt(amountMinor) - BigInt(maxFee));
}

/**
 * The self-signed path's price: providerFee (CCTP fast-burn) + forwarderFee, computed as the SDK
 * does. `maxFee` here is a REAL calldata parameter — it is signed into
 * `bridgeWithPreapprovalAndHook` — so unlike the agent path the name is true.
 */
export async function bridgeFeeDeducted({ amountUsdc, cctpDomain }) {
  const amountMinor = toMinor(amountUsdc);
  const [burn, fwd] = await Promise.all([
    irisJson(`${IRIS}/v2/burn/USDC/fees/${ARC_CCTP_DOMAIN}/${cctpDomain}`),
    irisJson(`${IRIS}/v2/burn/USDC/fees/${ARC_CCTP_DOMAIN}/${cctpDomain}?forward=true`),
  ]);
  const burnTier = burn.find((t) => t.finalityThreshold === FAST_FINALITY);
  const fwdTier = fwd.find((t) => t.finalityThreshold === FAST_FINALITY);
  if (!fwdTier?.forwardFee) throw new Error("destination is not available for forwarded bridging right now");
  const scaledBps = BigInt(Math.round(Number(burnTier?.minimumFee ?? 0) * 100));
  const baseFee = (scaledBps * amountMinor + 999_999n) / 1_000_000n;
  const providerFee = baseFee + baseFee / 10n; // +10% buffer (matches SDK)
  const forwarderFee = BigInt(fwdTier.forwardFee.high);
  const maxFee = providerFee + forwarderFee;
  return {
    amountMinor, maxFee, feeUsdc: toUsdc(maxFee),
    netUsdc: bridgeNetDeducted({ amountMinor, maxFee }),
    providerFeeUsdc: toUsdc(providerFee), forwarderFeeUsdc: toUsdc(forwarderFee),
    // ⭐ THE OTHER MECHANIC, FROM THE OTHER PRODUCER. Same rule: the pricing function declares it.
    mechanic: "deducted",
  };
}

/** The self-signed path's calldata — unchanged, against BridgingKitContract. */
export function bridgeCallDataDeducted({ amountMinor, maxFee, recipient, cctpDomain }) {
  const bridgeParams = {
    amount: amountMinor, maxFee, fee: 0n,
    mintRecipient: pad(getAddress(recipient), { size: 32 }),
    destinationCaller: ZERO_HASH,
    burnToken: CONTRACTS.USDC,
    feeRecipient: BRIDGE_CONTRACT,
    destinationDomain: cctpDomain,
    minFinalityThreshold: FAST_FINALITY,
  };
  return encodeFunctionData({ abi: BRIDGE_ABI, functionName: "bridgeWithPreapprovalAndHook", args: [bridgeParams, FORWARD_HOOK] });
}

/**
 * ═══ ⭐⭐ THE PRICE COMES FROM CIRCLE'S SIGNED QUOTE, NOT FROM THE IRIS FEE TIERS ═══════════════
 *
 * Under CCTP upfront fees the fee is not something we compute — it is quoted, signed, and enforced
 * on chain. `depositForBurnWithFees` will not accept a fee we derived ourselves; it takes the
 * signed quote and `assert`s that what the FeeManager collects equals what the quote said.
 *
 * ⛔ SO THE OLD ARITHMETIC IS GONE, NOT REFACTORED. It read two IRIS tier tables, picked the FAST
 * tier, scaled `minimumFee` into a base fee and added a 10% buffer to match the SDK. Every line of
 * that was OUR reconstruction of someone else's pricing, and none of it is authoritative any more.
 * Keeping it as a cross-check would be a second source of truth for a number the chain enforces.
 *
 * ⭐ `feeMinor`, NOT `maxFee`. The old name came from the CCTP burn parameter it was signed into —
 * and under upfront fees that parameter is `EMPTY_MAX_FEE`, hardcoded to ZERO and measured as zero
 * on chain in run 2's `DepositForBurn`. A field called `maxFee` holding the real fee, beside a
 * calldata `maxFee` of 0, is a name that is false wherever it is read.
 *
 * ⚠️ `minFinalityThreshold` IS NO LONGER OURS TO CHOOSE. `_inferParamsFromQuote` derives it from
 * the quote — 2000 (SLOW) for a FORWARD-only quote — so `FAST_FINALITY` leaves the call entirely.
 * ⛔ MINT_TIMING DOES NOT MOVE ON THIS. The single SLOW settlement we have measured was 11s, which
 * is consistent with the existing copy; one observation is not a distribution and must not edit it.
 *
 * @returns {{amountMinor, feeMinor, feeUsdc, netUsdc, quote}} — `quote` is the verbatim response,
 *          carrying `signedQuote`, `expiry` and `feeTotalAmount`. It travels with the fee so every
 *          downstream figure comes from ONE quote and nothing re-reads.
 */
export async function bridgeFee({ amountUsdc, cctpDomain }) {
  const amountMinor = toMinor(amountUsdc);
  const res = await fetch(`${IRIS}/v2/quote/burn/usdc/${ARC_CCTP_DOMAIN}/${cctpDomain}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amount: amountMinor.toString(), feeToken: CONTRACTS.USDC, requests: [{ type: "FORWARD" }] }),
  });
  if (!res.ok) throw new Error(`quote ${res.status} — destination is not available for forwarded bridging right now`);
  const quote = await res.json();
  // ⛔ THE FEE TOKEN IS CHECKED, NOT ASSUMED. We ask for the ERC-20 path because a gasless SCA
  // cannot attach `msg.value`; a quote that came back priced in something else would produce a burn
  // whose fee we cannot pay, and the failure would surface as an opaque revert after the approve.
  if (String(quote?.feeToken ?? "").toLowerCase() !== CONTRACTS.USDC.toLowerCase()) {
    throw new Error(`quote came back with feeToken ${quote?.feeToken} — expected Arc USDC`);
  }
  if (typeof quote?.signedQuote !== "string" || !/^\d+$/.test(String(quote?.feeTotalAmount ?? ""))) {
    throw new Error("quote is missing a signedQuote or a feeTotalAmount");
  }
  const feeMinor = BigInt(quote.feeTotalAmount);
  return {
    amountMinor,
    feeMinor,
    feeUsdc: toUsdc(feeMinor),
    netUsdc: bridgeNetUsdc({ amountMinor }),
    quote,
    // ⭐⭐ THE MECHANIC IS ORIGINATED HERE, BY THE FUNCTION THAT KNOWS WHICH CONTRACT WILL BE CALLED.
    // Not inferred downstream from a field's shape, not decided by a surface: the producer of the
    // price is the only thing that knows where the fee will be charged, so it says so.
    mechanic: "upfront",
  };
}

/**
 * ⭐⭐ WHAT THE WALLET ACTUALLY PARTS WITH — amount AND fee, in MINOR UNITS.
 *
 * ⛔ EXACT BY CONSTRUCTION, SO THERE IS NOTHING TO ROUND. Both operands are BigInt minor units from
 * the SAME quote, and their sum is exact. The directional rule ("a required figure rounds UP")
 * therefore applies only to what is RENDERED — see requiredAmount/availableAmount at the surfaces.
 * ⚠️ A float version of this would need a rounding decision, and the safe direction (up) would then
 * have to be argued at every call site. Not converting is strictly better than converting carefully.
 */
export function bridgeDebitMinor(fee) {
  return BigInt(fee.amountMinor) + BigInt(fee.feeMinor);
}

// ══════════════════════════════════════════════════════════════════════════════════════
// THE FEE BAND — "covers the fee" and "worth doing" are different thresholds
// ══════════════════════════════════════════════════════════════════════════════════════
// The fee-floor refuses only when `fee >= amount`, i.e. when NOTHING would arrive. That
// leaves a wide gap in which a bridge is technically settleable and economically absurd,
// and nothing sat in it. At today's flat ~0.0532 fee to Base:
//     1.0   USDC ->  5.3% fee     fine
//     0.1   USDC -> 53.2% fee     passes the floor, over half the money is gone
//     0.054 USDC -> 98.5% fee     passes the floor, 0.0008 arrives
// The fee is FLAT, so the ratio worsens as the amount shrinks — the smaller the bridge,
// the more it needs saying.
//
// ⭐ COMPUTED ONCE, HERE, AND THREADED. Every caller (agent-act's quote, _actions'
// execution gate, every UI surface) reads the SAME structured verdict rather than
// re-deriving a ratio from two numbers. That is the refundClass pattern: the producer
// decides the class, and no surface re-computes it. Three surfaces re-deriving one fact
// is precisely how this product ended up with three different bridge renderings.
export const FEE_BAND_WARN = 0.10;        // >=10% of the amount: disclose prominently
export const FEE_BAND_ACKNOWLEDGE = 0.25; // >=25%: disclosure alone is not consent

// 🚨 READ THIS BEFORE ADDING A BAND — CONSENT CORRECTNESS DEPENDS ON IT.
//
// The bands are ORDERED by severity and `acknowledge` is the TOP one. Exactly ONE band
// gates execution (see the `bandInfo.band === "acknowledge"` check in _actions.mjs), and
// a whole rule rests silently on that fact:
//
//   THE FEE IS VOLATILE, so a plan quoted below the acknowledge band can reach execution
//   above it. The agreed rule is: accept an acknowledgment if the CURRENT band is no
//   WORSE than the one acknowledged; refuse only on a genuine worsening. That rule needs
//   NO CODE today — because `acknowledge` is the top band, a token can only exist for it,
//   so an EXACT token match already means "current is no worse than acknowledged", and
//   any improvement simply stops gating.
//
// ⚠️ ADD A GATING BAND ABOVE `acknowledge` AND THAT REASONING SILENTLY BREAKS. A user who
// accepted `acknowledge` would hold a token that no longer matches the new top band, and
// `_actions` would refuse them MID-PLAN — after earlier steps have moved funds, which is
// the exact outcome the pre-flight in agent-execute-plan.mjs exists to prevent. Nobody
// adding a band would be reading the token check, which is why this is written HERE.
//
// If you add one, you must ALSO: mint a token per band, send the acknowledged band
// alongside the token, authenticate it (recompute and compare), and replace the exact
// match with an explicit `severity(current) <= severity(acknowledged)` comparison.
// `verify-bridge-fee-band.mjs` pins this vocabulary and will fail if you change it.
export const FEE_BANDS = ["none", "warn", "acknowledge"]; // ordered least → most severe
export const GATING_BANDS = ["acknowledge"];              // the ONLY bands that refuse

/** @returns {{feeRatio:number, band:"none"|"warn"|"acknowledge", feeUsdc:number, netUsdc:number}} */
export function bridgeFeeBand({ amountUsdc, feeUsdc, netUsdc }) {
  const amount = Number(amountUsdc);
  const fee = Number(feeUsdc);
  // A non-finite or non-positive amount cannot be reasoned about. Return the STRICTEST
  // band rather than "none": an unknown ratio must never read as a safe one.
  if (!Number.isFinite(amount) || !Number.isFinite(fee) || amount <= 0) {
    return { feeRatio: 1, band: "acknowledge", feeUsdc: fee, netUsdc: Number(netUsdc) };
  }
  const feeRatio = fee / amount;
  const band =
    feeRatio >= FEE_BAND_ACKNOWLEDGE ? "acknowledge" : feeRatio >= FEE_BAND_WARN ? "warn" : "none";
  return { feeRatio, band, feeUsdc: fee, netUsdc: Number(netUsdc) };
}

/**
 * The acknowledgment token, same shape as the vault card's (`ackTokenFor`): a hash of the
 * disclosure the user actually saw, so a stale acknowledgment cannot be replayed against a
 * different one.
 *
 * ⚠️ IT BINDS TO THE BAND, NOT THE EXACT FEE. The fee is re-quoted live at execution and
 * moves constantly (0.0541 / 0.053520 / 0.053196 on one route in a single day). Binding to
 * the number would invalidate every acknowledgment on the next tick and train people to
 * click through a box that always complains. Binding to the BAND means small drift is
 * tolerated and crossing into a worse disclosure correctly invalidates the ack.
 *
 * ⭐ IT ALSO BINDS TO THE OWNER. Without that, one token was valid for ANY wallet at the
 * same amount/destination/band — and a quote priced for one wallet stayed acknowledgeable
 * after switching to another, which is exactly what a stale on-screen quote invited. Not
 * exploitable on its own (the server re-prices, and a caller can only acknowledge their own
 * bridge), but the token is EVIDENCE OF CONSENT, and evidence not bound to who consented is
 * weaker than it looks. `v2` because adding the field changes every digest.
 * ⚠️ Owner may legitimately be absent on paths that carry no session; it degrades to "anon",
 * which is consistent within a request and so never causes a false refusal — it only makes
 * the binding weaker there.
 */
export function bridgeAckToken({ owner, destinationKey, amountUsdc, band }) {
  // ═══ 🚨 HMAC, NOT A BARE HASH — AND THIS IS WHAT THE TOKEN'S NAME ALWAYS CLAIMED ═══════════════
  // Until v3 this was `sha256(<public string>)`. Every input — owner, destination, amount, band — is
  // visible to the caller and three of them are on the receipt, so ANY caller could recompute the
  // token for a plan it was already proposing. The gate's refusal therefore stopped a client that had
  // not bothered, not one intending to bypass: an explicit-intent marker for a cooperating UI, not an
  // authentication. Verified by recomputation 2026-08-17 — the stored token reproduced exactly from
  // four public values.
  //
  // ⭐ WITH A SERVER KEY THE REFUSAL BECOMES REAL. A token can now only originate from a disclosure
  // this server issued, so "the client held a token" is evidence rather than arithmetic — and only
  // then is it worth storing a HASH of it on the receipt (see `ackTokenHash` in _bridge-record.mjs).
  // Hashing a publicly-derivable value would have removed no capability and preserved no evidence;
  // the two changes are one decision and land together.
  //
  // 🚨 FAIL-CLOSED, NEVER WEAK. A missing key must NOT degrade to an unkeyed digest — that would
  // silently restore exactly the property being removed, and every caller would keep working. In
  // practice this is unreachable on an authenticated path (`_auth.mjs` disables sessions without the
  // same secret, so the request 401s first), which makes it a backstop rather than a live branch.
  //
  // ⚠️ IT RIDES ON `SESSION_SECRET` RATHER THAN A NEW VAR, DELIBERATELY. A new env var would be unset
  // at first deploy, and the only safe behaviour then is refusing every acknowledge-band bridge — a
  // self-inflicted outage on the money path. The cost is real and is recorded: rotating SESSION_SECRET
  // now invalidates outstanding acknowledgments too, alongside sessions and `internalToken()`.
  const secret = process.env.SESSION_SECRET;
  if (!secret || String(secret).length < 16) {
    throw new Error("SESSION_SECRET not set (>=16 chars) — a bridge acknowledgment cannot be minted or verified");
  }
  const who = owner ? String(owner).toLowerCase() : "anon";
  // ⚠️ `v3` because keying changes every digest. An in-flight plan card holding a v2 token is refused
  // at confirm and re-asks for acknowledgment — correct, and the reason acceptance is asked for at a
  // point where it can still be given freely.
  const digest = `bridge|${who}|${String(destinationKey)}|${Number(amountUsdc)}|band:${band}|v3`;
  return createHmac("sha256", String(secret)).update(digest).digest("hex");
}

// ⭐ THE STORED FORM OF THIS TOKEN LIVES IN `_bridge-receipts.mjs` (`ackTokenFingerprint`), not here.
// It is a property of the RECORD FORMAT — what a receipt may durably hold — rather than of minting,
// and keeping it there stops `_bridge-record.mjs` from importing this whole module (viem, _circle,
// _predict) for a two-line hash.
// Build the bridgeWithPreapprovalAndHook calldata (byte-identical to App Kit's
// custom-burn path).
// ⭐ EXPORTED 2026-08-28 for the USER-SIGNED bridge. A MetaMask burn must be byte-identical to
// the agent's, and the only way to guarantee that is to build it here — once — rather than
// reimplementing the tuple in the browser where it would drift silently.
// 🚨 THE CLIENT NEVER SUPPLIES `maxFee`. It arrives from `bridgeFee()` on the same server request
// that computes the band, because the band is DERIVED from maxFee: a client-chosen maxFee would
// let the caller pick the band its own acknowledgment is checked against, making the gate theatre.

// ═══ ⚠️ TWO BRIDGE PATHS NOW SHOW A FEE BEFORE THE ACTION, AND THE GUARANTEES DIFFER ══════════
//
// A user meeting both reasonably assumes one promise. They are not the same promise, and the
// difference is worth stating where someone changing either will read it:
//
//   #/bridge-manual (self-signed)  the figure is `maxFee` inside calldata the USER SIGNS. It is a
//                                  CEILING enforced by the contract: the bridge cannot take more,
//                                  and the user holds the transaction that says so.
//
//   #/bridge (agent)               the figure is a server-side quote, SEALED for QUOTE_TTL_MS and
//                                  bound to the burn (see below). It is the fee that will be
//                                  charged because this server will not re-read it — not because
//                                  a contract the user signed forbids more.
//
// ⭐ Both are true statements and neither is weaker in practice; they are different KINDS of
// binding — one is enforced by the chain, one by this code path plus a MAC. ⛔ So the two panels
// must NOT share a fee sentence: reusing the manual wording here would assert a contract-enforced
// ceiling that the agent path does not have. The copy in BridgePanel says "quoted just now and
// held for this bridge, not re-read when it runs", which is exactly and only what is true.
//
// ═══ ⭐⭐ CONSENT-FEE BINDING — THE FIGURE SHOWN IS THE FIGURE SIGNED ═══════════════════════════
//
// Until this, `agentBridge` priced the bridge ITSELF, so a confirm step showing a fee would have
// shown one quote while the calldata carried another — the two are ~200 ms apart on the existing
// path and the fee moves roughly every 30 s (docs/agent-receipt-fee-authority-scope.md). Across a
// HUMAN pause that gap is seconds, not milliseconds, so a naive confirm step would show a number
// and burn a different one — worse than the silence it replaces.
//
// ⛔ AND THE FEE CANNOT SIMPLY BE POSTED BACK BY THE CLIENT. `maxFee` goes straight into signed
// calldata; a user-supplied one would let a caller choose what the burn authorises. Today the ONLY
// client value reaching the gate is `ackToken`, explicitly untrusted and recomputed server-side.
//
// ⭐ SO THE QUOTE TRAVELS SEALED. The server issues ONE opaque string; the client returns it
// verbatim and never handles a fee field. Tampering breaks the HMAC and the bridge is refused, so
// nothing user-controllable reaches the calldata — the figure inside is the server's own.
//
// ⚠️ HMAC RATHER THAN A BLOBS-STORED HANDLE, DELIBERATELY. A stored quote would be written then
// read seconds later, and this project's Blobs reads are EVENTUALLY CONSISTENT — the read could
// miss its own write and refuse a legitimate confirm. Sealing carries the value with the token and
// has no read at all. [[stale-read-then-act]] · [[netlify-blobs-strong-consistency]]
//
// ⚠️ Rides on SESSION_SECRET for the same reason bridgeAckToken does: a new env var would be unset
// at first deploy and the only safe behaviour then is refusing every bridge.
export const QUOTE_TTL_MS = 180_000; // 3 min — long enough to read a figure, short enough to bound drift

/**
 * ⭐⭐ HOW LONG THIS QUOTE IS ACTUALLY GOOD FOR, IN MILLISECONDS — THE TIGHTER OF TWO REAL BOUNDS.
 *
 *   OURS    `QUOTE_TTL_MS` — how long we will honour our own seal.
 *   THEIRS  the quote's `expiry` — after which the BURN REVERTS on chain.
 *
 * ⛔ NOT A MIN OVER TWO NUMBERS OF THE SAME KIND. Ours is an age budget in milliseconds; theirs is
 * an absolute instant in SECONDS. Turning theirs into a remaining duration is a computation, done
 * here, once — and 120_000 never appears in our source. Circle's window is documented as
 * APPROXIMATE and is measured at 120s on both real quotes; a retyped vendor constant on a money
 * path, free to drift with nobody watching, is exactly what this avoids.
 *
 * ⚠️ A block-height quote yields OUR bound only, and that is honest rather than convenient: this
 * path cannot convert a block height into a duration without a live block read and a block-time
 * assumption. `openBridgeQuote` refuses such a quote outright, so the figure never reaches a user.
 */
export function quoteWindowMs(fee, now = Date.now()) {
  const q = fee?.quote;
  if (!q || q?.expiry?.mode !== "TIMESTAMP") return QUOTE_TTL_MS;
  const theirsMs = (Number(q.expiry.expiresAt) * 1000) - now;   // SECONDS -> ms, computed
  if (!Number.isFinite(theirsMs)) return QUOTE_TTL_MS;
  return Math.max(0, Math.min(QUOTE_TTL_MS, theirsMs));
}

function quoteSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || String(secret).length < 16) {
    throw new Error("SESSION_SECRET not set (>=16 chars) — a bridge quote cannot be sealed or opened");
  }
  return String(secret);
}
const b64u = (buf) => Buffer.from(buf).toString("base64url");

/** Seal a priced quote into ONE opaque string. The client stores and returns it; it never sees a
 *  fee field it could alter, and every field the gate will trust is inside the MAC. */
export function sealBridgeQuote({ owner, destinationKey, amountUsdc, fee, now = Date.now() }) {
  // ═══ ⭐⭐ THE QUOTE SOURCE IS A DISCRIMINATOR, NOT AN ABSENCE ═════════════════════════════════
  //
  // Two pricing paths exist: our own live `bridgeFee()` read (self-issued, bounded only by
  // QUOTE_TTL_MS) and Circle's signed upfront-fee quote (which carries its OWN deadline, after
  // which the burn REVERTS).
  //
  // ⛔ "EXTERNAL EXPIRY FIELDS ARE MISSING, SO USE OUR TTL" WOULD BE ABSENCE READING AS SAFE — and
  // on exactly the surface where it costs the most. A migration that dropped the expiry from the
  // fee object would silently restore a 180-second window over a 120-second quote, with nothing
  // failing and nothing to look at. So the SOURCE is named in the payload and the opener requires
  // the fields that source implies. An unrecognised source refuses.
  const externallyQuoted = !!fee?.quote;
  const xp = externallyQuoted ? normalizeQuoteExpiry(fee.quote) : null;
  const payload = {
    o: owner ? String(owner).toLowerCase() : "anon",
    d: String(destinationKey),
    a: Number(amountUsdc),
    // ⭐ BigInts as strings — they are the values that reach the calldata.
    // ⚠️ `m` now holds the QUOTE'S fee (`feeMinor`), not a `maxFee`. The burn's own maxFee is
    // EMPTY_MAX_FEE — zero — so a field named for it would be false wherever it is read.
    m: fee.feeMinor.toString(),
    n: fee.amountMinor.toString(),
    f: Number(fee.feeUsdc),
    t: Number(fee.netUsdc),
    // ⚠️ MILLISECONDS — Date.now(). The external `xe` beside it is SECONDS. The two are never
    // compared to each other; see the units block in assertQuoteUnexpired.
    iat: now,
    qs: externallyQuoted ? "circle" : "self",
    // ⭐⭐ THE MECHANIC TRAVELS INSIDE THE MAC. It decides which sentence a user is shown about
    // where their fee went, so a client-alterable one would let a caller choose the claim. Sealed
    // for the same reason the fee is.
    fm: fee.mechanic ?? "unknown",
    // ⭐ mode AND expiresAt, both INSIDE the MAC, never the value alone. Storing a bare number would
    // let a block height be compared against a clock — a category error that reads as an ordinary
    // `>` in source. The mode is the field that makes the number mean anything.
    ...(externallyQuoted ? { xm: xp.mode, xe: xp.expiresAtSec, sq: fee.quote.signedQuote } : {}),
  };
  const body = b64u(JSON.stringify(payload));
  const mac = createHmac("sha256", quoteSecret()).update(`bridgequote|${body}|v1`).digest("base64url");
  return `${body}.${mac}`;
}

// ═══ ⛔ ADOPTION BLOCKER — CCTP UPFRONT FEES AND THIS EXPIRY CHECK ════════════════════════════
//
// Circle's upfront-fee flow (2026-09-02) issues its OWN signed quote with its OWN expiry, and a
// burn submitted after that expiry REVERTS. Measured against the docs: Arc testnet's quote window is
// "approximately 2 minutes"; `QUOTE_TTL_MS` here is 3 minutes. Our seal can therefore outlive
// Circle's quote by up to a minute — and the revert would land AFTER the approve has confirmed.
//
// ⛔ THE FIX IS NOT TO HARDCODE 120_000. Three reasons, and the third is the one that settles it:
//   a. We do not use Circle's signed quote today. This path burns through BridgingKitContract via
//      `bridgeWithPreapprovalAndHook`, so that expiry governs nothing here. There is NO LIVE GAP.
//   b. 120s is Circle's constant, and their own table calls it APPROXIMATE. Copying it in would be
//      the defect we bound MINT_TIMING and the marketing refusal count away from this week: a
//      number retyped from someone else's document, free to drift with nobody watching.
//   c. Circle's expiry may be a SOURCE BLOCK NUMBER, not wall-clock — "A quote's expiry is either an
//      exact wall-clock time or a source blockchain block number." A millisecond TTL cannot
//      represent a block height at all, so no literal is even the right SHAPE.
//
// ═══ ⭐⭐ EXISTENCE PROOF, 2026-09-03 — ARC-AS-SOURCE UPFRONT FEES WORK ON OUR EXACT ROUTE ════
// A third-party wallet (arc-ai-wallet.vercel.app) renders a live Arc → Base Sepolia bridge as:
//     bridge amount 2 USDC · forwarder fee 0.054129 USDC · USDC needed on source 2.054129 USDC
// with Approve and Burn both "Included" — the same two-transaction shape we already run.
// ⚠️ THEIR FIGURE IS REPORTED, NOT FETCHED BY US. [[conversation-sourced-numbers-must-be-marked]]
//
// ⭐ IT IS THE SAME FEE, MEASURED AGAINST OUR OWN PRODUCER. `bridgeFee({amountUsdc: 2, cctpDomain: 6})`
// returned 54121 minor units — 0.054121 USDC — on 2026-09-03: finalityThreshold 1000, minimumFee 0,
// forwardFee.high 54121 (low/med are 53821, so they read the SAME band we do), providerFee 0. Their
// 0.054129 is EIGHT MINOR UNITS away, inside our own measured spread for this route
// (0.054071 / 0.054145 / 0.054147 / 0.054208). Same tier, same band, read moments apart.
//
// 🚨 SO ADOPTION CHANGES **WHERE** THE FEE IS CHARGED, NOT **WHAT** IT COSTS. The fee is flat with
// respect to the amount (verified: identical at 1 and 2 USDC), and it is the same number either way
// — today taken out of the 2, under upfront fees charged on top of it. "Is it more expensive" is
// therefore NOT one of the open questions, and should not be re-asked.
//
// ⭐ WHICH NARROWS THE REMAINING UNKNOWNS TO OURS, NOT CIRCLE'S:
//   1. the approve TARGET moves from BridgingKitContract to TokenMessengerWithFees
//      (0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A on Arc — proxy verified, impl 0x9dc13cc5…,
//       tokenMessenger() → 0x8FE6B999…, Arc's own TokenMessengerV2)
//   2. the allowance must cover amount + fee, not amount. `job-bridge-approve.mjs`'s
//      "REQUIRED = amount, NO BUFFER" reasoning becomes wrong, and an exact-amount allowance
//      would revert every burn.
//   3. the quote-expiry binding below — the one blocker with no code written for it yet.
// None of the three is a question about whether Circle supports us. They are all questions about
// our own two transactions.
//
// ⭐ THE RESOLUTION, STATED SO ADOPTION CANNOT QUIETLY SKIP IT: on adoption the seal's expiry must be
// DERIVED FROM THE QUOTE'S OWN EXPIRY FIELD — carried inside the MAC and compared against whatever
// unit Circle expresses it in — never set to a literal we hope is smaller. `verify-bridge-fee-binding`
// §4 fails if a signed-quote or external-expiry field appears here without the check reading it.
/** Open a sealed quote, or throw. ⛔ FAIL-CLOSED AT EVERY STEP — a malformed token, a bad MAC, an
 *  expired quote or a mismatch against what the caller is now asking for all REFUSE. The mismatch
 *  checks matter: without them a quote for 0.1 USDC could authorise a burn of 100. */
export function openBridgeQuote(token, { owner, destinationKey, amountUsdc, now = Date.now() }) {
  if (typeof token !== "string" || !token.includes(".")) throw new Error("bridge quote is missing or malformed");
  const [body, mac] = token.split(".");
  const expected = createHmac("sha256", quoteSecret()).update(`bridgequote|${body}|v1`).digest("base64url");
  // ⚠️ Length-checked before timingSafeEqual, which THROWS on a length mismatch.
  if (!mac || mac.length !== expected.length ||
      !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    throw new Error("bridge quote failed verification — it was not issued by this server");
  }
  let p;
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
  catch { throw new Error("bridge quote is unreadable"); }
  // ── DEADLINE 1 — OURS, measured from our own issuance stamp. MILLISECONDS on both sides. ──────
  if (!Number.isFinite(p.iat) || now - p.iat > QUOTE_TTL_MS) throw new Error("bridge quote has expired — price it again");
  if (now - p.iat < -5_000) throw new Error("bridge quote is not yet valid");

  // ── DEADLINE 2 — THE QUOTE'S OWN, when there is one ──────────────────────────────────────────
  // ⭐⭐ TWO INDEPENDENT DEADLINES, BOTH ENFORCED, NEITHER REPLACING THE OTHER. They are not a
  // numeric `min`: ours is a millisecond age from `iat`, theirs is an absolute second-precision
  // instant, and on the upfront-fee path theirs (~120s) is the tighter one. Ours still bounds a
  // quote whose external deadline is somehow far in the future.
  // ⛔ THE SOURCE DECIDES WHICH FIELDS ARE REQUIRED — an absence never selects a branch.
  const expiry = openQuoteExpiry(p, now);

  const who = owner ? String(owner).toLowerCase() : "anon";
  if (p.o !== who) throw new Error("bridge quote belongs to another wallet");
  if (p.d !== String(destinationKey)) throw new Error("bridge quote is for a different destination");
  // ═══ ⛔⛔ THE AMOUNT BINDING IS OURS, AND UNDER UPFRONT FEES IT IS THE ONLY ONE ═══════════════
  // MEASURED, two independent instruments, before adoption:
  //   1. THE VERIFIED PREIMAGE. `_buildRequests` builds the signed args WITHOUT the amount on the
  //      FORWARD path — `forwardArgs` omits it; only `preFinArgs` includes one, and PRE_FINALITY is
  //      N/A from Arc. Visible in the response itself: run 2's `items[0].args` is
  //      [TMWF, "6", USDC, 0x00…, "cctp-forward"] — no amount — and `items[0].amount` is the FEE.
  //   2. A CALIBRATED SIMULATION. Against one quote requested for 2000000, burns of 500000 and
  //      9000000 BOTH simulated cleanly, while a wrong destinationDomain reverted — so the
  //      instrument could see a binding when one existed, and saw none here.
  // ⭐⭐ SO CIRCLE'S SIGNATURE DOES NOT BIND THE AMOUNT, AND THIS LINE IS NOT REDUNDANT UNDER
  // ADOPTION — it BECOMES the only thing between a held quote and a burn of a different size.
  // Removing it as "the signed quote covers that" would be exactly wrong. Pinned by
  // verify-bridge-fee-binding.
  if (p.a !== Number(amountUsdc)) throw new Error("bridge quote is for a different amount");
  return {
    // ⭐ THE SAME SHAPE `bridgeFee` RETURNS, so `agentBridge` cannot tell a re-opened quote from a
    // freshly fetched one — one code path, one set of field names, no branch on provenance.
    feeMinor: BigInt(p.m), amountMinor: BigInt(p.n), feeUsdc: p.f, netUsdc: p.t, issuedAt: p.iat,
    // ⚠️ Normalised on the way out, so a seal from an older deploy (no `fm`) opens as `unknown`
    // rather than as whichever mechanic happens to be first in the map.
    mechanic: bridgeMechanicOf(p.fm),
    quote: p.sq ? { signedQuote: p.sq, expiry: { mode: p.xm, expiresAt: p.xe } } : null,
    // ⭐ CARRIED OUT so the caller can RE-CHECK immediately before the burn — see agentBridge. The
    // opener runs before an approve transaction; the deadline that matters is the one at the burn.
    quoteSource: p.qs === "circle" ? "circle" : "self",
    expiry,
    // ⭐⭐ THE RE-CHECK, HANDED TO THE EXECUTOR. It asks the SAME question of the SAME sealed fields
    // against a FRESH clock, immediately before the burn — see the block in agentBridge. A closure
    // rather than a re-parse so there is one payload and one predicate; re-deriving the deadline
    // from a second decode would be a second source of truth for the same instant.
    // ⚠️ It judges the EXTERNAL deadline only. Our own TTL expiring mid-flight is not a revert
    // risk — the chain does not know about it — so re-applying it here would refuse a bridge that
    // would have succeeded.
    reCheckExpiry: () => openQuoteExpiry(p, Date.now()),
  };
}

/**
 * Read the external deadline out of a sealed payload and judge it. Shared by `openBridgeQuote` and
 * by the pre-burn re-check, so both ask the SAME question of the SAME fields.
 *
 * @returns {{mode:string, expiresAtSec:number, secondsLeft:number}|null} — null on the self-issued
 *          path, where there is no external deadline and our TTL is the whole story.
 */
export function openQuoteExpiry(p, now = Date.now()) {
  if (p?.qs === "self") {
    // ⚠️ Asserted, not assumed. A self-issued seal carrying external fields is a writer that has
    // half-migrated, and honouring our 3-minute TTL over a real 2-minute quote is the failure this
    // discriminator exists to prevent.
    if (p.xm != null || p.xe != null || p.sq != null) {
      throw new Error("bridge quote is malformed — a self-issued quote carries an external expiry");
    }
    return null;
  }
  if (p?.qs !== "circle") {
    throw new Error("bridge quote does not say where it came from — refusing rather than assuming");
  }
  if (p.xm == null || p.xe == null) {
    throw new Error("bridge quote claims an external price with no expiry — refusing");
  }
  const { secondsLeft } = assertQuoteUnexpired({ mode: p.xm, expiresAtSec: p.xe, nowMs: now });
  return { mode: p.xm, expiresAtSec: p.xe, secondsLeft };
}

/**
 * The burn call, in the shape the spike proved on real bytes (runs 1 and 2).
 *
 * ⭐ THE FORWARDING HOOK IS NOT AN ARGUMENT ANY MORE. It is requested in the QUOTE
 * (`requests: [{type:"FORWARD"}]`) and travels inside `signedQuote`; the contract reads it from
 * there. `FORWARD_HOOK` as a calldata constant is gone with the old entry point.
 *
 * ⚠️ NO `maxFee`, NO `minFinalityThreshold`. `_depositForBurn` hardcodes `EMPTY_MAX_FEE` and
 * `_inferParamsFromQuote` derives the threshold from the quote — both measured on chain in run 2
 * (`maxFee = 0`, `minFinalityThreshold = 2000`). Passing either would be inventing a parameter the
 * function does not have.
 */
export function bridgeCallData({ amountMinor, recipient, cctpDomain, signedQuote, refundAddress }) {
  return encodeFunctionData({
    abi: TMWF_ABI,
    functionName: "depositForBurnWithFees",
    args: [
      BigInt(amountMinor),
      cctpDomain,
      pad(getAddress(recipient), { size: 32 }),
      CONTRACTS.USDC,
      ZERO_HASH,                       // any caller (the relayer) may claim
      { signedQuote, refundAddress: getAddress(refundAddress) },
    ],
  });
}

/**
 * ═══ ⭐⭐⭐ THE APPROVE AND THE BURN, IN ONE userOp — AND THE ATOMICITY IS THE SAFETY PROPERTY ═══
 *
 * `executeBatch` loops `callWithReturnDataOrRevert`, so if the burn reverts the approve reverts
 * with it. **Either both land or neither does, and no allowance ever stands alone.**
 *
 * ⛔ THAT IS THE WHOLE REASON THIS FUNCTION EXISTS. Sent as two sequential transactions, a burn that
 * fails after a successful approve — a quote that expired in between, a revert, a timeout — leaves
 * an `amount + fee` allowance standing to `TokenMessengerWithFees`, a UUPS proxy whose
 * `_authorizeUpgrade` has an EMPTY BODY behind a single EOA (owner `0x3b61abee…`, nonce 237): no
 * timelock, no notice. Splitting this back into two transactions silently reintroduces that window.
 * 🚨 `verify-bridge-batch-atomicity.mjs` fails if the approve and the burn are ever submitted
 * separately. It is not a style check — it is the guard on the reason this option was chosen.
 *
 * ⚠️ AND THE BATCH SHAPE IS VALIDATION-PROVEN, NOT SETTLEMENT-PROVEN. `estimateContractExecutionFee`
 * showed the account accepts a self-targeted `executeBatch` and that Circle accepts a
 * `contractAddress` equal to the wallet. It simulates; it does not settle. **No batched burn has
 * ever landed on chain.** The first one is a pre-registered, unproven path — see
 * `docs/batched-burn-preregistration.md` — and must be run as one, not assumed from the estimate.
 */
export function bridgeBatchCallData({ walletAddress, fee, recipient, cctpDomain }) {
  const debit = bridgeDebitMinor(fee);
  const approveData = encodeFunctionData({
    abi: APPROVE_ABI, functionName: "approve", args: [getAddress(TMWF), debit],
  });
  const burnData = bridgeCallData({
    amountMinor: fee.amountMinor, recipient, cctpDomain,
    signedQuote: fee.quote.signedQuote, refundAddress: walletAddress,
  });
  return encodeFunctionData({
    abi: BATCH_ABI,
    functionName: "executeBatch",
    args: [[
      { target: getAddress(CONTRACTS.USDC), value: 0n, data: approveData },
      { target: getAddress(TMWF), value: 0n, data: burnData },
    ]],
  });
}

// EXECUTOR — burn on Arc from the agent SCA. Returns after the Arc-side burn
// lands (waitForTx); the destination mint is async (poll bridgeMintStatus).
// Assumes the CALLER already enforced cap / fee-floor / day-ceiling (see
// _actions.executeAction — the one secure path). `recipient` defaults to the
// source wallet (bridge to self on the destination).
export async function agentBridge({ walletAddress, destination, amountUsdc, recipient, fee: boundFee }) {
  const dest = resolveDestination(destination);
  if (!dest) throw new Error(`unsupported destination "${destination}"`);
  const to = getAddress(recipient || walletAddress);

  // ═══ ⭐⭐ THE FEE IS ACCEPTED, NOT RE-READ, WHEN ONE IS BOUND ═══════════════════════════════════
  // A confirm step that shows a figure has to bind it here or it is showing one number and burning
  // another. ⛔ `boundFee` NEVER ORIGINATES WITH THE CLIENT — it comes from a sealed quote this
  // server issued and re-opened, so it is the server's own figure travelling by value.
  // ⚠️ The un-bound path re-quotes HERE, at execution. It cannot hold a quote across an approval
  // because a quote's window is ~120s; what it loses is not the binding but the DISCLOSURE, which
  // is why job-bridge-approve now seals in-request rather than executing un-bound.
  // ⛔ NO FALLBACK PRICING. This used to read `boundFee ?? await bridgeFee(...)`, so a caller that
  // forgot to pass a fee got a fresh quote silently — and under upfront fees that quote's
  // `signedQuote` is what the CHAIN enforces the fee against, while the caller's gates had bounded a
  // different one. A missing fee is now a refusal: the executor resolves it once and threads it.
  const fee = boundFee;
  if (!fee?.quote?.signedQuote) {
    throw new Error("bridge fee carries no signed quote — refusing to burn without one");
  }

  // ═══ ⭐⭐⭐ RE-CHECK THE DEADLINE IMMEDIATELY BEFORE THE SUBMIT ══════════════════════════════════
  // The opener judged the deadline before anything happened. This asks again, against a fresh
  // clock, at the last moment we can still refuse for free.
  // ⭐ AND THE WINDOW IT USED TO GUARD IS NOW GONE. When the approve was a separate transaction, a
  // refusal here left a standing allowance; batching removed that, so this check now costs nothing
  // when it fires. It stays because a burn past the deadline still REVERTS, and a revert costs gas
  // and produces a failed receipt for a bridge that was never going to work.
  if (fee?.reCheckExpiry) fee.reCheckExpiry();

  const client = circle();

  // ═══ ⭐⭐⭐ ONE userOp: approve + burn, ATOMIC ════════════════════════════════════════════════
  //
  // ⛔ THERE IS NO SEPARATE APPROVE TRANSACTION, AND THAT IS THE SAFETY PROPERTY — not a tidiness
  // one. `executeBatch` loops `callWithReturnDataOrRevert`, so a reverting burn reverts the approve
  // with it: **either both land or neither does, and no allowance ever stands alone.** Sent as two
  // sequential transactions, any failure between them leaves `amount + fee` approved to
  // `TokenMessengerWithFees` — a UUPS proxy whose `_authorizeUpgrade` has an EMPTY BODY behind a
  // single EOA, no timelock, no notice. `verify-bridge-batch-atomicity.mjs` fails if these are ever
  // split again.
  //
  // ⚠️ NO ALLOWANCE READ. The old path read `allowance()` to decide whether to approve; here the
  // approve is unconditional and inside the batch. Reading first would be a round trip whose answer
  // could not change what we submit — and an approve to the exact debit is consumed exactly by the
  // burn, so a successful bridge leaves zero. (Measured: both real burn wallets read 0 to TMWF.)
  //
  // ⛔ VALIDATION-PROVEN, NOT SETTLEMENT-PROVEN. `estimateContractExecutionFee` showed the account
  // accepts a self-targeted `executeBatch` and that Circle accepts a `contractAddress` equal to the
  // wallet. AN ESTIMATE SIMULATES; IT DOES NOT SETTLE. No batched burn has landed on chain. The
  // first one is pre-registered (`docs/batched-burn-preregistration.md`) and must be run as the
  // unproven path it is.
  const callData = bridgeBatchCallData({ walletAddress, fee, recipient: to, cctpDomain: dest.cctpDomain });
  const brTx = await client.createContractExecutionTransaction({
    walletAddress,
    blockchain: ARC.blockchain,
    // ⭐ THE WALLET CALLS ITSELF. Circle wraps this as execute(SCA, 0, executeBatch([...])), and
    // `_checkAccessRuleFromEPOrAcctItself` permits `msg.sender == address(this)`.
    contractAddress: getAddress(walletAddress),
    callData,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  // ⭐ ONE await, so there is no longer any ambiguity about WHICH one stalled. The stage tag stays
  // because provisional records written by older deploys still carry it and the reconcile job
  // refuses an untagged one — and because "burn" is now the only truthful value.
  let burnHash;
  try {
    burnHash = await waitForTx(client, brTx.data?.id);
  } catch (e) {
    if (e?.name === "TxPendingError") e.stage = "burn";
    throw e;
  }

  return {
    burnHash,
    burnTx: `${ARC.explorer}/tx/${burnHash}`,
    feeUsdc: fee.feeUsdc,
    netUsdc: fee.netUsdc,
    // ⭐ CARRIED OUT WITH THE FIGURES IT EXPLAINS. `netUsdc` alone is a number whose meaning depends
    // entirely on this value; handing one onward without the other is what let a surface render the
    // wrong path's sentence beside a right number.
    feeMechanic: fee.mechanic ?? "unknown",
    destination: { key: dest.key, label: dest.label, cctpDomain: dest.cctpDomain },
    recipient: to,
  };
}

// Poll IRIS once for the forwarded mint on the destination. Returns the current
// stage so the UI can show "burn done → waiting → minted". `destExplorerTx` lets
// us build the destination tx link.
export async function bridgeMintStatus({ burnHash, destinationKey }) {
  const dest = BRIDGE_DESTINATIONS[destinationKey];
  const url = `${IRIS}/v2/messages/${ARC_CCTP_DOMAIN}?transactionHash=${burnHash}`;
  let data;
  try {
    data = await irisJson(url);
  } catch {
    return { state: "pending" };
  }
  const m = data?.messages?.[0];
  if (!m) return { state: "pending" };
  if (m.forwardState === "FAILED") return { state: "failed" };
  const confirmed = (m.forwardState === "CONFIRMED" || m.forwardState === "COMPLETE") && typeof m.forwardTxHash === "string" && m.forwardTxHash.length > 0;
  if (confirmed) {
    return {
      state: "minted",
      mintTxHash: m.forwardTxHash,
      mintTx: dest ? `${dest.explorerTx}${m.forwardTxHash}` : null,
    };
  }
  return { state: "pending", forwardState: m.forwardState ?? null };
}
