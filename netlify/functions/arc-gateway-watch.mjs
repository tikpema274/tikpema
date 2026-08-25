// arc-gateway-watch.mjs — HAS ARC APPEARED ON CIRCLE'S MAINNET GATEWAY DOMAIN LIST?
//
// ═══ 🚨 WHY THIS EXISTS ═════════════════════════════════════════════════════════════════════════
// Measured 2026-08-24: Arc has NO Gateway domain on mainnet. Twelve domains are listed (Ethereum,
// Avalanche, Optimism, Arbitrum, Solana, Base, Polygon, Unichain, Sonic, Worldchain, Sei, HyperEVM)
// and Arc is not among them. Without a domain, burn intents and mints have nothing to address, so
// on Arc mainnet the unified balance does not work and `payX402` — which signs against
// GATEWAY.WALLET and requires extra.name === "GatewayWalletBatched" — has no rail.
//
// This is a DEPENDENCY, not a defect: nothing in this repo can fix it. What this function does is
// notice the day it changes, ahead of the 16 Sep date it matters for.
//
// ⚠️ AN EARLIER ATTEMPT WAS A CLOUD SCHEDULED AGENT AND IT COULD NOT RUN. Its sandbox egress proxy
// returns 403 for both Circle hosts — confirmed across three fresh sandboxes and two transports
// (curl and WebFetch). A Netlify function has unrestricted egress, and this is also where the other
// monitors already live.
//
// ═══ ⭐⭐ STATELESS ON PURPOSE — NO BLOBS ═══════════════════════════════════════════════════════
// The obvious design remembers the last verdict so it can alert "on change". That would put this
// monitor on Netlify Blobs, and Blobs is precisely where this repo's monitors have failed: a
// connect-context bug took budget-sweep down for five ticks, and a memoised store handle wedges a
// warm container forever. A monitor whose own storage can break is a monitor that goes quiet
// exactly when something is wrong.
//
// ═══ 🚨 EVERY TICK PUSHES — REVISED 2026-08-25, AND THIS IS THE WHOLE POINT ════════════════════
// The first version pushed only on ARC_PRESENT, on INCONCLUSIVE, and on MONDAYS. On the other six
// days a healthy tick left nothing but a log line, so silence had THREE causes that could not be
// told apart:
//     (a) ran, nothing changed — the intended, healthy case
//     (b) the cron never fired
//     (c) the function threw before it could report
// A weekly beat bounds that ambiguity at seven days on a schedule that runs DAILY, which is six
// days of a dead watch reading exactly like a quiet one. That is the failure this file was written
// to avoid, committed by the file itself.
//
// ⭐ SO THE RULE IS NOW: **the beat is the cron's own period.** Every tick posts, whatever the
// verdict. `verdict().alert` still means "this is NEWS" and is unchanged — delivery and newsiness
// are different questions, and conflating them is what produced the gap.
//     ARC PRESENT   -> 🚨 the event the watch exists for
//     INCONCLUSIVE  -> ⚠️ a broken check is not a passing check
//     ARC ABSENT    -> ✅ the daily beat, carrying BOTH readings
// **No line for more than ~24h now means the watch did not run.** That is a falsifiable claim; the
// old design had none. Still derived from the clock, not from stored state.
//
// ⭐⭐ AND THE CHANNEL IS THE RECORD. Persisting each tick would mean Blobs — refused above. The
// alert channel already stores what a tick saw, timestamped, OFF-HOST, one line per day, in a
// place this function cannot break. Absence of a record is therefore distinguishable from absence
// of change without the monitor owning any storage. [[observation-that-does-not-survive]]
//
// ⚠️ WHICH MAKES DELIVERY LEAD-BEARING, so an undelivered beat returns 500. Silence only means
// "did not run" if a running watch is reliably heard; a channel that is quietly rejecting posts
// would restore the exact ambiguity this change removes. [[absence-must-never-read-as-safe]]
//
// ═══ ⭐ THE POSITIVE CONTROL IS NOT DECORATION ═════════════════════════════════════════════════
// "Arc is absent from the mainnet list" is worthless unless the same instrument demonstrably CAN
// report Arc. It appears on TESTNET as chain "ARC", domain 26. If the testnet call does not show
// it, the mainnet call's silence proves nothing and the verdict is INCONCLUSIVE — never "unchanged".
// [[filtered-read-is-not-absence]]

const MAINNET = "https://gateway-api.circle.com/v1/info";
const TESTNET = "https://gateway-api-testnet.circle.com/v1/info";
const WEBHOOK_VAR = "DD_WATCH_WEBHOOK";
const TIMEOUT_MS = 20_000;

const isArc = (chain) => /^arc\b/i.test(String(chain ?? "").trim());

/** ⚠️ An empty or missing array is NOT "no chains are supported". It is an UNREADABLE ANSWER, and
 *  treating it as data is how an outage becomes a clean-looking verdict — a zero-length list would
 *  make Arc "absent" from every chain, which is the expected answer for entirely the wrong reason.
 *
 *  ⭐ EXPORTED because it was previously inline and therefore untestable: a mutation that returned
 *  `d || []` passed the suite 25/0, since nothing could reach it. A guard no test can execute is
 *  not a guard. */
export function parseDomains(json) {
  const d = json?.domains;
  if (!Array.isArray(d) || d.length === 0) throw new Error("no domains[] in response");
  return d;
}

async function domains(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return parseDomains(await r.json());
}

// 🚨 NO FALLBACK CHANNEL — DO NOT ADD ONE. strong-read-watch records what a "so it works without a
// new secret" fallback did: prod silently pushed money-path alerts into the in-app feedback channel
// with nobody deciding it. An unset variable means nothing is pushed, so the absence is logged
// loudly instead. Awaited, because a scheduled function can be frozen at return.
async function push(content) {
  const url = process.env[WEBHOOK_VAR];
  if (!url) {
    console.error("[arc-gateway-watch][NO-ALERT-CHANNEL] " + JSON.stringify({
      note: `${WEBHOOK_VAR} is unset — this alert reached NOBODY. A monitor that cannot alert is ` +
            `not a monitor; treat this as the finding plus a second one.`,
      wouldHaveSent: content.slice(0, 180),
    }));
    return { sent: false, reason: "no webhook configured" };
  }
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return r.ok ? { sent: true } : { sent: false, reason: `webhook rejected (HTTP ${r.status})` };
  } catch (e) {
    return { sent: false, reason: String(e?.message ?? e).slice(0, 90) };
  }
}

/** Pure verdict, exported so a suite can drive every branch without a network. */
export function verdict({ mainnet, testnet, error }) {
  if (error) return { outcome: "INCONCLUSIVE", reason: error, alert: true };
  const controlOk = testnet.some((d) => isArc(d.chain));
  if (!controlOk) {
    return {
      outcome: "INCONCLUSIVE",
      reason: "the positive control FAILED — Arc is not on the TESTNET list either, so the mainnet " +
              "list's silence proves nothing about Arc",
      alert: true,
    };
  }
  const arc = mainnet.find((d) => isArc(d.chain));
  if (arc) {
    return {
      outcome: "ARC_PRESENT", alert: true, arc,
      reason: `Arc is on the MAINNET Gateway list — domain ${arc.domain}, wallet ${arc.walletContract?.address ?? "?"}`,
    };
  }
  return {
    outcome: "ARC_ABSENT", alert: false,
    reason: `Arc absent from ${mainnet.length} mainnet domains; control passed (Arc on testnet)`,
  };
}

/** The Arc row from a domain list, or null. Shared by the verdict and the readings so a future
 *  change to Arc-matching cannot make the alert body disagree with the outcome. */
const findArc = (list) => list.find((x) => isArc(x.chain)) ?? null;

/**
 * ⭐ EXPORTED SO THE SUITE ASSERTS ON THE RENDERED LINE, not on a source regex — a copy guard that
 * greps source has the blind spot it was built to close. [[assert-on-rendered-output-not-source-regex]]
 *
 * ⭐⭐ THE CONTROL IS PRINTED FIRST, ALWAYS. The control is what licenses the subject's silence: a
 * reader shown "mainnet: Arc absent" first has already drawn the conclusion by the time they reach
 * the calibration that decides whether it means anything.
 */
export function alertBody({ v, readings, at }) {
  const row = (label, r) =>
    `\`${label}\` ` +
    (r
      ? `${r.domains} domains — ${r.arc ? `**ARC PRESENT** (domain ${r.arc.domain})` : "Arc absent"}`
      : "**UNREAD** — the call returned no usable list");
  const lines = [
    row("control  testnet", readings?.control),
    row("subject  mainnet", readings?.subject),
  ].join("\n");

  const head =
    v.outcome === "ARC_PRESENT"
      ? `🚨 **[arc-gateway-watch]** ARC IS NOW ON CIRCLE'S MAINNET GATEWAY LIST\n` +
        `${v.reason}\n` +
        `⭐ The unified balance and the \`GatewayWalletBatched\` rail become possible on Arc mainnet.\n` +
        `⚠️ \`netlify/functions/_gateway.mjs\` hardcodes \`API_BASE\` to the **testnet** endpoint and needs updating.`
      : v.outcome === "INCONCLUSIVE"
      ? `⚠️ **[arc-gateway-watch]** THE CHECK DID NOT RUN — this is not "unchanged"\n${v.reason}`
      : `✅ **[arc-gateway-watch]** daily tick — ${v.reason}\n` +
        `(Every tick posts. **No line for more than a day means the watch did not run** — that is the point.)`;

  return `${head}\n${lines}\n_${at}_`;
}

export const handler = async () => {
  const startedAt = new Date().toISOString();
  let v, readings = null;
  try {
    // ⭐ Both fetched. The control is not skipped when the main call succeeds — that is exactly when
    // an uncalibrated "absent" is most persuasive.
    const [mainnet, testnet] = await Promise.all([domains(MAINNET), domains(TESTNET)]);
    // ⚠️ Recorded from the SAME lists the verdict is computed from, in the same tick — a second
    // fetch could disagree with the verdict it is supposed to evidence.
    readings = {
      control: { endpoint: TESTNET, domains: testnet.length, arc: findArc(testnet) },
      subject: { endpoint: MAINNET, domains: mainnet.length, arc: findArc(mainnet) },
    };
    v = verdict({ mainnet, testnet });
  } catch (e) {
    v = verdict({ error: `endpoint unreachable or unreadable: ${String(e?.message ?? e).slice(0, 110)}` });
  }

  // ⭐⭐ NO CONDITION. Every tick posts — see the header. Awaited, because a scheduled function can
  // be frozen at return.
  const notify = { attempted: true, ...(await push(alertBody({ v, readings, at: startedAt }))) };

  const record = { at: startedAt, outcome: v.outcome, reason: v.reason, alert: v.alert,
                   heartbeat: true, delivered: notify.sent === true, readings,
                   arc: v.arc ?? null, notify };

  // ⚠️ 500 when the CHECK could not run (INCONCLUSIVE) — unchanged — OR when the BEAT WAS NOT
  // DELIVERED. The second is new: this design makes an undelivered beat indistinguishable from a
  // dead cron, so a channel that is not working has to be red somewhere rather than silently
  // returning the watch to the ambiguity it just escaped.
  const code = v.outcome === "INCONCLUSIVE" || !record.delivered ? 500 : 200;
  (code === 500 ? console.error : console.log)("[arc-gateway-watch] " + JSON.stringify(record));
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(record) };
};
