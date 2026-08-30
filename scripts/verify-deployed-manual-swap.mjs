// verify-deployed-manual-swap.mjs — DID THE MANUAL SWAP PANEL ACTUALLY SHIP? Read-only.
//
//   node scripts/verify-deployed-manual-swap.mjs                 # against production
//   node scripts/verify-deployed-manual-swap.mjs --dist dist     # against a local build
//   node scripts/verify-deployed-manual-swap.mjs --url https://<deploy>--tikpema.netlify.app
//
// ⛔ MOVES NO MONEY, NEEDS NO SESSION, WRITES NOTHING. Two GETs: the page, then its JS bundle.
//
// ═══ 🚨 WHY THIS EXISTS ════════════════════════════════════════════════════════════════════════
// The same reason as verify-deployed-disclosure: a live run costs a real fee, and spending it
// against an unshipped build wastes the run. "The deploy went green" means a deploy landed, not
// that THIS panel is in the artifact being served.
//
// ═══ ⭐⭐ THE CONTROL COMES FIRST, AND WITHOUT IT THE FILE IS VACUOUS ════════════════════════════
// One decisive assertion here is an ABSENCE (the old SwapPanel sub-copy must be GONE), and an
// absence passes for free against the wrong artifact — an SPA shell, a 404 body, a bundle that
// failed to fetch. So the CONTROL asserts strings present in BOTH the old and new builds. If those
// are missing, the instrument cannot see this app's panel copy at all and every later verdict is
// meaningless — so it ABORTS rather than reporting a pass.
// [[equality-passes-vacuously-on-empty]] · [[absence-must-never-read-as-safe]]
//
// ═══ ⭐ CALIBRATED AGAINST A BUILD IT MUST FAIL ═════════════════════════════════════════════════
// Every PRESENT fragment below was confirmed ABSENT from production's bundle at the time of
// writing (2026-08-30, index-foSNyN_9.js), and the ABSENT fragment confirmed PRESENT there. So this
// script is RED against pre-deploy production by construction — which is what makes a later green
// mean something. [[a-deploy-check-needs-a-build-it-should-fail-against]]
//
// ⚠️ FRAGMENTS DERIVED FROM A REAL BUILD, NOT FROM SOURCE. JSX collapses whitespace and minifiers
// rewrite everything except string literals. (One candidate for this file was initially written
// with the wrong leading case and appeared in NEITHER bundle — it was the search string, not the
// build. Confirm every fragment against dist/ before trusting it.)
//
// ═══ ⚠️ THE HONEST LIMIT — A BINDING, NOT AN OBSERVATION ════════════════════════════════════════
// This proves the served bundle CONTAINS this panel's copy. It does not execute React and does not
// watch anything paint. The render is proven by verify-manual-swap-copy (which renders SwapReview
// with real numbers); this proves that code is what is served. The claim is transitive — state it
// that way, never as "the review was observed rendering in production".
// ⛔ AND IT SAYS NOTHING ABOUT THE SERVER ENDPOINT. /api/user-swap-start needs a session, and a
// session needs SESSION_SECRET. This file is a bundle check only.

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const DIST = arg("--dist");
const BASE = arg("--url", "https://app.tikpema.xyz");

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };

// Present in BOTH the old and new builds. If these are missing we are not looking at this app.
const CONTROL = [
  "Swapping from",
  "Set up your wallet first",
  "spending caps do not apply here",
];
// New-build only. Each confirmed ABSENT from production before the deploy.
const MUST_BE_PRESENT = [
  ["the review's heading", "Check this before you sign"],
  ["⭐ the floor stated as a guarantee", "guaranteed at least"],
  ["⭐ the beneficiary is described as read from the BYTES", "Read from the transaction data itself, not from the quote"],
  ["⭐ a matching wallet is confirmed in words", "this is your wallet"],
  ["⭐ a MISMATCH is called out", "NOT your wallet"],
  ["the decode refuses in the user's language", "The swap could not be read"],
  ["the agent panel LINKS to its manual twin", "Swap from your own wallet instead"],
  ["the agent panel's title names WHICH wallet", "from your agent wallet, gasless"],
];
// Must be GONE — the old SwapPanel sub-copy, which did not distinguish the two wallets.
const MUST_BE_ABSENT = [["the old undistinguished swap copy", "from your wallet, gasless"]];

async function main() {
  let js = "", where = "";
  if (DIST) {
    const { readdirSync, readFileSync } = await import("node:fs");
    const f = readdirSync(`${DIST}/assets`).find((x) => /^index-.*\.js$/.test(x));
    if (!f) { console.error(`no index-*.js in ${DIST}/assets`); process.exit(2); }
    js = readFileSync(`${DIST}/assets/${f}`, "utf8"); where = `${DIST}/assets/${f}`;
  } else {
    const html = await (await fetch(BASE)).text();
    const m = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/);
    if (!m) { console.error(`could not find the JS bundle in ${BASE}`); process.exit(2); }
    js = await (await fetch(BASE + m[0])).text(); where = BASE + m[0];
  }
  console.log(`\n── manual swap panel · served artifact ──\n  ${where}  (${js.length} bytes)\n`);

  console.log("⭐⭐ CONTROL — can this instrument see the app's panel copy at all?");
  let controlOk = true;
  for (const c of CONTROL) { const ok = js.includes(c); controlOk &&= ok; check(`control present: "${c}"`, ok); }
  if (!controlOk) {
    console.log("\n⛔ ABORTING — the control failed, so the instrument is not reading this app's bundle.");
    console.log("   Every assertion below would be an ABSENCE passing for free. No verdict is given.");
    process.exit(2);
  }

  console.log("\n⭐ THE NEW PANEL IS IN THE SERVED BUNDLE");
  for (const [label, s] of MUST_BE_PRESENT) check(label, js.includes(s), `"${s.slice(0, 46)}"`);

  console.log("\n⛔ THE OLD COPY IS GONE");
  for (const [label, s] of MUST_BE_ABSENT) check(`${label} removed`, !js.includes(s), `"${s}"`);

  console.log(`\n${fail === 0 ? "✅ ALL PASS — this build is serving the manual swap panel" : "❌ NOT SERVING IT — do not spend a fee against this build"} — ${pass} passed, ${fail} failed.`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
