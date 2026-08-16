// calibrate-money-alert.mjs — FIRE the deposit-blocking escalation on purpose, at zero cost.
//
// ═══ ⭐⭐ WHY THIS EXISTS ═══════════════════════════════════════════════════════════════════════
// The money-channel escalation was the last untested branch on a path that now blocks deposits, and
// it was recorded as "suite-proven only" because firing it LIVE means holding a deliberate 20-minute
// DD outage. ⚠️ THAT ARGUMENT ONLY EVER APPLIED TO THE LIVE ROUTE. A forced invocation against a
// webhook nobody depends on costs nothing: no outage, no deploy, no deposit blocked.
//
// ⭐ AND IT IS THE SAME MOVE THAT CALIBRATED dd-watch ITSELF, which caught two real bugs on its first
// run. "First firing = first sighting, mid-outage" is a choice, not a constraint.
//
// ═══ 🚨 IT SENDS THE REAL BYTES ════════════════════════════════════════════════════════════════
// The message comes from `moneyAlertLines()` in shared/dd-watch/watch.mjs — THE SAME function the
// handler calls. A script that rebuilt the text would rehearse a second copy and prove nothing about
// the one that fires at 3am.
//
// ═══ ⚠️ IT CANNOT PAGE THE REAL CHANNEL BY ACCIDENT ═════════════════════════════════════════════
// `WATCH_ALERT_WEBHOOK` is NEVER read from the environment here. The destination must be passed
// explicitly with `--webhook`, and with no destination at all it runs against a LOCAL capture server
// and prints what would have been sent. A calibration tool that could reach the money channel by
// default is a calibration tool that will, on the day someone runs it half-awake.
//
//   node scripts/dd/calibrate-money-alert.mjs                      # local capture, prints the payload
//   node scripts/dd/calibrate-money-alert.mjs --webhook <url>      # deliver for real
//   node scripts/dd/calibrate-money-alert.mjs --refusing-ms 1200000
//
// Zero money, zero deploy, no production state touched.

import { createServer } from "node:http";
import {
  GRACE_MS, TTL_MS, HEALTH_TTL_MS, MONEY_WEBHOOK_VAR, blocksDeposits, moneyAlertLines,
} from "../../shared/dd-watch/watch.mjs";

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

// ⚠️ DEFAULT IS PAST THE GRACE ON PURPOSE — the whole point is the branch that only fires there.
const refusingMs = Number(argOf("--refusing-ms", String(GRACE_MS + 5 * 60 * 1000)));
const explicitHook = argOf("--webhook", null);

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };

// ═══ 🚨 SAFETY: refuse to fire at the real money channel ═══════════════════════════════════════
// Compared against the env var's VALUE without ever using it as a destination — the check reads it,
// the sender never does.
const realHook = (process.env[MONEY_WEBHOOK_VAR] || "").trim();
if (explicitHook && realHook && explicitHook.trim() === realHook) {
  console.error(`\n🚨 REFUSING: --webhook is the REAL ${MONEY_WEBHOOK_VAR}. This tool exists to rehearse ` +
                `the alert, not to page the channel that carries the kill-switch siren. Use a throwaway.\n`);
  process.exit(2);
}

console.log(`\ncalibrate-money-alert — forcing the deposit-blocking escalation`);
console.log(`  refusingMs ${refusingMs} (${Math.round(refusingMs / 60000)}m) · grace ${GRACE_MS / 60000}m · watch-record TTL ${TTL_MS / 60000}m · HEALTH TTL ${HEALTH_TTL_MS / 60000}m`);
console.log(`  destination: ${explicitHook ? "EXPLICIT webhook (real delivery)" : "local capture server (no external call)"}\n`);

// ── the gate ────────────────────────────────────────────────────────────────────────────────────
const judgement = {
  alert: true,
  alertReason: argOf("--reason", "stale"),
  refusingMs,
  refusingSince: new Date(Date.now() - refusingMs).toISOString(),
  outcomes: { canonical: "503", functionPath: "503" },
};
check("⭐ the forced judgement DOES cross the deposit-blocking threshold",
  blocksDeposits(judgement) === true, `${Math.round(refusingMs / 60000)}m ≥ ${GRACE_MS / 60000}m`);
check("⚠️ …and a judgement inside the grace would NOT (the gate is real, not bypassed)",
  blocksDeposits({ ...judgement, refusingMs: GRACE_MS - 1 }) === false);

// ── the payload, from the SAME builder the handler calls ────────────────────────────────────────
const lines = moneyAlertLines({ judgement, canonical: "https://app.tikpema.xyz/api/dd-analyze" });
const body = JSON.stringify({ content: lines.join("\n") });

console.log("\n── THE EXACT MESSAGE THAT WOULD REACH THE MONEY CHANNEL ──────────────────");
console.log(lines.map((l) => "  │ " + l).join("\n"));
console.log("──────────────────────────────────────────────────────────────────────────\n");

// ⚠️ ASSERTED, because "it looked fine in the terminal" is how a malformed payload ships. These are
// the properties a reader of the MONEY channel needs, not the ones a DD reader needs.
check("🚨 it leads with the consequence, not the component", /^🚨 DEPOSITS BLOCKED/.test(lines[0]));
check("⭐ it explains WHY deposits are affected (that reader is not tracking DD)",
  lines.some((l) => /deposit path REFUSES/.test(l)));
check("⭐ it says this is fail-closed and not data loss", lines.some((l) => /not a data loss/.test(l)));
check("⭐ it names the likeliest cause and the margin",
  lines.some((l) => /dd-canary cron has not fired/.test(l) && /TWO missed ticks/.test(l)));
check("⭐ it carries the elapsed time and the grace it passed",
  lines.some((l) => /refusing \d+m \(past the \d+m grace/.test(l)));
// 🚨🚨 THE BUG THIS RUN FOUND, PINNED. The message quoted `TTL_MS` — the WATCH RECORD's freshness
// (20m) — while calling it the health TTL, which is 30m. It also read as zero margin, since the
// grace is also 20m. An operator mid-outage would have believed deposits were already beyond
// recovery with ten minutes still on the clock.
check("🚨🚨 it quotes the HEALTH artifact TTL, not this module's own record TTL",
  lines.some((l) => new RegExp(`stale at ${HEALTH_TTL_MS / 60000}m`).test(l)),
  `health ${HEALTH_TTL_MS / 60000}m vs watch-record ${TTL_MS / 60000}m`);
check("⚠️ …and the stale point is strictly LATER than the grace, so the sentence implies real margin",
  HEALTH_TTL_MS > GRACE_MS, `${HEALTH_TTL_MS / 60000}m > ${GRACE_MS / 60000}m`);
check("⭐ it carries the canonical URL so a reader can check for themselves",
  lines.some((l) => /canonical: https/.test(l)));
check("⚠️ the payload is valid JSON under Discord's content key", (() => {
  try { const p = JSON.parse(body); return typeof p.content === "string" && p.content.length > 0; }
  catch { return false; }
})());
// 🚨 DISCORD REJECTS >2000 CHARS. A message that is right and undeliverable is a message nobody sees,
// and this is exactly the class of defect a rehearsal exists to catch before an outage does.
check("🚨 …and fits Discord's 2000-character limit", JSON.parse(body).content.length <= 2000,
  `${JSON.parse(body).content.length} chars`);

// ── deliver ─────────────────────────────────────────────────────────────────────────────────────
let target = explicitHook, server = null, captured = null;
if (!target) {
  // ⭐ A LOCAL CAPTURE SERVER, so the DELIVERY PATH runs end-to-end even with no webhook to hand —
  // the fetch, the headers, the status handling. Without this the "no webhook" case would only ever
  // print, and printing is not sending.
  await new Promise((res) => {
    server = createServer((req, r) => {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", () => { captured = { headers: req.headers, body: b }; r.writeHead(204); r.end(); });
    });
    server.listen(0, "127.0.0.1", () => res());
  });
  target = `http://127.0.0.1:${server.address().port}/capture`;
}

let delivered = null, status = null, err = null;
try {
  const res = await fetch(target, {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
    signal: AbortSignal.timeout(15_000),
  });
  delivered = res.ok; status = res.status;
} catch (e) { delivered = false; err = String(e?.name ?? e); }
if (server) server.close();

console.log(`\n── DELIVERY ──────────────────────────────────────────────────────────────`);
console.log(`  target    : ${explicitHook ? explicitHook.replace(/\/[^/]+$/, "/…") : "local capture"}`);
console.log(`  delivered : ${delivered}   status ${status ?? "—"}${err ? `   error ${err}` : ""}`);
check("⭐⭐ the delivery path actually ran and was accepted", delivered === true, `HTTP ${status}`);
if (captured) {
  check("⭐ the receiver got the exact bytes we built",
    JSON.parse(captured.body).content === lines.join("\n"));
  check("⭐ …with the JSON content-type a webhook requires",
    /application\/json/.test(captured.headers["content-type"] || ""));
}

console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
if (!explicitHook) {
  console.log("⚠️ This run used a LOCAL capture. The bytes, the gate and the delivery path are proven;");
  console.log("   what is NOT proven is that the real webhook accepts them — pass --webhook <throwaway>.\n");
} else {
  console.log("⭐ Delivered to a real endpoint: someone has now SEEN this alert before an outage did.\n");
}
process.exit(fail === 0 ? 0 : 1);
