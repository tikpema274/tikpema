// verify-deployed-custody.mjs — IS THE CUSTODY CLAIM ACTUALLY BEING SERVED? Read-only.
//
//   node scripts/verify-deployed-custody.mjs                 # against production
//   node scripts/verify-deployed-custody.mjs --dist dist     # against a local build
//   node scripts/verify-deployed-custody.mjs --url https://<deploy>--tikpema.netlify.app
//
// ⛔ MOVES NO MONEY, NEEDS NO SESSION, WRITES NOTHING. Two GETs: the page, then its JS bundle.
//
// ═══ ⭐ WHY THIS GATE EXISTS SEPARATELY ═════════════════════════════════════════════════════════
// `CustodyNotice` makes the ONE claim about money that every self-signed panel makes — caps do not
// apply — and it has THREE renderers (ManualSendPanel, ManualBridgePanel, ManualSwapPanel). The
// bundle layer covered one and a half of them: gate:manualswap names swap, gate:disclosure names
// bridge and never mentions the notice, and ManualSendPanel has no served-bundle gate at all.
// ⛔ Putting the fragment inside either existing gate would pin the sentence on behalf of two panels
// that gate does not name, and a red would be addressed to the wrong file. A GATE'S NAME IS ITS
// ADDRESS: this one failing means "the custody copy moved", which is true for all three at once.
// docs/self-signed-page-scope.md § addendum 2 §6.
//
// ⚠️ WHAT IT ADDS OVER THE SUITE, WHICH IS ONE THING ONLY. verify-custody-notice.tsx already asserts
// the wording, the token cases, the enum-leak absence, the three composed bindings and the page.
// This adds: THE CODE CARRYING THAT CLAIM IS WHAT IS BEING SERVED. Transitive, not observed — it
// does not execute React and does not watch anything paint. State it that way.
// [[binding-tested-across-what-it-binds]]
//
// ═══ 🚨 WHICH TWO BUILDS DOES THIS GATE TELL APART? — ASKED BEFORE IT WAS WRITTEN ════════════════
// A deploy check is only meaningful against an artifact it must FAIL on. So: what is the negative?
//
// ⛔ NOT the unification. Measured across the real deploys: the custody sentence is present in BOTH
// the pre-unification build (2026-08-30 13:55, index-CfsAYHNr.js — three inline copies) and the
// served one (one shared component). `Agent spending caps do not apply here` counts 2 then, 1 now.
// A fragment present in both builds is not evidence, so THIS IS NOT A UNIFICATION GATE and must not
// be read as one. [[a-deploy-check-needs-a-build-it-should-fail-against]]
//
// 🚨 AND THERE IS NO HISTORICAL BUILD WITHOUT THE SUBJECT. Every build back to index-foSNyN_9.js
// carries the claim in some form, so running this file against any old deploy produces a red that
// proves the fragments are NEW, not that they DISCRIMINATE. ⭐ The negative therefore has to be
// CONSTRUCTED: the served bundle with the custody literals removed — "the app, with this claim
// deleted", which is the actual failure this gate exists to catch. Reproduce it with:
//
//   node -e 'const fs=require("fs");let js=fs.readFileSync("dist/assets/index-<hash>.js","utf8");
//   for (const l of ["Agent spending caps do not apply here","not a limit on your own funds",
//     "You sign this yourself, with your own key, spending ","its spending caps do not bound them",
//     "Operations you sign yourself","caps do not bound these"]) js=js.split(l).join("<<GONE>>");
//   fs.mkdirSync("/tmp/synth/assets",{recursive:true});
//   fs.writeFileSync("/tmp/synth/assets/index-synth.js",js)'
//   node scripts/verify-deployed-custody.mjs --dist /tmp/synth     # must be RED, and must NOT abort
//
// ⭐ ONE assertion does have a real red build: the ABSENCE below. The swap panel's divergent
// sub-copy `this is your wallet and your money` counts 1 in CfsAYHNr and 0 now, so that check is
// calibrated against a genuine artifact rather than a constructed one.
//
// ═══ ⭐⭐ CALIBRATED FOUR WAYS — DEMONSTRATED, NOT ASSERTED (2026-08-31) ═════════════════════════
//   served prod D4ZeRpcr              exit 0 — 10/0.
//   CfsAYHNr 13:55, real prior build  exit 1 — control 3/3 PASSES and it does NOT abort; the three
//                                     custody-sentence checks PASS (they existed inline then), and
//                                     the page, the entry point and the absence go red. ⭐ That the
//                                     sentence passes here is the proof this is not a unification
//                                     gate — exactly as the section above says.
//   served minus the custody claim    exit 1 — control 3/3 passes, all six presence checks red.
//   (synthetic)                       ⭐⭐ THE DISCRIMINATING ROW: the gate reports the failure it
//                                     exists to catch, on an artifact where everything else is fine.
//   served minus the three host       exit 2 — ABORTS. The control can fail, so it is a control.
//   panels (synthetic)
//
// ⛔ AND WHAT THE THIRD ROW WOULD HAVE DONE WITH § addendum 2 §6's PROPOSED CONTROL: that synthetic
// strips `Operations you sign yourself` along with the rest of the claim — see it go red in that
// row's output. As a CONTROL it would have ABORTED at exit 2 there, reporting "not reading this app"
// about an artifact that is this app with the claim deleted. **The gate would have been silent in
// precisely its own failure case.** That is why a control must be disjoint from the subject.
//
// ⚠️ FRAGMENTS DERIVED FROM REAL BUILDS, NOT FROM SOURCE. A composed phrase never appears as one
// literal in a minified bundle: `spending your own funds` and `spending your own USDC` both count 0
// despite shipping, because the `token` ternary splits them. Every count below was read off an
// actual artifact.

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const DIST = arg("--dist");
const BASE = arg("--url", "https://app.tikpema.xyz");

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };

// ═══ ⭐⭐ THE CONTROL — AND BOTH READINGS ARE STATED, NEITHER IS INFERRED ═════════════════════════
// A control must satisfy TWO INDEPENDENT properties, and checking one and inferring the other is
// how this recurs: [[control-needs-ownership-and-stability]].
//   OWNERSHIP  — sole-owned within the surface under test, so it cannot be satisfied by an
//                unrelated component (gate:manualswap shipped a control owned by four panels, none
//                of them its subject — it passed with the subject deleted).
//   STABILITY  — present in BOTH builds, so it is the fixed point that makes a difference mean
//                something rather than being evidence of the difference.
//
// ⛔ AND A THIRD REQUIREMENT THIS GATE MADE VISIBLE: THE CONTROL MUST BE DISJOINT FROM THE SUBJECT.
// § addendum 2 §6 proposed `Operations you sign yourself` as the control here. Measured:
//   owners 1 [SelfSignedPanel.tsx] · CfsAYHNr 0 / served 1
// It fails stability outright — but the deeper problem is that it is PART OF THE SUBJECT, so it
// disappears in exactly the artifact this gate exists to judge, aborting instead of reporting the
// failure. ⭐ A control drawn from the subject can never witness the subject's absence. It has been
// demoted to a discriminator below, which is what it always was.
//
// ⭐ So the controls are the three HOST panels' own copy: they enclose the subject, they survive its
// removal, and each proves its panel is visible — which is what makes an absence about the notice
// in that panel non-vacuous. All three are labels, not claims: a claim is by definition the string
// someone will rewrite, which is why a claim is never a control.
const CONTROL = [
  // fragment                                     owners                    CfsAYHNr / served
  ["Check the address carefully.",                "ManualSendPanel.tsx",    "1 / 1"],
  ["Bridge from your own wallet",                 "ManualBridgePanel.tsx",  "2 / 2"],
  ["Check this before you sign",                  "ManualSwapPanel.tsx",    "1 / 1"],
];

// ⭐ Present because the claim is SERVED — not because the unification happened. Three of these
// count 2 in the pre-unification build and 1 now; the count is not asserted, only presence.
const MUST_BE_PRESENT = [
  ["⭐⭐ the custody claim itself", "Agent spending caps do not apply here", "CustodyNotice"],
  ["⭐ …and the REASON, not just the absence", "not a limit on your own funds", "CustodyNotice"],
  ["⭐ the user-signs half of the sentence", "You sign this yourself, with your own key, spending ", "CustodyNotice"],
  ["⭐ the page states the contrast in its OWN words", "its spending caps do not bound them", "SelfSignedPanel"],
  ["the page is named for the ACT", "Operations you sign yourself", "SelfSignedPanel"],
  ["⭐⭐ the ENTRY POINT shipped, not just the page", "caps do not bound these", "Dashboard"],
];

// ⭐ The one assertion with a REAL red build: present in CfsAYHNr (1), gone now (0).
const MUST_BE_ABSENT = [
  ["the swap panel's divergent custody sub-copy", "this is your wallet and your money", "ManualSwapPanel"],
];

async function main() {
  let js = "", where = "";
  if (DIST) {
    const { readdirSync, readFileSync } = await import("node:fs");
    const f = readdirSync(`${DIST}/assets`).find((x) => /^index-.*\.js$/.test(x));
    if (!f) { console.error(`no index-*.js in ${DIST}/assets`); process.exit(2); }
    js = readFileSync(`${DIST}/assets/${f}`, "utf8"); where = `${DIST}/assets/${f}`;
  } else {
    const html = await (await fetch(BASE, { headers: { "cache-control": "no-cache" } })).text();
    const m = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/);
    if (!m) { console.error(`could not find the JS bundle in ${BASE}`); process.exit(2); }
    js = await (await fetch(BASE + m[0], { headers: { "cache-control": "no-cache" } })).text();
    where = BASE + m[0];
  }
  console.log(`\n── custody claim · served artifact ──\n  ${where}  (${js.length.toLocaleString()} bytes)\n`);

  console.log("⭐⭐ CONTROL — are the three HOST panels visible? (each disjoint from the subject)");
  let controlOk = true;
  for (const [s, owner, both] of CONTROL) {
    const ok = js.includes(s); controlOk &&= ok;
    check(`"${s}"`, ok, `owner ${owner} · old/new ${both}`);
  }
  if (!controlOk) {
    console.log("\n⛔ ABORTING — a host panel is not visible, so the instrument is not reading this app.");
    console.log("   The absence check below would pass for free. No verdict is given.");
    process.exit(2);
  }

  console.log("\n⭐ THE CLAIM AND ITS PAGE ARE IN THE SERVED BUNDLE");
  for (const [label, s, owner] of MUST_BE_PRESENT) check(label, js.includes(s), `${owner} · "${s.slice(0, 40)}"`);

  console.log("\n⛔ THE DIVERGENT WORDING IS GONE");
  for (const [label, s, owner] of MUST_BE_ABSENT) check(`${label} removed`, !js.includes(s), `${owner} · "${s}"`);

  console.log(`\n${fail === 0
    ? "✅ ALL PASS — the custody claim and its page are being served"
    : "❌ NOT SERVED — the custody claim is not (fully) in this artifact"} — ${pass} passed, ${fail} failed.`);
  console.log(`⚠️ A BINDING, NOT AN OBSERVATION: this proves the served JS CONTAINS the claim. That it`);
  console.log(`  RENDERS is proven separately by verify-custody-notice.tsx against the same code.`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
