// built.mjs — THE HUMAN INDEX. What exists, and what each thing actually is right now.
//
//   GET /built     → this page (text/html, 200)
//
// ═══ ⭐ WHY THIS EXISTS ════════════════════════════════════════════════════════════════════════
// DD, the two x402 sellers, the census, arc-x402-reference and the Hyperliquid scripts all exist
// and NONE of them is findable from this domain unless you already know the URL. The audience is
// one human who followed a link from Discord or GitHub — prose and links, not a machine index.
// ⛔ Deliberately NOT a .well-known or a JSON catalogue. That is a separate decision.
//
// ═══ 🚨 THE HARD CONSTRAINT — EVERY LINE HERE IS A LIVE PUBLIC CLAIM ═══════════════════════════
// Each entry states its ACTUAL STATE, not a feature: "live on Arc testnet", "a script, no
// endpoint", "waiting on a dependency". **If an entry cannot be stated honestly in one line, it
// does not go on the page.**
//
// ⚠️ THE STATES BELOW WERE PROBED, NOT REMEMBERED (2026-08-27, read-only):
//   /api/dd-analyze                → 402 + accepts[], 60000 atomic  (verified by unpaid POST)
//   /.netlify/functions/x402-vanilla-seller → 402, 10000 atomic, eip155:5042002
//   /.netlify/functions/x402-quote          → 402,  1000 atomic, eip155:5042002
//   github.com/tikpema274/arc-x402-reference → public, remote main at v0.2.0
// 🚨 DO NOT EDIT A STATE HERE FROM ANOTHER PAGE'S COPY. This page exists because descriptions
// drift ahead of implementations, and it must not become an instance of the thing it documents.
//
// ⛔ DELIBERATELY OMITTED: dd-watch and strong-read-watch. They are internal monitors with no
// public surface and nothing a reader could visit or verify.
//
// ⚠️ THE RAIL IS NOT NAMED FOR DD, on purpose. Its live 402 declares
// `extra.name: "GatewayWalletBatched"` while /dd and the OpenAPI both say "EIP-3009 on Arc".
// Those disagree; that is DD's copy to fix, not this page's to repeat. Until it is fixed this
// entry says "over x402" and stops there — the one claim that is true either way.

const ENTRIES = [
  {
    title: "DD — on-chain due diligence",
    state: "Live on Arc testnet.",
    body: `POST an address, pay $0.06 USDC over x402, get one signed report with a coverage manifest
           that says exactly what was and was not checked. The manifest is inside the signed payload,
           so it cannot be stripped.`,
    links: [["app.tikpema.xyz/dd", "/dd"], ["OpenAPI", "/openapi.json"], ["identity (ERC-8004 agentId 851891)", "/api/dd-identity"]],
  },
  {
    title: "Vanilla x402 seller",
    state: "Live on Arc testnet, settling real testnet USDC.",
    body: `A minimal EIP-3009 seller — 0.01 USDC per call, <code>receiveWithAuthorization</code>, no
           Gateway and no batching. Built to prove the plain path works end to end.`,
    links: [["POST /api/x402-vanilla-seller", "/api/x402-vanilla-seller"]],
    note: "A call with no payment returns the 402 and the full terms. It costs nothing.",
  },
  {
    title: "x402 quote — Gateway nanopayment",
    state: "Live on Arc testnet, settling real testnet USDC.",
    body: `The same shape over Circle Gateway's batched rail instead: 0.001 USDC per call,
           <code>GatewayWalletBatched</code>.`,
    links: [["POST /api/x402-quote", "/api/x402-quote"]],
    note: "Same — an unpaid call returns the terms.",
  },
  {
    title: "The x402 seller census",
    state: "A finished measurement of Base mainnet. Not a service.",
    body: `Seven days of USDC transfers to every payout address in Circle's discovery index — what
           x402 sellers actually receive. Published with its per-address rows and both directory
           harvests, so every number in it can be re-checked. It has been corrected twice since
           publication and both corrections are in it, including one claim withdrawn as
           unrecoverable.`,
    links: [
      ["the write-up", "https://github.com/tikpema274/tikpema/blob/main/docs/x402-seller-census-2026-08-25.md"],
      ["the evidence", "https://github.com/tikpema274/tikpema/tree/main/scripts/x402-census"],
    ],
  },
  {
    title: "arc-x402-reference",
    state: "A library, not a service. v0.2.0.",
    body: `A standalone vanilla x402 (EIP-3009) buyer and seller for Arc testnet, extracted so it can
           be read without the rest of this repo around it.`,
    links: [["github.com/tikpema274/arc-x402-reference", "https://github.com/tikpema274/arc-x402-reference"]],
  },
  {
    title: "Hyperliquid top-shorts",
    state: "Scripts. No endpoint, nothing published.",
    body: `Reads the largest short positions among the top Hyperliquid accounts, and drafts posts a
           human sends. Facts only — it does not classify strategy, because a basis trade and a
           directional short are indistinguishable in a position object.`,
    links: [["scripts/hl/ in the repo", "https://github.com/tikpema274/tikpema/tree/main/scripts/hl"]],
    note: "There is nothing to visit.",
  },
  {
    title: "Arc on Circle's mainnet Gateway",
    state: "Waiting on a dependency nobody here controls.",
    body: `As of 2026-08-24, Arc has no Gateway domain on Circle's mainnet list — twelve chains are
           listed and Arc is not one of them, so the unified balance has no rail on Arc mainnet. A
           daily job checks and posts a beat to a private channel on every tick, which means silence
           there indicates it did not run.`,
    links: [],
    note: "Nothing to visit. Listed because it gates what can move to mainnet.",
  },
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// ⚠️ `body` and `note` carry intentional inline <code> tags, so they are NOT escaped. They are
// authored constants in this file, never user input — the only reason that is safe.
const squash = (s) => String(s).replace(/\s+/g, " ").trim();

function page() {
  const entries = ENTRIES.map((e) => `
    <section>
      <h2>${esc(e.title)}</h2>
      <p class="state">${esc(e.state)}</p>
      <p>${squash(e.body)}</p>
      ${e.links.length ? `<p class="links">${e.links.map(([t, h]) => `<a href="${esc(h)}">${esc(t)}</a>`).join(" &middot; ")}</p>` : ""}
      ${e.note ? `<p class="note">${squash(e.note)}</p>` : ""}
    </section>`).join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Built — Tikpema</title>
<meta name="description" content="What exists, and what each thing actually is right now.">
<style>
  :root { color-scheme: dark light; }
  body { margin:0; padding:2rem 1.25rem; font:16px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
         background:#0d0d0f; color:#e9e6e1; }
  main { max-width: 46rem; margin: 0 auto; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; }
  .sub { color:#a09a92; margin:.25rem 0 0; }
  h2 { font-size:1rem; margin:2.25rem 0 .25rem; }
  .state { color:#e0b25c; margin:0 0 .5rem; font-size:.95rem; }
  .note { color:#a09a92; font-size:.88rem; margin:.4rem 0 0; }
  .links { margin:.5rem 0 0; font-size:.9rem; }
  a { color:#e0b25c; }
  code { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.9em; }
  section { border-bottom:1px solid #232327; padding-bottom:1.1rem; }
  section:last-of-type { border-bottom:0; }
  footer { color:#7d786f; font-size:.85rem; margin-top:2.5rem; }
</style></head><body><main>
<h1>Built</h1>
<p class="sub">What exists, and what each thing actually is right now. If an entry sounds narrow,
that is the entry being accurate.</p>
${entries}
<footer>Everything above is on Arc testnet or is a document. Nothing here is on mainnet.
Source: <a href="https://github.com/tikpema274/tikpema">github.com/tikpema274/tikpema</a>.</footer>
</main></body></html>`;
}

export default async () =>
  new Response(page(), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
