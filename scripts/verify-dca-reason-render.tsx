// verify-dca-reason-render.tsx — DOES THE READER ACTUALLY SEE WHY A MANDATE ENDED?
//
//   npx tsx scripts/verify-dca-reason-render.tsx        (also: npm run test:dcareason)
//
// ═══ 🚨 WHY THIS EXISTS — THE THIRD INSTANCE OF THE SAME SHAPE ═════════════════════════════════
// `lastReason` has been written by dca-tick on every terminal transition since the DCA lifecycle
// existed — "reached end date" / "total budget spent" — and NOTHING IN THE UI READ IT. The row
// rendered a bare status beside `until <endAt>`, so a reader saw "complete" against a FUTURE date
// and "cancelled" against a date six weeks past, and could not tell what ended either one.
//
// ⭐⭐ THIRD INSTANCE: errata_note (lived in VERSIONS, dd-openapi's projection never served it),
// dataDisclosure (covered by the deliverable hash, no renderer read it), now lastReason. Same
// family every time — THE FIELD IS IN THE DATA AND THE PROJECTION DROPS IT — and in all three the
// thing that would have caught it is a render assertion, not a source grep.
//
// ═══ ⚠️ WHY NOT A SOURCE GREP FOR `lastReason` ═════════════════════════════════════════════════
// "The string appears in a .tsx file" is not "the reason reaches the reader". A grep passes the day
// it is written and forever after — through a refactor that deletes the JSX and leaves the type, a
// conditional that never fires, or a parent that stops passing the prop. THE PROJECTION IS THE
// THING UNDER TEST, so this renders it.
//
// ⭐ THREE DIRECTIONS, because presence alone cannot distinguish a projection from a hardcode:
//   1. a mandate WITH a lastReason emits that text
//   2. a mandate WITHOUT one emits nothing resembling it
//   3. a mandate with a DIFFERENT reason emits THAT one   ← the direction a hardcoded string fails
//
// 🚨 AND EVERY ORDERING ASSERTION REQUIRES PRESENCE FIRST. `indexOf(a) < indexOf(b)` is satisfied
// by ABSENCE: indexOf returns -1, and -1 is less than everything. That exact fail-open bit the
// disclosure suite once and is called out in its source; it is not repeated here.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MandateDetail } from "../src/components/DcaPanel";

let pass = 0, fail = 0;
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
const check = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? `  — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};
const strip = (html: string) =>
  html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const HOUR = 3600 * 1000;
const base = {
  id: "m1", perTickAmount: 0.05, tokenIn: "USDC", tokenOut: "EURC",
  cadenceMs: HOUR, spentAmount: 0.15, totalBudgetAmount: 0.15,
  endAt: Date.parse("2026-09-21T00:00:00Z"),
};
const render = (m: any) => strip(renderToStaticMarkup(<MandateDetail m={m} />));

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  DCA — WHY A MANDATE ENDED, RENDERED not grepped                    ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("1 — a terminal mandate WITH a lastReason");
{
  const REASON = "total budget spent";
  const text = render({ ...base, status: "complete", lastReason: REASON, closedAt: "2026-08-20T09:00:00Z" });
  check("the reason text is rendered", text.includes(REASON), text.slice(0, 110));
  check("the status is still rendered", /status: complete/.test(text));
  // ⭐ ORDER: the status names the outcome, the reason explains it — reason must follow status.
  // 🚨 PRESENCE FIRST. Written bare, this passes when the reason is ABSENT (indexOf → -1).
  const iR = text.indexOf(REASON);
  const iS = text.indexOf("status: complete");
  check(
    "⭐ the reason sits WITH the status, after it",
    iR >= 0 && iS >= 0 && iS < iR,
    `status@${iS} reason@${iR}${iR < 0 ? " (ABSENT — ordering cannot be satisfied by absence)" : ""}`
  );
}

section("2 — a mandate WITHOUT a lastReason (catches a hardcode)");
{
  const text = render({ ...base, status: "cancelled", cancelledAt: "2026-07-01T09:00:00Z" });
  check("no 'total budget spent' is emitted", !/total budget spent/i.test(text), text.slice(0, 110));
  check("no 'reached end date' is emitted", !/reached end date/i.test(text));
  check("the status still renders normally", /status: cancelled/.test(text));
}

section("3 — a DIFFERENT reason: proves the text is the RECORD'S, not the component's");
{
  const OTHER = "reached end date";
  const text = render({ ...base, status: "expired", lastReason: OTHER, closedAt: "2026-08-26T09:00:00Z" });
  check("the supplied reason is what appears", text.includes(OTHER), text.slice(0, 110));
  // 🚨 If the other sentence showed up here the component would be hardcoding — the exact failure
  // a presence-only assertion cannot see.
  check("…and the OTHER reason does NOT appear", !/total budget spent/i.test(text));
}

section("4 — ⭐ the ENDING date replaces the ceiling on a terminal mandate");
{
  // The row that started this: "complete" against a FUTURE endAt (Sep 21) it never reached.
  const text = render({ ...base, status: "complete", lastReason: "total budget spent", closedAt: "2026-08-20T09:00:00Z" });
  check("an ending date is shown", /ended /.test(text), text.slice(0, 140));
  check("🚨 the unreached ceiling is NOT shown as 'until'", !/until /.test(text));
  check("the ending date is the CLOSED date, not endAt", /Aug 20, 2026/.test(text) && !/Sep 21, 2026/.test(text));
}

section("5 — an ACTIVE mandate still shows the ceiling it is running toward");
{
  const text = render({ ...base, status: "active", spentAmount: 0.05 });
  check("'until <endAt>' is shown while active", /until Sep 21, 2026/.test(text), text.slice(0, 130));
  check("no ending date is invented", !/ended /.test(text));
}

section("6 — cancelledAt / stoppedAt are used, and a record with NONE says nothing");
{
  const c = render({ ...base, status: "cancelled", cancelledAt: "2026-07-01T09:00:00Z" });
  check("cancelledAt renders as the ending date", /ended Jul 1, 2026/.test(c), c.slice(0, 130));
  const s = render({ ...base, status: "stopped-failed", stoppedAt: "2026-06-02T09:00:00Z" });
  check("stoppedAt renders as the ending date", /ended Jun 2, 2026/.test(s), s.slice(0, 130));
  // ⚠️ An older record with no ending stamp must NOT fall back to endAt — that reprints the
  // ceiling as the ending, which is the defect this suite exists for.
  const none = render({ ...base, status: "expired" });
  check("no stamp → no ending date, and NO fallback to the ceiling",
    !/ended /.test(none) && !/until /.test(none), none.slice(0, 130));
  check("…and it does not render 'Invalid Date'", !/Invalid Date/.test(none));
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0`);
console.log(`⭐ The reason reaches the reader, comes from the RECORD, and a terminal mandate shows when it ended.\n`);
