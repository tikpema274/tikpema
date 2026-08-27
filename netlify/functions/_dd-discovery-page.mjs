import { DD_PRICE_HUMAN } from "./_dd-x402.mjs";
import {
  SUPPORTED_CHAINS, DD_RESOURCE_URL, DD_OPENAPI_URL, DD_SAMPLE_ADDRESS,
} from "./_dd-descriptor.mjs";

// _dd-discovery-page — the HUMAN half of the 405.
//
// ═══ ⭐ WHAT THIS IS AND IS NOT ══════════════════════════════════════════════════════════════
// A person who clicks the link gets a page instead of a JSON blob. Every fact on it comes from the
// SAME constants the JSON and the OpenAPI document use, so the page cannot advertise a price, a
// chain or a URL that the endpoint would not honour.
//
// 🚨 IT DOES NOT SOFTEN THE TERMS. The coverage floor and the flat-price reason are the strongest
// honest things this service says, and a "friendly landing page" is exactly where they would get
// trimmed for tone. They are here in full, and the suite asserts they are.
//
// ⚠️ SELF-CONTAINED: no external CSS, fonts, scripts or images. A discovery page that needs a CDN
// is a discovery page that breaks behind a corporate proxy, in an air-gapped test, or the day the
// CDN moves. Nothing here loads over the network.
//
// ⚠️ ESCAPED, NOT INTERPOLATED RAW. These values are ours today, but a descriptor that ever carries
// user or env-derived text must not be able to inject markup into a page we serve.

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * ⭐⭐ THE HEALTH BANNER — WHY A PAGE THAT RENDERS DURING AN OUTAGE MUST SAY SO.
 *
 * The page moved AHEAD of the health gate so it stays reachable during the post-deploy refusal
 * window (measured on prod 2026-08-16). That fix creates its own hazard: **a page that renders
 * unchanged while the service is refusing implies the service is fine.** A reader copies the curl,
 * runs it, gets a 503, and reasonably concludes they got the call wrong — which is worse than the
 * bare 503 they used to get, because the bare 503 at least named what was happening.
 *
 * This page's entire job is "here is how to call it". If calling it RIGHT NOW would fail, that
 * belongs on the page. Omitting it would be disclosure-by-omission on the one surface built
 * specifically to be honest to a stranger who has no other source.
 *
 * ⚠️ IT SITS ABOVE THE CURL, not at the foot of the page. A caveat below the thing it qualifies is
 * a caveat most readers never reach — they copy the command and leave.
 *
 * 🚨 AND IT DOES NOT PROMISE THAT WAITING HELPS UNLESS IT DOES. `selfClearing` distinguishes
 * "the canary has not run for this build yet" (true, resolves by itself) from "a fixture actually
 * regressed" (false, will keep failing until somebody fixes the code). Telling a stranger to retry
 * in a few minutes when the detector is genuinely broken would be a fresh lie, printed on the
 * honesty surface, to make an error message feel friendlier.
 *
 * ⚠️ NO CRON PERIOD IS QUOTED. The schedule lives in netlify.toml, outside anything this module can
 * read, and a hardcoded "10 minutes" here would be a second source of truth that silently goes wrong
 * the day the schedule changes — [duplicate-source-of-truth-is-the-recurring-bug] on a user-facing
 * promise. The page says "minutes, without anyone doing anything", which stays true across a change.
 */
function healthBanner(health) {
  if (!health || health.serving === true) return "";

  const reason = health.reason ? `<code>${esc(health.reason)}</code>` : "<code>unknown</code>";
  const detail = health.detail ? `<p class="sub">${esc(health.detail)}</p>` : "";

  // ⚠️ COULD-NOT-TELL IS ITS OWN BANNER. It must not borrow either the reassuring wording or the
  // alarming one — an unknown rendered as a known is the failure this whole codebase is built around.
  if (health.serving === null) {
    return `<div class="down">
<b>⚠️ We could not determine whether this service is currently answering.</b>
The command below may return <code>503</code> rather than the <code>402</code> challenge. That would
be the service refusing, not a mistake in your call. Reason: ${reason}.
${detail}</div>`;
  }

  if (health.selfClearing) {
    return `<div class="down">
<b>⚠️ This service is REFUSING right now — the command below will return <code>503</code>, not the
<code>402</code> challenge.</b>
Nothing is wrong with your call. The detector publishes a freshness artifact and refuses to answer
without a current one; right now there isn't one. Reason: ${reason}.
<b>This clears by itself, usually within minutes</b>, when the scheduled self-check next runs — you
do not need to do anything except try again.
${detail}</div>`;
  }

  return `<div class="down">
<b>🚨 This service is REFUSING right now — the command below will return <code>503</code>, not the
<code>402</code> challenge.</b>
Nothing is wrong with your call. Reason: ${reason}.
<b>⚠️ This will NOT clear by waiting.</b> The refusal reflects a problem with the service itself
rather than a missing freshness check, so retrying will keep returning <code>503</code> until it is
fixed. The service is deliberately refusing rather than answering from a detector it cannot vouch for.
${detail}</div>`;
}

export function discoveryPage({ method, health = null }) {
  const chain = SUPPORTED_CHAINS[0];
  const curl =
    `curl -sS -X POST ${DD_RESOURCE_URL} \\\n` +
    `  -H 'Content-Type: application/json' \\\n` +
    `  -d '{"address":"${DD_SAMPLE_ADDRESS}","chain":"${chain}"}'`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tikpema DD — on-chain due diligence</title>
<style>
  :root { color-scheme: dark light; }
  body { margin:0; padding:2rem 1.25rem; font:16px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
         background:#0d0d0f; color:#e9e6e1; }
  main { max-width: 46rem; margin: 0 auto; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; }
  h2 { font-size:.78rem; letter-spacing:.08em; text-transform:uppercase; color:#a09a92; margin:2rem 0 .5rem; }
  code, pre { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; }
  pre { background:#17171a; border:1px solid #2a2a2f; border-radius:10px; padding:1rem;
        overflow-x:auto; font-size:.85rem; }
  .sub { color:#a09a92; margin:.25rem 0 0; }
  .warn { border-left:3px solid #d9a441; padding:.6rem 0 .6rem .9rem; margin:1rem 0; background:#1a170f; }
  /* ⚠️ Visually louder than .warn and placed ABOVE the curl: it qualifies a command the reader is
     about to copy, and a caveat under the thing it qualifies is one most readers never reach. */
  .down { border:1px solid #7d4a2e; border-left:4px solid #e0763c; border-radius:8px;
          padding:.85rem 1rem; margin:1.25rem 0; background:#1c120c; }
  .down .sub { margin-top:.5rem; font-size:.85rem; }
  a { color:#e0b25c; }
  table { border-collapse:collapse; width:100%; font-size:.9rem; }
  td { padding:.35rem .6rem .35rem 0; vertical-align:top; border-bottom:1px solid #232327; }
  td:first-child { color:#a09a92; white-space:nowrap; }
</style></head>
<body><main>

<h1>On-chain due diligence, per call</h1>
<p class="sub">You sent a <code>${esc(method)}</code>. This endpoint takes <b>POST</b> — here is how to call it.</p>
${healthBanner(health)}
<h2>Try it — this costs nothing</h2>
<p>A POST without payment returns the <code>402</code> challenge and the full terms.</p>
<pre>${esc(curl)}</pre>

<h2>What you get</h2>
<table>
  <tr><td>Price</td><td><b>${esc(DD_PRICE_HUMAN)}</b> per report, paid over x402 (EIP-3009 on Arc)</td></tr>
  <tr><td>Artifact</td><td>one signed on-chain due-diligence report about the address and chain you name</td></tr>
  <tr><td>Attestation</td><td>ERC-1271, verifiable against the on-chain owner of ERC-8004 agentId 851891</td></tr>
  <tr><td>Chains</td><td><code>${esc(SUPPORTED_CHAINS.join(", "))}</code></td></tr>
</table>

<div class="warn">
<b>⚠️ It is a coverage manifest, not a clean bill.</b> The report states exactly what was and was not
checked, and that manifest is inside the signed payload so it cannot be stripped.
<b>The floor is low, real and predictable:</b> for an address with no contract code, the report can
come back with a single checked item — at the same full price. That is not a degraded case; it is
the deterministic answer for such an address, and the <code>subjectPreview</code> in the 402 tells
you in advance whether you are in it.
</div>

<div class="warn">
<b>Why the price does not scale with coverage.</b> A coverage-scaled price would pay us more for
reporting more coverage — an incentive to overstate what we actually checked, on the one number you
cannot independently audit before you buy. A flat price removes that incentive entirely.
</div>

<h2>Machine-readable</h2>
<p>Same endpoint returns JSON to any client that does not ask for HTML.
<a href="${esc(DD_OPENAPI_URL)}">OpenAPI description</a>.</p>

<!-- ⭐ THE ENTRY POINT, NOT A DECORATION. /built is a live route; src/App.tsx:85 records what
     happens to a live route nothing links to (#/dca: reachable only by typing the hash, for
     22 days). This link and the Dashboard card ship WITH the page, not after it. -->
<h2>Elsewhere</h2>
<p>DD is one of several things built here. <a href="/built">What else exists</a> — each with what
it actually is right now, which is not always much.</p>

</main></body></html>`;
}
