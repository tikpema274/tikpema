#!/usr/bin/env node
// verify-user-bridge-recovery.mjs — DOES A USER-SIGNED BRIDGE SURVIVE THE USER LEAVING?
//
//   node scripts/verify-user-bridge-recovery.mjs      (also: npm run test:userbridge)
//
// ═══ 🚨 THE WINDOW THIS EXISTS FOR ═════════════════════════════════════════════════════════════
// The agent path completes on its own: the server burns and writes the receipt in ONE request, so
// there is no moment where money has moved and nothing records it.
//
// The user-signed path has a seam the agent path does not: the burn is signed in the BROWSER, and
// the receipt is written by a SECOND request. Close the tab in between and the money is on chain
// with nothing pointing at it.
//
// ⭐⭐ SO THE QUESTION IS NOT "does the sweeper run" — it is WHICH of these states it recovers, and
// the answer is NOT uniform. Asserted here by construction, not by reading the sweeper:
//
//   intent written, never signed        → NOT recoverable, and MUST NOT be. No burn exists; a
//                                         settler handed this would chase a mint forever.
//   burn confirmed (promoted)           → RECOVERABLE. This is the agent path's own shape.
//   ⚠️ signed, tab closed before promote → NOT recoverable by the sweeper. The burn happened and
//                                         we never learned its hash. NAMED, NOT CLOSED — see below.
//
// 🚨 THAT THIRD ROW IS AN HONEST GAP, NOT A PASS. It is asserted here so it cannot be forgotten,
// and so nobody reads "the sweeper covers it" off the other two rows.

import { isStranded, SUBMITTED_STATE, MINT_DEADLINE_MS } from "../netlify/functions/_bridge-receipts.mjs";

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? `  — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  USER-SIGNED BRIDGE — WHAT SURVIVES THE USER LEAVING?               ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

const OLD = Date.now() - (MINT_DEADLINE_MS + 60_000);
const iso = (ms) => new Date(ms).toISOString();

section("1 — an INTENT that was never signed is deliberately NOT swept");
{
  const intent = {
    owner: "0xabc", txId: "user-abc", origin: "user-signed",
    state: SUBMITTED_STATE, burnHash: null, submittedAt: iso(OLD),
  };
  check("a user intent with no burnHash is NOT stranded",
    isStranded(intent) === false,
    "correct: there is no burn to settle, and handing one to the settler makes it chase a mint that may never exist");
  // ⭐ THE CONTROL. If this ever flips, the exclusion has silently become inclusion.
  check("⭐ …and that holds regardless of age", isStranded({ ...intent, submittedAt: iso(0) }) === false);
}

section("2 — a PROMOTED user receipt IS swept, exactly like an agent one");
{
  const promoted = {
    owner: "0xabc", origin: "user-signed", state: "burn_confirmed",
    burnHash: "0x" + "11".repeat(32), burnedAt: iso(OLD),
    destinationKey: "base-sepolia", recipient: "0xdef",
  };
  check("⭐⭐ a user-signed burn_confirmed receipt past the deadline IS stranded",
    isStranded(promoted) === true,
    "this is the property that makes delivered-vs-quoted reporting work for the manual path");

  // 🚨 THE DISCRIMINATOR. If recovery keyed on origin, the manual path would silently never
  // recover — and would look identical to one that does until a real bridge stalled.
  const agentTwin = { ...promoted };
  delete agentTwin.origin;
  check("⭐⭐ recovery does NOT depend on `origin` — agent and user twins behave identically",
    isStranded(promoted) === isStranded(agentTwin),
    `user=${isStranded(promoted)} agent=${isStranded(agentTwin)}`);

  check("…and a FRESH one is not swept yet (the deadline is real, not decorative)",
    isStranded({ ...promoted, burnedAt: iso(Date.now()) }) === false);
}

section("3 — ⚠️ THE GAP: signed, then the tab closed before promote");
{
  // The intent exists; the burn is on chain; we never learned the hash.
  const orphaned = {
    owner: "0xabc", txId: "user-abc", origin: "user-signed",
    state: SUBMITTED_STATE, burnHash: null, submittedAt: iso(OLD),
  };
  check("🚨 NOT recovered by the sweeper — asserted so it is never mistaken for covered",
    isStranded(orphaned) === false,
    "the burn happened and no record carries its hash; nothing can settle it");
  console.log("     ⛔ THIS IS A KNOWN, NAMED GAP, NOT A PASS.");
  console.log("        Closing it needs a reconcile that scans Arc for burns FROM the owner to the");
  console.log("        BridgingKit after the intent's block — the 'SEPARATE, UNBUILT job' the receipt");
  console.log("        module already names for provisional records. NOT built here.");
  console.log("     ⭐ What the intent DOES buy: the attempt, the owner, the destination, the");
  console.log("        recipient and the consent evidence are all durable. Without it the burn is");
  console.log("        on chain and unattributable to anyone.");
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0`);
console.log(`⭐ Promoted receipts recover on the same path as agent ones; unsigned intents are`);
console.log(`   excluded by design; and the signed-then-abandoned window is named, not hidden.\n`);
