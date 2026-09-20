// verify-env-assert.mjs — the same-environment assert must DISCRIMINATE in three directions, not one.
// A guard validated only against the correct config proves nothing; this exercises the two failing
// directions as PASSING tests (the guard MUST throw), so a future "fall through to testnet" regression
// reddens here.
//
//   node scripts/verify-env-assert.mjs
//
// Directions:
//   1. correct config (all four testnet)                 -> returns "testnet", no throw
//   2. deliberate mismatch (Gateway moved, chain testnet, AND the reverse)
//                                                         -> throws, message NAMES both labels + values
//   3. unknown value (RPC host / wallet in neither column) -> throws UNKNOWN, never "probably testnet"

import assert from "node:assert/strict";
import { assertSameEnvironment, assertPackagesAgree, classify, ENV_TABLE, EnvironmentAssertionError } from "../netlify/functions/_env-assert.mjs";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const T = {
  chainId: 5042002,
  rpc: "https://rpc.testnet.arc.io",
  gatewayApiBase: "https://gateway-api-testnet.circle.com",
  gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9", // mixed case on purpose (normalisation)
};
const MAINNET_WALLET = "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE";
const MAINNET_HOST = "https://gateway-api.circle.com";

let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); } };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

console.log("── DIRECTION 1: correct config loads ──────────────────────────────────────");
check("all-four-testnet resolves to 'testnet', no throw", () => {
  assert.equal(assertSameEnvironment(T), "testnet");
});

console.log("── DIRECTION 2: partial migration throws AND names both labels + values ────");
check("Gateway WALLET moved to mainnet, chain still testnet -> throws, names both", () => {
  const e = throws(() => assertSameEnvironment({ ...T, gatewayWallet: MAINNET_WALLET }));
  assert.ok(e instanceof EnvironmentAssertionError, "must throw EnvironmentAssertionError");
  assert.match(e.message, /testnet:/, "names the testnet side");
  assert.match(e.message, /mainnet:/, "names the mainnet side");
  assert.match(e.message, /gatewayWallet=0x77777777Dcc4/i, "names the value that produced mainnet");
  assert.match(e.message, /chainId=5042002/, "names a value that produced testnet");
});
check("Gateway HOST moved to mainnet, chain still testnet (the reverse) -> throws, names both", () => {
  const e = throws(() => assertSameEnvironment({ ...T, gatewayApiBase: MAINNET_HOST }));
  assert.ok(e instanceof EnvironmentAssertionError);
  assert.match(e.message, /gatewayHost=.*gateway-api\.circle\.com/, "names the mainnet host");
  assert.match(e.message, /testnet:/);
  assert.match(e.message, /mainnet:/);
});
check("a wallet typo'd to the OTHER environment's address is a split, not a pass", () => {
  // host testnet + wallet mainnet — the exact near-identical-address typo the wallet now guards
  const e = throws(() => assertSameEnvironment({ ...T, gatewayWallet: MAINNET_WALLET }));
  assert.ok(e instanceof EnvironmentAssertionError);
});

console.log("── DIRECTION 3: unknown value REFUSES (no default, no 'probably testnet') ──");
check("an RPC host in NEITHER column -> UNKNOWN refusal, not classified testnet", () => {
  assert.equal(classify("rpcHost", "rpc.evil.example"), null, "classify() returns null, never a default");
  const e = throws(() => assertSameEnvironment({ ...T, rpc: "https://rpc.evil.example" }));
  assert.ok(e instanceof EnvironmentAssertionError, "must throw");
  assert.match(e.message, /NEITHER the testnet nor the mainnet column/i, "refused as UNKNOWN");
  assert.match(e.message, /rpcHost=/, "names the offending field");
  assert.doesNotMatch(e.message, /spans TWO environments/, "unknown is refused as unknown, not mislabelled as a split");
});
check("a Gateway wallet in NEITHER column -> UNKNOWN refusal", () => {
  const bogus = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  assert.equal(classify("gatewayWallet", bogus), null);
  const e = throws(() => assertSameEnvironment({ ...T, gatewayWallet: bogus }));
  assert.ok(e instanceof EnvironmentAssertionError);
  assert.match(e.message, /NEITHER the testnet nor the mainnet column/i);
});
check("chainId and rpcHost have NO mainnet entry (fail-closed by absence)", () => {
  assert.equal(ENV_TABLE.chainId.mainnet, undefined, "no invented mainnet chain id");
  assert.equal(ENV_TABLE.rpcHost.mainnet, undefined, "no invented mainnet rpc host");
  // consequence: a mainnet-shaped chain id is UNKNOWN, not 'mainnet'
  assert.equal(classify("chainId", 999999), null);
});

console.log("── the two Gateway wallets differ (the discriminator is real) ──────────────");
check("testnet and mainnet Gateway wallets are distinct values", () => {
  assert.notEqual(ENV_TABLE.gatewayWallet.testnet, ENV_TABLE.gatewayWallet.mainnet);
});

console.log("\n── ⭐ cross-PACKAGE agreement: app-server vs dd-core (phase B, mainnet §1) ─────");
// env-assert binds one package's four levers to ONE environment. It did not bind the PACKAGES to each
// other: shared/dd/chains.mjs (dd-core) carries its own chain table by design, so a flip that moved the
// server and forgot dd-core would boot, and the paid DD path would analyse the wrong chain. This pure
// function takes both packages' values and REFUSES on any disagreement; _arc.mjs calls it at import.
const S = { chainId: 5042002, rpc: "https://rpc.testnet.arc.io" };
check("agreeing packages return quietly", () => {
  assert.equal(assertPackagesAgree({ server: S, ddCore: { id: 5042002, rpc: "https://rpc.testnet.arc.io" } }), undefined);
});
check("the RPC compares by HOST — a trailing slash or a path is not a disagreement", () => {
  assert.equal(assertPackagesAgree({ server: S, ddCore: { id: 5042002, rpc: "https://rpc.testnet.arc.io/" } }), undefined);
});
check("a chain-id disagreement REFUSES, naming chainId and BOTH values", () => {
  const e = throws(() => assertPackagesAgree({ server: S, ddCore: { id: 5042999, rpc: S.rpc } }));
  assert.ok(e instanceof EnvironmentAssertionError, "EnvironmentAssertionError (the boot refuses)");
  assert.match(e.message, /chainId/); assert.match(e.message, /5042002/); assert.match(e.message, /5042999/);
  assert.match(e.message, /app-server/); assert.match(e.message, /dd-core/);
  assert.doesNotMatch(e.message, /rpcHost/, "does not blame the host");
});
check("an RPC-host disagreement REFUSES, naming rpcHost and BOTH hosts", () => {
  const e = throws(() => assertPackagesAgree({ server: S, ddCore: { id: 5042002, rpc: "https://rpc.mainnet.arc.example" } }));
  assert.ok(e instanceof EnvironmentAssertionError);
  assert.match(e.message, /rpcHost/); assert.match(e.message, /rpc\.testnet\.arc\.io/); assert.match(e.message, /rpc\.mainnet\.arc\.example/);
  assert.doesNotMatch(e.message, /chainId=/, "does not blame the chain id");
});
check("a MISSING dd-core value refuses — absence is not agreement", () => {
  assert.ok(throws(() => assertPackagesAgree({ server: S, ddCore: undefined })) instanceof EnvironmentAssertionError);
  assert.ok(throws(() => assertPackagesAgree({ server: S, ddCore: { rpc: S.rpc } })) instanceof EnvironmentAssertionError);
});
check("_env-assert.mjs stays PURE — no imports, so it can be called from anywhere including the DD surface", () => {
  const src = readFileSync("netlify/functions/_env-assert.mjs", "utf8");
  assert.doesNotMatch(src, /^\s*import\s/m, "an import would make the pure module impure");
});
check("⭐ THE BOOT REFUSES: a copy of _arc.mjs whose dd-core disagrees fails at IMPORT with the cross-package sentence", () => {
  // Not a unit call — the real module, top-level, spawned: the throw happens where a cold start would hit it.
  const { spawnSync } = require("node:child_process"); const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os"); const { join, resolve } = require("node:path");
  const ROOT = resolve(".");
  let arc = readFileSync("netlify/functions/_arc.mjs", "utf8")
    .replace(/from "\.\/([^"]+)"/g, `from "${ROOT}/netlify/functions/$1"`)
    .replace(/from "\.\.\/\.\.\/shared\//g, `from "${ROOT}/shared/`);
  const mutated = arc.replace('ddCore: CHAINS["arc-testnet"]', 'ddCore: { id: 1, rpc: CHAINS["arc-testnet"].rpc }');
  assert.notEqual(mutated, arc, "the call site was found and mutated");
  const dir = mkdtempSync(join(tmpdir(), "arc-boot-")); const f = join(dir, "_arc.mutant.mjs"); writeFileSync(f, mutated);
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import("${f}").then(() => { console.log("BOOTED"); process.exit(0); }, (e) => { console.error(e.message); process.exit(3); })`], { cwd: ROOT, encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 3, `the import must FAIL (got ${r.status}: ${(r.stdout + r.stderr).slice(0, 200)})`);
  assert.match(r.stderr, /cross-package assert REFUSED/); assert.match(r.stderr, /dd-core=1\b/);
  // and the UNMUTATED copy boots — the control that proves the harness itself is not what refused
  const dir2 = mkdtempSync(join(tmpdir(), "arc-boot-")); const f2 = join(dir2, "_arc.ok.mjs"); writeFileSync(f2, arc);
  const r2 = spawnSync(process.execPath, ["--input-type=module", "-e", `import("${f2}").then(() => { console.log("BOOTED"); process.exit(0); }, (e) => { console.error(e.message); process.exit(3); })`], { cwd: ROOT, encoding: "utf8" });
  rmSync(dir2, { recursive: true, force: true });
  assert.equal(r2.status, 0, `the unmutated copy must boot: ${(r2.stdout + r2.stderr).slice(0, 200)}`);
});
check("_arc.mjs CALLS assertPackagesAgree at import, against shared/dd/chains.mjs", () => {
  const arc = readFileSync("netlify/functions/_arc.mjs", "utf8");
  assert.match(arc, /import \{[^}]*CHAINS[^}]*\} from "\.\.\/\.\.\/shared\/dd\/chains\.mjs"/, "imports dd-core's table");
  assert.match(arc, /assertPackagesAgree\(\{/, "calls it");
});

console.log(`\n${failed === 0 ? "✅ all directions discriminate" : `❌ ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
