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
//
// ═══ 🚨 ONE OF THESE PASSES BY COINCIDENCE — READ THIS BEFORE EDITING CustodyNotice ═════════════
// `spending caps do not apply here` was chosen as a control on 2026-08-30, when THREE panels each
// carried that sentence inline. Later the same day they were unified into `CustodyNotice`, whose
// wording is "Agent spending caps do not apply here" — which HAPPENS to contain the control as a
// substring. ⭐ The control therefore still passes, but it passes for a reason NOBODY CHOSE: it now
// depends on a shared component this gate does not otherwise mention, was never written to check,
// and whose text is owned by a different suite entirely.
//
// ⛔ THE CONSEQUENCE, WHICH IS THE POINT OF THIS NOTE: EDIT CustodyNotice'S SENTENCE AND THIS GATE
// GOES RED — reporting "cannot see the app's panel copy", i.e. aborting before it judges anything —
// while the SWAP PANEL IT NAMES IS PERFECTLY FINE. A reader would chase a defect in the wrong file.
// ⚠️ A control that can be satisfied from a source outside the thing it is controlling for is not
// really a control; it is a coincidence that has not failed yet.
//
// ⭐ THE FIX IS NOT TO WEAKEN IT. Replace this entry with a fragment that belongs to the SWAP PANEL
// and predates this change (the other two controls already do), or let the custody sentence be
// owned by a gate of its own — scoped in docs/self-signed-page-scope.md, deliberately not built.
// [[a-deploy-check-needs-a-build-it-should-fail-against]]
//
// ═══ ⭐⭐ AND A SECOND ONE COULD NEVER FAIL CORRECTLY AT ALL — FIXED 2026-08-31 ═══════════════════
// `Set up your wallet first` sat in this list until 2026-08-31. Its owners are BridgePanel,
// SendPanel, SwapPanel and VaultPanel — and NOT ManualSwapPanel, which guards with
// WalletGuardNotice. So it was not merely ALSO satisfiable from outside its subject; it was
// satisfiable ONLY from outside it. ⛔ Delete ManualSwapPanel.tsx and it still passed, at count 4,
// in BOTH builds — licensing the vacuous-absence check below on the strength of three panels that
// have nothing to do with swapping. The coincidental control above is a coincidence that has not
// failed yet; this one never could.
//
// ⭐ REPLACED BY THE TAIL OF THE SAME SENTENCE, which is swap-only. Measured both ways:
//     "Set up your wallet first"   4 owners, none the subject   · foSNyN_9 4 / served 4
//     "come back here to swap"     1 owner, SwapPanel.tsx       · foSNyN_9 1 / served 1
//   It goes to 0 if SwapPanel.tsx is deleted, so it can fail for the right reason.
//
// ⭐ DEMONSTRATED, NOT ASSERTED — three readings, 2026-08-31:
//     served prod (D4ZeRpcr)        → exit 0, 12/0
//     foSNyN_9 (panel not yet built)→ exit 1: control 3/3 PASSES, then 9 red. "NOT SERVING IT" —
//                                     which is the truth. It does NOT abort, and must not.
//     served prod minus SwapPanel's → exit 2: ABORTS. `come back here to swap` 0, while
//     literals (synthetic)            `Set up your wallet first` is still 3 and would have passed.
//   ⛔ That last row is the whole point: the string this replaced could not tell the two apart.
//
// ⚠️ AND DELIBERATELY NOT `Swapping from ` WITH THE TRAILING SPACE, which IS sole-owned by
// ManualSwapPanel — one character is the whole difference between a two-owner fragment and a
// one-owner one. It counts 0 in foSNyN_9, because that panel did not exist there: the same
// character that makes it cleanly owned makes it NEW-BUILD-ONLY. In this block it would abort with
// "cannot see the app's panel copy" against a build where the panel had simply not shipped — a
// fresh instance of this file's own defect, in the act of fixing it.
//
// ⭐⭐ THE RULE, so the next one is prevented rather than described: CONTROLS WANT STABILITY,
// DISCRIMINATORS WANT VOLATILITY — and a CLAIM sentence is by definition the string someone will
// rewrite. That is why the third entry below was wrong the day it was written, before CustodyNotice
// existed. Reach for a LABEL owned by the subject's own render path, never for a claim.
// docs/self-signed-page-scope.md § addendum 2 · [[a-deploy-check-needs-a-build-it-should-fail-against]]
const CONTROL = [
  "Swapping from",                   // SwapPanel + ManualSwapPanel — both the swap surface, both builds
  "come back here to swap",          // ⭐ SwapPanel only, both builds — see the block above
  "spending caps do not apply here", // 🚨 the coincidental one — see the block above
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
