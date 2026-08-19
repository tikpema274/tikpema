// verify-disclosure-render.tsx — DOES THE BUYER ACTUALLY SEE THE DATA DISCLOSURE?
//
//   npx tsx scripts/verify-disclosure-render.tsx        (also: npm run test:disclosurerender)
//
// ═══ 🚨 WHY THIS EXISTS — A DEFECT THAT SHIPPED TWO DAYS AFTER ITS OWN LESSON ══════════════════
// On 2026-08-19 `dataDisclosure` was written into the canonical report, covered by the deliverable
// hash, and deployed. NOTHING IN THE UI READ IT. The field was in the data and the projection
// dropped it before any reader saw it — which is precisely the `errata_note` failure from two days
// earlier, where a caveat lived in `VERSIONS` and dd-openapi's projection never served it.
//
// ⭐⭐ AND THE HASH DIFFERENTIAL DID NOT CATCH IT, BECAUSE IT CANNOT. Removing the field changes
// the deliverableHash, so TRANSIT TAMPERING is detectable — a real guarantee, and the wrong one.
// It says nothing about whether a renderer projects the field. Two different guarantees; only one
// was established, and the other was assumed.
//
// ═══ ⚠️ WHY NOT A SOURCE GREP FOR THE FIELD NAME ═══════════════════════════════════════════════
// "The string `dataDisclosure` appears in a .tsx file" is not "the disclosure reaches the reader".
// A grep passes the day it is written and passes forever after — including through a refactor that
// deletes the JSX but leaves the type, a conditional that never fires, or a parent that stops
// passing the prop. THE PROJECTION IS THE THING UNDER TEST, so the test renders.
//
// ⭐ BOTH DIRECTIONS, so it can DISTINGUISH rather than always pass: a brief WITH a disclosure must
// emit that exact text, and a brief WITHOUT one must emit nothing resembling it. A test that only
// asserts presence would pass against a component that hardcodes the sentence.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Brief } from "../src/components/jobTimeline";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

const DISCLOSURE =
  "⚠️ No paid data was purchased for this brief, so it rests on web sources alone — " +
  "advertised 1 USDC exceeds the absolute per-buy ceiling of 0.01 USDC.";
const ANSWER = "5 EURC converts to approximately 5.70-5.78 USDC.";

const strip = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  DATA DISCLOSURE — RENDERED, not grepped                            ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("a brief WITH a disclosure");
{
  const html = renderToStaticMarkup(
    <Brief brief={{ answer: ANSWER, reasoning: "r", sources: [], dataDisclosure: DISCLOSURE }} />
  );
  const text = strip(html);
  check("the disclosure text is rendered", text.includes(strip(DISCLOSURE)));
  check("the answer is still rendered", text.includes(strip(ANSWER)));
  // ⭐ ORDER IS PART OF THE CLAIM. A caveat under the thing it qualifies is read after the reader
  // has already formed a view — the same reason the DD page puts its warning above the curl.
  // 🚨 THE ORDERING CHECK MUST REQUIRE PRESENCE FIRST. Written as a bare `iA < iB` it PASSED
  // against the broken component: indexOf returned -1 for the missing disclosure, and -1 is less
  // than everything. An ordering assertion that is satisfied by ABSENCE is the same fail-open shape
  // this whole suite exists against — caught by running the guard against the pre-fix component
  // rather than by reading it.
  const iD = text.indexOf(strip(DISCLOSURE));
  const iA = text.indexOf(strip(ANSWER));
  check(
    "⭐ it appears ABOVE the answer, not below it",
    iD >= 0 && iA >= 0 && iD < iA,
    `disclosure@${iD} answer@${iA}${iD < 0 ? " (ABSENT — ordering cannot be satisfied by absence)" : ""}`
  );
}

section("a brief WITHOUT a disclosure — the direction that catches a hardcode");
{
  const html = renderToStaticMarkup(
    <Brief brief={{ answer: ANSWER, reasoning: "r", sources: [] }} />
  );
  const text = strip(html);
  check("no disclosure text is emitted", !text.includes("No paid data was purchased"));
  check("nothing resembling a disclosure box is emitted", !/rests on web sources alone/i.test(text));
  check("the answer still renders normally", text.includes(strip(ANSWER)));
}

section("a DIFFERENT disclosure — proves the text is the data's, not the component's");
{
  const other = "⚠️ OUR REPORTING DID NOT RUN FOR THIS BRIEF.";
  const text = strip(renderToStaticMarkup(
    <Brief brief={{ answer: ANSWER, sources: [], dataDisclosure: other }} />
  ));
  check("the supplied text is what appears", text.includes(strip(other)));
  // 🚨 If the ceiling sentence showed up here, the component would be hardcoding it — the exact
  // failure a presence-only assertion cannot see.
  check("🚨 the ceiling sentence does NOT appear when a different one was supplied",
        !text.includes("per-buy ceiling"));
}

console.log("\n════════════════════════════════════════════════════════════════════════");
console.log(`${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log("⭐ The disclosure reaches the reader, comes from the DATA, and sits above the answer.\n");
