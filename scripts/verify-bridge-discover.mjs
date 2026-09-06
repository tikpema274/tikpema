// verify-bridge-discover.mjs — the chain-derived discovery sweeper's guards.
//
// Three properties, each with the mutation it exists to catch:
//   1. OWNER BINDING comes from the Transfer leg, never DepositForBurn.depositor (which is the Kit).
//   2. UNREADABLE IS PER-TICK — one failed window makes the whole tick unreadable AND freezes the cursor.
//   3. `origin` IS PROVENANCE — the pipeline is byte-identical under all three values.

import {
  blockWindows, joinBurns, diffUndocumented, discoveredReceipt, sweepVerdict,
  destinationForDomain, DISCOVER_OUTCOME, MAX_LOG_WINDOW, isSettleable,
} from "../netlify/functions/_bridge-discover.mjs";
import { BRIDGE_CONTRACT } from "../netlify/functions/_bridge.mjs";
import { isPastDeadline, isStranded } from "../netlify/functions/_bridge-receipts.mjs";

let pass = 0, fail = 0;
const check = (l, ok, d = "") => { if (ok) { pass++; console.log(`  ✅ ${l}`); } else { fail++; console.log(`  ❌ ${l}${d ? `  — ${d}` : ""}`); } };

const OWNER = "0x74b7b561fd71c68eb1da6b96a7a87033904b24e5";
const TX = "0x0938de7c24aeda6bf96a890d8a277b68107be92005030e763091c8c253561a88";
// ⭐ THE FIXTURE CARRIES THE HAZARD: depositor IS the Kit, exactly as the chain emits it. A fixture
// with a user-looking depositor would let the wrong read pass. [[fixtures-that-agree-cannot-discriminate]]
const transfers = [{ transactionHash: TX, from: OWNER, to: BRIDGE_CONTRACT, value: "1000000", blockNumber: 59339282n }];
const deposits = [{ transactionHash: TX, depositor: BRIDGE_CONTRACT, amount: "1000000", maxFee: "51999",
                    destinationDomain: 7, mintRecipient: OWNER }];

console.log("\n── 1. ⛔ OWNER BINDING — the Transfer leg, never depositor ─────────────");
const joined = joinBurns({ transfers, deposits });
check("one candidate is produced", joined.length === 1, String(joined.length));
check("🚨 owner is the Transfer's `from` (the USER)", joined[0]?.owner === OWNER, joined[0]?.owner);
check("🚨 owner is NOT DepositForBurn.depositor (the Kit)",
  joined[0]?.owner.toLowerCase() !== BRIDGE_CONTRACT.toLowerCase(), joined[0]?.owner);
check("   …and the fixture really does carry the Kit as depositor", 
  deposits[0].depositor.toLowerCase() === BRIDGE_CONTRACT.toLowerCase());
// MUTATION: read depositor instead. Must not survive.
const mutantOwnerRead = (t, d) => (d.depositor || "").toLowerCase();
check("⭐ MUTATION — a reader taking `depositor` yields the KIT, so the assertion above goes red",
  mutantOwnerRead(transfers[0], deposits[0]) !== OWNER
  && mutantOwnerRead(transfers[0], deposits[0]) === BRIDGE_CONTRACT.toLowerCase());
// The join is also the discriminator.
check("⭐ a DepositForBurn with NO Transfer leg is excluded (not a bridge we can attribute)",
  joinBurns({ transfers: [], deposits }).length === 0);
check("⭐ a Transfer to the Kit with NO DepositForBurn is excluded (a plain transfer, not a burn)",
  joinBurns({ transfers, deposits: [] }).length === 0);
check("⭐ a Transfer whose `from` IS the Kit is excluded (the Kit's own onward leg)",
  joinBurns({ transfers: [{ ...transfers[0], from: BRIDGE_CONTRACT }], deposits }).length === 0);

console.log("\n── 2. ⛔ UNREADABLE IS PER-TICK, AND THE CURSOR FREEZES ────────────────");
const partial = sweepVerdict({ windowsAttempted: 4, windowsServed: 3, discovered: [] });
check("🚨 3 of 4 windows served -> UNREADABLE, never `none`", partial.outcome === DISCOVER_OUTCOME.UNREADABLE, partial.outcome);
check("🚨 …and the cursor does NOT advance", partial.advanceCursor === false);
const partialWithFind = sweepVerdict({ windowsAttempted: 4, windowsServed: 3, discovered: [{ burnHash: TX }] });
check("⭐ a partial tick that DID find something is still UNREADABLE",
  partialWithFind.outcome === DISCOVER_OUTCOME.UNREADABLE, partialWithFind.outcome);
check("   …and still does not advance the cursor", partialWithFind.advanceCursor === false);
check("⭐ …but the finding is REPORTED, never suppressed", partialWithFind.discovered.length === 1);
const clean = sweepVerdict({ windowsAttempted: 4, windowsServed: 4, discovered: [] });
check("a fully-served empty tick -> `none`", clean.outcome === DISCOVER_OUTCOME.NONE);
check("   …and advances the cursor", clean.advanceCursor === true);
const found = sweepVerdict({ windowsAttempted: 2, windowsServed: 2, discovered: [{ burnHash: TX }] });
check("a fully-served tick with a burn -> `discovered`", found.outcome === DISCOVER_OUTCOME.DISCOVERED);
check("🚨 ZERO windows attempted is NOT `none` — it is unreadable",
  sweepVerdict({ windowsAttempted: 0, windowsServed: 0 }).outcome === DISCOVER_OUTCOME.UNREADABLE);
// MUTATION: the tempting "if any window served, report what we know".
const mutantVerdict = (a, s, d) => (s > 0 ? (d.length ? "discovered" : "none") : "unreadable");
check("⭐ MUTATION — 'any window served is good enough' would call a partial scan `none`",
  mutantVerdict(4, 3, []) === "none" && partial.outcome === DISCOVER_OUTCOME.UNREADABLE);

console.log("\n── 3. `origin` IS PROVENANCE — nothing branches on it ──────────────────");
const cand = joined[0];
const base = discoveredReceipt(cand, { discoveredAt: "2026-01-01T00:00:00.000Z" });
const strip = (r) => { const { origin, ...rest } = r; return JSON.stringify(rest); };
// ⭐ THE VALUE IS FED IN AT THE INPUT **AND** SET ON THE OUTPUT. Varying it only AFTER construction
// would test downstream consumers while leaving a branch INSIDE discoveredReceipt invisible — which
// is exactly what an earlier draft of this section did. [[a-partial-mock-fails-at-instantiation]]
const outs = ["chain-discovered", "user-signed", null].map((o) => {
  const r = discoveredReceipt({ ...cand, origin: o }, { discoveredAt: "2026-01-01T00:00:00.000Z" });
  r.origin = o;                       // the value varies…
  return { o, body: strip(r), verdict: sweepVerdict({ windowsAttempted: 1, windowsServed: 1, discovered: [r] }).outcome };
});
check("⭐ every field EXCEPT origin is byte-identical across all three values",
  new Set(outs.map((x) => x.body)).size === 1, `${new Set(outs.map((x) => x.body)).size} distinct bodies`);
check("⭐ the verdict is identical across all three values",
  new Set(outs.map((x) => x.verdict)).size === 1);
check("   …and the three values really were different", new Set(outs.map((x) => String(x.o))).size === 3);
check("the receipt this module writes declares chain-discovered", base.origin === "chain-discovered");

console.log("\n── 4. THE RECEIPT — chain facts, the CEILING qualifier, and NO intent ──");
check("amount from the chain", base.amountRequested === 1);
check("fee is the maxFee CEILING", base.feeDisclosed === 0.051999);
check("⭐ feeIsCeiling is TRUE — maxFee is a bound, not a charge", base.feeIsCeiling === true);
check("   …and it carries the DEDUCTED qualifier, not a hand-written hedge",
  /^That figure is a maximum, signed into the transaction/.test(base.feeCeilingNote), base.feeCeilingNote);
check("   …and the mechanic is `deducted` so the renderer says it too", base.feeMechanic === "deducted");
check("destination derives from the CCTP domain registry", base.destinationKey === "polygon", base.destinationKey);
check("🚨 NO intentId is claimed", !("intentId" in base));
check("🚨 NO txId of a parked record is claimed", !("txId" in base));
check("⭐ submittedAt is NULL — we did not witness a submission", base.submittedAt === null);
check("an unknown domain is NAMED, not guessed or dropped", destinationForDomain(99).key === null
  && /CCTP domain 99/.test(destinationForDomain(99).label));

console.log("\n── 5. THE DIFF, AND THE WINDOW ARITHMETIC ─────────────────────────────");
const NEIGHBOUR = "0xd228fa5eb0bc4f84cd8315b0045096a407d2b66f2540b2d57b53399dd224e65d";
const both = [{ burnHash: TX }, { burnHash: NEIGHBOUR }];
const left = diffUndocumented(both, [NEIGHBOUR]);
check("⭐ an already-recorded burn is EXCLUDED by the diff", left.length === 1 && left[0].burnHash === TX);
check("   …and the diff is case-insensitive on the hash",
  diffUndocumented(both, [NEIGHBOUR.toUpperCase()]).length === 1);
check("🚨 an EMPTY recorded set does not silently exclude everything",
  diffUndocumented(both, []).length === 2);
const w = blockWindows(1n, 30000n);
check("windows respect Arc's 10,000-block cap", w.every((x) => x.toBlock - x.fromBlock <= MAX_LOG_WINDOW));
check("windows are contiguous and cover the range",
  w[0].fromBlock === 1n && w[w.length - 1].toBlock === 30000n
  && w.every((x, i) => i === 0 || x.fromBlock === w[i - 1].toBlock + 1n));
check("a single-block range yields one window", blockWindows(5n, 5n).length === 1);
check("an inverted range yields none", blockWindows(10n, 5n).length === 0);

console.log("\n── 6. 🚨 THE RECEIPT MUST BE REACHABLE BY THE SETTLER ─────────────────");
// ⭐⭐ ASSERTED ACROSS THE MODULE BOUNDARY, against the REAL predicates. A guard that only checked
// "burnedAt is a string" would have passed on `null` — the exact defect this section exists for:
// isPastDeadline returns FALSE for an unparseable burnedAt, so a null-burnedAt receipt is never
// stranded, never settled, and renders "in flight" forever. [[binding-tested-across-what-it-binds]]
const withTs = discoveredReceipt({ ...cand, blockTimestamp: "2026-08-28T21:52:47.000Z" });
check("burnedAt is set from the block timestamp", withTs.burnedAt === "2026-08-28T21:52:47.000Z");
check("🚨 …and the REAL isPastDeadline says the burn is past its mint deadline",
  isPastDeadline(withTs, Date.parse("2026-09-06T00:00:00Z")) === true);
check("🚨 …and the REAL isStranded picks it up, so the settler is handed it",
  isStranded(withTs, Date.parse("2026-09-06T00:00:00Z")) === true);
check("it is settleable", isSettleable(withTs) === true);
const noTs = discoveredReceipt({ ...cand });
check("⭐ MUTATION — a receipt with NO block timestamp is NOT settleable", isSettleable(noTs) === false);
check("   …and the real isStranded would NEVER pick it up (the silent-forever row)",
  isStranded(noTs, Date.parse("2026-09-06T00:00:00Z")) === false);
check("   …which is why it must be refused rather than written",
  isSettleable(noTs) === false && noTs.burnedAt === null);

console.log(`\n${"═".repeat(72)}`);
console.log(`${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
