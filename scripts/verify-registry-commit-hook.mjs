// verify-registry-commit-hook.mjs — the pre-commit hook runs gate:registry on the STAGED content when a commit
// touches src/components/ or scripts/guard-registry.mjs, and refuses the commit when it fails.
//
//   node scripts/verify-registry-commit-hook.mjs      (npm run test:registryhook)
//
// ═══ WHY (2026-10-01) ═════════════════════════════════════════════════════════════════════════════════════
// 523ed1f added "Nothing was signed or changed" to ConnectPasskey (declared noClaims). Its commit listed four suites
// green but never ran gate:registry; the deploy chain caught it 30 minutes in, and the claim was FALSE in the exact case
// T was about to test live. gate:registry takes ~1 s and reads files only, so it belongs at commit time.
// ⭐ STAGED, NOT ON DISK: the hook exports the INDEX (git checkout-index) and runs the gate there, so a partly staged
// file is judged by what will be committed — a clean stage with a dirty working tree passes; a dirty stage with a
// clean working tree is refused.
// ⚠️ LIMITS (the hook says the first two in its own output): `--no-verify` skips it; there is no CI behind it; it
// recognises claim WORDS (§13's figures rule lives in test:all); it says a claim EXISTS, never whether it is TRUE.
//
// Exercised against the REAL hook, in a throwaway clone of this repo whose core.hooksPath points at THIS repo's
// .githooks — a hook edit that breaks the rule breaks this suite. The fixture is 523ed1f's own sentence.
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 66 - t.length))}`);
const REPO = process.cwd();
const HOOKS = resolve(REPO, ".githooks");
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const COMP = "src/components/ConnectPasskey.tsx";
const CLAIM = "Nothing was signed or changed — sign in again when you're ready.";
const ANCHOR = "<b>Sign-in was cancelled.</b>";

const dirs = [];
function clone() {
  const d = mkdtempSync(join(tmpdir(), "registry-hook-")); dirs.push(d);
  git(REPO, "clone", "-q", "--shared", REPO, d);
  git(d, "config", "user.email", "hook-test@example.invalid"); git(d, "config", "user.name", "hook test");
  git(d, "config", "core.hooksPath", HOOKS);
  return d;
}
const commit = (d, msg) => { const head = git(d, "rev-parse", "HEAD"); const r = spawnSync("git", ["commit", "-q", "-m", msg], { cwd: d, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, moved: git(d, "rev-parse", "HEAD") !== head }; };
const withClaim = (src) => src.replace(ANCHOR, `${ANCHOR} ${CLAIM}`);

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  pre-commit runs gate:registry on the STAGED content                 ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("0 — the fixture is the real case");
const base = readFileSync(join(REPO, COMP), "utf8");
check("ConnectPasskey still carries the anchor the fixture edits", base.includes(ANCHOR));
check("…and is declared claim-free today (the declaration the hook must enforce)", /ConnectPasskey:\s*\{\s*noClaims:\s*true\s*\}/.test(readFileSync(join(REPO, "scripts/guard-registry.mjs"), "utf8")));

section("1 — 🚨 523ed1f's claim, staged on a noClaims component → the commit is REFUSED");
{
  const d = clone();
  writeFileSync(join(d, COMP), withClaim(base)); git(d, "add", COMP);
  const r = commit(d, "add a claim");
  check("⭐⭐ refused: non-zero exit, HEAD did not move", r.status !== 0 && !r.moved, `status=${r.status}`);
  check("⭐ …and the output names gate:registry and the component", /gate:registry/.test(r.out) && /ConnectPasskey/.test(r.out), r.out.slice(0, 200));
  check("⭐⭐ …and says plainly that --no-verify skips it and NO CI checks later (a bypass is a deliberate act)",
    /--no-verify/.test(r.out) && /no CI/i.test(r.out), r.out.slice(-300));
}

section("2 — ⭐⭐ STAGED, not on disk: the INDEX is what is judged");
{
  const d = clone();
  // a clean change staged; the claim only in the working tree → the commit carries no claim → allowed
  writeFileSync(join(d, COMP), base.replace(ANCHOR, `${ANCHOR} `)); git(d, "add", COMP);
  writeFileSync(join(d, COMP), withClaim(base));
  const r = commit(d, "clean stage, dirty tree");
  check("⭐⭐ clean STAGE + claim only on disk → ALLOWED (what is committed has no claim)", r.status === 0 && r.moved, r.out.slice(0, 200));
}
{
  const d = clone();
  // the claim staged; the working tree cleaned afterwards → the commit WOULD carry the claim → refused
  writeFileSync(join(d, COMP), withClaim(base)); git(d, "add", COMP);
  writeFileSync(join(d, COMP), base);
  const r = commit(d, "dirty stage, clean tree");
  check("⭐⭐ claim STAGED + working tree clean → REFUSED (a disk-only check would have let it in)", r.status !== 0 && !r.moved, r.out.slice(0, 200));
}

section("3 — scope: it runs only when components or the registry are staged");
{
  const d = clone();
  writeFileSync(join(d, "README.md"), readFileSync(join(d, "README.md"), "utf8") + "\n");
  git(d, "add", "README.md");
  const r = commit(d, "docs only");
  check("a commit touching neither → allowed, and gate:registry is NOT run", r.status === 0 && r.moved && !/gate:registry/.test(r.out), r.out.slice(0, 160));
}
{
  const d = clone();
  const reg = readFileSync(join(d, "scripts/guard-registry.mjs"), "utf8");
  writeFileSync(join(d, "scripts/guard-registry.mjs"), reg + "\n// registry-hook test edit\n"); // a real change to the registry file
  writeFileSync(join(d, COMP), withClaim(base)); // claim on disk only
  git(d, "add", "scripts/guard-registry.mjs");
  const r = commit(d, "registry touched");
  check("⭐ staging scripts/guard-registry.mjs runs it too (and passes when the STAGED components are clean)", r.status === 0 && r.moved && /gate:registry/.test(r.out), r.out.slice(0, 200));
}

section("5 — ⭐⭐ test:reachability on the STAGED content when scripts/ change (43a199b's class)");
{
  // 43a199b put process.exit above a suite's checks, so they could no longer redden a run. The fixture: an assertion
  // appended AFTER a real suite's final process.exit — exactly that shape.
  const SUITE = "scripts/verify-forgery-verdict.mjs";
  const d = clone();
  writeFileSync(join(d, SUITE), readFileSync(join(d, SUITE), "utf8") + '\nok("stranded after the exit", true);\n');
  git(d, "add", SUITE);
  const r = commit(d, "strand an assertion");
  check("⭐⭐ an assertion stranded after the last process.exit, staged → REFUSED", r.status !== 0 && !r.moved, `status=${r.status}`);
  check("⭐ …and the output names test:reachability and the suite", /test:reachability/.test(r.out) && /verify-forgery-verdict/.test(r.out), r.out.slice(0, 220));
  check("  …and repeats the bypass statement", /--no-verify/.test(r.out) && /no CI/i.test(r.out));
}
{
  const d = clone();
  const SUITE = "scripts/verify-forgery-verdict.mjs";
  writeFileSync(join(d, SUITE), "// harmless edit (a comment)\n" + readFileSync(join(d, SUITE), "utf8"));
  git(d, "add", SUITE);
  const r = commit(d, "harmless scripts edit");
  check("⭐ a harmless scripts/ change → allowed, and test:reachability RAN (said so)", r.status === 0 && r.moved && /test:reachability/.test(r.out), r.out.slice(0, 200));
}
{
  const d = clone();
  writeFileSync(join(d, COMP), withClaim(base)); git(d, "add", COMP);
  const r = commit(d, "component only");
  check("  a component-only commit does not run test:reachability (scope)", !/test:reachability/.test(r.out), r.out.slice(0, 160));
}

section("4 — the hook's own source");
{
  const h = readFileSync(join(HOOKS, "pre-commit"), "utf8");
  check("⭐ it exports the INDEX (git checkout-index) and runs the gates THERE", /checkout-index/.test(h) && /verify-guard-registry\.mjs/.test(h) && /verify-assertion-reachability\.mjs/.test(h));
  const codeLines = h.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"); // comments may explain it; code runs it once
  check("  …ONE export serves both gates", (codeLines.match(/checkout-index/g) ?? []).length === 1, String((codeLines.match(/checkout-index/g) ?? []).length));
  check("⭐ it fails CLOSED when the gate cannot run (no script in the index / node missing)", /fail(s)? closed|FAIL CLOSED/i.test(h) && /command -v node/.test(h));
  check("  it cleans up its temp copy", /trap .*rm -rf/.test(h));
}

for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log(`\n${fail === 0 ? "✅" : "❌"} verify-registry-commit-hook — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
