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
import { diffHarvests, auditHarvest, FORBIDDEN_VERBS, pairsFor, SENTINELS, stabilityAcrossThree } from "../shared/x402-diff.mjs";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

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
// ⭐⭐ AND A TAG-STRIPPED VIEW FOR PROSE THAT SPANS INLINE MARKUP. Three assertions in this file's
// drafts failed on a CORRECT page because a sentence ran across `<b>`/`<i>` or a source newline —
// `24 of them belong to a single host` is `<b>24</b> of them…` in the HTML. The rule that emerged:
// match `text` for anything a human reads as a sentence, `html` for structure (tags, headings,
// attributes), `flat` only when the markup itself is part of the claim.
const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

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
section("4b — ⛔ THE FOUR PARTS, IN ORDER, AND NO COMPANY IN A HEADING");
// ⛔ ORDER IS THE ASSERTION, not presence. The benign reading placed AFTER the distinguishing check
// reads as a concession; placed after the structural limit it reads as an afterthought. And a count
// published without part 2 at all is an accusation. Each part is pinned by a phrase and the four
// indices must ascend.
{
  const parts = [
    ["1 the measurement", "offers name a different payout address"],
    ["2 the benign reading", "The ordinary explanation fits it"],
    ["3 what would distinguish", "What would tell the two apart, and has not been done"],
    ["4 the structural limit", "cannot reach at any effort"],
  ];
  const at = parts.map(([, needle]) => flat.indexOf(needle));
  parts.forEach(([label], i) => check(`⭐⭐ part ${label} is present`, at[i] >= 0));
  check("⭐⭐⭐ …and all four appear IN THAT ORDER",
    at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1])),
    at.join(" < "));

  // 1 — derived, not typed.
  const pt = data.payTo.pattern;
  check("⭐⭐ the measurement is derived: distinct new addresses equals the changed-offer count",
    pt.distinctNewAddresses === data.payTo.changedCount && pt.oneAddressPerChangedOffer === true,
    `${pt.distinctNewAddresses} addresses / ${data.payTo.changedCount} offers`);
  check("⭐ …and the concentration figure comes from the data",
    text.includes(`${n(pt.topHost.changedOffers)} of them belong to a single host`),
    `${pt.topHost?.changedOffers} on the top host`);
  check("⭐⭐ …and the cross-chain claim is derived, not asserted",
    pt.topHostSpansMultipleChains === (pt.topHost.chains.length > 1) &&
    pt.topHost.chains.every((c) => flat.includes(c === "eip155:8453" ? "Base" : "Solana")));
  check("⛔ the page states the figures are derived rather than recorded by hand",
    /derived from the two harvests, not recorded by hand/.test(text));

  // 2 — the benign reading must be NAMED, not gestured at.
  check("⭐⭐ the benign reading names the mechanism",
    /one payout address per endpoint is a reasonable/i.test(text) &&
    /regenerates every address together when it re-keys or redeploys/i.test(text));
  check("⭐⭐ …and gives the reason it is the likelier reading",
    /wants few destinations/.test(text));

  // 3 — a NAMED check, and explicitly not done.
  check("⭐⭐ the distinguishing check is named specifically, not gestured at",
    /402<\/code> challenge/.test(html) && /the address it names is the one in this reading/.test(text));
  check("⭐⭐ …and is stated as NOT performed", /Those requests have not been made/.test(text));
  check("⭐⭐⭐ …and the page says on-chain reads would NOT settle it",
    /independent addresses are consistent with per-endpoint derivation/.test(text) &&
    /a shared deployer is consistent with systematic provisioning/.test(text),
    "a read that cannot change what we publish is activity, not measurement");

  // 4 — a property of the instrument, not a hedge.
  check("⭐⭐⭐ the structural limit is stated as a property of the instrument",
    /A catalog records where money is pointed/.test(text) &&
    /never records who pointed it, or why/.test(text) &&
    /no amount of further care with this data would make it so/.test(text));
  check("⭐⭐ …and it is a declared field, so the JSON carries it too",
    data.notMeasured.some((g) => g.field === "whoChangedTheEntry" &&
      g.state === "structurally-unanswerable" && /limit of the instrument/.test(g.reason)));

  // ⛔ NO COMPANY IN A HEADING. The host belongs in the data and the resource URLs, nowhere else.
  const headings = [...html.matchAll(/<h[12]>([\s\S]*?)<\/h[12]>/g)].map((m) => m[1]);
  const titleTag = html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
  const hostNames = new Set(data.payTo.changes.map((c) => { try { return new URL(c.resource).host; } catch { return ""; } }));
  check("⭐ there are hosts to keep out of the headings", hostNames.size > 0, [...hostNames].join(", "));
  check("⛔⛔ no host appears in ANY heading",
    [...hostNames].every((h) => headings.every((x) => !x.includes(h))),
    "a finding whose most quotable sentence is a company name is an accusation wearing a measurement's clothes");
  check("⛔⛔ …nor in the <title>", [...hostNames].every((h) => !titleTag.includes(h)));
  check("⛔ …nor in the meta description a link preview would quote",
    [...hostNames].every((h) => !(html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "").includes(h)));
  check("⭐ …but the host IS still visible in the data, so nothing is hidden",
    [...hostNames].every((h) => html.includes(h)) && Boolean(pt.topHost?.host));
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

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("8 — ⭐⭐⭐ THREE READINGS: THE NUMBER THAT TESTS \"UNCHANGED ≠ STABLE\" IS DEFINED BEFORE IT EXISTS");
// ⛔ Written 2026-09-11 with TWO harvests on disk, for a third scheduled 2026-09-25. The counts are
// fixed by fixture here so the day the third reading lands nothing is re-derived: the command prints
// them, and this section is what says the command computes the right thing.
{
  // ⭐ Every ordered pair, so the interval question is answerable BOTH ways — and the last entry is
  // still the newest adjacent pair, which the bare /snapshot/diff redirect relies on.
  const three = pairsFor(["2026-09-25", "2026-08-27", "2026-09-11"]);
  check("⭐ three dates yield three pairs: both adjacent AND the span",
    JSON.stringify(three) === JSON.stringify(["2026-08-27..2026-09-11", "2026-08-27..2026-09-25", "2026-09-11..2026-09-25"]),
    three.join(" "));
  check("⭐ …and the LAST pair is the newest adjacent one, so NEWEST_PAIR keeps its meaning",
    three[three.length - 1] === "2026-09-11..2026-09-25");
  check("⭐ two dates still yield exactly one pair (today's live state is unchanged by this)",
    pairsFor(["2026-09-11", "2026-08-27"]).length === 1 && DIFF_PAIRS.length === 1, DIFF_PAIRS.join(","));

  // ⭐⭐ EVERY COUNTER GETS A DISTINCT VALUE — 1 / 2 / 5 / 4, with unchanged-all at 3 — because the
  // first draft had held == reverted == 1 and a mutation wiring bySpanPair to the WRONG counter stayed
  // green. Fixtures that agree cannot discriminate. Key 6 is absent from C and must not be counted.
  const S = Object.keys(SENTINELS).map((network) => ({ resource: "https://sentinel.test/x", network, asset: "u", scheme: "exact", payTo: "S", amount: "1" }));
  const mk = (id, payTo, amount = "1") => ({ resource: `https://x.test/${id}`, network: "eip155:8453", asset: "USDC", scheme: "exact", payTo, amount });
  const STATES = {           //  A    B    C
    1: ["a", "a", "a"],      //  unchanged across all three           (1 + 2 sentinels = 3)
    2: ["a", "a", "c"],      //  unchanged A..B then changed by C      (1)  ⭐ THE NUMBER
    3: ["a", "b", "b"], 7: ["a", "b", "b"],                                    // changed then held (2)
    4: ["a", "b", "a"], 8: ["a", "b", "a"], 9: ["a", "b", "a"], 13: ["a", "b", "a"], 14: ["a", "b", "a"], // reverted (5)
    5: ["a", "b", "c"], 10: ["a", "b", "c"], 11: ["a", "b", "c"], 12: ["a", "b", "c"],       // changed twice (4)
  };
  const at = (i) => Object.entries(STATES).map(([id, v]) => mk(id, v[i]));
  const A = { rows: [...at(0), mk(6, "a", "1"), ...S], listingsCollected: 15 };
  const B = { rows: [...at(1), mk(6, "a", "2"), ...S], listingsCollected: 15 };
  const C = { rows: [...at(2),                  ...S], listingsCollected: 14 };
  const s = stabilityAcrossThree(A, B, C, { labelA: "A", labelB: "B", labelC: "C" });
  check("⭐ the fixture passes the gate, so this section tests the counts and not the gate", s.computed === true);
  const p = s.payTo;
  const N = Object.keys(STATES).length;
  check("⭐ comparable = keys carrying a value in ALL THREE (key 6 is absent from C and does not count)",
    p.comparable === N + S.length, `comparable ${p.comparable}`);
  check("⭐ key 1 + sentinels: unchanged across all three is 3", p.unchangedAcrossAllThree === 3, String(p.unchangedAcrossAllThree));
  check("⭐⭐⭐ key 2: unchanged A..B then changed by C — THE NUMBER — is exactly 1", p.unchangedThenChanged === 1, String(p.unchangedThenChanged));
  check("⭐ changed then held is 2, and is NOT counted as misleading", p.changedThenHeld === 2, String(p.changedThenHeld));
  check("⭐⭐ equal at A and C, different at B — the span pair misled — is exactly 5", p.changedThenReverted === 5, String(p.changedThenReverted));
  check("⭐ changed twice is 4", p.changedTwice === 4, String(p.changedTwice));
  check("⭐ the five states partition the comparable keys, and the result says so", p.partitions === true);
  check("⭐ amounts are measured on the same join: key 6's amount change is not comparable (absent from C), so amount.unchangedThenChanged is 0",
    s.amount.unchangedThenChanged === 0 && s.amount.comparable === N + S.length, `${s.amount.unchangedThenChanged} / ${s.amount.comparable}`);
  check("⭐ pairMisled sums payTo + amount for each pair — 1 and 5, nothing else in the fixture has those values",
    s.pairMisled.byFirstPair === 1 && s.pairMisled.bySpanPair === 5,
    JSON.stringify({ f: s.pairMisled.byFirstPair, s: s.pairMisled.bySpanPair }));
  check("⭐ the examples name the key and both values, so a reader can go and look",
    p.examples.unchangedThenChanged[0]?.resource === "https://x.test/2" && p.examples.changedThenReverted[0]?.resource === "https://x.test/4");
  check("⛔ the result never says \"stable\"", !/\bstable\b/i.test(JSON.stringify(s).replace(/not stability|not \"stable\"/g, "")));
  // ⭐ Row ORDER within a reading is not a change (same regression as §5, one reading further).
  const Bshuf = { ...B, rows: [...B.rows].reverse() };
  const s2 = stabilityAcrossThree(A, Bshuf, C, {});
  check("⭐ reordering a reading's rows changes no count", JSON.stringify({ ...s2.payTo, examples: 0 }) === JSON.stringify({ ...p, examples: 0 }));
  // ⛔ The gate is the same gate: one filtered reading and NOTHING is computed.
  const Cf = { ...C, rows: C.rows.filter((r) => !(r.network in SENTINELS)) };
  const s3 = stabilityAcrossThree(A, B, Cf, { labelC: "C-filtered" });
  check("⛔ a filtered THIRD reading is refused — no payTo, no amount, no pairMisled", s3.computed === false && !("payTo" in s3) && !("pairMisled" in s3),
    s3.gate.refusal ?? "");

  // ⭐⭐ THE DAY'S COMMAND, RUN TODAY: it must refuse, fetch nothing, and write nothing.
  const dir = new URL("./x402-census/", import.meta.url);
  const filesBefore = readdirSync(dir).sort().join(",");
  const run = spawnSync(process.execPath, [new URL("./take-reading.mjs", dir).pathname], { encoding: "utf8", timeout: 20_000 });
  const today = new Date().toISOString().slice(0, 10);
  if (today < "2026-09-25") {
    check("⛔ before 2026-09-25 `npm run census:reading` exits 3 and says why", run.status === 3 && /not before 2026-09-25/.test(run.stderr), `exit ${run.status}`);
    check("⛔ …without invoking the harvester (no harvester banner in stdout)", !/harvest-index —/.test(run.stdout) && !/page +1/.test(run.stdout));
    check("⛔ …and the census directory is byte-for-byte the same file list", readdirSync(dir).sort().join(",") === filesBefore);
  } else {
    // ⚠️ On or after the day this suite must not run the harvester as a side effect of test:all.
    check("⚠️ on/after 2026-09-25 this suite does not exercise the live command (it would harvest); the wiring assertions in §0 take over", true);
  }
}

console.log(`\n${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail ? 1 : 0);
