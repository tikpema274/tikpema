// probe-v10-signmessage.mjs — ZERO MONEY. The FIRST production evidence for the
// @circle-fin/developer-controlled-wallets ^9 → ^10.6.0 (resolves 10.8.0) bump.
//
// Pre-registered at db668ba (docs/v10-bump-deploy-preregistration.md, ADDENDUM 2) BEFORE running.
// That pre-registration is the contract this file executes; it is not amended by this file.
//
// ═══ WHY THIS EXISTS AT ALL ═════════════════════════════════════════════════════════════════════
// The bump is committed, pushed and DEPLOYED, and has produced ZERO production evidence: no gate,
// suite or probe has ever invoked a Circle SDK method against prod. `capture:window` reported
// no-window, correctly caveated — the tree hash moved because of a COMMENT, and the manifests sit
// outside SURFACES, so the deploy's actual substance contributed nothing to the hash. Offline
// evidence plus a hash that moved for the wrong reason is not evidence about production.
//
// ⚠️ AND IT EXISTS IN THE REPO BECAUSE THE LAST COPY DID NOT. The first cut of this probe lived in
// a session scratchpad and is GONE (MODULE_NOT_FOUND). Same lesson `_prod-session.mjs` opens with:
// a method that survives only as prose has to be re-derived, traps and all.
//
// ═══ THE CALL ═══════════════════════════════════════════════════════════════════════════════════
// `POST /api/agent-dd-report` with a valid session reaches:
//   agent-dd-report → makeProduceReport → _dd-rungs.mjs → ddAttestationOptions → makeCircleSigner
//   → circle() → client.signMessage({walletId, message})
// Zero USDC, zero gas, no chain write, no store write. One authenticated request.
//
// ⭐ WHAT A SIGNATURE PROVES, MECHANICALLY — measured in the INSTALLED dist, not assumed:
// `dist/developer-controlled-wallets.es.js` implements signMessage as
//     {entitySecretCiphertext: await z(e)(), ...s}
// so the ciphertext is generated PER CALL. A returned signature therefore proves the deployed
// entity secret was parsed and encrypted under v10's path — prediction 2 — rather than leaving that
// to inference.
//
// ⚠️ WHAT IT STILL DOES NOT PROVE — the typed-ERROR branch. The same dist wraps every signing call
// as `catch(n){throw b(n)?w(n):n}` (isAxiosError → fromAxiosError). On the SUCCESS path that catch
// is never entered. A pass here means "the SDK constructs, encrypts and transports in production".
// It never means "the shim works in production". This is stated in the verdict, not only here.
//
// ═══ RUN (the operator runs this; see WHO RUNS IT below) ════════════════════════════════════════
//   read -rs SESSION_SECRET && export SESSION_SECRET
//   node scripts/dd/probe-v10-signmessage.mjs
//   unset SESSION_SECRET
//
// ⚠️ NO `--env-file=.env`. That loads the DEV secret; prod 401s; and a 401 reads like an endpoint
// bug. `requireProdSessionSecret` refuses that case by comparing against .env — it does not rely on
// anyone remembering.
//
// ═══ WHO RUNS IT, AND WHY NOT AN AGENT ══════════════════════════════════════════════════════════
// Prod's SESSION_SECRET is deliberately absent from `.env` and must stay absent. Nothing here mints
// a prod session on its own; `requireProdSessionSecret()` exits(2) with the operator instruction.
// That interactive step IS the boundary. [[live-proof-fund-moving-user-runs]]
//
// ═══ 🚨 FIX 1 — A 401 IS "THE PROBE DID NOT RUN", NOT A FALSIFIER ═══════════════════════════════
// The scratchpad cut reported falsifier 3 (shim / typed-error) as "possible — inspect" on a body of
// {"error":"Authentication required"}. That is WRONG, and wrong in the shape this week keeps
// producing: agent-dd-report calls `requireSession(event)` and returns 401 AHEAD of the ladder, so
// on a 401 `circle()` is never called, no SDK client is ever constructed, and the shim is
// STRUCTURALLY INCAPABLE of being implicated. Naming it as a possible cause invents a suspect the
// observation cannot speak to.
// ⭐ THE RULE: a check must not offer a cause for an observation that could not have involved it.
// Same family as [[probe-must-discriminate-between-states]] — there, one reading covering several
// states; here, one reading assigned to a state it excludes.
//
// ═══ 🚨 FIX 2 — TOKEN LIFETIME IS PRINTED, AND AN EXPIRED TOKEN IS NEVER SENT ═══════════════════
// The scratchpad run minted a token with exp 12:51:29Z and dispatched it after 13:00 — the
// interactive paste ate the 30-minute lifetime, and the server's honest 401 was then read as an
// auth finding. Sessions last 30 min (`_auth.mjs` SESSION_TTL_SEC) and `verifyToken` rejects on
// `exp < now`, so an expired token and a wrong secret are INDISTINGUISHABLE from outside.
// So: remaining lifetime is printed at mint, re-checked immediately before dispatch, and a token
// with no life left is refused as "token expired before dispatch" rather than sent to earn a 401.
// A thin margin is refused too — the report takes seconds to produce, and expiring mid-flight
// produces exactly the 401 this guard exists to stop being misread.

import { requireProdSessionSecret, mintProdToken } from "../_prod-session.mjs";

const BASE = process.env.PROBE_BASE || "https://app.tikpema.xyz";
const ENDPOINT = `${BASE}/api/agent-dd-report`;
// Any address works for auth; the SUBJECT matters only in that it must survive the ladder and be
// analysable, because a refusal short-circuits before the signer.
const ADDRESS = process.env.PROBE_ADDRESS || "0x6fb28d6366e755e0e27307692282490c6682fc58";
// Arc testnet USDC — DD_SAMPLE_ADDRESS in _dd-descriptor.mjs: a real contract, so a real report.
const SUBJECT = process.env.PROBE_SUBJECT || "0x3600000000000000000000000000000000000000";
const CHAIN = process.env.PROBE_CHAIN || "arc-testnet"; // SUPPORTED_CHAINS[0]
const MIN_LIFETIME_SEC = Number(process.env.PROBE_MIN_LIFETIME_SEC || 60);
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 90_000); // quorum RPC, uncached by design

let pass = 0, fail = 0;
const check = (l, c, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
  return !!c;
};
const note = (l) => console.log(`  ·  ${l}`);

function abort(headline, detail) {
  console.error(`\n✖ ${headline}`);
  if (detail) console.error(`  ${detail}`);
  console.error(`\n  VERDICT: the probe did not run. NO falsifier applies, and nothing is proven`);
  console.error(`  about v10 either way.\n`);
  process.exit(2);
}

// ── the token ───────────────────────────────────────────────────────────────────────────────────
// PROBE_TOKEN exists for the case that produced the expiry bug: a token minted elsewhere and carried
// in by hand. It is subject to exactly the same lifetime guard — that is the point of accepting it
// here rather than leaving it to a hand-written curl with no guard at all.
const supplied = (process.env.PROBE_TOKEN || "").trim();

/** exp (unix seconds) out of a session token, WITHOUT the secret. Null if unreadable. */
function expOf(token) {
  try {
    const [p] = String(token).split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    return Number.isFinite(payload?.exp) ? payload.exp : null;
  } catch { return null; }
}

let token, exp, provenance;
if (supplied) {
  token = supplied;
  exp = expOf(token);
  if (exp === null) abort(`PROBE_TOKEN is not a readable session token.`, `Its payload did not decode to JSON with a numeric \`exp\`.`);
  provenance = `token: SUPPLIED via PROBE_TOKEN, ${token.length} chars`;
} else {
  const secret = requireProdSessionSecret();
  ({ token, exp } = await mintProdToken({ address: ADDRESS, secret }));
  provenance = `token: minted in-process, ${token.length} chars`;
}

const remainingAtMint = exp - Math.floor(Date.now() / 1000);
console.log(`\nprobe-v10-signmessage — ZERO MONEY · ${ENDPOINT}`);
note(provenance);
note(`exp ${new Date(exp * 1000).toISOString()} — ⏱ ${remainingAtMint}s of lifetime remaining right now`);
note(`subject ${SUBJECT} on ${CHAIN}`);
console.log("");

// 🚨 FIX 2. Refuse BEFORE the network, and say which refusal this is.
if (remainingAtMint <= 0) {
  abort(
    `TOKEN EXPIRED BEFORE DISPATCH (${Math.abs(remainingAtMint)}s past exp).`,
    `Not sent. The server would have answered 401, and a 401 from an expired token is ` +
    `indistinguishable from a wrong secret. Mint and send in the SAME step: drop PROBE_TOKEN and ` +
    `let this script mint in-process.`
  );
}
if (remainingAtMint < MIN_LIFETIME_SEC) {
  abort(
    `TOKEN HAS ONLY ${remainingAtMint}s LEFT (below the ${MIN_LIFETIME_SEC}s margin).`,
    `Not sent. The report runs live quorum RPC and takes seconds; a token that expires mid-flight ` +
    `returns the same 401 as a bad secret. Raise PROBE_MIN_LIFETIME_SEC only if you want that risk.`
  );
}

// ── the request ─────────────────────────────────────────────────────────────────────────────────
// ⚠️ A TRANSPORT FAILURE IS ITS OWN OUTCOME, not an HTTP status. Letting fetch reject would end the
// run in an unhandled rejection, which reads as a crash rather than as "the site was unreachable".
async function post(bearer) {
  const started = Date.now();
  let res;
  try {
    res = await rawPost(bearer);
  } catch (e) {
    return { status: 0, body: null, text: `transport: ${e?.name ?? "Error"}: ${e?.message ?? e}`, ms: Date.now() - started };
  }
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON is itself a finding — kept as `text` */ }
  return { status: res.status, body, text, ms: Date.now() - started };
}

function rawPost(bearer) {
  return fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ address: SUBJECT, chain: CHAIN }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

// ── control first ───────────────────────────────────────────────────────────────────────────────
// ⭐ WITHOUT THIS CONTROL A 401 PROVES NOTHING. If the route 401s everything — wrong URL, SPA
// catch-all, dead function — then the real call's 401 gets read as a statement about the credential
// when it is a statement about the route. The control is what separates them.
const control = await post(null);
const controlOk = check(
  "⭐ CONTROL — an UNAUTHENTICATED request is rejected 401 (so the route is alive and gating)",
  control.status === 401, `HTTP ${control.status} in ${control.ms}ms`
);
if (!controlOk) {
  console.log(`\n  control body: ${(control.text || "").slice(0, 200)}`);
  abort(
    `The control did not 401.`,
    `A route that does not gate anonymous requests cannot tell an auth failure from a dead route, ` +
    `so no reading of the authenticated call would be trustworthy. Nothing was concluded.`
  );
}

// ── the probe ───────────────────────────────────────────────────────────────────────────────────
const remainingAtDispatch = exp - Math.floor(Date.now() / 1000);
if (remainingAtDispatch <= 0) {
  abort(
    `TOKEN EXPIRED BEFORE DISPATCH (during the control call).`,
    `Not sent — same reason as above. The control consumed the remaining lifetime.`
  );
}
note(`dispatching with ⏱ ${remainingAtDispatch}s of token lifetime left`);

const probe = await post(token);
console.log(`\n  probe → HTTP ${probe.status} in ${probe.ms}ms\n`);

const report = probe.body?.report ?? null;
const att = report?.attestation ?? null;
const refusal = report?.refusal ?? null;
const sig = att?.signature ?? null;

// ═══ CLASSIFICATION ═════════════════════════════════════════════════════════════════════════════
// A CLOSED outcome set. Anything not named here lands in UNMODELLED and is a finding in itself —
// never a silent pass. [[absence-must-never-read-as-safe]]
let klass, headline, detail;

if (probe.status === 401) {
  // 🚨 FIX 1. See the header. requireSession returns 401 ahead of the ladder; circle() is never
  // called; no falsifier can be implicated by this reading.
  klass = "AUTH";
  headline = "AUTH — THE PROBE DID NOT RUN. No falsifier applies.";
  detail =
    "The control 401'd too, so the route is alive and gating; this 401 is about the CREDENTIAL, not\n" +
    "  the endpoint. `requireSession` refuses ahead of the ladder, so `circle()` was never called and\n" +
    "  no SDK client was ever constructed — falsifiers 1, 2 and 3 are all STRUCTURALLY INCAPABLE of\n" +
    "  being implicated by this observation, and naming any of them here would be inventing a suspect.\n" +
    "  The token had " + remainingAtDispatch + "s of life at dispatch, so expiry is ruled out. Re-read prod's secret:\n" +
    "    netlify env:get SESSION_SECRET --context production | grep -vE '^\\s*$' | tail -1";
} else if (probe.status === 405 || probe.status === 400) {
  klass = "NOT-REACHED";
  headline = "THE LADDER REFUSED THE INPUT — signMessage was never reached. THIS PROVES NOTHING.";
  detail = `refusal.reason = ${JSON.stringify(refusal?.reason ?? null)}. This is a probe-configuration\n` +
           `  fault (subject or chain), not a statement about v10. Fix PROBE_SUBJECT / PROBE_CHAIN and re-run.`;
} else if (probe.status === 503) {
  klass = "NOT-REACHED";
  headline = "A GATE REFUSED BEFORE ANALYSIS — signMessage was never reached. THIS PROVES NOTHING.";
  detail = `Either the HEALTH rung (the detector failed its own fixtures) or the policy store was\n` +
           `  unreadable. Both refuse ahead of the signer, so no SDK call happened. Body: ${(probe.text || "").slice(0, 160)}`;
} else if (probe.status === 200 && att?.status === "signed") {
  klass = "SIGNED";
  headline = "⭐⭐ SIGNED IN PRODUCTION — the first production evidence for v10.";
  detail = null;
} else if (probe.status === 200 && att?.status === "unsigned" && refusal?.reason) {
  klass = "NOT-REACHED";
  headline = `THE REPORT REFUSED (${refusal.reason}) — signMessage was never reached. THIS PROVES NOTHING.`;
  detail =
    refusal.reason === "chain-unreadable"
      ? `Every RPC read failed, so the analysis had nothing to attest and returned before the signer.\n` +
        `  That is an Arc RPC finding (this repo has been throttled there before), NOT an SDK finding.`
      : `detail: ${String(refusal.detail ?? "").slice(0, 200)}`;
} else if (probe.status === 200 && att?.status === "unsigned") {
  // The signer is caught and DEGRADED in _dd-rungs.mjs — a signing failure is a 200 with an
  // unsigned attestation, which is precisely why a 200 alone can never be the pass condition.
  klass = "SIGNER-FAILED";
  headline = "🚨 THE SIGNER FAILED IN PRODUCTION — falsifier 1 or 2. This IS evidence, and it is a finding.";
  detail =
    `The report completed but could not be signed, so signMessage WAS reached and threw. The response\n` +
    `  carries only a correlation id by design — the discriminating error is in the Netlify function log:\n` +
    `    detail: ${String(att.detail ?? "").slice(0, 200)}\n` +
    `  A ciphertext/hex error is falsifier 1 (the deployed secret differs from the shape-checked value,\n` +
    `  or v10's WebCrypto RSA-OAEP path differs from the hexToBytes guard read out of the dist).\n` +
    `  A transport/module-resolution error is falsifier 2 (externalized axios did not resolve under\n` +
    `  \`npm ci\` — a failure bundling cannot catch). ⚠️ DO NOT PICK ONE FROM HERE: this response cannot\n` +
    `  tell them apart. Read the log, then record which.`;
} else if (probe.status === 500) {
  klass = "UNMODELLED";
  headline = "HTTP 500 — unmodelled. Inspect before attributing anything.";
  detail =
    `The handler's outer catch produced this, and signing failures do NOT reach it (they degrade to a\n` +
    `  200 with an unsigned attestation). So this is something outside the signer. Falsifier 3 (a typed\n` +
    `  error surfacing wrong) is CONSISTENT with a 500 but is not established by one — the log under the\n` +
    `  correlation id decides. Body: ${(probe.text || "").slice(0, 200)}`;
} else {
  klass = "UNMODELLED";
  headline = `HTTP ${probe.status} with attestation.status ${JSON.stringify(att?.status ?? null)} — unmodelled.`;
  detail = `Body: ${(probe.text || "").slice(0, 240)}`;
}

// ── the assertions, run ONLY on the branch they can speak to ────────────────────────────────────
if (klass === "SIGNED") {
  check("PREDICTION 4 — HTTP 200", probe.status === 200, `HTTP ${probe.status}`);
  check("PREDICTION 3 — attestation.status is \"signed\", not a refusal", att.status === "signed");

  // ⚠️ A 200 IS NOT THE PASS. These three are.
  const present = check(
    "🚨 PREDICTION 1 — a signature is PRESENT (not null, not empty)",
    typeof sig === "string" && sig.length > 0,
    sig === null ? "ABSENT" : `${String(sig).length} chars`
  );
  if (present) {
    check(
      "🚨 PREDICTION 1 — …and it is HEX-SHAPED (0x + lowercase hex, attachAttestation lowercases)",
      /^0x[0-9a-f]+$/.test(sig), `${sig.slice(0, 12)}…${sig.slice(-6)}`
    );
    // Not an exact length: an SCA signature is not required to be 65 bytes, and asserting 132 chars
    // would fail a perfectly good signature for the wrong reason. Non-trivial length + hex is the
    // honest bound; the exact bytes are reported so a reader can judge.
    const bytes = (sig.length - 2) / 2;
    check(
      "🚨 PREDICTION 1 — …and it is a non-trivial length (>= 32 bytes)",
      bytes >= 32, `${bytes} bytes${bytes === 65 ? " (65 = standard ECDSA r,s,v)" : ""}`
    );
  } else {
    console.log("");
    console.log("  🚨 ABSENT — signMessage may never have been reached; THIS PROVES NOTHING.");
    console.log("     An attestation marked \"signed\" with no signature is a contradiction in the response");
    console.log("     itself and is a finding on its own. Do not record this run as evidence for v10.");
  }

  // ⚠️ THE SAME OBSERVATION, A DIFFERENT CLAIM — not a second instrument, and not corroboration.
  // It is listed separately only because the pre-registration listed it separately.
  // [[repeating-one-instrument-is-not-corroboration]]
  check(
    "⭐ PREDICTION 2 — the deployed entity secret parsed and encrypted under v10 (same signature, inferred)",
    /^0x[0-9a-f]+$/.test(String(sig)),
    "signMessage generates entitySecretCiphertext PER CALL in the installed 10.8.0 dist, so a " +
    "signature cannot exist without that path having run"
  );

  note(`agentId ${att.agentId} · keyId ${att.keyId} · method ${att.method} · alg ${att.alg}`);
  note(`verifyingContract ${att.verifyingContract} · chainId ${att.chainId} · canon ${att.canon}`);
} else {
  // ⚠️ REFUSES TO CALL A FAILED RUN A PASS. Every non-SIGNED branch is a failure of THIS PROBE's
  // purpose — producing production evidence — even where it is not a failure of the deploy.
  fail++;
  console.log(`  ❌ NO PRODUCTION EVIDENCE FOR v10 WAS PRODUCED BY THIS RUN.`);
}

// ═══ 🚨 RECONCILE THE HEADLINE WITH THE ASSERTIONS ══════════════════════════════════════════════
// Found by running this classifier against a stubbed known case: a response with
// `attestation.status:"signed"` and a NULL signature printed every ABSENT warning correctly and then
// still headlined `VERDICT [SIGNED] — the first production evidence for v10`. Exit code 1, headline
// a pass. A reader skims the verdict line.
// ⭐ THE BRANCH IS CHOSEN BY THE RESPONSE; THE VERDICT MUST BE EARNED BY THE ASSERTIONS. Deriving
// the headline from the branch alone lets a claim outlive the check that was supposed to support it.
if (klass === "SIGNED" && fail > 0) {
  klass = "SIGNED-CONTRADICTORY";
  headline = "🚨 THE RESPONSE CLAIMS \"signed\" BUT THE ASSERTIONS FAILED — NO EVIDENCE FOR v10.";
  detail =
    "An attestation marked signed whose signature does not survive inspection is a contradiction in\n" +
    "  the response itself, and a finding on its own. signMessage may never have been reached.\n" +
    "  THIS PROVES NOTHING about v10 — do not record it as a pass.";
}

// ── verdict ─────────────────────────────────────────────────────────────────────────────────────
console.log(`\n──────────────────────────────────────────────────────────────────────────────`);
console.log(`  VERDICT [${klass}]  ${headline}`);
if (detail) console.log(`  ${detail}`);

if (klass === "SIGNED" && fail === 0) {
  console.log(``);
  console.log(`  ⚠️ WHAT THIS PASS DOES NOT PROVE — the typed-ERROR branch. The installed dist wraps`);
  console.log(`  every signing call as \`catch(n){throw isAxiosError(n) ? fromAxiosError(n) : n}\`, and the`);
  console.log(`  success path never enters that catch. Record this as "the SDK constructs, encrypts and`);
  console.log(`  transports in production" — NEVER as "the shim works in production". The shim remains`);
  console.log(`  proven offline only. (Pre-registered at db668ba; unchanged by this result.)`);
}
console.log(`──────────────────────────────────────────────────────────────────────────────`);
console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
