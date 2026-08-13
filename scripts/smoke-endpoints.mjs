// smoke-endpoints — post-deploy: do the money endpoints still INSTANTIATE on prod?
//
//   node scripts/smoke-endpoints.mjs [origin]      default https://app.tikpema.xyz
//
// ═══ 🚨 WHAT THIS CATCHES THAT A BUILD DOES NOT ══════════════════════════════════════════════
// A wrong import does not fail the build. It fails at MODULE INSTANTIATION — on the first real
// request, as a 500. Adding two exports to _agent-wallets.mjs broke five suites locally for exactly
// that reason, and the deployed bundle is a separate artifact from the one the suites import.
//
// ⭐ AN UNAUTHENTICATED CALL THAT REFUSES PROVES THE MODULE LOADED. `requireSession` is the first
// thing each handler does, so this touches no wallet, no chain and no store.
//
// ═══ ⭐⭐ WHY THE BODY IS ASSERTED, NOT ONLY THE STATUS CLASS ═════════════════════════════════
// A 4xx FROM THE CDN AND A 4xx FROM THE FUNCTION ARE DIFFERENT FACTS, AND ONLY THE BODY
// DISTINGUISHES THEM. Measured 2026-08-12: the first version of this check classified any `4*` as
// "module loaded". `/api/job-run` returned **404 with an HTML page** — the request never reached the
// function at all — and the check printed a PASS. It turned "never got there" into evidence of
// health, which is this repo's recurring failure family wearing a smoke test's clothes.
//
// 🚨 WORSE, AND THE REASON THIS IS A HARD ASSERTION: an unmatched `/api/*` **GET** is served by the
// SPA catch-all as **200 with HTML**. A caller doing `if (!res.ok) throw` sees res.ok === TRUE, and
// with `.catch(() => ({}))` on the parse that HTML becomes an empty object read as success. A POST
// gets 404 because the SPA rule skips POST — so the failure mode DIFFERS BY METHOD, and the quiet
// one is the GET. A status class alone can never tell these apart.
//
// ⚠️ WHAT THIS DOES NOT PROVE: that the provisioning branch returns 503. That needs a first-login
// wallet race, which cannot be triggered on demand. It is covered by verify-provisioning-status.

const ORIGIN = process.argv[2] || "https://app.tikpema.xyz";

// ⚠️ PATHS ARE EXPLICIT, NOT DERIVED FROM A CONVENTION. Only 31 of 57 functions have an `/api/`
// redirect; the job plane is called directly. Assuming `/api/<name>` is what produced the false pass.
const ENDPOINTS = [
  { path: "/api/agent-send" },
  { path: "/api/agent-withdraw" },
  { path: "/api/agent-bridge" },
  { path: "/api/agent-act" },
  { path: "/api/job-bridge-approve" },
  { path: "/api/agent-ub-deposit" },
  { path: "/api/ub-withdraw" },
  { path: "/.netlify/functions/job-run", note: "no /api route — see the file header" },
  // ⭐⭐ THE THREE ALLOWLISTED POLLERS. They must KEEP their 202-on-provisioning, because
  // useGatewayBalance.ts:51, useWallet.ts:313 and AgentsPanel.tsx:105 branch on that CODE to drive a
  // poll. A sweep that changes 202 → 503 is exactly the change that could catch one of them, and a
  // wrongly-503'd poller fails SILENTLY (the card just never fills) rather than loudly.
  // ⚠️ THIS CHECKS INSTANTIATION ONLY. The 202 branch needs a first-login race and cannot be
  // triggered on demand — the source-level allowlist in verify-provisioning-status is what pins it.
  // ⭐ THE REMAINING SEVEN from the 18-handler wrap. Same edit, same instantiation risk — inferring
  // they are fine because eleven others passed is reasoning, not measurement.
  { path: "/api/agent-execute-plan" },
  { path: "/api/agent-ub-spend" },
  { path: "/api/agent-vault-deposit" },
  { path: "/api/agent-vault-withdraw" },
  { path: "/api/agent-vault-shares" },
  { path: "/api/job-swap-approve" },
  // 🚨 /api/dca-create 404'd until the redirect was added (see netlify.toml). Listed at the /api
  // path ON PURPOSE: that is what agentClient calls, so this entry stays red until the fix ships.
  { path: "/api/dca-create", note: "redirect added — was 404 in prod" },
  { path: "/api/dca-cancel", note: "redirect added — was 404 in prod" },
  { path: "/api/dca-list", note: "redirect added — was 404 in prod" },
  { path: "/api/agents", note: "POLLER — must keep 202" },
  { path: "/api/gateway-balance", note: "POLLER — must keep 202" },
  { path: "/api/my-wallet", note: "POLLER — must keep 202" },
];

const looksLikeHtml = (b) => /^\s*(<!doctype|<html)/i.test(b);

let pass = 0, fail = 0;
console.log(`\n── smoke: ${ORIGIN} ─────────────────────────────────────────────`);

for (const { path, note } of ENDPOINTS) {
  let code = 0, body = "", err = null;
  try {
    const res = await fetch(ORIGIN + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(25_000),
    });
    code = res.status;
    body = (await res.text()).slice(0, 300);
  } catch (e) { err = String(e?.name || e); }

  const problems = [];
  if (err) problems.push(`request failed (${err})`);
  else {
    // ⭐ THE THREE CONDITIONS, IN THE ORDER THAT MATTERS.
    if (code >= 500) problems.push(`HTTP ${code} — the module did not instantiate`);
    if (looksLikeHtml(body))
      problems.push("HTML body — this is the SPA catch-all, so the request NEVER REACHED THE FUNCTION");
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* handled below */ }
    if (!parsed || typeof parsed !== "object")
      problems.push("body is not JSON — only a JSON refusal proves the function answered");
    else if (!parsed.error)
      problems.push(`JSON without an \`error\` key (${Object.keys(parsed).join(",") || "empty"})`);
    if (!(code >= 400 && code < 500))
      problems.push(`HTTP ${code} — expected a 4xx refusal from requireSession`);
  }

  if (problems.length === 0) {
    pass++;
    console.log(`  ✅ ${path.padEnd(38)} ${code} ${JSON.parse(body).error}${note ? `  (${note})` : ""}`);
  } else {
    fail++;
    console.error(`  ❌ ${path.padEnd(38)} ${code}\n       ${problems.join("\n       ")}\n       body: ${body.slice(0, 120).replace(/\n/g, " ")}`);
  }
}

console.log(`\n${fail === 0 ? "✅" : "❌"} smoke-endpoints: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
