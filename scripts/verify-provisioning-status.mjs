import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// verify-provisioning-status — 202 must never be ambiguous inside one endpoint.
//
// ═══ 🚨 THE DEFECT THIS PINS ══════════════════════════════════════════════════════════════════
// `ensureOwnerWallet` can report `pending`. Seven endpoints answered that with **202**, which on
// each of them ALSO meant "your transaction is in flight" or "an irreversible clock has started".
// Two opposite outcomes — "nothing happened, retry freely" and "retrying double-spends" — behind
// one status code, discriminated only by a body field.
//
// ⭐ MEASURED 2026-08-12 on ub-withdraw: read as "started" three times in one session, ~2 hours
// lost. The obvious remedy for a 202-with-no-effect is to POST AGAIN — against a real 202 that is
// a duplicate money movement.
//
// ⭐⭐ AND IT WAS ALREADY WRONG IN THE CLIENT. 202 passes `res.ok`, so agent-send, agent-withdraw,
// agent-bridge, agent-act and job-bridge-approve handed the provisioning body to their callers AS A
// SUCCESSFUL RESULT — an absence reading as a completed money operation.
//
// ⭐ THE INVARIANT IS PER-FILE, NOT GLOBAL. Endpoints where 202 means ONLY provisioning
// (gateway-balance, my-wallet, agents, the vault reads) are unambiguous and their clients branch on
// the code — those keep 202 deliberately. What must never recur is ONE endpoint using 202 for both.

const DIR = "netlify/functions";
const files = readdirSync(DIR).filter((f) => f.endsWith(".mjs") && !f.startsWith("_"));

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.error(`  ❌ ${name}\n     ${e.message}`); } };
// ⚠️ AN ASYNC TEST HANDED TO A SYNCHRONOUS RUNNER PASSES WITHOUT EXECUTING. `fn()` returns a
// promise, the try/catch never sees the rejection, and the check is counted green having asserted
// nothing. Two checks here did exactly that until a mutation run exposed them — the suite could not
// fail. Async checks MUST use `ta`.
const ta = async (name, fn) => { try { await fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.error(`  ❌ ${name}\n     ${e.message}`); } };
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("\n── provisioning must never share a status code with an action ──");

// ═══ 1. THE INVARIANT ════════════════════════════════════════════════════════════════════════
t("⭐⭐ no endpoint uses 202 for BOTH provisioning and an action", () => {
  const bad = [];
  for (const f of files) {
    const code = strip(readFileSync(`${DIR}/${f}`, "utf8"));
    const n202 = (code.match(/json\(202/g) || []).length;
    const provisioning202 = /json\(202,\s*\{[^}]*status:\s*"provisioning"/s.test(code) ||
                            /json\(202,\s*\{\s*\n?\s*status:\s*"provisioning"/s.test(code);
    if (provisioning202 && n202 > 1) bad.push(`${f} (${n202} × 202, one of them provisioning)`);
  }
  assert.deepEqual(bad, [],
    "these endpoints answer 'nothing happened' and 'something irreversible began' with the same " +
    "status code:\n       " + bad.join("\n       "));
});

// ═══ 2. THE SEVEN THAT WERE FIXED USE THE SHARED HELPER ══════════════════════════════════════
const FIXED = ["agent-send", "agent-withdraw", "agent-bridge", "agent-act",
               "job-bridge-approve", "agent-ub-deposit", "job-run", "ub-withdraw"];

for (const name of FIXED) {
  t(`${name}: provisioning refuses via the shared helper, not a local copy`, () => {
    const src = readFileSync(`${DIR}/${name}.mjs`, "utf8");
    const code = strip(src);
    assert.match(code, /walletProvisioningRefusal\(\)/,
      "must use the one definition — seven copies of a constant is the drift this repo keeps meeting");
    assert.match(code, /WALLET_PROVISIONING_STATUS/, "…and the shared status, not a literal");
    assert.doesNotMatch(code, /json\(202,\s*\{\s*status:\s*"provisioning"/,
      "the ambiguous 202 has come back");
  });
}

// ═══ 3. THE HELPER ITSELF SAYS THE SAFE THING ════════════════════════════════════════════════
await ta("⭐ the shared refusal is 503 and states plainly that nothing happened", async () => {
  const m = await import("../netlify/functions/_agent-wallets.mjs");
  assert.equal(m.WALLET_PROVISIONING_STATUS, 503,
    "provisioning is transient and nothing happened — the same class as the balance-unreadable refusals");
  const b = m.walletProvisioningRefusal();
  assert.equal(b.reason, "wallet-provisioning", "a machine-readable reason, not only prose");
  assert.equal(b.retryable, true);
  assert.match(b.whatHappened, /nothing/i,
    "the response most likely to be misread as 'something began' must say that nothing did");
  assert.ok(b.error, "`error` is the key every existing client reads when !res.ok");
});

await ta("⭐⭐ 503 makes every existing client throw instead of silently succeeding", async () => {
  const m = await import("../netlify/functions/_agent-wallets.mjs");
  const s = m.WALLET_PROVISIONING_STATUS;
  // `res.ok` is true for 200-299. That is exactly why 202 leaked through as success.
  assert.ok(!(s >= 200 && s < 300),
    `status ${s} is 2xx, so res.ok is true and agentClient.post()/useWallet would return the ` +
    `provisioning body AS A SUCCESSFUL MONEY RESULT — the bug this change exists to remove`);
});

// ═══ 4. ub-withdraw's 202 still means exactly one thing ══════════════════════════════════════
t("⭐ ub-withdraw: the sole 202 is the STARTED withdrawal", () => {
  const code = strip(readFileSync(`${DIR}/ub-withdraw.mjs`, "utf8"));
  assert.equal((code.match(/json\(202/g) || []).length, 1, "202 must have a single meaning here");
  const m = code.match(/json\(202,\s*\{[\s\S]{0,200}/);
  assert.match(m[0], /status:\s*"started"/);
  assert.match(m[0], /withdrawalId/, "a started 202 must carry the id that makes it findable");
});

// ═══ 5. THE ENDPOINTS DELIBERATELY LEFT ALONE ════════════════════════════════════════════════
t("⭐ unambiguous provisioning-only endpoints keep their 202 (their clients branch on the code)", () => {
  // ⚠️ NOT an oversight. useGatewayBalance.ts:51, useWallet.ts:313 and AgentsPanel.tsx:105 read 202
  // as provisioning; changing these would break polling for no safety gain, because on these
  // endpoints 202 is not ambiguous — nothing irreversible shares it.
  for (const f of ["gateway-balance.mjs", "my-wallet.mjs", "agents.mjs"]) {
    const code = strip(readFileSync(`${DIR}/${f}`, "utf8"));
    assert.equal((code.match(/json\(202/g) || []).length, 1,
      `${f} has grown a second 202 — it is now ambiguous and must be fixed like the others`);
  }
});

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-provisioning-status: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
