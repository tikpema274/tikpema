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
// Instead the alerting rule needs no memory at all:
//     ARC PRESENT            -> push. This is the event the watch exists for.
//     CHECK COULD NOT RUN    -> push. A broken check is not a passing check.
//     ARC ABSENT, control ok -> silent... EXCEPT on Mondays (see below).
//
// 🚨 AND THE MONDAY RULE EXISTS BECAUSE SILENCE IS AMBIGUOUS. "Running and finding nothing" and
// "not running at all" look identical from outside — that is the failure that let five dead
// budget-sweep ticks pass unnoticed. So once a week the watch says so out loud, which bounds how
// long silence can mean nothing. Derived from the clock, not from stored state.
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

export const handler = async () => {
  const startedAt = new Date().toISOString();
  let v;
  try {
    // ⭐ Both fetched. The control is not skipped when the main call succeeds — that is exactly when
    // an uncalibrated "absent" is most persuasive.
    const [mainnet, testnet] = await Promise.all([domains(MAINNET), domains(TESTNET)]);
    v = verdict({ mainnet, testnet });
  } catch (e) {
    v = verdict({ error: `endpoint unreachable or unreadable: ${String(e?.message ?? e).slice(0, 110)}` });
  }

  // The weekly liveness push. Monday, so a quiet watch cannot be quiet for more than 7 days.
  const monday = new Date().getUTCDay() === 1;
  const shouldAlert = v.alert || (v.outcome === "ARC_ABSENT" && monday);

  let notify = { attempted: false };
  if (shouldAlert) {
    const body =
      v.outcome === "ARC_PRESENT"
        ? `🚨 **[arc-gateway-watch]** ARC IS NOW ON CIRCLE'S MAINNET GATEWAY LIST\n` +
          `${v.reason}\n` +
          `⭐ The unified balance and the \`GatewayWalletBatched\` rail become possible on Arc mainnet.\n` +
          `⚠️ \`netlify/functions/_gateway.mjs\` hardcodes \`API_BASE\` to the **testnet** endpoint and needs updating.`
        : v.outcome === "INCONCLUSIVE"
        ? `⚠️ **[arc-gateway-watch]** THE CHECK DID NOT RUN — this is not "unchanged"\n${v.reason}`
        : `✅ **[arc-gateway-watch]** weekly liveness — ${v.reason}\n` +
          `(Silent the rest of the week by design; this line exists so silence cannot mean "not running".)`;
    notify = { attempted: true, ...(await push(body)) };
  }

  const record = { at: startedAt, outcome: v.outcome, reason: v.reason, alerted: shouldAlert, notify,
                   arc: v.arc ?? null, mondayLiveness: monday };
  // ⚠️ INCONCLUSIVE returns 500 so a failed check is red in the platform's own view, not just in a
  // log line nobody reads. ARC_PRESENT is a success — the watch worked.
  const code = v.outcome === "INCONCLUSIVE" ? 500 : 200;
  (code === 500 ? console.error : console.log)("[arc-gateway-watch] " + JSON.stringify(record));
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(record) };
};
