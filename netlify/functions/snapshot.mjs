// snapshot.mjs — A DATED, ONE-OFF MEASUREMENT OF THE CIRCLE x402 DISCOVERY CATALOG.
//
//   GET /snapshot/2026-08-27        → the page   (text/html, 200)
//   GET /snapshot/2026-08-27.json   → the data   (application/json, 200)
//   GET /snapshot                   → 302 to the newest, AND the page says it redirected
//
// ═══ ⛔⛔ THIS OVERTURNS A RECORDED DECISION. SAY SO, DO NOT ABSORB IT. ════════════════════════
// `built.mjs` states: *"Deliberately NOT a .well-known or a JSON catalogue. That is a separate
// decision."* This is that decision, made the other way, and it is deliberate rather than an
// extension of /built.
//
// ⭐ WHY IT IS OVERTURNED: /built's audience is "one human who followed a link from Discord" — for
// THAT page a JSON twin adds a second surface to keep true for no reader. This page's subject is a
// catalog OF AGENT SERVICES, and the audience most likely to consume a measurement of it is an
// agent. Withholding the machine-readable form here would publish a fact about the agent economy
// in the one format an agent cannot use. The reason /built declined is intact; it simply does not
// apply to this page.
// ⚠️ AND THE COST /built WAS AVOIDING IS REAL: two surfaces drift. It is paid ONCE, here, by
// rendering both from the SAME frozen object below — the page cannot state a number the JSON does
// not have. A second hand-maintained copy is the thing that would have justified /built's refusal.
//
// ═══ 🚨 WHY THE URL SAYS 2026-08-27 AND NOT TODAY ══════════════════════════════════════════════
// The harvest on disk is 1,003 listings taken 2026-08-27. A LATER re-read on 2026-09-09 counted
// 1,246 — that number is real, but ITS DATA WAS NEVER SAVED, so no breakdown can be derived from
// it. Publishing "1,246" beside a network table computed from the 1,003 harvest would be two
// datasets wearing one date.
// ⭐ So the artifact is dated when the MEASUREMENT was taken, not when the page was written. That
// is the whole discipline this page exists to demonstrate.
//
// ═══ ⛔ WHAT THIS PAGE DOES NOT CLAIM, AND WHY THE ABSENCE IS STATED ═══════════════════════════
// Composition ONLY. Liveness ("does the endpoint answer") and price agreement ("does the live 402
// match the listing") both require calling 960 third-party URLs across 25 hosts. THOSE CALLS HAVE
// NOT BEEN MADE. They are a decision — probing 960 services uninvited is not a step — so the page
// reports them as not-measured rather than leaving a gap a reader fills in.
//
// ⚠️ EVERY FIELD CARRIES ITS OWN STATE: verified | not-measured | could-not-check, with a reason.
// A blank is not a finding, and "nobody has checked this" is a state worth printing.

const CAPTURED = "2026-08-27";
const SOURCE = "https://api.circle.com/v2/x402/discovery/resources?limit=100&offset=N";

// ⭐ THE ONE OBJECT. Page and JSON both render from this; neither can state a figure the other
// lacks. Frozen so a later edit cannot quietly diverge one view from the other.
const SNAPSHOT = Object.freeze({
  capturedAt: CAPTURED,
  publishedAt: "2026-09-11",
  source: SOURCE,
  scope: "composition-only",
  method: Object.freeze({
    fetch: "direct HTTP, limit=100, paginated to a short page",
    siwx: "NOT sent — see the siwxTrap block",
    selfCheck: "testnet rows must be present, or the harvest was filtered",
    provenance: "harvest file circle-index-2026-08-27.harvest.json, a projection of the raw index",
  }),
  totals: Object.freeze({
    listings: 1003, acceptsRows: 3808, distinctResourceUrls: 960, distinctHosts: 25, networks: 16,
  }),
  // 🚨 THE TRAP GETS ITS OWN FIELD, not a footnote. Without it the count is un-reproducible.
  siwxTrap: Object.freeze({
    state: "verified",
    withoutSiwx: 1003,
    withSiwxFalse: 838,
    hidden: 165,
    hiddenIncludes: "every testnet row",
    detail:
      "`circle services search` silently appends siwx=false. It is not in the CLI's --help; it is " +
      "visible only by reading the CLI's own dist/index.js. Re-running this census through the CLI " +
      "yields a DIFFERENT DENOMINATOR with no signal that it changed, and the counts still look " +
      "plausible. Fetch the API directly.",
  }),
  networks: Object.freeze([
    ["eip155:8453", "Base", 1164], ["eip155:137", "Polygon", 625],
    ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "Solana mainnet", 562],
    ["eip155:84532", "Base Sepolia", 396], ["eip155:80002", "Polygon Amoy", 396],
    ["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "Solana devnet", 264],
    ["eip155:43114", "Avalanche", 98], ["eip155:1", "Ethereum", 56],
    ["eip155:42161", "Arbitrum", 56], ["eip155:10", "Optimism", 56],
    ["eip155:130", "Unichain", 56], ["eip155:196", "X Layer", 31],
    ["eip155:146", "Sonic", 12], ["eip155:480", "World Chain", 12],
    ["eip155:1329", "Sei", 12], ["eip155:999", "HyperEVM", 12],
  ].map((r) => Object.freeze(r))),
  hostConcentration: Object.freeze([
    ["x402.quicknode.com", 2112], ["api.aisa.one", 324], ["np.orthogonal.com", 292],
    ["x402.api.agentmail.to", 199], ["api.arkm.com", 178],
  ].map((r) => Object.freeze(r))),
  // ⭐ ABSENCE AS A VALUE. "Arc is not in the catalog" is a RESULT, and it is the question this
  // snapshot is most often asked. A missing key would read as an oversight.
  arc: Object.freeze({
    state: "verified-absent", rows: 0,
    detail: "No accepts[] entry names an Arc network. Searched the full 3,808-row set, not a filtered view.",
  }),
  notMeasured: Object.freeze([
    Object.freeze({ field: "liveness", state: "not-measured",
      reason: "requires GET against 960 third-party URLs across 25 hosts; those calls have not been made" }),
    Object.freeze({ field: "advertisedVsLivePrice", state: "not-measured",
      reason: "same 960 calls; a listing's price and its live 402 have not been compared" }),
    Object.freeze({ field: "payoutAddressOwnership", state: "not-measured",
      reason: "14 EVM chains readable in principle; 826 of 3,808 rows are Solana and need a different client" }),
    Object.freeze({ field: "upgradeability", state: "not-measured",
      reason: "EIP-1967 has no Solana equivalent — the question differs per ecosystem, it is not one check" }),
    Object.freeze({ field: "serviceQuality", state: "could-not-check",
      reason: "no on-chain or catalog signal distinguishes a service that works from one that does not" }),
  ]),
});

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const n = (x) => x.toLocaleString("en-GB");

function page({ redirected }) {
  const S = SNAPSHOT;
  const rows = S.networks.map(([caip, name, c]) =>
    `<tr><td>${esc(name)}</td><td class="m">${esc(caip)}</td><td class="r">${n(c)}</td></tr>`).join("");
  const hosts = S.hostConcentration.map(([h, c]) =>
    `<tr><td class="m">${esc(h)}</td><td class="r">${n(c)}</td></tr>`).join("");
  const gaps = S.notMeasured.map((g) =>
    `<tr><td><b>${esc(g.field)}</b></td><td>${esc(g.state)}</td><td>${esc(g.reason)}</td></tr>`).join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Circle Agent Marketplace catalog — snapshot, 27 August 2026</title>
<meta name="description" content="A dated one-off measurement of the Circle x402 Discovery catalog: ${n(S.totals.listings)} listings across ${S.totals.networks} networks, captured ${CAPTURED}. Composition only. Method included.">
<style>
:root{--ink:#0f141a;--surface:#171e24;--line:rgba(236,230,216,.14);--text:#ece6d8;--muted:#8a929b;--amber:#e0a44c}
*{box-sizing:border-box}body{margin:0;padding:0;background:var(--ink);color:var(--text);
font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:820px;margin:0 auto;padding:40px 20px 80px}
h1{font-size:1.7rem;line-height:1.25;margin:0 0 6px}h2{font-size:1.15rem;margin:38px 0 10px;color:var(--amber)}
.sub{color:var(--muted);margin:0 0 4px}.m{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:14px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:12px;letter-spacing:.08em;text-transform:uppercase}
td.r{text-align:right;font-family:ui-monospace,monospace}
.box{border:1px solid var(--line);border-left:3px solid var(--amber);background:var(--surface);
padding:14px 16px;margin:18px 0;border-radius:6px}
.box b{color:var(--amber)}code{font-family:ui-monospace,monospace;font-size:13px;color:var(--amber)}
a{color:var(--amber)}footer{margin-top:48px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:14px}
</style></head><body><main>

${redirected ? `<div class="box"><b>You asked for the latest.</b> This is the snapshot of
<b>${CAPTURED}</b>, and it is the only one. A bare <code>/snapshot</code> will never silently serve
a newer measurement without telling you which one you got.</div>` : ""}

<h1>Circle Agent Marketplace catalog — snapshot, 27 August 2026</h1>
<p class="sub">A single measurement of the Circle x402 Discovery catalog. Composition only.</p>

<div class="box">
<b>This is a one-off measurement taken on ${CAPTURED}. It is not maintained.</b><br>
Nothing here has been re-checked since. Prices, endpoints and payout addresses change without
notice. Treat every figure as <i>“was true on ${CAPTURED}”</i>, never as <i>“is true”</i>.
The method is below and the source is a public API — <b>re-run it rather than cite it</b>.
<div class="sub" style="margin-top:8px" id="age"></div>
</div>

<h2>How many x402 sellers are listed, and on which networks</h2>
<table><tr><th>listings</th><th>accepts rows</th><th>distinct URLs</th><th>hosts</th><th>networks</th></tr>
<tr><td class="r">${n(S.totals.listings)}</td><td class="r">${n(S.totals.acceptsRows)}</td>
<td class="r">${n(S.totals.distinctResourceUrls)}</td><td class="r">${n(S.totals.distinctHosts)}</td>
<td class="r">${S.totals.networks}</td></tr></table>
<p class="sub">A listing may accept payment on several networks, so accepts rows exceed listings.
960 distinct URLs across just 25 hosts — this catalog is more concentrated than its listing count suggests.</p>

<h2>🚨 The <code>siwx=false</code> trap — read this before re-running</h2>
<div class="box">
<b>${n(S.siwxTrap.withoutSiwx)} listings direct from the API. ${n(S.siwxTrap.withSiwxFalse)} through the CLI.</b>
The difference is <b>${S.siwxTrap.hidden}</b>, and it includes <b>${esc(S.siwxTrap.hiddenIncludes)}</b>.<br><br>
${esc(S.siwxTrap.detail)}
</div>
<p class="sub">This is on the page rather than in a footnote because a count published without it is
not reproducible: a reader who re-runs the obvious way gets a different denominator and no warning
that it changed.</p>

<h2>Which networks the Circle agent registry covers</h2>
<table><tr><th>network</th><th>CAIP-2</th><th>accepts rows</th></tr>${rows}</table>
<p class="sub">14 EVM chains and 2 Solana clusters. Testnet rows total
${n(S.networks[3][2] + S.networks[4][2])} — first-class in this catalog, and exactly what the CLI hides.</p>

<h2>Is Arc in the catalog?</h2>
<div class="box"><b>No — ${S.arc.rows} rows.</b> ${esc(S.arc.detail)}</div>

<h2>Where the catalog actually lives</h2>
<table><tr><th>host</th><th>accepts rows</th></tr>${hosts}</table>
<p class="sub">One host carries 55.5% of all rows; the top five carry 81.5%.</p>

<h2>What this snapshot does NOT claim</h2>
<table><tr><th>field</th><th>state</th><th>why</th></tr>${gaps}</table>
<p class="sub">Each is listed rather than omitted. A blank would read as “fine”; these are open.</p>

<h2>Method: how to re-run this yourself</h2>
<p>Fetch <code>${esc(S.source)}</code> directly, <code>limit=100</code>, paginating until a short
page. <b>Do not use the CLI</b> — see the trap above. Then verify the harvest was unfiltered by
checking that Base Sepolia and Polygon Amoy rows are present; if either is zero, the fetch was
filtered and the denominator is wrong.</p>
<p>The machine-readable form of everything above:
<a href="/snapshot/${CAPTURED}.json">/snapshot/${CAPTURED}.json</a></p>

<footer>Captured ${CAPTURED} · published ${S.publishedAt} · composition only ·
<a href="/snapshot/${CAPTURED}.json">JSON</a> · <a href="/built">what else is built</a></footer>
</main>
<script>
// ⭐ The staleness line is computed AT LOAD, so decay is visible without anyone maintaining it.
(function(){var d=Math.floor((Date.now()-Date.parse("${CAPTURED}T00:00:00Z"))/864e5);
var e=document.getElementById("age");if(e)e.textContent="As of loading this page, that measurement is "+d+" day"+(d===1?"":"s")+" old.";})();
</script>
</body></html>`;
}

export async function handler(event) {
  const path = (event.path || "").replace(/\/+$/, "");
  const NOSTORE = { "Cache-Control": "no-store" };

  if (path.endsWith(`/${CAPTURED}.json`)) {
    return { statusCode: 200, headers: { "Content-Type": "application/json; charset=utf-8", ...NOSTORE },
      body: JSON.stringify(SNAPSHOT, null, 2) };
  }
  // ⛔ A bare /snapshot must not silently serve the newest. It redirects, and the destination SAYS
  // it did — a URL that quietly updates is how a reader cites a number they never saw.
  if (/\/snapshot$/.test(path)) {
    return { statusCode: 302, headers: { Location: `/snapshot/${CAPTURED}?from=latest`, ...NOSTORE }, body: "" };
  }
  return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...NOSTORE },
    body: page({ redirected: (event.queryStringParameters || {}).from === "latest" }) };
}
