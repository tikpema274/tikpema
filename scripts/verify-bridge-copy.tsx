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
import { BridgeReceiptStatus, KNOWN_RECEIPT_STATES, type BridgeReceiptView } from "../src/components/bridgeReceiptStatus";

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
const spans = (r: BridgeReceiptView) => {
  // ⚠️ The fallback nests a `<span class="mono">` to show the raw state, so a naive `<span` count
  // reports 2 for a row that says exactly one thing. Count STATUS spans only — the nested
  // identifier is part of one sentence, not a second sentence.
  const html = renderToStaticMarkup(<BridgeReceiptStatus r={r} />);
  return (html.match(/<span/g) || []).length - (html.match(/<span class="mono"/g) || []).length;
};

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
  // 🚨 THIS ASSERTION PREVIOUSLY PINNED 4dp — it ENFORCED the defect rather than missing it. A row
  // saying "exactly" while rendering a rounded number is the "yet" class: one word claiming more than
  // the render delivers, on the one surface whose claim is that the figure was read from the chain.
  // The input below has 9 decimals precisely so a 4dp render cannot pass by coincidence.
  check("⭐⭐ a measured arrival renders 6dp — 'exactly' must not name a ROUNDED number",
    /exactly 0\.946804 USDC/.test(arrived), arrived.slice(0, 70));
  check("⭐ …and the 4dp form is GONE, not merely un-asserted",
    !/exactly 0\.9468 USDC/.test(arrived));
  check("⭐⭐ …and says it was READ FROM THE CHAIN, which is what makes it 'exactly'",
    /read from the destination chain/i.test(arrived));
  check("⭐⭐ `minted` WITHOUT a measured amount refuses to present the estimate as an arrival",
    /no measured amount was recorded/i.test(text({ state: "minted" })));
  check("  an in-flight row is explicitly an ESTIMATE", /estimated 0\.940000 USDC to arrive/i.test(text({ state: "burn_confirmed", netPredicted: 0.94 })));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — THE UNKNOWN STATE MUST NOT RENDER SILENCE");
// ⭐⭐ THE GAP RENDERING FOUND, NOW CLOSED. A receipt in an unrecognised state used to render
// NOTHING — a row with an amount and a destination and no status, indistinguishable from an
// ordinary one. Strictly worse than an error: an error prompts someone to look, a blank does not.
{
  const alien = text({ state: "some_state_from_a_future_deploy" });
  check("⭐⭐ an unknown state now renders a status instead of silence", alien.length > 0, alien.slice(0, 78));
  check("⭐⭐ …it NAMES the raw state, the one datum that makes the row actionable",
    /some_state_from_a_future_deploy/.test(alien));
  check("⭐⭐ …and claims NOTHING in either direction about the money",
    /not.{0,40}evidence that funds did or did not move/i.test(alien));
  check("⭐ …it does not imply arrival", !/arrived|most likely arrived/i.test(alien));
  check("⭐ …and does not imply failure either", !/\bfailed\b/i.test(alien));
  check("  …exactly one status renders", spans({ state: "some_state_from_a_future_deploy" }) === 1);

  const none = text({});
  check("⭐⭐ a receipt with NO state says so, rather than rendering blank", /no status was recorded/i.test(none));
  check("  …and still refuses to characterise the money", /did or did not move/i.test(none));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("8 — THE BINDING: the client must know every state the SERVER can write");
// ⭐⭐ A GUARD CAN ONLY BE TRUSTED ACROSS WHAT IT BINDS. `KNOWN_RECEIPT_STATES` is a transcribed
// copy of the server's vocabulary — unavoidable, since _bridge-receipts.mjs imports @netlify/blobs
// and cannot enter the browser bundle — so the duplication is made safe HERE, by reading both
// sides, rather than by hoping they stay in step.
// 🚨 THE REALISTIC BUG IS NOT A TYPO: it is a legitimate new state added server-side that the
// client never learned. Before the fallback that blanked a row silently; now it fails this suite.
{
  const server = await import("../netlify/functions/_bridge-receipts.mjs");
  const ALL: string[] = [...server.ALL_RECEIPT_STATES];

  check("⭐ the server exposes its state vocabulary as ONE composed list", ALL.length > 0, ALL.join(", "));
  for (const st of ALL) {
    const t = text({ state: st });
    check(`⭐⭐ server state \`${st}\` renders a real status, not the fallback`,
      t.length > 0 && !/unrecognised status/i.test(t), t.slice(0, 56));
  }
  check("⭐⭐ the client list and the server list are the SAME SET, both directions",
    [...KNOWN_RECEIPT_STATES].sort().join("|") === ALL.slice().sort().join("|"),
    `client=[${[...KNOWN_RECEIPT_STATES].sort()}] server=[${ALL.slice().sort()}]`);

  // ⭐ AND EVERY WRITER IS CHECKED AGAINST THE VOCABULARY — a writer inventing a state that no
  // constant declares would satisfy both lists above and still blank a row in production.
  // ⚠️ SCOPED TO THE WRITERS OF *THIS* STORE, AND THE LIST IS DERIVED, NOT HARDCODED. A first
  // attempt scanned every function and flagged `approving`, `burn_pending`, `pending`, `completed`
  // … — the vocabularies of the JOB, DCA and x402 state machines, which are different stores and
  // none of this component's business. ⭐ job-bridge-approve.mjs writes its own `burn_confirmed`
  // into a SEPARATE receipt system (see 412e8d0) and is correctly excluded by this derivation.
  // Deriving from "who imports a writer" means a NEW writer file is in scope automatically —
  // a hardcoded list would go stale exactly when it mattered.
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = "netlify/functions";
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const writers = readdirSync(dir)
    .filter((f) => f.endsWith(".mjs"))
    .filter((f) => {
      const src = strip(readFileSync(`${dir}/${f}`, "utf8"));
      return /_bridge-receipts\.mjs/.test(src) &&
        /\b(saveReceipt|writeReceiptNeverThrows|writePendingReceiptNeverThrows)\s*\(/.test(src);
    });
  check("⭐ the writer set is DERIVED from who imports a receipt writer, so a new one cannot escape it",
    writers.length >= 3, writers.join(", "));
  const emitted = new Set<string>();
  for (const f of writers) {
    for (const m of strip(readFileSync(`${dir}/${f}`, "utf8")).matchAll(/\bstate:\s*"([a-z_]+)"/g)) emitted.add(m[1]);
  }
  const strays = [...emitted].filter((s) => !ALL.includes(s));
  check("⭐⭐ no writer emits a receipt state outside the declared vocabulary",
    strays.length === 0, strays.length ? `STRAY: ${strays.join(", ")}` : `${emitted.size} literals, all declared`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("9 — A MISSING AMOUNT MUST NOT BECOME A CONFIDENT NUMBER");
// 🚨 FOUND BY RENDERING. `Number(null)` is 0, not NaN — so a receipt with `netPredicted: null`
// rendered "in flight — estimated 0.0000 USDC to arrive": a specific, confident, WRONG figure for
// an amount nobody recorded. ⚠️ And it is REACHABLE: recordPendingBridge writes
// `netPredicted: c.netUsdc ?? null` with no consent context, and the reconcile job carries that
// null into the durable receipt. NaN at least looks broken; 0.0000 looks like an answer.
{
  const nullAmt = text({ state: "burn_confirmed", netPredicted: null as any });
  const absent  = text({ state: "burn_confirmed" });
  check("⭐⭐ netPredicted:null NEVER renders 0.0000", !/0\.0000/.test(nullAmt), nullAmt.slice(0, 76));
  check("⭐⭐ …and says the amount was not recorded", /estimated arrival amount was not recorded/i.test(nullAmt));
  check("⭐⭐ an ABSENT amount never renders NaN", !/NaN/.test(absent), absent.slice(0, 76));
  check("⭐ …and both still say the burn is confirmed", /burn is confirmed/i.test(nullAmt) && /burn is confirmed/i.test(absent));
  check("⭐ a REAL amount is still shown, to 6dp", /estimated 0\.940000 USDC to arrive/.test(text({ state: "burn_confirmed", netPredicted: 0.94 })));

  const unconfNull = text({ state: "mint_unconfirmed", netPredicted: null as any, mintRecovery: { cause: "never_appeared" } });
  check("⭐⭐ the unconfirmed row does not print a fake estimate either",
    !/0\.0000/.test(unconfNull) && /not recorded/i.test(unconfNull), unconfNull.slice(0, 90));
  check("  …and still shows a real one when present",
    /0\.940000 USDC/.test(text({ state: "mint_unconfirmed", netPredicted: 0.94, mintRecovery: { cause: "never_appeared" } })));

  check("⭐ NO rendered status anywhere contains NaN, for ANY known state and a null amount",
    [...KNOWN_RECEIPT_STATES].every((st) =>
      !/NaN/.test(text({ state: st, netPredicted: null as any, amountDelivered: null, delivery: "measured" }))));
}

// ═══════════ ⭐⭐ THE TWO FEES ON A RECEIPT — RENDERED, or they are write-never-read ═══════════
// The record carries `feeCharged` and `feeDisclosed` so the gap between what was SHOWN and what was
// TAKEN is visible. A field written and never rendered is the shape this repo hit three times in one
// week, so both are asserted on the rendered output, including the rare branches.
section("FEES — both, and the drift between them");
{
  const base = { state: "minted", delivery: "measured", amountDelivered: 0.0958, destinationLabel: "Base (Sepolia)" };

  const same = text({ ...base, feeCharged: 0.054209, feeDisclosed: 0.054209 });
  check("⭐⭐ shows the fee that was CHARGED", /0\.054209 USDC charged/.test(same), same.slice(0, 90));
  check("⭐ …and stays quiet about the disclosed fee when it is the same number",
    !/you were shown/.test(same), "an always-on second figure would train people to ignore it");

  const drift = text({ ...base, feeCharged: 0.05, feeDisclosed: 0.06 });
  check("⭐⭐ …and SHOWS the disclosed fee when it differs — the drift is visible, not averaged away",
    /0\.050000 USDC charged/.test(drift) && /you were shown/.test(drift) && /0\.060000/.test(drift));

  // ⭐ THE INVARIANT, ON SCREEN. Nothing enforces charged <= disclosed yet; if a receipt ever
  // violates it the user is told, rather than it living only in a server log.
  const bad = text({ ...base, feeCharged: 0.07, feeDisclosed: 0.06 });
  check("🚨 …and says so LOUDLY if charged exceeded disclosed",
    /charged MORE than you were shown/i.test(bad));

  // ⚠️ The error path records feeCharged: null deliberately — unknown, not a stand-in.
  const unknown = text({ ...base, feeCharged: null, feeDisclosed: 0.06 });
  check("⭐⭐ an UNKNOWN charged fee says so, rather than showing the disclosed one as if it were charged",
    /not recorded/.test(unknown) && !/0\.060000 USDC charged/.test(unknown), unknown.slice(0, 100));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
