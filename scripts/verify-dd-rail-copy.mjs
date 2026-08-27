// verify-dd-rail-copy.mjs — DOES THE HUMAN COPY NAME THE RAIL THE CODE ACTUALLY CHARGES ON?
//
//   node scripts/verify-dd-rail-copy.mjs          (also: npm run test:ddrail)
//
// ═══ 🚨 THE DEFECT THIS EXISTS FOR ═════════════════════════════════════════════════════════════
// On 2026-08-27 the live 402 declared `extra.name: "GatewayWalletBatched"` while /dd, the OpenAPI
// document AND the 405 body all said "paid over x402 (EIP-3009 on Arc)". THREE SURFACES DESCRIBING
// ONE ENDPOINT, DRIFTING INDEPENDENTLY, none of them checked against the code that builds the
// challenge. A buyer following the published description would have built a token-domain payer and
// been unable to pay.
//
// ⭐⭐ AND THE RAIL WAS ONLY HALF THE DEFECT. The old copy also omitted a PREREQUISITE: the price
// is pulled from a Circle Gateway balance the payer must have deposited beforehand. A buyer who
// corrected only the rail would have been exactly as stuck. So this suite asserts THREE
// constraints on every surface, not one:
//
//   1. signed against the GatewayWallet contract, NOT the USDC token
//   2. requires an EXISTING Gateway balance — deposit first
//   3. ecrecover(sig) == from, so an EOA that both holds the balance and signs (no SCA+delegate)
//
// ═══ ⭐ THE SOURCE OF TRUTH IS THE CODE, NOT ANOTHER PAGE ══════════════════════════════════════
// Every assertion binds to `DD_EXTRA.name` from _dd-x402.mjs — the exact object that becomes
// `accepts[0].extra` in the challenge. Copy is checked against the CHARGING CODE, never against
// another copy surface: /dd was corrected FROM the OpenAPI's wording once, and both were wrong.
//
// ═══ ⚠️ OFFLINE ON PURPOSE ═════════════════════════════════════════════════════════════════════
// No network. It renders the surfaces in-process and reads the constant. The LIVE half — does the
// deployed 402 still declare this rail — is verify-dd-rail-copy-live.mjs, split out so a flaky
// network cannot manufacture a tolerated red inside test:all. Same split as
// test:vanillabytes / test:vanillabyteslive.
// 🚨 SPLITTING IS NOT DROPPING: this half is structurally incapable of noticing that the DEPLOYED
// endpoint changed rails. That is exactly what the live half is for.

import { DD_EXTRA, DD_VERIFYING_CONTRACT } from "../netlify/functions/_dd-x402.mjs";
import { discoveryPage } from "../netlify/functions/_dd-discovery-page.mjs";
import { openapiDocument } from "../netlify/functions/dd-openapi.mjs";

let pass = 0, fail = 0;
const t = (label, fn) => {
  try { fn(); console.log(`  ✅ ${label}`); pass++; }
  catch (e) { console.log(`  ❌ ${label}\n       ${e.message}`); fail++; }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

console.log(`\n╔══════════════════════════════════════════════════════════════════════`);
console.log(`║  DD RAIL COPY — does what we SAY match what we CHARGE ON?`);
console.log(`╚══════════════════════════════════════════════════════════════════════\n`);

const RAIL = DD_EXTRA.name;

// The three constraints, as testable shapes. Deliberately loose on wording and strict on SUBSTANCE:
// this suite must not become a spell-checker for one phrasing.
const CONSTRAINTS = [
  ["names the GatewayWallet contract, not the USDC token", (s) => /GatewayWallet/i.test(s) && /not (against )?the USDC token|NOT the USDC token|not a token-domain/i.test(s)],
  ["says a Gateway balance must be DEPOSITED beforehand",  (s) => /deposit/i.test(s) && /balance/i.test(s)],
  ["says the payer must be an EOA that holds and signs",   (s) => /ecrecover/i.test(s) && /EOA/i.test(s)],
];

console.log("── 0 — the source of truth ──────────────────────────────────────────");
t("DD_EXTRA.name is the rail the challenge will declare", () => {
  assert(RAIL === "GatewayWalletBatched", `DD_EXTRA.name is ${JSON.stringify(RAIL)}`);
});
t("…and its verifyingContract is the Gateway Wallet, not the USDC token", () => {
  assert(DD_EXTRA.verifyingContract === DD_VERIFYING_CONTRACT, "extra.verifyingContract drifted from the constant");
  assert(!/^0x3600/i.test(DD_EXTRA.verifyingContract), "verifyingContract is the USDC token address — the rail changed");
});

const SURFACES = [];
{
  // /dd — the human page. Rendered, not grepped: this is what a reader actually sees.
  const html = discoveryPage({ method: "GET", health: null });
  SURFACES.push(["/dd (human page)", typeof html === "string" ? html : String(html?.body ?? html)]);

  const doc = openapiDocument();
  SURFACES.push(["OpenAPI info.description", String(doc?.info?.description ?? "")]);
  const dd = doc?.info?.["x-dd"] ?? doc?.["x-dd"] ?? doc?.info ?? {};
  const proto = JSON.stringify(dd) + JSON.stringify(doc?.paths ?? {});
  SURFACES.push(["OpenAPI paymentProtocol", proto]);
}

for (const [name, text] of SURFACES) {
  console.log(`\n── ${name} ──────────────────────────────────────────`);
  t(`names the rail the code charges on ("${RAIL}") or Circle Gateway explicitly`, () => {
    assert(new RegExp(RAIL, "i").test(text) || /Circle Gateway/i.test(text),
      `neither "${RAIL}" nor "Circle Gateway" appears`);
  });
  // 🚨 THE REGRESSION GUARD. "EIP-3009 on Arc" as an unqualified description of THIS endpoint is
  // the exact wrong claim. It may appear only while being corrected or ruled out.
  t(`does NOT describe this endpoint as plain "EIP-3009 on Arc"`, () => {
    const m = text.match(/.{0,70}EIP-3009 on Arc.{0,70}/gi) || [];
    const bad = m.filter((x) => !/NOT|cannot|corrected|said|was |instead of|rather than/i.test(x));
    assert(bad.length === 0, `unqualified claim: …${bad[0]}…`);
  });
  for (const [label, probe] of CONSTRAINTS) {
    t(`${label}`, () => assert(probe(text), "constraint not stated on this surface"));
  }
}

console.log(`\n════════════════════════════════════════════════════════════════════════`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0`);
console.log(`⭐ Every surface names the rail the charging code declares, and all three payer constraints.\n`);
