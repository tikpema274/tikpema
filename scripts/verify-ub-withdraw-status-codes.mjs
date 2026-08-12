import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// verify-ub-withdraw-status-codes — 202 on this endpoint means ONE thing.
//
// ═══ 🚨 THE DEFECT THIS PINS ══════════════════════════════════════════════════════════════════
// ub-withdraw used to return 202 for BOTH "your wallet is provisioning, nothing happened, retry
// freely" AND "an irreversible ~7-day withdrawal clock has started". Two opposite meanings, one
// status code, discriminated only by a body field.
//
// ⭐ MEASURED COST 2026-08-12: read as "started" three times in one session. The operator chased a
// missing record and an unchanged balance for an hour — and the natural remedy for a
// 202-with-no-record is to POST AGAIN, which against a REAL 202 is a second clock on the same
// funds. The ambiguity was most dangerous exactly where it mattered most.
//
// ⚠️ THIS IS A SOURCE-STRUCTURE GUARD, AND THAT IS A REAL LIMIT. It cannot prove what the deployed
// function returns — only that nobody has reintroduced the collision in this file. The behavioural
// proof is the deploy + a live call. Stated so the next reader does not over-trust a green.

const SRC = "netlify/functions/ub-withdraw.mjs";
const src = readFileSync(SRC, "utf8");
// Comments discuss the old 202 at length; strip them or this measures the prose.
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.error(`  ❌ ${name}\n     ${e.message}`); } };

console.log("\n── ub-withdraw status codes ─────────────────────────────────────");

t("⭐⭐ exactly ONE json(202 in the handler — 202 has a single meaning", () => {
  const n = (code.match(/json\(202/g) || []).length;
  assert.equal(n, 1,
    `found ${n} json(202 calls. A second one means 202 again covers two outcomes, and the one that ` +
    `matters is the irreversible one.`);
});

t("⭐ …and that one is the STARTED withdrawal", () => {
  const m = code.match(/json\(202,\s*\{[\s\S]{0,200}/);
  assert.ok(m, "no json(202 found at all — the started path must still return 202");
  assert.match(m[0], /status:\s*"started"/, "the sole 202 must be the started withdrawal");
  assert.match(m[0], /withdrawalId/, "a started 202 must carry the withdrawalId that makes it findable");
});

t("⭐⭐ the provisioning branch does NOT return 202", () => {
  const m = code.match(/if\s*\(wallet\.pending\)\s*\{[\s\S]{0,400}?\}/);
  assert.ok(m, "the wallet.pending branch has gone missing entirely");
  assert.doesNotMatch(m[0], /json\(202/, "provisioning must not share a code with an irreversible start");
  assert.match(m[0], /json\(503/, "provisioning is a transient refusal — same class as balance-unreadable");
});

t("⭐ …and it says plainly that nothing happened", () => {
  const m = code.match(/if\s*\(wallet\.pending\)\s*\{[\s\S]{0,400}?\}/);
  assert.match(m[0], /retryable:\s*true/, "the caller must be told a retry is safe");
  assert.match(m[0], /whatHappened/,
    "the response most likely to be misread as 'something began' must state that nothing did");
  assert.match(m[0], /reason:\s*"wallet-provisioning"/, "a machine-readable reason, not just prose");
});

t("both no-op refusals are the same class (503), so 'safe to retry' reads consistently", () => {
  assert.match(code, /reason:\s*"balance-unreadable"/);
  const codes = [...code.matchAll(/json\((\d{3})/g)].map((m) => m[1]);
  assert.ok(codes.includes("503"), "503 must still cover the unreadable-balance refusal");
  // ⭐ 200 is the GET (a read). 202 is the ONLY code meaning an action BEGAN. Nothing else in the
  // 2xx range may appear, or the "did something start?" question stops having one answer.
  const twoXX = [...new Set(codes.filter((c) => c.startsWith("2")))].sort();
  assert.deepEqual(twoXX, ["200", "202"], `unexpected 2xx codes: ${twoXX}`);
});

t("🚧 the known collision on the OTHER money paths is recorded, not silently dropped", () => {
  // Those endpoints still overload 202 with an in-flight transaction, where a mistaken retry is a
  // DOUBLE SPEND. They have live front-end callers, so they need their own change and proof — the
  // note must survive in the source until then.
  assert.match(src, /agent-send/, "the outstanding collision must stay named in this file");
  assert.match(src, /DOUBLE SPEND/i, "…including why it is worse there than it was here");
});

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-ub-withdraw-status-codes: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
