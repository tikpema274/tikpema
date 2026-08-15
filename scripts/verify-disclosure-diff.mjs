#!/usr/bin/env node
// verify-disclosure-diff.mjs — the delta between an ACCEPTED disclosure and the one now in force.
//
//   npx tsx scripts/verify-disclosure-diff.mjs   (also: npm run test:disclosure)
//
// ═══ 🚨 THE DEFECT THIS CLOSES, WHICH WAS SHIPPED ════════════════════════════════════════════
// A vault gate refusal is a 409 carrying the FRESH disclosure — the server says so at
// agent-vault-deposit.mjs: "carrying the disclosure so the UI can render exactly what must be
// acknowledged". The client threw it away (`throw new Error(data?.error)`), so that sentence
// described a capability with NO CONSUMER. A user whose acknowledgement had been invalidated saw a
// bare refusal beside a disclosure they had already ticked, tick still set, nothing indicating the
// disclosure had moved underneath them. ⭐ A gate refusing without saying why.
//
// ⚠️ AND CLEARING THE TICK ALONE WOULD NOT HAVE FIXED IT. "This changed, look again" leaves the user
// to diff two things they cannot see — the old disclosure is gone the moment the new one renders.
// A re-tick nobody can check is a formality, and a formality is trained click-through, already a
// recorded hazard on the fee-band surface. So the change is COMPUTED: the digest is
// `address | warn codes | withdrawFee | depositFee`, therefore every move is explainable.
//
// ⚠️ THE CLIENT CANNOT COMPARE DIGESTS — it holds `ackToken`, a HASH of the digest, while the
// disclosure carries the raw string. The authoritative "something moved" signal is the REFUSAL.

import { diffDisclosure, bps } from "../src/lib/disclosureDiff.ts";
import { errorWithPayload } from "../src/lib/httpError.ts";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);
const D = (over = {}) => ({ level: "WARN", warns: [{ code: "upgradeable", detail: "u" }], blocks: [], withdrawFeeBps: 50, depositFeeBps: 0, ...over });

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  DISCLOSURE DELTA — computed, never announced                        ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("1 — EVERY DIGEST INPUT PRODUCES AN ITEMISED CHANGE");
{
  const added = diffDisclosure(D(), D({ warns: [{ code: "upgradeable" }, { code: "emergency-withdraw", detail: "drain" }] }), true);
  ok("⭐⭐ a NEW warn is named, with its detail", added.warnsAdded.length === 1 && added.warnsAdded[0].code === "emergency-withdraw");
  ok("  …and it is not reported as unexplained", added.unexplained === false);

  const removed = diffDisclosure(D({ warns: [{ code: "upgradeable" }, { code: "owner-is-eoa" }] }), D(), true);
  ok("⭐ a REMOVED warn is named too — a disclosure can get better, and silence would hide that",
    removed.warnsRemoved.length === 1 && removed.warnsRemoved[0].code === "owner-is-eoa");

  const fee = diffDisclosure(D(), D({ withdrawFeeBps: 150 }), true);
  ok("⭐⭐ a FEE move names WHICH fee and BOTH values", fee.feeChanges.length === 1 &&
    fee.feeChanges[0].label === "withdraw fee" && fee.feeChanges[0].fromBps === 50 && fee.feeChanges[0].toBps === 150);
  ok("  …rendered as percentages, not raw bps", bps(150) === "1.50%" && bps(50) === "0.50%");
  ok("⭐ the DEPOSIT fee is diffed separately from the withdraw fee",
    diffDisclosure(D(), D({ depositFeeBps: 25 }), true).feeChanges[0]?.label === "deposit fee");

  const lvl = diffDisclosure(D(), D({ level: "BLOCK" }), true);
  ok("⭐ a verdict LEVEL move is reported", lvl.levelChange?.from === "WARN" && lvl.levelChange?.to === "BLOCK");
}

section("2 — ⭐⭐ THE CASE THAT MUST NEVER BE SILENT");
{
  // The server refused, so something moved — but nothing we render accounts for it.
  const same = diffDisclosure(D(), D(), true);
  ok("⭐⭐ a refusal with NO itemisable difference is UNEXPLAINED, never 'nothing changed'",
    same.changed === true && same.unexplained === true);
  ok("  …because an empty panel reads as 'nothing important happened'", same.warnsAdded.length === 0 && same.feeChanges.length === 0);

  ok("⭐ a MISSING accepted side is unexplained rather than an empty (reassuring) delta",
    diffDisclosure(null, D(), true).unexplained === true);
  ok("  …and with no current disclosure there is nothing to claim at all",
    diffDisclosure(D(), null, true).changed === false);

  // ⚠️ Without the refusal signal, an identical pair is genuinely unchanged — the flag is what makes
  // "unexplained" reachable, and it must NOT fire on an ordinary comparison.
  ok("⭐ without the refusal signal, identical disclosures are NOT reported as changed",
    diffDisclosure(D(), D(), false).changed === false && diffDisclosure(D(), D(), false).unexplained === false);
}

section("3 — A FEE THAT BECOMES UNREADABLE IS A CHANGE, NOT A ZERO");
{
  const gone = diffDisclosure(D(), D({ withdrawFeeBps: null }), true);
  ok("⭐⭐ a fee going from a value to UNKNOWN is reported as a change",
    gone.feeChanges.length === 1 && gone.feeChanges[0].fromBps === 50 && gone.feeChanges[0].toBps === null);
  ok("  …and renders as 'unknown', never as 0.00%", bps(null) === "unknown");
  ok("⭐ …because an unreadable fee shown as 0% is the absence-reads-as-safe shape on a money field",
    bps(0) === "0.00%" && bps(null) !== bps(0));
}

section("4 — ⭐⭐ THE BODY MUST SURVIVE THE THROW");
// 🚨 THE IMPLEMENTATION TRAP. The server sends the fresh disclosure on a 409; the client turned it
// into `new Error(data.error)` and the structure was gone. Everything above would then read a field
// that is not there and fail silently in exactly the way the original defect does.
// ⭐ Tested by CALLING it, not by grepping for it.
{
  const body = { error: "this vault has owner-power warnings you must acknowledge", blocked: true,
                 disclosure: { level: "WARN", warns: [{ code: "emergency-withdraw" }], withdrawFeeBps: 50, depositFeeBps: 0, digest: "d2" } };
  const err = errorWithPayload(body, "Deposit failed");
  ok("⭐⭐ the thrown Error still carries the response body", err.payload === body);
  ok("⭐ …including the fresh disclosure the delta is computed from", err.payload?.disclosure?.warns?.[0]?.code === "emergency-withdraw");
  ok("  …and `message` is unchanged, so every existing caller keeps working", err.message === body.error);
  ok("  …with a fallback when the body names no error", errorWithPayload({}, "Deposit failed").message === "Deposit failed");
  // ⭐ END TO END: a 409 body → the delta a user reads.
  const d = diffDisclosure({ level: "WARN", warns: [{ code: "upgradeable" }], withdrawFeeBps: 50, depositFeeBps: 0 },
                           err.payload.disclosure, true);
  ok("⭐⭐ the surviving body produces an ITEMISED delta, end to end",
    d.warnsAdded[0]?.code === "emergency-withdraw" && d.warnsRemoved[0]?.code === "upgradeable" && d.unexplained === false);
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
