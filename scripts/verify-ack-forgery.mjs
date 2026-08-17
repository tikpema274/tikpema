// verify-ack-forgery.mjs — POST-DEPLOY: does PRODUCTION refuse a token an outsider could compute?
//
// ═══ ⭐⭐ WHY THIS EXISTS BESIDE gate:deployed ═══════════════════════════════════════════════════
// `verify-ack-token-keyed.mjs` proves the CODE mints an HMAC. It cannot prove the DEPLOYMENT does:
// a stale bundle, a rolled-back function, or a SESSION_SECRET that differs from the one the suite
// assumed would all pass that suite while production still accepted a publicly-derivable token.
//
// This is the only EXTERNAL proof that the acknowledge gate is an authentication rather than
// arithmetic. It reconstructs the exact pre-v3 token — `sha256` of four public values, the same
// construction that reproduced a real stored token on 2026-08-17 — and asserts prod rejects it.
//
// ═══ 🚨 IT MUST NOT BE ABLE TO SPEND ═══════════════════════════════════════════════════════════
// `agent-execute-plan` only compares the token when the band is `acknowledge`; below that it falls
// through and EXECUTES. So a probe amount that drifted out of the band would turn this check into a
// bridge on every deploy.
//
// ⭐ THE AMOUNT IS THEREFORE DEEP IN THE BAND, NOT MERELY INSIDE IT. At 0.06 USDC against a ~0.0533
// fee the ratio is ~89% — the fee would have to COLLAPSE BY ~72% (below 0.015) for this to become
// executable. And the failure is bounded on the other side too: if the fee ever ROSE above the
// amount, the fee-floor refuses first (`fee >= amount` → nothing arrives → refused), so both
// directions of drift end in a refusal rather than a spend.
// ⚠️ RESIDUAL, STATED: that is a bound, not an impossibility. `executed === true` is asserted as a
// CRITICAL failure below, and the run reports the live ratio so the margin is visible each time.
//
//   node scripts/verify-ack-forgery.mjs
//   (SESSION_SECRET is read from the production Netlify context if not already exported)

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mintProdToken } from "./_prod-session.mjs";

const BASE = process.env.PROBE_BASE || "https://app.tikpema.xyz";
const OWNER = process.env.PROBE_OWNER || "0xfd801d082479e69f93bf79ccbf5f9dfe3c615767";
const AMOUNT = Number(process.env.PROBE_AMOUNT || 0.06); // deep in the acknowledge band — see header
const DEST = "base";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };

// ── the secret ──────────────────────────────────────────────────────────────────────────────────
// 🚨 IT NEVER SKIPS. A post-deploy check that quietly no-ops when a credential is missing reports
// success for a deployment it never examined — the absence-reads-as-safe family this repo keeps
// paying for. Missing secret ⇒ FAIL, loudly.
// ⚠️ This is a SECOND consumer of the SESSION_SECRET readback, alongside probe-ub-auth. That
// dependency is why `is_secret` on SESSION_SECRET is recorded as DECIDED-false; this makes the
// decision load-bearing in one more place rather than introducing anything new.
function secret() {
  const env = (process.env.SESSION_SECRET || "").trim();
  if (env) return env;
  try {
    return execFileSync("netlify", ["env:get", "SESSION_SECRET", "--context", "production"],
      { encoding: "utf8" }).split("\n").map((l) => l.trim()).filter(Boolean).pop();
  } catch { return ""; }
}

console.log(`\nverify-ack-forgery — can an OUTSIDER still satisfy the acknowledge gate on prod?\n`);

const s = secret();
if (!s || s.length < 16 || /no value set/i.test(s)) {
  console.error("  ❌ SESSION_SECRET unavailable (env or `netlify env:get … --context production`).");
  console.error("     REFUSING to report a pass on a deployment this check never examined.\n");
  process.exit(2);
}

const { token } = await mintProdToken({ address: OWNER, secret: s });

// The pre-v3 construction: sha256 over four values any caller already holds.
const forged = createHash("sha256")
  .update(`bridge|${OWNER.toLowerCase()}|${DEST}|${AMOUNT}|band:acknowledge|v2`).digest("hex");

const res = await fetch(`${BASE}/api/agent-execute-plan`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    plan: [{ type: "bridge_usdc", amountUsdc: AMOUNT, destination: DEST, reasoning: "ack-forgery probe" }],
    ackTokens: { 0: forged },
  }),
  signal: AbortSignal.timeout(45_000),
});
const d = await res.json().catch(() => ({}));
const disc = d.stepDisclosures?.[0];

console.log(`  HTTP ${res.status}   executed=${d.executed}   needsAck=${d.needsAck ?? false}`);
if (disc) console.log(`  band=${disc.band}  feeRatio=${(disc.feeRatio * 100).toFixed(1)}%  fee=${disc.feeUsdc} of ${AMOUNT}\n`);

// ── 🚨 the spend guard, asserted FIRST ──────────────────────────────────────────────────────────
check("🚨🚨 NOTHING EXECUTED — the probe never spends", d.executed === false,
  d.executed === true ? "CRITICAL: this probe just bridged real USDC" : `executed=${d.executed}`);

// ── the band must actually have fired, or the refusal proves nothing ────────────────────────────
check("⭐ the band was `acknowledge` — otherwise the token is never compared and this is vacuous",
  disc?.band === "acknowledge", `band=${disc?.band ?? "—"}`);
check("⚠️ …with margin: the ratio is comfortably above the 25% threshold",
  typeof disc?.feeRatio === "number" && disc.feeRatio >= 0.5,
  disc ? `${(disc.feeRatio * 100).toFixed(1)}% (fee would have to collapse to exit the band)` : "—");

// ── ⭐⭐ THE PROPERTY ────────────────────────────────────────────────────────────────────────────
check("⭐⭐ the FORGED public-input token was REFUSED", d.needsAck === true && d.executed === false);
check("🚨🚨 the server-issued token DIFFERS from the forgeable one — the key is live in prod",
  typeof disc?.ackToken === "string" && disc.ackToken !== forged,
  disc?.ackToken ? `served ${disc.ackToken.slice(0, 12)}… vs forged ${forged.slice(0, 12)}…` : "no token issued");

console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
