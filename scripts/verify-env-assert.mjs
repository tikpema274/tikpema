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
import { assertSameEnvironment, classify, ENV_TABLE, EnvironmentAssertionError } from "../netlify/functions/_env-assert.mjs";

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

console.log(`\n${failed === 0 ? "✅ all directions discriminate" : `❌ ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
