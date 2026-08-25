#!/usr/bin/env node
// top-shorts.mjs — the largest SHORT positions among the top-N Hyperliquid accounts.
//
//   node scripts/hl/top-shorts.mjs                          # defaults: 250 accounts, 5 coins, top 10
//   node scripts/hl/top-shorts.mjs --accounts 100 --top 5
//   node scripts/hl/top-shorts.mjs --coins BTC,ETH
//   node scripts/hl/top-shorts.mjs --json                   # machine-readable, same numbers
//
// ═══ 🚨 THE HEADLINE IS A CLAIM ABOUT A UNIVERSE, AND THE UNIVERSE IS PRINTED WITH IT ══════════
// This is NOT "the top shorts on Hyperliquid". It is the largest shorts AMONG THE TOP-N ACCOUNTS BY
// ACCOUNT VALUE, in a STATED set of coins. The leaderboard ranks by account value, not by exposure,
// so an account with a huge short and a small balance is invisible here. Both facts print on every
// run — as part of the result, not as a footnote a reader can skip.
//
// ⭐ FACTS ONLY. No strategy classification. A basis trade, a directional short and a spot hedge
// look identical in a position object; separating them is a hypothesis and does not belong in a
// table of measurements.
import { fetchLeaderboard, topAccounts, scanPositions, fetchUniverse, DEFAULT_COINS } from "./_hl.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const N_ACCOUNTS = Number(arg("accounts", 250));
const TOP = Number(arg("top", 10));
const COINS = arg("coins", DEFAULT_COINS.join(",")).split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
const AS_JSON = process.argv.includes("--json");
if (!Number.isInteger(N_ACCOUNTS) || N_ACCOUNTS < 1) { console.error("--accounts must be a positive integer"); process.exit(2); }
if (!Number.isInteger(TOP) || TOP < 1) { console.error("--top must be a positive integer"); process.exit(2); }

const log = (...a) => { if (!AS_JSON) console.log(...a); };
const usd = (n) => "$" + Math.round(n).toLocaleString();

log("");
log("  Hyperliquid — largest SHORTS among the top accounts");
log("  " + "─".repeat(74));

// ⚠️ Validate the requested coins against the live universe. Scanning for a coin that does not
// exist would report "0 positions", which reads as "nobody is short it" — a false absence.
const universe = await fetchUniverse();
const known = new Map(universe.map((u) => [u.name, u]));
const unknown = COINS.filter((c) => !known.has(c));
if (unknown.length) { console.error(`  🚨 not tradable on Hyperliquid: ${unknown.join(", ")} — refusing to report 0 for a coin that does not exist`); process.exit(2); }
const delisted = COINS.filter((c) => known.get(c)?.delisted);

const rows = await fetchLeaderboard();
const { addresses, sortKey, available } = topAccounts(rows, N_ACCOUNTS);
log(`  scanning ${addresses.length} of ${available.toLocaleString()} accounts, ranked by ${sortKey}`);
log(`  coins: ${COINS.join(", ")}${delisted.length ? `   ⚠️ delisted: ${delisted.join(", ")}` : ""}`);
log("");

const t0 = Date.now();
const { positions, scanned } = await scanPositions(addresses, { coins: COINS });
const secs = ((Date.now() - t0) / 1000).toFixed(1);

const shorts = positions.filter((p) => p.side === "SHORT").sort((a, b) => b.notionalUsd - a.notionalUsd);
const top = shorts.slice(0, TOP);

if (AS_JSON) {
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    universe: { accountsScanned: scanned.requested, accountsAvailable: available, sortKey, coins: COINS, delisted },
    scanned, elapsedSeconds: Number(secs),
    caveats: [
      "Top-N ACCOUNTS by account value — not all accounts, and not ranked by exposure.",
      "Only the coins listed in universe.coins were scanned.",
      "liquidationPx is CROSS-MARGIN where leverageType is 'cross': it moves with the account's other positions and is not this position's independent risk.",
      "An inbound scan failure is counted in scanned.failed — results describe the accounts that ANSWERED.",
    ],
    shorts: top, allShorts: shorts.length,
  }, null, 2));
  process.exit(0);
}

log(`  ${"#".padStart(3)}  ${"coin".padEnd(6)} ${"notional".padStart(14)} ${"size".padStart(12)} ${"entry".padStart(11)} ${"lev".padStart(6)} ${"liqPx".padStart(12)}  ${"uPnL".padStart(13)}  account`);
log("  " + "─".repeat(110));
top.forEach((p, i) => {
  log(`  ${String(i + 1).padStart(3)}  ${p.coin.padEnd(6)} ${usd(p.notionalUsd).padStart(14)} ${p.size.toLocaleString().padStart(12)} ` +
      `${(p.entryPx ?? 0).toLocaleString().padStart(11)} ${((p.leverage ?? "?") + "x").padStart(6)} ` +
      `${(p.liquidationPx === null ? "—" : Math.round(p.liquidationPx).toLocaleString()).padStart(12)}  ` +
      `${usd(p.unrealizedPnl).padStart(13)}  ${p.address.slice(0, 12)}…`);
});

log("");
log("  " + "─".repeat(74));
log(`  ${shorts.length} short position(s) found in ${COINS.join("/")}; showing top ${top.length}.  ${secs}s`);
// 🚨 PRINTED EVEN WHEN ZERO. A failure count that only appears when non-zero teaches a reader that
// its absence means nothing happened, when it may mean nobody looked.
log(`  accounts: ${scanned.ok} with positions · ${scanned.empty} empty · ${scanned.failed} FAILED` +
    (scanned.failed ? `  ← results describe the ${scanned.requested - scanned.failed} that answered` : ""));
if (scanned.failed) scanned.failures.slice(0, 5).forEach((f) => log(`      ${f.address.slice(0, 12)}… ${f.error}`));
log("");
log("  ⚠️  This is the largest shorts among the top " + scanned.requested + " accounts BY ACCOUNT VALUE —");
log("      not all accounts, and not ranked by exposure. A large short held by a small account is invisible here.");
log("  ⚠️  liquidationPx is CROSS-MARGIN: it moves with the account's other positions.");
log("      It is not this position's independent liquidation risk.");
log("");
