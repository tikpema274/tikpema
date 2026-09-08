// arc-phase-watch.mjs — has Arc's mainnet shipped?
//
// ═══ 🚨 WHY THIS EXISTS ALONGSIDE arc-gateway-watch ═══════════════════════════════════════════
// arc-gateway-watch asks "does Arc have a Circle Gateway domain?" and that reading was accurate —
// 12 domains, Arc absent — but it CANNOT SAY WHAT IS BLOCKING. Arc has no domain because ARC HAS NO
// MAINNET: its own deployment-phases table lists Private Mainnet and Public Mainnet as *Upcoming*.
//
// ⛔ GATEWAY DOMAIN PRESENCE IS DOWNSTREAM OF MAINNET LAUNCH. A watcher on the downstream signal
// fires late — or misleadingly, if a domain appears at private-mainnet time we cannot access. This
// watches the UPSTREAM signal: the phase table itself. [[refuted-by-what-you-read-not-what-you-failed-to-find]]
//
// ⚠️ BOTH ARE KEPT. They answer different questions and both still matter: this one says "can we
// deploy at all", the Gateway one says "will the unified balance and x402 work when we do".
//
// ═══ ⛔ A PARSE FAILURE IS NOT "NO CHANGE" ════════════════════════════════════════════════════
// This scrapes a docs page. If the table format moves, a naive parser returns nothing and the tick
// reads exactly like "still Upcoming" — silence standing in for the event we are waiting for, which
// is the one direction that must never happen. So an unparseable page ALERTS, and a phase set that
// no longer contains the rows we know about ALERTS.

const SOURCE = "https://docs.arc.io/arc/concepts/deployment-model.md";
const WEBHOOK_VAR = "DD_WATCH_WEBHOOK";
const TIMEOUT_MS = 20_000;

/** ⭐ THE BASELINE, RECORDED 2026-09-08 FROM THE LIVE PAGE. Change is only detectable against a
 *  written-down prior — "it looks different" is not an observation without one. */
export const BASELINE = Object.freeze({
  Devnet: "Internal",
  "Private Testnet": "Complete",
  "Public Testnet": "Live",
  "Private Mainnet": "Upcoming",
  "Public Mainnet": "Upcoming",
});

/** Parse the pipe table. Returns { phase: status }. PURE — the tests never touch the network. */
export function parsePhases(md) {
  const out = {};
  for (const line of String(md ?? "").split("\n")) {
    // | **Public Mainnet**  | Upcoming | Full public mainnet with open access...
    const m = line.match(/^\|\s*\*\*([^*]+)\*\*\s*\|\s*([^|]+?)\s*\|/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

/**
 * ⛔ THE VERDICT IS THE PART THAT MUST NOT FAIL QUIET. Four outcomes, and three of them alert.
 */
export function verdict({ phases, error }) {
  if (error) return { level: "error", changed: null, headline: `⛔ COULD NOT READ the Arc deployment-phases page — ${error}. This is UNKNOWN, not "no change".` };
  const found = Object.keys(phases ?? {});
  if (!found.length) return { level: "error", changed: null, headline: "⛔ PARSED ZERO PHASES — the page format has changed. Silence here would read as 'still Upcoming', which is the one direction that must never happen." };

  const missing = Object.keys(BASELINE).filter((k) => !(k in phases));
  if (missing.length) return { level: "error", changed: null, headline: `⛔ PHASE ROWS DISAPPEARED (${missing.join(", ")}) — the table was restructured. Re-read it by hand before trusting this watcher again.` };

  const diffs = Object.entries(BASELINE).filter(([k, v]) => phases[k] !== v).map(([k, v]) => `${k}: ${v} → ${phases[k]}`);
  const mainnetLive = ["Private Mainnet", "Public Mainnet"].some((k) => /live/i.test(phases[k] ?? ""));

  if (mainnetLive) return { level: "event", changed: diffs, headline: `🚨🚨 ARC MAINNET IS LIVE — ${diffs.join(" · ")}. The mainnet move is unblocked at the CHAIN layer; check the Gateway domain next (arc-gateway-watch) before promising unified balance or x402.` };
  if (diffs.length) return { level: "change", changed: diffs, headline: `⚠️ THE PHASE TABLE MOVED — ${diffs.join(" · ")}. Not necessarily mainnet, but the baseline is stale; re-read and update BASELINE.` };
  return { level: "steady", changed: [], headline: "Arc mainnet still Upcoming — Private and Public Mainnet unchanged." };
}

async function push(text) {
  const url = process.env[WEBHOOK_VAR];
  // ⛔ A MONITOR THAT CANNOT ALERT IS NOT A MONITOR. Say so loudly rather than returning quietly.
  if (!url) { console.error(`[arc-phase-watch] ⛔ ${WEBHOOK_VAR} is unset — this alert reached NOBODY.`); return { sent: false, reason: "no webhook configured" }; }
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text.slice(0, 1900) }), signal: AbortSignal.timeout(TIMEOUT_MS) });
    return r.ok ? { sent: true } : { sent: false, reason: `webhook rejected (HTTP ${r.status})` };
  } catch (e) { return { sent: false, reason: String(e?.message ?? e) }; }
}

export const handler = async () => {
  const at = new Date().toISOString();
  let phases = null, error = null;
  try {
    const r = await fetch(SOURCE, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    phases = parsePhases(await r.text());
  } catch (e) { error = String(e?.message ?? e); }

  const v = verdict({ phases, error });
  // ⚠️ SILENT ON THE EXPECTED OUTCOME, except Mondays — so a quiet week cannot be mistaken for a
  // dead schedule. Same rule as arc-gateway-watch, for the same reason.
  const monday = new Date(at).getUTCDay() === 1;
  const speak = v.level !== "steady" || monday;
  const notify = speak
    ? { attempted: true, ...(await push(`**Arc phase watch** · ${at}\n${v.headline}${v.level === "steady" ? "\n_(Monday liveness beat — the watcher is alive.)_" : ""}`)) }
    : { attempted: false };

  console.log(`[arc-phase-watch] ${v.level} — ${v.headline}`);
  return { statusCode: 200, headers: { "content-type": "application/json" },
           body: JSON.stringify({ at, level: v.level, changed: v.changed, phases, error, notify }, null, 2) };
};
