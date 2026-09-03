// marketing-site.mjs — WHICH site serves tikpema.xyz, in ONE place.
//
// ═══ ⭐⭐ THE UUID, AND WHY IT IS NOT THE OBVIOUS-LOOKING NAME ══════════════════════════════════
// RESOLVED BY A READ, not typed from the dashboard: listSitesForAccount filtered on
// `custom_domain === "tikpema.xyz"`, 2026-08-31. That is the only property that means "the site
// serving the marketing page"; everything else is a label. Re-confirmed 2026-09-01 against the
// Netlify DNS zone, whose apex record carries this site_id explicitly.
//
// 🚨 THE NAME MOVED THREE TIMES IN ONE DAY while this id never did:
//     "tikpema"  →  "tikpema274111111111111111111111111111"  →  "tikpema274"
// A command reading `--site tikpema` broke silently in the middle of that. ⛔ And `tikpema274` is
// ALSO the GitHub org name AND a second Netlify account slug, so the name that looks most obviously
// right is the most ambiguous string available. Name resolution is not identity.
// ⚠️ If this constant ever needs changing, re-derive it from the DOMAIN, never from a name.
//
// ⛔ NOT `.netlify/state.json`. That is the CLI link and it points at the APP site
// (5464f1a6-… / app.tikpema.xyz), which is correct for the app and wrong for this page. A whole
// session was spent on that split. `scripts/lib/netlify-api.mjs#siteId()` reads the link and is
// therefore the WRONG helper for anything about the marketing page.
export const SITE_ID = "a892e744-9dfc-45df-8cd4-8cd1b0c480b4";
export const SITE_DOMAIN = "tikpema.xyz";

// ═══ ⭐ MEASURED 2026-09-03 — `tikpema274` IS BOTH A TEAM SLUG AND A SITE NAME ══════════════════
// The note above says the name is ambiguous. This is the concrete shape of it, and the failure it
// produces reads like DELETION rather than like ambiguity:
//
//   site  tikpema274  a892e744-9dfc-45df-8cd4-8cd1b0c480b4  custom_domain tikpema.xyz
//                     ↳ lives in the **salifuimorosandow** team
//   team  tikpema274  6a2d60a96569da5544221758
//                     ↳ contains ONE site, `readytodeploy`, never published
//
// 🚨 SO `listSitesForAccount --data '{"account_slug":"tikpema274"}'` RETURNS THE MARKETING SITE'S
// NAMESAKE TEAM AND NOT THE MARKETING SITE. It answers with one unpublished site, exit 0, no error
// — indistinguishable from "the site is gone". The scoping looks obviously correct precisely
// because the slug matches the site name.
// ⭐ Use `listSitesForAccount` on **salifuimorosandow**, or filter any listing on
// `custom_domain === SITE_DOMAIN`, which is the derivation this file already mandates.
// [[probe-must-discriminate-between-states]] — an empty listing here means "wrong team" OR
// "deleted", and nothing in the response tells you which.
