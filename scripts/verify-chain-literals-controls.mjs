// verify-chain-literals-controls.mjs — THE GUARD'S CONTROLS FIRE. Proven by MUTATION, every run.
//
//   node scripts/verify-chain-literals-controls.mjs        (also: npm run test:literalscontrols, in test:all)
//
// verify-chain-literals.mjs carries four non-vacuity controls (C1–C4) plus an `expect`-count check and a
// refuse-mode rule. A control that has never been seen to fail is a comment. This suite copies the guard's
// SOURCE, applies one mutation at a time, runs the mutant against the real tree, and asserts the exit code
// AND the sentence the reader would see. The unmutated guard is run first as the baseline (green, exit 0).
//
// ⭐ Each mutation targets ONE control, so a control that stops firing reddens ONE line here, by name.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(".");
const GUARD = "scripts/verify-chain-literals.mjs";
const src = readFileSync(GUARD, "utf8");
const dir = mkdtempSync(join(tmpdir(), "chain-literals-"));

let failed = 0;
const check = (label, fn) => { try { fn(); console.log(`  ✅ ${label}`); } catch (e) { failed++; console.log(`  ❌ ${label}\n     ${e.message}`); } };

/** Write a mutant (imports re-pointed at the repo so the copy resolves them), run it from the repo root. */
function run(name, mutate) {
  let s = src.replace(/from "\.\.\/(netlify|shared)\//g, `from "${ROOT}/$1/`);
  if (mutate) {
    const before = s; s = mutate(s);
    assert.notEqual(s, before, `mutation "${name}" did not apply — the guard's text changed; update this suite`);
  }
  const p = join(dir, `${name}.mjs`);
  writeFileSync(p, s);
  const r = spawnSync(process.execPath, [p], { cwd: ROOT, encoding: "utf8" });
  return { exit: r.status, out: r.stdout + r.stderr };
}

console.log("── baseline: the unmutated guard is green ──────────────────────────────────");
const base = run("baseline", null);
check("exit 0", () => assert.equal(base.exit, 0, base.out.slice(-600)));
check("MODE is refuse", () => assert.match(base.out, /mode: REFUSE/));
check("no file outside the allowlist", () => assert.match(base.out, /no file holds a chain literal outside the allowlist/));
check("nothing deferred to phase B", () => assert.doesNotMatch(base.out, /deferred to phase B/));
check("controls failed: 0", () => assert.match(base.out, /controls failed: 0/));

console.log("\n── C1: the scanner can see — a source declared to hold a lever it does not hold ──");
{
  const m = run("c1", (s) => s.replace('"netlify/functions/_gateway.mjs":    { pkg: "app-server", holds: ["gatewayWallet"] }',
                                       '"netlify/functions/_gateway.mjs":    { pkg: "app-server", holds: ["gatewayWallet", "chainId"] }'));
  check("exit 1", () => assert.equal(m.exit, 1));
  check("names the source and the lever", () => assert.match(m.out, /❌ app-server\s+netlify\/functions\/_gateway\.mjs holds chainId/));
}
console.log("\n── C1: cross-package agreement — dd-core disagreeing with the server ──");
{
  // the mutant compares dd-core against a chain id the server does NOT run on
  const m = run("c1b", (s) => s.replace('ok("dd-core names the server\'s chain id in `id:`", new RegExp(`id:\\\\s*${CHAIN_ID}\\\\b`).test(ddcore));',
                                        'ok("dd-core names the server\'s chain id in `id:`", new RegExp(`id:\\\\s*${CHAIN_ID}9\\\\b`).test(ddcore));'));
  check("exit 1", () => assert.equal(m.exit, 1));
  check("the agreement line reddens", () => assert.match(m.out, /❌ dd-core names the server's chain id/));
}

console.log("\n── C2: an allowlist that matches everything ────────────────────────────────");
{
  const m = run("c2", (s) => s.replace('"agent-metadata/":    { cls: "record"', '"":    { cls: "record"'));
  check("exit 1", () => assert.equal(m.exit, 1));
  check("the synthetic probes classify — and the rule count control reddens", () => {
    assert.match(m.out, /❌ netlify\/functions\/__chain-literal-probe__\.mjs → unclassified/);
    assert.match(m.out, /❌ the directory rules cover only their four prefixes/);
  });
}

console.log("\n── C3: allowlist rot — an entry for a file that holds no literal ───────────");
{
  const m = run("c3", (s) => s.replace('"scripts/verify-vault.mjs":', '"scripts/verify-checkout-store.mjs":'));
  check("exit 1", () => assert.equal(m.exit, 1));
  check("names the stale entry", () => assert.match(m.out, /❌ scripts\/verify-checkout-store\.mjs — NO HIT — stale entry, remove it/));
}

console.log("\n── C4: a phase-b entry that is NOT on the DD surface ───────────────────────");
{
  // scripts/verify-vault.mjs holds a literal but is not DD surface → C4 must redden
  const m = run("c4", (s) => s.replace('const PHASE_B = {', 'const PHASE_B = { "scripts/verify-vault.mjs": "mutant",'));
  check("exit 1", () => assert.equal(m.exit, 1));
  check("names the off-surface entry", () => assert.match(m.out, /❌ scripts\/verify-vault\.mjs is on the DD surface/));
}

console.log("\n── refuse mode: PHASE_B non-empty again → exit 1, with the flip sentence ────");
{
  // a DD-surface file that still holds a literal (a fixture) — C3 and C4 pass, so ONLY the refuse rule fires
  const m = run("refuse-phaseb", (s) => s.replace('const PHASE_B = {', 'const PHASE_B = { "shared/dd-canary/fixtures.mjs": "mutant",'));
  check("exit 1", () => assert.equal(m.exit, 1));
  check("says the flip is illegal while PHASE_B is non-empty", () => assert.match(m.out, /MODE is refuse but PHASE_B is not empty/));
  check("C3 and C4 did NOT fire (the rule is isolated)", () => {
    assert.doesNotMatch(m.out, /NO HIT/); assert.doesNotMatch(m.out, /❌ .* is on the DD surface/);
  });
}

console.log("\n── refuse mode: a NEW literal outside the allowlist → exit 1 ────────────────");
{
  // remove one control entry so its (still present) literal becomes an unallowlisted hit
  const m = run("refuse-new", (s) => s.replace(/^\s*"scripts\/verify-x402-signer-binding\.mjs":.*\n/m, ""));
  check("exit 1", () => assert.equal(m.exit, 1));
  check("names the file OUTSIDE the allowlist", () => assert.match(m.out, /OUTSIDE the allowlist:[\s\S]*scripts\/verify-x402-signer-binding\.mjs/));
}

console.log("\n── expect counts: provider-list and record entries are exact ───────────────");
{
  const m = run("expect-provider", (s) => s.replace(/("shared\/onchain-analyze\/endpoints\.mjs":\s*\{ cls: "provider-list", expect: \{ rpcHost: )2/, "$13"));
  check("provider-list drift → exit 1, named as drift", () => {
    assert.equal(m.exit, 1); assert.match(m.out, /shared\/onchain-analyze\/endpoints\.mjs: allowlisted as provider-list with expect/);
  });
}
{
  const m = run("expect-record", (s) => s.replace(/("shared\/dd\/identity\.mjs":\s*\{ cls: "record", expect: \{ chainId: )1/, "$13"));
  check("record drift → exit 1, named as drift", () => {
    assert.equal(m.exit, 1); assert.match(m.out, /shared\/dd\/identity\.mjs: allowlisted as record with expect/);
  });
}
{
  // C5: an expect-bearing class WITHOUT an expect is refused by the guard itself
  const m = run("expect-missing", (s) => s.replace(/("shared\/onchain-analyze\/endpoints\.mjs":\s*\{ cls: "provider-list"), expect: \{ rpcHost: 2 \}/, "$1"));
  check("a provider-list entry with NO expect → exit 1 (C5)", () => {
    assert.equal(m.exit, 1); assert.match(m.out, /❌ .*endpoints\.mjs .*carries an exact expect/);
  });
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "✅ every control has been seen to fail" : `❌ ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
