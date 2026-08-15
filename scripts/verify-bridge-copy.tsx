// verify-bridge-copy.tsx — WHAT A BRIDGE RECEIPT ROW ACTUALLY SAYS, rendered.
//
//   npx tsx scripts/verify-bridge-copy.tsx        (also: npm run test:bridgecopy)
//
// ═══ 🚨 WHY THIS EXISTS — FOUR FALSE ALARMS, ZERO TRUE ONES ══════════════════════════════════
// The copy in this panel was guarded by SOURCE REGEXES in verify-bridge-receipts.mjs. Across four
// commits they failed four times, and EVERY failure was text MOVING rather than meaning changing:
//   · JSX wrapped "could not be / determined" onto two lines — the phrase exists on screen and
//     not in the source as one string
//   · the `unresolved` row grew an attempt-count branch, pushing the match past the char window
//   · the same again when the settler gained three fields between two anchors
//   · and the window was WIDENED each time to make it pass
// ⭐⭐ A GUARD THAT ONLY EVER CRIED WOLF, AND WAS LOOSENED BY ITS OWN FALSE POSITIVES — in a panel
// whose entire job is telling someone whether their money moved. That is worse than no guard: it
// consumed attention, taught everyone to widen it, and never once caught a real defect.
//
// ⭐ THE FIX IS THE ARTIFACT, NOT THE PATTERN. Source is not what a user reads. This renders
// `BridgeReceiptStatus` with react-dom/server and asserts on TEXT CONTENT — wrapping, interpolated
// variables, conditional fragments and all. It can see things no regex can:
//   · a `<span>` that is present in source but never renders (a branch that cannot be reached)
//   · text assembled from variables (`${count} failed reads`)
//   · TWO branches matching at once, which would paint two contradictory sentences in one row
//   · a state that renders NOTHING — a row with an amount and no status, which reads as normal
//
// ⚠️ PRESENT AND ABSENT ARE DIFFERENT CHECKS, and only both together prove anything — a new
// sentence appearing does not mean the old falsehood left. Both directions are asserted below.

// ⚠️ THE EXPLICIT React IMPORT IS LOAD-BEARING HERE, though it is redundant in src/.
// tsconfig sets "jsx": "react-jsx" (automatic runtime) but only `include`s `src`, so a .tsx file
// under scripts/ falls outside it and esbuild applies the CLASSIC transform — which compiles JSX to
// `React.createElement` and dies with "React is not defined". A `@jsxImportSource` pragma does NOT
// help: that only selects the source for an ALREADY-automatic transform.
// ⭐ The same gap means `tsc --noEmit` never typechecks this file — it is verified by RUNNING, which
// for a rendering test is the stronger guarantee anyway, and `npm run test:bridgecopy` runs it.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BridgeReceiptStatus, type BridgeReceiptView } from "../src/components/bridgeReceiptStatus";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

/** Render a receipt and return the TEXT a browser would paint — tags stripped, entities decoded,
 *  whitespace collapsed. ⭐ Collapsing is the whole point: it is exactly what defeated the regexes,
 *  because JSX line-wrapping is invisible to a reader and fatal to a pattern. */
const text = (r: BridgeReceiptView) =>
  renderToStaticMarkup(<BridgeReceiptStatus r={r} />)
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();

/** How many status branches rendered at once. ⭐ A row must say exactly ONE thing; two matching
 *  branches would paint two contradictory sentences and no source regex could ever notice. */
const spans = (r: BridgeReceiptView) =>
  (renderToStaticMarkup(<BridgeReceiptStatus r={r} />).match(/<span/g) || []).length;

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  BRIDGE RECEIPT COPY — RENDERED, not grepped                         ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — EVERY STATE SAYS EXACTLY ONE THING");
// 🚨 THE FAILURE THIS PANEL EXISTS TO PREVENT: a row that renders an amount and NO status reads as
// normal. A regex cannot detect an unreachable branch; rendering can.
{
  const cases: Array<[string, BridgeReceiptView]> = [
    ["burn_submitted/settling",    { state: "burn_submitted", provisional: { band: "settling" } }],
    ["burn_submitted/unwitnessed", { state: "burn_submitted", provisional: { band: "unwitnessed" } }],
    ["burn_submitted/unresolved",  { state: "burn_submitted", provisional: { band: "unresolved" }, reconcileAttempts: 7 }],
    ["burn_submitted/NO BAND",     { state: "burn_submitted" }],
    ["submit_failed",              { state: "submit_failed", submitFailureDetail: "Circle reports FAILED" }],
    ["burn_confirmed",             { state: "burn_confirmed", netPredicted: 0.94 }],
    ["minted/measured",            { state: "minted", delivery: "measured", amountDelivered: 0.9468 }],
    ["minted/UNMEASURED",          { state: "minted" }],
    ["mint_unconfirmed/unreadable",{ state: "mint_unconfirmed", netPredicted: 0.94, destinationLabel: "Polygon (Amoy)", mintRecovery: { cause: "chain_unreadable", verifyFailureCount: 1730, exhausted: true } }],
    ["mint_unconfirmed/unseen",    { state: "mint_unconfirmed", netPredicted: 0.94, mintRecovery: { cause: "never_appeared", exhausted: false } }],
    ["mint_failed",                { state: "mint_failed" }],
    ["mint_unverified",            { state: "mint_unverified", verifyFailure: { reason: "rpc_error" } }],
  ];
  for (const [name, r] of cases) {
    const t = text(r), n = spans(r);
    check(`⭐ ${name} renders a status`, t.length > 0, t.length > 0 ? `"${t.slice(0, 62)}…"` : "RENDERED NOTHING");
    check(`   …and exactly ONE, never two contradictory sentences`, n === 1, `${n} spans`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — THE WORD THAT WAS THE LIE: 'yet'");
// ⭐⭐ "Yet" tells the reader someone is still waiting. For a provisional receipt nobody was —
// there is no sweeper, settler or reconcile job for a `tx-` record until it is reconciled.
{
  const settling = text({ state: "burn_submitted", provisional: { band: "settling" } });
  const unwit = text({ state: "burn_submitted", provisional: { band: "unwitnessed" } });
  const unres = text({ state: "burn_submitted", provisional: { band: "unresolved" }, reconcileAttempts: 7 });

  check("⭐ `settling` is the ONLY band allowed to say 'yet'", /has not been confirmed yet/.test(settling));
  check("⭐⭐ `unwitnessed` does NOT say 'yet'", !/\byet\b/.test(unwit), unwit.slice(0, 70));
  check("⭐⭐ …and says plainly that nothing is checking", /nothing is checking this automatically/i.test(unwit));
  check("⭐⭐ `unresolved` does NOT say 'yet'", !/\byet\b/.test(unres));
  check("⭐⭐ …and says it will NOT resolve on its own", /will not resolve on its own/i.test(unres));
  check("⭐ …and names the manual step", /reconcile this transaction against Circle/i.test(unres));
  check("⭐ every band says nothing was observed leaving the wallet",
    [settling, unwit, unres].every((t) => /nothing has been observed leaving your wallet/i.test(t)));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — EVIDENCE vs SILENCE: 'we asked N times' ≠ 'nobody ever checked'");
// ⭐⭐ Different problems, different urgency — and this is TEXT BUILT FROM A VARIABLE, which is
// precisely what a source regex cannot verify.
{
  const asked = text({ state: "burn_submitted", provisional: { band: "unresolved" }, reconcileAttempts: 42 });
  const never = text({ state: "burn_submitted", provisional: { band: "unresolved" }, reconcileAttempts: 0 });
  check("⭐⭐ the ATTEMPT COUNT is interpolated into the sentence", /We asked Circle 42 times/.test(asked), asked.slice(0, 80));
  check("⭐⭐ zero attempts says NOTHING EVER CHECKED IT — not 'we asked 0 times'",
    /nothing ever checked it automatically/i.test(never) && !/asked Circle 0 times/i.test(never));
  check("  …and the two rows are genuinely different text", asked !== never);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — THE 12-DAY RECORD: an unreadable chain is not a pending mint");
// 🚨 `lastVerifyFailure` is written only after IRIS said `minted`, so `chain_unreadable` means the
// mint WAS REPORTED AS LANDED and our read failed. The old copy called that "unproven … it may
// still land" — wrong in both halves.
{
  const unreadable = text({
    state: "mint_unconfirmed", netPredicted: 0.94, destinationLabel: "Polygon (Amoy)",
    mintRecovery: { cause: "chain_unreadable", verifyFailureCount: 1730, exhausted: true },
  });
  const unseen = text({ state: "mint_unconfirmed", netPredicted: 0.94, mintRecovery: { cause: "never_appeared", exhausted: false } });

  check("⭐⭐ it says Circle REPORTED THE MINT COMPLETED", /Circle reported the destination mint as completed/i.test(unreadable));
  check("⭐⭐ …blames OUR read, naming the chain", /our own read of Polygon \(Amoy\) has never succeeded/i.test(unreadable));
  check("⭐⭐ …and says it MOST LIKELY ARRIVED", /most likely arrived/i.test(unreadable));
  check("⭐ …with the failed-read count interpolated", /1730 failed reads/.test(unreadable));
  check("⭐⭐ …and NEVER the old falsehood 'it may still land'", !/may still land/i.test(unreadable), "ABSENT check");
  check("⭐ an exhausted row says we stopped re-checking", /stopped re-checking automatically/i.test(unreadable));

  check("⭐⭐ the UNSEEN case is different text and keeps 'it may still land'",
    /may still land/i.test(unseen) && !/most likely arrived/i.test(unseen));
  check("  …and says Circle has not reported it either", /has not been reported by Circle either/i.test(unseen));
  check("⭐⭐ the two causes NEVER render the same sentence", unreadable !== unseen);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — GOOD NEWS MUST NOT WEAR WARNING GRAMMAR");
{
  const failed = text({ state: "submit_failed", submitFailureDetail: "the USDC approval landed, but the bridge call itself was never submitted" });
  check("⭐⭐ a failed submission leads with NO FUNDS LEFT YOUR WALLET", /no funds left your wallet/i.test(failed));
  check("⭐ …carries the server's own explanation", /never submitted/i.test(failed));
  check("⭐⭐ …and does NOT tell the user to review or reconcile anything", !/needs review|reconcile/i.test(failed), failed.slice(0, 80));
  check("  …a missing detail still renders a truthful fallback",
    /the transaction never landed/i.test(text({ state: "submit_failed" })));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — NUMBERS ARE FORMATTED, NOT DUMPED");
// A raw float in a money row is its own kind of lie about precision.
{
  const arrived = text({ state: "minted", delivery: "measured", amountDelivered: 0.946804123 });
  check("⭐ a measured arrival is fixed to 4dp", /exactly 0\.9468 USDC/.test(arrived), arrived.slice(0, 70));
  check("⭐⭐ …and says it was READ FROM THE CHAIN, which is what makes it 'exactly'",
    /read from the destination chain/i.test(arrived));
  check("⭐⭐ `minted` WITHOUT a measured amount refuses to present the estimate as an arrival",
    /no measured amount was recorded/i.test(text({ state: "minted" })));
  check("  an in-flight row is explicitly an ESTIMATE", /estimated 0\.9400 USDC to arrive/i.test(text({ state: "burn_confirmed", netPredicted: 0.94 })));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — THE UNKNOWN STATE MUST NOT RENDER SILENCE");
// ⭐⭐ THE ONE A REGEX COULD NEVER CATCH. A receipt in a state this component does not know about
// would render an EMPTY status — a row with an amount and no words, which reads as normal.
{
  const alien = text({ state: "some_state_from_a_future_deploy" });
  check("🚧 KNOWN GAP, ASSERTED SO IT CANNOT BE FORGOTTEN: an unknown state renders NOTHING",
    alien === "", `rendered ${JSON.stringify(alien)}`);
  console.log("      ⚠️ This is a REAL gap, recorded rather than hidden. The row still shows the amount");
  console.log("         and destination, so an unknown state paints a row that looks ordinary. Closing it");
  console.log("         needs a fallback branch; it is NOT closed by this commit, and this check will");
  console.log("         start failing the moment someone adds one — which is the reminder.");
  check("  …and an empty receipt likewise renders nothing", text({}) === "");
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
