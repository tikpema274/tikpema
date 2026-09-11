// snapshot-diff.mjs — WHAT CHANGED BETWEEN TWO DATED READINGS OF THE CIRCLE x402 CATALOG.
//
//   GET /snapshot/diff/2026-08-27..2026-09-11        → the page   (text/html, 200)
//   GET /snapshot/diff/2026-08-27..2026-09-11.json   → the data   (application/json, 200)
//   GET /snapshot/diff                               → 302 to the newest adjacent pair
//
// ═══ 🚨 THE DENOMINATOR GATE RUNS BEFORE ANYTHING IS COMPUTED, AND IT REFUSES ═════════════════
// A diff between an unfiltered harvest and a `siwx=false` one would show ~165 disappearances, every
// one a testnet row, and it would read as a finding. ⛔ So this page does not render a diff with a
// warning attached — it renders a REFUSAL instead, at HTTP 409, with no counts on it at all. A
// warning on a wrong number is still a wrong number published, and the warning is the skippable part.
// See shared/x402-diff.mjs; the gate re-derives sentinel counts from the ROWS, never from either
// harvest's stored self-check (which the two generations write under different keys anyway).
//
// ═══ ⛔ THE PAGE NEVER SAYS "REMOVED" OR "ADDED" ═══════════════════════════════════════════════
// Neither harvest can bound what it missed. A listing absent from the later reading may be
// withdrawn, renamed, or missed by a paging hiccup, and nothing distinguishes those from outside.
// So the vocabulary is observational throughout — "absent from the 2026-09-11 reading", "present
// only in the later reading" — and `FORBIDDEN_VERBS` is asserted against this rendered output by
// scripts/verify-snapshot-diff.mjs. The constraint is enforced, not merely intended.
//
// ═══ ⛔ AND "UNCHANGED" IS NOT "STABLE" ════════════════════════════════════════════════════════
// Two instants fifteen days apart bound their endpoints and say nothing about the interval. That
// gets its own section near the top of the page, not a footnote — a reader who takes "unchanged"
// as "stable" has been misled by the artifact, not by their own carelessness.
//
// ⭐ THE PAYOUT ROW LEADS. A seller silently repointing where money goes is the highest-value
// comparison available here, and zero is a measurement — the section renders its count either way.

import EARLIER from "../../scripts/x402-census/circle-index-2026-08-27.harvest.json" with { type: "json" };
import LATER from "../../scripts/x402-census/circle-index-2026-09-11.harvest.json" with { type: "json" };
import { diffHarvests, pairId, pairsFor, FORBIDDEN_VERBS } from "../../shared/x402-diff.mjs";

// ⭐ DERIVED, NOT DECLARED. The pair list and every figure below come from the harvests themselves,
// so a third harvest is a two-line change here and nothing to keep in step.
const HARVESTS = Object.freeze({ "2026-08-27": EARLIER, "2026-09-11": LATER });
const DATES = Object.freeze(Object.keys(HARVESTS).sort());
const PAIRS = Object.freeze(pairsFor(DATES));
const NEWEST_PAIR = PAIRS[PAIRS.length - 1];

const LABEL = Object.freeze({ "2026-08-27": "27 August 2026", "2026-09-11": "11 September 2026" });
const NET = Object.freeze({
  "eip155:8453": "Base", "eip155:137": "Polygon", "eip155:84532": "Base Sepolia",
  "eip155:80002": "Polygon Amoy", "eip155:43114": "Avalanche", "eip155:1": "Ethereum",
  "eip155:42161": "Arbitrum", "eip155:10": "Optimism", "eip155:130": "Unichain",
  "eip155:196": "X Layer", "eip155:146": "Sonic", "eip155:480": "World Chain",
  "eip155:1329": "Sei", "eip155:999": "HyperEVM",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana mainnet",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "Solana devnet",
});

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const n = (x) => Number(x).toLocaleString("en-GB");
const netName = (c) => NET[c] ?? c;
// ⭐ Page shows a truncated payout address; the JSON carries it in full. The repo's convention for
// public records, and the JSON is one link away for anyone verifying.
const short = (a) => (a && a.length > 18 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a ?? "—");

function computeFor(pair) {
  const [from, to] = String(pair).split("..");
  if (!HARVESTS[from] || !HARVESTS[to] || from >= to) return null;
  return { from, to, diff: diffHarvests(HARVESTS[from], HARVESTS[to], { labelA: from, labelB: to }) };
}

const CSS = `
:root{--ink:#0f141a;--surface:#171e24;--line:rgba(236,230,216,.14);--text:#ece6d8;--muted:#8a929b;--amber:#e0a44c}
*{box-sizing:border-box}body{margin:0;padding:0;background:var(--ink);color:var(--text);
font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 20px 80px}
h1{font-size:1.7rem;line-height:1.25;margin:0 0 6px}h2{font-size:1.15rem;margin:38px 0 10px;color:var(--amber)}
.sub{color:var(--muted);margin:0 0 4px}.m{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:14px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:12px;letter-spacing:.08em;text-transform:uppercase}
td.r{text-align:right;font-family:ui-monospace,monospace}
.box{border:1px solid var(--line);border-left:3px solid var(--amber);background:var(--surface);
padding:14px 16px;margin:18px 0;border-radius:6px}
.box b{color:var(--amber)}code{font-family:ui-monospace,monospace;font-size:13px;color:var(--amber)}
a{color:var(--amber)}footer{margin-top:48px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:14px}
.big{font-size:2.1rem;font-weight:600;color:var(--amber);line-height:1.1}
.wrap{overflow-x:auto}`;

// ⛔ THE REFUSAL. No counts, no table, no "here is the diff anyway".
function refusalPage({ from, to, diff }) {
  const g = diff.gate;
  const audit = (a) => `<tr><td>${esc(a.label)}</td><td class="r">${n(a.rows)}</td>
    ${Object.keys(a.sentinels).map((c) => `<td class="r">${n(a.observed[c])}</td>`).join("")}
    <td>${a.passed ? "passed" : "<b>FAILED</b>"}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diff refused — a filtered reading has a different denominator</title>
<style>${CSS}</style></head><body><main>
<h1>This diff was refused, and no comparison was computed.</h1>
<p class="sub">${esc(from)} &rarr; ${esc(to)}</p>
<div class="box"><b>At least one of the two readings did not pass the testnet self-check.</b><br>
${esc(g.refusal ?? "")}<br><br>
Circle's CLI silently appends <code>siwx=false</code>, which hides every testnet row. Comparing a
filtered reading against an unfiltered one produces roughly 165 phantom disappearances that look
exactly like a finding — a plausible count, a coherent network breakdown, no error anywhere.
<br><br><b>So this page shows nothing rather than showing it with a warning.</b> A warning on a
wrong number is still a wrong number published, and the warning is the part a reader skips.</div>
<h2>What the gate measured, counted from the rows themselves</h2>
<table><tr><th>reading</th><th>rows</th>${Object.values(g.a.sentinels).map((s) => `<th>${esc(s)}</th>`).join("")}<th>verdict</th></tr>
${audit(g.a)}${audit(g.b)}</table>
<p class="sub">Counted from the rows, not read from either harvest's stored self-check — a stored
flag is a claim, the rows are the evidence.</p>
<footer><a href="/snapshot/${esc(to)}">the ${esc(to)} reading</a> &middot;
<a href="/built">what else is built</a></footer>
</main></body></html>`;
}

function page({ from, to, diff, redirected }) {
  const d = diff;
  const P = d.payTo;
  const rowsFor = (list) => list.map((c) => `<tr>
    <td class="m">${esc(c.resource)}</td>
    <td>${esc(netName(c.network))}</td>
    <td class="m">${c.onlyInEarlier.map((x) => esc(short(x))).join("<br>")}</td>
    <td class="m">${c.onlyInLater.map((x) => esc(short(x))).join("<br>")}</td>
    <td>${esc(c.state)}</td></tr>`).join("");

  const hostsNew = d.presence.hosts.presentOnlyInLater;
  const hostsGone = d.presence.hosts.absentFromLater;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Circle x402 catalog — what differs between ${esc(LABEL[from])} and ${esc(LABEL[to])}</title>
<meta name="description" content="A comparison of two dated readings of the Circle x402 Discovery catalog, ${esc(from)} and ${esc(to)}. ${P.changedCount} offers name a different payout address. Composition only.">
<style>${CSS}</style></head><body><main>

${redirected ? `<div class="box"><b>You asked for the latest comparison.</b> This is
<b>${esc(from)} &rarr; ${esc(to)}</b>, the newest adjacent pair of ${PAIRS.length}. A bare
<code>/snapshot/diff</code> never serves a comparison without naming which one you got.</div>` : ""}

<h1>What differs between the ${esc(LABEL[from])} and ${esc(LABEL[to])} readings</h1>
<p class="sub">Two dated readings of the Circle x402 Discovery catalog, compared. Composition only.</p>

<h2>⭐ Where the money is pointed</h2>
<div class="box">
<div class="big">${n(P.changedCount)}</div>
<b>offers name a different payout address in the later reading</b>, out of ${n(P.comparableOffers)}
offers present in both.<br><br>
${P.changedCount === 0
  ? `That is a measurement, not an empty section: every offer carried by both readings names the
     same payout address in each.`
  : `A seller repointing where its money goes is not announced anywhere, and a buyer paying from a
     cached listing would not notice. ⛔ <b>This says nothing about who controls either address.</b>
     A changed entry is a changed catalog entry; ownership was not checked on any chain, and routine
     key rotation and a takeover look identical from here.`}
</div>
${P.changedCount ? `<div class="wrap"><table>
<tr><th>resource</th><th>network</th><th>payout in ${esc(from)}</th><th>payout in ${esc(to)}</th><th>state</th></tr>
${rowsFor(P.changes)}</table></div>
<p class="sub">Addresses truncated here; the JSON carries them in full.
${esc(P._method)}</p>` : ""}

<h2>⛔ Two instants, not a period — "unchanged" is not "stable"</h2>
<div class="box"><b>${esc(d.interval.text)}</b></div>
<p class="sub">This is stated here rather than in a footnote because every number on this page is
read as a rate of change by default, and none of them is one.</p>

<h2>⛔ What "absent" does and does not mean</h2>
<div class="box">
Neither reading can bound what it did not see. The ${esc(from)} harvest never looked for a
<code>total</code>; the ${esc(to)} harvest did find one and matched it, but a listing absent from a
later reading may have been withdrawn, renamed, or missed by paging — <b>and nothing here
distinguishes those</b>.<br><br>
So every count below says <i>absent from the ${esc(to)} reading</i> or <i>present only in the
${esc(to)} reading</i>. Neither is an event. Nobody observed a change; two readings simply differ.
</div>

<h2>Presence</h2>
<table>
<tr><th></th><th class="r">${esc(from)}</th><th class="r">${esc(to)}</th><th class="r">in both</th>
<th class="r">absent from ${esc(to)}</th><th class="r">only in ${esc(to)}</th></tr>
<tr><td>distinct resource URLs</td><td class="r">${n(d.presence.resources.inEarlier)}</td>
<td class="r">${n(d.presence.resources.inLater)}</td><td class="r">${n(d.presence.resources.inBoth)}</td>
<td class="r">${n(d.presence.resources.absentFromLater)}</td><td class="r">${n(d.presence.resources.presentOnlyInLater)}</td></tr>
<tr><td>distinct payout addresses</td><td class="r">${n(d.presence.payToAddresses.inEarlier)}</td>
<td class="r">${n(d.presence.payToAddresses.inLater)}</td><td class="r">${n(d.presence.payToAddresses.inBoth)}</td>
<td class="r">${n(d.presence.payToAddresses.absentFromLater)}</td><td class="r">${n(d.presence.payToAddresses.presentOnlyInLater)}</td></tr>
<tr><td>hosts</td><td class="r">${n(d.presence.hosts.inEarlier)}</td><td class="r">${n(d.presence.hosts.inLater)}</td>
<td class="r">${n(d.presence.hosts.inEarlier - hostsGone.length)}</td>
<td class="r">${n(hostsGone.length)}</td><td class="r">${n(hostsNew.length)}</td></tr>
<tr><td>accepts rows</td><td class="r">${n(d.totals.rowsEarlier)}</td><td class="r">${n(d.totals.rowsLater)}</td>
<td class="r">—</td><td class="r">—</td><td class="r">—</td></tr>
</table>

<h2>Hosts present only in the ${esc(to)} reading</h2>
${hostsNew.length ? `<p class="m">${hostsNew.map((h) => esc(h)).join(" &middot; ")}</p>` : `<p class="sub">None.</p>`}
${hostsGone.length ? `<h2>Hosts absent from the ${esc(to)} reading</h2><p class="m">${hostsGone.map((h) => esc(h)).join(" &middot; ")}</p>`
  : `<p class="sub"><b>No host present in the ${esc(from)} reading is absent from the ${esc(to)} one.</b>
     Every difference in the host column is one direction only.</p>`}

<h2>Advertised price</h2>
<div class="box"><b>${n(d.price.changedCount)}</b> offers advertise a different amount in the later
reading.<br><br>⛔ Advertised, not charged. No endpoint was called in either reading, so neither says
what any of these services actually asks for when paid.</div>
${d.price.examples.length ? `<div class="wrap"><table><tr><th>resource</th><th>network</th>
<th class="r">${esc(from)}</th><th class="r">${esc(to)}</th></tr>
${d.price.examples.map((e) => `<tr><td class="m">${esc(e.resource)}</td><td>${esc(netName(e.network))}</td>
<td class="r m">${e.earlier.map(esc).join(", ")}</td><td class="r m">${e.later.map(esc).join(", ")}</td></tr>`).join("")}
</table></div><p class="sub">First ${d.price.examples.length} of ${n(d.price.changedCount)}; the JSON carries the method.</p>` : ""}

<h2>Networks</h2>
<table><tr><th>network</th><th class="m">CAIP-2</th><th class="r">${esc(from)}</th><th class="r">${esc(to)}</th><th class="r">difference</th></tr>
${d.networks.map((x) => `<tr><td>${esc(netName(x.caip))}</td><td class="m">${esc(x.caip)}</td>
<td class="r">${n(x.earlier)}</td><td class="r">${n(x.later)}</td>
<td class="r">${x.delta > 0 ? "+" : ""}${n(x.delta)}</td></tr>`).join("")}</table>

<h2>The gate this page had to pass first</h2>
<table><tr><th>reading</th><th class="r">rows</th>
${Object.values(d.gate.a.sentinels).map((s) => `<th class="r">${esc(s)}</th>`).join("")}<th>verdict</th></tr>
${[d.gate.a, d.gate.b].map((a) => `<tr><td>${esc(a.label)}</td><td class="r">${n(a.rows)}</td>
${Object.keys(a.sentinels).map((c) => `<td class="r">${n(a.observed[c])}</td>`).join("")}
<td>${a.passed ? "passed" : "FAILED"}</td></tr>`).join("")}</table>
<p class="sub">Both readings must carry testnet rows or this page renders a refusal instead of a
comparison — a filtered reading has a different denominator, and the difference would appear here as
roughly 165 testnet listings vanishing. Counted from the rows, not from either harvest's stored
self-check.</p>

<h2>What this comparison does NOT claim</h2>
<table><tr><th>field</th><th>state</th><th>why</th></tr>
${d.notMeasured.map((g) => `<tr><td><b>${esc(g.field)}</b></td><td>${esc(g.state)}</td><td>${esc(g.reason)}</td></tr>`).join("")}</table>

<h2>Method</h2>
<p>Both readings were fetched directly from <code>api.circle.com/v2/x402/discovery/resources</code>
with <code>limit=100</code> and no <code>siwx</code> parameter. This page compares them; it makes no
request of its own and never has.</p>
<p class="sub">⛔ The join is set-valued, not row-paired. <code>(resource, network, asset, scheme)</code>
is not unique — 834 keys in the later reading carry rows with conflicting values, the same URL
offered at two prices — so pairing rows would silently drop a third of them. Per key this compares
the SET of payout addresses and the SET of amounts, which invents no identity and loses no row.</p>
<p>The machine-readable form, with full addresses:
<a href="/snapshot/diff/${esc(pairId(from, to))}.json">/snapshot/diff/${esc(pairId(from, to))}.json</a></p>

<footer>Comparing <a href="/snapshot/${esc(from)}">${esc(from)}</a> and
<a href="/snapshot/${esc(to)}">${esc(to)}</a> &middot; composition only &middot;
<a href="/snapshot/diff/${esc(pairId(from, to))}.json">JSON</a> &middot;
<a href="/built">what else is built</a></footer>
</main></body></html>`;
}

export async function handler(event) {
  const path = (event.path || "").replace(/\/+$/, "");
  const NOSTORE = { "Cache-Control": "no-store" };
  const HTML = { "Content-Type": "text/html; charset=utf-8", ...NOSTORE };
  const JSONH = { "Content-Type": "application/json; charset=utf-8", ...NOSTORE };

  if (/\/snapshot\/diff$/.test(path)) {
    return { statusCode: 302, headers: { Location: `/snapshot/diff/${NEWEST_PAIR}?from=latest`, ...NOSTORE }, body: "" };
  }

  const m = path.match(/\/snapshot\/diff\/([\d-]{10}\.\.[\d-]{10})(\.json)?$/);
  const wantsJson = Boolean(m?.[2]);
  const got = m && computeFor(m[1]);

  // ⛔ An unknown pair 404s listing what exists. It does NOT fall back to the newest — serving one
  // comparison under another's URL is precisely the citation failure these pages exist to refuse.
  if (!got) {
    const avail = { error: "no comparison for that pair", available: PAIRS };
    return wantsJson
      ? { statusCode: 404, headers: JSONH, body: JSON.stringify(avail, null, 2) }
      : { statusCode: 404, headers: HTML, body: `<!doctype html><meta charset="utf-8">
<title>No comparison for that pair</title><body style="background:#0f141a;color:#ece6d8;font:16px/1.6 system-ui;padding:40px">
<h1>No comparison for that pair.</h1><p>These exist:</p><ul>${PAIRS.map((p) =>
  `<li><a style="color:#e0a44c" href="/snapshot/diff/${p}">${p}</a></li>`).join("")}</ul>
<p>You were not sent to the nearest one — that is how a reader cites a comparison they did not ask for.</p></body>` };
  }

  const { from, to, diff } = got;

  // 🚨 THE GATE. 409, and nothing computed — see the module comment.
  if (!diff.gate.passed) {
    return wantsJson
      ? { statusCode: 409, headers: JSONH,
          body: JSON.stringify({ pair: pairId(from, to), computed: false, gate: diff.gate,
            _why: "A filtered reading has a different denominator. No comparison was computed." }, null, 2) }
      : { statusCode: 409, headers: HTML, body: refusalPage({ from, to, diff }) };
  }

  if (wantsJson) {
    return { statusCode: 200, headers: JSONH, body: JSON.stringify({
      pair: pairId(from, to), from, to,
      scope: "composition-only",
      vocabulary: { forbidden: FORBIDDEN_VERBS,
        _why: "no event was observed; two readings differ. Fields are named for the observation." },
      ...diff,
    }, null, 2) };
  }
  return { statusCode: 200, headers: HTML,
    body: page({ from, to, diff, redirected: (event.queryStringParameters || {}).from === "latest" }) };
}

export { PAIRS, NEWEST_PAIR, DATES, HARVESTS };
