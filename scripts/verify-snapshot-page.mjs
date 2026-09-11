// verify-snapshot-page.mjs — the dated snapshots say what they measured, and refuse to look current.
//
//   node scripts/verify-snapshot-page.mjs      (also: npm run test:snapshot)
//
// ═══ WHY THIS SUITE EXISTS ═══════════════════════════════════════════════════════════════════
// /snapshot publishes MEASUREMENTS. Four ways a published measurement goes wrong, all silent:
//
//   1. ⛔ IT LOOKS CURRENT FOREVER. An undated artifact at a bare URL is cited in six months by
//      someone who is not being careless — the page gave them nothing to be careless with.
//   2. ⛔ IT CLAIMS MORE THAN WAS MEASURED. Liveness and price-agreement need ~1,000 third-party
//      calls that HAVE NOT BEEN MADE. A page that simply omits them reads as "fine".
//   3. ⛔ IT IS NOT REPRODUCIBLE. The `siwx=false` trap is the difference between 1,003 and 838
//      listings and hides every testnet row; a count published without it cannot be re-derived.
//   4. ⛔⛔ THE SECOND MEASUREMENT QUIETLY REWRITES THE FIRST. Added 2026-09-11. The tempting edit
//      is to "bring the page up to date" — which destroys the only thing a pair is good for. §6
//      pins 2026-08-27's figures against its own harvest so a later refresh cannot touch them.
//
// ⭐ AND EACH PAGE AND ITS JSON MUST NOT DRIFT. They render from ONE frozen object per date,
// precisely so a page cannot state a figure its JSON lacks — /built declined a JSON twin partly to
// avoid that cost, so the cost is paid structurally here rather than by discipline.
//
// ⚠️ 🚨 AND ONE ASSERTION IS ABOUT THE HARVESTER, NOT THE PAGE (§7). The first 2026-09-11 harvest
// lowercased payTo "for tidiness". Base58 is case-sensitive, so it corrupted all 1,087 Solana
// payouts and de-checksummed the EVM ones. The harvest's OWN self-check passed — the counts were
// right — and the damage was visible only in a diff, where 110 of 111 payout addresses read as
// "gone". A projection must PRESERVE. That is asserted here because nothing else would catch it.
//
// Zero network. Zero money.

import { handler } from "../netlify/functions/snapshot.mjs";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

const DATES = ["2026-08-27", "2026-09-11"];
const LATEST = DATES[DATES.length - 1];
const LABEL = { "2026-08-27": "27 August 2026", "2026-09-11": "11 September 2026" };

const get = async (p, q = {}) => handler({ path: p, queryStringParameters: q });
const pages = {}, jsons = {};
for (const d of DATES) {
  pages[d] = (await get(`/snapshot/${d}`)).body;
  jsons[d] = JSON.parse((await get(`/snapshot/${d}.json`)).body);
}
const bare = await get("/snapshot");
const viaLatest = (await get(`/snapshot/${LATEST}`, { from: "latest" })).body;
const unknown = await get("/snapshot/2025-01-01");
const unknownJson = await get("/snapshot/2025-01-01.json");

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  /snapshot — dated, bounded, reproducible, and NOT rewritten         ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("0 — THE INSTRUMENT IS NOT VACUOUS");
check("⭐ there is more than one snapshot — half this suite is about the pair", DATES.length >= 2, `${DATES.length} dates`);
for (const d of DATES) {
  check(`⭐ ${d} rendered and is substantial`, pages[d].length > 4000, `${pages[d].length} bytes`);
  check(`⭐ ${d} JSON parsed and carries totals`, Number(jsons[d]?.totals?.listings) > 0, `${jsons[d]?.totals?.listings} listings`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⛔ NO PAGE CAN LOOK CURRENT");
for (const d of DATES) {
  check(`⭐⭐ ${d}: the DATE is in the <title>, not only the body`,
    new RegExp(`<title>[^<]*${LABEL[d]}[^<]*</title>`).test(pages[d]));
  check(`⭐ ${d}: the staleness line is computed AT LOAD`,
    /Date\.now\(\)/.test(pages[d]) && pages[d].includes(`Date.parse("${d}T00:00:00Z")`),
    "a hardcoded age is stale the moment it ships");
  check(`⛔ ${d}: nothing claims the page is maintained`, /is not maintained/.test(pages[d]));
}
check("⭐⭐ a bare /snapshot REDIRECTS — never 200s with a page", bare.statusCode === 302, `status ${bare.statusCode}`);
check("⭐⭐ …to the NEWEST dated url", (bare.headers.Location ?? "").startsWith(`/snapshot/${LATEST}`), bare.headers.Location);
check("⭐⭐ …and the destination SAYS it redirected, so nobody cites a number they did not ask for",
  /You asked for the latest/.test(viaLatest) && !/You asked for the latest/.test(pages[LATEST]),
  "shown only on the ?from=latest render — a direct visit is not told it redirected");
// ⛔ THE FALL-THROUGH THAT WOULD SERVE ONE DATE'S NUMBERS UNDER ANOTHER DATE'S URL.
check("⭐⭐ an UNKNOWN date 404s and lists what exists — it does not fall through to the newest",
  unknown.statusCode === 404 && DATES.every((d) => unknown.body.includes(d)) && !/1,162|1,003/.test(unknown.body),
  `status ${unknown.statusCode}`);
check("⭐ …and so does an unknown .json", unknownJson.statusCode === 404);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⛔ EACH CLAIMS ONLY WHAT WAS MEASURED");
for (const d of DATES) {
  const J = jsons[d], P = pages[d];
  check(`⭐⭐ ${d}: scope is declared composition-only`, J.scope === "composition-only", J.scope);
  check(`⭐⭐ ${d}: liveness is stated as NOT MEASURED, with a reason`,
    J.notMeasured.some((g) => g.field === "liveness" && g.state === "not-measured" && g.reason.length > 20));
  check(`⭐⭐ ${d}: advertised-vs-live price likewise`,
    J.notMeasured.some((g) => g.field === "advertisedVsLivePrice" && g.state === "not-measured"));
  check(`⛔ ${d}: the page does not assert liveness anywhere`,
    !/\b(all|every)\s+(endpoints?|listings?)\s+(answered|responded|are live)/i.test(P));
  check(`⭐ ${d}: the gaps are RENDERED, not merely in the JSON`,
    /What this snapshot does NOT claim/.test(P) && /not-measured/.test(P),
    "an omission a reader cannot see is not a disclosure");
  // ⭐ ABSENCE AS A VALUE. Arc's zero is the question these snapshots are most asked; a missing key
  // would read as an oversight rather than a result.
  check(`⭐⭐ ${d}: Arc's absence is a RESULT, not a missing key`,
    J.arc?.state === "verified-absent" && J.arc.rows === 0 && /Is Arc in the catalog/.test(P));
}
// ⭐ THE ROW THAT ONLY EXISTS BECAUSE THERE ARE TWO — and it CLOSED rather than being deleted.
// ⛔ When a declared gap is filled, the row must say where the answer went. Deleting it leaves a
// reader who saw the earlier JSON with a question that has silently stopped being acknowledged.
check("⭐⭐ the change-between-snapshots row still exists, now pointing at the comparison",
  jsons[LATEST].notMeasured.some((g) => g.field === "changeBetweenSnapshots" &&
    g.state === "published-separately" && g.reason.includes("/snapshot/diff")));
check("⭐⭐ …and every page LINKS the comparison, so it is reachable not just referenced",
  DATES.every((d) => pages[d].includes("/snapshot/diff/")));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — 🚨 THE siwx TRAP IS ON EVERY PAGE, UNDER ITS OWN HEADING");
// ⚠️ The heading wraps the term in <code>, so a [^<]* class cannot cross it — the first draft of
// this assertion failed on a page that was correct. Match across inner tags, bounded.
for (const d of DATES) {
  check(`⭐⭐ ${d}: it has its own <h2>, not a footnote`,
    /<h2>[\s\S]{0,160}?siwx=false[\s\S]{0,160}?<\/h2>/.test(pages[d]));
  check(`⭐⭐ ${d}: BOTH sides of the measured gap appear`, /1,003/.test(pages[d]) && /838/.test(pages[d]));
  check(`⭐ ${d}: …and the difference is named`, /\b165\b/.test(pages[d]));
  check(`⭐⭐ ${d}: …and that it hides every testnet row`, /every testnet row/.test(pages[d]));
  check(`⛔ ${d}: the reader is told not to use the CLI`, /Do not use the CLI/i.test(pages[d]));
}
check("⭐ 2026-08-27's JSON carries the trap as its OWN measurement",
  jsons["2026-08-27"].siwxTrap?.hidden === 165 && jsons["2026-08-27"].siwxTrap.withoutSiwx === 1003 &&
  jsons["2026-08-27"].siwxTrap.withSiwxFalse === 838);
// ⛔⛔ THE ONE THAT STOPS A MEASUREMENT BEING BORROWED. The CLI was NOT re-run on 2026-09-11, so
// that page may CITE 838 with its date attached but must never report it as its own reading.
check("⭐⭐ 2026-09-11 does NOT report 838 as its own — the CLI was not re-run that day",
  jsons["2026-09-11"].siwxTrap.withSiwxFalse === null && jsons["2026-09-11"].siwxTrap.hidden === null &&
  jsons["2026-09-11"].siwxTrap.deltaMeasuredOn === "2026-08-27",
  "a number carried forward under a new date stops being a snapshot");
check("⭐⭐ …and the page says so in words, not just by omission",
  /The CLI was not re-run on this date/.test(pages["2026-09-11"]) &&
  /belongs to that date and is not restated as today/.test(pages["2026-09-11"]));
check("⭐ …while still proving the trap was avoided TODAY, by the testnet rows being present",
  /792 testnet rows are present/.test(pages["2026-09-11"]));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⭐⭐ PAGE AND JSON CANNOT DRIFT");
// The whole reason /built declined a JSON twin was two surfaces drifting. Structure, not discipline.
for (const d of DATES) {
  const J = jsons[d], P = pages[d];
  for (const [label, v] of [["listings", J.totals.listings], ["accepts rows", J.totals.acceptsRows],
                            ["hosts", J.totals.distinctHosts], ["distinct URLs", J.totals.distinctResourceUrls],
                            ["payout addresses", J.totals.distinctPayTo]]) {
    check(`⭐ ${d}: the page states the JSON's ${label}`, P.includes(v.toLocaleString("en-GB")), String(v));
  }
  check(`⭐⭐ ${d}: every network in the JSON is rendered on the page`,
    J.networks.every(([, name]) => P.includes(name)), `${J.networks.length} networks`);
  check(`⭐ ${d}: the network count matches the rows actually listed`,
    J.totals.networks === J.networks.length, `${J.totals.networks} vs ${J.networks.length}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — GROUNDED: EVERY FIGURE MATCHES ITS OWN HARVEST ON DISK");
// ⛔ A page must not drift from its own source. This re-derives from each harvest rather than
// trusting the constants — the failure being guarded is a hand-edited number nobody re-checked.
for (const d of DATES) {
  const J = jsons[d];
  const h = JSON.parse(readFileSync(`scripts/x402-census/circle-index-${d}.harvest.json`, "utf8"));
  check(`⭐⭐ ${d}: listings match the harvest`, J.totals.listings === h.listingsCollected,
    `${J.totals.listings} vs ${h.listingsCollected}`);
  check(`⭐⭐ ${d}: accepts rows match`, J.totals.acceptsRows === h.acceptsRows,
    `${J.totals.acceptsRows} vs ${h.acceptsRows}`);
  const net = {}, urls = new Set(), hosts = new Set(), pay = new Set();
  for (const r of h.rows) {
    net[r.network] = (net[r.network] || 0) + 1;
    if (r.resource) { urls.add(r.resource); try { hosts.add(new URL(r.resource).host); } catch { /* not a URL */ } }
    if (r.payTo) pay.add(r.payTo);
  }
  check(`⭐⭐ ${d}: the network count matches`, J.totals.networks === Object.keys(net).length,
    `${J.totals.networks} vs ${Object.keys(net).length}`);
  const wrong = J.networks.filter(([caip, , c]) => net[caip] !== c);
  check(`⭐⭐ ${d}: every per-network row matches the harvest`, wrong.length === 0,
    wrong.length ? wrong.map((w) => w[1]).join(", ") : `${J.networks.length} rows`);
  check(`⭐ ${d}: distinct URLs, hosts and payout addresses match`,
    J.totals.distinctResourceUrls === urls.size && J.totals.distinctHosts === hosts.size &&
    J.totals.distinctPayTo === pay.size,
    `${urls.size} / ${hosts.size} / ${pay.size}`);
  check(`⛔ ${d}: Arc really is absent from the harvest, not just from the page`,
    !Object.keys(net).some((k) => /arc/i.test(k) || k === "eip155:5042002"));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — ⛔⛔ THE SECOND MEASUREMENT DID NOT REWRITE THE FIRST");
// This is the assertion the whole two-snapshot design exists for. The tempting maintenance edit is
// to refresh the old page's numbers; that would leave two URLs showing one measurement.
check("⭐⭐ 2026-08-27 still reports ITS OWN totals, not the newer harvest's",
  jsons["2026-08-27"].totals.listings === 1003 && jsons["2026-08-27"].totals.acceptsRows === 3808 &&
  jsons["2026-08-27"].totals.distinctHosts === 25);
check("⭐⭐ …and they are genuinely DIFFERENT from the newer ones, so the check can fail",
  jsons["2026-09-11"].totals.listings !== jsons["2026-08-27"].totals.listings &&
  jsons["2026-09-11"].totals.distinctHosts !== jsons["2026-08-27"].totals.distinctHosts,
  `${jsons["2026-08-27"].totals.listings} vs ${jsons["2026-09-11"].totals.listings} listings`);
check("⭐⭐ the older page TELLS the reader a newer one exists, and links to it",
  jsons["2026-08-27"].supersededBy === "2026-09-11" &&
  /A NEWER MEASUREMENT EXISTS/.test(pages["2026-08-27"]) &&
  pages["2026-08-27"].includes('href="/snapshot/2026-09-11"'));
check("⭐ …and says explicitly that it was NOT updated",
  /has deliberately <b>not<\/b> been updated/.test(pages["2026-08-27"]));
check("⛔ the newest is NOT marked superseded", jsons[LATEST].supersededBy === null);
check("⭐ each page lists every snapshot, so neither is a dead end",
  DATES.every((d) => DATES.every((o) => pages[d].includes(`/snapshot/${o}`))));
// ⭐ THE PROVENANCE UPGRADE, STATED AS A DIFFERENCE BETWEEN THE TWO RUNS RATHER THAN BACKFILLED.
check("⭐⭐ 2026-09-11 records that it CHECKED for drift; 2026-08-27 records that it did not",
  /CHECKED, and present/.test(jsons["2026-09-11"].method.totalField) &&
  /not-checked/.test(jsons["2026-08-27"].method.totalField),
  "the older harvest's blind spot is named, not silently inherited or silently fixed");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — 🚨 THE HARVEST PRESERVED ITS SOURCE BYTES (the diff-poisoning bug)");
// ⛔ The first 2026-09-11 harvest lowercased payTo. Counts stayed correct, the self-check passed,
// and 110 of 111 payout addresses read as "gone" in the diff — a catalog-wide payout rotation that
// never happened. Normalise at COMPARE time, never at harvest time.
{
  const h = JSON.parse(readFileSync("scripts/x402-census/circle-index-2026-09-11.harvest.json", "utf8"));
  const sol = h.rows.filter((r) => /^solana:/.test(r.network) && r.payTo);
  const evm = h.rows.filter((r) => /^eip155:/.test(r.network) && r.payTo);
  check("⭐ there are Solana rows to be wrong about", sol.length > 100, `${sol.length} rows`);
  check("⭐⭐ every Solana payout keeps its base58 case — lowercasing invents a different address",
    sol.every((r) => r.payTo !== r.payTo.toLowerCase()), `${sol.length} checked`);
  check("⭐⭐ EVM payouts keep their checksum casing too",
    evm.filter((r) => r.payTo !== r.payTo.toLowerCase()).length > evm.length * 0.5,
    `${evm.filter((r) => r.payTo !== r.payTo.toLowerCase()).length}/${evm.length} mixed-case`);
  // ⭐ AND THE PROOF THAT MATTERS: the two harvests actually overlap on payouts.
  const prev = JSON.parse(readFileSync("scripts/x402-census/circle-index-2026-08-27.harvest.json", "utf8"));
  const A = new Set(prev.rows.map((r) => r.payTo).filter(Boolean));
  const B = new Set(h.rows.map((r) => r.payTo).filter(Boolean));
  const kept = [...A].filter((x) => B.has(x)).length;
  check("⭐⭐ most payout addresses PERSIST across the two harvests", kept > A.size * 0.6,
    `${kept} of ${A.size} still present — the corrupted run scored 1`);
}

console.log(`\n${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail ? 1 : 0);
