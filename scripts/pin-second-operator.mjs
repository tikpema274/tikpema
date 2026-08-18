#!/usr/bin/env node
// pin-second-operator.mjs — add a SECOND, INDEPENDENT pinning operator for every must-stay-pinned
// CID, by pin-by-CID against a provider that is not Pinata.
//
// ═══ ⚠️ THE TOKEN NEVER TOUCHES A FILE. Paste it into this shell only: ═════════════════════════
//
//   read -rs -p "token> " PIN2_TOKEN && export PIN2_TOKEN && echo
//   node scripts/pin-second-operator.mjs --provider filebase --bucket <name>            # DRY RUN
//   node scripts/pin-second-operator.mjs --provider filebase --bucket <name> --confirm  # PINS
//   unset PIN2_TOKEN
//
// 🚨 THERE IS DELIBERATELY NO `--env-file=.env` FORM, AND NO .env ENTRY TO CREATE. That is not
// caution, it is the direct lesson from PINATA_JWT: .env held a 10-char placeholder, the script's
// own DOCUMENTED invocation was `--env-file=.env`, and so the documented command could never work —
// it loaded the placeholder every time. The shape check caught it, which was luck: the check was
// written for a different failure (a captured CLI message). A placeholder that happened to be
// JWT-shaped would have sailed through and 401'd against the live API.
// ⭐ SO THE DEFENCE HERE IS NOT A BETTER SHAPE CHECK — it is refusing to read .env at all, plus an
// ANTI-PLACEHOLDER GATE that fails if the handed token appears as ANY value in .env. A shape check
// only catches placeholders someone predicted; that gate catches any placeholder, including one
// added next year by someone who never read this comment.
//
// ═══ 🚨 WHY pin-by-CID AND NOT RE-UPLOAD ═══════════════════════════════════════════════════════
// We hold the bytes locally, so re-uploading is tempting. But the CID a provider ANNOUNCES depends
// on how it wraps an upload: our addresses are CIDv1 raw ("bafkrei…"), while a file-upload API
// typically announces a UnixFS dag-pb root ("bafybei…"). If the second operator announces a
// different root, the bytes are stored, the routing instruments still show ONE operator for the CID
// the chain points at, and the work looks done while achieving nothing.
// pin-by-CID asks the provider to fetch and announce THE EXACT CID we name. No codec ambiguity.
//
// ═══ ⭐ THE ANNOUNCEMENT CANARY — THE FAILURE THIS SCRIPT IS SHAPED AROUND ══════════════════════
// Filebase tokens are scoped to ONE BUCKET, and buckets have a visibility setting. Filebase states
// it "publishes all of our provider records to IPFS DHT servers", and its docs define private vs
// public purely for the S3 access path (`https://<bucket>.s3.filebase.io/...`) — which strongly
// implies bucket visibility does not gate DHT announcement. ⚠️ BUT NO SOURCE WAS FOUND STATING
// THAT INTERSECTION OUTRIGHT, so it is not treated as known.
//
// 🚨 IF A PRIVATE BUCKET DID NOT ANNOUNCE, EVERY PIN WOULD SUCCEED AND THE OPERATOR COUNT WOULD
// NEVER MOVE — the same end state as not doing the work, reached through a door the earlier
// "does Filebase announce under a DNS name?" pre-check does not cover. That pre-check measured
// Filebase's peers on someone else's bucket; it cannot speak for ours.
// ⭐ SO IT IS MEASURED, NOT ASSUMED: after the FIRST CID is pinned, this polls the routing
// instruments until a NEW named operator appears. If none does within the deadline, the run STOPS
// and the remaining CIDs are never pinned. One unanswered documentation question becomes one
// measured fact, at the cost of one pin.
//
// ═══ ORDER ═══════════════════════════════════════════════════════════════════════════════════
// Strictly _pinned-set.mjs's pinOrder, and it stops on the first failure. v1.0.0 goes FIRST: it is
// the only CID here with sold products depending on it. Pinning the cheap ones first to "warm up"
// spends the run's reliability budget on the CIDs whose loss costs least.

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { byPinOrder } from "./_pinned-set.mjs";
import { bafkreiRawCid } from "./_cid.mjs";
import { classifyOperators } from "./_operator-count.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// ═══════════════════════════════ PROVIDERS ═══════════════════════════════
// Every provider here speaks the IPFS Pinning Service API (POST /pins, GET /pins/{requestid}).
// ⚠️ NO DEFAULT — publishing to the wrong account is not a mistake a script may make for you.
const PROVIDERS = {
  filebase: {
    label: "Filebase",
    base: "https://api.filebase.io/v1/ipfs",
    // ⭐ Measured 2026-08-18 on a CID Filebase already hosts: its peers announce
    // bitswap.filebase.io and trustless.filebase.io → registrable domain filebase.io.
    // Recorded so a run can SAY whether the operator it produced is the one expected —
    // but never asserted as a requirement: the gate counts distinctness, not names.
    expectOperator: "filebase.io",
    // Filebase issues a PER-BUCKET token, and the console shows S3 access key/secret separately.
    // Pasting the S3 secret is the likely mistake, so the 401 path names it explicitly.
    credentialHint:
      "console.filebase.com → Access Keys → the IPFS Pinning Service / RPC API section →\n" +
      '       "Choose Bucket to Generate Token" → pick the bucket → copy the Secret Access Token.\n' +
      "       ⚠️ That is NOT the S3 access key / secret pair shown elsewhere on the same page.",
  },
};

// ⚠️ Filebase publishes no token format, length or prefix. So there is deliberately NO shape gate:
// a shape I invented would reject valid tokens, and the repo already has one shape check that
// passed for the wrong reason. Validity is established by a READ-ONLY authenticated call instead —
// which proves the token works AND that it is the right artifact, before anything is written.
const MIN_TOKEN_LEN = 8;

const ROUTING = [
  { name: "delegated-ipfs.dev", url: (c) => `https://delegated-ipfs.dev/routing/v1/providers/${c}` },
  { name: "cid.contact", url: (c) => `https://cid.contact/routing/v1/providers/${c}` },
];

const PIN_POLL_MS = 5000, PIN_DEADLINE_MS = 5 * 60 * 1000;
const ANNOUNCE_POLL_MS = 20000, ANNOUNCE_DEADLINE_MS = 12 * 60 * 1000;
const HTTP_TIMEOUT_MS = 25000;

// ═══════════════════════════════ CLI ═══════════════════════════════

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1] ?? null; };
const CONFIRM = argv.includes("--confirm");
const PROVIDER_NAME = arg("--provider");
const BUCKET = arg("--bucket");
const ONLY = arg("--only");

const die = (m) => { console.error(`\n❌ REFUSING — ${m}\n`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!PROVIDER_NAME) die(`--provider is required. Known: ${Object.keys(PROVIDERS).join(", ")}`);
const P = PROVIDERS[PROVIDER_NAME];
if (!P) die(`unknown provider "${PROVIDER_NAME}". Known: ${Object.keys(PROVIDERS).join(", ")}`);
// ⭐ --bucket IS REQUIRED EVEN THOUGH THE TOKEN ALREADY DETERMINES THE BUCKET. The token is opaque,
// so without this the bucket would be whichever the token happened to be generated for — a choice
// made once in a console and invisible at every later run. Naming it makes the choice an assertion
// the operator can read back, and lets the run refuse if the token disagrees.
if (!BUCKET) die(`--bucket is required. The token is scoped to ONE bucket; name it so the choice is visible rather than inherited from whichever was default when the token was made.`);

console.log(`\n╔══ SECOND PINNING OPERATOR — ${P.label}`);
console.log(`║  bucket declared : ${BUCKET}`);
console.log(`║  endpoint        : ${P.base}`);
console.log(`║  mode            : ${CONFIRM ? "🚨 PINS (writes)" : "dry run"}`);
console.log(`╚═══════════════════════════════════════════════════════════════════\n`);

// ═══════════════ GATE 1 — the credential, without ever reading .env for it ═══════════════

console.log("── GATE 1 — credential ─────────────────────────────────────────────");
const TOKEN = (process.env.PIN2_TOKEN || "").trim();
if (!TOKEN) {
  die(
    `PIN2_TOKEN is missing or empty. Refusing to run unauthenticated.\n` +
    `   Paste it into this shell only:\n` +
    `     read -rs -p "token> " PIN2_TOKEN && export PIN2_TOKEN && echo\n` +
    `   Where to get it:\n       ${P.credentialHint}`
  );
}
if (/\s/.test(TOKEN)) die("PIN2_TOKEN contains whitespace — that is not a token. It was likely a CLI message or a wrapped paste.");
if (TOKEN.length < MIN_TOKEN_LEN) die(`PIN2_TOKEN is ${TOKEN.length} chars — too short to be a credential.`);

// ═══ 🚨 THE ANTI-PLACEHOLDER GATE ═══
// Reads .env ONLY to REFUSE, never to obtain a value. If the handed token appears as any value in
// .env, it is a placeholder someone committed to a file — which is how PINATA_JWT's documented
// command came to be unable to work. Catches any placeholder, not only predicted ones.
{
  let env = null;
  try { env = await readFile(path.join(REPO_ROOT, ".env"), "utf8"); } catch { /* absent is fine */ }
  if (env) {
    const values = env.split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => {
        const v = l.slice(l.indexOf("=") + 1).trim();
        return v.replace(/^["']|["']$/g, "");
      })
      .filter(Boolean);
    if (values.some((v) => v === TOKEN)) {
      die(
        `the token you supplied appears as a VALUE IN .env.\n` +
        `   That makes it a placeholder or a committed secret, and neither may be used to publish.\n` +
        `   ⭐ This gate exists because PINATA_JWT's documented '--env-file=.env' invocation loaded a\n` +
        `   placeholder every time and therefore could never work. Paste the real token instead:\n` +
        `     read -rs -p "token> " PIN2_TOKEN && export PIN2_TOKEN && echo`
      );
    }
    console.log(`  ✅ not present in .env (${values.length} value(s) checked)`);
  } else {
    console.log(`  ✅ no .env present`);
  }
}
console.log(`  ✅ ${TOKEN.length} chars, no whitespace  (no shape assertion — ${P.label} publishes no token format)`);

// ═══════════════ helpers ═══════════════

async function api(method, pathname, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${P.base}${pathname}`, {
      method, signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        Accept: "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { status: res.status, ok: res.ok, json, text };
  } catch (e) {
    return { status: 0, ok: false, json: null, text: `transport: ${e.message}` };
  } finally { clearTimeout(t); }
}

// Query BOTH routing instruments and return the operator classification for a CID.
// ⚠️ Union across instruments, and an instrument that fails yields UNKNOWN — never zero. The two
// have already been measured disagreeing (1 peer vs 2, and 0 vs 2 on a fresh pin).
async function measureOperators(cid) {
  const operators = new Map();
  let answered = false;
  const perInstrument = [];
  for (const inst of ROUTING) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(inst.url(cid), { signal: ctrl.signal, headers: { Accept: "application/json" } });
      if (!res.ok) { perInstrument.push(`${inst.name}: HTTP ${res.status}`); continue; }
      const text = await res.text();
      let providers = [];
      try {
        const d = JSON.parse(text);
        providers = d.Providers || [];
      } catch {
        // NDJSON form
        providers = text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean).flatMap((o) => o.Providers || [o]);
      }
      answered = true;
      perInstrument.push(`${inst.name}: ${providers.length} peer(s)`);
      for (const peer of providers) {
        const op = operatorOf(peer.Addrs) || `unknown:${peer.ID}`;
        if (!operators.has(op)) operators.set(op, new Set());
        operators.get(op).add(peer.ID);
      }
    } catch (e) {
      perInstrument.push(`${inst.name}: ${e.message}`);
    } finally { clearTimeout(t); }
  }
  return { c: classifyOperators(operators, answered), perInstrument };
}

// Same rule as verify-pin-providers.mjs: registrable domain, null when no DNS name is announced.
function operatorOf(addrs) {
  for (const a of addrs || []) {
    const parts = String(a).split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      if (["dns", "dns4", "dns6", "dnsaddr"].includes(parts[i])) {
        const host = parts[i + 1];
        const labels = host.split(".");
        return labels.length >= 2 ? labels.slice(-2).join(".") : host;
      }
    }
  }
  return null;
}

// ═══════════════ GATE 2 — the token WORKS and is the RIGHT ARTIFACT (read-only) ═══════════════

console.log("\n── GATE 2 — authenticated READ (proves the artifact before any write) ──");
{
  const r = await api("GET", "/pins?limit=1");
  if (r.status === 401 || r.status === 403) {
    die(
      `${P.label} rejected the token (HTTP ${r.status}${r.json?.error?.reason ? ` ${r.json.error.reason}` : ""}).\n` +
      `   ⭐ THE LIKELY CAUSE IS THE WRONG ARTIFACT, NOT A WRONG PASTE. ${P.label} shows an S3 access\n` +
      `   key and secret on the same console page as the pinning token, and only the pinning token\n` +
      `   authenticates this endpoint.\n       ${P.credentialHint}`
    );
  }
  if (r.status === 0) die(`could not reach ${P.base} — ${r.text}`);
  if (!r.ok) die(`${P.label} returned HTTP ${r.status}: ${String(r.text).slice(0, 200)}`);
  const count = r.json?.count ?? (Array.isArray(r.json?.results) ? r.json.results.length : null);
  console.log(`  ✅ authenticated — HTTP 200, ${count === null ? "pin list readable" : `${count} existing pin(s) in this bucket`}`);
}

// ═══════════════ GATE 3 — which bucket did the token resolve to? ═══════════════
//
// ⭐ The declared --bucket is an ASSERTION. Where the bucket is recoverable from the token or the
// API it is CHECKED; where it is not, that is said plainly rather than implied. An unverifiable
// assertion printed as if verified is worse than no check at all.
console.log("\n── GATE 3 — bucket ─────────────────────────────────────────────────");
{
  let derived = null;
  // Some Filebase tokens are base64 of a colon-joined triple whose last field is the bucket.
  // Attempted, never assumed — and ONLY the bucket field is ever printed, never the key material.
  try {
    const dec = Buffer.from(TOKEN, "base64").toString("utf8");
    if (/^[\x20-\x7e]+$/.test(dec) && dec.includes(":")) {
      const parts = dec.split(":");
      const last = parts[parts.length - 1];
      if (/^[a-z0-9][a-z0-9.-]{1,62}$/i.test(last)) derived = last;
    }
  } catch { /* not base64 — fine */ }

  if (derived) {
    if (derived !== BUCKET) {
      die(`the token resolves to bucket "${derived}" but --bucket says "${BUCKET}".\n` +
          `   The token decides where pins land. Re-run with --bucket ${derived}, or generate a token for ${BUCKET}.`);
    }
    console.log(`  ✅ token resolves to bucket "${derived}" — matches --bucket`);
  } else {
    console.log(`  ⚠️  the bucket is NOT derivable from this token, so "${BUCKET}" is UNVERIFIED —`);
    console.log(`      it is what you declared, not what was confirmed. Pins land wherever the token`);
    console.log(`      was generated for. Confirm in the console if that matters.`);
  }
  console.log(`  ⭐ bucket VISIBILITY (public/private) is not checked here and is not assumed to be`);
  console.log(`     harmless: ${P.label} defines private only for the S3 access path, and states it`);
  console.log(`     publishes all provider records to the DHT — but no source states that`);
  console.log(`     intersection outright. The announcement canary below MEASURES it.`);
}

// ═══════════════ GATE 4 — local bytes, and the baseline ═══════════════

const DOCS = ONLY ? byPinOrder().filter((d) => d.cid === ONLY || d.key === ONLY) : byPinOrder();
if (!DOCS.length) die(`--only "${ONLY}" matched no document in the pinned set.`);

console.log("\n── GATE 4 — local bytes re-hash to the recorded CIDs ────────────────");
for (const d of DOCS) {
  const buf = await readFile(path.join(REPO_ROOT, d.rel));
  const sha = createHash("sha256").update(buf).digest("hex");
  if (buf.length !== d.bytes) die(`${d.rel} is ${buf.length} bytes, expected ${d.bytes}`);
  if (sha !== d.sha256) die(`${d.rel} hashes ${sha}, expected ${d.sha256}`);
  const cid = bafkreiRawCid(Buffer.from(sha, "hex"));
  if (cid !== d.cid) die(`${d.rel} derives CID ${cid}, expected ${d.cid}`);
  console.log(`  ✅ ${d.key.padEnd(20)} ${d.bytes} bytes → ${d.cid.slice(0, 18)}…`);
}

console.log("\n── BASELINE — operators announcing each CID right now ───────────────");
const baseline = new Map();
for (const d of DOCS) {
  const { c, perInstrument } = await measureOperators(d.cid);
  baseline.set(d.cid, c);
  console.log(`  ${d.key.padEnd(20)} ${c.verdict.padEnd(11)} named: ${c.namedOps.join(", ") || "(none)"}   [${perInstrument.join(" | ")}]`);
}

// ═══════════════════════════ DRY RUN STOPS HERE ═══════════════════════════
if (!CONFIRM) {
  console.log("\n╔══ DRY RUN — nothing was pinned ════════════════════════════════════");
  console.log(`║  Would pin ${DOCS.length} CID(s) to ${P.label}, bucket "${BUCKET}", IN THIS ORDER:`);
  for (const d of DOCS) console.log(`║    ${d.pinOrder}. ${d.cid}  — ${d.what}`);
  console.log("║");
  console.log(`║  ⭐ After CID #1 the run STOPS unless a NEW named operator appears within`);
  console.log(`║     ${ANNOUNCE_DEADLINE_MS / 60000} minutes. A private bucket that stores but does not announce would`);
  console.log(`║     otherwise let all three pins "succeed" while the operator count never moves.`);
  console.log("║");
  console.log("║  Re-run with --confirm to pin.");
  console.log("╚════════════════════════════════════════════════════════════════════\n");
  process.exit(0);
}

// ═══════════════════════════ THE PINS ═══════════════════════════════

async function pinOne(d) {
  console.log(`\n── PINNING ${d.key} — ${d.cid}`);
  const post = await api("POST", "/pins", { cid: d.cid, name: d.name });
  if (!post.ok) {
    return { ok: false, why: `POST /pins → HTTP ${post.status} ${String(post.text).slice(0, 200)}` };
  }
  const requestid = post.json?.requestid;
  let status = post.json?.status;
  console.log(`  requestid ${requestid}  status ${status}`);
  if (!requestid) return { ok: false, why: "provider returned no requestid — cannot track this pin" };

  const started = Date.now();
  while (status !== "pinned" && status !== "failed" && Date.now() - started < PIN_DEADLINE_MS) {
    await sleep(PIN_POLL_MS);
    const g = await api("GET", `/pins/${requestid}`);
    if (!g.ok) { console.log(`  ⚠️  poll HTTP ${g.status} — retrying`); continue; }
    status = g.json?.status;
    process.stdout.write(`\r  status ${status}  (${Math.round((Date.now() - started) / 1000)}s)   `);
  }
  console.log("");
  if (status === "pinned") return { ok: true, requestid };
  if (status === "failed") return { ok: false, why: `provider reported status=failed for ${d.cid}` };
  // ⚠️ NOT A FAILURE AND NOT A SUCCESS. A queued pin may still complete.
  return { ok: false, indeterminate: true, requestid, why: `still "${status}" after ${PIN_DEADLINE_MS / 1000}s — the pin MAY still complete. Re-run with --only ${d.cid} later rather than assuming either way.` };
}

// ⭐ THE CANARY. Runs after the FIRST pin only, and gates everything after it.
async function awaitNewOperator(d) {
  const before = new Set(baseline.get(d.cid)?.namedOps ?? []);
  console.log(`\n── ⭐ ANNOUNCEMENT CANARY — does bucket "${BUCKET}" actually announce?`);
  console.log(`   baseline named operator(s): ${[...before].join(", ") || "(none)"}`);
  console.log(`   waiting up to ${ANNOUNCE_DEADLINE_MS / 60000} min for a NEW named operator on ${d.cid.slice(0, 18)}…`);
  const started = Date.now();
  while (Date.now() - started < ANNOUNCE_DEADLINE_MS) {
    await sleep(ANNOUNCE_POLL_MS);
    const { c } = await measureOperators(d.cid);
    const fresh = c.namedOps.filter((o) => !before.has(o));
    const secs = Math.round((Date.now() - started) / 1000);
    if (fresh.length) {
      console.log(`\n   ✅ NEW NAMED OPERATOR after ${secs}s: ${fresh.join(", ")}`);
      if (P.expectOperator && !fresh.includes(P.expectOperator)) {
        console.log(`   ⚠️  expected ${P.expectOperator} — got ${fresh.join(", ")}. Not an error; recorded because`);
        console.log(`      WHICH operator appeared is the fact this step exists to learn.`);
      }
      return { ok: true, fresh };
    }
    process.stdout.write(`\r   still ${c.namedOps.length} named (${c.namedOps.join(", ") || "none"})  ${secs}s   `);
  }
  console.log("");
  return { ok: false };
}

let pinned = 0;
for (const [i, d] of DOCS.entries()) {
  const r = await pinOne(d);
  if (!r.ok) {
    console.log(`\n❌ ${r.indeterminate ? "INDETERMINATE" : "FAILED"} on ${d.key}: ${r.why}`);
    console.log(`   Stopping. ${DOCS.length - i - 1} CID(s) NOT pinned — deliberately: the order is by`);
    console.log(`   consequence of loss, so continuing past a failure would spend the run on the cheap ones.`);
    process.exit(1);
  }
  pinned++;
  console.log(`  ✅ pinned (${pinned}/${DOCS.length})`);

  if (i === 0) {
    const canary = await awaitNewOperator(d);
    if (!canary.ok) {
      console.log(`\n🚨 STOPPING — the pin succeeded but NO NEW NAMED OPERATOR appeared within ${ANNOUNCE_DEADLINE_MS / 60000} min.`);
      console.log(`   This is exactly the failure the canary exists for, and it is INDETERMINATE, not proven:`);
      console.log(`     · bucket "${BUCKET}" may be private in a way that stores without announcing, OR`);
      console.log(`     · announcement propagation may simply be slower than the deadline.`);
      console.log(`   ⚠️ The remaining ${DOCS.length - 1} CID(s) were NOT pinned. Pinning them now would spend`);
      console.log(`      quota on an operator that may never be counted.`);
      console.log(`   Next: re-run 'npm run gate:pins' in ~30 min. If ${P.expectOperator} appears, resume with`);
      console.log(`   --only for each remaining CID. If it does not, check the bucket's visibility setting first.`);
      process.exit(1);
    }
  }
}

// ═══════════════ FINAL — the criterion, measured by the gate itself ═══════════════
console.log(`\n── FINAL MEASUREMENT ───────────────────────────────────────────────`);
for (const d of DOCS) {
  const { c } = await measureOperators(d.cid);
  console.log(`  ${c.verdict === "OK" ? "✅" : "⏳"} ${d.key.padEnd(20)} ${c.verdict.padEnd(11)} named: ${c.namedOps.join(", ") || "(none)"}`);
}
console.log(`\n⭐ ${pinned} CID(s) pinned to ${P.label}. THE CRITERION IS gate:pins EXITING 0, not this output:`);
console.log(`   npm run gate:pins`);
console.log(`   ⚠️ Announcement can lag minutes behind a pin — a CID still showing one operator here is`);
console.log(`      not yet a failure. Re-run the gate before concluding either way.\n`);
