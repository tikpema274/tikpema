// _hl.mjs — the Hyperliquid RETRIEVAL layer. Facts only, no inference.
//
// ═══ ⭐ WHAT THIS DELIBERATELY DOES NOT DO ══════════════════════════════════════════════════════
// It does not classify strategy, guess intent, or rank by anything it had to infer. A basis trade,
// a directional short and a spot hedge are INDISTINGUISHABLE in a position object; anything that
// separates them is a hypothesis. Hypotheses belong in a separate, labelled layer — never mixed
// into the facts table, where they would be read as measurements.
//
// ═══ 🚨 THE TWO THINGS THE OUTPUT MUST ALWAYS CARRY, OR IT OVERSTATES WHAT IT MEASURED ═════════
//   1. WHICH COINS WERE SCANNED. "Top 10 shorts" is a claim about a stated universe.
//   2. THAT IT IS THE TOP-N *ACCOUNTS*, NOT ALL ACCOUNTS. The leaderboard ranks by account value,
//      not by exposure to any coin — in a 60-account sample only 12 held ANY position at all. So
//      this finds the largest shorts AMONG LARGE ACCOUNTS, which is a defensible universe and is
//      NOT "the largest shorts on Hyperliquid".
//
// ═══ ⭐⭐ AND THE ONE THAT IS EASIEST TO GET WRONG: A FAILED FETCH IS NOT AN EMPTY ACCOUNT ══════
// 250 sequential HTTP calls will not all succeed. If a failure is silently skipped, the result set
// shrinks and the summary still says "scanned 250" — an absence quietly filling a result slot and
// reading as data. Every account resolves to exactly one of THREE outcomes — `ok`, `empty`,
// `failed` — the counts are returned alongside the positions, and the caller is expected to print
// the failure count even when it is zero. [[absence-must-never-read-as-safe]]

export const HL_INFO = "https://api.hyperliquid.xyz/info";
export const HL_LEADERBOARD = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";

/** Default coin universe. ⭐ HYPE is in it on EVIDENCE, not on vibes: in a 60-account sample it
 *  carried more short notional than SOL and XRP combined. Excluding it because it is not a
 *  household name would omit one of the largest short books among exactly these accounts. */
export const DEFAULT_COINS = ["BTC", "ETH", "SOL", "XRP", "HYPE"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST to the info endpoint with bounded retry. Throws after `tries` — a caller must not be able
 *  to mistake a dead endpoint for an empty answer. */
async function info(body, { tries = 4, timeoutMs = 15000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(HL_INFO, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { last = e; if (i < tries - 1) await sleep(400 * (i + 1)); }
  }
  throw new Error(`hyperliquid info(${body.type}) failed after ${tries}: ${String(last?.message ?? last).slice(0, 80)}`);
}

/** The tradable universe, so a caller can validate a requested coin instead of silently scanning
 *  for something that does not exist and reporting "0 positions". */
export async function fetchUniverse() {
  const j = await info({ type: "meta" });
  const u = j?.universe ?? [];
  if (!u.length) throw new Error("meta returned an empty universe — refusing to treat that as 'no coins'");
  return u.map((x) => ({ name: x.name, maxLeverage: x.maxLeverage, delisted: !!x.isDelisted }));
}

/** The account universe. ⚠️ NOT available from api.hyperliquid.xyz — `{"type":"leaderboard"}` there
 *  returns HTTP 422. This separate host is what the web UI uses, and it is the ONLY enumeration of
 *  accounts available; without it there is no way to ask "which accounts hold X". */
export async function fetchLeaderboard({ timeoutMs = 60000 } = {}) {
  const r = await fetch(HL_LEADERBOARD, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`leaderboard HTTP ${r.status}`);
  const rows = (await r.json())?.leaderboardRows ?? [];
  if (!rows.length) throw new Error("leaderboard returned no rows — refusing to treat that as 'no accounts'");
  return rows;
}

/** Top N addresses by account value. The sort key is stated in the result so the output can name
 *  the universe it actually used rather than implying a different one. */
export function topAccounts(rows, n) {
  const sorted = [...rows].sort((a, b) => Number(b.accountValue) - Number(a.accountValue));
  return { addresses: sorted.slice(0, n).map((r) => r.ethAddress), sortKey: "accountValue", available: rows.length };
}

/** One call returns EVERY coin an account holds — ⭐ so the scan cost is per ACCOUNT, not per coin.
 *  Adding coins to the universe costs nothing here; only the candle fetch is per-coin. */
async function positionsFor(address) {
  const j = await info({ type: "clearinghouseState", user: address });
  const ps = (j?.assetPositions ?? []).map((p) => p.position).filter(Boolean);
  return { accountValue: j?.marginSummary?.accountValue ?? null, positions: ps };
}

/**
 * Scan accounts and return every position in `coins`.
 *
 * ⭐ THE RETURN CARRIES ITS OWN COMPLETENESS. `scanned.failed` is not an error path — it is part of
 * the result, because "10 shorts out of 250 accounts" and "10 shorts out of the 217 that answered"
 * are different claims and only one of them is true.
 */
export async function scanPositions(addresses, { coins = DEFAULT_COINS, concurrency = 6, paceMs = 120 } = {}) {
  const want = new Set(coins.map((c) => c.toUpperCase()));
  const out = [];
  const scanned = { requested: addresses.length, ok: 0, empty: 0, failed: 0, failures: [] };
  let cursor = 0;

  const worker = async () => {
    while (cursor < addresses.length) {
      const addr = addresses[cursor++];
      try {
        const { accountValue, positions } = await positionsFor(addr);
        if (!positions.length) scanned.empty++; else scanned.ok++;
        for (const p of positions) {
          if (!want.has(String(p.coin).toUpperCase())) continue;
          const szi = Number(p.szi);
          out.push({
            address: addr,
            accountValue: accountValue === null ? null : Number(accountValue),
            coin: p.coin,
            side: szi < 0 ? "SHORT" : "LONG",
            size: Math.abs(szi),
            notionalUsd: Math.abs(Number(p.positionValue)),
            entryPx: p.entryPx === null ? null : Number(p.entryPx),
            leverage: p.leverage?.value ?? null,
            leverageType: p.leverage?.type ?? null,   // ⚠️ "cross" is why liquidationPx is coupled
            liquidationPx: p.liquidationPx === null || p.liquidationPx === undefined ? null : Number(p.liquidationPx),
            unrealizedPnl: Number(p.unrealizedPnl),
            returnOnEquity: p.returnOnEquity === undefined ? null : Number(p.returnOnEquity),
            marginUsed: p.marginUsed === undefined ? null : Number(p.marginUsed),
            cumFunding: p.cumFunding ?? null,
          });
        }
      } catch (e) {
        // 🚨 NOT skipped silently. A failed account is counted and named.
        scanned.failed++;
        if (scanned.failures.length < 20) scanned.failures.push({ address: addr, error: String(e?.message ?? e).slice(0, 70) });
      }
      if (paceMs) await sleep(paceMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, addresses.length) }, worker));
  return { positions: out, scanned };
}

/** Daily OHLCV straight from Hyperliquid. ⚠️ Deliberately NOT an Arbitrum/Goldsky price feed:
 *  Hyperliquid is its own L1 and these positions are marked against ITS oracle, so PnL and
 *  liquidation distance must be computed against this price. A DEX price from another chain is a
 *  different number that does not govern these liquidations. */
export async function fetchDailyCandles(coin, days = 7) {
  const end = Date.now(), start = end - days * 86400_000;
  const j = await info({ type: "candleSnapshot", req: { coin, interval: "1d", startTime: start, endTime: end } });
  return (Array.isArray(j) ? j : []).map((c) => ({
    coin, openTime: c.t, open: Number(c.o), close: Number(c.c), high: Number(c.h), low: Number(c.l), volume: Number(c.v),
  }));
}
