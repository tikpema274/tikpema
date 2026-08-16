// fire-ub-spend.mjs — ⚠️ MOVES REAL USDC. One authenticated in-range UB spend against PROD.
//
// ═══ 🚨 THIS IS THE MONEY-MOVING RUNNER. A BARE RUN IS A DRY RUN. ═══════════════════════════════
// Without `--confirm` it resolves the secret, mints the token, prints the exact request, and STOPS
// before any HTTP call. `--confirm` sends one real spend of `--amount` USDC cross-chain.
//
// ⭐ PROVE AUTH FIRST, FOR FREE. `scripts/probe-ub-auth.mjs` answers "does prod trust this token"
// with an over-cap amount and moves nothing. Run it before spending anything here — an auth failure
// discovered by a money-moving script has already cost the fee.
//
// ═══ ⚠️ TWO RUNNER DEFECTS FROM THE PREVIOUS (NOW-LOST) VERSION, FIXED HERE BY CONSTRUCTION ══════
// 1. THE CAPTURE WAS WRITTEN AFTER THE POLL LOOP, so a timeout destroyed the very evidence the
//    capture existed to preserve. Here the durable record is written IMMEDIATELY after the fire
//    returns, before anything is polled or asserted. (PROGRESS.md:9034.)
// 2. A NON-200 STILL ENTERED THE POLL LOOP, spending minutes polling for a transfer that was never
//    created. Here a non-200 short-circuits it entirely.
//
// ═══ RUN ════════════════════════════════════════════════════════════════════════════════════════
//   node scripts/probe-ub-auth.mjs                 # free auth proof FIRST
//   read -rs SESSION_SECRET && export SESSION_SECRET
//   node scripts/fire-ub-spend.mjs --amount 10.5              # DRY RUN — prints the exact call
//   node scripts/fire-ub-spend.mjs --amount 10.5 --confirm    # ⚠️ SENDS IT
//   unset SESSION_SECRET
//
// ⚠️ NO `--env-file=.env` — that loads the DEV secret. The guard refuses it rather than trusting you
// to remember; see scripts/_prod-session.mjs.

import { writeFileSync } from "node:fs";
import { requireProdSessionSecret, mintProdToken } from "./_prod-session.mjs";

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const CONFIRM = args.includes("--confirm");

const BASE = process.env.PROBE_BASE || "https://app.tikpema.xyz";
const ENDPOINT = `${BASE}/api/agent-ub-spend`;
const ADDRESS = process.env.PROBE_ADDRESS || "0x6fb28d6366e755e0e27307692282490c6682fc58";
const RECIPIENT = argOf("--recipient", ADDRESS);
const AMOUNT = Number(argOf("--amount", "0"));
const CHAIN = argOf("--chain", "Base_Sepolia");
const CAPTURE = argOf("--capture", `ub-spend-capture-${process.pid}.json`);

// ⚠️ NaN GUARD AT THE GATE. `amount > 0` is FALSE for NaN, but a later `amount > cap` is ALSO false —
// the repo's recorded NaN fail-open. A missing/garbled --amount must stop here, not drift downstream.
if (!Number.isFinite(AMOUNT) || AMOUNT <= 0) {
  console.error(`\n✖ --amount must be a positive number (got ${JSON.stringify(argOf("--amount", null))}).`);
  console.error(`  The server enforces floor <= amount <= cap; pick an in-range value.\n`);
  process.exit(2);
}

const secret = requireProdSessionSecret();
const { token, exp } = await mintProdToken({ address: ADDRESS, secret });

console.log(`\n════ UB SPEND · ${CONFIRM ? "⚠️  WILL MOVE REAL USDC" : "DRY RUN (nothing sent)"} ════\n`);
console.log(`  POST ${ENDPOINT}`);
console.log(`    Authorization: Bearer <token minted in-process, ${token.length} chars, exp ${new Date(exp * 1000).toISOString()}>`);
console.log(`    { recipientAddress: "${RECIPIENT}", amountUsdc: ${AMOUNT}, destinationChain: "${CHAIN}" }`);
console.log(`\n  spender  : ${ADDRESS} (this session's own agent SCA)`);
console.log(`  capture  : ${CAPTURE}`);

if (!CONFIRM) {
  console.log(`\nDRY RUN — nothing sent. Re-run with --confirm to move ${AMOUNT} USDC.\n`);
  process.exit(0);
}

// ── the fire ────────────────────────────────────────────────────────────────────────────────────
const firedAt = new Date().toISOString();
let status = null, body = null, transportError = null;
try {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ recipientAddress: RECIPIENT, amountUsdc: AMOUNT, destinationChain: CHAIN }),
    signal: AbortSignal.timeout(60_000),
  });
  status = res.status;
  try { body = await res.json(); } catch { body = { _nonJsonBody: true }; }
} catch (e) {
  // ⚠️ A TRANSPORT FAILURE IS NOT A "DIDN'T HAPPEN". The request may have reached the server and
  // moved funds before the socket died, so this is captured as UNKNOWN rather than as a failure.
  transportError = String(e?.name ?? e);
}

// 🚨 DURABLE CAPTURE FIRST — before any poll, any assertion, any print. This is the fix for the
// defect that destroyed a run's evidence by writing the record only after the poll loop timed out.
const capture = {
  firedAt, endpoint: ENDPOINT, request: { recipientAddress: RECIPIENT, amountUsdc: AMOUNT, destinationChain: CHAIN },
  spender: ADDRESS, status, body, transportError,
  outcome: transportError ? "UNKNOWN — transport failed; funds MAY have moved"
         : status === 200 ? "ACCEPTED" : `REFUSED (${status})`,
};
writeFileSync(CAPTURE, JSON.stringify(capture, null, 2));
console.log(`\n  ⭐ capture written to ${CAPTURE} BEFORE any polling — evidence survives a timeout.`);

if (transportError) {
  console.error(`\n🚨 TRANSPORT FAILED (${transportError}) — this is NOT proof nothing happened.`);
  console.error(`   The request may have reached the server. Reconcile on-chain before re-firing;`);
  console.error(`   a blind retry is how one spend becomes two.\n`);
  process.exit(3);
}

console.log(`\n  HTTP ${status}  ${JSON.stringify(body)?.slice(0, 300) ?? ""}`);

// ⚠️ SHORT-CIRCUIT: a non-200 created no transfer, so there is nothing to poll for. The old runner
// polled anyway and burned minutes proving an absence it already knew about.
if (status !== 200) {
  console.error(`\n❌ REFUSED (${status}) — no transfer was created, nothing to poll. Capture holds the body.`);
  if (status === 401) console.error(`   401 = the token was not trusted. Run scripts/probe-ub-auth.mjs (free) to isolate it.`);
  if (status === 409) console.error(`   409 = the agent is PAUSED — that is the kill-switch working, not a bug.`);
  console.log("");
  process.exit(1);
}

console.log(`\n✅ ACCEPTED — transferId ${body?.transferId ?? "—"} · txHash ${body?.txHash ?? "— (not yet)"}`);
console.log(`   ⚠️ ACCEPTED IS NOT SETTLED. A 200 means the spend was submitted, not that value landed`);
console.log(`   on the destination chain — the repo has already measured accepted ≠ confirmed on the`);
console.log(`   gateway path. Confirm on-chain before recording this as a completed proof.\n`);
