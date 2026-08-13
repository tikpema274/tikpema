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

export function discoveryPage({ method }) {
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
  a { color:#e0b25c; }
  table { border-collapse:collapse; width:100%; font-size:.9rem; }
  td { padding:.35rem .6rem .35rem 0; vertical-align:top; border-bottom:1px solid #232327; }
  td:first-child { color:#a09a92; white-space:nowrap; }
</style></head>
<body><main>

<h1>On-chain due diligence, per call</h1>
<p class="sub">You sent a <code>${esc(method)}</code>. This endpoint takes <b>POST</b> — here is how to call it.</p>

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

</main></body></html>`;
}
