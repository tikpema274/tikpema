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
// 🚨 CIRCLE'S UPFRONT FEES (2026-09-02) WOULD INVERT THIS. Under `depositForBurnWithFees` the fee is
// collected on the SOURCE chain IN ADDITION to the amount and the recipient receives the full
// amount — so `netUsdc` would become `amount`, and every surface deriving "what arrives" from this
// would be wrong by exactly the fee. Not adopted; see the ADOPTION BLOCKER on `openBridgeQuote`.
export function bridgeNetUsdc({ amountMinor, maxFee }) {
  return toUsdc(BigInt(amountMinor) - BigInt(maxFee));
}

// Live bridge fee for an amount to a destination domain, computed exactly as the
// SDK does: providerFee (CCTP fast-burn, ~0 on testnet) + forwarderFee (the
// relayer's destination-gas charge). maxFee is in USDC minor units. Throws if the
// destination has no forwarding tier (route not bridgeable right now).
export async function bridgeFee({ amountUsdc, cctpDomain }) {
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
    amountMinor,
    maxFee,
    feeUsdc: toUsdc(maxFee),
    netUsdc: bridgeNetUsdc({ amountMinor, maxFee }),
    providerFeeUsdc: toUsdc(providerFee),
    forwarderFeeUsdc: toUsdc(forwarderFee),
  };
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
  const payload = {
    o: owner ? String(owner).toLowerCase() : "anon",
    d: String(destinationKey),
    a: Number(amountUsdc),
    // ⭐ BigInts as strings — they are the values that reach the calldata.
    m: fee.maxFee.toString(),
    n: fee.amountMinor.toString(),
    f: Number(fee.feeUsdc),
    t: Number(fee.netUsdc),
    iat: now,
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
  if (!Number.isFinite(p.iat) || now - p.iat > QUOTE_TTL_MS) throw new Error("bridge quote has expired — price it again");
  if (now - p.iat < -5_000) throw new Error("bridge quote is not yet valid");
  const who = owner ? String(owner).toLowerCase() : "anon";
  if (p.o !== who) throw new Error("bridge quote belongs to another wallet");
  if (p.d !== String(destinationKey)) throw new Error("bridge quote is for a different destination");
  if (p.a !== Number(amountUsdc)) throw new Error("bridge quote is for a different amount");
  return { maxFee: BigInt(p.m), amountMinor: BigInt(p.n), feeUsdc: p.f, netUsdc: p.t, issuedAt: p.iat };
}

export function bridgeCallData({ amountMinor, maxFee, recipient, cctpDomain }) {
  const bridgeParams = {
    amount: amountMinor,
    maxFee,
    fee: 0n, // protocolFee
    mintRecipient: pad(getAddress(recipient), { size: 32 }),
    destinationCaller: ZERO_HASH, // any caller (the relayer) may claim
    burnToken: CONTRACTS.USDC,
    feeRecipient: BRIDGE_CONTRACT, // default (no custom fee)
    destinationDomain: cctpDomain,
    minFinalityThreshold: FAST_FINALITY,
  };
  return encodeFunctionData({ abi: BRIDGE_ABI, functionName: "bridgeWithPreapprovalAndHook", args: [bridgeParams, FORWARD_HOOK] });
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
  // This used to call bridgeFee() unconditionally, which is why the fee the gate BANDED and the fee
  // SIGNED into the calldata were two different quotes ~200 ms apart — the B≠C gap the receipt
  // schema names with `feeDisclosed` / `feeCharged`. A confirm step that shows a figure has to bind
  // it here or it is showing one number and burning another.
  // ⛔ `boundFee` NEVER ORIGINATES WITH THE CLIENT. It comes from a sealed quote this server issued
  // and re-opened (openBridgeQuote), so it is the server's own figure travelling by value.
  // ⚠️ The un-bound path REMAINS, for callers with no confirm step to bind from — job-bridge-approve
  // prices at approval and executes later, so re-reading is correct there.
  const fee = boundFee ?? await bridgeFee({ amountUsdc, cctpDomain: dest.cctpDomain });
  const callData = bridgeCallData({ amountMinor: fee.amountMinor, maxFee: fee.maxFee, recipient: to, cctpDomain: dest.cctpDomain });

  const client = circle();

  // 1) Ensure allowance ≥ amount (on-chain approve — SCA-safe, no permit).
  const allowance = await publicClient().readContract({
    address: CONTRACTS.USDC,
    abi: ALLOWANCE_ABI,
    functionName: "allowance",
    args: [getAddress(walletAddress), BRIDGE_CONTRACT],
  });
  if (allowance < fee.amountMinor) {
    const apTx = await client.createContractExecutionTransaction({
      walletAddress,
      blockchain: ARC.blockchain,
      contractAddress: CONTRACTS.USDC,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [BRIDGE_CONTRACT, fee.amountMinor.toString()],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    // 🚨 TAG WHICH AWAIT STALLED. TxPendingError carries only a transaction id, and there are TWO
    // awaits in this function — so downstream, `txId` alone cannot say whether it names an
    // ALLOWANCE or a BURN. A reconcile job that assumed "burn" would read this transaction's
    // txHash and write it as a burnHash: a fabricated money-movement record for a burn that was
    // never submitted. ⭐ Nothing about the money moves here — an approve grants an allowance —
    // so the honest downstream outcome for this one is "no burn exists and none is coming".
    try {
      await waitForTx(client, apTx.data?.id);
    } catch (e) {
      if (e?.name === "TxPendingError") e.stage = "approve";
      throw e;
    }
  }

  // 2) The bridge call itself (Arc burn + forwarding hook).
  const brTx = await client.createContractExecutionTransaction({
    walletAddress,
    blockchain: ARC.blockchain,
    contractAddress: BRIDGE_CONTRACT,
    callData,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  // The burn's own await — tagged for the same reason as the approve above. This is the ONLY
  // stage whose eventual txHash is a real burn hash, which is exactly why it must be named
  // rather than inferred from being "the one that usually times out".
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
