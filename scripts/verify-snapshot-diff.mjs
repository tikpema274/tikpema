// verify-snapshot-diff.mjs — the comparison refuses a wrong denominator, and never claims an event.
//
//   node scripts/verify-snapshot-diff.mjs      (also: npm run test:snapshotdiff)
//
// ═══ WHY THIS SUITE EXISTS ═══════════════════════════════════════════════════════════════════
// Three ways a published diff goes wrong, and none of them looks like an error:
//
//   1. 🚨 IT COMPARES ACROSS A FILTER. An unfiltered harvest against a `siwx=false` one shows ~165
//      disappearances, EVERY ONE A TESTNET ROW — a plausible count, a coherent breakdown, no error
//      anywhere. §1 proves the page REFUSES rather than rendering it with a warning: a warning on a
//      wrong number is still a wrong number published, and the warning is the skippable part.
//   2. ⛔ IT REPORTS AN EVENT NOBODY OBSERVED. Neither harvest can bound what it missed, so a
//      listing absent from the later reading may be withdrawn, renamed, or missed by paging. §2
//      asserts the forbidden vocabulary is absent from the RENDERED page, not merely from intent.
//   3. ⛔ IT LETS "UNCHANGED" READ AS "STABLE". Two instants fifteen days apart say nothing about
//      the interval. §3 requires that on the page, in its own section, above the fold.
//
// ⭐ AND §4 GUARDS THE JOIN. `(resource, network, asset, scheme)` is NOT unique — 834 keys in the
// later reading carry conflicting rows — so a row-paired join silently drops a third of the data
// and reports confident numbers over the survivors. The comparison is set-valued, and that is
// asserted against a fixture built to break a last-write-wins Map.
//
// Zero network. Zero money.

import { handler } from "../netlify/functions/snapshot-diff.mjs";
import { PAIRS as DIFF_PAIRS, DATES as HARVEST_DATES, HARVESTS } from "../netlify/functions/snapshot-diff.mjs";
import { DATES as SNAPSHOT_DATES, PAIRS as SNAPSHOT_PAIRS, handler as snapshotHandler } from "../netlify/functions/snapshot.mjs";
import { diffHarvests, auditHarvest, FORBIDDEN_VERBS, pairsFor, SENTINELS } from "../shared/x402-diff.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

const PAIR = DIFF_PAIRS[DIFF_PAIRS.length - 1];
const [FROM, TO] = PAIR.split("..");
const get = (p, q = {}) => handler({ path: p, queryStringParameters: q });
const pageRes = await get(`/snapshot/diff/${PAIR}`);
const html = pageRes.body;
const jsonRes = await get(`/snapshot/diff/${PAIR}.json`);
const data = JSON.parse(jsonRes.body);
const bare = await get("/snapshot/diff");
const unknown = await get("/snapshot/diff/2020-01-01..2020-01-02");
const n = (x) => Number(x).toLocaleString("en-GB");
// ⚠️ PROSE ASSERTIONS MATCH AGAINST COLLAPSED WHITESPACE. Template literals wrap sentences across
// source lines, so `/a takeover look identical/` failed on a page that said exactly that with a
// newline in the middle. Two assertions in the first draft of this file were wrong this way, and
// both looked like page defects. Match `flat` for prose; match `html` for structure.
const flat = html.replace(/\s+/g, " ");

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  /snapshot/diff — refuses a wrong denominator, claims no events      ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("0 — THE INSTRUMENT IS NOT VACUOUS, AND THE TWO DATE LISTS AGREE");
check("⭐ the page rendered and is substantial", pageRes.statusCode === 200 && html.length > 6000,
  `${pageRes.statusCode}, ${html.length} bytes`);
check("⭐ the JSON parsed and actually computed a comparison", data.computed === true && data.gate.passed === true);
check("⭐ there is a pair to be about", DIFF_PAIRS.length >= 1, DIFF_PAIRS.join(", "));
// ⛔ snapshot.mjs keys its frozen SNAPSHOTS; snapshot-diff.mjs keys the harvest files on disk. Two
// lists, and sharing pairsFor() does not stop them drifting — only comparing them does. A snapshot
// published with no harvest behind it, or a harvest with no page, both surface here.
check("⭐⭐ the snapshot pages and the harvests cover the SAME dates",
  JSON.stringify([...SNAPSHOT_DATES].sort()) === JSON.stringify([...HARVEST_DATES].sort()),
  `pages ${SNAPSHOT_DATES.join(",")} vs harvests ${HARVEST_DATES.join(",")}`);
check("⭐ …so both derive the same pair list", JSON.stringify(SNAPSHOT_PAIRS) === JSON.stringify(DIFF_PAIRS));
check("⭐ pairsFor is the single derivation, and it is ordered earliest-first",
  pairsFor(["2026-09-11", "2026-08-27"])[0] === "2026-08-27..2026-09-11");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — 🚨 A FILTERED READING IS REFUSED, NOT WARNED ABOUT");
// ⭐ THE FIXTURE IS THE REAL FAILURE: a harvest with every testnet row stripped, which is exactly
// what the CLI's undeclared siwx=false produces. Not a malformed file — a plausible one.
{
  const real = HARVESTS[TO];
  const filtered = { ...real, rows: real.rows.filter((r) => !(r.network in SENTINELS)) };
  check("⭐ the fixture is realistic — it lost rows but is otherwise a valid harvest",
    filtered.rows.length > 1000 && filtered.rows.length < real.rows.length,
    `${real.rows.length} → ${filtered.rows.length} rows`);

  const audit = auditHarvest(filtered, TO);
  check("⭐⭐ the audit FAILS on it", audit.passed === false);
  check("⭐ …and names the siwx signature in the reason", /siwx=false/.test(audit.reason ?? ""));
  // ⛔ The gate must read the ROWS. This fixture still carries the harvest's own `selfCheck: passed`.
  check("⭐⭐⭐ …even though the file still CLAIMS it passed — the rows are the evidence",
    real.selfCheck?.passed === true && audit.passed === false && audit.claimDisagrees.length > 0,
    `stored claim disagrees on ${audit.claimDisagrees.length} sentinel(s)`);

  const d = diffHarvests(HARVESTS[FROM], filtered, { labelA: FROM, labelB: TO });
  check("⭐⭐⭐ diffHarvests COMPUTES NOTHING — no counts to be quoted out of context",
    d.computed === false && d.payTo === undefined && d.presence === undefined && d.networks === undefined,
    "a warning on a wrong number is still a wrong number published");
  check("⭐ the refusal names WHICH reading failed", (d.gate.refusal ?? "").includes(TO));
  check("⭐ …and the gate still reports both audits, so the reader can see which side is sound",
    d.gate.a.passed === true && d.gate.b.passed === false);

  // ⭐ AND THE NON-VACUITY CONTROL: an empty harvest must also fail, for a DIFFERENT reason.
  const empty = auditHarvest({ rows: [] }, "empty");
  check("⭐⭐ an empty harvest fails too, and says so distinctly",
    empty.passed === false && /no rows at all/.test(empty.reason) && !/siwx/.test(empty.reason));
  check("⛔ …and a sound harvest PASSES, so the gate is not simply always-refusing",
    auditHarvest(HARVESTS[FROM], FROM).passed === true && auditHarvest(real, TO).passed === true);
}
check("⭐⭐ the live page states the gate it had to pass", /gate this page had to pass/i.test(flat));
check("⭐ …and shows both readings' sentinel counts", /Base Sepolia/.test(html) && /Polygon Amoy/.test(html));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⛔ NO EVENT IS CLAIMED: THE VOCABULARY IS ENFORCED ON THE RENDERED PAGE");
for (const verb of FORBIDDEN_VERBS) {
  const re = new RegExp(`\\b${verb}\\b`, "i");
  check(`⛔ the page never says "${verb}"`, !re.test(html),
    "a listing absent from the later reading may be withdrawn, renamed, or missed by paging");
}
check("⭐⭐ it says 'absent from' instead", new RegExp(`absent from the ${TO} reading`, "i").test(flat));
check("⭐⭐ …and 'present only in' for the other direction",
  new RegExp(`present only in the ${TO} reading`, "i").test(flat));
check("⭐⭐ the JSON field names carry the same discipline, not just the prose",
  "absentFromLater" in data.presence.resources && "presentOnlyInLater" in data.presence.resources &&
  !("removedCount" in data.presence.resources) && !("addedCount" in data.presence.resources));
check("⭐ the page says explicitly that nobody observed a change",
  /Nobody observed a change; two readings simply differ/.test(flat));
check("⭐⭐ the JSON declares the forbidden vocabulary so an agent inherits the constraint",
  Array.isArray(data.vocabulary?.forbidden) && data.vocabulary.forbidden.includes("removed"));
check("⭐ 'cause of absence' is a declared gap, not an omission",
  data.notMeasured.some((g) => g.field === "causeOfAbsence" && g.state === "cannot-distinguish"));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⛔ UNCHANGED ≠ STABLE, ON THE PAGE, IN ITS OWN SECTION");
check("⭐⭐ it has its own <h2>", /<h2>[\s\S]{0,200}?not a period[\s\S]{0,200}?<\/h2>/.test(html));
check("⭐⭐ …placed ABOVE the presence and network tables, not at the foot",
  html.indexOf("not a period") < html.indexOf("<h2>Presence</h2>") &&
  html.indexOf("not a period") < html.indexOf("<h2>Networks</h2>"),
  "a caveat below the numbers is read after the numbers");
check("⭐⭐ it names the interval in days from the DATES, not a literal",
  data.interval.days === 15 && html.includes("15 days apart"), `${data.interval.days} days`);
check("⭐⭐ …and says a value equal on both dates may have changed and changed back",
  /changed and changed back/.test(flat));
check("⭐ the interval caveat is in the JSON too — an agent reads no footnotes",
  data.interval.state === "unobserved" && data.interval.text.length > 100);
check("⭐ 'what happened between' is a declared gap",
  data.notMeasured.some((g) => g.field === "whatHappenedBetween" && g.state === "not-measured"));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⭐ THE PAYOUT ROW LEADS, AND ZERO WOULD BE A MEASUREMENT");
{
  // ⭐ Structural, not textual: take the FIRST <h2> and require it to be this one. Comparing
  // indexOf offsets was brittle to a single emoji (a surrogate pair counts as two code units).
  const firstH2 = html.match(/<h2>([\s\S]*?)<\/h2>/)?.[1] ?? "";
  check("⭐⭐ the payout section is the FIRST <h2> on the page",
    /Where the money is pointed/.test(firstH2),
    `first heading is: ${firstH2.replace(/\s+/g, " ").slice(0, 60)}`);
}
check("⭐ the count is rendered", html.includes(n(data.payTo.changedCount)) && data.payTo.changedCount >= 0,
  `${data.payTo.changedCount} of ${data.payTo.comparableOffers}`);
check("⭐⭐ …with the denominator beside it, so it is a rate not a scare number",
  html.includes(n(data.payTo.comparableOffers)));
check("⛔⛔ the page refuses to imply ownership from a catalog entry",
  /says nothing about who controls either address/i.test(flat) &&
  /routine key rotation and a takeover look identical/i.test(flat));
check("⭐ payoutOwnership is a declared gap",
  data.notMeasured.some((g) => g.field === "payoutOwnership" && g.state === "not-measured"));
// ⭐ ZERO IS A MEASUREMENT. Prove the section renders a real statement when there is nothing to show,
// rather than vanishing — an absent section reads as "not checked".
{
  const same = diffHarvests(HARVESTS[FROM], HARVESTS[FROM], { labelA: FROM, labelB: FROM });
  check("⭐⭐ a reading against ITSELF yields zero payout changes", same.payTo.changedCount === 0);
  check("⭐⭐ …and the section still has a count and a method, not an empty div",
    same.payTo.state === "verified" && same.payTo.comparableOffers > 0 && same.payTo._method.length > 50,
    `${same.payTo.comparableOffers} comparable offers, 0 changed`);
  check("⛔ …and the self-comparison reports no presence differences either — the control is sound",
    same.presence.resources.absentFromLater === 0 && same.presence.resources.presentOnlyInLater === 0);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — ⭐ THE JOIN IS SET-VALUED, BECAUSE THE KEY IS NOT UNIQUE");
// ⛔ THE FIXTURE BREAKS A LAST-WRITE-WINS MAP. Two rows share (resource, network, asset, scheme)
// and differ in payTo. A row-paired join keeps whichever came last and reports a phantom change.
{
  const mk = (payTo, amount) => ({ resource: "https://x.test/a", network: "eip155:8453",
    asset: "0xA", scheme: "exact", payTo, amount, extraNameState: "name-present", extraName: "USD Coin" });
  const sentinelRows = [
    { ...mk("0xkeep", "1"), network: "eip155:84532" }, { ...mk("0xkeep", "1"), network: "eip155:80002" },
  ];
  const A = { rows: [mk("0xaaa", "100"), mk("0xbbb", "200"), ...sentinelRows], listingsCollected: 3 };
  const B = { rows: [mk("0xbbb", "200"), mk("0xaaa", "100"), ...sentinelRows], listingsCollected: 3 };
  const d = diffHarvests(A, B, { labelA: "a", labelB: "b" });
  check("⭐ the fixture passes the gate, so §5 tests the join and not the gate", d.computed === true);
  check("⭐⭐⭐ the same two offers in a DIFFERENT ORDER register no payout change",
    d.payTo.changedCount === 0,
    "a last-write-wins Map would report 0xbbb→0xaaa, a repoint that did not happen");
  check("⭐⭐ …and no price change either", d.price.changedCount === 0);

  const C = { rows: [mk("0xaaa", "100"), mk("0xccc", "200"), ...sentinelRows], listingsCollected: 3 };
  const d2 = diffHarvests(A, C, { labelA: "a", labelB: "c" });
  check("⭐⭐⭐ but a GENUINELY different payout set IS reported — the check is not vacuous",
    d2.payTo.changedCount === 1 && d2.payTo.changes[0].onlyInLater.includes("0xccc") &&
    d2.payTo.changes[0].onlyInEarlier.includes("0xbbb"));
  check("⭐ …and it keeps the address they still share, so partial repoints are visible",
    d2.payTo.changes[0].inBoth.includes("0xaaa"));
  check("⭐⭐ an offer present in only ONE reading is NOT counted as a payout change",
    diffHarvests(A, { rows: sentinelRows, listingsCollected: 0 }, {}).payTo.changedCount === 0,
    "presence and repointing are different questions; conflating them inflates the headline");
}
check("⭐ the page explains why the join is set-valued", /set-valued, not row-paired/.test(flat));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — ROUTES: DATED, AND NEVER A SILENT SUBSTITUTE");
check("⭐⭐ a bare /snapshot/diff REDIRECTS, never 200s", bare.statusCode === 302, `status ${bare.statusCode}`);
check("⭐ …to the newest pair, saying so", (bare.headers.Location ?? "").includes(`${PAIRS_NEWEST()}?from=latest`),
  bare.headers.Location);
function PAIRS_NEWEST() { return DIFF_PAIRS[DIFF_PAIRS.length - 1]; }
check("⭐⭐ …and the destination TELLS the reader which comparison it served",
  /You asked for the latest comparison/.test((await get(`/snapshot/diff/${PAIR}`, { from: "latest" })).body) &&
  !/You asked for the latest comparison/.test(html));
check("⭐⭐ an unknown pair 404s and lists what exists — no fall-back to the newest",
  unknown.statusCode === 404 && unknown.body.includes(PAIR) && !unknown.body.includes(n(data.payTo.comparableOffers)),
  `status ${unknown.statusCode}`);
check("⭐ the date is in the <title>, so a screenshot carries it",
  /<title>[^<]*27 August 2026[^<]*11 September 2026[^<]*<\/title>/.test(html));
check("⭐ both snapshot pages are linked, so the diff is not a dead end",
  html.includes(`/snapshot/${FROM}`) && html.includes(`/snapshot/${TO}`));
check("⭐⭐ and each snapshot page links FORWARD to the comparison",
  (await snapshotHandler({ path: `/snapshot/${TO}`, queryStringParameters: {} })).body
    .includes(`/snapshot/diff/${PAIR}`));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — GROUNDED: THE PAGE'S FIGURES COME FROM THE HARVESTS ON DISK");
{
  const A = HARVESTS[FROM], B = HARVESTS[TO];
  check("⭐⭐ row totals match the harvests", data.totals.rowsEarlier === A.rows.length &&
    data.totals.rowsLater === B.rows.length, `${A.rows.length} / ${B.rows.length}`);
  const urlsA = new Set(A.rows.map((r) => r.resource).filter(Boolean));
  const urlsB = new Set(B.rows.map((r) => r.resource).filter(Boolean));
  check("⭐⭐ distinct-URL counts match", data.presence.resources.inEarlier === urlsA.size &&
    data.presence.resources.inLater === urlsB.size, `${urlsA.size} / ${urlsB.size}`);
  check("⭐⭐ 'absent from the later reading' is genuinely a set difference",
    data.presence.resources.absentFromLater === [...urlsA].filter((u) => !urlsB.has(u)).length);
  const netB = {}; for (const r of B.rows) netB[r.network] = (netB[r.network] || 0) + 1;
  check("⭐⭐ every network's later count matches the harvest",
    data.networks.every((x) => x.later === (netB[x.caip] ?? 0)), `${data.networks.length} networks`);
  check("⭐ the deltas are arithmetic, not typed in",
    data.networks.every((x) => x.delta === x.later - x.earlier));
  check("⛔ every payout change names a resource that exists in BOTH readings",
    data.payTo.changes.every((c) => urlsA.has(c.resource) && urlsB.has(c.resource)),
    `${data.payTo.changes.length} changes checked`);
}

console.log(`\n${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail ? 1 : 0);
