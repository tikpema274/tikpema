// verify-ofac-screen.mjs — the deterministic OFAC SDN screen: a FACT, tri-state, never a silent clear.
//
//   node scripts/dd/verify-ofac-screen.mjs
//
// The screen must: match a listed address (case-insensitively), report a negative WITH its snapshot
// date AND completeness (a partial-list negative is not a clearance), refuse to screen a malformed
// address (unreadable, not "not listed"), and be DETERMINISTIC + reproducible from the pinned list.

import { screenOfac, ofacVerdict, OFAC_STATUS } from "../../shared/onchain-analyze/ofac.mjs";
import { OFAC_SDN } from "../../shared/onchain-analyze/ofac-sdn.2026-09-16.mjs";
import { baseReport, SCHEMA_VERSION } from "../../shared/onchain-analyze/schema.mjs";
import { canonicalize } from "../../shared/onchain-analyze/attest.mjs";

let pass = 0, fail = 0;
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const ok = (l, c, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${l}${x ? ` — ${x}` : ""}`); };

// ⭐ INDEPENDENT literal — a real Tornado Cash SDN address, NOT read back from OFAC_SDN. If the screener
// ignored the list (or the snapshot were swapped out from under it), this flips to not-listed and fails.
const LISTED = "0x722122df12d4e14e13ac3b6895a86e84145b6967";

section("1 — a LISTED address is a match, and the fact says so");
{
  // Guard the guard: the independent literal really is in the pinned snapshot (else this test is vacuous).
  ok("⭐ the independent literal is present in the pinned list (non-vacuity)", OFAC_SDN.addresses.has(LISTED), LISTED);
  const r = screenOfac(LISTED);
  ok("⭐ status is 'listed'", r.status === OFAC_STATUS.LISTED, r.status);
  ok("⭐ it names the list and the snapshot date", r.list === OFAC_SDN.list && r.snapshot === OFAC_SDN.snapshot, `${r.list} @ ${r.snapshot}`);
  ok("⭐⭐ the verdict STOPs (a buyer cannot allow a sanctioned address)", ofacVerdict(r).stop === true && ofacVerdict(r).indeterminate === false);
}

section("2 — case-insensitive (EVM equality); checksummed input matches");
{
  const upper = "0x" + LISTED.slice(2).toUpperCase();
  ok("⭐ UPPERCASE form of a listed address still matches", screenOfac(upper).status === OFAC_STATUS.LISTED, upper);
  ok("⭐ mixed/whitespace form matches too", screenOfac(`  ${LISTED}  `).status === OFAC_STATUS.LISTED);
}

section("3 — a NOT-LISTED address carries the snapshot date AND completeness (a partial negative is not a clearance)");
{
  const clean = "0x000000000000000000000000000000000000dEaD";
  const r = screenOfac(clean);
  ok("⭐ status is 'not-listed'", r.status === OFAC_STATUS.NOT_LISTED, r.status);
  ok("⭐ the note carries the snapshot date", r.note.includes(OFAC_SDN.snapshot), r.note.slice(0, 60));
  ok("⛔ listComplete reflects the pinned list's completeness", r.listComplete === (OFAC_SDN.complete === true));
  // ⭐⭐ the WHOLE POINT: a negative against a PARTIAL list must NOT read as a clearance.
  ok("⭐⭐ a partial-list negative is INDETERMINATE, not a clearance", OFAC_SDN.complete === true
    ? (ofacVerdict(r).stop === false && ofacVerdict(r).indeterminate === false)
    : (ofacVerdict(r).stop === false && ofacVerdict(r).indeterminate === true),
    `complete=${OFAC_SDN.complete} verdict=${JSON.stringify(ofacVerdict(r))}`);
}

section("4 — a MALFORMED address is UNREADABLE, never 'not listed' (could-not-tell must not clear)");
{
  for (const bad of ["not-an-address", "0x123", "", null, undefined, "0xZZZ...", "0x" + "g".repeat(40)]) {
    const r = screenOfac(bad);
    ok(`⭐ ${JSON.stringify(bad)} → unreadable`, r.status === OFAC_STATUS.UNREADABLE, r.status);
  }
  ok("⭐⭐ an unreadable subject STOPs (indeterminate) — never a silent not-listed", ofacVerdict(screenOfac("nope")).stop === true && ofacVerdict(screenOfac("nope")).indeterminate === true);
}

section("5 — DETERMINISTIC: same input → same fact, twice");
{
  const a = screenOfac(LISTED), b = screenOfac(LISTED);
  ok("⭐ identical facts on repeat", JSON.stringify(a) === JSON.stringify(b));
}

section("6 — the fact never omits the list identity (a missing field reads as safe)");
{
  const r = screenOfac(LISTED);
  ok("⭐ list, snapshot, source, count, listComplete, status all present", ["list", "snapshot", "source", "count", "listComplete", "status"].every((k) => k in r), Object.keys(r).join(","));
}

section("7 — ⛔ a MALFORMED sanctions fact does NOT clear (the verdict's own fail-closed)");
{
  ok("⭐ missing status → stop", ofacVerdict({}).stop === true && ofacVerdict({}).indeterminate === true);
  ok("⭐ null → stop", ofacVerdict(null).stop === true);
}

section("8 — ⭐ WIRED INTO THE REPORT: sanctions rides on baseReport and is SIGNED (in canon)");
{
  const rpt = baseReport({ address: LISTED, chainId: 5042002, chainName: "arc-testnet", blockNumber: 100 });
  ok("⭐ every report carries a `sanctions` fact", rpt.sanctions?.status === OFAC_STATUS.LISTED, rpt.sanctions?.status);
  ok("⭐ it is the SAME fact the standalone screen produces", JSON.stringify(rpt.sanctions) === JSON.stringify(screenOfac(LISTED)));
  ok("⭐ schemaVersion bumped to 0.3.0 (a report asserting sanctions is a DIFFERENT claim)", SCHEMA_VERSION === "onchain-analyze/0.3.0", SCHEMA_VERSION);

  // ⭐⭐ THE SIGNING PROPERTY: canon excludes only `reads` and `attestation`. sanctions must be INSIDE
  // the signed bytes, so a signature vouches for the exact pinned list version (via ddTree). Prove it
  // by content, not by trusting the exclusion list.
  const canon = canonicalize(rpt);
  ok("⭐⭐ sanctions IS inside the signed canon (status present)", canon.includes(`"status":"${OFAC_STATUS.LISTED}"`), null);
  ok("⭐⭐ …and the snapshot date is signed too (binds the list VERSION)", canon.includes(OFAC_SDN.snapshot));
  ok("⭐ a clean subject's negative is ALSO signed with its snapshot", canonicalize(baseReport({ address: "0x000000000000000000000000000000000000dEaD", chainId: 5042002, chainName: "arc", blockNumber: 1 })).includes(OFAC_SDN.snapshot));
}

console.log(`\n╔══════════════════════════════════════════════════════════════════════`);
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log(`╚══════════════════════════════════════════════════════════════════════`);
process.exit(fail === 0 ? 0 : 1);
