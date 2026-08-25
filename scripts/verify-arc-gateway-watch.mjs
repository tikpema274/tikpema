// verify-arc-gateway-watch.mjs — A BROKEN CHECK MUST NEVER READ AS A PASSING ONE.
//
//   node scripts/verify-arc-gateway-watch.mjs      (also: npm run test:arcgatewaywatch)
//
// ═══ 🚨 WHAT THIS WATCH IS FOR ═════════════════════════════════════════════════════════════════
// Arc has no Gateway domain on mainnet (measured 2026-08-24). Without one the unified balance and
// the GatewayWalletBatched rail do not work on Arc mainnet. The watch notices the day that changes.
//
// ═══ ⭐⭐ THE PROPERTY UNDER TEST ═══════════════════════════════════════════════════════════════
// "Arc is absent from the mainnet list" is worth NOTHING unless the same instrument demonstrably
// CAN report Arc. The testnet list is the positive control. If the control fails, the correct
// verdict is INCONCLUSIVE — never "unchanged". [[filtered-read-is-not-absence]]
//
// ⚠️ This is not hypothetical: the earlier CLOUD version of this watch was blocked by an egress
// proxy and returned empty for BOTH endpoints. Had it treated that as "Arc absent", it would have
// reported the expected answer daily, for the right-looking reason, until 16 Sep.
//
// OFFLINE — `verdict()` is a pure function, so every branch is driven without a network.
import { verdict, parseDomains, alertBody, handler } from "../netlify/functions/arc-gateway-watch.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => {
  let ok = false, note = x;
  try { ok = typeof c === "function" ? !!c() : !!c; }
  catch (e) { ok = false; note = `threw: ${String(e?.message ?? e).slice(0, 60)}`; }
  if (ok) { pass++; console.log(`  ✅ ${l}${note ? ` — ${note}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${note ? ` — ${note}` : ""}`); }
};
const section = (t, fn) => { console.log(`\n${t}`); try { fn(); }
  catch (e) { fail++; console.log(`  ❌ 🚨 SECTION CRASHED — ${String(e?.message ?? e).slice(0, 80)}`); } };

const d = (chain, domain = 0, addr = "0x0") => ({ chain, network: "Mainnet", domain, walletContract: { address: addr } });
const MAINNET_TODAY = ["Ethereum","Avalanche","Optimism","Arbitrum","Solana","Base","Polygon","Unichain","Sonic","Worldchain","Sei","HyperEVM"].map((c, i) => d(c, i));
const TESTNET_OK = [...MAINNET_TODAY, d("ARC", 26, "0x0077777d7EBA4688BDeF3E311b846F25870A19B9")];

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  ARC GATEWAY WATCH — a broken check must not read as a passing one  ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("── 1. TODAY'S REALITY: absent, control passes → quiet ──────────────", () => {
  const v = verdict({ mainnet: MAINNET_TODAY, testnet: TESTNET_OK });
  check("outcome is ARC_ABSENT", v.outcome === "ARC_ABSENT", v.outcome);
  check("⭐ it does NOT alert — the expected answer is not news", v.alert === false);
  check("…and the reason states the control passed", /control passed/i.test(v.reason), v.reason.slice(0, 60));
  check("the domain count is quoted, not just 'absent'", /12 mainnet domains/.test(v.reason));
});

section("── 2. 🚨 THE CONTROL FAILS → INCONCLUSIVE, NEVER 'UNCHANGED' ───────", () => {
  // The literal shape the cloud version hit: neither list mentions Arc.
  const v = verdict({ mainnet: MAINNET_TODAY, testnet: MAINNET_TODAY });
  check("🚨 outcome is INCONCLUSIVE, not ARC_ABSENT", v.outcome === "INCONCLUSIVE", v.outcome);
  check("⭐⭐ it ALERTS — a check that could not run must be heard", v.alert === true);
  check("…and names the control as the thing that failed", /positive control FAILED/i.test(v.reason));
  check("⭐ it says the silence proves nothing", /proves nothing/i.test(v.reason));
});

section("── 3. ⭐ THE EVENT THE WATCH EXISTS FOR ────────────────────────────", () => {
  const v = verdict({ mainnet: [...MAINNET_TODAY, d("ARC", 26, "0xABC")], testnet: TESTNET_OK });
  check("outcome is ARC_PRESENT", v.outcome === "ARC_PRESENT", v.outcome);
  check("⭐ it alerts", v.alert === true);
  check("the domain NUMBER is carried, not just the fact", v.arc?.domain === 26 && /domain 26/.test(v.reason));
  check("the wallet contract is carried", /0xABC/.test(v.reason));
});

section("── 4. AN UNREACHABLE ENDPOINT IS INCONCLUSIVE, NOT ABSENT ──────────", () => {
  const v = verdict({ error: "endpoint unreachable or unreadable: HTTP 403" });
  check("🚨 outcome is INCONCLUSIVE", v.outcome === "INCONCLUSIVE", v.outcome);
  check("it alerts", v.alert === true);
  check("the underlying error is carried, not swallowed", /403/.test(v.reason));
});

section("── 5. ⚠️ CHAIN-NAME MATCHING IS ANCHORED, NOT A SUBSTRING ──────────", () => {
  // 🚨 A bare `includes("arc")` would match "Arbitrum"… no — but it WOULD match a future
  // "Polygon zkEVM Archive" or similar. Anchored matching is what keeps a lookalike from
  // triggering a false ARC_PRESENT, which is the most expensive wrong answer this watch can give.
  const decoys = verdict({ mainnet: [d("Arbitrum", 3), d("Marchain", 9), d("Archive", 11)], testnet: TESTNET_OK });
  check("🚨 'Arbitrum' does NOT count as Arc", decoys.outcome === "ARC_ABSENT", decoys.outcome);
  check("🚨 'Marchain' does not either (substring in the middle)", decoys.outcome === "ARC_ABSENT");
  check("⚠️ 'Archive' does not either (starts with 'arc')", decoys.outcome === "ARC_ABSENT");
  // …and the real thing still matches, in the casings Circle might plausibly use.
  for (const name of ["ARC", "Arc", "arc", "Arc Mainnet", " ARC "]) {
    const v = verdict({ mainnet: [d(name, 26)], testnet: TESTNET_OK });
    check(`⭐ "${name}" IS recognised as Arc`, v.outcome === "ARC_PRESENT", v.outcome);
  }
});

section("── 6. BOTH DIRECTIONS: the control is checked even when Arc IS there ", () => {
  // ⭐ If the control failed AND Arc appeared on mainnet, the honest answer is still INCONCLUSIVE:
  // an instrument that cannot see Arc where it certainly is cannot be trusted where it might be.
  const v = verdict({ mainnet: [...MAINNET_TODAY, d("ARC", 26)], testnet: MAINNET_TODAY });
  check("⭐⭐ a failed control outranks a positive finding", v.outcome === "INCONCLUSIVE", v.outcome);
  check("…so a broken instrument cannot manufacture good news", v.outcome !== "ARC_PRESENT");
});

section("── 7. 🚨 AN UNREADABLE RESPONSE IS AN ERROR, NOT 'NO CHAINS' ───────", () => {
  // ⭐⭐ THIS SECTION EXISTS BECAUSE THE SUITE WAS VACUOUS WITHOUT IT. This guard was inline in the
  // fetch helper, so a mutation returning `d || []` passed 25/0 — nothing could reach it. An empty
  // list would make Arc absent from every chain: the EXPECTED answer, for entirely the wrong reason.
  for (const [label, bad] of [["empty domains[]", { domains: [] }], ["missing domains", {}],
       ["domains is not an array", { domains: "nope" }], ["null body", null], ["undefined", undefined]]) {
    let threw = false;
    try { parseDomains(bad); } catch { threw = true; }
    check(`🚨 ${label} THROWS rather than returning []`, threw);
  }
  // ⚠️ Both directions: a real payload must still parse, or the guard would just break the watch.
  check("⭐ a populated response parses normally", () => parseDomains({ domains: MAINNET_TODAY }).length === 12);
});

const asection = async (t, fn) => { console.log(`\n${t}`); try { await fn(); }
  catch (e) { fail++; console.log(`  ❌ 🚨 SECTION CRASHED — ${String(e?.message ?? e).slice(0, 80)}`); } };

const okRes = (list) => ({ ok: true, status: 200, json: async () => ({ domains: list }) });
const badRes = (status) => ({ ok: false, status, json: async () => ({}) });

/**
 * ⭐⭐ DRIVES THE REAL `handler()` — network and webhook stubbed, nothing else. The verdict tests
 * above are pure-function tests and structurally CANNOT see the alerting rule, which is where the
 * whole "silence is ambiguous" defect lived. [[binding-tested-across-what-it-binds]]
 */
async function runTick({ mainnet, testnet, testnetStatus = null, webhookOk = true, webhook = "https://example.invalid/hook" }) {
  const realFetch = globalThis.fetch, realEnv = process.env.DD_WATCH_WEBHOOK;
  const posted = [];
  if (webhook === null) delete process.env.DD_WATCH_WEBHOOK;
  else process.env.DD_WATCH_WEBHOOK = webhook;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("gateway-api-testnet")) return testnetStatus ? badRes(testnetStatus) : okRes(testnet);
    if (u.includes("gateway-api.circle.com")) return okRes(mainnet);
    posted.push(JSON.parse(init.body).content);
    return { ok: webhookOk, status: webhookOk ? 204 : 500 };
  };
  try {
    const out = await handler();
    return { out, body: JSON.parse(out.body), posted };
  } finally {
    globalThis.fetch = realFetch;
    if (realEnv === undefined) delete process.env.DD_WATCH_WEBHOOK;
    else process.env.DD_WATCH_WEBHOOK = realEnv;
  }
}

await asection("── 8. ⭐⭐ EVERY TICK PUSHES — silence must mean 'DID NOT RUN' ──────", async () => {
  // 🚨 Under the OLD rule this posted NOTHING on six days in seven, so a healthy tick and a dead
  // cron were indistinguishable for up to a week on a DAILY schedule.
  const { out, body, posted } = await runTick({ mainnet: MAINNET_TODAY, testnet: TESTNET_OK });
  check("outcome is ARC_ABSENT — the healthy, expected case", body.outcome === "ARC_ABSENT", body.outcome);
  check("⭐⭐ …and it STILL POSTS — the beat is the cron's own period", posted.length === 1, `${posted.length} post(s)`);
  check("⭐ the verdict is still 'not news' — delivery and newsiness stay separate", body.alert === false);
  check("the record says a beat happened", body.heartbeat === true && body.delivered === true);
  check("⭐ the weekday rule is GONE, not merely widened", !("mondayLiveness" in body));
  check("HTTP 200 on a healthy delivered beat", out.statusCode === 200, String(out.statusCode));
  const c = posted[0];
  // 🚨 ANCHOR ON THE ROW LABELS, NOT THE BARE WORD. A first version compared indexOf("control")
  // against indexOf("subject") and was VACUOUS: "control" already appears earlier in the reason
  // text ("control passed (Arc on testnet)"), so it matched the HEAD and the check passed even with
  // the rows swapped. Found by mutation, not by reading. [[assert-on-rendered-output-not-source-regex]]
  const iC = c.indexOf("control  testnet"), iS = c.indexOf("subject  mainnet");
  check("⭐⭐ the CONTROL row is rendered BEFORE the subject row", iC !== -1 && iS !== -1 && iC < iS,
    `control@${iC} subject@${iS}`);
  check("…control reports 13 domains WITH Arc", /control.*13 domains.*ARC PRESENT/s.test(c));
  check("…subject reports 12 domains WITHOUT Arc", /subject.*12 domains.*Arc absent/s.test(c));
  check("⭐ the line says what its own absence would mean", /did not run/i.test(c));
});

await asection("── 9. 🚨 BREAK THE CONTROL — validated by FAILING, not only passing", async () => {
  // The literal shape the cloud version hit. The control must outrank everything.
  const { out, body, posted } = await runTick({ mainnet: MAINNET_TODAY, testnet: MAINNET_TODAY });
  check("🚨 outcome is INCONCLUSIVE, NOT ARC_ABSENT", body.outcome === "INCONCLUSIVE", body.outcome);
  check("⭐⭐ …and it is HEARD — a broken check is not a passing check", posted.length === 1);
  check("…the post says the check did not run", /THE CHECK DID NOT RUN/.test(posted[0]));
  check("🚨 HTTP 500 — red in the platform's own view", out.statusCode === 500, String(out.statusCode));
  check("⭐ the control row shows Arc MISSING where it certainly should be", /control.*Arc absent/s.test(posted[0]));

  // ⚠️ And the other way the control can fail: it does not answer at all.
  const un = await runTick({ mainnet: MAINNET_TODAY, testnet: TESTNET_OK, testnetStatus: 403 });
  check("🚨 an unreachable control is INCONCLUSIVE too", un.body.outcome === "INCONCLUSIVE", un.body.outcome);
  check("…the underlying 403 is carried, not swallowed", /403/.test(un.body.reason));
  check("⭐ both readings render as UNREAD rather than as zero domains", (un.posted[0].match(/UNREAD/g) || []).length === 2);
  check("🚨 …and it never reports 'Arc absent' from a call that failed", !/Arc absent/.test(un.posted[0]));

  // ⭐ Both directions: a failed control outranks even a POSITIVE finding, through the handler.
  const both = await runTick({ mainnet: [...MAINNET_TODAY, d("ARC", 26)], testnet: MAINNET_TODAY });
  check("⭐⭐ a broken instrument cannot manufacture good news, end to end", both.body.outcome === "INCONCLUSIVE", both.body.outcome);
});

await asection("── 10. ⚠️ AN UNDELIVERED BEAT IS RED — delivery is load-bearing ─────", async () => {
  // If a running watch is not reliably heard, silence stops meaning "did not run" and the whole
  // change is undone. So a channel that rejects must not return 200.
  const rej = await runTick({ mainnet: MAINNET_TODAY, testnet: TESTNET_OK, webhookOk: false });
  check("verdict is healthy ARC_ABSENT", rej.body.outcome === "ARC_ABSENT", rej.body.outcome);
  check("🚨 …but the tick is 500 because the beat did not land", rej.out.statusCode === 500, String(rej.out.statusCode));
  check("…and the record says so plainly", rej.body.delivered === false && /rejected/i.test(rej.body.notify.reason || ""));

  // ⚠️ No channel configured at all — the monitor cannot alert, which is its own finding.
  const none = await runTick({ mainnet: MAINNET_TODAY, testnet: TESTNET_OK, webhook: null });
  check("🚨 an UNSET channel is 500, never a quiet 200", none.out.statusCode === 500, String(none.out.statusCode));
  check("…and names the reason", /no webhook configured/i.test(none.body.notify.reason || ""), none.body.notify.reason);
  check("⭐ nothing was posted, because there was nowhere to post", none.posted.length === 0);
});

console.log("\n════════════════════════════════════════════════════════════════════════");
console.log(`${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log("⭐ Absence is only reportable when the instrument has proven it can see presence.\n");
