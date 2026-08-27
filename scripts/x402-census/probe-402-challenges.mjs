// probe-402-challenges.mjs — CAPTURE THIRD-PARTY 402 CHALLENGES VERBATIM.
//
//   node scripts/x402-census/probe-402-challenges.mjs   # writes challenges-<date>.snapshot.json
//
// ═══ ⭐ WHY THIS EXISTS ════════════════════════════════════════════════════════════════════════
// The DD-comparable findings rest on what two third-party sellers CHARGE, read from their own live
// 402 challenges. A seller can reprice or delete at any moment, so those readings are the most
// perishable evidence in this repo — and the prepaid CREDIT TIERS in particular existed nowhere but
// in a session transcript: the Bazaar lists only the $5 tier, while the endpoint quotes four.
//
// ═══ 🚨 READ-ONLY, AND THAT IS A PROPERTY OF THE METHOD, NOT THE INTENT ════════════════════════
// GET with NO payment header. An x402 seller answers that with 402 + the terms and does no work.
// ⛔ NOTHING IS SIGNED, NOTHING IS PAID, NO PAYMENT HEADER IS EVER CONSTRUCTED. Do not "improve"
// this by adding a payment header to see what happens — that BUYS.
//
// ═══ ⚠️ WHAT THIS ARTIFACT IS, AND IS NOT ══════════════════════════════════════════════════════
// A SNAPSHOT of live third-party responses at one instant. It is NOT a fact about what these
// sellers charge now. Anything derived from it must carry the capture timestamp.
//
// ═══ ⭐ DRIFT IS DETECTED MECHANICALLY ═════════════════════════════════════════════════════════
// EXPECTED below records what was observed on 2026-08-27 (first probe). Every field is re-compared
// on each run and differences are reported as FINDINGS. Eyeballing two JSON blobs is how a changed
// payTo goes unnoticed.
//
// ⚠️ AND A "NO DRIFT" RESULT IS ONLY AS STRONG AS THE INTERVAL IT SPANS. The first probe and the
// first re-probe were 3h33m apart, ON THE SAME DAY. That is nowhere near enough to call these
// terms stable; it establishes only that they had not changed within an afternoon. State the
// interval whenever the result is cited.
//
// ⭐ CACHE STATUS IS CHECKED, because a CDN copy would produce a false "unchanged": every response
// is recorded with x-vercel-cache / cf-cache-status. The 2026-08-27 re-probe was MISS / DYNAMIC
// on all six — live origin responses, not cached ones. An unchanged reading served from cache
// would prove nothing about the seller.

import { writeFileSync } from "node:fs";

const PROBES = [
  { id:"deep-dd",        method:"GET", url:"https://402.com.tr/api/x402/deep-dd" },
  { id:"dd-scan",        method:"GET", url:"https://api.craigmbrown.com/v1/services/ops.due-diligence-scan" },
  { id:"credits-0.25",   method:"GET", url:"https://402.com.tr/api/x402/buy-credits?tier=0.25" },
  { id:"credits-1",      method:"GET", url:"https://402.com.tr/api/x402/buy-credits?tier=1" },
  { id:"credits-5",      method:"GET", url:"https://402.com.tr/api/x402/buy-credits?tier=5" },
  { id:"credits-20",     method:"GET", url:"https://402.com.tr/api/x402/buy-credits?tier=20" },
];
// observed 2026-08-27, first probe — the baseline drift is measured against
const EXPECTED = {
  "deep-dd":      { status:402, amount:"750000",      payTo:"0x973a31858f4d2125f48c880542da11a2796f12d6", network:"eip155:8453", scheme:"exact", extraName:"USD Coin" },
  "dd-scan":      { status:402, amount:"1000000",     payTo:"0x5E709929A4AB69eC3a8811d03417869059BC4EB9", network:"eip155:8453", scheme:"exact", extraName:"USD Coin" },
  "credits-0.25": { status:402, amount:"250000",      payTo:"0x973a31858f4d2125f48c880542da11a2796f12d6", network:"eip155:8453", scheme:"exact", extraName:"USD Coin" },
  "credits-1":    { status:402, amount:"1000000",     payTo:"0x973a31858f4d2125f48c880542da11a2796f12d6", network:"eip155:8453", scheme:"exact", extraName:"USD Coin" },
  "credits-5":    { status:402, amount:"5000000",     payTo:"0x973a31858f4d2125f48c880542da11a2796f12d6", network:"eip155:8453", scheme:"exact", extraName:"USD Coin" },
  "credits-20":   { status:402, amount:"20000000",    payTo:"0x973a31858f4d2125f48c880542da11a2796f12d6", network:"eip155:8453", scheme:"exact", extraName:"USD Coin" },
};

const HDR = "payment-required";
const capturedAt = new Date().toISOString();
const out = [], findings = [];

for (const p of PROBES) {
  let rec = { id:p.id, url:p.url, method:p.method, capturedAt:new Date().toISOString() };
  try {
    // 🚨 NO payment header. Nothing here constructs, signs, or sends one.
    const r = await fetch(p.url, { method:p.method, headers:{ accept:"application/json" } });
    rec.status = r.status;
    rec.headers = Object.fromEntries([...r.headers.entries()]);   // verbatim
    rec.bodyRaw = await r.text();                                  // verbatim
    try { rec.bodyParsed = JSON.parse(rec.bodyRaw); } catch { rec.bodyParsed = null; }
    const b64 = r.headers.get(HDR);
    rec.paymentRequiredHeaderB64 = b64 ?? null;
    if (b64) { try { rec.paymentRequiredDecoded = JSON.parse(Buffer.from(b64,"base64").toString("utf8")); }
               catch(e){ rec.paymentRequiredDecoded = null; rec.decodeError = String(e.message); } }
    else rec.paymentRequiredDecoded = null;
    // terms are read from the header when present, else the body — both are captured above
    const src = rec.paymentRequiredDecoded ?? rec.bodyParsed;
    const a = src?.accepts?.[0];
    rec.terms = a ? { amount:a.amount ?? null, payTo:a.payTo ?? null, network:a.network ?? null,
                      asset:a.asset ?? null, scheme:a.scheme ?? null,
                      maxTimeoutSeconds:a.maxTimeoutSeconds ?? null,
                      extraNameState: !("extra" in a)||a.extra==null ? "no-extra"
                                    : !("name" in a.extra)          ? "extra-without-name"
                                    : a.extra.name===null           ? "name-null" : "name-present",
                      extraName: a?.extra?.name ?? null,
                      acceptsCount: (src.accepts||[]).length,
                      x402Version: src.x402Version ?? null } : null;
  } catch (e) { rec.error = String(e.message); rec.terms = null; }

  // ⭐ mechanical drift comparison
  const exp = EXPECTED[p.id];
  if (exp) {
    const got = { status:rec.status, ...(rec.terms ? {amount:rec.terms.amount, payTo:rec.terms.payTo,
                  network:rec.terms.network, scheme:rec.terms.scheme, extraName:rec.terms.extraName} : {}) };
    for (const k of Object.keys(exp)) {
      const e = exp[k], g = got[k];
      const same = typeof e==="string" && typeof g==="string" ? e.toLowerCase()===g.toLowerCase() : e===g;
      if (!same) findings.push({ probe:p.id, field:k, expected:e, observed:g ?? null });
    }
  }
  rec.comparedAgainst = exp ?? null;
  out.push(rec);
  console.log(`  ${String(rec.status ?? "ERR").padEnd(4)} ${p.id.padEnd(14)} ${rec.terms ? `${rec.terms.amount} -> ${rec.terms.payTo}` : (rec.error||"no terms")}`);
}

console.log(findings.length ? `\n🚨 ${findings.length} DRIFT FINDING(S):` : `\n✅ no drift against the 2026-08-27 baseline`);
for (const f of findings) console.log(`   ${f.probe}.${f.field}: expected ${f.expected}  observed ${f.observed}`);

const file = `scripts/x402-census/challenges-${capturedAt.slice(0,10)}.snapshot.json`;
writeFileSync(file, JSON.stringify({
  _what:"LIVE 402 challenges from THIRD-PARTY sellers, captured verbatim (headers + body + the PAYMENT-REQUIRED header base64 and its decoded form).",
  _snapshotNotFact:"⚠️ These are third-party responses at ONE INSTANT. This is a SNAPSHOT, NOT a fact about what these sellers charge now — a seller can reprice or delete at any time. Anything derived from it must carry capturedAt.",
  _method:"GET, no payment header. Nothing signed, nothing paid, no payment header constructed. Read-only is a property of the method here, not merely the intent.",
  _why:"These readings are the most perishable evidence behind the DD-comparable findings, and the prepaid credit tiers existed nowhere but a session transcript: the Bazaar lists only the $5 tier while the endpoint quotes four.",
  capturedAt, probes:out.length, driftFindings:findings,
  responses:out,
}, null, 1));
console.log(`\n  written ${file}`);
