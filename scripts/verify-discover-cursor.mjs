// verify-discover-cursor.mjs — the discovery cursor advances ONLY on a complete tick.
//
// ⛔ THE PROPERTY THAT MATTERS: an UNREADABLE tick must not move the cursor. Advancing past blocks
// nobody read would skip them permanently and silently — absence-reads-as-safe with persistence
// attached. The verdict already decides this; the cursor must OBEY rather than re-judge.

import { readFileSync } from "node:fs";
import { nextScanRange, nextCursor, WINDOW, MAX_WINDOWS_PER_TICK, COLD_START_WINDOWS, CURSOR_KEY }
  from "../shared/discover-cursor.mjs";
import { sweepVerdict, DISCOVER_OUTCOME } from "../netlify/functions/_bridge-discover.mjs";

let pass = 0, fail = 0;
const check = (l, ok, d = "") => { if (ok) { pass++; console.log(`  ✅ ${l}`); } else { fail++; console.log(`  ❌ ${l}${d ? `  — ${d}` : ""}`); } };
const HEAD = 1_000_000n;

console.log("\n── 1. ⛔ AN UNREADABLE TICK DOES NOT MOVE THE CURSOR ───────────────────");
const partial = sweepVerdict({ windowsAttempted: 3, windowsServed: 2, discovered: [] });
const held = nextCursor({ current: "900000", scannedTo: 930000n, advanceCursor: partial.advanceCursor });
check("🚨 a 2-of-3 tick is UNREADABLE", partial.outcome === DISCOVER_OUTCOME.UNREADABLE);
check("🚨 …and the cursor does NOT move", held.moved === false && held.cursor === "900000");
check("   …and it says why", /not complete/i.test(held.reason || ""));
const partialFound = sweepVerdict({ windowsAttempted: 3, windowsServed: 2, discovered: [{ burnHash: "0x1" }] });
check("⭐ a partial tick that FOUND something still holds the cursor",
  nextCursor({ current: "900000", scannedTo: 930000n, advanceCursor: partialFound.advanceCursor }).moved === false);
check("   …but the finding is still reported, not suppressed", partialFound.discovered.length === 1);
const complete = sweepVerdict({ windowsAttempted: 3, windowsServed: 3, discovered: [] });
const moved = nextCursor({ current: "900000", scannedTo: 930000n, advanceCursor: complete.advanceCursor });
check("a COMPLETE tick advances to the last block of the range", moved.moved === true && moved.cursor === "930000");
check("🚨 zero windows attempted is UNREADABLE, so it cannot advance",
  nextCursor({ current: "900000", scannedTo: 930000n,
    advanceCursor: sweepVerdict({ windowsAttempted: 0, windowsServed: 0 }).advanceCursor }).moved === false);
check("⛔ the cursor NEVER moves backward — a stale tick cannot un-scan",
  nextCursor({ current: "950000", scannedTo: 930000n, advanceCursor: true }).cursor === "950000");
check("   …and says so rather than silently no-op'ing",
  /already at or beyond/i.test(nextCursor({ current: "950000", scannedTo: 930000n, advanceCursor: true }).reason || ""));

console.log("\n── 2. THE RANGE A TICK OWNS ───────────────────────────────────────────");
const cold = nextScanRange({ cursor: null, head: HEAD });
check("⚠️ a COLD START scans one window only", cold.coldStart === true && cold.to - cold.from === WINDOW - 1n);
check("🚨 …and does NOT scan from 0 — it makes no claim about history",
  cold.from > HEAD - WINDOW * 2n, String(cold.from));
const warm = nextScanRange({ cursor: "900000", head: HEAD });
check("a warm tick starts at cursor+1 — no block scanned twice, none skipped", warm.from === 900001n);
check("   …and is bounded per tick", warm.to - warm.from + 1n <= WINDOW * BigInt(MAX_WINDOWS_PER_TICK));
check("   …and reports lag so a stuck cursor is visible", warm.lag === HEAD - 900000n);
const caught = nextScanRange({ cursor: String(HEAD), head: HEAD });
check("caught up -> nothing to do, not an empty scan reported as clean", caught.nothingToDo === true);
check("a tick never scans past head", nextScanRange({ cursor: String(HEAD - 5n), head: HEAD }).to === HEAD);
check("consecutive ticks are contiguous", (() => {
  const a = nextScanRange({ cursor: "900000", head: HEAD });
  const b = nextScanRange({ cursor: String(a.to), head: HEAD });
  return b.from === a.to + 1n;
})());

console.log("\n── 3. ⭐ THE SCHEDULE IS REGISTERED — a commented-out cron is invisible ─");
// bridge-mint-sweep's own header notes it has no such guard: "the build stamp cannot see
// netlify.toml, so a forgotten restore leaves an identical tree hash and a sweeper that never runs."
const toml = readFileSync("netlify.toml", "utf8");
check("🚨 bridge-discover-sweep is scheduled in netlify.toml",
  /\[functions\."bridge-discover-sweep"\]\s*\n\s*schedule = "/.test(toml));
check("   …on the same cadence as bridge-mint-sweep",
  /\[functions\."bridge-discover-sweep"\]\s*\n\s*schedule = "\*\/10 \* \* \* \*"/.test(toml));
check("   …and the function file exists", (() => {
  try { readFileSync("netlify/functions/bridge-discover-sweep.mjs", "utf8"); return true; } catch { return false; }
})());
const fn = readFileSync("netlify/functions/bridge-discover-sweep.mjs", "utf8");
check("⭐ it consumes sweepVerdict's advanceCursor rather than re-judging", /verdict\.advanceCursor/.test(fn));
check("🚨 an unreadable RECEIPT STORE refuses the tick — zero owners is not a clean scan",
  /store-unreadable/.test(fn));
check("⭐ the cursor key is shared, not restated", CURSOR_KEY.length > 0 && fn.includes("CURSOR_KEY"));

// ═══ ⭐⭐ THE SECOND CAP: THE FILTER IS WHAT KEEPS A LEGAL WINDOW LEGAL ════════════════════════
// Arc caps eth_getLogs TWICE — 10,000 BLOCKS (`-32012`) and 20,000 RESULTS (`-32602`). WINDOW is
// sized against the first. Nothing sizes the second: it is held by the discovery query being
// SELECTIVE, and that is a property of a filter in another file, which is exactly the kind of
// load-bearing fact that gets refactored away by someone who does not know it is load-bearing.
//
// ⛔ MEASURED 2026-09-10 on the same 10,000-block window: WITH the `to: BRIDGE_CONTRACT` topic the
// query returns 611 logs; WITHOUT it the identical request returns `-32602`. Headroom is ~20-30x
// today (611 at head, 977 at head-5,000,000, cap 20,000) and it is the topic constraint that
// provides it.
//
// 🚨 AND THE FAILURE WOULD BE A SILENT STALL, NOT AN ERROR. `sweepVerdict` refuses to advance the
// cursor on an unreadable tick — correct, and asserted above — so a window that can NEVER succeed
// is retried every tick forever. Discovery stops, and the only symptom is `cursorLag` climbing.
// A guard that costs one regex is cheap against a failure whose signature is "nothing happens".
{
  const sweep = readFileSync(new URL("../netlify/functions/bridge-discover-sweep.mjs", import.meta.url), "utf8");
  const call = sweep.match(/getLogs\(\{[\s\S]{0,260}?\}\)/);
  check("⭐ the discovery getLogs call is findable — the check has something to be about", !!call);
  const q = call?.[0] ?? "";
  check("⭐⭐ it still narrows by the USDC CONTRACT, not the whole chain", /address:\s*CONTRACTS\.USDC/.test(q));
  check("⭐⭐ …and by the RECIPIENT topic — the constraint measured to be worth 611 logs vs -32602",
    /to:\s*BRIDGE_CONTRACT/.test(q),
    "dropping this makes a correctly-sized window exceed the 20,000-result cap");
  check("⭐ …and by the Transfer event, not every log at that address", /event:\s*TRANSFER/.test(q));
  // ⚠️ Pinned so the two caps stay distinguishable in code as well as in prose: a future edit that
  // "fixes" WINDOW to chase a result-cap error would be treating the wrong cap.
  check("⭐ WINDOW is still the BLOCK cap, unchanged at 10,000", WINDOW === 10000n, String(WINDOW));
}

console.log(`\n${"═".repeat(72)}`);
console.log(`${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
