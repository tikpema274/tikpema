// _bridge-discover.mjs — CHAIN-DERIVED BRIDGE DISCOVERY. Find burns the record layer never saw.
//
// ═══ ⭐⭐ THE PRINCIPLE: A RECEIPT DOES NOT NEED AN INTENT ═════════════════════════════════════
// The burn's logs carry amount, destination and fee. The chain is authoritative for every field a
// receipt shows, so a complete and TRUE receipt can be written from the chain alone — claiming
// NOTHING about which intent produced it.
//
// ⛔ AND IT MUST CLAIM NOTHING. Attribution to a parked intent is only ever PROBABLE: the binding
// fields (owner, destination, amount, and a fee that older intents do not even carry) repeat, and
// the store holds two intents identical on all of them 3m49s apart. A receipt attributed to the
// WRONG intent is worse than no receipt — it is a true money record wearing a false provenance.
// 🚨 THE TEMPTATION IS REAL AND WAS FELT: for the 2026-08-28 burn the chain's maxFee (0.051999)
// matches a parked intent's ratio to six decimals, same destination, same amount, +10.2s. It looks
// certain. "Looks certain" is a property of THAT pair, not of the rule — and the pair the rule has
// to survive is the one nobody can test. So: no intentId, ever, on a discovered receipt.
//
// ═══ ⭐⭐ WHY LOGS AND NOT RECEIPTS — MEASURED 2026-09-06, AND IT DECIDES THE WHOLE DESIGN ═════
// Arc's public RPC drops transaction BODIES and RECEIPTS between 5 and 8 days old, but keeps LOGS:
//
//     eth_getTransactionReceipt   3-5d ✅ 3/3      8-9d ❌ 0/3
//     eth_getTransactionByHash    3-5d ✅          8-9d ❌
//     eth_getLogs                 served at head-1,500,000 ✅
//
// A sweeper built on `getTransactionReceipt` could never backfill; one built on logs can, and the
// 9-day-old burn decodes completely from its `DepositForBurn` leg. ⚠️ Do not "simplify" this to a
// receipt fetch — it will pass on fresh data and silently stop finding anything older than a week.
//
// ═══ 🚨 WHAT IT COVERS, AND WHAT IT DOES NOT ══════════════════════════════════════════════════
// COVERS   burns to BridgingKitContract that moved USDC from an owner ALREADY INDEXED in the store
//          — including burns whose allowance was granted by App Kit's `increaseAllowance` rather
//          than our panel's `approve`. Discovery keys on the BURN, not on how the allowance was
//          granted, so the 2026-09-01 and 2026-09-03 orphans are in scope.
// DOES NOT owners with no receipt in the store (enumeration is store-driven — never used the app,
//          never indexed); burns that do not target BridgingKitContract, which INCLUDES THE ENTIRE
//          UPFRONT/AGENT PATH (`depositForBurnWithFees` on TokenMessengerWithFees, a different
//          address) — those are written server-side in one request and have no window to lose;
//          anything outside the scanned block range. It discovers BURNS, not intents: a user who
//          signed nothing is correctly invisible.

import { CONTRACTS } from "./_arc.mjs";
import { BRIDGE_CONTRACT, BRIDGE_DESTINATIONS } from "./_bridge.mjs";
import { bridgeMechanicCopy } from "../../shared/bridge-mechanic.mjs";

/** TokenMessengerV2 on Arc — READ FROM CHAIN via TMWF.tokenMessenger(), not guessed. It emits the
 *  DepositForBurn leg carrying maxFee and destinationDomain. */
export const TOKEN_MESSENGER_V2 = "0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa";

/** ⚠️ Arc caps eth_getLogs at 10,000 blocks (`-32012`; re-measured 2026-09-10 — written here as
 *  -32614, which Arc no longer returns). ⭐ AND THAT IS ONLY THE RANGE CAP: a second cap refuses
 *  above 20,000 RESULTS with `-32602`, so a correctly-sized window is safe only while its filter
 *  stays selective. Measured headroom and what consumes it: shared/discover-cursor.mjs.
 *  The cap is exclusive of the 10,000th, so 9,999.
 *  ⚠️ ONE WINDOW IS ~1.5-2.1 HOURS OF ARC, NOT A FIXED DURATION — the block rate varies. Measured
 *  2026-09-07: 0.533 s/block over the last 1,000,000 blocks but 0.757 over the last 1,000, and a
 *  live 90s sample gave 0.752. An earlier comment here said a flat "0.514s, so one window is ~85.6
 *  minutes and a day is ~168,224 blocks" — that was one span's average stated as a constant. */
export const MAX_LOG_WINDOW = 9999n;

export const DISCOVER_OUTCOME = Object.freeze({
  DISCOVERED: "discovered",
  NONE: "none",
  UNREADABLE: "unreadable",
});

const lc = (s) => String(s ?? "").toLowerCase();

/** Split [from,to] into windows the RPC will actually serve. Inclusive bounds. */
export function blockWindows(fromBlock, toBlock, cap = MAX_LOG_WINDOW) {
  const from = BigInt(fromBlock), to = BigInt(toBlock);
  if (to < from) return [];
  const out = [];
  for (let s = from; s <= to; s += cap + 1n) {
    const e = s + cap > to ? to : s + cap;
    out.push({ fromBlock: s, toBlock: e });
  }
  return out;
}

/** Destination from the CCTP domain — DERIVED from the one registry the quote path reads, never a
 *  second table. An unknown domain is named as unknown rather than dropped or guessed. */
export function destinationForDomain(domain) {
  // ═══ 🚨 DOMAIN 0 IS ETHEREUM, AND 0 IS ALSO WHAT AN ABSENCE COERCES TO ════════════════════════
  // MEASURED 2026-09-07: `Number(null)`, `Number("")` and `Number(false)` are all 0, so the old
  // `Number(domain)` returned **Ethereum (Sepolia)** for a MISSING destination. A receipt would have
  // told a user their money went to Ethereum when nothing knew where it went — and Ethereum is the
  // most expensive route, so the fee shown alongside would have been wrong too.
  // ⭐ `undefined` gave NaN and correctly fell through to unknown, which made the defect worse, not
  // better: two absences behaved differently, so testing one proved nothing about the other.
  // ⛔ SO THE TYPE IS CHECKED BEFORE THE VALUE. Only an integer, or a string of digits, is a domain.
  // Everything else is UNKNOWN — never the chain that happens to sit at zero.
  // [[absence-must-never-read-as-safe]] · [[nan-fail-open-cap-pattern]]
  const isInt = typeof domain === "number" && Number.isInteger(domain);
  const isDigits = typeof domain === "string" && /^\d+$/.test(domain.trim());
  if (!isInt && !isDigits) {
    return { key: null, label: `unknown CCTP domain (${JSON.stringify(domain) ?? "undefined"})` };
  }
  const d = Number(domain);
  for (const [key, v] of Object.entries(BRIDGE_DESTINATIONS)) {
    if (v.cctpDomain === d) return { key, label: v.label };
  }
  return { key: null, label: `CCTP domain ${d}` };
}

/**
 * ═══ ⛔⛔ THE OWNER COMES FROM THE TRANSFER LEG, NEVER FROM DepositForBurn.depositor ═══════════
 * `depositor` is the BridgingKitContract, because the Kit is the caller — every burn on this path
 * reports the SAME depositor. Reading it would attribute every burn in the world to the contract
 * and bind every discovered receipt to an owner that is not a user. The user is the `from` of the
 * USDC Transfer leg in the same transaction.
 *
 * ⭐ THE JOIN IS ALSO THE DISCRIMINATOR. Requiring BOTH legs in one transaction excludes a plain
 * USDC transfer TO the Kit, which has no DepositForBurn and is not a bridge at all.
 */
export function joinBurns({ transfers = [], deposits = [] } = {}) {
  const byTx = new Map();
  for (const t of transfers) {
    const hash = lc(t?.transactionHash);
    if (!hash) continue;
    byTx.set(hash, { burnHash: t.transactionHash, owner: lc(t?.from), amountMinor: t?.value ?? null,
      blockNumber: t?.blockNumber ?? null });
  }
  const out = [];
  for (const d of deposits) {
    const hash = lc(d?.transactionHash);
    const leg = hash && byTx.get(hash);
    if (!leg) continue;                       // a DepositForBurn with no owner Transfer: not ours
    if (!leg.owner || leg.owner === lc(BRIDGE_CONTRACT)) continue;
    out.push({
      ...leg,
      // ⚠️ amount comes from the EVENT, which is the burned amount. The Transfer leg agrees, and
      // disagreement is a reason to refuse rather than to pick one.
      amountMinor: d?.amount != null ? String(d.amount) : leg.amountMinor,
      maxFeeMinor: d?.maxFee != null ? String(d.maxFee) : null,
      destinationDomain: d?.destinationDomain ?? null,
      mintRecipient: d?.mintRecipient ?? null,
    });
  }
  return out;
}

/** Candidates the store has never recorded. `recorded` is every burnHash in the store. */
export function diffUndocumented(candidates, recorded) {
  const seen = new Set([...(recorded || [])].map(lc));
  return (candidates || []).filter((c) => !seen.has(lc(c.burnHash)));
}

const toUsdc = (minor) => (minor == null ? null : Number(minor) / 1e6);

/**
 * Build the receipt. ⭐ `feeMechanic: "deducted"` and the CEILING QUALIFIER, deliberately: what the
 * chain gives us is `maxFee`, a bound signed into the burn, NOT the fee actually taken. Presenting
 * it as a charge would overstate on exactly the path the 2026-09-06 mirrored fix exists to qualify.
 * The renderer already says the true thing for this mechanic; this receipt opts into it.
 *
 * ⛔ NO `intentId`, NO `txId` OF A PARKED RECORD. See the header.
 */
export const RECEIPT_ORIGIN = Object.freeze({
  /** Found on chain afterwards by the sweeper. Nobody watched it happen. */
  DISCOVERED: "chain-discovered",
  /** Written by the tool that MADE the burn, at the moment it made it. */
  TOOL_SIGNED: "tool-signed",
});

/**
 * ⭐⭐ WHY `tool-signed` AND NOT `chain-discovered` — the label must be true, not merely convenient.
 * A receipt written by `bridge-direct.mjs` was NOT discovered: nothing searched for it, and its
 * existence owes nothing to the sweeper. It was WITNESSED AT SOURCE by the process that signed the
 * burn. Reusing "chain-discovered" would be the cheapest possible lie — it would read, to anyone
 * auditing provenance later, as evidence that discovery works on a case discovery never saw.
 *
 * ⚠️ AND THE TWO VALUES DIFFER IN MORE THAN WORDING. `isAutoRetryExhausted` re-anchors its budget on
 * `discoveredAt` for `chain-discovered` ONLY, because such a receipt is born older than its burn.
 * A `tool-signed` receipt is born SECONDS after its burn, so it needs no exemption and correctly
 * gets none — the ordinary 7-day rule from `burnedAt` is right for it. Sharing the label would have
 * silently handed it an exemption it does not need, which is how a narrow rule becomes a broad one.
 */
export function discoveredReceipt(c, { discoveredAt = new Date().toISOString(), origin = RECEIPT_ORIGIN.DISCOVERED } = {}) {
  const dest = destinationForDomain(c.destinationDomain);
  const fee = toUsdc(c.maxFeeMinor);
  return {
    schema: "bridge-receipt/1",
    owner: c.owner,
    burnHash: c.burnHash,
    burnTx: c.burnHash,
    // ═══ 🚨 burnedAt IS LOAD-BEARING, NOT DECORATION — CAUGHT BEFORE THE FIRST WRITE ═══════════
    // This was `null`, on the reasoning that a log gives a block and not a wall clock. That was
    // over-cautious AND WRONG IN THE DANGEROUS DIRECTION: `isPastDeadline` returns FALSE for an
    // unparseable burnedAt ("unknown burn time ⇒ never auto-escalate"), and `isStranded` routes
    // burn_confirmed straight through it. A receipt with a null burnedAt is therefore NEVER swept —
    // it sits at burn_confirmed, rendering "in flight", FOREVER, for money that landed days ago.
    // ⭐ The block timestamp IS a verified chain fact and is readable for old blocks (measured: the
    // 9-day-old burn's header returns 2026-08-28T21:52:47Z, matching the explorer to the second).
    // Setting it makes the receipt MORE truthful, not less. [[binding-tested-across-what-it-binds]]
    burnedAt: c.blockTimestamp ?? null,
    blockNumber: c.blockNumber != null ? String(c.blockNumber) : null,
    submittedAt: null,              // ⛔ we did not see it submitted. Null is the honest answer.
    state: "burn_confirmed",
    // ⭐ PROVENANCE ONLY — NOTHING BRANCHES ON IT. See verify-bridge-discover §3, which runs the
    // whole pipeline under all three origin values and asserts byte-identical output.
    origin,
    destinationKey: dest.key,
    destinationLabel: dest.label,
    recipient: c.mintRecipient ?? null,
    amountRequested: toUsdc(c.amountMinor),
    feeMechanic: "deducted",
    feeDisclosed: fee,
    feeCharged: fee,
    feeDisclosedMinor: c.maxFeeMinor ?? null,
    feeIsCeiling: true,
    feeCeilingNote: bridgeMechanicCopy("deducted").feeCeilingNote,
    // ⚠️ SUBTRACTED IN MINOR UNITS, NOT IN DECIMALS. `0.1 - 0.054312` in float gives
    // 0.045688000000000006 — which is what the first tool-signed receipt actually stored. Both
    // operands are exact integers of minor units, so the subtraction is exact there and only the
    // final divide introduces a representable value. A money figure carrying float noise is not
    // wrong by any amount that matters, and it is still the wrong thing to persist: it reads as
    // sloppiness in exactly the field a user checks against their wallet.
    netPredicted: c.amountMinor != null && c.maxFeeMinor != null
      ? Number(BigInt(c.amountMinor) - BigInt(c.maxFeeMinor)) / 1e6
      : null,
    delivery: "predicted",
    amountDelivered: null,
    payer: c.owner,
    discoveredAt,
  };
}

/**
 * ═══ ⛔⛔ UNREADABLE IS PER-TICK, NOT PER-WINDOW ══════════════════════════════════════════════
 * If ANY sub-window threw, the tick reports `unreadable` — even when other windows served and even
 * when those windows found burns. A partial scan reporting "no undocumented burns" is the
 * absence-reads-as-safe failure WITH A CURSOR ATTACHED: it would also advance past blocks nobody
 * looked at, so the gap becomes permanent and silent.
 *
 * ⛔ `ARC.rpc` IS A SINGLE ENDPOINT, so `absenceNeedsCorroboration` cannot be satisfied — there is
 * nobody else to ask. An empty result from a window that SERVED is a real "nothing here"; an empty
 * result from a window that THREW is not a result at all.
 *
 * ⭐ Anything discovered before the failure is still REPORTED — findings are never suppressed — but
 * the verdict stays `unreadable` and the cursor does not move.
 */
export function sweepVerdict({ windowsAttempted = 0, windowsServed = 0, discovered = [] } = {}) {
  const complete = windowsAttempted > 0 && windowsServed === windowsAttempted;
  if (!complete) {
    return {
      outcome: DISCOVER_OUTCOME.UNREADABLE,
      advanceCursor: false,
      discovered,
      detail: `scan INCOMPLETE — ${windowsServed}/${windowsAttempted} windows served. A partial ` +
        `scan cannot say "nothing undocumented", and the cursor must not move past blocks nobody read.`,
    };
  }
  return {
    outcome: discovered.length ? DISCOVER_OUTCOME.DISCOVERED : DISCOVER_OUTCOME.NONE,
    advanceCursor: true,
    discovered,
    detail: discovered.length
      ? `${discovered.length} undocumented burn(s) across ${windowsServed} window(s).`
      : `no undocumented burns across ${windowsServed} window(s), all served.`,
  };
}

/**
 * ⛔ REFUSE TO WRITE A RECEIPT THAT CAN NEVER BE SETTLED. A discovered receipt whose `burnedAt` does
 * not parse is unreachable by `isStranded` — the settler will never be handed it — so writing one
 * would create a permanently-pending row about money that already moved. That is strictly worse
 * than the gap it was meant to close.
 * ⭐ An unreadable block timestamp is an `unreadable` outcome, NOT a receipt.
 */
export function isSettleable(receipt) {
  return Number.isFinite(Date.parse(receipt?.burnedAt || ""));
}

/** ⭐ THE SCAN SET IS store-derived ∪ operator-derived — re-exported so the runner has one import
 *  surface and `shared/operator-wallets.mjs` stays the single definition of who the operator is. */
export { scanOwnerSet, operatorWalletReport, OPERATOR_WALLET_VARS } from "../../shared/operator-wallets.mjs";

export const DISCOVER_CONSTANTS = Object.freeze({ USDC: CONTRACTS.USDC, KIT: BRIDGE_CONTRACT, TOKEN_MESSENGER_V2 });
