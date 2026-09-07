// verify-consequence-card.tsx — ONE card shape, and the badge that pays for the resemblance.
//
//   npx tsx scripts/verify-consequence-card.tsx        (also: npm run test:consequencecard)
//
// ⛔ THE PROPERTY THAT MATTERS: the self-signed cards and the dashboard cards now render through
// the SAME component, so they look alike — but they do not behave alike. Nobody but the user can
// run a self-signed operation, and no agent cap bounds it. The badge is the one visible thing that
// carries that difference onto the control itself, where the page intro can be scrolled past.
//
// ⭐⭐ SO THIS SUITE ASSERTS AN INEQUALITY, NOT A PRESENCE. "The badge renders on #/self-signed" is
// satisfied by a component that stamps it on everything; "the dashboard has none" is satisfied by a
// dashboard that renders nothing at all. Only the PAIR, each with its own non-emptiness floor,
// distinguishes the shipped behaviour from both failures.
// [[collapse-needs-pairwise-inequality]] [[equality-passes-vacuously-on-empty]]
//
// ⚠️ THE EXPECTED TEXT IS COMPOSED FROM THE PRODUCER, never typed here. Change the badge wording in
// ConsequenceCard and this suite keeps passing CORRECTLY; delete the badge and it goes red. That is
// the same rule CustodyNotice's suites follow — the expected string comes from the same source as
// the real one. [[assert-on-rendered-output-not-source-regex]]

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import ConsequenceCard, { CARD_SIGNERS, CARD_SIGNER_BADGE, cardSignerBadge } from "../src/components/ConsequenceCard";

const Dashboard = (await import("../src/components/Dashboard")).default;
const SelfSignedPanel = (await import("../src/components/SelfSignedPanel")).default;

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

const wallet: any = {
  agentWallet: { address: "0x" + "ab".repeat(20), balance: "12.3456" },
  address: "0x" + "cd".repeat(20), usdcBalance: "12.3456", busy: false, isAuthenticated: true,
  activeKind: "metamask", metamaskConnected: true,
  ensureSession: async () => "t", refreshAgentWallet: async () => {}, refreshBalance: async () => {},
  connectMetaMask: async () => {},
};

const dashHtml = renderToStaticMarkup(<Dashboard wallet={wallet} />);
const selfHtml = renderToStaticMarkup(<SelfSignedPanel wallet={wallet} />);

/** The badge text, taken from the producer. */
const BADGE = CARD_SIGNER_BADGE.self as string;
const countBadges = (html: string) => (html.match(/class="qbadge"/g) || []).length;
const countCards = (html: string) => (html.match(/class="quick-card"/g) || []).length;

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⛔ NON-EMPTINESS FIRST, so every count below can actually fail");
check("the dashboard rendered cards at all", countCards(dashHtml) > 0, `${countCards(dashHtml)} cards`);
check("the self-signed page rendered cards at all", countCards(selfHtml) > 0, `${countCards(selfHtml)} cards`);
check("⭐ the self-signed page renders EXACTLY three", countCards(selfHtml) === 3, `${countCards(selfHtml)}`);
check("the producer actually supplies a badge string", typeof BADGE === "string" && BADGE.length > 0, JSON.stringify(BADGE));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⭐⭐ THE BADGE IS ON ALL THREE SELF-SIGNED CARDS");
check("🚨 three cards, three badges", countBadges(selfHtml) === 3, `${countBadges(selfHtml)} badges`);
check("⭐ …and the badge carries the producer's text",
  selfHtml.includes(`<span class="qbadge">${BADGE}</span>`), BADGE);
// Each operation individually — a count of 3 could in principle come from one card stamped thrice.
// ⚠️ MATCHED BY TITLE, NOT BY ROUTE. `onClick` is a closure and never reaches static markup, so a
// route string is not a thing this instrument can see; asserting on one silently found nothing and
// reported it as a missing badge. [[probe-must-discriminate-between-states]]
for (const op of ["Send", "Bridge", "Swap"]) {
  const card = selfHtml.split('class="quick-card"').find((c) => c.includes(`${op} from your own wallet`));
  check(`⭐ ${op} carries the badge on ITS OWN card`,
    !!card && card.includes('class="qbadge"'), card ? "card found, badge missing" : "no card with that title");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⛔ AND ON NONE OF THE DASHBOARD'S");
check("🚨 the dashboard renders ZERO badges", countBadges(dashHtml) === 0, `${countBadges(dashHtml)} badges`);
check("⭐ …and the badge TEXT appears nowhere on the dashboard",
  !dashHtml.includes(BADGE), `"${BADGE}" leaked onto the dashboard`);
check("⭐⭐ the two pages DISAGREE on badges — the inequality, not either half alone",
  countBadges(selfHtml) !== countBadges(dashHtml),
  `self=${countBadges(selfHtml)} dash=${countBadges(dashHtml)}`);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⭐ THE AXIS: `agent` EARNS NO BADGE, AND SAYS SO AS A VALUE");
check("both signers are modelled", JSON.stringify(CARD_SIGNERS) === JSON.stringify(["agent", "self"]));
check("⭐ `agent` maps to null EXPLICITLY, not to a missing key",
  Object.prototype.hasOwnProperty.call(CARD_SIGNER_BADGE, "agent") && CARD_SIGNER_BADGE.agent === null);
check("the accessor returns nothing for agent", cardSignerBadge("agent") === null);
check("the accessor returns the badge for self", cardSignerBadge("self") === BADGE);
check("⛔ an absent signer earns no badge", cardSignerBadge(undefined) === null);
check("⛔ an unknown value earns no badge rather than throwing", cardSignerBadge("nonsense" as any) === null);
// Rendered, not just the accessor — a map can be right while the component ignores it.
check("⭐⭐ a card with no signer renders NO badge",
  !renderToStaticMarkup(<ConsequenceCard title="X" onClick={() => {}}>y</ConsequenceCard>).includes("qbadge"));
check("⭐⭐ a card with signer=self renders ONE",
  countBadges(renderToStaticMarkup(
    <ConsequenceCard title="X" signer="self" onClick={() => {}}>y</ConsequenceCard>)) === 1);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — ⭐ ONE SHAPE: BOTH PAGES GO THROUGH THE COMPONENT");
{
  const dashSrc = readFileSync(new URL("../src/components/Dashboard.tsx", import.meta.url), "utf8");
  const selfSrc = readFileSync(new URL("../src/components/SelfSignedPanel.tsx", import.meta.url), "utf8");
  check("the dashboard imports the shared card", /import ConsequenceCard from ".\/ConsequenceCard"/.test(dashSrc));
  check("the self-signed page imports it too", /import ConsequenceCard/.test(selfSrc));
  // ⚠️ ONE `<button className="quick-card">` REMAINS ON PURPOSE and it is not a button: the
  // "What else is built" card is an <a href="/built"> — real navigation, not a hash route. Forcing
  // it through a button-shaped component would break the link, so it is excluded BY ELEMENT, and
  // this assertion pins that reason rather than a count that would drift.
  check("⭐ no hash-routed card writes the markup by hand any more",
    !/<button className="quick-card"/.test(dashSrc), "an inline button card is back on the dashboard");
  check("⚠️ …the one remaining raw card is the <a href> one, excluded by element",
    /<a className="quick-card" href=/.test(dashSrc));
  check("⛔ the self-signed page no longer hand-rolls its list",
    !/className="linkbtn"[\s\S]{0,120}from your own wallet/.test(selfSrc));
  // ⭐⭐ STRUCTURAL, NOT TEXTUAL. The first draft matched the badge STRING in each page's source and
  // went red on this file's own comment explaining why the string must not be typed — a guard
  // failing on its own documentation, which teaches the next reader to delete the explanation
  // rather than keep the check. The property is "no page emits the badge MARKUP", and the class
  // name is what expresses it. [[assert-on-rendered-output-not-source-regex]]
  check("⭐⭐ the badge markup is emitted ONLY by the producer",
    !/qbadge/.test(dashSrc) && !/qbadge/.test(selfSrc),
    "a page hand-rolled the badge instead of deriving it from the signer");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — ⛔ THE COPY IS NOT MERGED — two claims, two owners");
check("⭐ the dashboard still describes the OPERATION",
  /Goes to someone else/.test(dashHtml) && /Leaves Arc/.test(dashHtml));
check("⭐ the self-signed page keeps ITS OWN blurbs, not the dashboard's",
  /Move USDC to any address on Arc/.test(selfHtml) && !/Goes to someone else/.test(selfHtml));
check("⭐⭐ …and still states the caps contrast for the page, once",
  /spending caps do not bound them/i.test(selfHtml.replace(/<[^>]+>/g, " ")));

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money, zero network.`);
process.exit(fail === 0 ? 0 : 1);
