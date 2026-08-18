#!/usr/bin/env node
// verify-pin-providers.mjs — measure HOW MANY INDEPENDENT OPERATORS actually announce each
// MUST-STAY-PINNED CID, and fail while that number is 1.
//
// ═══ ⭐⭐ WHY COUNTING PROVIDERS IS THE WRONG METRIC ═══════════════════════════════════════════
// Measured 2026-08-18 for bafkreigton…o2af4, the CID two PAID reports resolve through:
//
//   delegated-ipfs.dev  -> 1 peer   Qmdv6yNi… /dnsaddr/bitswap-v3.pinata.cloud
//   cid.contact         -> 2 peers  Qmdv6yNi… bitswap-v3.pinata.cloud
//                                   QmaSDHYK… gateway-v3.pinata.cloud
//
// 🚨 A "providers >= 2" GATE WOULD HAVE PASSED ON cid.contact's ANSWER. Both peers are Pinata:
// that is TRANSPORT redundancy (bitswap peer + gateway peer) inside ONE account, at ONE company,
// under ONE billing relationship. The failure this gate exists to catch — the account lapses, the
// card expires, the operator deletes the pin — takes every Pinata peer with it simultaneously.
// So the gate counts DISTINCT OPERATORS, derived from the announced multiaddrs' DNS names, and a
// peer whose operator cannot be determined is counted as its own unknown operator rather than
// folded into an existing one (unknown must never be quietly absorbed into a passing count).
//
// ═══ ⭐ TWO INSTRUMENTS, BECAUSE ONE IS n=1 ═════════════════════════════════════════════════════
// The two routing endpoints DISAGREED on the very first measurement (1 peer vs 2). Either alone
// would have produced a confident, wrong picture. Both are queried; the operator set is the UNION,
// and each instrument's own answer is printed so a disagreement is visible rather than averaged.
//
// ═══ 🚨 AN UNREACHABLE INSTRUMENT IS NOT "ZERO PROVIDERS" ══════════════════════════════════════
// A routing endpoint that times out, 5xxs, or returns unparseable JSON yields UNKNOWN — never 0.
// Zero would read as a definite "the pin is gone" and, worse, an all-instruments-down run would
// otherwise produce a crisp, authoritative, entirely fabricated verdict. If NO instrument answered
// for a CID, this exits 1 as UNRESOLVED and says so in those words. Absence never reads as an
// answer here, in either direction.
//
// READ-ONLY. No credential, no pinning, no chain call, no money. Queries two public routing APIs.
//
//   node scripts/verify-pin-providers.mjs

const MIN_OPERATORS = 2;

// ═══ THE MUST-STAY-PINNED SET ═══════════════════════════════════════════════════════════════════
// Mirrors the list in scripts/pin-invariants.mjs (which holds it as a comment, not as data, so it
// cannot be imported). ⚠️ A SECOND COPY OF A LIST IS THE REPO'S RECURRING BUG, so this file does
// not merely restate it — checkDrift() below re-derives the set from the live companion route's
// rendered payload and FAILS if the two disagree. The copy is checked, not trusted.
const PINNED = [
  {
    cid: "bafkreigtonfmznrzbi3b34w27b5utra5jjcngc74skc7i67dymue3o2af4",
    what: "dd-service.json v1.0.0 — agentId 851891",
    why: "TWO PAID REPORTS were produced under this document; their attestations resolve through it",
  },
  {
    cid: "bafkreib6viz4fqa4oqrrgxfecwcttxyda6ilm5nmzr7yplznqeahqmomla",
    what: "dd-service.json v1.1.0 — agentId 851891",
    why: "supersedes v1.0.0; the document tokenURI(851891) points at once setAgentURI lands",
  },
  {
    cid: "bafkreidoeond3akvswce3e425o5grfygsvrfyleqkwathio4ae6y6vujae",
    what: "unified.json — agentId 851823",
    why: "the Tikpema Agent identity document; tokenURI(851823) points here",
  },
];

// A CID that does not exist. Its purpose is to prove the instruments can say NO — without it, an
// endpoint quietly returning {"Providers":[]} for everything would be indistinguishable from a
// working measurement of a lapsed pin.
// A WELL-FORMED CID for bytes that were never pinned anywhere — sha256 of a fixed sentence, encoded
// the same way pin-invariants.mjs derives a bafkrei address. ⚠️ It must be well-formed: a malformed
// CID makes the endpoint reject the REQUEST, which is an error, not an observed "no providers", and
// the first version of this file used one — the control read INCONCLUSIVE for the wrong reason.
const NEGATIVE_CONTROL = "bafkreid2yastsfu2iapelampew6y7pqv3ia67wjso4vn5wlezwvnupbaza";

const INSTRUMENTS = [
  { name: "delegated-ipfs.dev", url: (c) => `https://delegated-ipfs.dev/routing/v1/providers/${c}` },
  { name: "cid.contact", url: (c) => `https://cid.contact/routing/v1/providers/${c}` },
];

const COMPANION = "https://app.tikpema.xyz/api/dd-identity";
const TIMEOUT_MS = 30000;

// Map an announced multiaddr to the organisation that operates it. Registrable domain (last two
// labels) is the unit: bitswap-v3.pinata.cloud and gateway-v3.pinata.cloud are ONE operator.
// ⚠️ Returns null — never a default bucket — when no DNS name is announced, so the caller can count
// it as its own unknown rather than silently merging it into a known operator's tally.
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

async function queryOne(inst, cid) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(inst.url(cid), { signal: ctrl.signal, headers: { Accept: "application/json" } });
    clearTimeout(t);
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const text = await res.text();
    let d;
    try { d = JSON.parse(text); } catch { return { ok: false, reason: "unparseable JSON" }; }
    const peers = Array.isArray(d?.Providers) ? d.Providers : [];
    return { ok: true, peers };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, reason: e?.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : (e?.message || String(e)) };
  }
}

// The copy-drift check described above: every CID the deployed companion names in its version chain
// must appear in PINNED. If the route starts pointing at a v1.1.0 CID this file has never heard of,
// that CID would be load-bearing and unmeasured — the exact silence this gate exists to prevent.
async function checkDrift() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(COMPANION, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    clearTimeout(t);
    if (!res.ok) return { state: "UNKNOWN", note: `companion returned HTTP ${res.status}` };
    const d = await res.json();
    // Field names are dd-identity.mjs's own: `versions[]` and `current_document.cid`.
    const chain = Array.isArray(d?.versions) ? d.versions : [];
    const cids = chain.map((v) => v?.cid).filter(Boolean);
    if (d?.current_document?.cid) cids.push(d.current_document.cid);
    // 🚨 A 200 that names NO CID is a FAILURE, not UNKNOWN. It means the payload was renamed and this
    // check lost its grip on it — after which a genuinely drifted CID would pass unnoticed forever.
    // A mute check that reports UNKNOWN is exactly the "absence reads as safe" shape this repo keeps
    // getting bitten by, so it is failed loudly and the field names are named in the message.
    if (!cids.length) {
      return {
        state: "DRIFT",
        note: "companion answered 200 but named no CID under `versions[].cid` or `current_document.cid` — " +
          "the payload shape changed and this check can no longer see what it is meant to guard",
      };
    }
    const known = new Set(PINNED.map((p) => p.cid));
    const missing = [...new Set(cids)].filter((c) => !known.has(c));
    return missing.length
      ? { state: "DRIFT", note: `companion names CID(s) absent from PINNED: ${missing.join(", ")}` }
      : { state: "OK", note: `${new Set(cids).size} CID(s) named, all covered` };
  } catch (e) {
    clearTimeout(t);
    return { state: "UNKNOWN", note: e?.message || String(e) };
  }
}

console.log("\n══ PIN PROVIDER REDUNDANCY ═════════════════════════════════════════════════════");
console.log(`   requirement: at least ${MIN_OPERATORS} INDEPENDENT OPERATORS per must-stay-pinned CID`);
console.log(`   instruments: ${INSTRUMENTS.map((i) => i.name).join(", ")}\n`);

// ── negative control ───────────────────────────────────────────────────────────────────────────
process.stdout.write("negative control (a CID that does not exist) ... ");
let controlProved = false;
for (const inst of INSTRUMENTS) {
  const r = await queryOne(inst, NEGATIVE_CONTROL);
  if (r.ok && r.peers.length === 0) { controlProved = true; break; }
}
console.log(controlProved ? "0 providers — the instruments CAN say no" : "INCONCLUSIVE");
if (!controlProved) {
  console.log("  ⚠️ no instrument returned an empty set for a nonexistent CID. A '0 providers'");
  console.log("     result below would be unfalsifiable, so it is not treated as evidence.");
}

// ── measurement ────────────────────────────────────────────────────────────────────────────────
let failures = 0, unresolved = 0;
for (const p of PINNED) {
  console.log(`\n── ${p.cid}`);
  console.log(`   ${p.what}`);
  console.log(`   ${p.why}`);
  const operators = new Map(); // operator -> Set(peerId)
  let anyAnswered = false;
  for (const inst of INSTRUMENTS) {
    const r = await queryOne(inst, p.cid);
    if (!r.ok) { console.log(`   ${inst.name.padEnd(20)} UNKNOWN — ${r.reason} (NOT counted as zero)`); continue; }
    anyAnswered = true;
    console.log(`   ${inst.name.padEnd(20)} ${r.peers.length} peer(s)`);
    for (const peer of r.peers) {
      const op = operatorOf(peer.Addrs) || `unknown:${peer.ID}`;
      if (!operators.has(op)) operators.set(op, new Set());
      operators.get(op).add(peer.ID);
      console.log(`     · ${String(peer.ID).slice(0, 16)}…  ${op}  [${(peer.Protocols || []).join(",")}]`);
    }
  }
  if (!anyAnswered) {
    console.log(`   ⚠️ UNRESOLVED — no instrument answered. This is NOT a measurement of zero providers,`);
    console.log(`      and it is NOT a pass. Re-run; if it persists the routing APIs are down, not the pin.`);
    unresolved++;
    continue;
  }
  const opNames = [...operators.keys()].sort();
  const peerCount = [...operators.values()].reduce((n, s) => n + s.size, 0);
  console.log(`   → ${peerCount} distinct peer(s) across ${opNames.length} operator(s): ${opNames.join(", ")}`);
  if (opNames.length >= MIN_OPERATORS) {
    console.log(`   ✅ ${opNames.length} independent operators — the pin survives losing any one.`);
  } else if (opNames.length === 0) {
    // 🚨 ZERO IS NOT "ONE, BUT SMALLER". An instrument ANSWERED and announced nobody: either these bytes
    // were never pinned, or the pin has lapsed. Folding this into the single-operator branch printed
    // "SINGLE OPERATOR (undefined)" — a wrong diagnosis of the most serious state this gate can observe.
    failures++;
    console.log(`   ❌ NOT ANNOUNCED BY ANYONE. The instruments answered and named zero providers.`);
    console.log(`      Either this CID was never pinned, or the pin has LAPSED. If a report was sold`);
    console.log(`      under it, that report is no longer checkable against the claims it was produced under.`);
    console.log(`      (An unpinned CID reads this way too — expected for a version awaiting its pin.)`);
  } else {
    failures++;
    console.log(`   ❌ SINGLE OPERATOR (${opNames[0]}). ${peerCount} peer(s) here are transport redundancy,`);
    console.log(`      not custody redundancy: one lapsed account removes all of them at once.`);
  }
}

// ── drift ──────────────────────────────────────────────────────────────────────────────────────
console.log("\n── copy-drift check against the deployed companion");
const drift = await checkDrift();
console.log(`   ${drift.state} — ${drift.note}`);
if (drift.state === "DRIFT") failures++;
if (drift.state === "UNKNOWN") console.log("   (not a pass and not a failure — the companion could not be read)");

console.log("\n════════════════════════════════════════════════════════════════════════════════");
if (unresolved) {
  console.log(`UNRESOLVED for ${unresolved} CID(s) — no instrument answered. Exiting 1: an unmeasured`);
  console.log("permanent obligation is not a satisfied one.");
  process.exit(1);
}
if (failures) {
  console.log(`❌ ${failures} finding(s). A CID that two paid reports resolve through has ONE operator.`);
  console.log("   Confirmation says it is there TODAY; a second operator is what makes it SURVIVE.");
  process.exit(1);
}
console.log("✅ every must-stay-pinned CID is announced by at least two independent operators.");
