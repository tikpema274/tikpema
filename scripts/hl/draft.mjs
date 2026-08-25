#!/usr/bin/env node
// draft.mjs — turn a scan into POST DRAFTS. It writes text; a human sends it.
//
//   node scripts/hl/draft.mjs                        # scan, then draft
//   node scripts/hl/draft.mjs --accounts 100
//   node scripts/hl/draft.mjs --from scan.json       # draft from a saved --json scan
//   node scripts/hl/draft.mjs --out drafts.txt
//
// ═══ ⭐⭐ THE RULE THIS FILE IS BUILT ON ════════════════════════════════════════════════════════
//
//     NARROW THE CLAIM UNTIL IT IS TRUE UNAIDED. DO NOT APPEND A DISCLAIMER TO A FALSE HEADLINE.
//
// "Top 10 BTC shorts on Hyperliquid" is FALSE — the scan covers the top-N accounts BY ACCOUNT
// VALUE, so a large short held by a small account is invisible. A caveat in a later post does not
// repair that: posts get quoted, screenshotted and read alone, and the headline is what travels.
// So every draft states its universe INSIDE the sentence that makes the claim.
//
// ⭐ This is the same discipline as the retrieval layer, applied where it is HARDER: there, the
// caveat is a line of output nobody has to fit in 280 characters.
//
// ═══ 🚨 AND THE ONE THING IT MUST NEVER DO ═════════════════════════════════════════════════════
// It must never TRUNCATE. Cutting a post at 280 can slice a number in half — "$125,9" — or drop the
// clause that scopes the claim, turning a true statement into a false one. An over-length draft is
// REFUSED and reported, never trimmed to fit. [[token-cap-silent-truncation-trap]]
//
// ⛔ NO INFERENCE. No "whales are bearish", no strategy naming, no directional read. A basis trade
// and a directional short are indistinguishable in a position object; the draft reports positions.
import { readFileSync, writeFileSync } from "node:fs";
import { fetchLeaderboard, topAccounts, scanPositions, DEFAULT_COINS } from "./_hl.mjs";

const LIMIT = 280;
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const FROM = arg("from", null);
const OUT = arg("out", null);
const N = Number(arg("accounts", 250));
const COINS = arg("coins", DEFAULT_COINS.join(",")).split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);

/** Human-scale money. ⚠️ Rounds DOWN in magnitude so a figure is never overstated: $126M for
 *  $125.9M is fine; $126M for $125.4M would be a number the data does not support. */
const money = (n) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(Math.floor(a / 1e8) / 10).toFixed(1)}B`;
  if (a >= 1e6) return `$${Math.floor(a / 1e6)}M`;
  if (a >= 1e3) return `$${Math.floor(a / 1e3)}K`;
  return `$${Math.round(a)}`;
};
const px = (n) => (n === null ? "—" : n >= 1000 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(2)}`);

// ── gather ──
let shorts, scanned, requested, available, coins;
if (FROM) {
  const j = JSON.parse(readFileSync(FROM, "utf8"));
  shorts = j.shorts ?? []; scanned = j.scanned; requested = j.universe.accountsScanned;
  available = j.universe.accountsAvailable; coins = j.universe.coins;
} else {
  const rows = await fetchLeaderboard();
  const t = topAccounts(rows, N);
  const r = await scanPositions(t.addresses, { coins: COINS });
  shorts = r.positions.filter((p) => p.side === "SHORT").sort((a, b) => b.notionalUsd - a.notionalUsd);
  scanned = r.scanned; requested = t.addresses.length; available = t.available; coins = COINS;
}

// 🚨 A SCAN WITH FAILURES CANNOT PRODUCE A "TOP N" CLAIM. If accounts did not answer, the ranking
// is over the ones that did — and no 280-character phrasing carries that honestly. Refuse to draft
// rather than emit a claim whose universe is unstateable.
if (scanned.failed > 0) {
  console.error(`\n  🚨 REFUSING TO DRAFT — ${scanned.failed} of ${scanned.requested} accounts failed to answer.`);
  console.error(`     A "largest among the top ${requested}" claim would be false: the ranking covers`);
  console.error(`     the ${scanned.requested - scanned.failed} that responded. Re-run the scan.\n`);
  process.exit(1);
}
if (!shorts.length) {
  // ⭐ STDOUT, NOT STDERR — and the stream is the point. This exits 0 because an empty market IS a
  // finding; writing it to the error stream would contradict the sentence it is printing and would
  // hide a legitimate result from anything reading stdout.
  console.log(`\n  No short positions found in ${coins.join("/")} among the top ${requested} accounts.`);
  console.log(`  ⚠️ That is a RESULT, not a failure — and there is nothing to draft.\n`);
  process.exit(0);
}

const withPos = scanned.ok, empty = scanned.empty;
const byCoin = {};
for (const s of shorts) byCoin[s.coin] = (byCoin[s.coin] ?? 0) + s.notionalUsd;
const totalNotional = shorts.reduce((a, s) => a + s.notionalUsd, 0);
const top = shorts[0];

// ── the drafts. Each names its universe inside the claim. ──
const drafts = [];

drafts.push({
  label: "A — single post, one position",
  text:
`Largest ${top.coin} short among Hyperliquid's top ${requested} accounts by account value:

${money(top.notionalUsd)} notional · ${top.leverage}x ${top.leverageType}
entry ${px(top.entryPx)} · liq ${px(top.liquidationPx)}
unrealised ${top.unrealizedPnl < 0 ? "-" : "+"}${money(top.unrealizedPnl)}

Position data only. No view on why it's open.`,
});

drafts.push({
  label: "B — single post, the aggregate",
  text:
`Scanned Hyperliquid's top ${requested} accounts by account value.

${withPos} hold positions, ${empty} are empty.
${shorts.length} short positions in ${coins.join("/")}, ${money(totalNotional)} notional.

Largest: ${top.coin}, ${money(top.notionalUsd)} at ${top.leverage}x.

Ranked by account value, not by exposure.`,
});

// ⭐⭐ TWO KINDS OF SHORTENING, AND ONLY ONE IS SAFE.
//   · dropping a DATA ROW      — the claim stays true, the list is just shorter. SAFE, automatic.
//   · trimming the CLAIM CLAUSE — "among the top N accounts by account value" is what makes the
//     headline true. Cutting it leaves a confident falsehood that fits. NEVER automatic.
// So the list grows largest-first while the whole post fits, and the header is never touched. If
// even the header does not fit, that is a bug and the draft is REFUSED below rather than salvaged.
const buildRanked = (max = 5) => {
  const head = `Largest shorts among Hyperliquid's top ${requested} accounts by account value, in ${coins.join("/")}:\n\n`;
  const tail = `\n\nMethod in the reply. 🧵`;
  const rows = [];
  for (const s of shorts.slice(0, max)) {
    const row = `${rows.length + 1}. ${s.coin} ${money(s.notionalUsd)} · ${s.leverage}x · entry ${px(s.entryPx)}`;
    const candidate = head + [...rows, row].join("\n") + tail;
    if ([...candidate].length > LIMIT) break;      // this row does not fit — stop, do not trim it
    rows.push(row);
  }
  return { text: head + rows.join("\n") + tail, shown: rows.length };
};
const ranked = buildRanked();
drafts.push({
  label: `C — thread, post 1 of 2 (the numbers${ranked.shown < Math.min(5, shorts.length) ? `, ${ranked.shown} rows — trimmed to fit by dropping ROWS, not the claim` : ""})`,
  text: ranked.text,
});

drafts.push({
  label: "C — thread, post 2 of 2 (the method — this is the part that makes post 1 honest)",
  text:
`Method: top ${requested} of ${available.toLocaleString()} accounts, ranked by ACCOUNT VALUE — not by exposure. A large short in a small account is invisible here.

${withPos} of ${requested} held any position.

Liquidation prices are cross-margin: they move with the account's other positions.`,
});

// ── report ──
const out = [];
const w = (s) => { out.push(s); console.log(s); };
w("");
w(`  Hyperliquid draft posts — ${new Date().toISOString().slice(0, 16).replace("T", " ")}Z`);
w(`  scanned ${requested} of ${available.toLocaleString()} accounts · ${withPos} with positions · ${scanned.failed} failed`);
w(`  ⛔ DRAFTS ONLY. Nothing is posted. Read them, then send whichever you want yourself.`);
w("  " + "─".repeat(72));

let refused = 0;
for (const d of drafts) {
  const n = [...d.text].length;                       // count code points, not UTF-16 units
  const over = n > LIMIT;
  if (over) refused++;
  w("");
  w(`  ${over ? "🚨" : "✅"} ${d.label}   ${n}/${LIMIT} chars${over ? "  — REFUSED, NOT TRUNCATED" : ""}`);
  w("  " + "┄".repeat(72));
  for (const line of d.text.split("\n")) w("  │ " + line);
  w("  " + "┄".repeat(72));
  if (over) {
    // 🚨 The whole point: an over-length draft is a BUG TO FIX, not a string to cut. Trimming could
    // remove the clause that scopes the claim and leave a confident falsehood that still fits.
    w(`  │ 🚨 ${n - LIMIT} chars over. Shorten the SOURCE text — do not trim to fit.`);
    w(`  │    Cutting could drop the universe clause and leave a false claim that fits.`);
  }
}

w("");
w("  " + "─".repeat(72));
w(`  ${drafts.length - refused}/${drafts.length} drafts fit. ${refused ? `🚨 ${refused} refused.` : ""}`);
w("  ⭐ Every draft states its universe INSIDE the claim — 'among the top N accounts by account");
w("     value' — because a caveat in a reply does not travel with a screenshot.");
w("  ⛔ No strategy read, no directional call. Position data only.");
w("");
if (OUT) { writeFileSync(OUT, out.join("\n")); console.log(`  written to ${OUT}\n`); }
process.exit(refused ? 1 : 0);
