#!/usr/bin/env node
// verify-spec-published.mjs — assert the OpenAPI document is actually PUBLISHED and VALID at the
// canonical path, on the live site.
//
//   node scripts/verify-spec-published.mjs            # prod
//   node scripts/verify-spec-published.mjs --url https://<deploy>--tikpema-predict-test.netlify.app
//
// ═══ 🚨 WHY "RETURNS 200" IS NOT A TEST HERE ═══════════════════════════════════════════════════
// This site has an SPA fallback: `/*` → /index.html, status 200. So EVERY unmatched path returns
// 200 with an HTML body. Measured before the route existed:
//
//   GET /openapi.json                       → 200  text/html   (index.html)
//   GET /definitely-not-a-real-path-9f3a.json → 200  text/html   (index.html)
//
// ⭐ A ROUTE THAT DOES NOT EXIST AND A WORKING SPEC ARE INDISTINGUISHABLE BY STATUS CODE. A checker
// that asks "does /openapi.json 200?" passes on a site that has never heard of OpenAPI, and hands a
// web page to a parser expecting JSON. That is the [[absence-must-never-read-as-safe]] family in a
// place a discovery registry will look.
//
// ⭐⭐ SO THIS GATE CARRIES A NEGATIVE CONTROL and fails if the control does NOT return HTML — if a
// nonsense path ever starts returning JSON, this gate has lost the ability to tell the two apart
// and its passes stop meaning anything. The control is checked FIRST, before any verdict is trusted.
//
// ⚠️ EXPECTED TO FAIL UNTIL THE ROUTES SHIP. /openapi.json and /dd are new redirects; before the
// deploy that adds them this reports exactly the HTML-instead-of-JSON failure it was written for.
//
// READ-ONLY: GETs, plus ONE unpaid POST that is REFUSED by design (the 402 challenge). Nothing is
// bought and nothing is signed — an unpaid POST cannot settle.

import { DD_PRICE_DECIMAL, DD_PRICE_ATOMIC } from "../netlify/functions/_dd-x402.mjs";

const i = process.argv.indexOf("--url");
const BASE = (i === -1 ? "https://app.tikpema.xyz" : process.argv[i + 1]).replace(/\/$/, "");
const T = 25000;

let bad = 0;
const ok = (label, cond, detail = "") => {
  console.log(`   ${cond ? "✅" : "❌"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!cond) bad++;
};

async function get(path, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), T);
  try {
    const r = await fetch(`${BASE}${path}`, { signal: ctrl.signal, headers });
    return { status: r.status, ctype: r.headers.get("content-type") || "", body: await r.text() };
  } catch (e) { return { status: 0, ctype: "", body: "", error: e.message }; }
  finally { clearTimeout(t); }
}

console.log(`\n╔══════════════════════════════════════════════════════════════════════╗`);
console.log(`║  OPENAPI SPEC — PUBLISHED AND VALID?   ${BASE}`);
console.log(`╚══════════════════════════════════════════════════════════════════════╝\n`);

// ═══ THE NEGATIVE CONTROL, FIRST ═══
console.log("── ⭐ negative control (must prove this gate can tell 'missing' from 'served') ──");
{
  const c = await get("/definitely-not-a-real-path-9f3a.json");
  const isHtml = /text\/html/i.test(c.ctype);
  ok(`a nonexistent path returns HTML, not JSON`, isHtml, `status ${c.status} ${c.ctype}`);
  if (!isHtml) {
    console.log("      🚨 THE CONTROL FAILED. Either the SPA fallback changed or this gate is no longer");
    console.log("         measuring what it claims. Every verdict below is untrustworthy until fixed.");
  }
  ok(`…and it does so at status 200 (the trap this gate exists for)`, c.status === 200, `status ${c.status}`);
}

// ═══ THE CANONICAL SPEC ═══
console.log("\n── /openapi.json — the canonical path discovery tooling looks for ──");
let spec = null;
{
  const r = await get("/openapi.json", { Accept: "application/json" });
  ok("HTTP 200", r.status === 200, `got ${r.status}`);
  // 🚨 THE LOAD-BEARING ASSERTION. Not the status — the CONTENT TYPE.
  ok("Content-Type is application/json (NOT text/html)", /application\/json/i.test(r.ctype), r.ctype || "(none)");
  try { spec = JSON.parse(r.body); ok("body parses as JSON", true); }
  catch { ok("body parses as JSON", false, `first 60 chars: ${r.body.slice(0, 60).replace(/\n/g, " ")}`); }
}

if (spec) {
  console.log("\n── document ────────────────────────────────────────────────────────");
  ok('openapi === "3.1.0"', spec.openapi === "3.1.0", String(spec.openapi));
  ok("info.title present", !!spec.info?.title);
  ok("info.x-guidance present", typeof spec.info?.["x-guidance"] === "string" && spec.info["x-guidance"].length > 100);
  ok("info.contact.email present", !!spec.info?.contact?.email, spec.info?.contact?.email || "(missing)");
  ok("externalDocs.url present", !!spec.externalDocs?.url, spec.externalDocs?.url || "(missing)");

  // ⭐ The guidance must not round "arc-testnet" up to "Arc". An agent seeking a MAINNET service
  // must bounce off the text BEFORE paying, not discover it afterwards.
  const g = spec.info?.["x-guidance"] || "";
  ok("x-guidance says 'Arc testnet', never bare 'Arc'", /Arc testnet/.test(g) && !/\bon Arc\b(?! testnet)/.test(g));
  ok("x-guidance is concise (< 600 words, well inside the ~1000-token budget)", g.split(/\s+/).length < 600, `${g.split(/\s+/).length} words`);

  console.log("\n── the paid operation ──────────────────────────────────────────────");
  const post = spec.paths?.["/api/dd-analyze"]?.post;
  ok("POST /api/dd-analyze is described", !!post);
  const pay = post?.["x-payment-info"];
  ok("x-payment-info present", !!pay);
  ok("price.amount matches the code constant", pay?.price?.amount === DD_PRICE_DECIMAL, `${pay?.price?.amount} vs ${DD_PRICE_DECIMAL}`);
  // ⚠️ Circle's example says "0.010000". A sample price shipped live is a service advertising a
  // price it will not honour — asserted explicitly so a copy-paste cannot survive review.
  ok('price.amount is NOT Circle\'s "0.010000" sample', pay?.price?.amount !== "0.010000");
  ok("price.currency stated", pay?.price?.currency === "USDC", String(pay?.price?.currency));
  ok("price.mode stated", pay?.price?.mode === "fixed", String(pay?.price?.mode));
  ok("protocols[] contains x402", Array.isArray(pay?.protocols) && pay.protocols.some((p) => "x402" in p));

  const schema = post?.requestBody?.content?.["application/json"]?.schema;
  ok("request schema declared", !!schema?.properties);
  // 🚨 EVERY field, not most. An agent building a call from this cannot guess an undocumented one.
  const missing = Object.entries(schema?.properties || {}).filter(([, v]) => !v.description).map(([k]) => k);
  ok("EVERY request field has a description", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `${Object.keys(schema?.properties || {}).length} field(s)`);
}

// ═══ THE OTHER PUBLISHED PATHS ═══
console.log("\n── the paths this document promises ────────────────────────────────");
{
  const legacy = await get("/api/dd-openapi", { Accept: "application/json" });
  ok("/api/dd-openapi still serves JSON (a published URL is a promise)", legacy.status === 200 && /application\/json/i.test(legacy.ctype), `${legacy.status} ${legacy.ctype}`);

  const docs = await get(spec?.externalDocs?.url?.replace(BASE, "") || "/dd", { Accept: "text/html" });
  ok("externalDocs.url serves HTML at 200 (not 405, not the SPA shell)", docs.status === 200 && /text\/html/i.test(docs.ctype), `${docs.status} ${docs.ctype}`);
  // ⚠️ The SPA shell is ALSO html/200 — so check it is the DD page, not index.html.
  ok("…and it is the DD service page, not the app shell", /due diligence|dd-analyze|coverage/i.test(docs.body), docs.body.slice(0, 40).replace(/\n/g, " "));
}

// ═══ THE RUNTIME PROOF ═══
console.log("\n── runtime: an unpaid call must challenge, not serve ────────────────");
{
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), T);
  let r = null;
  try {
    const res = await fetch(`${BASE}/api/dd-analyze`, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: "0x3600000000000000000000000000000000000000", chain: "arc-testnet" }),
    });
    r = { status: res.status, body: await res.text() };
  } catch (e) { r = { status: 0, body: e.message }; }
  finally { clearTimeout(t); }

  ok("HTTP 402 on an unpaid POST", r.status === 402, `got ${r.status}`);
  let j = null; try { j = JSON.parse(r.body); } catch { /* */ }
  ok("402 body carries accepts[]", Array.isArray(j?.accepts) && j.accepts.length > 0);
  const amounts = (j?.accepts || []).map((a) => a.maxAmountRequired ?? a.amount).filter(Boolean);
  ok("the challenge quotes the same atomic price as the spec", amounts.every((a) => String(a) === DD_PRICE_ATOMIC), amounts.join(", ") || "(none)");
}

// ═══ ⭐⭐ THE DISCOVERY CASE — the one this gate NEVER exercised ═══════════════════════════════
// 🚨 Every assertion above posts a VALID SUBJECT, so this gate has only ever proven the 402 works
// for callers who ALREADY KNOW THE SCHEMA. The case discovery actually uses — an empty body — went
// unmeasured for weeks while the listing question stayed open, and it was returning 400.
// That is [binding-tested-across-what-it-binds]: a guard proving the easy property while the
// load-bearing one goes unwatched. Without this block the 402-for-probes fix could regress silently
// and every check above would stay green.
console.log("\n── runtime: a DISCOVERY PROBE must be challenged, not refused ────────");
{
  const probe = async (label, body) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), T);
    let r = null;
    try {
      const init = { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json" } };
      if (body !== null) init.body = body;
      const res = await fetch(`${BASE}/api/dd-analyze`, init);
      r = { status: res.status, body: await res.text() };
    } catch (e) { r = { status: 0, body: e.message }; }
    finally { clearTimeout(t); }
    let pj = null; try { pj = JSON.parse(r.body); } catch { /* */ }
    ok(`${label} → HTTP 402`, r.status === 402, `got ${r.status}`);
    ok(`${label} → carries accepts[]`, Array.isArray(pj?.accepts) && pj.accepts.length > 0);
    ok(`${label} → carries x402Version`, pj?.x402Version === 2, String(pj?.x402Version));
  };
  await probe("empty body `{}`", "{}");
  await probe("no body at all", null);
}

console.log("\n════════════════════════════════════════════════════════════════════════");
if (bad) { console.log(`❌ ${bad} check(s) failed.\n`); process.exit(1); }
console.log(`✅ the spec is published, valid, priced from one constant, and the runtime agrees.\n`);
