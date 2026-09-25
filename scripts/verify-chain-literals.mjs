// verify-chain-literals.mjs — THE GREP-GUARD over the testnet chain literals (mainnet go/no-go §1 row 1).
//
//   node scripts/verify-chain-literals.mjs        (also: npm run test:literals, in test:all)
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════════════════════
// env-assert reads ONE copy per lever (ARC.rpc, ARC.chainId, GATEWAY.WALLET). A migration that misses
// a duplicate PASSES the assert and verifies x402/DD against the wrong network's Gateway. Measured
// 2026-09-20 (`git grep -l`, *.md excluded): the RPC host in 23 files, the chain id in 51, the testnet
// Gateway wallet in 13. Read file by file those split FIVE ways, and only one of them is refactor work:
//
//   source      the ONE copy per PACKAGE: app-server (_arc.mjs + _gateway.mjs), app-client
//               (src/config/chain.ts), dd-core (shared/dd/chains.mjs — must stay importable WITHOUT
//               netlify/functions, see the DD-core extraction design), and the env-assert table.
//   pin         THE published offer — shared/x402/published.mjs, the ONE "what buyers were told" pair
//               (network + asset) that every seller asserts its runtime against at import. At the flip
//               it is the conscious acknowledgement. (Was three in-code copies until phase B.)
//   table       an id→label lookup keyed by network id (NETWORK_LABELS in _dd-x402): fail-closed at
//               import — a published network with no row throws — so a flip ADDS a row, never moves one.
//   provider-list  shared/onchain-analyze/endpoints.mjs — the quorum's INDEPENDENT provider list, by
//               decision NOT derived from dd-core. Fail-closed: the quorum client runs assertChain()
//               (eth_chainId vs the declared id) per endpoint, so an entry forgotten on a flip fails its
//               chain guard → rpc-quorum-unmet → refusal, never a false claim; and C3 below makes the
//               list a flip-completeness check (after a flip the needle is the NEW host; an un-updated
//               list has zero hits → "stale entry" → exit 1). ⚠️ CAVEAT, recorded: independence of the
//               LIST is not independence of the PROVIDERS — the public host here and in chains.mjs is
//               the same node; the file's own header says so (`independenceVerified:false`).
//   control     a suite or fixture that asserts the value. A test that imports the value under test
//               tests nothing — these stay literal BY DESIGN and are allowlisted one by one.
//   record      a FACT about where something LIVES, never a lever: the registered ERC-8004
//               identities (unified.json is FROZEN), the evidence dir, the census harvest, and the
//               chain id beside AGENT_ID in dd-identity.mjs and beside agentId in shared/dd/identity.mjs —
//               deriving THOSE from ARC.chainId would make a mainnet flip silently claim identity
//               851891 lives on mainnet. It does not.
//   annotation  a comment that quotes the value (Circle's own doc examples). Reworded where cheap.
//   spike       scripts/spikes/ — one-off measurements, kept as records, never run as guards.
//   phase-b     a real re-literal that sits ON THE DD SURFACE (`DD_SURFACE_DIRS/FILES` in
//               stamp-build.mjs). ddTree is a CONTENT hash; any edit there rotates it and opens a
//               deposit refusal window, so those landed together in ONE deploy — phase B, 2026-09-20.
//               The list is EMPTY now and refuse mode keeps it so: a non-empty PHASE_B exits 1.
//
// ═══ ⭐ THE GUARD HOLDS NO LITERAL OF ITS OWN ═══════════════════════════════════════════════
// It imports the three values from the app-server source and searches for THEM. So it cannot drift
// from the source, and it needs no allowlist entry for itself.
//
// ═══ ⭐⭐ NON-VACUITY CONTROLS — these FAIL (exit 1) in EVERY mode, warn included ═════════════
//   C1  every declared package source actually CONTAINS the value it is declared to hold — the scanner
//       can see. Also the cross-package agreement: the client and dd-core sources hold the SAME chain
//       id and RPC host as the server source (env-assert does not check that today).
//   C2  the allowlist does NOT match a path it was never told about (two synthetic probes, one under
//       netlify/functions and one under scripts). An allowlist that matches everything FAILS here
//       rather than passing silently — the same discipline as gate:spec's negative control.
//   C3  every explicit allowlist path EXISTS and has ≥1 hit — an allowlist entry for a file that no
//       longer holds the literal is rot, and rot is how a list stops being read.
//   C4  every `phase-b` path IS on the DD surface (parsed from stamp-build.mjs, not restated), the pin
//       file is on the DD surface (a seller on the surface imports it), and DD-surface hits are tagged.
//   C5  every entry of an exact-count class (pin/record/site/annotation/table/provider-list) carries an
//       `expect` — a blanket allow on one of those files would hide a new re-literal beside the pin.
//
// ═══ MODE ═══════════════════════════════════════════════════════════════════════════════════
//   "warn"    (phase A, 8bd4821) — unallowlisted hits and phase-b entries were REPORTED, exit 0.
//   "refuse"  (phase B, now) — any unallowlisted hit exits 1, AND a non-empty PHASE_B list exits 1.
//   The flip happened in the same commit as the phase-B DD-surface edits, as the rule required.
//   verify-chain-literals-controls.mjs proves every control above fires, by mutation, on every run.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ARC, } from "../netlify/functions/_arc.mjs";
import { GATEWAY } from "../netlify/functions/_gateway.mjs";

const MODE = "refuse"; // phase B (2026-09-20). Flipped in the same commit that emptied PHASE_B — see the header.

// ── the three levers, read from the source, never typed here ─────────────────────────────────
const RPC_HOST = new URL(ARC.rpc).hostname;
const CHAIN_ID = String(ARC.chainId);
const GW_WALLET = String(GATEWAY.WALLET).toLowerCase();
const LEVERS = {
  rpcHost:       { needle: RPC_HOST, re: new RegExp(RPC_HOST.replace(/\./g, "\\."), "g") },
  chainId:       { needle: CHAIN_ID, re: new RegExp(`(?<![0-9A-Za-z_])${CHAIN_ID}(?![0-9A-Za-z_])`, "g") },
  gatewayWallet: { needle: GW_WALLET, re: new RegExp(GW_WALLET, "gi") },
};

// ── the package sources (class `source`) — C1 asserts each holds what it is declared to hold ───
const SOURCES = {
  "netlify/functions/_arc.mjs":        { pkg: "app-server", holds: ["rpcHost", "chainId"] },
  "netlify/functions/_gateway.mjs":    { pkg: "app-server", holds: ["gatewayWallet"] },
  "src/config/chain.ts":               { pkg: "app-client", holds: ["rpcHost", "chainId"] },
  "shared/dd/chains.mjs":              { pkg: "dd-core",    holds: ["rpcHost", "chainId"] },
  "netlify/functions/_env-assert.mjs": { pkg: "env-assert table", holds: ["rpcHost", "chainId", "gatewayWallet"] },
};

// ── directory rules (a prefix carries the reason for everything under it) ──────────────────────
const DIR_RULES = {
  "agent-metadata/":    { cls: "record", why: "registered ERC-8004 identities — unified.json is FROZEN; the chain id is where the identity LIVES; mainnet = a NEW registration, not an edit" },
  "evidence/":          { cls: "record", why: "captured evidence; a record is not a lever" },
  "scripts/x402-census/": { cls: "record", why: "harvested third-party listings; a dataset, not a lever" },
  "scripts/spikes/":    { cls: "spike",  why: "one-off measurements kept as records, never run as guards (FILE_UNWIRED_OK)" },
};

// ── explicit allowlist, one line per file, each with its class and its reason ──────────────────
const ALLOW = {
  // THE pin — one file, one pair. ⭐ `expect` pins the EXACT hit count per lever for every exact-count class —
  // a blanket allow on a file would hide a NEW re-literal beside the pin (x402-quote held two until phase A).
  "shared/x402/published.mjs":                 { cls: "pin", expect: { chainId: 1 }, why: "PUBLISHED_OFFER — what buyers were told; every seller asserts its runtime against it at import (on the DD surface by decision)" },
  // a lookup table keyed by network id — fail-closed at import; a flip ADDS a row
  "netlify/functions/_dd-x402.mjs":            { cls: "table", expect: { chainId: 1 }, why: "NETWORK_LABELS id→label; a published network without a row throws at import" },
  // the quorum's independent provider list — see the header for the fail-closed reason and the caveat
  "shared/onchain-analyze/endpoints.mjs":      { cls: "provider-list", expect: { rpcHost: 2 }, why: "one ENTRY + one load-bearing DD-surface comment naming the arc.network alias as the same backend; independent by decision (T, 2026-09-20): assertChain() per endpoint fails a forgotten entry closed; C3 makes the list a flip-completeness check; list-independence ≠ provider-independence" },
  // records in code
  "netlify/functions/dd-identity.mjs":         { cls: "record", expect: { chainId: 1 }, why: "CHAIN_ID beside AGENT_ID 851891 — where the identity was REGISTERED; must NOT derive from ARC.chainId" },
  "shared/dd/identity.mjs":                    { cls: "record", expect: { chainId: 1 }, why: "DD_PINNED_IDENTITY.chainId beside agentId 851891 — where the identity is REGISTERED; verifyAttestation pins against it and checks eth_chainId before any read; a record like dd-identity (T, 2026-09-20; moved from attest-circle.mjs 2026-09-25)" },
  // a claim on a static page, bound to the client source by a suite (it cannot import)
  "site/index.html":                           { cls: "site", expect: { chainId: 1 }, why: "static marketing page; verify-site-claims.mjs binds its chain-id claim to src/config/chain.ts" },
  // annotations left in place — comment-only quotations of a MEASURED or PUBLISHED fact; rewording would misquote
  "netlify/functions/built.mjs":               { cls: "annotation", expect: { chainId: 2 }, why: "comment-only: the 402 responses PROBED 2026-08-27 name eip155:<id> — a record of an observation" },
  "netlify/functions/_x402-vanilla.mjs":       { cls: "annotation", expect: { chainId: 2 }, why: "comment-only: quotes @circle-fin/x402-batching's own `networks:` example verbatim" },
  "scripts/dd/checks/repo-address-audit.mjs":  { cls: "annotation", expect: { chainId: 2 }, why: "comment-only: a worked example of the rule this check enforces" },
  // controls — suites and fixtures that PIN the value on purpose
  "scripts/verify-env-assert.mjs":             { cls: "control", why: "THE env-assert suite — pins all three on purpose (mixed-case wallet for normalisation)" },
  "scripts/verify-site-claims.mjs":            { cls: "control", why: "binds site/index.html's chain-id claim to the client source" },
  "scripts/verify-arc-gateway-watch.mjs":      { cls: "control", why: "fixture of Circle's Gateway list — the watch's control column" },
  "scripts/verify-fee-reconcile.mjs":          { cls: "control", why: "asserts the fee reconcile is chain-pinned" },
  "scripts/verify-snapshot-page.mjs":          { cls: "control", why: "asserts the snapshot page names no Arc network" },
  "scripts/verify-budget-consistency.mjs":     { cls: "control", why: "fixture: a CAIP-2 network on a recorded spend" },
  "scripts/verify-dd-two-axis-copy.mjs":       { cls: "control", why: "fixture: the settlement-vs-subject axis copy" },
  "scripts/verify-dd-card-copy.tsx":           { cls: "control", why: "fixture: a DD report subject" },
  "scripts/verify-vanilla-seller-limits.mjs":  { cls: "control", why: "fixture: a buyer's x-payment on the expected network" },
  "scripts/verify-vanilla-seller-bytes.mjs":   { cls: "control", why: "offline suite: the buyer signs on the expected chain id; the handler must accept" },
  "scripts/verify-vault.mjs":                  { cls: "control", why: "fixture: report subjects" },
  "scripts/verify-x402-signer-binding.mjs":    { cls: "control", why: "fixture: an EIP-712 domain" },
  "scripts/dd/_mock-chain.mjs":                { cls: "control", why: "the mock chain answers the expected id" },
  "scripts/dd/verify-attestation.mjs":         { cls: "control", why: "fixture: a signed report + identity" },
  "scripts/dd/verify-dd-facilitator.mjs":      { cls: "control", why: "fixture: chain id + settle-fate network" },
  "scripts/dd/verify-dd-report.mjs":           { cls: "control", why: "fixture: report subjects" },
  "scripts/dd/verify-endpoint.mjs":            { cls: "control", why: "asserts a report names the chain it was analyzed on" },
  "scripts/dd/verify-ofac-screen.mjs":         { cls: "control", why: "fixture: screened subjects" },
  "scripts/dd/verify-owner-tristate.mjs":      { cls: "control", why: "fixture: an injected chain" },
  "scripts/dd/verify-settle-gate.mjs":         { cls: "control", why: "fixture: chain id on the settle gate" },
  "scripts/dd/verify-subjectless-402.mjs":     { cls: "control", why: "pins the RPC host the engine must call (fetch interception)" },
  "scripts/dd/verify-canary-endpoint-binding.mjs": { cls: "control", why: "fixture: the Gateway wallet as a known-contract SUBJECT" },
  "shared/dd-canary/fixtures.mjs":             { cls: "control", why: "fixture (DD surface — a fixture, not a lever; untouched)" },
  "src/dev/dd-card-fixtures.ts":               { cls: "control", why: "fixture: a DD report subject" },
};

// ── phase B — real re-literals ON THE DD SURFACE, deliberately untouched in phase A ────────────
// ⛔ EMPTY since phase B (2026-09-20): dd-analyze ARC_RPC, _dd-x402 DD_VERIFYING_CONTRACT + its pin, _x402-confirm
// GATEWAY_WALLET all import their source; endpoints.mjs is a provider-list and shared/dd/identity.mjs a record, by
// decision. Refuse mode exits 1 if anything is ever listed here again — a DD-surface re-literal is fixed, not parked.
const PHASE_B = {};

// ── scan ──────────────────────────────────────────────────────────────────────────────────────
const SELF = "scripts/verify-chain-literals.mjs";
// tracked AND untracked-but-not-ignored: a NEW file holding a literal must be seen BEFORE it is committed
const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\0").filter(Boolean)
  .filter((p) => !p.endsWith(".md") && p !== SELF && p !== "package-lock.json");

const hits = new Map(); // path → { lever → count }
for (const p of tracked) {
  let text; try { text = readFileSync(p, "utf8"); } catch { continue; }
  for (const [lever, { re }] of Object.entries(LEVERS)) {
    const n = (text.match(re) || []).length;
    if (n) { if (!hits.has(p)) hits.set(p, {}); hits.get(p)[lever] = n; }
  }
}

// DD surface, parsed from stamp-build.mjs (never restated here)
const stampSrc = readFileSync("scripts/stamp-build.mjs", "utf8");
const ddDirs = [...(stampSrc.match(/const DD_SURFACE_DIRS = \[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const ddFiles = [...(stampSrc.match(/const DD_SURFACE_FILES = \[[\s\S]*?\n\];/) ?? [""])[0].matchAll(/^\s*"([^"]+\.mjs)"/gm)].map((m) => m[1]);
const onDdSurface = (p) => ddDirs.some((d) => p.startsWith(`${d}/`)) || ddFiles.includes(p);

const classify = (p) => {
  if (SOURCES[p]) return { cls: "source", why: `${SOURCES[p].pkg} source` };
  if (PHASE_B[p]) return { cls: "phase-b", why: PHASE_B[p] }; // before ALLOW: a deferred fix is never masked by an allow entry
  if (ALLOW[p]) return ALLOW[p];
  for (const [prefix, rule] of Object.entries(DIR_RULES)) if (p.startsWith(prefix)) return rule;
  return null;
};

let failed = 0;
const ok = (label, cond, detail = "") => { console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`); if (!cond) failed++; };

console.log("╔═════════════════════════════════════════════════════════════════════════════╗");
console.log(`║  CHAIN LITERALS — one source per package · mode: ${MODE.toUpperCase().padEnd(6)}                     ║`);
console.log("╚═════════════════════════════════════════════════════════════════════════════╝");
console.log(`  levers from the app-server source: rpcHost=${RPC_HOST} chainId=${CHAIN_ID} gatewayWallet=${GW_WALLET.slice(0, 6)}…${GW_WALLET.slice(-4)}`);
console.log(`  scanned ${tracked.length} tracked files (*.md, package-lock.json and this guard excluded) · ${hits.size} hold a literal`);

// ═══ C1 — the scanner can see, and the packages agree ═══
console.log("\n── C1 · package sources hold what they are declared to hold (positive control) ──");
for (const [p, { pkg, holds }] of Object.entries(SOURCES)) {
  const h = hits.get(p) || {};
  for (const lever of holds) ok(`${pkg.padEnd(16)} ${p} holds ${lever}`, (h[lever] || 0) >= 1, `${h[lever] || 0} hit(s)`);
}
{
  // cross-package agreement, read from each source's own text — the client and dd-core must name the
  // SAME chain id and host the server names. (Phase B moves this into env-assert at boot.)
  const client = readFileSync("src/config/chain.ts", "utf8");
  const ddcore = readFileSync("shared/dd/chains.mjs", "utf8");
  ok("app-client names the server's chain id in `id:`", new RegExp(`id:\\s*${CHAIN_ID}\\b`).test(client));
  ok("dd-core names the server's chain id in `id:`", new RegExp(`id:\\s*${CHAIN_ID}\\b`).test(ddcore));
  ok("app-client names the server's RPC host", client.includes(RPC_HOST));
  ok("dd-core names the server's RPC host", ddcore.includes(RPC_HOST));
}

// ═══ C2 — the allowlist does NOT match everything ═══
console.log("\n── C2 · negative control: a path the allowlist was never told about is NOT allowed ──");
for (const probe of ["netlify/functions/__chain-literal-probe__.mjs", "scripts/__chain-literal-probe__.mjs", "src/__probe__.ts"]) {
  ok(`${probe} → unclassified`, classify(probe) === null);
}
ok("the directory rules cover only their four prefixes", Object.keys(DIR_RULES).length === 4 && !Object.keys(DIR_RULES).some((d) => d === "" || d === "/" || d === "scripts/" || d === "netlify/"));

// ═══ C3 — no allowlist rot ═══
console.log("\n── C3 · every explicit allowlist path exists and still holds a literal ──");
for (const p of [...Object.keys(SOURCES), ...Object.keys(ALLOW), ...Object.keys(PHASE_B)]) {
  ok(p, existsSync(p) && hits.has(p), existsSync(p) ? (hits.has(p) ? "" : "NO HIT — stale entry, remove it") : "MISSING");
}

// ═══ C4 — phase-b entries are DD-surface, and DD-surface hits are tagged ═══
console.log("\n── C4 · phase-b entries sit on the DD surface (parsed from stamp-build.mjs) ──");
ok("DD_SURFACE_DIRS parsed (the check is not vacuous)", ddDirs.length >= 3, ddDirs.join(", "));
ok("DD_SURFACE_FILES parsed", ddFiles.length >= 5, `${ddFiles.length} files`);
for (const p of Object.keys(PHASE_B)) ok(`${p} is on the DD surface`, onDdSurface(p));
for (const [p, e] of Object.entries(ALLOW)) if (e.cls === "pin") ok(`the pin ${p} is on the DD surface (a seller on the surface imports it)`, onDdSurface(p));

// ═══ C5 — exact-count classes carry an exact expect ═══
console.log("\n── C5 · every pin/record/site/annotation/table/provider-list entry carries an exact expect ──");
const EXACT = new Set(["pin", "record", "site", "annotation", "table", "provider-list"]);
for (const [p, e] of Object.entries(ALLOW)) if (EXACT.has(e.cls)) ok(`${p} (${e.cls}) carries an exact expect`, !!e.expect && Object.keys(e.expect).length > 0);

// ═══ THE TABLE ═══
console.log("\n── classification of every file holding a literal ──");
const rows = [...hits.entries()].map(([p, h]) => ({ p, h, c: classify(p) }))
  .sort((a, b) => (a.c?.cls ?? "~").localeCompare(b.c?.cls ?? "~") || a.p.localeCompare(b.p));
const fmt = (h) => Object.entries(h).map(([k, n]) => `${k}×${n}`).join(" ");
const counts = {};
for (const { p, h, c } of rows) {
  const cls = c?.cls ?? "UNCLASSIFIED";
  counts[cls] = (counts[cls] || 0) + 1;
  console.log(`  ${cls.padEnd(12)} ${onDdSurface(p) ? "[DD-surface] " : ""}${p}  (${fmt(h)})${c?.why ? `\n               ${c.why}` : ""}`);
}
console.log("\n  totals: " + Object.entries(counts).map(([k, n]) => `${k}=${n}`).join("  ·  "));

// ═══ THE VERDICT ═══
// an `expect` entry whose counts drifted is a finding, not an allow — a new re-literal beside a pin
const drifted = rows.filter((r) => r.c?.expect && JSON.stringify(r.c.expect) !== JSON.stringify(r.h));
for (const r of drifted) console.log(`  ⚠️  ${r.p}: allowlisted as ${r.c.cls} with expect ${JSON.stringify(r.c.expect)} but holds ${JSON.stringify(r.h)} — a re-literal beside the ${r.c.cls}, or a stale expect`);
const unclassified = [...rows.filter((r) => r.c === null), ...drifted];
const phaseB = rows.filter((r) => r.c?.cls === "phase-b");
console.log(`\n── verdict (${MODE}) ──`);
if (unclassified.length) {
  console.log(`  ${MODE === "refuse" ? "❌" : "⚠️ "} ${unclassified.length} file(s) hold a chain literal OUTSIDE the allowlist:`);
  for (const r of unclassified) console.log(`       ${onDdSurface(r.p) ? "[DD-surface] " : ""}${r.p}  (${fmt(r.h)})`);
  if (MODE === "refuse") failed++;
  else console.log("     WARN-ONLY (phase A): reported, not refused. Each must import its package source or be classified.");
} else console.log("  ✅ no file holds a chain literal outside the allowlist");
if (phaseB.length) {
  console.log(`  ${MODE === "refuse" ? "❌" : "⚠️ "} ${phaseB.length} DD-surface re-literal(s) deferred to phase B (one deploy, one window):`);
  for (const r of phaseB) console.log(`       ${r.p} — ${r.c.why}`);
  if (MODE === "refuse") { failed++; console.log("     🚨 MODE is refuse but PHASE_B is not empty — the flip is only legal once these are fixed."); }
}

console.log(`\n  controls failed: ${failed}   ·   mode: ${MODE}`);
if (failed) console.log("  🚨 a CONTROL failed — the verdict above is untrustworthy until it is fixed (this exits 1 in every mode)");
process.exit(failed === 0 ? 0 : 1);
