// verify-script-inert.mjs — the money-moving scripts are INERT until --send, and the wallets they
// burn from are visible to discovery.
//
// ⛔ FOUR PROPERTIES, EACH WITH THE MUTATION IT EXISTS TO CATCH:
//   1. a bare load makes ZERO network calls and exits NON-ZERO with a DISTINCT code
//   2. the operator wallet set is DERIVED from config — adding a var extends the scan, no edit here
//   3. an unrecognised SPIKE_FROM is refused, and the refusal NAMES THE CONSEQUENCE
//   4. a tool-written receipt says `tool-signed`, not `chain-discovered`, and gets no exemption

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATOR_WALLET_VARS, operatorWallets, operatorWalletReport, scanOwnerSet } from "../shared/operator-wallets.mjs";
import { checkSpikeSource, SPIKE_SOURCE_REASON } from "../shared/spike-source-guard.mjs";
import { discoveredReceipt, RECEIPT_ORIGIN } from "../netlify/functions/_bridge-discover.mjs";
import { isAutoRetryExhausted } from "../netlify/functions/_bridge-receipts.mjs";

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

console.log(`\n${"═".repeat(72)}`);
console.log(`${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
