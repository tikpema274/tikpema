// verify-ledger-gate.mjs — the two ledgers cannot drift again: gate:ledger (head of deploy:prod) and
// stage-ledger (tail of deploy:prod).
//
//   node scripts/verify-ledger-gate.mjs        (npm run test:ledgergate)
//
// ═══ THE DRIFT THIS ENDS (2026-09-19, f4a8016) ═══════════════════════════════════════════════════
// dd-refusal-window-log.jsonl and deploy-loss-log.jsonl are GATE INPUTS: capture-refusal-window judges
// `rotated` against the log's last ddTree; verify-deploy-loss-delta takes the loss log's last line as its
// baseline. Both are appended by the deploy chain and were committed by HABIT — which lapsed for 14
// deploys, so a fresh clone judged rotation against a four-day-old tree and the loss delta against a
// stale census. Nothing enforced the commit; now two things do:
//   gate:ledger  — HEAD of the chain, read-only: the COMMITTED ledger must be at the working tree's last
//                  line. Three outcomes, never conflated: up-to-date / N deploys BEHIND (N and the file
//                  named) / UNREADABLE (missing, empty, malformed last line — the condition the gates ran
//                  on silently; it must never pass). [[absence-must-never-read-as-safe]]
//   stage-ledger — TAIL of the chain: `git add` exactly the two ledger paths (one list, one place),
//                  index only — never commits, never pushes, never the build stamp, never anything else.
//
// The git-facing properties run against REAL throwaway repos in the OS temp dir (removed after), never this one.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { assessLedger, LEDGERS } from "./gate-ledger.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const line = (i, field = "at") => JSON.stringify({ [field]: `2026-09-1${i}T00:00:00.000Z`, commit: "c".repeat(40), ddTree: "d".repeat(64) });
const lines = (n, field = "at") => Array.from({ length: n }, (_, i) => line(i, field)).join("\n") + "\n";

console.log("\nverify-ledger-gate — the ledgers cannot drift again\n");

section("1 — assessLedger: three outcomes, never conflated");
{
  const up = assessLedger({ name: "x.jsonl", committed: lines(3), working: lines(3), timeField: "at" });
  check("⭐ committed == working → up-to-date, behind 0", up.outcome === "up-to-date" && up.behind === 0, JSON.stringify(up));
  const one = assessLedger({ name: "x.jsonl", committed: lines(3), working: lines(4), timeField: "at" });
  check("⭐ one uncommitted line → BEHIND 1, names the file and the committed last timestamp", one.outcome === "behind" && one.behind === 1 && /x\.jsonl/.test(one.reason) && /1 deploy/.test(one.reason) && /2026-09-12/.test(one.reason), one.reason);
  const many = assessLedger({ name: "x.jsonl", committed: lines(2), working: lines(16), timeField: "at" });
  check("⭐ fourteen uncommitted lines → BEHIND 14 (the measured drift)", many.outcome === "behind" && many.behind === 14 && /14 deploys/.test(many.reason), many.reason);
  const missingC = assessLedger({ name: "x.jsonl", committed: null, working: lines(3), timeField: "at" });
  check("🚨 not in the committed tree → UNREADABLE, says so, NOT up-to-date and NOT behind", missingC.outcome === "unreadable" && /not (in|committed)/i.test(missingC.reason), missingC.reason);
  const missingW = assessLedger({ name: "x.jsonl", committed: lines(3), working: null, timeField: "at" });
  check("🚨 missing from the working tree → UNREADABLE", missingW.outcome === "unreadable" && /working tree|missing/i.test(missingW.reason), missingW.reason);
  const empty = assessLedger({ name: "x.jsonl", committed: "", working: "", timeField: "at" });
  check("🚨 EMPTY committed file → UNREADABLE (no baseline is not 'up to date')", empty.outcome === "unreadable" && /empty/i.test(empty.reason), empty.reason);
  const emptyW = assessLedger({ name: "x.jsonl", committed: "\n\n", working: lines(2), timeField: "at" });
  check("🚨 committed holds only blank lines → UNREADABLE", emptyW.outcome === "unreadable", emptyW.reason);
  const malformed = assessLedger({ name: "x.jsonl", committed: lines(2) + "{not json\n", working: lines(2) + "{not json\n", timeField: "at" });
  check("🚨 malformed last line → UNREADABLE naming the line, never up-to-date", malformed.outcome === "unreadable" && /malformed|parse/i.test(malformed.reason) && /line 3/.test(malformed.reason), malformed.reason);
  const noTime = assessLedger({ name: "x.jsonl", committed: '{"foo":1}\n', working: '{"foo":1}\n', timeField: "at" });
  check("🚨 last line parses but carries no timestamp field → UNREADABLE (names the field)", noTime.outcome === "unreadable" && /at/.test(noTime.reason), noTime.reason);
  const rewritten = assessLedger({ name: "x.jsonl", committed: lines(3), working: line(9) + "\n" + lines(3), timeField: "at" });
  check("🚨 working tree is NOT an append of the committed content → refused as REWRITTEN (append-only ledger)", rewritten.outcome === "rewritten", rewritten.reason);
  const loss = assessLedger({ name: "deploy-loss-log.jsonl", committed: lines(2, "observedAt"), working: lines(3, "observedAt"), timeField: "observedAt" });
  check("the loss ledger's field is observedAt", loss.outcome === "behind" && loss.behind === 1);
  check("⭐ LEDGERS names exactly the two files with their time fields (one list, one place)", LEDGERS.length === 2 && LEDGERS.some((l) => l.path === "dd-refusal-window-log.jsonl" && l.timeField === "at") && LEDGERS.some((l) => l.path === "deploy-loss-log.jsonl" && l.timeField === "observedAt"));
}

// ── a throwaway repo with the real file layout ──────────────────────────────────────────────────
const HERE = process.cwd();
const GATE = join(HERE, "scripts/gate-ledger.mjs"), STAGE = join(HERE, "scripts/stage-ledger.mjs");
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const run = (cwd, file, args = []) => spawnSync(process.execPath, [file, ...args], { cwd, encoding: "utf8" });
function repo() {
  const d = mkdtempSync(join(tmpdir(), "ledger-gate-"));
  git(d, "init", "-q"); git(d, "config", "user.email", "t@example.com"); git(d, "config", "user.name", "t");
  mkdirSync(join(d, "shared"), { recursive: true });
  writeFileSync(join(d, "dd-refusal-window-log.jsonl"), lines(2));
  writeFileSync(join(d, "deploy-loss-log.jsonl"), lines(2, "observedAt"));
  writeFileSync(join(d, "shared/build-stamp.generated.mjs"), "export const RAW_BUILD_STAMP = null;\n");
  writeFileSync(join(d, "other.txt"), "untouched\n");
  git(d, "add", "-A"); git(d, "commit", "-q", "-m", "base");
  return d;
}
const staged = (d) => git(d, "diff", "--cached", "--name-only").split("\n").filter(Boolean).sort();

section("2 — gate:ledger CLI: exit codes and messages against a real repo");
{
  const d = repo();
  let r = run(d, GATE);
  check("⭐ up to date → exit 0, says so for both files", r.status === 0 && (r.stdout.match(/\.jsonl: up to date/g) || []).length === 2, r.stdout.trim().split("\n").slice(-3).join(" | "));
  writeFileSync(join(d, "dd-refusal-window-log.jsonl"), lines(3));
  r = run(d, GATE);
  check("🚨 one ledger 1 behind → exit 1, names the file and '1 deploy'", r.status === 1 && /dd-refusal-window-log\.jsonl/.test(r.stdout + r.stderr) && /1 deploy\b/.test(r.stdout + r.stderr), (r.stdout + r.stderr).trim().split("\n").slice(-2).join(" | "));
  writeFileSync(join(d, "deploy-loss-log.jsonl"), lines(16, "observedAt"));
  r = run(d, GATE);
  check("🚨 both behind (1 and 14) → exit 1, both named with their counts", r.status === 1 && /14 deploys/.test(r.stdout + r.stderr) && /1 deploy\b/.test(r.stdout + r.stderr));
  git(d, "add", "-A"); git(d, "commit", "-q", "-m", "caught up");
  r = run(d, GATE);
  check("after committing → exit 0 again", r.status === 0);
  writeFileSync(join(d, "deploy-loss-log.jsonl"), lines(16, "observedAt") + "{garbage\n");
  git(d, "add", "-A"); git(d, "commit", "-q", "-m", "malformed committed");
  r = run(d, GATE);
  check("🚨 malformed committed last line → exit 1 UNREADABLE (not 'up to date' even though nothing is uncommitted)", r.status === 1 && /unreadable/i.test(r.stdout + r.stderr) && !/up to date.*deploy-loss/i.test(r.stdout + r.stderr), (r.stdout + r.stderr).trim().split("\n").slice(-2).join(" | "));
  rmSync(join(d, "dd-refusal-window-log.jsonl"));
  r = run(d, GATE);
  check("🚨 ledger missing from the working tree → exit 1 UNREADABLE naming it", r.status === 1 && /unreadable/i.test(r.stdout + r.stderr) && /dd-refusal-window-log/.test(r.stdout + r.stderr));
  const e = repo(); writeFileSync(join(e, "dd-refusal-window-log.jsonl"), ""); git(e, "add", "-A"); git(e, "commit", "-q", "-m", "empty");
  r = run(e, GATE);
  check("🚨 EMPTY committed ledger → exit 1 UNREADABLE", r.status === 1 && /unreadable/i.test(r.stdout + r.stderr) && /empty/i.test(r.stdout + r.stderr));
  const f = repo(); git(f, "rm", "-q", "--cached", "deploy-loss-log.jsonl"); git(f, "commit", "-q", "-m", "untracked ledger");
  r = run(f, GATE);
  check("🚨 ledger not in the committed tree at all → exit 1 UNREADABLE", r.status === 1 && /unreadable/i.test(r.stdout + r.stderr) && /deploy-loss-log/.test(r.stdout + r.stderr));
  rmSync(d, { recursive: true, force: true }); rmSync(e, { recursive: true, force: true }); rmSync(f, { recursive: true, force: true });
}

section("3 — stage-ledger: exactly the two paths, index only");
{
  const d = repo();
  // dirty everything: both ledgers, the stamp (non-null!), and an unrelated file
  writeFileSync(join(d, "dd-refusal-window-log.jsonl"), lines(3));
  writeFileSync(join(d, "deploy-loss-log.jsonl"), lines(3, "observedAt"));
  writeFileSync(join(d, "shared/build-stamp.generated.mjs"), 'export const RAW_BUILD_STAMP = { commit: "x" };\n');
  writeFileSync(join(d, "other.txt"), "changed\n");
  const head = git(d, "rev-parse", "HEAD");
  const r = run(d, STAGE);
  check("⭐ exit 0 and prints 'ledger staged — commit it'", r.status === 0 && /ledger staged — commit it/.test(r.stdout), r.stdout.trim());
  check("🚨 stages EXACTLY the two ledger paths", JSON.stringify(staged(d)) === JSON.stringify(["dd-refusal-window-log.jsonl", "deploy-loss-log.jsonl"]), JSON.stringify(staged(d)));
  check("🚨 the build stamp is NOT staged (dirty, non-null, and still not staged)", !staged(d).includes("shared/build-stamp.generated.mjs"));
  check("🚨 the unrelated dirty file is NOT staged", !staged(d).includes("other.txt"));
  check("🚨 no commit was made (HEAD unchanged) — index only", git(d, "rev-parse", "HEAD") === head);
  check("⭐ …and it WARNS that the stamp is dirty/non-null (so the human clears it before committing)", /stamp/i.test(r.stdout) && /stamp:clear|non-null|dirty/i.test(r.stdout));
  check("no remote, no push attempted (no 'origin' configured and exit still 0)", r.status === 0);
  const r2 = run(d, STAGE);
  check("idempotent: a second run stages the same two and nothing more", r2.status === 0 && staged(d).length === 2);
  rmSync(d, { recursive: true, force: true });
}

section("4 — ordering: a chain failure leaves the index clean; a gate:ledger failure cannot block a later capture");
{
  const d = repo();
  writeFileSync(join(d, "dd-refusal-window-log.jsonl"), lines(3));
  writeFileSync(join(d, "shared/build-stamp.generated.mjs"), 'export const RAW_BUILD_STAMP = { commit: "x" };\n');
  // the chain shape: gate:ledger && … && stage-ledger. Simulate a failure BEFORE the tail.
  const chain = spawnSync("sh", ["-c", `node "${GATE}" && false && node "${STAGE}"`], { cwd: d, encoding: "utf8" });
  check("🚨 a failure anywhere before the tail → nothing staged, nothing committed", chain.status !== 0 && staged(d).length === 0);
  // gate:ledger itself failing (1 behind) is the FIRST link: nothing after it runs — and it writes nothing
  const g = run(d, GATE);
  check("gate:ledger fails here (1 behind) and writes nothing: working tree byte-identical, index empty", g.status === 1 && staged(d).length === 0 && git(d, "status", "--porcelain").split("\n").filter(Boolean).length === 2);
  // A later deploy's capture must not depend on gate:ledger: the capture appends regardless. Model it: append, then stage.
  writeFileSync(join(d, "dd-refusal-window-log.jsonl"), lines(4));
  const s = run(d, STAGE);
  check("⭐ the capture (an append) and the stage still work on the next run — gate:ledger blocks a DEPLOY, never a capture", s.status === 0 && staged(d).includes("dd-refusal-window-log.jsonl"));
  rmSync(d, { recursive: true, force: true });
}

section("5 — package.json wiring: gate:ledger is the HEAD of deploy:prod, stage:ledger its TAIL");
{
  const pkg = JSON.parse(execFileSync("cat", ["package.json"], { encoding: "utf8" }));
  const chain = pkg.scripts["deploy:prod"];
  const steps = chain.split("&&").map((s) => s.trim());
  check("⭐ first step is gate:ledger", steps[0] === "npm run gate:ledger", steps[0]);
  check("⭐ last step is stage:ledger", steps[steps.length - 1] === "npm run stage:ledger", steps[steps.length - 1]);
  check("…after gate:deployed and capture:window (which append what gets staged)", steps.indexOf("npm run capture:window") > steps.indexOf("npm run gate:deployed") && steps.indexOf("npm run stage:ledger") > steps.indexOf("npm run capture:window") && steps.indexOf("npm run stage:ledger") > steps.indexOf("npm run gate:deployloss"));
  check("scripts exist and point at the files", /gate-ledger\.mjs/.test(pkg.scripts["gate:ledger"] || "") && /stage-ledger\.mjs/.test(pkg.scripts["stage:ledger"] || ""));
  check("this suite is in test:all", (pkg.suites || []).includes("test:ledgergate"));
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0\n`);
