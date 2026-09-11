#!/usr/bin/env node
// harvest-index.mjs — RE-HARVEST the Circle x402 Discovery index, self-checked, discard-on-fail.
//
//   node scripts/x402-census/harvest-index.mjs        # writes circle-index-<date>.harvest.json
//
// ═══ 🚨 NO `siwx` PARAMETER. THIS IS THE WHOLE METHOD. ════════════════════════════════════════
// `circle services search` silently appends `siwx=false`. It is NOT in the CLI's --help; it is
// visible only by reading the CLI's own dist/index.js. On 2026-08-27 that one undeclared parameter
// hid **165 of 1,003 listings — including EVERY TESTNET ROW**.
// ⛔ Do NOT "simplify" this to the CLI, and do NOT add siwx in either direction. A filtered harvest
// produces a DIFFERENT DENOMINATOR and gives no signal that it changed; the counts still look
// plausible. Fetch the API directly, with only `limit` and `offset`.
//
// ═══ ⭐⭐ DISCARD-ON-FAIL, NOT WARN-ON-FAIL ════════════════════════════════════════════════════
// If the testnet self-check does not pass, this writes NOTHING and exits non-zero. A harvest that
// warns and writes anyway becomes the file somebody publishes six months later, warning unread.
// The two sentinel networks must BOTH appear, because they are exactly the rows siwx=false removes.
//
// ═══ ⭐ ONE IMPROVEMENT OVER THE 2026-08-27 RUN, RECORDED AS SUCH ══════════════════════════════
// That harvest noted: "read no `total` field and stopped on a short page, so NO per-page total was
// observed… this file cannot say whether the index drifted during its own harvest." This run LOOKS
// for a total on every page and records what it found — including "absent", which is itself the
// answer to whether the API offers one.
//
// ⚠️ SHAPE IS LOAD-BEARING — AND SO IS THE BYTE CONTENT OF EVERY FIELD. Rows are projected to the
// SAME keys AND THE SAME VALUES as circle-index-2026-08-27 so the two are diffable. See the payTo
// comment below for what one line of "tidying" did to the first attempt at this file.

import { writeFileSync, existsSync } from "node:fs";

const BASE = "https://api.circle.com/v2/x402/discovery/resources";
const PAGE = 100;
const SENTINELS = { "eip155:84532": "Base Sepolia", "eip155:80002": "Polygon Amoy" };
const startedAt = new Date().toISOString();
const date = startedAt.slice(0, 10);
const OUT = new URL(`./circle-index-${date}.harvest.json`, import.meta.url).pathname;

if (existsSync(OUT)) {
  console.error(`✖ ${OUT} already exists. A snapshot is dated and immutable — refusing to overwrite.`);
  process.exit(2);
}

const listings = [];
const totalsSeen = [];
let pages = 0, offset = 0, exhausted = false;

console.log(`harvest-index — ${BASE}\n  limit=${PAGE}, NO siwx parameter, paginating to a short page\n`);

for (;;) {
  const url = `${BASE}?limit=${PAGE}&offset=${offset}`;
  let res, body;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(45_000) });
    body = await res.json();
  } catch (e) {
    console.error(`✖ page ${pages + 1} failed: ${e?.message}. NOTHING WRITTEN — a partial harvest is a wrong denominator.`);
    process.exit(2);
  }
  if (!res.ok) {
    console.error(`✖ page ${pages + 1} → HTTP ${res.status}. NOTHING WRITTEN.`);
    process.exit(2);
  }
  const d = body.data ?? body;
  const got = d.items ?? d.resources ?? (Array.isArray(d) ? d : []);
  // ⭐ Look for a total wherever it might live, and record ABSENT as a finding rather than a blank.
  const t = body.total ?? d.total ?? body.pagination?.total ?? d.pagination?.total ?? null;
  totalsSeen.push(t ?? "absent");
  pages++;
  listings.push(...got);
  process.stdout.write(`  page ${String(pages).padStart(2)}  offset ${String(offset).padStart(4)}  +${got.length}  (total field: ${t ?? "absent"})\n`);
  offset += got.length;
  if (got.length < PAGE) { exhausted = true; break; }
  if (pages > 60) { console.error("✖ paging cap hit — refusing to guess at the tail. NOTHING WRITTEN."); process.exit(2); }
}

// ── project to the 2026-08-27 row shape, exactly ─────────────────────────────────────────────
const rows = [];
for (const it of listings) {
  for (const a of it.accepts ?? []) {
    const extra = a.extra ?? null;
    rows.push({
      resource: it.resource ?? null,
      // ⛔⛔ DO NOT NORMALISE CASE. The first run of this script lowercased payTo "for tidiness".
      // Base58 is CASE-SENSITIVE, so that CORRUPTED all 1,087 Solana payouts; and 2026-08-27 stored
      // EVM addresses checksummed, so it broke those too. The self-check still passed — the counts
      // were right — and the damage showed up only in the DIFF, where 110 of 111 payout addresses
      // read as "gone" and 127 of 128 as "new". A catalog-wide payout rotation that never happened.
      // ⭐ A projection must PRESERVE, not improve. Normalise at COMPARE time, never at harvest time.
      payTo: a.payTo ?? a.recipient ?? null,
      network: a.network ?? null,
      amount: a.maxAmountRequired ?? a.amount ?? null,
      asset: a.asset ?? null,
      scheme: a.scheme ?? null,
      extraNameState: !extra ? "no-extra" : (extra.name ? "name-present" : "extra-without-name"),
      extraName: extra?.name ?? null,
    });
  }
}

// ── ⭐⭐ THE SELF-CHECK. Both sentinels or nothing is written. ────────────────────────────────
const net = {};
for (const r of rows) net[r.network] = (net[r.network] || 0) + 1;
const missing = Object.entries(SENTINELS).filter(([caip]) => !(net[caip] > 0));

console.log(`\n  listings ${listings.length} · accepts rows ${rows.length} · networks ${Object.keys(net).length}`);
for (const [caip, name] of Object.entries(SENTINELS)) {
  console.log(`  sentinel ${name.padEnd(14)} ${caip.padEnd(16)} ${net[caip] ?? 0} rows  ${net[caip] > 0 ? "✅" : "❌"}`);
}

if (missing.length) {
  console.error(`\n✖ SELF-CHECK FAILED — ${missing.map(([, n]) => n).join(" and ")} absent.`);
  console.error("  A testnet-free harvest is the siwx=false signature. The denominator is wrong.");
  console.error("  NOTHING WRITTEN. Fix the fetch rather than publishing the count.");
  process.exit(1);
}

writeFileSync(OUT, JSON.stringify({
  _what: `Circle x402 discovery index, harvested ${date}, ALL networks. A projection — see _droppedFields and _cannotAnswer.`,
  _why: "Second dated reading, to sit alongside circle-index-2026-08-27 and make a DIFF possible. Never replaces it.",
  source: `${BASE}?limit=${PAGE}&offset=N — fetched DIRECTLY.`,
  _siwx: "NO siwx parameter sent, in either direction. The CLI appends siwx=false, which on 2026-08-27 hid 165 of 1,003 listings INCLUDING EVERY TESTNET ROW. The sentinel counts below are the proof this harvest was unfiltered.",
  harvestedAt: startedAt,
  harvesterStampedItself: true,
  listingsCollected: listings.length,
  acceptsRows: rows.length,
  pagination: {
    pages, exhausted, pageSize: PAGE,
    totalFieldPerPage: totalsSeen,
    _provenance: totalsSeen.every((t) => t === "absent")
      ? "The API returned NO `total` on any page — checked this run, unlike 2026-08-27 which simply did not look. So this file still cannot say whether the index drifted mid-harvest; the difference is that the absence is now MEASURED rather than unexamined."
      : "A per-page total WAS observed; see totalFieldPerPage. Compare against listingsCollected before trusting the count.",
  },
  selfCheck: { sentinels: SENTINELS, observed: Object.fromEntries(Object.keys(SENTINELS).map((k) => [k, net[k] ?? 0])), passed: true },
  _droppedFields: [
    "description — free text",
    "extensions — bazaar/builder-code/sign-in-with-x blocks incl. full JSON Schemas (the bulk of the payload)",
    "quality, lastUpdated, type, x402Version (per item)",
    "accepts[].currency, accepts[].maxTimeoutSeconds",
    "accepts[].extra fields OTHER than `name`",
    "metadata (per item)",
  ],
  _cannotAnswer: [
    "anything about extensions — bazaar presence, builder codes, input/output schemas",
    "x402 protocol version per item",
    "EIP-712 domain extra.version or Gateway receiverAuthorizer — only extra.name was kept",
    "freshness/ordering questions needing lastUpdated",
  ],
  rows,
}, null, 1) + "\n");

console.log(`\n✅ SELF-CHECK PASSED — written to ${OUT}`);
console.log(`   ⚠️ This is a SECOND dated reading. It does not replace 2026-08-27; the pair is the point.`);
