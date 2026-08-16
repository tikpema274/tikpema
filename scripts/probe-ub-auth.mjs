// probe-ub-auth.mjs — ZERO MONEY. Does prod trust a locally-minted session token?
//
// ═══ ⭐⭐ THE DISCRIMINATOR, WHICH IS THE ENTIRE POINT ════════════════════════════════════════════
// Send a VALID-SHAPE token with a DELIBERATELY OVER-CAP amount to `POST /api/agent-ub-spend`:
//
//     401  →  the token was REJECTED. The secret is not prod's. Nothing about the endpoint is proven.
//     400  →  the token was TRUSTED and the CAP refused the amount. Auth works. NOTHING MOVED.
//
// ⭐ The over-cap amount is what makes this free. `agent-ub-spend.mjs` enforces the cap AT THE TOP,
// BEFORE any UB call and before anything signs (reject-not-clamp, :60) — so a trusted-but-over-cap
// request returns 400 having touched no funds. A merely-authenticated probe would have to send a
// SPENDABLE amount and would therefore move money to answer an auth question.
//
// ⚠️ A 200 WOULD BE A DEFECT, NOT A PASS. It would mean the cap did not reject an amount above it —
// i.e. the reject-not-clamp guarantee is broken — and it would mean this probe just spent real USDC.
// It is asserted against explicitly rather than left to fall through an else.
//
// ═══ RUN (the secret is prod's, and is NOT in .env — see scripts/_prod-session.mjs) ══════════════
//   read -rs SESSION_SECRET && export SESSION_SECRET
//   node scripts/probe-ub-auth.mjs
//   unset SESSION_SECRET
//
// ⚠️ NO `--env-file=.env`. That loads the DEV secret; prod 401s; the 401 reads like an endpoint bug.
// The guard refuses that case by comparing against .env — it does not rely on you remembering.

import { requireProdSessionSecret, mintProdToken } from "./_prod-session.mjs";

const BASE = process.env.PROBE_BASE || "https://app.tikpema.xyz";
const ENDPOINT = `${BASE}/api/agent-ub-spend`;
// Any address works — the question is whether the SIGNATURE is trusted, not who signed.
const ADDRESS = process.env.PROBE_ADDRESS || "0x6fb28d6366e755e0e27307692282490c6682fc58";
// ⚠️ Far above any plausible cap. If a future cap ever exceeded this the probe would start spending,
// so it is asserted against the cap the server REPORTS in its own 400 body, below.
const OVER_CAP_USDC = Number(process.env.PROBE_AMOUNT || 100000);

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };

const secret = requireProdSessionSecret();
const { token, exp } = await mintProdToken({ address: ADDRESS, secret });

console.log(`\nprobe-ub-auth — ZERO MONEY · ${ENDPOINT}`);
console.log(`  token: minted in-process, ${token.length} chars, exp ${new Date(exp * 1000).toISOString()}`);
console.log(`  amount: ${OVER_CAP_USDC} USDC — deliberately over cap, so a TRUSTED token still moves nothing\n`);

// ── control first: does an UNSIGNED request 401? ────────────────────────────────────────────────
// ⭐ WITHOUT THIS CONTROL A 401 PROVES NOTHING. If the endpoint 401s everything (wrong URL, redirect,
// dead function), the real probe's 401 would be read as "secret is wrong" — a false finding about a
// credential, produced by a broken route. The control makes the two distinguishable.
async function post(bodyToken, amount) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(bodyToken ? { Authorization: `Bearer ${bodyToken}` } : {}) },
    body: JSON.stringify({ recipientAddress: ADDRESS, amountUsdc: amount, destinationChain: "Base_Sepolia" }),
    signal: AbortSignal.timeout(30_000),
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON body is itself a finding */ }
  return { status: res.status, body };
}

const control = await post(null, OVER_CAP_USDC);
check("⭐ CONTROL — an UNAUTHENTICATED request is rejected 401", control.status === 401,
  `HTTP ${control.status}`);

// ── the probe ───────────────────────────────────────────────────────────────────────────────────
const probe = await post(token, OVER_CAP_USDC);
console.log(`\n  probe → HTTP ${probe.status}  ${JSON.stringify(probe.body)?.slice(0, 160) ?? ""}\n`);

check("🚨 the probe did NOT return 200 — a 200 means the cap failed to reject AND money moved",
  probe.status !== 200, `HTTP ${probe.status}`);

const trusted = probe.status === 400;
const rejected = probe.status === 401;
check("⭐⭐ the verdict is one of the two known outcomes, not something unmodelled",
  trusted || rejected, `HTTP ${probe.status}`);

if (trusted) {
  check("⭐⭐ PROD TRUSTS THE TOKEN — auth works, and the cap refused the amount (nothing moved)",
    /exceeds per-spend limit|below minimum spend/.test(JSON.stringify(probe.body ?? {})),
    `cap reported: ${probe.body?.cap ?? "—"}`);
  // ⚠️ Guards the probe's own premise: if the cap ever rose above the probe amount, this script would
  // begin SPENDING instead of probing. Asserted against the server's own reported cap, not a constant.
  check("⚠️ …and the probe amount is still safely ABOVE the cap the server reports",
    typeof probe.body?.cap !== "number" || OVER_CAP_USDC > probe.body.cap,
    `probe ${OVER_CAP_USDC} vs cap ${probe.body?.cap ?? "not reported"}`);
} else if (rejected) {
  console.log("  🚨 401 WITH A 401 CONTROL AND A WELL-FORMED TOKEN: the supplied secret is not prod's.");
  console.log("     The guard already ruled out the dev value, empty, and 'No value set' — so re-read");
  console.log("     prod's value and check for a stray leading/trailing character:");
  console.log("       netlify env:get SESSION_SECRET --context production | grep -vE '^\\s*$' | tail -1");
  fail++; // an untrusted token is a FAILED probe, not a neutral observation
}

console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
