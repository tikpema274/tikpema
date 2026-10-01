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
// ⭐ THE AMOUNT IS DERIVED FROM THE LIVE FEE (2026-10-01). It was a fixed 0.06, "deep in the band" at a ~0.054 fee —
// until the Base fee moved to ~0.0649 and the fee floor refused the probe before any band existed (deploy 6abe1aca).
// Now: a reference quoteOnly reads the fee, the probe is fee / 0.6 (ratio 60%), capped at 0.25 USDC. Both directions
// of drift still end in a refusal, never a spend: fee ≥ amount → the floor; ratio < 25% → step 1's band guard below.
// ⚠️ RESIDUAL, STATED: a bound, not an impossibility. `executed === true` is a CRITICAL FAIL; the ratio is printed.
//
// ═══ ⭐⭐ THREE VERDICTS — PASS / FAIL / UNTESTED — and the LOG says which ═══════════════════════════════════
// UNTESTED = prod refused the probe BEFORE the comparison; the gate was not examined. Red (exit 3), never green, but
// not FAIL (exit 1). The last line is `gate:forgery VERDICT=<…> — <why>` so a deploy log answers "which red?" without
// re-deriving it (2026-10-01's log could not). Decisions live in scripts/lib/forgery-verdict.mjs, suite-tested.
//
//   node scripts/verify-ack-forgery.mjs
//   (SESSION_SECRET is read from the production Netlify context if not already exported)

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mintProdToken } from "./_prod-session.mjs";
import { REFERENCE_AMOUNT_USDC, EXIT, probeAmountFromFee, readReferenceFee, step1Reached, step2Verdict, verdictLine }
  from "./lib/forgery-verdict.mjs";

const BASE = process.env.PROBE_BASE || "https://app.tikpema.xyz";
const OWNER = process.env.PROBE_OWNER || "0xfd801d082479e69f93bf79ccbf5f9dfe3c615767";
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
  console.log(verdictLine("UNTESTED", "SESSION_SECRET unavailable — no probe was sent"));
  process.exit(EXIT.UNTESTED);
}

const { token } = await mintProdToken({ address: OWNER, secret: s });


const post = (body) => fetch(`${BASE}/api/agent-execute-plan`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(45_000),
});
const planAt = (amountUsdc) => [{ type: "bridge_usdc", amountUsdc, destination: DEST, reasoning: "ack-forgery probe" }];
const read = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _nonJson: t.slice(0, 120) }; } };
const show = (b) => (typeof b?.blocked === "string" ? `  blocked="${b.blocked}"` : b?._nonJson ? `  non-JSON: ${b._nonJson}` : "");

// ── step 0: the LIVE fee at a reference amount (quoteOnly — executes nothing) ───────────────────────────
const r0 = await post({ plan: planAt(REFERENCE_AMOUNT_USDC), quoteOnly: true });
const b0 = await read(r0);
console.log(`  step 0 (reference quote, ${REFERENCE_AMOUNT_USDC} USDC): HTTP ${r0.status}  executed=${b0.executed}  fee=${b0.stepDisclosures?.[0]?.feeUsdc ?? "—"}${show(b0)}`);
const ref = readReferenceFee(r0.status, b0);
if (!ref.ok) finish(ref.verdict, ref.why);
const probe = probeAmountFromFee(ref.feeUsdc);
if (!probe.ok) finish("UNTESTED", probe.why);
const AMOUNT = probe.amountUsdc;
console.log(`  probe amount ${AMOUNT} USDC = fee ${ref.feeUsdc} / 0.6 (ratio ${(probe.ratio * 100).toFixed(1)}%)`);

// The pre-v3 construction: sha256 over four values any caller already holds.
const forged = createHash("sha256")
  .update(`bridge|${OWNER.toLowerCase()}|${DEST}|${AMOUNT}|band:acknowledge|v2`).digest("hex");

// ═══ ⭐⭐ TWO STEPS SINCE 2026-09-13 — THE SEAL COMES BEFORE THE ACK GATE ═════════════════════════
// The executor OPENS a sealed fee quote per bridge step before it compares any ack token, so step 1 re-prices with
// `quoteOnly` and returns the seal; step 2 posts it WITH the forged ack. 🚨 THE SPEND GUARD: step 2 is sent ONLY on
// a sealed acknowledge-band quote — below that band no ack is compared and a valid seal would EXECUTE.
const r1 = await post({ plan: planAt(AMOUNT), quoteOnly: true });
const b1 = await read(r1);
const d1 = b1.stepDisclosures?.[0];
console.log(`  step 1 (quoteOnly): HTTP ${r1.status}  requoted=${b1.requoted}  executed=${b1.executed}  band=${d1?.band ?? "—"}  sealed=${typeof d1?.quoteToken === "string"}${show(b1)}`);
const s1 = step1Reached(r1.status, b1);
if (!s1.reached) finish(s1.verdict, `${s1.why} — step 2 NOT sent`);

const r2 = await post({ plan: planAt(AMOUNT), quoteTokens: { 0: d1.quoteToken }, ackTokens: { 0: forged } });
const b2 = await read(r2);
const disc = b2.stepDisclosures?.[0] ?? d1;
console.log(`  step 2: HTTP ${r2.status}   executed=${b2.executed}   needsAck=${b2.needsAck ?? false}${show(b2)}`);
if (disc) console.log(`  band=${disc.band}  feeRatio=${(disc.feeRatio * 100).toFixed(1)}%  fee=${disc.feeUsdc} of ${AMOUNT}\n`);

// ── the checks, printed one per property (the verdict below is decided by step2Verdict, not by these) ───────
check("🚨🚨 NOTHING EXECUTED — the probe never spends", b2.executed === false,
  b2.executed === true ? "CRITICAL: this probe just bridged real USDC" : `executed=${b2.executed}`);
check("⭐ the band was `acknowledge` — otherwise the token is never compared and this is vacuous",
  disc?.band === "acknowledge", `band=${disc?.band ?? "—"}`);
check("⭐⭐ the FORGED public-input token was REFUSED", b2.needsAck === true && b2.executed === false);
check("🚨🚨 the server-issued token DIFFERS from the forgeable one — the key is live in prod",
  typeof disc?.ackToken === "string" && disc.ackToken !== forged,
  disc?.ackToken ? `served ${disc.ackToken.slice(0, 12)}… vs forged ${forged.slice(0, 12)}…` : "no token issued");

const v = step2Verdict(r2.status, b2, { forged, disclosure: d1 });
finish(v.verdict === "PASS" && fail > 0 ? "FAIL" : v.verdict, v.verdict === "PASS" && fail > 0 ? `${fail} check(s) failed beside a PASS verdict` : v.why);

// ── the end of every run: ONE verdict line, then the exit code that names it ──────────────────────
// ⭐ A hoisted declaration AT THE BOTTOM (2026-10-01): test:reachability's rule is positional — an assertion textually
// after the last `process.exit(` cannot redden a run — so the only exit besides the missing-secret one lives last.
function finish(verdict, why) {
  console.log(`\n${verdict === "PASS" ? "✅" : verdict === "UNTESTED" ? "⛔" : "❌"} ${verdictLine(verdict, why)}`);
  if (verdict === "UNTESTED") console.log("   The acknowledge gate was NOT examined on this deploy — red, and not a pass.");
  console.log(`   pass ${pass} / fail ${fail}\n`);
  process.exit(EXIT[verdict]);
}
