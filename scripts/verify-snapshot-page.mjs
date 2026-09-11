// verify-snapshot-page.mjs — the dated snapshot says what it measured, and refuses to look current.
//
//   node scripts/verify-snapshot-page.mjs      (also: npm run test:snapshot)
//
// ═══ WHY THIS SUITE EXISTS ═══════════════════════════════════════════════════════════════════
// /snapshot publishes a MEASUREMENT. Three ways a published measurement goes wrong, all silent:
//
//   1. ⛔ IT LOOKS CURRENT FOREVER. An undated artifact at a bare URL is cited in six months by
//      someone who is not being careless — the page gave them nothing to be careless with.
//   2. ⛔ IT CLAIMS MORE THAN WAS MEASURED. Liveness and price-agreement need 960 third-party
//      calls that HAVE NOT BEEN MADE. A page that simply omits them reads as "fine".
//   3. ⛔ IT IS NOT REPRODUCIBLE. The `siwx=false` trap is the difference between 1,003 and 838
//      listings and hides every testnet row; a count published without it cannot be re-derived.
//
// ⭐ AND THE PAGE AND THE JSON MUST NOT DRIFT. They render from ONE frozen object precisely so the
// page cannot state a figure the JSON lacks — /built declined a JSON twin partly to avoid that
// cost, so the cost is paid structurally here rather than by discipline.
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

const CAPTURED = "2026-08-27";
const page = (await handler({ path: `/snapshot/${CAPTURED}`, queryStringParameters: {} })).body;
const viaLatest = (await handler({ path: `/snapshot/${CAPTURED}`, queryStringParameters: { from: "latest" } })).body;
const bare = await handler({ path: "/snapshot", queryStringParameters: {} });
const jsonRes = await handler({ path: `/snapshot/${CAPTURED}.json`, queryStringParameters: {} });
const data = JSON.parse(jsonRes.body);

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  /snapshot — dated, bounded, reproducible                            ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("0 — THE INSTRUMENT IS NOT VACUOUS");
check("⭐ the page rendered and is substantial", page.length > 4000, `${page.length} bytes`);
check("⭐ the JSON parsed and carries totals", Number(data?.totals?.listings) > 0, `${data?.totals?.listings} listings`);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⛔ IT CANNOT LOOK CURRENT");
check("⭐⭐ the DATE is in the <title>, not only the body", /<title>[^<]*27 August 2026[^<]*<\/title>/.test(page));
check("⭐⭐ a bare /snapshot REDIRECTS — never 200s with a page",
  bare.statusCode === 302, `status ${bare.statusCode}`);
check("⭐ …to the DATED url", /\/snapshot\/2026-08-27/.test(bare.headers.Location ?? ""), bare.headers.Location);
check("⭐⭐ …and the destination SAYS it redirected, so nobody cites a number they did not ask for",
  /You asked for the latest/.test(viaLatest) && !/You asked for the latest/.test(page),
  "shown only on the ?from=latest render — a direct visit is not told it redirected");
check("⭐ the staleness line is computed AT LOAD, not written in",
  /Date\.now\(\)/.test(page) && /day/.test(page),
  "a hardcoded age is stale the moment it ships");
check("⛔ nothing claims the page is maintained", /is not maintained/.test(page));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⛔ IT CLAIMS ONLY WHAT WAS MEASURED");
check("⭐⭐ scope is declared composition-only", data.scope === "composition-only", data.scope);
check("⭐⭐ liveness is stated as NOT MEASURED, with a reason",
  data.notMeasured.some((g) => g.field === "liveness" && g.state === "not-measured" && g.reason.length > 20));
check("⭐⭐ advertised-vs-live price likewise",
  data.notMeasured.some((g) => g.field === "advertisedVsLivePrice" && g.state === "not-measured"));
check("⛔ the page does not assert liveness anywhere",
  !/\b(all|every)\s+(endpoints?|listings?)\s+(answered|responded|are live)/i.test(page));
check("⭐ the gaps are RENDERED, not merely in the JSON",
  /What this snapshot does NOT claim/.test(page) && /not-measured/.test(page),
  "an omission a reader cannot see is not a disclosure");
// ⭐ ABSENCE AS A VALUE. Arc's zero is the question this snapshot is most asked; a missing key
// would read as an oversight rather than a result.
check("⭐⭐ Arc's absence is a RESULT, not a missing key",
  data.arc?.state === "verified-absent" && data.arc.rows === 0 && /Is Arc in the catalog/.test(page));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — 🚨 THE siwx TRAP IS ON THE PAGE, UNDER ITS OWN HEADING");
// ⚠️ The heading wraps the term in <code>, so a [^<]* class cannot cross it — the first draft of
// this assertion failed on a page that was correct. Match across inner tags, bounded.
check("⭐⭐ it has its own <h2>, not a footnote", /<h2>[\s\S]{0,160}?siwx=false[\s\S]{0,160}?<\/h2>/.test(page));
check("⭐⭐ BOTH numbers appear", /1,003/.test(page) && /838/.test(page));
check("⭐ …and the difference is named", /\b165\b/.test(page));
check("⭐⭐ …and that it hides every testnet row", /every testnet row/.test(page));
check("⛔ the reader is told not to use the CLI", /Do not use the CLI/i.test(page));
check("⭐ the JSON carries the trap too — an agent must not miss it",
  data.siwxTrap?.hidden === 165 && data.siwxTrap.withoutSiwx === 1003 && data.siwxTrap.withSiwxFalse === 838);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⭐⭐ PAGE AND JSON CANNOT DRIFT");
// The whole reason /built declined a JSON twin was two surfaces drifting. Structure, not discipline.
for (const [label, v] of [["listings", data.totals.listings], ["accepts rows", data.totals.acceptsRows],
                          ["hosts", data.totals.distinctHosts], ["distinct URLs", data.totals.distinctResourceUrls]]) {
  check(`⭐ the page states the JSON's ${label}`, page.includes(v.toLocaleString("en-GB")), String(v));
}
check("⭐⭐ every network in the JSON is rendered on the page",
  data.networks.every(([, name]) => page.includes(name)), `${data.networks.length} networks`);
check("⭐ the network count matches the rows actually listed",
  data.totals.networks === data.networks.length, `${data.totals.networks} vs ${data.networks.length}`);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — GROUNDED: THE FIGURES MATCH THE HARVEST ON DISK");
// ⛔ The page must not drift from its own source. This re-derives from the harvest rather than
// trusting the constants — the failure being guarded is a hand-edited number nobody re-checked.
{
  const h = JSON.parse(readFileSync("scripts/x402-census/circle-index-2026-08-27.harvest.json", "utf8"));
  check("⭐⭐ listings match the harvest", data.totals.listings === h.listingsCollected,
    `${data.totals.listings} vs ${h.listingsCollected}`);
  check("⭐⭐ accepts rows match", data.totals.acceptsRows === h.acceptsRows,
    `${data.totals.acceptsRows} vs ${h.acceptsRows}`);
  const net = {}; for (const r of h.rows) net[r.network] = (net[r.network] || 0) + 1;
  check("⭐⭐ the network count matches", data.totals.networks === Object.keys(net).length,
    `${data.totals.networks} vs ${Object.keys(net).length}`);
  const wrong = data.networks.filter(([caip, , c]) => net[caip] !== c);
  check("⭐⭐ every per-network row matches the harvest", wrong.length === 0,
    wrong.length ? wrong.map((w) => w[1]).join(", ") : `${data.networks.length} rows`);
  check("⛔ Arc really is absent from the harvest, not just from the page",
    !Object.keys(net).some((k) => /arc/i.test(k) || k === "eip155:5042002"));
}

console.log(`\n${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail ? 1 : 0);
