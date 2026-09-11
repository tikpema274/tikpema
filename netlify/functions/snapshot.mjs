// snapshot.mjs — DATED, ONE-OFF MEASUREMENTS OF THE CIRCLE x402 DISCOVERY CATALOG.
//
//   GET /snapshot/2026-08-27        → the page   (text/html, 200)
//   GET /snapshot/2026-09-11        → the page   (text/html, 200)
//   GET /snapshot/<date>.json       → the data   (application/json, 200)
//   GET /snapshot                   → 302 to the NEWEST, AND the page says it redirected
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
// rendering every page and every JSON from the SAME frozen objects below — a page cannot state a
// number its JSON does not have. A second hand-maintained copy is what would justify /built's refusal.
//
// ═══ 🚨 TWO SNAPSHOTS NOW, AND THE OLD ONE IS NOT EDITED ══════════════════════════════════════
// 2026-09-11 was harvested as a SEPARATE act and ADDED. 2026-08-27's figures are byte-for-byte what
// they were; nothing in it was "brought up to date".
// ⛔ THAT IS THE WHOLE POINT OF A DATED ARTIFACT. Updating the old page in place would destroy the
// only thing a second measurement is good for — the pair. What the old page gains is one banner
// saying a newer one exists, which is additive and cannot change a figure.
// ⚠️ A bare /snapshot redirects to the NEWEST, so that destination moves as snapshots are added.
// It announces which one it served precisely because it moves.
//
// ═══ ⛔ WHAT THESE PAGES DO NOT CLAIM, AND WHY THE ABSENCE IS STATED ═══════════════════════════
// Composition ONLY. Liveness ("does the endpoint answer") and price agreement ("does the live 402
// match the listing") both require calling ~1,000 third-party URLs. THOSE CALLS HAVE NOT BEEN MADE.
// They are a decision — probing a thousand services uninvited is not a step — so the pages report
// them as not-measured rather than leaving a gap a reader fills in.
//
// ⚠️ EVERY FIELD CARRIES ITS OWN STATE: verified | not-measured | not-remeasured | could-not-check,
// with a reason. A blank is not a finding, and "nobody has checked this" is a state worth printing.

const SOURCE = "https://api.circle.com/v2/x402/discovery/resources?limit=100&offset=N";

// ⭐ THE FROZEN OBJECTS. Page and JSON both render from these; neither can state a figure the other
// lacks. Frozen so a later edit cannot quietly diverge one view from the other.
export const SNAPSHOTS = Object.freeze({

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // ⛔ FIRST MEASUREMENT — FROZEN. Do not "correct" these numbers against a later harvest.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  "2026-08-27": Object.freeze({
    capturedAt: "2026-08-27",
    publishedAt: "2026-09-11",
    label: "27 August 2026",
    source: SOURCE,
    scope: "composition-only",
    supersededBy: "2026-09-11",
    previous: null,
    method: Object.freeze({
      fetch: "direct HTTP, limit=100, paginated to a short page",
      siwx: "NOT sent — see the siwxTrap block",
      selfCheck: "testnet rows must be present, or the harvest was filtered",
      provenance: "harvest file circle-index-2026-08-27.harvest.json, a projection of the raw index",
      totalField: "not-checked — this harvester did not look for a per-page `total`, so this " +
        "measurement cannot say whether the index drifted while it was being read. The 2026-09-11 " +
        "harvest looked, and found one.",
    }),
    totals: Object.freeze({
      listings: 1003, acceptsRows: 3808, distinctResourceUrls: 960, distinctHosts: 25, networks: 16,
      distinctPayTo: 111,
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
    concentration: Object.freeze({ top1Pct: 55.5, top5Pct: 81.5 }),
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
  }),

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // SECOND MEASUREMENT — 15 days later. Same method, same projection, ADDED not substituted.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  "2026-09-11": Object.freeze({
    capturedAt: "2026-09-11",
    publishedAt: "2026-09-11",
    label: "11 September 2026",
    source: SOURCE,
    scope: "composition-only",
    supersededBy: null,
    previous: "2026-08-27",
    method: Object.freeze({
      fetch: "direct HTTP, limit=100, paginated to a short page — 12 requests",
      siwx: "NOT sent — see the siwxTrap block",
      selfCheck: "PASSED: Base Sepolia 396 rows and Polygon Amoy 396 rows both present, so the " +
        "harvest was unfiltered. The harvester discards rather than publishes if either is zero.",
      provenance: "harvest file circle-index-2026-09-11.harvest.json, a projection of the raw index",
      // ⭐ THE ONE THING THIS HARVEST KNOWS THAT THE FIRST DID NOT.
      totalField: "CHECKED, and present: every one of the 12 pages reported total=1162, matching " +
        "the 1,162 listings actually collected. So unlike 2026-08-27, this measurement can say the " +
        "index did NOT drift while it was being read.",
    }),
    totals: Object.freeze({
      listings: 1162, acceptsRows: 4215, distinctResourceUrls: 1094, distinctHosts: 48, networks: 16,
      distinctPayTo: 128,
    }),
    // 🚨 THE TRAP AGAIN — BUT ONLY THE MECHANISM WAS RE-VERIFIED, NOT THE CLI DELTA.
    // ⛔ The 1,003 / 838 / 165 figures belong to 2026-08-27 and are NOT restated as today's. Carrying
    // a measured number forward under a new date is how a snapshot stops being a snapshot.
    siwxTrap: Object.freeze({
      state: "mechanism-verified; delta not-remeasured",
      withoutSiwx: 1162,
      withSiwxFalse: null,
      hidden: null,
      deltaMeasuredOn: "2026-08-27",
      deltaThen: Object.freeze({ withoutSiwx: 1003, withSiwxFalse: 838, hidden: 165 }),
      hiddenIncludes: "every testnet row",
      evidenceToday: "792 testnet rows are present in this harvest (Base Sepolia 396, Polygon Amoy " +
        "396), which is what a CLI-filtered read would have removed entirely.",
      detail:
        "`circle services search` silently appends siwx=false. It is not in the CLI's --help; it is " +
        "visible only by reading the CLI's own dist/index.js. The CLI was NOT re-run on this date, so " +
        "the size of the gap today is unknown; only its existence is re-confirmed, by the testnet " +
        "rows above being present at all. Fetch the API directly.",
    }),
    networks: Object.freeze([
      ["eip155:8453", "Base", 1327],
      ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "Solana mainnet", 823],
      ["eip155:137", "Polygon", 555],
      ["eip155:84532", "Base Sepolia", 396], ["eip155:80002", "Polygon Amoy", 396],
      ["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "Solana devnet", 264],
      ["eip155:43114", "Avalanche", 108], ["eip155:42161", "Arbitrum", 69],
      ["eip155:1", "Ethereum", 66], ["eip155:10", "Optimism", 66],
      ["eip155:130", "Unichain", 66], ["eip155:196", "X Layer", 31],
      ["eip155:146", "Sonic", 12], ["eip155:480", "World Chain", 12],
      ["eip155:1329", "Sei", 12], ["eip155:999", "HyperEVM", 12],
    ].map((r) => Object.freeze(r))),
    hostConcentration: Object.freeze([
      ["x402.quicknode.com", 2112], ["api.aisa.one", 394], ["np.orthogonal.com", 293],
      ["x402.api.agentmail.to", 199], ["api.arkm.com", 178],
    ].map((r) => Object.freeze(r))),
    concentration: Object.freeze({ top1Pct: 50.1, top5Pct: 75.3 }),
    arc: Object.freeze({
      state: "verified-absent", rows: 0,
      detail: "No accepts[] entry names an Arc network. Searched the full 4,215-row set, not a " +
        "filtered view. 15 days and 159 listings later, still zero.",
    }),
    notMeasured: Object.freeze([
      Object.freeze({ field: "liveness", state: "not-measured",
        reason: "requires GET against 1,094 third-party URLs across 48 hosts; those calls have not been made" }),
      Object.freeze({ field: "advertisedVsLivePrice", state: "not-measured",
        reason: "same 1,094 calls; a listing's price and its live 402 have not been compared" }),
      Object.freeze({ field: "payoutAddressOwnership", state: "not-measured",
        reason: "14 EVM chains readable in principle; 1,087 of 4,215 rows are Solana and need a different client" }),
      Object.freeze({ field: "upgradeability", state: "not-measured",
        reason: "EIP-1967 has no Solana equivalent — the question differs per ecosystem, it is not one check" }),
      Object.freeze({ field: "serviceQuality", state: "could-not-check",
        reason: "no on-chain or catalog signal distinguishes a service that works from one that does not" }),
      // ⭐ NEW GAP, AND IT ONLY EXISTS BECAUSE THERE ARE NOW TWO SNAPSHOTS.
      Object.freeze({ field: "changeBetweenSnapshots", state: "not-published",
        reason: "the two harvests are diffable and the diff is the interesting artifact, but no diff " +
          "view has been built and no per-listing change set is published here" }),
    ]),
  }),
});

// ⭐ THE NEWEST, DERIVED — not a second constant that can fall out of step with the map.
export const DATES = Object.freeze(Object.keys(SNAPSHOTS).sort());
export const LATEST = DATES[DATES.length - 1];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const n = (x) => Number(x).toLocaleString("en-GB");

function page(S, { redirected }) {
  const D = S.capturedAt;
  const rows = S.networks.map(([caip, name, c]) =>
    `<tr><td>${esc(name)}</td><td class="m">${esc(caip)}</td><td class="r">${n(c)}</td></tr>`).join("");
  const hosts = S.hostConcentration.map(([h, c]) =>
    `<tr><td class="m">${esc(h)}</td><td class="r">${n(c)}</td></tr>`).join("");
  const gaps = S.notMeasured.map((g) =>
    `<tr><td><b>${esc(g.field)}</b></td><td>${esc(g.state)}</td><td>${esc(g.reason)}</td></tr>`).join("");
  const testnetRows = S.networks.filter(([c]) => c === "eip155:84532" || c === "eip155:80002")
    .reduce((s, [, , c]) => s + c, 0);

  // 🚨 THE TRAP BLOCK DIFFERS BY WHAT WAS ACTUALLY RE-MEASURED. A page that reprinted 838 under a
  // date on which the CLI was never run would be stating someone else's measurement as its own.
  const trapBody = S.siwxTrap.withSiwxFalse !== null
    ? `<b>${n(S.siwxTrap.withoutSiwx)} listings direct from the API. ${n(S.siwxTrap.withSiwxFalse)} through the CLI.</b>
The difference is <b>${S.siwxTrap.hidden}</b>, and it includes <b>${esc(S.siwxTrap.hiddenIncludes)}</b>.<br><br>
${esc(S.siwxTrap.detail)}`
    : `<b>${n(S.siwxTrap.withoutSiwx)} listings direct from the API. The CLI was not re-run on this date,
so the size of the gap today is <b>not measured</b>.</b><br><br>
What IS verified today: ${esc(S.siwxTrap.evidenceToday)}<br><br>
When the gap was last measured, on <b>${esc(S.siwxTrap.deltaMeasuredOn)}</b>, it was
${n(S.siwxTrap.deltaThen.withoutSiwx)} direct vs ${n(S.siwxTrap.deltaThen.withSiwxFalse)} through the
CLI — <b>${S.siwxTrap.deltaThen.hidden}</b> hidden, ${esc(S.siwxTrap.hiddenIncludes)}. That figure
belongs to that date and is not restated as today's.<br><br>
${esc(S.siwxTrap.detail)}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Circle Agent Marketplace catalog — snapshot, ${esc(S.label)}</title>
<meta name="description" content="A dated one-off measurement of the Circle x402 Discovery catalog: ${n(S.totals.listings)} listings across ${S.totals.networks} networks, captured ${D}. Composition only. Method included.">
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

${redirected ? `<div class="box"><b>You asked for the latest.</b> You are reading the snapshot of
<b>${D}</b>, which is the newest of ${DATES.length}. A bare <code>/snapshot</code> will never
silently serve a measurement without telling you which one you got — and the URL it sends you to
changes as snapshots are added, which is exactly why it says so.</div>` : ""}

${S.supersededBy ? `<div class="box"><b>⚠️ A NEWER MEASUREMENT EXISTS: <a href="/snapshot/${esc(S.supersededBy)}">${esc(S.supersededBy)}</a>.</b><br>
Everything below is what was measured on <b>${D}</b> and has deliberately <b>not</b> been updated.
Editing this page to match the newer harvest would destroy the only thing two measurements are good
for. If you want the current shape of the catalog, follow the link; if you want to know what changed,
you need both.</div>` : ""}

<h1>Circle Agent Marketplace catalog — snapshot, ${esc(S.label)}</h1>
<p class="sub">A single measurement of the Circle x402 Discovery catalog. Composition only.</p>

<div class="box">
<b>This is a one-off measurement taken on ${D}. It is not maintained.</b><br>
Nothing here has been re-checked since. Prices, endpoints and payout addresses change without
notice. Treat every figure as <i>&ldquo;was true on ${D}&rdquo;</i>, never as <i>&ldquo;is true&rdquo;</i>.
The method is below and the source is a public API — <b>re-run it rather than cite it</b>.
<div class="sub" style="margin-top:8px" id="age"></div>
</div>

<h2>How many x402 sellers are listed, and on which networks</h2>
<table><tr><th>listings</th><th>accepts rows</th><th>distinct URLs</th><th>hosts</th><th>networks</th><th>payout addrs</th></tr>
<tr><td class="r">${n(S.totals.listings)}</td><td class="r">${n(S.totals.acceptsRows)}</td>
<td class="r">${n(S.totals.distinctResourceUrls)}</td><td class="r">${n(S.totals.distinctHosts)}</td>
<td class="r">${S.totals.networks}</td><td class="r">${n(S.totals.distinctPayTo)}</td></tr></table>
<p class="sub">A listing may accept payment on several networks, so accepts rows exceed listings.
${n(S.totals.distinctResourceUrls)} distinct URLs across just ${S.totals.distinctHosts} hosts — this
catalog is more concentrated than its listing count suggests.</p>

<h2>🚨 The <code>siwx=false</code> trap — read this before re-running</h2>
<div class="box">${trapBody}</div>
<p class="sub">This is on the page rather than in a footnote because a count published without it is
not reproducible: a reader who re-runs the obvious way gets a different denominator and no warning
that it changed.</p>

<h2>Which networks the Circle agent registry covers</h2>
<table><tr><th>network</th><th>CAIP-2</th><th>accepts rows</th></tr>${rows}</table>
<p class="sub">14 EVM chains and 2 Solana clusters. Testnet rows total
${n(testnetRows)} — first-class in this catalog, and exactly what the CLI hides.</p>

<h2>Is Arc in the catalog?</h2>
<div class="box"><b>No — ${S.arc.rows} rows.</b> ${esc(S.arc.detail)}</div>

<h2>Where the catalog actually lives</h2>
<table><tr><th>host</th><th>accepts rows</th></tr>${hosts}</table>
<p class="sub">One host carries ${S.concentration.top1Pct}% of all rows; the top five carry ${S.concentration.top5Pct}%.</p>

<h2>What this snapshot does NOT claim</h2>
<table><tr><th>field</th><th>state</th><th>why</th></tr>${gaps}</table>
<p class="sub">Each is listed rather than omitted. A blank would read as &ldquo;fine&rdquo;; these are open.</p>

<h2>Method: how to re-run this yourself</h2>
<p>Fetch <code>${esc(S.source)}</code> directly, <code>limit=100</code>, paginating until a short
page. <b>Do not use the CLI</b> — see the trap above. Then verify the harvest was unfiltered by
checking that Base Sepolia and Polygon Amoy rows are present; if either is zero, the fetch was
filtered and the denominator is wrong.</p>
<p class="sub">Drift while reading: ${esc(S.method.totalField)}</p>
<p>The machine-readable form of everything above:
<a href="/snapshot/${D}.json">/snapshot/${D}.json</a></p>

<h2>All snapshots</h2>
<table><tr><th>date</th><th>listings</th><th>accepts rows</th><th>hosts</th><th>Arc rows</th><th></th></tr>
${DATES.map((d) => {
  const T = SNAPSHOTS[d];
  return `<tr><td>${d === D ? `<b>${esc(d)}</b> (this one)` : `<a href="/snapshot/${esc(d)}">${esc(d)}</a>`}</td>
<td class="r">${n(T.totals.listings)}</td><td class="r">${n(T.totals.acceptsRows)}</td>
<td class="r">${n(T.totals.distinctHosts)}</td><td class="r">${T.arc.rows}</td>
<td><a href="/snapshot/${esc(d)}.json">JSON</a></td></tr>`;
}).join("")}</table>
<p class="sub">Each was harvested separately and none has been edited since. No diff view is published
— the numbers above are side by side, but no per-listing change set has been computed for readers.</p>

<footer>Captured ${D} · published ${S.publishedAt} · composition only ·
<a href="/snapshot/${D}.json">JSON</a> · <a href="/built">what else is built</a></footer>
</main>
<script>
// ⭐ The staleness line is computed AT LOAD, so decay is visible without anyone maintaining it.
(function(){var d=Math.floor((Date.now()-Date.parse("${D}T00:00:00Z"))/864e5);
var e=document.getElementById("age");if(e)e.textContent="As of loading this page, that measurement is "+d+" day"+(d===1?"":"s")+" old.";})();
</script>
</body></html>`;
}

export async function handler(event) {
  const path = (event.path || "").replace(/\/+$/, "");
  const NOSTORE = { "Cache-Control": "no-store" };

  const jm = path.match(/\/snapshot\/(\d{4}-\d{2}-\d{2})\.json$/);
  if (jm) {
    const S = SNAPSHOTS[jm[1]];
    if (!S) return { statusCode: 404, headers: { "Content-Type": "application/json", ...NOSTORE },
      body: JSON.stringify({ error: "no snapshot for that date", available: DATES }, null, 2) };
    return { statusCode: 200, headers: { "Content-Type": "application/json; charset=utf-8", ...NOSTORE },
      body: JSON.stringify(S, null, 2) };
  }

  // ⛔ A bare /snapshot must not silently serve the newest. It redirects, and the destination SAYS
  // it did — a URL that quietly updates is how a reader cites a number they never saw.
  if (/\/snapshot$/.test(path)) {
    return { statusCode: 302, headers: { Location: `/snapshot/${LATEST}?from=latest`, ...NOSTORE }, body: "" };
  }

  const hm = path.match(/\/snapshot\/(\d{4}-\d{2}-\d{2})$/);
  const S = hm && SNAPSHOTS[hm[1]];
  // ⛔ An unknown date is a 404 listing what exists — NOT a silent fall-through to the newest, which
  // would serve one date's numbers under another date's URL.
  if (!S) return { statusCode: 404, headers: { "Content-Type": "text/html; charset=utf-8", ...NOSTORE },
    body: `<!doctype html><meta charset="utf-8"><title>No snapshot for that date</title>
<body style="background:#0f141a;color:#ece6d8;font:16px/1.6 system-ui;padding:40px">
<h1>No snapshot for that date.</h1><p>These exist, and each is a separate measurement:</p>
<ul>${DATES.map((d) => `<li><a style="color:#e0a44c" href="/snapshot/${d}">${d}</a></li>`).join("")}</ul>
<p>You were not redirected to the nearest one — that is how a reader ends up citing a figure from a
date they did not ask for.</p></body>` };

  return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...NOSTORE },
    body: page(S, { redirected: (event.queryStringParameters || {}).from === "latest" }) };
}
