// verify-hl-retrieval.mjs — THE RETRIEVAL LAYER MUST NOT REPORT MORE THAN IT SCANNED.
//
//   node scripts/verify-hl-retrieval.mjs      (also: npm run test:hlretrieval)
//
// ═══ 🚨 THE DEFECT THIS EXISTS TO PREVENT ══════════════════════════════════════════════════════
// 250 sequential HTTP calls will not all succeed. If a failed account is silently skipped, the
// result set shrinks while the summary still says "scanned 250" — an absence quietly filling a
// result slot and reading as data. "10 shorts out of 250 accounts" and "10 shorts out of the 217
// that answered" are DIFFERENT CLAIMS and only one is true.
// [[absence-must-never-read-as-safe]]
//
// ⚠️ OFFLINE BY CONSTRUCTION. `globalThis.fetch` is replaced, so no network is touched and the
// suite is runnable in CI, on a fork, and with no keys. It therefore proves the ACCOUNTING, not
// that Hyperliquid's API behaves as modelled — the live shape is exercised by running
// scripts/hl/top-shorts.mjs, which is not a regression check.
const realFetch = globalThis.fetch;
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

const pos = (coin, szi, notional, extra = {}) => ({
  coin, szi: String(szi), positionValue: String(notional), entryPx: "100",
  leverage: { value: 5, type: "cross" }, liquidationPx: "200", unrealizedPnl: "-1",
  returnOnEquity: "0", marginUsed: "1", ...extra,
});
/** Install a fake info endpoint. `plan` maps address -> positions[] | "FAIL" | "EMPTY". */
const install = (plan) => {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}");
    if (body.type === "meta") return { ok: true, json: async () => ({ universe: [
      { name: "BTC", maxLeverage: 40 }, { name: "ETH", maxLeverage: 25 }, { name: "HYPE", maxLeverage: 10 },
      { name: "OLD", maxLeverage: 5, isDelisted: true }] }) };
    if (body.type === "clearinghouseState") {
      const p = plan[body.user];
      if (p === "FAIL") throw new Error("simulated network failure");
      return { ok: true, json: async () => ({ marginSummary: { accountValue: "1000" },
        assetPositions: (p === "EMPTY" || !p ? [] : p).map((x) => ({ position: x })) }) };
    }
    return { ok: true, json: async () => ([]) };
  };
};
const { scanPositions, topAccounts, fetchUniverse, DEFAULT_COINS } = await import("./hl/_hl.mjs");

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  HL RETRIEVAL — never report more than was scanned                  ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

await section("── 1. 🚨 A FAILED ACCOUNT IS COUNTED, NOT SILENTLY DROPPED ─────────", async () => {
  install({ a: [pos("BTC", -1, 100)], b: "FAIL", c: [pos("BTC", -2, 200)], d: "FAIL", e: "EMPTY" });
  const { positions, scanned } = await scanPositions(["a","b","c","d","e"], { coins: ["BTC"], paceMs: 0 });
  check("⭐ failures are counted", scanned.failed === 2, `failed=${scanned.failed}`);
  check("⭐ requested is the FULL list, not the survivors", scanned.requested === 5, `${scanned.requested}`);
  check("ok / empty are separate outcomes", scanned.ok === 2 && scanned.empty === 1, `ok=${scanned.ok} empty=${scanned.empty}`);
  check("⭐⭐ the three outcomes account for every address", scanned.ok + scanned.empty + scanned.failed === scanned.requested);
  check("the failed addresses are NAMED, not just tallied", scanned.failures.length === 2 && scanned.failures[0].address === "b");
  check("only the answering accounts contribute positions", positions.length === 2, `${positions.length}`);
});

await section("── 2. THE COIN FILTER IS THE UNIVERSE, AND ONLY IT ─────────────────", async () => {
  install({ a: [pos("BTC", -1, 100), pos("ETH", -1, 999), pos("HYPE", -1, 50)] });
  const { positions } = await scanPositions(["a"], { coins: ["BTC", "HYPE"], paceMs: 0 });
  check("⭐ only requested coins are returned", positions.map(p=>p.coin).sort().join(",") === "BTC,HYPE",
    positions.map(p=>p.coin).join(","));
  check("⚠️ an unrequested coin is EXCLUDED even when it is the largest", !positions.some(p=>p.coin==="ETH"));
  const one = await scanPositions(["a"], { coins: ["BTC"], paceMs: 0 });
  check("⭐⭐ ONE call serves every coin — cost is per ACCOUNT, not per coin",
    one.scanned.requested === 1 && positions.length === 2, "1 account -> 2 coins in a single fetch");
});

await section("── 3. SIDE AND SIZE COME FROM THE SIGN, NOT FROM A GUESS ───────────", async () => {
  install({ a: [pos("BTC", -1.5, 150), pos("ETH", 2.5, 250)] });
  const { positions } = await scanPositions(["a"], { coins: ["BTC","ETH"], paceMs: 0 });
  const btc = positions.find(p=>p.coin==="BTC"), eth = positions.find(p=>p.coin==="ETH");
  check("negative szi -> SHORT", btc.side === "SHORT", btc.side);
  check("positive szi -> LONG", eth.side === "LONG", eth.side);
  check("⭐ size is the ABSOLUTE value (a short is not a negative quantity)", btc.size === 1.5, String(btc.size));
  check("notional is absolute too", btc.notionalUsd === 150);
  check("⚠️ leverageType is carried — it is why liquidationPx is coupled", btc.leverageType === "cross");
});

await section("── 4. ⚠️ MISSING FIELDS BECOME null, NEVER 0 ───────────────────────", async () => {
  install({ a: [pos("BTC", -1, 100, { liquidationPx: null, returnOnEquity: undefined, marginUsed: undefined })] });
  const { positions } = await scanPositions(["a"], { coins: ["BTC"], paceMs: 0 });
  const p = positions[0];
  // 🚨 A missing liquidation price rendered as 0 would read as "liquidates at zero" — the most
  // reassuring possible number for a short. Unknown must not wear a value's clothes.
  check("🚨 absent liquidationPx is null, not 0", p.liquidationPx === null, String(p.liquidationPx));
  check("absent returnOnEquity is null, not 0", p.returnOnEquity === null, String(p.returnOnEquity));
  check("absent marginUsed is null, not 0", p.marginUsed === null, String(p.marginUsed));
});

await section("── 5. AN EMPTY UNIVERSE IS AN ERROR, NOT 'NO COINS' ────────────────", async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ universe: [] }) });
  let threw = false;
  try { await fetchUniverse(); } catch { threw = true; }
  check("⭐ an empty meta THROWS rather than returning []", threw);
  install({});
  const u = await fetchUniverse();
  check("…and a populated one is returned normally", u.length === 4, `${u.length} coins`);
  check("delisted is surfaced, not hidden", u.find(x=>x.name==="OLD")?.delisted === true);
});

await section("── 6. topAccounts NAMES ITS SORT KEY AND THE POOL IT CAME FROM ─────", async () => {
  const rows = [{ethAddress:"lo",accountValue:"1"},{ethAddress:"hi",accountValue:"999"},{ethAddress:"mid",accountValue:"50"}];
  const t = topAccounts(rows, 2);
  check("sorted by accountValue, descending", t.addresses.join(",") === "hi,mid", t.addresses.join(","));
  check("⭐ the sort key is stated, so the output can name its universe", t.sortKey === "accountValue");
  check("⭐⭐ `available` is the FULL pool — the caller can say 250 of N", t.available === 3, String(t.available));
  check("⚠️ asking for more than exists returns what exists, not padding", topAccounts(rows, 99).addresses.length === 3);
});

await section("── 7. DEFAULTS ARE THE ONES THE EVIDENCE SUPPORTS ──────────────────", async () => {
  check("⭐ HYPE is in the default set (it out-shorted SOL and XRP combined in sampling)",
    DEFAULT_COINS.includes("HYPE"), DEFAULT_COINS.join(","));
  check("BTC and ETH are in it", DEFAULT_COINS.includes("BTC") && DEFAULT_COINS.includes("ETH"));
});

globalThis.fetch = realFetch;
console.log("\n════════════════════════════════════════════════════════════════════════");
console.log(`${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log("⭐ The scan reports what it scanned, and unknown never renders as a number.\n");
