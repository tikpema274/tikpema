// verify-ledger-commit-hook.mjs — the ledgers are committed ALONE, or not at all. The pre-commit hook refuses
// a commit that mixes a ledger file with anything else, and prints the exact three-line recovery.
//
//   node scripts/verify-ledger-commit-hook.mjs      (npm run test:ledgerhook)
//
// ═══ THE FAILURE (625f7fd, 2026-09-19) ═══════════════════════════════════════════════════════════
// stage:ledger left the two ledgers in the index after the deploy chain — as designed. A later
// `git add PROGRESS.md && git commit` then carried them along unnoticed: `git add` is additive, and a
// populated index is invisible at the prompt where the next commit is typed. The place that mistake
// becomes irreversible is the COMMIT, so the guard lives in the tracked pre-commit hook (.githooks,
// activated by `npm run hooks:install`, which `npm install` runs) — it fires however the index got
// populated and whether or not anyone read stage:ledger's message.
//
// ⚠️ LIMITS, stated so nobody assumes otherwise: `git commit --no-verify` skips the hook; there is no
// CI backstop (deploys are CLI-only). Real, not absolute. The hook says so in its own output.
//
// The properties are exercised against the REAL hook script, in throwaway repos whose core.hooksPath
// points at THIS repo's .githooks — so a hook edit that breaks the rule breaks this suite.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { LEDGERS } from "./gate-ledger.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const HOOKS = resolve(process.cwd(), ".githooks");
const [WINDOW, LOSS] = LEDGERS.map((l) => l.path);
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const line = (i) => JSON.stringify({ at: `2026-09-1${i}T00:00:00.000Z`, observedAt: `2026-09-1${i}T00:00:00.000Z`, commit: "c".repeat(40), ddTree: "d".repeat(64) }) + "\n";

function repo() {
  const d = mkdtempSync(join(tmpdir(), "ledger-hook-"));
  git(d, "init", "-q"); git(d, "config", "user.email", "t@example.com"); git(d, "config", "user.name", "t");
  git(d, "config", "core.hooksPath", HOOKS);
  mkdirSync(join(d, "shared"), { recursive: true });
  writeFileSync(join(d, WINDOW), line(0)); writeFileSync(join(d, LOSS), line(0));
  writeFileSync(join(d, "shared/build-stamp.generated.mjs"), "export const RAW_BUILD_STAMP = null;\n");
  writeFileSync(join(d, "PROGRESS.md"), "# progress\n"); writeFileSync(join(d, "other.txt"), "x\n");
  git(d, "add", "-A"); git(d, "commit", "-q", "--no-verify", "-m", "base");
  return d;
}
/** Stage the named files (after touching them) and attempt a commit THROUGH the hook. */
function attempt(d, files, msg = "try") {
  for (const f of files) writeFileSync(join(d, f), readFileSync(join(d, f), "utf8") + (f.endsWith(".jsonl") ? line(1) : "more\n"));
  if (files.length) git(d, "add", "--", ...files);
  const before = git(d, "rev-parse", "HEAD");
  const r = spawnSync("git", ["commit", "-q", "-m", msg], { cwd: d, encoding: "utf8" });
  const after = git(d, "rev-parse", "HEAD");
  return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), committed: before !== after };
}

console.log("\nverify-ledger-commit-hook — ledgers alone, or blocked with the exact recovery\n");
check("the real hook exists and is executable", (() => { try { execFileSync("test", ["-x", join(HOOKS, "pre-commit")]); return true; } catch { return false; } })());

section("1 — allowed: ledgers ALONE; other files alone; an empty index");
{
  const d = repo();
  let r = attempt(d, [WINDOW, LOSS], "chore(ledger): x");
  check("⭐ both ledgers alone → committed", r.status === 0 && r.committed, r.out.trim().split("\n").slice(-2).join(" | "));
  r = attempt(d, [WINDOW], "chore(ledger): one");
  check("⭐ one ledger alone → committed", r.status === 0 && r.committed, r.out.trim().split("\n").slice(-1).join(""));
  r = attempt(d, ["other.txt"], "docs: other");
  check("⭐ a non-ledger file alone → committed", r.status === 0 && r.committed);
  r = attempt(d, ["PROGRESS.md", "other.txt"], "docs: two");
  check("⭐ two non-ledger files → committed", r.status === 0 && r.committed);
  const e = spawnSync("git", ["commit", "-q", "-m", "empty"], { cwd: d, encoding: "utf8" });
  check("an EMPTY index → the hook does not block (git itself refuses 'nothing to commit')", !/ledger/i.test((e.stdout || "") + (e.stderr || "")));
  rmSync(d, { recursive: true, force: true });
}

section("2 — 🚨 blocked: a ledger + anything else");
{
  const d = repo();
  let r = attempt(d, [WINDOW, LOSS, "other.txt"], "mixed");
  check("🚨 ledgers + other.txt → BLOCKED, nothing committed", r.status !== 0 && !r.committed, r.out.trim().split("\n")[0]);
  check("🚨 …names the rule: ledgers are committed ALONE", /ledger/i.test(r.out) && /alone/i.test(r.out));
  check("🚨 …names the offending non-ledger file", r.out.includes("other.txt"));
  // ── the exact recovery: three copy-pasteable lines ──
  check("⭐ recovery line 1: unstage the ledgers", new RegExp(`git restore --staged(?: --)? ${WINDOW} ${LOSS}`).test(r.out) || new RegExp(`git restore --staged .*${WINDOW}.*${LOSS}`).test(r.out), r.out.split("\n").filter((l) => /restore --staged/.test(l)).join(" | "));
  check("⭐ recovery line 2: commit the other change (a literal git commit line)", /git commit -m "<your message>"|git commit -m ["'].*["']/.test(r.out));
  check("⭐ recovery line 3: add and commit the ledgers as chore(ledger)", new RegExp(`git add(?: --)? ${WINDOW} ${LOSS} && git commit -m "chore\\(ledger\\)`).test(r.out), r.out.split("\n").filter((l) => /chore\(ledger\)/.test(l)).join(" | "));
  check("⭐ the limits are STATED in the output: --no-verify skips it; no CI backstop", /--no-verify/.test(r.out) && /no CI backstop|not absolute|no server-side/i.test(r.out));
  check("…the index is left as it was (the author's staged set is not touched by the hook)", git(d, "diff", "--cached", "--name-only").split("\n").filter(Boolean).length === 3);
  git(d, "reset", "-q");
  r = attempt(d, [WINDOW, "PROGRESS.md"], "docs(deploy): record + ledger");
  check("🚨 a ledger + PROGRESS.md → BLOCKED too (strict, deliberately — 625f7fd was exactly this)", r.status !== 0 && !r.committed && r.out.includes("PROGRESS.md"));
  git(d, "reset", "-q");
  r = attempt(d, [LOSS, "shared/build-stamp.generated.mjs"], "mixed with stamp");
  check("a ledger + the (null) stamp → BLOCKED (the stamp is 'anything else')", r.status !== 0 && !r.committed);
  rmSync(d, { recursive: true, force: true });
}

section("3 — the existing stamp block still fires (ordering: before gitleaks, independent of the ledger rule)");
{
  const d = repo();
  writeFileSync(join(d, "shared/build-stamp.generated.mjs"), 'export const RAW_BUILD_STAMP = { "commit": "abcdef1234567" };\n');
  git(d, "add", "shared/build-stamp.generated.mjs");
  const r = spawnSync("git", ["commit", "-q", "-m", "stamp"], { cwd: d, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  check("🚨 a STAMPED build stamp alone → BLOCKED by the stamp rule", r.status !== 0 && /STAMPED build stamp is staged/.test(out));
  check("…and the ledger rule did not fire (no ledger was staged)", !/committed ALONE/i.test(out));
  rmSync(d, { recursive: true, force: true });
}

section("4 — stage-ledger's tail now prints the exact chore(ledger) command and warns about the populated index");
{
  const d = repo();
  writeFileSync(join(d, WINDOW), readFileSync(join(d, WINDOW), "utf8") + line(2));
  const r = spawnSync(process.execPath, [resolve(process.cwd(), "scripts/stage-ledger.mjs")], { cwd: d, encoding: "utf8" });
  check("prints the exact commit line", new RegExp(`git commit -m "chore\\(ledger\\)`).test(r.stdout), r.stdout.trim().split("\n").slice(-3).join(" | "));
  check("⭐ warns that the index is now populated and must be committed BEFORE staging anything else", /index/i.test(r.stdout) && /before (you )?(stage|add)/i.test(r.stdout));
  rmSync(d, { recursive: true, force: true });
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0\n`);
