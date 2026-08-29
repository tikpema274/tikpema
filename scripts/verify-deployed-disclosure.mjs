// verify-deployed-disclosure.mjs — DID THE DISCLOSURE FIX ACTUALLY SHIP? Read-only.
//
//   node scripts/verify-deployed-disclosure.mjs                 # against production
//   node scripts/verify-deployed-disclosure.mjs --dist dist     # against a local build
//   node scripts/verify-deployed-disclosure.mjs --url https://<deploy>--tikpema.netlify.app
//
// ⛔ MOVES NO MONEY, NEEDS NO SESSION, WRITES NOTHING. Two GETs: the page, then its JS bundle.
//
// ═══ 🚨 WHY THIS EXISTS: A 0.0542 USDC FEE SPENT AGAINST AN UNSHIPPED FIX ══════════════════════
// The ack gate's first live firing cost a real fee and returned a disclosure with no numbers in it.
// The fix is committed. Spending a SECOND fee to discover the fix had not shipped would waste the
// run twice over — and "the deploy went green" does not answer the question, because green means a
// deploy landed, not that THIS copy is in the artifact being served.
//
// ⚠️ `gate:deployed` ALREADY BINDS BUILD IDENTITY (served tree hash == local tree hash, and `src/`
// is inside SURFACES so this change does move it). This file is deliberately NOT that check. It
// asserts the CONTENT of the served JavaScript, independently of the stamp — two instruments, not
// two reads of one. [[repeating-one-instrument-is-not-corroboration]]
//
// ═══ ⭐⭐ THE CONTROL COMES FIRST, AND WITHOUT IT THE WHOLE FILE IS VACUOUS ══════════════════════
// The decisive assertion is an ABSENCE: the old "This is a {band} disclosure" wording must be GONE.
// An absence passes for free against the wrong file — an SPA shell, a 404 body, a bundle that
// failed to fetch, the wrong asset. So the CONTROL asserts strings from this panel that did NOT
// change. If those are missing, the instrument cannot see this panel at all and every later verdict
// is meaningless, so the script ABORTS rather than reporting a pass.
// [[equality-passes-vacuously-on-empty]] · [[absence-must-never-read-as-safe]]
//
// ═══ ⚠️ THE HONEST LIMIT — THIS IS A BINDING, NOT AN OBSERVATION OF THE RENDER ══════════════════
// It proves the served bundle CONTAINS the new disclosure component and NOT the old one. It does
// not execute React and does not watch the box paint. The render itself is proven by
// `verify-manual-bridge-copy` §6, which renders FeeDisclosureBox with real numbers. The claim is
// transitive: §6 proves this code renders four figures; this file proves this code is what is
// served. State it that way — never as "the disclosure was observed rendering in production".
// [[binding-tested-across-what-it-binds]]
//
// ⚠️ THE SEARCH STRINGS WERE DERIVED FROM A REAL BUILD, not from the source. JSX collapses
// whitespace and minifiers rewrite everything except string literals, so "it is in the .tsx" does
// not imply "it is in the .js". Each fragment below was confirmed present in dist/assets/index-*.js.

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const DIST = arg("--dist");
const BASE = arg("--url", "https://app.tikpema.xyz");

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } return !!c; };

function abort(headline, detail) {
  console.error(`\n✖ ${headline}`);
  if (detail) console.error(`  ${detail}`);
  console.error(`\n  VERDICT: the check did not run. This is NOT evidence that the fix shipped,`);
  console.error(`  and it is NOT evidence that it did not. ⛔ DO NOT SPEND THE FEE on this reading.\n`);
  process.exit(2);
}

// ── obtain the served bundle ────────────────────────────────────────────────────────────────────
let bundle, whence;
if (DIST) {
  const { readFileSync, readdirSync } = await import("node:fs");
  const files = readdirSync(`${DIST}/assets`).filter((f) => /^index-.*\.js$/.test(f));
  if (files.length !== 1) abort(`expected exactly one index-*.js in ${DIST}/assets, found ${files.length}.`);
  bundle = readFileSync(`${DIST}/assets/${files[0]}`, "utf8");
  whence = `${DIST}/assets/${files[0]}`;
} else {
  const page = await fetch(BASE, { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(45_000) })
    .catch((e) => abort(`could not fetch ${BASE}`, String(e?.message ?? e)));
  if (!page.ok) abort(`${BASE} returned HTTP ${page.status}.`);
  const html = await page.text();
  // ⚠️ The asset name is content-hashed and changes every build, so it is READ from the page rather
  // than remembered. A hardcoded filename would silently check a stale artifact forever.
  const m = html.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
  if (!m) abort(`no /assets/index-*.js reference found in the served page.`,
    `Either the page is not the app shell, or the asset naming changed. Refusing to guess.`);
  const url = `${BASE}/assets/${m[1]}`;
  const res = await fetch(url, { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(60_000) })
    .catch((e) => abort(`could not fetch ${url}`, String(e?.message ?? e)));
  if (!res.ok) abort(`${url} returned HTTP ${res.status}.`);
  bundle = await res.text();
  whence = url;
}

console.log(`\nDISCLOSURE SHIPPED? — read-only · ${whence}`);
console.log(`  bundle ${bundle.length.toLocaleString()} chars\n`);

// ── ⭐⭐ CONTROL — can this instrument see the panel at all? ─────────────────────────────────────
// ⚠️ "Most of this amount would become fee." is in BOTH builds — the headline never changed — so it
// belongs HERE, as proof the instrument is looking at the right component, and NOT below as
// evidence of the fix. Misfiling it would have been a check that passes either way.
console.log("── CONTROL — copy present in BOTH the old and fixed builds ──");
const CONTROL = [
  "Bridge from your own wallet",
  "stay on this page until the burn confirms",
  "Most of this amount would become fee",
];
let controlOk = true;
for (const c of CONTROL) if (!check(`sees ${JSON.stringify(c.slice(0, 44))}`, bundle.includes(c))) controlOk = false;
if (!controlOk) {
  abort(`THE CONTROL FAILED — this artifact does not contain the manual bridge panel's copy.`,
    `Every assertion below would pass or fail for reasons having nothing to do with the fix. The ` +
    `absence checks in particular would pass VACUOUSLY against the wrong file.`);
}

// ═══ 🚨 EVERY FRAGMENT BELOW WAS TESTED AGAINST BOTH BUILDS ════════════════════════════════════
// The first draft of this file used three fragments that prove NOTHING, and only a red calibration
// against a genuinely pre-fix bundle exposed them:
//
//   "of what you are sending"  → in BOTH (the old sentence contains it too)
//   "would arrive"             → in BOTH — and in the old build it comes from a DIFFERENT
//                                component entirely (`indicativeNetUsdc` on the quote card)
//   "acknowledge disclosure"   → in NEITHER, so its absence could never fail: the old code
//                                INTERPOLATED the band (`This is a {ackBand} disclosure`), so that
//                                pair of words never existed as a literal in any bundle
//
// ⭐ A fragment that appears in both builds is not evidence, and an absence that can never occur is
// not a check. Each string below is confirmed present in exactly ONE of the two bundles.
// [[probe-must-discriminate-between-states]] · [[check-whose-failure-mode-is-a-pass]]
console.log("\n── ⭐ THE FIX — fragments present ONLY in the fixed build ──");
check("⭐⭐ renders the AMOUNT SENT", bundle.includes("You are sending"));
check("⭐⭐ renders the RATIO — the clause that immediately follows it",
  bundle.includes("sending — so only"), "the % sits between two literals; this is the one after it");
check("⭐⭐ renders what would ARRIVE, adjacent to the reason",
  bundle.includes("would arrive. A fee this large"));
check("⭐ …and states why consent is needed, not just that the fee is large",
  bundle.includes("A fee this large needs your explicit acceptance"));

console.log("\n── 🚨 THE OLD WORDING — fragments present ONLY in the pre-fix build ──");
for (const o of ["disclosure — the fee is a large share", "and what arrives will be much smaller"]) {
  check(`🚨 gone: ${JSON.stringify(o.slice(0, 46))}`, !bundle.includes(o),
    "meaningful only because the control passed");
}

console.log(`\n${"═".repeat(76)}`);
if (fail === 0) {
  console.log(`✅ THE FIX IS IN THE SERVED BUNDLE   pass ${pass} / fail 0`);
  console.log(`⭐ Safe to spend the fee — but read the limit: this proves the served JS CONTAINS the`);
  console.log(`  new disclosure and not the old. That it RENDERS four figures is proven separately by`);
  console.log(`  verify-manual-bridge-copy §6 against the same code. Transitive, not observed.`);
} else {
  console.log(`❌ THE FIX IS NOT (FULLY) IN THE SERVED BUNDLE   pass ${pass} / fail ${fail}`);
  console.log(`⛔ DO NOT SPEND THE FEE. A run now would repeat the wasted one.`);
}
console.log(`${"═".repeat(76)}\n`);
process.exit(fail === 0 ? 0 : 1);
