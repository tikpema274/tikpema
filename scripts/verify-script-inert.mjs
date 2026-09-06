// verify-script-inert.mjs — the money-moving scripts are INERT until --send, and the wallets they
// burn from are visible to discovery.
//
// ⛔ FOUR PROPERTIES, EACH WITH THE MUTATION IT EXISTS TO CATCH:
//   1. a bare load makes ZERO network calls and exits NON-ZERO with a DISTINCT code
//   2. the operator wallet set is DERIVED from config — adding a var extends the scan, no edit here
//   3. an unrecognised SPIKE_FROM is refused, and the refusal NAMES THE CONSEQUENCE
//   4. a tool-written receipt says `tool-signed`, not `chain-discovered`, and gets no exemption

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATOR_WALLET_VARS, operatorWallets, operatorWalletReport, scanOwnerSet } from "../shared/operator-wallets.mjs";
import { checkSpikeSource, SPIKE_SOURCE_REASON } from "../shared/spike-source-guard.mjs";
import { discoveredReceipt, RECEIPT_ORIGIN, destinationForDomain } from "../netlify/functions/_bridge-discover.mjs";
import { isAutoRetryExhausted } from "../netlify/functions/_bridge-receipts.mjs";
import { blobsCredentials, assertStoreReachable } from "../shared/blobs-cli.mjs";

let pass = 0, fail = 0;
const check = (l, ok, d = "") => { if (ok) { pass++; console.log(`  ✅ ${l}`); } else { fail++; console.log(`  ❌ ${l}${d ? `  — ${d}` : ""}`); } };

const SCRIPTS = [
  { path: "scripts/spike-bridge.mjs", exit: 3, writesReceipt: false },
  { path: "scripts/bridge-direct.mjs", exit: 4, writesReceipt: true },
];

console.log("\n── 1. ⛔ INERT ON A BARE LOAD — zero network, distinct non-zero exit ───");
// ⚠️ ESM IMPORTS HOIST, so "the guard is first in the text" proves nothing on its own. This
// instruments fetch AND node:http/https to THROW and imports the module bare — the only way to know
// the imported graph does not dial at load time. [[assert-on-rendered-output-not-source-regex]]
const probe = join(mkdtempSync(join(tmpdir(), "inert-")), "probe.mjs");
writeFileSync(probe, `
let calls = [];
globalThis.fetch = (...a) => { calls.push("fetch"); throw new Error("NETWORK DURING IMPORT"); };
const http = await import("node:http"), https = await import("node:https");
for (const [n,m] of [["http",http],["https",https]]) for (const fn of ["request","get"])
  m.default[fn] = () => { calls.push(n+"."+fn); throw new Error("NETWORK DURING IMPORT"); };
let exitCode = null;
process.exit = (c) => { exitCode = c; throw new Error("__EXIT__"+c); };
try { await import(process.argv[2]); } catch (e) { if (!String(e.message).startsWith("__EXIT__")) console.log("THREW:"+e.message.slice(0,60)); }
console.log(JSON.stringify({ networkCalls: calls.length, exitCode }));
`);
for (const s of SCRIPTS) {
  const r = spawnSync(process.execPath, [probe, join(process.cwd(), s.path)], { encoding: "utf8" });
  let got = {};
  try { got = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch {}
  check(`${s.path}: bare import makes ZERO network calls`, got.networkCalls === 0, `saw ${got.networkCalls}`);
  check(`   …and exits ${s.exit} — non-zero`, got.exitCode === s.exit, `saw ${got.exitCode}`);
  const bare = spawnSync(process.execPath, [s.path], { encoding: "utf8" });
  check(`   …and a bare RUN exits ${s.exit} too`, bare.status === s.exit, `saw ${bare.status}`);
  check(`   🚨 …never 0 — a no-op exiting 0 reads as a completed run`, bare.status !== 0);
  check(`   …and says it wrote and moved nothing`, /INERT/.test(bare.stdout) && /moved nothing/.test(bare.stdout));
}
const codes = SCRIPTS.map((s) => s.exit);
check("⭐ the two refusal codes are DISTINCT from each other and from 1 (crash)",
  new Set(codes).size === codes.length && !codes.includes(1) && !codes.includes(0));

console.log("\n── 2. ⭐ THE OPERATOR SET IS DERIVED — no list to remember ─────────────");
check("OPERATOR_WALLET_VARS is non-empty", OPERATOR_WALLET_VARS.length > 0);
// ⭐⭐ DERIVED FROM THE ARRAY ITSELF, never from a copy of it: every declared var, whatever it is
// named, must reach the scan set. Add a wallet to the config and this passes without editing here.
for (const name of OPERATOR_WALLET_VARS) {
  const addr = "0x" + name.length.toString(16).padStart(2, "0").repeat(20);
  const env = { [name]: addr };
  check(`   ${name} → appears in the scan set`, scanOwnerSet([], env).includes(addr.toLowerCase()));
}
check("🚨 the scan set is a UNION — store owners survive alongside operator ones", (() => {
  const env = { [OPERATOR_WALLET_VARS[0]]: "0x" + "ab".repeat(20) };
  const set = scanOwnerSet(["0x" + "cd".repeat(20)], env);
  return set.includes("0x" + "ab".repeat(20)) && set.includes("0x" + "cd".repeat(20));
})());
check("   …and it de-duplicates an address present in both", (() => {
  const a = "0x" + "ef".repeat(20);
  return scanOwnerSet([a], { [OPERATOR_WALLET_VARS[0]]: a }).length === 1;
})());
check("⚠️ an UNSET var is skipped, not fatal — a partial env still scans", operatorWallets({}).length === 0);
check("   …and the report NAMES what is missing rather than implying full coverage",
  operatorWalletReport({}).missing.length === OPERATOR_WALLET_VARS.length);
check("junk in an operator var is ignored, never scanned as an address",
  operatorWallets({ [OPERATOR_WALLET_VARS[0]]: "not-an-address" }).length === 0);

console.log("\n── 3. ⛔ AN INVISIBLE SOURCE IS REFUSED, WITH THE REASON ───────────────");
const ENV = { AGENT_WALLET_ADDRESS: "0x" + "11".repeat(20) };
const stranger = "0x" + "99".repeat(20);
const refused = checkSpikeSource({ from: stranger, env: ENV });
check("a stranger address is REFUSED", refused.ok === false && refused.reason === SPIKE_SOURCE_REASON.REFUSED_INVISIBLE);
check("🚨 the refusal names the CONSEQUENCE, not just 'unknown address'",
  /invisible to discovery/i.test(refused.detail) && /no record of it would exist/i.test(refused.detail));
check("   …and says why: the sweeper enumerates owners FROM THE RECEIPT STORE",
  /enumerates owners from the receipt store/i.test(refused.detail));
check("   …and offers the two honest alternatives, not just the override",
  /operator wallet/i.test(refused.detail) && /OPERATOR_WALLET_VARS/.test(refused.detail));
check("⭐ 'permanently, not just until the next sweep' — the duration is stated",
  /permanently/i.test(refused.detail));
check("an operator wallet passes", checkSpikeSource({ from: "0x" + "11".repeat(20), env: ENV }).ok === true);
check("a store-known owner passes", checkSpikeSource({ from: stranger, storeOwners: [stranger], env: ENV }).ok === true);
check("⭐ the override works but STILL prints the reason — deliberate, not silent", (() => {
  const a = checkSpikeSource({ from: stranger, env: ENV, acknowledged: true });
  return a.ok === true && /invisible to discovery/i.test(a.detail) && /acknowledged/i.test(a.detail);
})());
check("a malformed address is refused before anything else", checkSpikeSource({ from: "nope", env: ENV }).ok === false);

console.log("\n── 4. ⭐ A TOOL-WRITTEN RECEIPT SAYS SO ────────────────────────────────");
const cand = { burnHash: "0x" + "aa".repeat(32), owner: "0x" + "11".repeat(20), amountMinor: "1000000",
  maxFeeMinor: "54000", destinationDomain: 6, mintRecipient: "0x" + "11".repeat(20),
  blockNumber: 1n, blockTimestamp: new Date().toISOString() };
const tool = discoveredReceipt(cand, { origin: RECEIPT_ORIGIN.TOOL_SIGNED });
const disc = discoveredReceipt(cand);
check("the tool receipt declares `tool-signed`", tool.origin === "tool-signed");
check("🚨 it does NOT claim `chain-discovered` — nothing discovered it", tool.origin !== "chain-discovered");
check("the sweeper's receipt still declares `chain-discovered`", disc.origin === "chain-discovered");
check("⭐ every other field is identical — the label is the only difference", (() => {
  const strip = (r) => { const { origin, discoveredAt, ...rest } = r; return JSON.stringify(rest); };
  return strip(tool) === strip(disc);
})());
// ⚠️ THE EXEMPTION MUST NOT LEAK ACROSS THE LABEL.
const old = new Date(Date.now() - 9 * 86400000).toISOString();
check("🚨 a tool-signed receipt gets NO retry-budget exemption — it does not need one",
  isAutoRetryExhausted({ origin: "tool-signed", burnedAt: old, discoveredAt: new Date().toISOString() }) === true);
check("   …while chain-discovered still does", 
  isAutoRetryExhausted({ origin: "chain-discovered", burnedAt: old, discoveredAt: new Date().toISOString() }) === false);
check("⭐ and a FRESH tool-signed burn is not exhausted anyway (burnedAt governs, correctly)",
  isAutoRetryExhausted({ origin: "tool-signed", burnedAt: new Date().toISOString() }) === false);
check("no tool receipt claims an intent", !("intentId" in tool) && !("txId" in tool));

console.log("\n── 5. ⛔ IT REFUSES TO BURN IF IT CANNOT RECORD — BEFORE THE MONEY ─────");
// MEASURED 2026-09-07 before any money moved: NETLIFY_SITE_ID / NETLIFY_BLOBS_TOKEN are in NEITHER
// .env NOR .env.example, so the first version would have burned real USDC and only THEN discovered
// it could not write the receipt. A post-burn failure is unrecoverable in the way that matters.
const noCreds = await assertStoreReachable(() => { throw new Error("should not be constructed"); },
  { env: {}, root: "/nonexistent" });
check("🚨 with no credentials the store is NOT reachable", noCreds.ok === false);
check("   …and it never even constructs a store handle", !/should not be constructed/.test(noCreds.detail || ""));
check("   …and the refusal says HOW to fix it", /netlify link|NETLIFY_SITE_ID/.test(noCreds.detail));
const creds = blobsCredentials({ env: {}, root: process.cwd() });
check("⭐ credentials resolve from the CLI's own config, not from a bare env read",
  creds.notes.some((n) => /state\.json|CLI config/.test(n)));
check("   …and env WINS when set, so CI can inject it",
  blobsCredentials({ env: { NETLIFY_SITE_ID: "x", NETLIFY_BLOBS_TOKEN: "y" } }).notes.every((n) => /from env/.test(n)));

// ⚠️ AN ORDER ASSERTION, AND IT IS A SOURCE CHECK — stated plainly rather than dressed up. Driving
// the real ordering would require a --send run, i.e. real money, which is precisely what this guard
// exists to make safe. So it asserts the one thing source CAN show: the store probe and its exit
// precede the first Circle execute call. [[assert-on-rendered-output-not-source-regex]] — this is
// the exception that rule warns about, and the limitation is that it cannot see reachability.
const src = readFileSync("scripts/bridge-direct.mjs", "utf8");
const iProbe = src.indexOf("assertStoreReachable");
const iExit = src.indexOf("process.exit(6)");
const iCircle = src.indexOf('await import("../netlify/functions/_circle.mjs")');
check("the store probe exists in bridge-direct", iProbe > 0);
check("🚨 …and it runs BEFORE the first Circle execute call", iProbe > 0 && iCircle > 0 && iProbe < iCircle);
check("🚨 …and its refusal exits 6, before any money call", iExit > iProbe && iExit < iCircle);
check("⭐ exit 6 is distinct from 3, 4, 1 and 0", ![0, 1, 3, 4].includes(6));
check("the write reuses the ALREADY-PROVEN handle, not a second bare-env resolution",
  /reach\.store/.test(src) && !/siteID: process\.env\.NETLIFY_SITE_ID/.test(src));

console.log("\n── 6. 🚨 A REFUSAL IS NOT A DRY RUN, AND THEY MUST NOT EXIT ALIKE ──────");
// MEASURED on a real run: `--send` was passed, `execute` read only `--execute`, so the run fell to
// the dry-run branch and printed "Re-run with --send" — an instruction whose only effect is the
// identical run. A refusal that tells you to do exactly what you just did is a closed loop.
const bsrc = readFileSync("scripts/bridge-direct.mjs", "utf8");
check("🚨 `execute` follows the SAME flag the guard accepts", /const execute = SEND;/.test(bsrc));
check("   …so `--send` can never pass the guard and leave execute false",
  !/const execute = process\.argv\.includes\("--execute"\)/.test(bsrc));
check("⭐ the dry-run message no longer tells a --send caller to re-run with --send",
  !/Dry run only\. Re-run with --send/.test(bsrc));
// Each pre-burn refusal carries its OWN exit code — none of them 0.
for (const [what, code] of [["fee ≥ amount", 7], ["insufficient balance", 8],
                            ["invisible source", 5], ["store unreachable", 6], ["inert", 4]]) {
  check(`   ${what} exits ${code}`, new RegExp(`process\\.exit\\(${code}\\)`).test(bsrc));
}
const exitCodes = [...bsrc.matchAll(/process\.exit\((\d+)\)/g)].map((m) => Number(m[1]));
check("🚨 NO pre-burn refusal exits 0 — a refusal must not read as a completed run", !exitCodes.includes(0));
check("⭐ every refusal code is DISTINCT — 'why did nothing happen' is answerable from status alone",
  new Set(exitCodes).size === exitCodes.length, JSON.stringify(exitCodes));
check("the fee refusal states the MECHANIC, not just the comparison",
  /fee comes OUT of the amount/.test(bsrc));
check("   …and names both remedies: a bigger amount OR a cheaper destination",
  /SPIKE_AMOUNT=<n>/.test(bsrc) && /cheaper\n?.*destination|cheaper/.test(bsrc));

console.log("\n── 7. 🚨 DOMAIN 0 IS ETHEREUM — AND 0 IS WHAT AN ABSENCE COERCES TO ────");
check("a real domain still resolves", destinationForDomain(0).key === "ethereum" && destinationForDomain(6).key === "base");
check("   …and a digit string too", destinationForDomain("0").key === "ethereum");
// ⛔ THE FAIL-OPEN: every one of these used to return Ethereum (Sepolia).
for (const absent of [null, "", false, undefined, NaN, "abc", 1.5, {}]) {
  check(`🚨 ${JSON.stringify(absent) ?? "undefined"} is UNKNOWN, never Ethereum`,
    destinationForDomain(absent).key === null);
}
check("⭐ and the unknown label SAYS it is unknown rather than naming a chain",
  /unknown CCTP domain/.test(destinationForDomain(null).label));
check("⭐ the script no longer hand-types a DESTINATION domain at all",
  !/const SEPOLIA = \{ cctpDomain: 0 \}/.test(bsrc) && !/SEPOLIA/.test(bsrc));

console.log("\n── 8. ⛔ THE DESTINATION IS RESOLVED, NEVER DEFAULTED ──────────────────");
// ⭐ A default destination would be the domain-0 fail-open wearing a CLI flag: an absent or
// misspelled name would send real money to whichever chain the default names, and the receipt would
// record that chain as fact. So there is no fallback — and the two mistakes refuse differently,
// because "you forgot" and "that is not a place" are different mistakes.
const runDest = (args) => spawnSync(process.execPath, ["scripts/bridge-direct.mjs", ...args], { encoding: "utf8" });
const missing = runDest(["--dry-run"]);
const unknown = runDest(["--dry-run", "--dest", "nowhere"]);
check("🚨 a MISSING destination refuses with exit 9", missing.status === 9, `saw ${missing.status}`);
check("🚨 an UNRECOGNISED destination refuses with exit 10", unknown.status === 10, `saw ${unknown.status}`);
check("⭐ the two are DISTINGUISHABLE by exit code", missing.status !== unknown.status);
check("⭐ …and by message — 'no destination given' vs 'not a destination this deployment knows'",
  /no destination given/.test(missing.stdout) && /is not a destination this deployment knows/.test(unknown.stdout));
check("🚨 neither falls back to a chain — no destination is named as chosen",
  !/Ethereum \(Sepolia\) selected|defaulting to/i.test(missing.stdout + unknown.stdout));
check("   …and the missing case SAYS there is deliberately no default",
  /does not have a default destination, deliberately/.test(missing.stdout));
check("   …and the unknown case says it was not interpreted loosely",
  /NOT interpreted loosely/.test(unknown.stdout));
check("both list the known destinations so the fix is obvious",
  /Known: /.test(missing.stdout) && /Known: /.test(unknown.stdout));
const dsrc = readFileSync("scripts/bridge-direct.mjs", "utf8");
check("⭐ it resolves through resolveDestinationStrict — the quote path's own producer",
  /resolveDestinationStrict/.test(dsrc));
// ⚠️ ARC'S OWN SOURCE DOMAIN (26) IS A LEGITIMATE LITERAL and must stay — this script always burns
// FROM Arc, so that is not a choice a caller makes. The defect was only ever a hand-typed
// DESTINATION. An assertion banning every literal would be wrong AND would go red on correct code,
// which is how a guard trains people to edit the guard.
const codeOnly = dsrc.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
const domainLits = [...codeOnly.matchAll(/cctpDomain:\s*(\d+)/g)].map((m) => Number(m[1]));
check("🚨 the ONLY hand-typed cctpDomain is Arc's own source domain",
  domainLits.length === 1 && domainLits[0] === 26, JSON.stringify(domainLits));
check("   …and every fee/receipt use reads DEST, not a const",
  !/SEPOLIA/.test(dsrc) && /DEST\.cctpDomain/.test(dsrc));
check("a VALID destination resolves and proceeds past the gate",
  runDest(["--dry-run", "--dest", "base"]).status !== 9 && runDest(["--dry-run", "--dest", "base"]).status !== 10);

console.log("\n── 9. 🚨 THE BANNER NAMES THE CHAIN THE MONEY IS GOING TO ──────────────");
// MEASURED on a real send: the header said "Arc -> Ethereum Sepolia" and "(Sepolia recip)" on a run
// whose destinationDomain was 6, whose fee was Base's, and whose mint link was basescan. The
// parameter reached the calldata and the fee lookup and STOPPED AT THE DISPLAY.
// ⚠️ Display-only, and the money went to the right chain — but a burner whose banner names the wrong
// chain is how someone confirms a burn they did not intend.
const banner = (dest) => spawnSync(process.execPath,
  ["scripts/bridge-direct.mjs", "--dry-run", "--dest", dest], { encoding: "utf8" }).stdout || "";
const bBase = banner("base"), bPoly = banner("polygon");
check("the banner names Base when --dest base", /Arc -> Base \(Sepolia\)/.test(bBase));
check("🚨 …and CHANGES to Polygon when --dest polygon", /Arc -> Polygon \(Amoy\)/.test(bPoly));
check("⭐ the two banners DIFFER — the mutation the defect would survive",
  bBase.split("\n")[0] !== bPoly.split("\n")[0] || bBase !== bPoly);
check("🚨 a Base run never says Sepolia-the-Ethereum-testnet in its banner",
  !/Arc -> Ethereum Sepolia/.test(bBase) && !/\(Sepolia recip\)/.test(bBase));
check("the recipient label derives too", /\(Base \(Sepolia\) recip\)/.test(bBase) && /\(Polygon \(Amoy\) recip\)/.test(bPoly));
// ⭐ THE CLASS, NOT THE TWO INSTANCES. Any chain name in code (not comments) must come from DEST.
const codeLines = readFileSync("scripts/bridge-direct.mjs", "utf8").split("\n")
  .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
const stray = codeLines.filter((l) =>
  /(sepolia|ethereum|etherscan|basescan|amoy|fuji)/i.test(l) && !/DEST\./.test(l) && !/GENERAL, not about this run/.test(l)
  && !/measured 2026-09-07/.test(l));
check("🚨 NO code line names a chain except through DEST", stray.length === 0, JSON.stringify(stray.slice(0, 2)));

console.log("\n── 10. ⭐ MONEY FIGURES CARRY NO FLOAT NOISE ───────────────────────────");
// The first tool-signed receipt stored netPredicted 0.045688000000000006 — 0.1 minus 0.054312 in
// float. Not wrong by any amount that matters, and still the wrong thing to persist.
const money = discoveredReceipt({ burnHash: "0x" + "bb".repeat(32), owner: "0x" + "11".repeat(20),
  amountMinor: "100000", maxFeeMinor: "54312", destinationDomain: 6, mintRecipient: "0x" + "11".repeat(20),
  blockNumber: 1n, blockTimestamp: new Date().toISOString() });
check("netPredicted is exact", money.netPredicted === 0.045688, String(money.netPredicted));
check("🚨 …and its decimal string has no float tail", String(money.netPredicted).length <= 8, String(money.netPredicted));
check("   …across several awkward pairs", [["100000","54312"],["1000000","54234"],["2000000","54131"]]
  .every(([a, f]) => {
    const r = discoveredReceipt({ ...money, amountMinor: a, maxFeeMinor: f });
    const dec = String(r.netPredicted).split(".")[1] ?? "";
    return dec.length <= 6;   // USDC is 6-decimal: more digits than that IS float noise
  }));

console.log(`\n${"═".repeat(72)}`);
console.log(`${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
