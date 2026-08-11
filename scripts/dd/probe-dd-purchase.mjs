// probe-dd-purchase.mjs — buy ONE real DD report end to end, against a real facilitator.
//
// ═══ 🚨 THIS SPENDS REAL USDC. A BARE RUN DOES NOT. ═══════════════════════════════════════════
// Without --confirm it does the entire READ-ONLY half and stops before paying: it fetches the 402,
// checks the quote is what we think we built, and snapshots the revenue wallet's Gateway balance.
// That half is worth running on its own — it catches a wrong payTo or a wrong price BEFORE money.
//
//   node --env-file=.env scripts/dd/probe-dd-purchase.mjs --url <draft>/.netlify/functions/dd-analyze
//   node --env-file=.env scripts/dd/probe-dd-purchase.mjs --url <draft>/.netlify/functions/dd-analyze --confirm
//
// ⚠️ --url IS REQUIRED. There is deliberately no default: the whole point of this run is that it
// happens against a DRAFT, and a default would eventually be pointed at production by omission.
//
// ⭐ ON A DRAFT, PREFER /.netlify/functions/dd-analyze OVER /api/dd-analyze. Both work on a healthy
// deploy — the handler builds `resource` from event.path either way, so the payment binds to whatever
// URL you actually hit and the retrieve URL derives from the same string. But /api/* depends on the
// netlify.toml redirect RESOLVING on that particular deploy, and a draft has been observed serving
// SPA HTML there while /.netlify/functions/dd-analyze answered normally. The functions path bypasses
// redirect resolution entirely, so it tests the SERVICE rather than the routing.
//
// 🚨 Never conclude "not deployed" from an HTML response at /api/*. This site's catch-all serves the
// SPA for anything unmatched, so a routing miss and a missing function look identical from outside.
// Ask the functions path before believing either.
//
// Flags:
//   --url <u>       the dd-analyze endpoint to buy from        (required)
//   --address <a>   subject to analyse   (default: a contract with code on Arc)
//   --poll <min>    retrieve poll budget in minutes            (default 20)
//   --confirm       ACTUALLY PAY $0.06 USDC
//
// ⭐ 20 minutes is the default poll budget for a reason. Settlement is a batch FLUSH measured at
// ~15.4 min on Arc, so a randomly-timed payment confirms anywhere in (0, ~15.4 min). A budget under
// the flush interval will frequently "fail" on a payment that is perfectly fine. Running out of
// budget is NOT a failure and NOT a loss — the handle stays redeemable forever; re-run with --handle
// or just GET the retrieve URL again.

import { fetchX402Requirements, payX402 } from "../../netlify/functions/_x402.mjs";

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const CONFIRM = process.argv.includes("--confirm");
const URL = arg("--url");
const SUBJECT = arg("--address", "0x0077777d7EBA4688BDeF3E311b846F25870A19B9"); // Gateway Wallet: real code on Arc
const POLL_MIN = Number(arg("--poll", "20"));
const HANDLE = arg("--handle");

const RPC = "https://rpc.testnet.arc.network";
const GATEWAY = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const USDC = "0x3600000000000000000000000000000000000000";
const AVAILABLE_BALANCE_SEL = "0x3ccb64ae";
const EXPECTED_PAYTO = "0xb407967319d56218c7e1c369125490e665a16ac4";
const EXPECTED_PRICE = "60000";

if (!URL) {
  console.error("✗ --url is REQUIRED (no default — this must target a DRAFT, never production by omission)");
  process.exit(2);
}

const pad = (a) => String(a).replace(/^0x/, "").toLowerCase().padStart(64, "0");
const usdc = (atomic) => (Number(atomic) / 1e6).toFixed(6);

// ═══ WHY THIS FILE TIMES OUT AND NARRATES ═══════════════════════════════════════════════════════
// Measured 2026-08-11: two --confirm runs hung with NO output and no way to attribute it. One
// stalled inside payX402; the other stalled on the FIRST await below, printing the "PHASE 0" header
// and nothing under it. From outside, a hang before the 402 and a hang after signing look identical
// — and they demand opposite responses, so "it hung" was not an observation anyone could act on.
//
// ⭐ THE ASYMMETRY THAT SHAPES ALL OF THIS: everything BEFORE the paid POST may be abandoned freely
// (no authorization has been sent, so nothing can be charged). Everything AFTER it must NEVER be
// abandoned on a timer — a client-side timeout there produces exactly the `charged: null` state
// this whole design exists to avoid, and would throw away the handle needed to resolve it.
// So: HARD TIMEOUTS before the money, OBSERVATION ONLY after it.
const STEP_TIMEOUT_MS = 25_000;
const stamp = () => new Date().toISOString().slice(11, 19);
const step = (msg) => console.log(`  [${stamp()}] ${msg}`);

/** Race a promise against a named timeout. PRE-MONEY USE ONLY — see the note above. */
const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`TIMEOUT after ${ms}ms in: ${label}`)), ms).unref?.()),
  ]);

/** availableBalance(USDC, depositor) on the Gateway Wallet. null = UNREADABLE, never zero. */
async function gatewayBalance(who) {
  try {
    const r = await fetch(RPC, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: GATEWAY, data: AVAILABLE_BALANCE_SEL + pad(USDC) + pad(who) }, "latest"],
      }),
      // ⭐ The probe's own read, bounded. Its absence is why a stalled baseline read presented as a
      // bare "PHASE 0" header with no line under it, indistinguishable from a stalled seller.
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
    const j = await r.json();
    if (j.error || typeof j.result !== "string") return null;
    return BigInt(j.result);
  } catch { return null; }
}

let fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) fail++;
};

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  DD PURCHASE PROBE — one real report, one real settlement           ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");
console.log(`  seller  : ${URL}`);
console.log(`  subject : ${SUBJECT}`);
console.log(`  mode    : ${CONFIRM ? "🚨 CONFIRM — WILL SPEND $0.06 USDC" : "read-only (no money)"}`);

// ── late redemption path: an existing handle, no new payment ───────────────────────────────────
if (HANDLE) {
  console.log(`\n── redeeming an existing handle ─────────────────────────────────`);
  const r = await fetch(`${URL}?handle=${encodeURIComponent(HANDLE)}`);
  const b = await r.json().catch(() => ({}));
  console.log(`  HTTP ${r.status}  ${b.status ?? ""} ${b.detail ?? ""}`);
  if (r.status === 200) {
    ok("⭐ SERVED", b.served === true);
    ok("  report present", !!b.report, b.report?.subject?.address);
    ok("  attestation signed", b.report?.attestation?.status === "signed", b.report?.attestation?.status);
    console.log(`\n  evidence: ${JSON.stringify(b.payment?.evidence)}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

// ═══ PHASE 0 — READ-ONLY. Everything that can be checked before money. ═══
console.log(`\n── PHASE 0 — the quote, checked before any payment ──────────────`);

step(`reading revenue wallet baseline (availableBalance, ${STEP_TIMEOUT_MS / 1000}s cap)…`);
const baselineBefore = await gatewayBalance(EXPECTED_PAYTO);
ok("revenue wallet Gateway balance is READABLE", baselineBefore !== null,
  baselineBefore === null
    ? `UNREADABLE or TIMED OUT after ${STEP_TIMEOUT_MS / 1000}s — a payment could never be confirmed; STOP`
    : `${usdc(baselineBefore)} USDC`);
if (baselineBefore === null) process.exit(1);

// ⚠️ Wrapped. An unreachable seller (bad draft URL, DNS, TLS) THROWS out of fetch, and an instrument
// that runs immediately before a payment must never answer with a stack trace — the operator needs to
// know "I could not reach it", not read a Node dump and guess.
let chal;
try {
  step(`fetching the 402 challenge from the seller (${STEP_TIMEOUT_MS / 1000}s cap)…`);
  chal = await withTimeout(
    fetchX402Requirements({ sellerUrl: URL, requestBody: { address: SUBJECT, chain: "arc-testnet" } }),
    STEP_TIMEOUT_MS, "fetchX402Requirements (the 402 challenge)");
  step("challenge received");
} catch (e) {
  console.log(`  ❌ could not reach the seller at all: ${e?.cause?.code ?? e?.message ?? e}`);
  console.log(`     Check the --url. A CLI draft prints TWO usable host forms; both work:`);
  console.log(`       https://<deploy-id>--<site>.netlify.app/.netlify/functions/dd-analyze`);
  console.log(`       https://<deploy-id>.app.tikpema.xyz.tikpema.xyz/.netlify/functions/dd-analyze   (doubled domain is NOT a typo)`);
  console.log(`     ⭐ Use /.netlify/functions/dd-analyze on a draft, not /api/dd-analyze — the latter`);
  console.log(`        depends on the netlify.toml redirect resolving, which tests routing, not the service.`);
  process.exit(1);
}
if (!chal.ok) {
  const raw = JSON.stringify(chal.body ?? {});
  console.log(`  ❌ no usable 402 challenge — ${raw.slice(0, 300)}`);

  // ⭐ HTML back means the ROUTE missed, not that the service is down. The catch-all serves the SPA
  // for anything unmatched, so "routing miss" and "function missing" are indistinguishable from here.
  if (/<!doctype html|<html/i.test(raw) || /got 404|got 200/.test(raw)) {
    console.log(`\n  🚨 That looks like SPA HTML, i.e. NOTHING MATCHED THIS PATH — a routing answer,`);
    console.log(`     not a statement about the service. If you targeted /api/dd-analyze, the`);
    console.log(`     netlify.toml redirect did not resolve on this deploy. Ask the function directly:`);
    console.log(`\n       node --env-file=.env scripts/dd/probe-dd-purchase.mjs --url ${String(URL).replace(/\/api\/dd-analyze\/?$/, "/.netlify/functions/dd-analyze")}\n`);
    console.log(`     If THAT answers, the service is fine and only /api/* routing is at fault.`);
  } else {
    console.log(`\n  ⚠️ A 503 here is EXPECTED and informative, not a bug:`);
    console.log(`     service-not-enabled  → DD_PUBLIC_ENABLED is not set in the context this deploy reads`);
    console.log(`     service-unverified   → the canary has not produced a health artifact for THIS build yet`);
    console.log(`     payment-misconfigured→ DD_PAYTO_ADDRESS is not set in that context`);
  }
  process.exit(1);
}

const req = chal.requirements ?? chal.challenge?.requirements ?? chal.body?.accepts?.[0] ?? chal.accepts?.[0];
console.log(`  quote: ${JSON.stringify({ payTo: req?.payTo, amount: req?.maxAmountRequired, asset: req?.asset })}`);
ok("⭐⭐ payTo is the DEDICATED REVENUE WALLET", String(req?.payTo).toLowerCase() === EXPECTED_PAYTO,
  `${req?.payTo}`);
ok("⭐ price is 60000 atomic ($0.06)", String(req?.maxAmountRequired) === EXPECTED_PRICE, String(req?.maxAmountRequired));
ok("asset is USDC on Arc", String(req?.asset).toLowerCase() === USDC);
ok("resource binds to this endpoint", typeof req?.resource === "string" && req.resource.includes("dd-analyze"), req?.resource);

if (fail > 0) {
  console.log(`\n🚨 QUOTE IS WRONG — refusing to continue. ${fail} check(s) failed.`);
  console.log("   Paying a wrong payTo would put unattributable USDC into a wallet whose zero history");
  console.log("   is the only thing making reconciliation possible. Fix the deploy, do not pay.");
  process.exit(1);
}

if (!CONFIRM) {
  console.log(`\n╔══════════════════════════════════════════════════════════════════════`);
  console.log(`║  ✅ READ-ONLY HALF PASSED. No money moved.`);
  console.log(`║  Baseline to beat: ${baselineBefore} atomic (${usdc(baselineBefore)} USDC)`);
  console.log(`║  Expect after payment: ${baselineBefore + BigInt(EXPECTED_PRICE)} (${usdc(baselineBefore + BigInt(EXPECTED_PRICE))} USDC)`);
  console.log(`║  Re-run with --confirm to spend $0.06 and complete the proof.`);
  console.log(`╚══════════════════════════════════════════════════════════════════════`);
  process.exit(0);
}

// ═══ PHASE 1 — PAY. Past this line, real USDC moves. ═══
console.log(`\n── PHASE 1 — 🚨 PAYING $0.06 USDC ──────────────────────────────`);
step("entering payX402 — it signs via Circle, POSTs the payment, then polls retrieve");
console.log(`  ⚠️ NO TIMEOUT IS APPLIED HERE, DELIBERATELY. Past this line an authorization may`);
console.log(`     already be in flight, and abandoning on a timer would produce charged:null and`);
console.log(`     discard the handle needed to resolve it. The ticker below OBSERVES ONLY.`);
const t0 = Date.now();

// ⭐ Heartbeat, not a watchdog. It can never cancel anything — it exists so that a stall has a
// TIMESTAMP and a duration instead of being an empty terminal. `unref` so it cannot hold the
// process open once payX402 resolves.
const ticker = setInterval(() => {
  const s = Math.round((Date.now() - t0) / 1000);
  console.log(`  [${stamp()}] …still inside payX402 at ${s}s (no output ≠ nothing happening; ` +
    `settlement polling is silent by design)`);
}, 15_000);
ticker.unref?.();

let res;
try {
  res = await payX402({
    sellerUrl: URL,
    challenge: chal,
    requestBody: { address: SUBJECT, chain: "arc-testnet" },
    approvedUsdc: 0.10,
    requireApproved: false,
    pollBudgetMs: POLL_MIN * 60 * 1000,
  });
} finally {
  clearInterval(ticker);
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\n── PHASE 2 — outcome after ${elapsed}s ─────────────────────────────`);
const b = res.body ?? res;

if (b?.executed && b?.data?.report) {
  const rpt = b.data.report;
  ok("⭐⭐⭐ 200 SERVED — the full round trip completed", true, `${elapsed}s`);
  ok("⭐ a REPORT was served, not a canned payload", rpt.subject?.address?.toLowerCase() === SUBJECT.toLowerCase(), rpt.subject?.address);
  ok("⭐⭐ the attestation is SIGNED", rpt.attestation?.status === "signed", rpt.attestation?.status);
  ok("  …bound to agentId 851891", String(rpt.attestation?.agentId) === "851891", String(rpt.attestation?.agentId));
  ok("  …carrying a signature a verifier can check", /^0x[0-9a-f]+$/i.test(rpt.attestation?.signature ?? ""));
  ok("coverage manifest accounts for the catalogue", (rpt.coverage?.totals?.checked ?? 0) + (rpt.coverage?.totals?.notChecked ?? 0) > 0,
    `${rpt.coverage?.totals?.checked} checked / ${rpt.coverage?.totals?.notChecked} not`);
  ok("⭐ confirmation is disclosed as AGGREGATE-ONLY", /AGGREGATE-ONLY/.test(b.data.payment?.attribution ?? ""));
  console.log(`\n  confirmation evidence: ${JSON.stringify(b.data.payment?.evidence)}`);
} else if (b?.pending) {
  console.log(`  ⏳ PENDING at budget exhaustion — this is NOT a failure and NOT a loss.`);
  console.log(`     handle   : ${b.handle}`);
  console.log(`     retrieve : ${b.retrieve}`);
  console.log(`     polls    : ${b.polls}`);
  console.log(`\n  ⭐ The entitlement is PERMANENT. Redeem later with:`);
  console.log(`     node --env-file=.env scripts/dd/probe-dd-purchase.mjs --url ${URL} --handle ${b.handle}`);
} else {
  console.log(`  ❌ unexpected outcome: ${JSON.stringify(b).slice(0, 600)}`);
  fail++;
}

// ═══ PHASE 3 — the money, read independently of anything the seller told us ═══
console.log(`\n── PHASE 3 — the revenue wallet, read straight from chain ──────`);
const after = await gatewayBalance(EXPECTED_PAYTO);
if (after === null) {
  console.log("  ⚠️ balance UNREADABLE right now — indeterminate, not a negative result. Re-read later.");
} else {
  const delta = after - baselineBefore;
  console.log(`  before ${baselineBefore} → after ${after}   (Δ ${delta} atomic = ${usdc(delta)} USDC)`);
  ok("⭐⭐ the revenue wallet's Gateway balance ROSE BY THE PRICE", delta >= BigInt(EXPECTED_PRICE),
    delta < BigInt(EXPECTED_PRICE) ? "not yet — settlement is batched; re-read after the flush" : `+${usdc(delta)}`);
}

console.log(`\n╔══════════════════════════════════════════════════════════════════════`);
console.log(`║  ${fail === 0 ? "✅ PROOF COMPLETE" : `❌ ${fail} CHECK(S) FAILED`}`);
console.log(`╚══════════════════════════════════════════════════════════════════════`);
process.exit(fail === 0 ? 0 : 1);
