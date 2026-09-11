// verify-built-index.mjs — /built renders, and it does not quote a figure that has moved.
//
//   node scripts/verify-built-index.mjs      (also: npm run test:builtindex)
//
// ═══ 🚨 WHY THIS EXISTS: /built 502'd PRODUCTION AND NOTHING LOCAL COULD SEE IT ════════════════
// `988f8fc` added a Snapshot entry to `ENTRIES` with an `href:` key instead of `links:`. `page()`
// does `e.links.length`, so the whole page threw `Cannot read properties of undefined` — not one
// broken section, a 502 on the entire index.
//
// ⛔ IT SURVIVED test:all AND A PUSH. /built had NO local test at all: its only check was
// `gate:deployed`'s HTTP probe, which runs AFTER the deploy. So the cheapest possible failure —
// a missing key in a literal, catchable by rendering the page once — cost a live outage and a
// second deploy cycle. THAT is the gap this file closes, not the one typo.
//
// ═══ ⭐⭐ AND THE SECOND DEFECT WAS QUIETER THAN THE 502 ════════════════════════════════════════
// That same entry hard-coded "1,003 listings … 25 hosts". Fifteen days later /snapshot served
// 1,162 and 48. The index page describing what exists would have been describing something that
// no longer did — and unlike the 502, nothing would ever have alerted anybody.
// ⭐ The fix is structural: the entry is DERIVED from snapshot.mjs's exported SNAPSHOTS. §2 asserts
// the derivation, so re-inlining the numbers to "keep built.mjs self-contained" turns this red.
//
// Zero network. Zero money.

import builtHandler, { validateEntries, REQUIRED_ENTRY_KEYS, page } from "../netlify/functions/built.mjs";
import { SNAPSHOTS, DATES, LATEST } from "../netlify/functions/snapshot.mjs";
import { handler as snapshotHandler } from "../netlify/functions/snapshot.mjs";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

// ⛔ A THROWN RENDER MUST BE A REPORTED FAILURE, NOT A CRASHED SUITE. The 502 this file exists for
// makes page() throw; if that killed the runner, the output would be a stack trace with no ❌ and
// no pass/fail line — indistinguishable to a CI log parser from a suite that never ran.
let res = null, renderError = null, html = "";
try { res = await builtHandler(); html = await res.text(); }
catch (e) { renderError = e; }
const src = readFileSync("netlify/functions/built.mjs", "utf8");
// ⚠️ SOURCE ASSERTIONS READ CODE, NOT COMMENTS. The first draft of the `e.links?.` check matched
// its OWN warning comment in built.mjs and went red on a correct file — the second time a marker
// in this repo has been caught by prose it was written to explain. Strip whole-line comments.
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sections = [...html.matchAll(/<section>([\s\S]*?)<\/section>/g)].map((m) => m[1]);
const n = (x) => Number(x).toLocaleString("en-GB");

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  /built — it renders, and it does not quote a number that has moved  ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("0 — ⛔ IT RENDERS AT ALL (the assertion that was missing)");
check("⭐⭐⭐ the handler returned 200 rather than throwing", res?.status === 200,
  renderError ? `THREW: ${renderError.message}` : `status ${res?.status}`);
check("⭐ the page is substantial", html.length > 4000, `${html.length} bytes`);
check("⭐⭐ every entry produced a section — a thrown map yields none", sections.length >= 6, `${sections.length} sections`);
check("⭐ each section has a heading, a state line and a body",
  sections.every((s) => /<h2>/.test(s) && /class="state"/.test(s) && /<p>/.test(s)));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — 🚨 A MALFORMED ENTRY IS REFUSED LOUDLY, NOT RENDERED HALF-WAY");
// ⛔ The temptation after a 502 is `e.links?.length`. That would have shipped a 200 with an entry
// silently missing its links — the same defect wearing a success code. The contract is REQUIRED
// keys and a loud throw, and this asserts the throw rather than the absence of a crash.
// ⭐⭐ RUN THE VALIDATOR, DO NOT GREP FOR IT. The first draft asserted the loop's source text and
// stayed GREEN when the whole loop was neutered with `if (false)` — a guard pinned to location, not
// behaviour. These feed it the exact entry shape that caused the outage.
const threw = (entries) => { try { validateEntries(entries); return false; } catch { return true; } };
const OK = { title: "t", state: "s", body: "b", links: [] };
check("⭐⭐ a valid entry passes — the validator is not simply always-throwing",
  !threw([OK, { ...OK, title: "u" }]));
check("⭐⭐⭐ THE EXACT OUTAGE: an entry with `href` and no `links` is REFUSED",
  threw([OK, { title: "Snapshot", state: "x", body: "y", href: "/snapshot/2026-08-27" }]),
  "this shape 502'd /built in production");
for (const k of REQUIRED_ENTRY_KEYS) {
  const bad = { ...OK }; delete bad[k];
  check(`⭐ a missing \`${k}\` is refused`, threw([bad]));
}
check("⭐⭐ a non-array `links` is refused too, not just an absent one",
  threw([{ ...OK, links: "/snapshot/2026-08-27" }]));
check("⭐ `links` is in the declared contract", REQUIRED_ENTRY_KEYS.includes("links"));
// ⭐⭐⭐ THE WIRING, NOT THE FUNCTION. Everything above proves validateEntries refuses bad input;
// none of it would notice the CALL to it being commented out, leaving the validator alive and the
// render unguarded. Only rendering a bad list covers that.
{
  // ⛔⛔ "page() threw" IS NOT THE ASSERTION. With the validateEntries call commented out, page()
  // STILL throws on this input — a TypeError from `e.links.length`, the original 502. The first
  // draft of this check went green on exactly the mutation it was written to catch, because both
  // states produce a throw. Name the error, or the probe cannot discriminate.
  let rendered = null, msg = "";
  try { rendered = page([{ title: "Snapshot", state: "x", body: "y", href: "/snapshot/2026-08-27" }]); }
  catch (e) { msg = e.message; }
  check("⭐⭐⭐ page() refuses the bad entry with the VALIDATOR's error, not a TypeError",
    /^built\.mjs: ENTRIES\[0\]/.test(msg) && /missing `links`/.test(msg),
    rendered ? `rendered ${rendered.length} bytes instead of throwing` : `threw: ${msg}`);
  check("⭐ …and page() still renders a GOOD list, so the check is not vacuous",
    typeof page([OK]) === "string" && page([OK]).includes("<section>"));
}
check("⛔ the render does NOT paper over a missing links with optional chaining",
  !/e\.links\?\./.test(code),
  "a 200 with a section quietly missing its links is the same bug wearing a success code");
check("⭐ …and the array-ness is checked too, not just presence", /!Array\.isArray\(e\.links\)/.test(code));
check("⛔ the dead `href:` key that caused it is gone", !/^\s*href:/m.test(code),
  "page() never read href — it looked like a link and rendered nothing");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⭐⭐ THE SNAPSHOT ENTRY IS DERIVED, SO IT CANNOT GO STALE");
const S = SNAPSHOTS[LATEST];
const snapSection = sections.find((s) => /Snapshot —/.test(s));
check("⭐ there is a snapshot entry to be about", Boolean(snapSection));
check("⭐⭐ built.mjs IMPORTS the snapshot data rather than restating it",
  /import \{ SNAPSHOTS, DATES, LATEST \} from "\.\/snapshot\.mjs"/.test(code));
for (const [label, v] of [["listings", S.totals.listings], ["accepts rows", S.totals.acceptsRows],
                          ["hosts", S.totals.distinctHosts], ["URLs", S.totals.distinctResourceUrls]]) {
  check(`⭐⭐ the entry states the CURRENT ${label}`, snapSection.includes(n(v)), String(v));
}
// ⛔ THE MUTATION THIS EXISTS FOR: the fortnight-old figures must NOT still be on the page.
const stale = SNAPSHOTS[DATES[0]].totals;
check("⛔⛔ …and NOT the superseded ones from the first reading",
  !snapSection.includes(n(stale.distinctHosts)) && !snapSection.includes(n(stale.listings)),
  `${stale.listings} listings / ${stale.distinctHosts} hosts must not appear`);
check("⭐ the entry names the newest capture date", snapSection.includes(S.capturedAt));
check("⭐ …and says the earlier reading still stands unedited",
  /unedited/.test(snapSection) && /never overwrites/.test(snapSection));
check("⭐⭐ Arc's zero is carried through from the data, not asserted here",
  snapSection.includes(`Arc: ${S.arc.rows}`) && S.arc.rows === 0);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐ EVERY SNAPSHOT LINK RESOLVES TO A SNAPSHOT THAT EXISTS");
// ⛔ A link on an index page is a promise. /built listing a date the function 404s is exactly the
// drift this page was written to refuse.
{
  const hrefs = [...html.matchAll(/href="(\/snapshot\/[^"]+)"/g)].map((m) => m[1]);
  check("⭐ there are snapshot links to check", hrefs.length >= DATES.length, `${hrefs.length} links`);
  check("⭐⭐ every dated snapshot has a link", DATES.every((d) => hrefs.includes(`/snapshot/${d}`)),
    DATES.join(", "));
  let allOk = true, detail = "";
  for (const h of hrefs) {
    const r = await snapshotHandler({ path: h.replace(/\?.*$/, ""), queryStringParameters: {} });
    if (r.statusCode !== 200) { allOk = false; detail += `${h}→${r.statusCode} `; }
  }
  check("⭐⭐ each one actually 200s through the real handler", allOk, detail || `${hrefs.length} checked`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⛔ NO ENTRY LOST ITS LINKS ON THE WAY TO THE PAGE");
// ⭐ The failure mode optional chaining would have produced: a section renders, its links do not.
{
  const withLinks = sections.filter((s) => /class="links"/.test(s)).length;
  const withNote = sections.filter((s) => /class="note"/.test(s)).length;
  check("⭐ most entries render a links paragraph", withLinks >= sections.length - 2,
    `${withLinks}/${sections.length} sections have links`);
  check("⭐ an entry with nothing to visit says so instead", withNote >= 1, `${withNote} note(s)`);
  check("⛔ no rendered link is empty or undefined",
    !/href="undefined"/.test(html) && !/<a href="">/.test(html));
}

console.log(`\n${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail ? 1 : 0);
