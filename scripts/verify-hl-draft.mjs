// verify-hl-draft.mjs — A DRAFT MUST NOT MAKE A CLAIM THE SCAN DOES NOT SUPPORT.
//
//   node scripts/verify-hl-draft.mjs      (also: npm run test:hldraft)
//
// ═══ 🚨 THE TWO DEFECTS THIS GUARDS ════════════════════════════════════════════════════════════
//
// 1. AN UNSCOPED HEADLINE. "Top 10 BTC shorts on Hyperliquid" is FALSE — the scan covers the top-N
//    accounts BY ACCOUNT VALUE, so a large short in a small account is invisible. A caveat in a
//    reply does not repair it: posts are quoted, screenshotted and read alone, and the headline is
//    what travels. ⭐ THE RULE IS TO NARROW THE CLAIM UNTIL IT IS TRUE UNAIDED — not to append a
//    disclaimer. Every draft must carry its universe INSIDE the claim.
//
// 2. TRUNCATION. Cutting at 280 can slice a number ("$125,9") or drop the clause that scopes the
//    claim — leaving a confident falsehood that fits. ⭐⭐ TWO KINDS OF SHORTENING, ONLY ONE SAFE:
//    dropping a DATA ROW keeps the claim true; trimming the CLAIM CLAUSE does not. The first is
//    automatic, the second must never happen. [[token-cap-silent-truncation-trap]]
//
// ⚠️ OFFLINE. Drafts are generated from a fixture via --from, so no network and no keys.
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => {
  let ok = false, note = x;
  try { ok = typeof c === "function" ? !!c() : !!c; }
  catch (e) { ok = false; note = `threw: ${String(e?.message ?? e).slice(0, 60)}`; }
  if (ok) { pass++; console.log(`  ✅ ${l}${note ? ` — ${note}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${note ? ` — ${note}` : ""}`); }
};
const section = async (t, fn) => { console.log(`\n${t}`); try { await fn(); }
  catch (e) { fail++; console.log(`  ❌ 🚨 SECTION CRASHED — ${String(e?.message ?? e).slice(0, 80)}`); } };

const FIX = "/tmp/_hl_draft_fixture.json";
const short = (coin, notional, lev = 5, entry = 100) => ({
  address: "0x" + coin.toLowerCase().padEnd(40, "0"), coin, side: "SHORT", size: 1,
  notionalUsd: notional, entryPx: entry, leverage: lev, leverageType: "cross",
  liquidationPx: entry * 2, unrealizedPnl: -1e6, returnOnEquity: 0, marginUsed: 1, cumFunding: null,
});
const fixture = (over = {}) => ({
  universe: { accountsScanned: 250, accountsAvailable: 43742, sortKey: "accountValue",
              coins: ["BTC", "ETH", "SOL", "XRP", "HYPE"], delisted: [] },
  scanned: { requested: 250, ok: 72, empty: 178, failed: 0, failures: [] },
  shorts: [short("BTC", 125e6, 5, 69878), short("ETH", 122e6), short("ETH", 101e6),
           short("BTC", 98e6), short("HYPE", 84e6)],
  ...over,
});
const run = (fx) => {
  writeFileSync(FIX, JSON.stringify(fx));
  try { return { code: 0, out: execFileSync("node", ["scripts/hl/draft.mjs", "--from", FIX], { encoding: "utf8" }) }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") }; }
};
const posts = (out) => out.split("\n").filter((l) => l.startsWith("  │ ")).map((l) => l.slice(4));

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  HL DRAFT — no claim the scan does not support, and never truncated ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

await section("── 1. 🚨 EVERY DRAFT CARRIES ITS UNIVERSE INSIDE THE CLAIM ─────────", async () => {
  const { out } = run(fixture());
  const blocks = out.split(/\n  [✅🚨] /).slice(1);
  check("four drafts were produced", blocks.length === 4, `${blocks.length}`);
  const bodies = blocks.map((b) => b.split("\n").filter((l) => l.startsWith("  │ ")).map((l) => l.slice(4)).join(" "));
  // Each draft must scope itself — "top N accounts" and the ranking basis, in its own text.
  bodies.forEach((b, i) => {
    check(`draft ${i + 1} names the account universe`, /top 250 accounts|top 250 of/i.test(b), b.slice(0, 46) + "…");
  });
  check("⭐ at least one draft says the ranking is by ACCOUNT VALUE, not exposure",
    bodies.some((b) => /account value/i.test(b) && /not by exposure|not by exposure/i.test(b)));
  check("⚠️ the cross-margin caveat appears", bodies.some((b) => /cross-margin/i.test(b)));
  // 🚨 THE HEADLINE THAT MUST NEVER APPEAR.
  check("🚨 NO draft claims 'shorts on Hyperliquid' without scoping",
    !bodies.some((b) => /shorts on Hyperliquid(?!'s)/i.test(b)));
});

await section("── 2. 🚨 NOTHING IS TRUNCATED, AND OVER-LENGTH IS REFUSED ──────────", async () => {
  const { out } = run(fixture());
  const counts = [...out.matchAll(/(\d+)\/280 chars/g)].map((m) => Number(m[1]));
  check("every draft reports its own length", counts.length === 4, counts.join(","));
  check("⭐ every draft is within 280", counts.every((c) => c <= 280), counts.join(","));
  check("🚨 nothing was silently cut — no draft ends mid-token",
    !posts(out).some((l) => /[$\d],?\d?$/.test(l.trim()) && l.trim().length > 60));
});

await section("── 3. ⭐⭐ IT DROPS ROWS, NOT THE CLAIM, TO FIT ─────────────────────", async () => {
  // Long coin names + big numbers push the ranked draft past 280 unless rows are dropped.
  const fat = fixture({ shorts: Array.from({ length: 5 }, (_, i) => short("FARTCOIN", 987654321 - i, 20, 123456.78)) });
  const { out } = run(fat);
  const counts = [...out.matchAll(/(\d+)\/280 chars/g)].map((m) => Number(m[1]));
  check("⭐ still within 280 with hostile inputs", counts.every((c) => c <= 280), counts.join(","));
  check("⭐⭐ it SAYS it dropped rows rather than doing it silently", /dropping ROWS, not the claim/.test(out));
  const bodies = posts(out).join(" ");
  check("🚨 the claim clause SURVIVED the fitting", /top 250 accounts by account value/i.test(bodies));
});

await section("── 4. 🚨 A SCAN WITH FAILURES CANNOT PRODUCE A 'TOP N' CLAIM ───────", async () => {
  const bad = fixture({ scanned: { requested: 250, ok: 60, empty: 178, failed: 12, failures: [] } });
  const { code, out } = run(bad);
  check("⭐ it REFUSES to draft", code === 1, `exit ${code}`);
  check("…and says why, with the numbers", /12 of 250/.test(out) && /REFUSING TO DRAFT/.test(out));
  check("🚨 no draft text was emitted", !/Largest .* short among/.test(out));
});

await section("── 5. NO POSITIONS IS A RESULT, NOT AN ERROR ───────────────────────", async () => {
  const { code, out } = run(fixture({ shorts: [] }));
  check("⭐ exits 0 — an empty market is a finding", code === 0, `exit ${code}`);
  check("…and says so in those words", /is a RESULT, not a failure/.test(out));
});

await section("── 6. ⛔ NO INFERENCE LEAKS INTO THE TEXT ──────────────────────────", async () => {
  const { out } = run(fixture());
  const bodies = posts(out).join(" ").toLowerCase();
  for (const banned of ["bearish", "bullish", "whale", "basis trade", "hedge", "expects", "betting", "signal"]) {
    check(`no "${banned}"`, !bodies.includes(banned));
  }
  check("⭐ and it states the limit explicitly", /no view on why it's open|position data only/i.test(bodies));
});

await section("── 7. 🚨 WHEN FITTING CANNOT SAVE IT, IT REFUSES — IT DOES NOT TRIM ", async () => {
  // ⭐⭐ THIS SECTION EXISTS BECAUSE THE SUITE WAS VACUOUS WITHOUT IT. Mutating "refuse" into
  // "truncate" passed 28/0, because with row-fitting working no draft ever exceeded 280 and the
  // refusal branch never executed. A guard that never runs is not a guard.
  //
  // Here the HEADER alone blows past the limit — a coin list row-dropping cannot shrink — so
  // fitting is powerless and the only correct behaviour is refusal.
  const huge = fixture({ universe: { accountsScanned: 250, accountsAvailable: 43742,
    sortKey: "accountValue", coins: Array.from({ length: 40 }, (_, i) => `LONGCOINNAME${i}`), delisted: [] } });
  const { code, out } = run(huge);
  const counts = [...out.matchAll(/(\d+)\/280 chars/g)].map((m) => Number(m[1]));
  check("⭐ at least one draft is over the limit (the path is REACHED)", counts.some((c) => c > 280), counts.join(","));
  check("🚨 it is REFUSED, not trimmed to 280", /REFUSED, NOT TRUNCATED/.test(out));
  check("⭐⭐ the over-length text is still printed IN FULL — no draft measures exactly 280",
    !counts.includes(280), counts.join(","));
  check("…and it says to shorten the SOURCE, not to trim", /do not trim to fit/i.test(out));
  // ⭐⭐ ASSERT ON WHAT WAS EMITTED, NOT ON WHAT THE LABEL CLAIMS. The "REFUSED, NOT TRUNCATED"
  // banner is derived from the length check, so it keeps printing even if the text is then cut —
  // the message can announce refusal while the behaviour truncates. Only measuring the PRINTED
  // BODY against the REPORTED length can tell those apart.
  // [[assert-on-rendered-output-not-source-regex]]
  // ⭐ THE TAIL IS THE INVARIANT. Reconstructing the body from decorated output is lossy — an
  // earlier version of this check compared lengths and was red on CORRECT code. What cannot be
  // faked: if a ~700-char draft were cut to 280, its closing line would be gone. So assert the
  // tails survive. Robust, and it fails for exactly one reason.
  check("⭐⭐ an over-length draft is emitted IN FULL — its closing line survives",
    out.includes("Ranked by account value, not by exposure.") && out.includes("Method in the reply."),
    "both tails present");
  check("⭐ the process exits non-zero so a pipeline cannot ignore it", code === 1, `exit ${code}`);
});

try { unlinkSync(FIX); } catch {}
console.log("\n════════════════════════════════════════════════════════════════════════");
console.log(`${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log("⭐ The claim is narrowed until true; nothing is trimmed to make it fit.\n");
