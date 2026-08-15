#!/usr/bin/env node
// verify-quorum-billing.mjs — WHO PAYS WHEN THE ENDPOINTS FAIL, and who gets shouted about.
//
//   node scripts/dd/verify-quorum-billing.mjs
//
// ═══ 🚨 THE BOUNDARY THIS PINS ═══════════════════════════════════════════════════════════════
// Routing quorum failures into the coverage manifest is right — it keeps an endpoint outage from
// becoming a SERVICE outage, and keeps fail-closed (never claim a power is absent when it could not
// be checked). But it has one consequence that is easy to miss and expensive to get wrong:
//
// ⭐⭐ THE SETTLE GATE USES COVERAGE-COMPLETENESS TO DETECT AN OUTAGE. Its own comment: "A
// `chain-unreachable` report carries an EMPTY manifest… so it fails (2) even before (3) is
// consulted." Populate every group with a reasoned `notChecked` and a TOTAL outage becomes
// structurally identical to a thin answer — and the service bills full price for a report that
// checked nothing because our own endpoints were down.
//
// ⚠️ THE PUBLISHED TERMS FORBID EXACTLY THAT: "you are not charged if the engine could not produce
// an answer — an outage, AN UNREACHABLE CHAIN, or a refusal returns the report free… 'We COULD NOT
// check' is OUR instrument failing and is FREE. Thin coverage by itself is never a refund reason;
// a broken instrument always is."
//
// So the line is: PARTIAL instrument failure BILLS (a thin answer is an answer); TOTAL instrument
// failure REFUSES (a broken instrument is not). A DISAGREEMENT is neither — we DID read, they
// conflicted — and bills, because it is a finding about the providers rather than about us.

import { isSystemicReadFailure, escalateProviderIntegrity } from "../../netlify/functions/dd-analyze.mjs";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const cov = (checked, notChecked) => ({ coverage: { checked, notChecked } });
const nc = (reason, n = 1) => Array.from({ length: n }, (_, i) => ({ id: `power:g${i}`, reason }));

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  QUORUM × BILLING — free when OUR instrument broke, billed otherwise ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

console.log("\n── THE BOUNDARY, BOTH DIRECTIONS ───────────────────────────────────");
ok("⭐⭐ EVERY check unreadable ⇒ SYSTEMIC — our instrument failed, so it must refuse and stay FREE",
  isSystemicReadFailure(cov([], nc("rpc-unreadable", 9))) === true);
ok("⭐⭐ every check quorum-unmet ⇒ SYSTEMIC too — a set that cannot corroborate is a broken instrument",
  isSystemicReadFailure(cov([], nc("rpc-quorum-unmet", 9))) === true);
ok("⭐⭐ ONE check succeeded ⇒ NOT systemic — a thin answer is an ANSWER and bills",
  isSystemicReadFailure(cov([{ id: "shape:code@address" }], nc("rpc-unreadable", 8))) === false);
ok("⭐⭐ every check DISAGREED ⇒ NOT systemic — we read, THEY conflicted; a finding is not an outage",
  isSystemicReadFailure(cov([], nc("rpc-disagreement", 9))) === false,
  "this is the laundering path: an integrity failure must never become a free outage");
ok("⭐ a mix of unreadable and disagreement ⇒ NOT systemic — one real finding is enough to bill",
  isSystemicReadFailure(cov([], [...nc("rpc-unreadable", 8), { id: "power:x", reason: "rpc-disagreement" }])) === false);
ok("⭐⭐ 'nothing to check here' ⇒ NOT systemic — an EOA with no code is a finding, and the terms bill it",
  isSystemicReadFailure(cov([], nc("not-applicable", 9))) === false,
  "the exact case the terms call out: \"there was NOTHING to check\" is an ANSWER");
ok("  a malformed report is not treated as systemic (it is not an outage claim to make)",
  isSystemicReadFailure({}) === false && isSystemicReadFailure(cov([], [])) === false);

console.log("\n── ⭐⭐ THE ESCALATION MUST NOT BE REACHABLE FROM THE BILLING BRANCH ──");
// 🚨 Charging for a disagreement makes a provider-integrity failure REVENUE-POSITIVE. That is the
// flat-price argument ("a coverage-scaled price would pay us more for reporting more coverage — an
// incentive to overstate") aimed at a different variable. The defence is structural, not vigilance.
const src = readFileSync(new URL("../../netlify/functions/dd-analyze.mjs", import.meta.url), "utf8");
const sig = src.match(/export function escalateProviderIntegrity\(([^)]*)\)/)?.[1] ?? "";
ok("⭐⭐ the escalation takes ONLY the report and a correlation id — no billing value is in scope",
  /^\s*report\s*,\s*correlationId\s*$/.test(sig), `signature: (${sig})`);
// ⚠️ COMMENTS STRIPPED FIRST, and the reason is a bug this check had on its first run: the block
// carries a long rationale ABOUT billing ("revenue-positive", "charged"), so grepping the raw text
// conflated "the code MENTIONS billing" with "the code USES billing". The claim is about what the
// function can branch on, which is code — the explanation is supposed to say those words.
const escBody = src
  .slice(src.indexOf("export function escalateProviderIntegrity"), src.indexOf("export function isSystemicReadFailure"))
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^\s*\/\/.*$/gm, " ");
ok("⭐⭐ …and it cannot branch on a charge outcome — no billing identifier appears in its CODE",
  !/\b(charged|settle\w*|paid|price)\b/i.test(escBody));
// ⚠️ EXISTENCE IS ASSERTED BEFORE ORDERING, and that is not pedantry — it is a hole this check
// HAD. `indexOf` returns -1 when the call is absent, and `-1 < anythingPositive` is TRUE, so
// DELETING the escalation entirely made this pass. A mutation caught it. Absence read as safe,
// inside a check written about structural guarantees.
// 🚨 AND THE STATEMENT FORM IS MATCHED, NOT THE BARE NAME — the second hole in this one check.
// `indexOf("escalateProviderIntegrity(report, correlationId)")` also matches the FUNCTION
// DECLARATION, which sits at module scope well before runPaidAnalysis. So deleting the CALL still
// left a match, still satisfied `> 0`, and still satisfied the ordering test: the check would have
// passed forever while the escalation never ran. ⭐ "The string appears" is not "the call happens".
const callMatch = src.match(/^[ \t]+escalateProviderIntegrity\(report, correlationId\);$/m);
const callAt = callMatch ? src.indexOf(callMatch[0]) : -1;
ok("⭐⭐ the escalation is actually CALLED as a statement (deleting the call must fail this suite)", callAt > 0);
ok("⭐ …and it is called BEFORE the report is handed to the paid flow, not after settlement",
  callAt > 0 && callAt < src.indexOf("runPaidAnalysis("));
ok("⭐ …and the reason is written AT THE CODE so nobody later simplifies them together",
  /revenue-positive|incentive gradients off the money path/i.test(src));
ok("  the escalation never throws — an alerting failure must not destroy a paid-for report",
  /an alert that breaks the response is worse than a missed alert/.test(src));

console.log("\n── IT FIRES ON A SPLIT AND IS SILENT OTHERWISE ─────────────────────");
const errs = [];
const realErr = console.error; console.error = (...a) => errs.push(a.join(" "));
escalateProviderIntegrity({ sources: { integrity: { providerDisagreement: false, splits: [] } } }, "c1");
const quiet = errs.length;
escalateProviderIntegrity({ subject: { address: "0xabc", chainId: 1, blockNumber: 2 },
  sources: { endpoints: ["a", "b"], integrity: { providerDisagreement: true, splits: [{ id: "owner:owner()" }] } } }, "c2");
escalateProviderIntegrity(null, "c3");
console.error = realErr;
ok("⭐ no split ⇒ silent", quiet === 0);
ok("⭐⭐ a split ⇒ one loud alert naming the subject, the block and the endpoints",
  errs.length === 1 && /PROVIDER DISAGREEMENT/.test(errs[0]) && /owner:owner\(\)/.test(errs[0]));
ok("⭐ …and it says a single-endpoint build would have SIGNED AND SOLD the answer",
  /SIGNED AND SOLD/.test(errs[0] ?? ""));
ok("  a malformed report does not throw out of the alerter", errs.length === 1);

console.log("\n── THE PAID PATH ACTUALLY READS THROUGH QUORUM ─────────────────────");
ok("⭐⭐ dd-analyze builds a quorumClient over the shared endpoint set",
  /quorumClient\(ARC_QUORUM_ENDPOINTS\.map/.test(src));
ok("⭐ …and no longer analyses through a bare single-endpoint client",
  !/analyze\(addr,\s*\{\s*client:\s*chainClient\(chain\)\s*\}\)/.test(src));
const runSrc = readFileSync(new URL("./analyze-run.mjs", import.meta.url), "utf8");
ok("⭐⭐ the CLI RE-EXPORTS the endpoint set rather than re-listing it — one source of truth",
  /export \{ ARC_QUORUM_ENDPOINTS as QUORUM_ENDPOINTS \}/.test(runSrc) &&
  !/rpc\.testnet\.arc\.network/.test(runSrc));
const epSrc = readFileSync(new URL("../../shared/onchain-analyze/endpoints.mjs", import.meta.url), "utf8");
ok("⭐ …and it lives under shared/, which the build stamp hashes (scripts/ does not)",
  /rpc\.testnet\.arc\.network/.test(epSrc) && /drpc\.org/.test(epSrc));

console.log("\n── ⭐⭐ EVERY MODULE dd-analyze RUNS IS INSIDE THE CODE-IDENTITY HASH ──");
// 🚨 THE FAIL-OPEN THIS CLOSES. `ddCodeIdentity` is the health artifact's identity: the canary's
// verdict is supposed to vouch for THIS code. `dd-analyze` imported chainClient and
// ddAttestationOptions from `scripts/dd/`, which is in NEITHER the stamp's SURFACES nor the DD
// surface — so a change to the ATTESTATION SIGNING path produced an identical tree, an identical
// ddTree, and no dirty flag. Old canary evidence would vouch for new code, which is the exact
// fail-open the binding exists to close.
//
// ⚠️ AND THE RELOCATION ALONE WOULD NOT HAVE CLOSED IT: `shared/` is inside SURFACES (fixing `tree`)
// but ddTree filters by DD_SURFACE_DIRS, which `shared/` root does not match. Both had to move.
//
// ⭐ COMPUTED FROM THE REAL IMPORT GRAPH, not from a list someone remembers to update — the
// stamper's own rule ("ADD A ROW WHENEVER THE CANARY GAINS AN IMPORT") is exactly what was missed,
// because the import arrived through dd-analyze rather than dd-canary.
{
  const { readdirSync } = await import("node:fs");
  const path = await import("node:path");
  const stampSrc = readFileSync(new URL("../stamp-build.mjs", import.meta.url), "utf8");
  const ddDirs = [...(stampSrc.match(/const DD_SURFACE_DIRS = \[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const ddFiles = [...(stampSrc.match(/const DD_SURFACE_FILES = \[([\s\S]*?)\];/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const root = path.resolve(new URL("../../", import.meta.url).pathname);
  const covered = (p) => ddDirs.some((d) => p.startsWith(d + "/")) || ddFiles.includes(p);
  const imports = (f) => { try { return [...readFileSync(path.join(root, f), "utf8").matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1]); } catch { return []; } };
  const seen = new Set(); const stack = ["netlify/functions/dd-analyze.mjs"];
  while (stack.length) {
    const cur = stack.pop(); if (seen.has(cur)) continue; seen.add(cur);
    for (const spec of imports(cur)) {
      const r = path.posix.normalize(path.posix.join(path.posix.dirname(cur), spec));
      if (!seen.has(r)) stack.push(r);
    }
  }
  const fromScripts = [...seen].filter((p) => p.startsWith("scripts/"));
  ok("⭐⭐ dd-analyze runs NO code from scripts/ — everything it imports is inside a stamped surface",
    fromScripts.length === 0, fromScripts.join(", ") || "none");
  ok("⭐⭐ …and shared/dd is a DD surface dir, so an attestation-signing change ROTATES the health key",
    ddDirs.includes("shared/dd"), ddDirs.join(", "));
  const signer = "shared/dd/attest-circle.mjs";
  ok("⭐⭐ the SIGNING path specifically is inside the code-identity hash",
    seen.has(signer) && covered(signer));

  // ⭐⭐ THE CHARGING DECISION AND THE IDENTITY LOGIC, ADDED 2026-08-16 after measuring their churn
  // over the full 354-commit history (5 changes total, on 5 distinct days). The canary's verdict
  // vouches for a PAID report; leaving out the code that decides whether the buyer is billed made
  // that vouching narrower than it reads.
  for (const f of ["shared/x402/settle-gate.mjs", "netlify/functions/_x402-confirm.mjs"]) {
    ok(`⭐⭐ the charging path is inside the code-identity hash — ${f}`, covered(f));
  }
  // ⚠️ THE ONE THAT CAN INVALIDATE EVERY OTHER ROW: build-stamp.mjs COMPUTES ddCodeIdentity, so a
  // change to it can alter what the identity MEANS without any identity rotating to say so.
  ok("⭐⭐ the code that COMPUTES the identity is itself inside the identity", covered("shared/build-stamp.mjs"));
  // ⚠️ …but NOT the generated file: hashing the stamp into its own hash is circular.
  // 🚨 THIS CHECK WAS A TAUTOLOGY AND A MUTATION EXPOSED IT. It read
  //     !covered(generated) || stampSrc.includes("const SELF")
  // — and since the generated file is not in DD_SURFACE_FILES, the left side is ALWAYS true and the
  // right side was never evaluated. Renaming `SELF` out of existence left it green. ⭐ An `||` whose
  // first operand is always true is not a check, it is a comment with a green tick.
  // Now it asserts the stamper's ACTUAL exclusion mechanism: the filter that drops SELF from the walk.
  ok("⭐⭐ the GENERATED stamp is excluded from the hash BY THE WALK — circular otherwise",
    /const SELF = /.test(stampSrc) && /\.filter\(\(p\) => p !== SELF\)/.test(stampSrc));
  ok("  …and it is genuinely absent from the DD surface list", !covered("shared/build-stamp.generated.mjs"));

  // ⭐ EVERY module dd-analyze reaches is now either covered or a KNOWN, NAMED exclusion. Derived
  // from the graph, so a new uncovered import fails here instead of being noticed months later.
  const KNOWN_UNCOVERED = new Set(["shared/build-stamp.generated.mjs"]);
  const uncovered = [...seen].filter((p) => {
    try { readFileSync(path.join(root, p)); } catch { return false; }
    return !covered(p) && !KNOWN_UNCOVERED.has(p);
  });
  ok("⭐⭐ NOTHING dd-analyze runs is outside the code-identity hash except the documented SELF exclusion",
    uncovered.length === 0, uncovered.join(", ") || "none");
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
