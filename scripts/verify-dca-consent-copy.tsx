// verify-dca-consent-copy.tsx — A CONSENT RECORD, PINNED AGAINST THE CODE IT DESCRIBES.
//
//   npx tsx scripts/verify-dca-consent-copy.tsx        (also: npm run test:dca)
//
// ═══ 🚨 WHY THIS ONE IS DIFFERENT FROM A COPY GUARD ══════════════════════════════════════════
// The block this pins is not marketing. It is what the user AUTHORIZED: a server-controlled key
// moving their funds while they are offline. If the words drift, the authorization drifts with
// them and nobody finds out. ⚠️ This surface has form — it ran 22 days with its own notes reading
// "fully verified" while `/api/dca-*` had no redirects and the panel 404'd.
//
// ═══ ⭐⭐ SO EVERY CLAIM IS CHECKED AGAINST THE SERVER, NOT JUST AGAINST ITSELF ═══════════════
// A guard that only asserts "the sentence is present" pins whatever was true when it was written.
// These assertions read the ACTUAL DCA modules, so a claim that stops matching the code fails —
// which is what caught the two corrections below.
//
// 🚨 WHAT WRITING THIS FOUND, both measured 2026-08-20:
//   1. "pause or cancel anytime" implied a PER-MANDATE pause. `STATUS` in `_dca.mjs` has only
//      active / cancelled / complete / expired / stopped-failed — no paused — and `DcaPanel`
//      offers exactly one control, Cancel. What exists is the AGENT-WIDE kill switch, checked
//      fail-closed at `dca-tick.mjs:372`. Stopping "this" would stop everything the executor does.
//   2. "cancelling stops it immediately" was FALSE for a fill already in flight. `dca-cancel`
//      never looks at `pendingPeriod`, and the swap is already submitted on-chain.
//
// ⚠️ AND A SEPARATE, UNFIXED DEFECT IS RECORDED IN SECTION 4 — the tick's ACTIVE check sits ABOVE
// its reconcile, so a cancelled mandate's in-flight fill is never reconciled at all. That is a
// ledger gap, not a copy problem, and it is deliberately NOT patched here.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

const DcaPanel = (await import("../src/components/DcaPanel")).default;

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

const wallet: any = {
  agentWallet: { address: "0x" + "ab".repeat(20), balance: "12.3456" },
  address: "0x" + "cd".repeat(20), usdcBalance: "12.3456", busy: false, isAuthenticated: true,
  ensureSession: async () => "t", refreshAgentWallet: async () => {}, refreshBalance: async () => {},
};
const rendered = renderToStaticMarkup(<DcaPanel wallet={wallet} />)
  .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
  .replace(/\s+/g, " ").trim();

const dca = readFileSync("netlify/functions/_dca.mjs", "utf8");
const tick = readFileSync("netlify/functions/dca-tick.mjs", "utf8");
const cancel = readFileSync("netlify/functions/dca-cancel.mjs", "utf8");
const panelSrc = readFileSync("src/components/DcaPanel.tsx", "utf8");

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  DCA CONSENT RECORD — pinned against the server it describes         ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("0 — the consent block reaches the screen");
check("⚠️ non-empty render", rendered.length > 400, `${rendered.length} chars`);
check("🚨 …and it is marked as custodial BEFORE the authorization",
  /This is custodial\. Read it before you authorize/.test(rendered));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⭐⭐ THE FOUR THINGS THE USER IS ACTUALLY AGREEING TO");
check("⭐⭐ a SERVER-CONTROLLED KEY signs, not their passkey",
  /signed by a server-controlled key, not your passkey/.test(rendered));
check("⭐⭐ …and it acts WHILE THEY ARE OFFLINE", /while you're offline/.test(rendered));
check("⭐ …bounded by an amount, a cadence and an end date", /every/.test(rendered) && /whichever comes first/.test(rendered));
check("⭐ …and still subject to the per-swap cap and daily ceiling",
  /per-swap cap and daily\s*ceiling/.test(rendered));
// 🚨 The checkbox text is the record itself — it must restate the custodial fact, not just tick.
check("🚨🚨 the CHECKBOX restates the custodial fact rather than saying only 'I agree'",
  /I understand Tikpema's server will move my USDC\/EURC automatically while I'm offline/.test(rendered) &&
  /signed by a key it controls/.test(rendered));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — 🚨 NO PER-MANDATE PAUSE IS PROMISED, BECAUSE NONE EXISTS");
// ⚠️ SCOPED TO THE `STATUS` OBJECT, not the whole file. My first pattern was !/PAUSED:/ over
// `_dca.mjs` — which matches `SKIPPED_PAUSED`, a per-TICK OUTCOME ("the kill switch was on this
// period"), not a mandate STATUS. Two different vocabularies, one substring: the check failed
// while the claim was correct. ⭐ The property is about the mandate lifecycle, so read the
// lifecycle enum and nothing else.
const STATUS_BLOCK = dca.slice(dca.indexOf("export const STATUS = {"),
  dca.indexOf("}", dca.indexOf("export const STATUS = {")));
check("⭐ the mandate lifecycle really has no paused state",
  !/pause/i.test(STATUS_BLOCK),
  (STATUS_BLOCK.match(/^\s*([A-Z_]+):/gm) || []).map((x) => x.trim().replace(":", "")).join("/"));
check("⭐ …and the panel really offers only one control", (panelSrc.match(/>Cancel</g) || []).length >= 1 &&
  !/>Pause</.test(panelSrc));
check("🚨🚨 …so the copy must NOT offer to pause THIS schedule",
  !/pause or cancel/i.test(rendered), rendered.match(/pause[^.]{0,40}/i)?.[0] ?? "");
check("⭐ …while the AGENT-WIDE kill switch may still be offered, because it is real",
  /stop your agent entirely/.test(rendered) && /assertNotPaused/.test(tick));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — 🚨 CANCELLING CANNOT RECALL AN IN-FLIGHT SWAP, AND SAYS SO");
check("⭐ dca-cancel genuinely never inspects pendingPeriod — so nothing stops a submitted fill",
  !/pendingPeriod/.test(cancel));
check("🚨🚨 the copy no longer claims cancelling stops it 'immediately'",
  !/cancelling stops it immediately/i.test(rendered));
check("⭐⭐ …it distinguishes FUTURE swaps from one already submitted",
  /stops\s*every future swap|stops every <b>future<\/b> swap|every future swap/i.test(rendered) &&
  /already submitted will still land|cannot recall one already submitted/i.test(rendered));
check("⭐ …and the checkbox carries that limit too, not just the prose above it",
  /cannot recall one already submitted/.test(rendered));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⚠️ THE UNFIXED LEDGER GAP, RECORDED SO IT CANNOT BE FORGOTTEN");
// 🚨 NOT A COPY PROBLEM, AND DELIBERATELY NOT PATCHED HERE — it is money-path logic.
// dca-tick.mjs skips non-ACTIVE mandates at the top of the loop, BEFORE the reconcile:
//     if (m.status !== STATUS.ACTIVE) { beat.inactive++; continue; }   ← line ~329
//     if (m.pendingPeriod != null) { await reconcilePending(m, key); } ← line ~340
// So a mandate cancelled while a fill is in flight is never reconciled: the swap lands on-chain
// and is NEVER counted against the daily ceiling. ⭐ The fix is to reconcile BEFORE the status
// check — but that advances ledgers for a cancelled mandate, so it is the user's call.
const activeAt = tick.indexOf("if (m.status !== STATUS.ACTIVE)");
const reconcileAt = tick.indexOf("if (m.pendingPeriod != null)");
const gapPresent = activeAt > 0 && reconcileAt > activeAt;
check("⚠️ the known ordering gap is STILL PRESENT (flip this assertion when it is fixed)",
  gapPresent, gapPresent
    ? `ACTIVE-check@${activeAt} precedes reconcile@${reconcileAt} — an in-flight fill on a cancelled mandate is never ledgered`
    : "🎉 reconcile now runs first — update this suite and the note in DcaPanel");

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
