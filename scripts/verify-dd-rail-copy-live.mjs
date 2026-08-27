// verify-dd-rail-copy-live.mjs — THE LIVE HALF: does the DEPLOYED 402 still declare the rail the
// deployed copy names?
//
//   node scripts/verify-dd-rail-copy-live.mjs                (also: npm run test:ddraillive)
//   node scripts/verify-dd-rail-copy-live.mjs --url https://<deploy>--tikpema-predict-test.netlify.app
//
// ═══ ⭐ WHY THIS IS SPLIT OUT OF test:all ══════════════════════════════════════════════════════
// It talks to the live site. A flaky network inside a BLOCKING aggregate manufactures a tolerated
// red, so this runs deliberately — same reasoning and same shape as test:vanillabyteslive.
//
// 🚨 SPLITTING IS NOT DROPPING, AND THE DIFFERENCE IS THE WHOLE POINT HERE.
// verify-dd-rail-copy.mjs proves the SOURCE agrees with the CHARGING CONSTANT. It is structurally
// incapable of noticing that the DEPLOYED endpoint charges on something else — which is exactly
// the defect that happened: the code was right, three copy surfaces were wrong, and every offline
// check stayed green because none of them read the live challenge.
//
// ⚠️ READ-ONLY. One GET and one UNPAID POST that is refused by design (the 402). Nothing is bought,
// nothing is signed — an unpaid POST cannot settle.

const i = process.argv.indexOf("--url");
const BASE = (i === -1 ? "https://app.tikpema.xyz" : process.argv[i + 1]).replace(/\/$/, "");
const T = 25000;

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? `  — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};

const req = async (path, init = {}) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), T);
  try {
    const r = await fetch(`${BASE}${path}`, { ...init, signal: ctrl.signal });
    return { status: r.status, ctype: r.headers.get("content-type") || "", body: await r.text() };
  } catch (e) { return { status: 0, ctype: "", body: "", error: e.message }; }
  finally { clearTimeout(t); }
};

console.log(`\n╔══════════════════════════════════════════════════════════════════════`);
console.log(`║  DD RAIL — LIVE 402 vs LIVE COPY    ${BASE}`);
console.log(`╚══════════════════════════════════════════════════════════════════════\n`);

// ── THE AUTHORITY: what the deployed endpoint actually declares ──
console.log("── the live challenge (the only authority here) ──────────────────────");
const chal = await req("/api/dd-analyze", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ address: "0x3600000000000000000000000000000000000000", chain: "arc-testnet" }),
});
ok("an unpaid POST is challenged with 402", chal.status === 402, `got ${chal.status}${chal.error ? ` (${chal.error})` : ""}`);
let j = null; try { j = JSON.parse(chal.body); } catch { /* */ }
const a0 = j?.accepts?.[0];
ok("the challenge carries accepts[0].extra.name", typeof a0?.extra?.name === "string", JSON.stringify(a0?.extra ?? null).slice(0, 90));

// ⛔ REFUSE rather than report a verdict this run cannot support. Without a rail from the live
// challenge every comparison below is vacuous, and a vacuous pass is how a wrong rail survives.
if (!a0?.extra?.name) {
  console.log("\n⛔ REFUSING TO REPORT — no rail could be read from the live challenge.");
  console.log("   Every comparison below would be a 0-of-0 equality, which passes on no evidence.");
  process.exit(2);
}
const RAIL = a0.extra.name;
console.log(`     live rail = ${JSON.stringify(RAIL)}, verifyingContract = ${a0.extra.verifyingContract ?? "(none)"}`);

// ── THE COPY SURFACES, AS DEPLOYED ──
const surfaces = [
  ["/dd (human page)", (await req("/dd", { headers: { Accept: "text/html" } })).body],
  ["/openapi.json", (await req("/openapi.json", { headers: { Accept: "application/json" } })).body],
  ["the 405 body (what a GET caller is told)", (await req("/api/dd-analyze", { headers: { Accept: "application/json" } })).body],
];

for (const [name, text] of surfaces) {
  console.log(`\n── ${name} ──────────────────────────────────────────`);
  ok("is non-empty (a blank surface cannot be compared)", (text || "").length > 50, `${(text || "").length} bytes`);
  ok(`names the live rail (${RAIL}) or Circle Gateway`,
    new RegExp(RAIL, "i").test(text) || /Circle Gateway/i.test(text));
  // 🚨 THE EXACT REGRESSION: an unqualified "EIP-3009 on Arc" describing THIS endpoint.
  const hits = (text.match(/.{0,70}EIP-3009 on Arc.{0,70}/gi) || [])
    .filter((x) => !/NOT|cannot|corrected|said|was |instead of|rather than/i.test(x));
  ok(`does NOT describe this endpoint as plain "EIP-3009 on Arc"`, hits.length === 0, hits[0] ? `…${hits[0]}…` : "");
  ok("states the DEPOSIT prerequisite (a corrected rail alone still leaves a buyer stuck)",
    /deposit/i.test(text) && /balance/i.test(text));
  ok("states ecrecover(sig) == from / EOA-holds-and-signs", /ecrecover/i.test(text) && /EOA/i.test(text));
}

console.log(`\n════════════════════════════════════════════════════════════════════════`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0`);
console.log(`⭐ The deployed copy names the rail the deployed challenge declares.\n`);
