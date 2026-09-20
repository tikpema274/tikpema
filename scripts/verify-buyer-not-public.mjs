// verify-buyer-not-public.mjs — THE x402 BUYER IS NEVER A PUBLIC ROUTE.
//
//   node scripts/verify-buyer-not-public.mjs        (also: npm run test:buyernotpublic, in test:all)
//
// ═══ 🚨 WHY THIS EXISTS — FOUND 2026-09-20, LIVE ON PROD ════════════════════════════════════════
// `x402-pay.mjs` was a "thin HTTP wrapper around the buyer core… proves the buyer path in isolation"
// (its own header). It shipped as a production function: POST /.netlify/functions/x402-pay { url }
// → payX402({ sellerUrl }) → the DELEGATE EOA's Gateway balance paid WHATEVER SELLER WAS POSTED.
// No session, no pause check, and `_x402.mjs` exempted it from the budget-approved ceiling by name
// ("the standalone x402-pay.mjs harness… intentionally exempt") — leaving only the per-call
// AGENT_MAX_SPEND backstop. Anyone could drain the delegate to their own x402 seller. Testnet money
// today; the mainnet checklist (§2, §7) would have carried it across. Probed read-only with an
// unreachable seller (502 "fetch failed", nothing spent) before removal.
// [[guard-belongs-on-the-caller-set]] — a harness is a caller too, and it had no guard.
//
// THE RULE: payX402 moves the agent's money. Every importer must be a path that (a) is not an HTTP
// entry point at all, or (b) requires the session AND sets `requireApproved:true` (the budget spine).
// Today the ONLY legitimate importer is _research.mjs (called from job-submit-background behind
// requireInternal + the per-job budget). A new importer must be added to ALLOWED_IMPORTERS here,
// with its guard named — which is the point: adding it is a decision, not a drop-in.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

let failed = 0;
const ok = (label, cond, detail = "") => { console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`); if (!cond) failed++; };

const DIR = "netlify/functions";
const ALLOWED_IMPORTERS = {
  "netlify/functions/_research.mjs": "not an HTTP entry point; reached only via job-submit-background (requireInternal) and calls payX402 with requireApproved:true",
};

console.log("── 1. the public buyer harness is GONE ──");
ok("netlify/functions/x402-pay.mjs does not exist", !existsSync(`${DIR}/x402-pay.mjs`));

console.log("\n── 2. every importer of payX402 is on the allowlist, with its guard named ──");
const importers = readdirSync(DIR).filter((f) => f.endsWith(".mjs") && f !== "_x402.mjs")
  .filter((f) => /import\s*\{[^}]*\bpayX402\b[^}]*\}\s*from\s*"\.\/_x402\.mjs"/.test(readFileSync(`${DIR}/${f}`, "utf8")))
  .map((f) => `${DIR}/${f}`);
ok("at least one importer exists (the check is not vacuous)", importers.length >= 1, importers.join(", "));
for (const p of importers) ok(`${p} is an allowed importer`, !!ALLOWED_IMPORTERS[p], ALLOWED_IMPORTERS[p] ?? "NOT ALLOWED — a new caller of the buyer must be a decision");
for (const p of Object.keys(ALLOWED_IMPORTERS)) ok(`${p} (allowlisted) still imports payX402`, importers.includes(p), importers.includes(p) ? "" : "stale allowlist entry");

console.log("\n── 3. the allowed importer sets requireApproved:true on its buy (fail-closed on the budget spine) ──");
{
  const src = readFileSync("netlify/functions/_research.mjs", "utf8");
  ok("_research.mjs calls payX402 with requireApproved: true", /payX402\(\{[^}]*requireApproved:\s*true/.test(src));
}

console.log("\n── 4. no HTTP function exports a handler that calls payX402 directly ──");
for (const f of readdirSync(DIR).filter((f) => f.endsWith(".mjs") && !f.startsWith("_"))) {
  const src = readFileSync(`${DIR}/${f}`, "utf8");
  ok(`${f} does not call payX402`, !/\bpayX402\s*\(/.test(src));
}

console.log(`\n${failed === 0 ? "✅ the buyer is not a public route" : `❌ ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
