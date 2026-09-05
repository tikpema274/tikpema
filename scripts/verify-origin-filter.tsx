#!/usr/bin/env node
// verify-origin-filter.tsx — CIRCLE IS ONLY ASKED ABOUT IDS CIRCLE ISSUED, AND THE ROW SAYS SO.
//
//   npx tsx scripts/verify-origin-filter.tsx   (also: npm run test:originfilter)
//
// ═══ 🚨 THE DEFECT (14d8b8a) ══════════════════════════════════════════════════════════════════
// Every non-terminal provisional was selected into `reconcilable` and posted to a job that calls
// circle().getTransaction({id: txId}). A user-signed record's txId is locally minted, so Circle
// 400s at URL parsing — ~146 identical failures per abandoned intent, nine records, bounded only
// by the 24h cap. The cap worked and bounded the wrong thing.
//
// ═══ ⛔ WHAT THIS SUITE DEFENDS, AND IT IS TWO THINGS ═════════════════════════════════════════
//  1. THE PREDICATE IS THE ID'S SHAPE, NOT `origin`. Asserted by constructing a record with the
//     "safe" origin and an unaskable id, and one with NO origin at all — both must be excluded.
//     An origin-based filter passes every test you would write about today's nine records and
//     admits the next path that mints its own id.
//  2. THE SENTENCE AND THE SELECTION READ ONE FUNCTION. A row the sweep refuses to send must never
//     claim Circle is being asked. Asserted by RENDERING, not by grepping source.

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { isCircleTransactionId, circleCanBeAsked } from "../shared/circle-tx-id.mjs";
import { BridgeReceiptStatus } from "../src/components/bridgeReceiptStatus";

let pass = 0, fail = 0;
const ok = (l: string, c: boolean, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
  return c;
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

const CIRCLE_ID = "0199a1b2-3c4d-7e8f-a012-3456789abcde";
const LOCAL_ID = "user-mtlru386-qxx7xy";          // a real one, from the store
const render = (r: any) => renderToStaticMarkup(React.createElement(BridgeReceiptStatus, { r }));
const row = (over: any) => ({
  state: "burn_submitted", amountRequested: 1, destinationLabel: "Unichain (Sepolia)", ...over,
});

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  the origin filter — the ID's SHAPE, at the selection, and the copy  ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 ⛔ THE PREDICATE IS A WHITELIST OVER THE ID, NOT A LIST OF ORIGINS");
{
  ok("⭐ a Circle UUID is askable", isCircleTransactionId(CIRCLE_ID));
  ok("🚨 the real locally-minted id is NOT", !isCircleTransactionId(LOCAL_ID));
  for (const bad of ["", "   ", "not-an-id", "user-abc", CIRCLE_ID.slice(0, -1), CIRCLE_ID + "x",
                     "0199a1b23c4d7e8fa0123456789abcde"]) {
    ok(`⛔ ${JSON.stringify(bad)} is not askable`, !isCircleTransactionId(bad));
  }
  for (const bad of [null, undefined, 12345, {}, []]) {
    ok(`⛔ ${JSON.stringify(bad) ?? "undefined"} is not askable`, !isCircleTransactionId(bad as any));
  }
  ok("⭐ case-insensitive — an upper-case UUID is still a UUID", isCircleTransactionId(CIRCLE_ID.toUpperCase()));

  // ⭐⭐ THE ROWS THAT SEPARATE "shape" FROM "origin". An origin filter passes every assertion
  //     above and fails both of these.
  ok("⭐⭐ origin `agent` with a LOCAL id → still excluded (origin is not the discriminator)",
    !circleCanBeAsked({ txId: LOCAL_ID, origin: "agent" } as any));
  ok("⭐⭐ NO origin at all, local id → still excluded",
    !circleCanBeAsked({ txId: LOCAL_ID } as any));
  ok("⭐⭐ origin `user-signed` with a CIRCLE id → INCLUDED (the rule is about the id, not the path)",
    circleCanBeAsked({ txId: CIRCLE_ID, origin: "user-signed" } as any));
  ok("⛔ a record with no txId is not askable — not asking is free", !circleCanBeAsked({} as any));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 ⛔ THE SELECTION IS FILTERED, AND IT IS THE SELECTION — not the job");
{
  const src = readFileSync("netlify/functions/_bridge-receipts.mjs", "utf8");
  ok("⭐⭐ the filter sits on the `reconcilable` push",
    /if \(!p\.terminal && circleCanBeAsked\(r\)\) reconcilable\.push\(r\)/.test(src));
  ok("⭐ …reading the shared predicate, not a local copy",
    /import \{ circleCanBeAsked \} from "\.\.\/\.\.\/shared\/circle-tx-id\.mjs"/.test(src));
  ok("⛔ …and the reason a job-side guard is the WRONG place is written where the edit would be made",
    /THE SWEEP WOULD STILL COUNT IT AS `reconciled`/i.test(src));
  // ⚠️ The job is deliberately NOT changed: it stays correct for the records it should receive.
  const job = readFileSync("netlify/functions/bridge-reconcile-background.mjs", "utf8");
  ok("⚠️ the job still calls Circle unconditionally — the fix is upstream, by design",
    /circle\(\)\.getTransaction\(\{ id: txId \}\)/.test(job));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 🚨 THE unwitnessed COPY — pending vs UNREACHABLE, rendered");
{
  const askable = render(row({ provisional: { band: "unwitnessed" }, txId: CIRCLE_ID, reconcileAttempts: 3 }));
  const not = render(row({ provisional: { band: "unwitnessed" }, txId: LOCAL_ID, reconcileAttempts: 100 }));

  ok("⭐ askable: the check keeps running, and the row says so", /keeps running/i.test(askable));
  ok("🚨 NOT askable: it does NOT say we keep re-checking", !/keep re-checking|keeps running/i.test(not));
  ok("⛔ NOT askable: it says Circle has no record and never did",
    /Circle has no record of this one and never did/i.test(not));
  ok("⛔ …and that asking cannot confirm it however many times",
    /asking Circle cannot confirm it, however many times we ask/i.test(not));
  ok("⭐ …and that it will not resolve on its own", /will\s*<b>not<\/b>\s*resolve on its own/i.test(not));
  ok("⭐ …and the attempts are reported as unable to have succeeded",
    /none of\s*those could have succeeded/i.test(not));
  // ⛔ THE WORD THE WHOLE FINDING TURNED ON.
  ok("⛔⛔ NOT askable: the row never says a confirmation is pending `yet`",
    !/confirmation yet/i.test(not));
  ok("⭐ CONTROL — both rows still say nothing left the wallet",
    /nothing has been observed leaving your wallet/i.test(askable) &&
    /nothing has been observed leaving your wallet/i.test(not));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 ⛔⛔ THE needs-review COPY — the instruction that cannot succeed");
{
  const askable = render(row({ provisional: { band: "unresolved" }, txId: CIRCLE_ID, reconcileAttempts: 5 }));
  const not = render(row({ provisional: { band: "unresolved" }, txId: LOCAL_ID, reconcileAttempts: 146 }));

  ok("⭐ both are still marked needs review", /needs review/i.test(askable) && /needs review/i.test(not));
  // 🚨 APOSTROPHES ARE ESCAPED IN RENDERED MARKUP — `Circle&#x27;s`, not `Circle's`. The first
  // draft of these two assertions contained a raw `'` and could NEVER have matched; they failed on
  // the first run. ⭐ The fix was to read the rendered bytes rather than guess them again — the
  // same rule that put these assertions in a renderer instead of a source grep, one level down.
  ok("⭐ askable: reconcile against Circle by hand — still the right instruction",
    /reconcile this transaction against Circle&#x27;s record by hand/i.test(askable));
  ok("🚨 NOT askable: that instruction is GONE", !/reconcile this transaction against/i.test(not));
  ok("⛔ …replaced by why Circle is the wrong place",
    /its id was not issued by Circle/i.test(not) && /no record there to reconcile against/i.test(not));
  ok("⭐⭐ …and by a place that CAN be checked, with what each answer means",
    /your own wallet&#x27;s history on Arc/i.test(not) &&
    /is there, and if it is not, nothing was sent/i.test(not));
  ok("⭐ …and 'will not resolve on its own' survives on BOTH — the load-bearing claim",
    /will\s*<b>not<\/b>\s*resolve on its own/i.test(askable) &&
    /will\s*<b>not<\/b>\s*resolve on its own/i.test(not));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 ⚠️ THE COUNTER'S NAME — narrowed to what it actually counts");
{
  const r = render(row({ provisional: { band: "unresolved" }, txId: CIRCLE_ID, reconcileAttempts: 5 }));
  // `bumpAttempt` also fires on `refused_unknown_stage`, which returns BEFORE any Circle call.
  ok("⛔ the row no longer claims a number of times we ASKED CIRCLE", !/asked Circle \d+ times/i.test(r));
  ok("⭐ …it says the CHECK ran, which is what the field counts", /The check ran 5 times/i.test(r));
  ok("⭐ the zero case still separates never-checked from checked-and-unanswered",
    /Nothing ever checked it automatically/i.test(
      render(row({ provisional: { band: "unresolved" }, txId: CIRCLE_ID, reconcileAttempts: 0 }))));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 ⭐⭐ ONE PREDICATE — the sentence and the selection cannot disagree");
{
  const comp = readFileSync("src/components/bridgeReceiptStatus.tsx", "utf8");
  ok("⭐ the panel imports the SAME function the selection uses",
    /import \{ circleCanBeAsked \} from "\.\.\/\.\.\/shared\/circle-tx-id\.mjs"/.test(comp));
  ok("⭐ …and derives one flag from it, once", /const askable = circleCanBeAsked\(r\)/.test(comp));
  ok("⛔ the panel does NOT re-derive the rule from `origin`",
    !/origin\s*===\s*"user-signed"/.test(comp) && !/origin\s*!==\s*"user-signed"/.test(comp));
  const sel = readFileSync("netlify/functions/_bridge-receipts.mjs", "utf8");
  ok("⛔ neither does the selection", !/origin\s*===\s*"user-signed"/.test(sel) && !/origin\s*!==\s*"user-signed"/.test(sel));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 🚨 THE SERVER STRING — the second copy of the claim, which HAD drifted");
// ═══ 🚨 THE DEFECT THIS CLOSES (measured on production, 2026-09-05) ═══════════════════════════
// `provisionalStatus`'s `detail` said "being re-checked with Circle automatically" and
// "reconcile the txId against Circle by hand" UNCONDITIONALLY. The origin filter narrowed the
// SELECTION and the PANEL; it did not narrow these. Read live from the store:
//
//   user-mtnczg9o-hkt3xc   unwitnessed, 15.41h, reconcileAttempts null, unaskable
//                          → detail claimed it was being re-checked automatically.  FALSE.
//   user-mtlru386-qxx7xy   unresolved, 42.08h, unaskable
//                          → detail told a human to reconcile against a record Circle never had.
//
// ⭐⭐ WHY IT SURVIVED, AND THE RULE. No user ever saw either sentence — the panel branches on
// `askable` and is guarded by §3 and §4 above. That is precisely what let them rot: a SECOND COPY
// of a claim, in the place nobody was looking, going stale while the watched copy stayed true. A
// guard on the rendered output cannot see a producer string the renderer does not use.
// ⛔ SO THIS SECTION ASSERTS THE PRODUCER DIRECTLY, and then asserts the two AGREE — because the
// property is not "each is right", it is "there is one claim". A binding can only be tested ACROSS
// what it binds. [[duplicate-source-of-truth-is-the-recurring-bug]] [[binding-tested-across-what-it-binds]]
{
  const producer = await import("../netlify/functions/_bridge-receipts.mjs");
  const aged = (ms: number, txId: string) => ({
    state: "burn_submitted", txId,
    submittedAt: new Date(Date.now() - ms).toISOString(),
  });
  const UNWIT_MS = producer.SUBMITTED_SETTLE_DEADLINE_MS + 60_000;
  const CAPPED_MS = producer.SUBMITTED_AGE_CAP_MS + 60_000;

  const unwitAsk = producer.provisionalStatus(aged(UNWIT_MS, CIRCLE_ID));
  const unwitNot = producer.provisionalStatus(aged(UNWIT_MS, LOCAL_ID));
  const capAsk = producer.provisionalStatus(aged(CAPPED_MS, CIRCLE_ID));
  const capNot = producer.provisionalStatus(aged(CAPPED_MS, LOCAL_ID));

  // ⛔ NON-VACUITY FIRST. Every assertion below is about what a band SAYS; if the fixtures are not
  // in the bands we think, they are all vacuously true about the wrong strings.
  ok("⛔ non-vacuity — both unwitnessed fixtures really are `unwitnessed`",
    unwitAsk.band === "unwitnessed" && unwitNot.band === "unwitnessed",
    `${unwitAsk.band} / ${unwitNot.band}`);
  ok("⛔ non-vacuity — both capped fixtures really are `unresolved` and terminal",
    capAsk.band === "unresolved" && capNot.band === "unresolved" && capAsk.terminal && capNot.terminal);

  // ⭐⭐ PAIRWISE INEQUALITY. Two assertions of the form "A says X" and "B does not say X" both
  // pass if A and B are the same string and X is absent. State the split itself.
  // [[collapse-needs-pairwise-inequality]]
  ok("⭐⭐ unwitnessed: the askable and unaskable details are DIFFERENT strings",
    unwitAsk.detail !== unwitNot.detail);
  ok("⭐⭐ unresolved: the askable and unaskable details are DIFFERENT strings",
    capAsk.detail !== capNot.detail);

  ok("⭐ unwitnessed + askable: the server string claims automatic re-checking",
    /re-checked with Circle automatically/i.test(unwitAsk.detail));
  ok("🚨 unwitnessed + NOT askable: it does NOT claim automatic re-checking",
    !/being re-checked with Circle automatically/i.test(unwitNot.detail), unwitNot.detail);
  ok("⛔ …and says why, in terms of the id rather than the origin",
    /not one Circle issued/i.test(unwitNot.detail));
  ok("⭐ …and that it will not resolve on its own", /will not resolve on its own/i.test(unwitNot.detail));

  ok("⭐ unresolved + askable: reconcile against Circle by hand — still the right instruction",
    /reconcile the txId against Circle by hand/i.test(capAsk.detail));
  ok("🚨 unresolved + NOT askable: that instruction is GONE — it could not have succeeded",
    !/reconcile the txId against Circle by hand/i.test(capNot.detail), capNot.detail);
  ok("⛔ …replaced by why Circle is the wrong place, and a place that CAN be checked",
    /no record at Circle to reconcile against/i.test(capNot.detail) &&
    /history on Arc/i.test(capNot.detail));

  // ═══ ⭐⭐ THE BINDING, ACROSS THE TWO SURFACES ═════════════════════════════════════════════
  // The server string and the rendered row are two expressions of ONE claim. Asserting each
  // separately would keep passing if they drifted apart again — which is the whole defect. So the
  // question asked here is whether they AGREE, derived from each independently.
  const serverClaimsAuto = (d: string) => /re-checked with Circle automatically/i.test(d);
  const panelClaimsAuto = (txId: string, attempts: number) =>
    /re-checking it with Circle automatically|keeps running/i.test(
      render(row({ provisional: { band: "unwitnessed" }, txId, reconcileAttempts: attempts })));

  for (const [label, txId, st] of [["askable", CIRCLE_ID, unwitAsk], ["NOT askable", LOCAL_ID, unwitNot]] as const) {
    // ⚠️ BOTH attempt counts, because the panel's askable branch renders two different sentences
    // depending on zero-vs-nonzero and only one of them must survive the agreement check.
    for (const attempts of [0, 100]) {
      ok(`⭐⭐ ${label} @${attempts} attempts — server and panel agree on "is anything checking?"`,
        serverClaimsAuto(st.detail) === panelClaimsAuto(txId, attempts),
        `server=${serverClaimsAuto(st.detail)} panel=${panelClaimsAuto(txId, attempts)}`);
    }
  }

  // ═══ 🚨 THE TWO PRODUCTION RECORDS, BY SHAPE ══════════════════════════════════════════════
  // Not the ids as data — the SHAPES that were false. A regression here is the exact live defect.
  const mtnczg9o = producer.provisionalStatus(
    { state: "burn_submitted", txId: "user-mtnczg9o-hkt3xc", submittedAt: new Date(Date.now() - 15.41 * 3600_000).toISOString(), reconcileAttempts: null });
  ok("🚨 REGRESSION — `user-mtnczg9o-hkt3xc`'s shape no longer claims automatic re-checking",
    mtnczg9o.band === "unwitnessed" && !serverClaimsAuto(mtnczg9o.detail), mtnczg9o.detail);
  const mtlru386 = producer.provisionalStatus(
    { state: "burn_submitted", txId: "user-mtlru386-qxx7xy", submittedAt: new Date(Date.now() - 42.08 * 3600_000).toISOString(), reconcileAttempts: 123 });
  ok("🚨 REGRESSION — `user-mtlru386-qxx7xy`'s shape no longer sends a human to Circle",
    mtlru386.band === "unresolved" && !/reconcile the txId against Circle by hand/i.test(mtlru386.detail),
    mtlru386.detail);

  // ⭐ CONTROL — `settling` is untouched by this change. A fix that quietly rewrote every band
  // would satisfy everything above; this is what says it did not.
  const settleAsk = producer.provisionalStatus(aged(60_000, CIRCLE_ID));
  const settleNot = producer.provisionalStatus(aged(60_000, LOCAL_ID));
  ok("⭐ CONTROL — `settling` says the same thing either way (askability is not yet the question)",
    settleAsk.band === "settling" && settleAsk.detail === settleNot.detail, settleAsk.detail);
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
