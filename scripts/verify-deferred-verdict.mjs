// verify-deferred-verdict.mjs — gate:forgery's verdict must not stop the gates that come after it.
//
// ⭐ WHY (2026-10-02): deploy:prod:chain ran `… && gate:forgery && gate:spec && gate:deployloss && stage:ledger`.
// gate:forgery runs AFTER the deploy is live, and reports; it cannot undo anything. But an UNTESTED (exit 3, a probe
// refused before the comparison, e.g. the fee moved) or a FAIL (exit 1) stopped the three gates behind it. stage:ledger
// then never staged the ledgers, so the NEXT deploy's first link, gate:ledger, refused it as BEHIND. With C and E (the
// piece 5 money deploys) next in line, one UNTESTED on C would have blocked E until the ledgers were rebuilt by hand.
//
// ⭐ THE FIX: scripts/deferred-verdict.mjs runs gate:forgery, then the steps that must run regardless (`&&` among
// themselves, as before), then exits with forgery's OWN code, so the deploy log still says which red (1 vs 3).
//
// This suite runs the post-deploy segment of the REAL deploy:prod:chain string from package.json, with `npm` replaced
// by a stub on PATH that logs each `npm run <name>` and exits with a code chosen per scenario. Nothing real runs.

import { readFileSync, writeFileSync, mkdtempSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { chainSteps } from "./lib/deploy-chain.mjs";

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 70 - t.length))}`);

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const chain = pkg.scripts["deploy:prod:chain"] ?? "";
const REPO = new URL("..", import.meta.url).pathname;

// The stub `npm`: logs `run <name>`, exits STUB_EXITS[name] (default 0). Anything but `npm run X` exits 99.
const dir = mkdtempSync(join(tmpdir(), "deferred-verdict-"));
const stub = join(dir, "npm");
writeFileSync(stub, `#!${process.execPath}
const fs = require("fs");
const [cmd, name] = process.argv.slice(2);
if (cmd !== "run" || !name) process.exit(99);
fs.appendFileSync(process.env.STUB_LOG, name + "\\n");
const codes = JSON.parse(process.env.STUB_EXITS || "{}");
process.exit(codes[name] ?? 0);
`);
chmodSync(stub, 0o755);

// The segment after the artifact leaves the machine: from `npm run gate:deployed` to the end of the chain.
const at = chain.indexOf("npm run gate:deployed");
const segment = at >= 0 ? chain.slice(at) : "";
let n = 0;
function runSegment(exits) {
  const log = join(dir, `log-${n++}`);
  const r = spawnSync("sh", ["-c", segment], { cwd: REPO, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, STUB_EXITS: JSON.stringify(exits) } });
  const ran = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  return { status: r.status, ran, out: `${r.stdout}${r.stderr}` };
}
const AFTER = ["gate:spec", "gate:deployloss", "stage:ledger"];
const show = (r) => `exit ${r.status}; ran ${r.ran.join(" → ")}`;

section("0 — the chain has the segment this suite runs");
ok("deploy:prod:chain contains `npm run gate:deployed`, then gate:forgery", at >= 0 && segment.includes("gate:forgery"), segment.slice(0, 120));

section("1 — all green: every post-deploy gate runs, in order, exit 0");
{
  const r = runSegment({});
  ok("exit 0", r.status === 0, show(r));
  ok("ran gate:deployed → capture:window → gate:forgery → gate:spec → gate:deployloss → stage:ledger",
    r.ran.join(",") === ["gate:deployed", "capture:window", "gate:forgery", ...AFTER].join(","), r.ran.join(","));
}

section("2 — ⭐⭐ gate:forgery UNTESTED (exit 3): the three gates behind it STILL RUN, and the chain exits 3");
{
  const r = runSegment({ "gate:forgery": 3 });
  ok("⭐⭐ gate:spec, gate:deployloss and stage:ledger all ran after it", AFTER.every((s) => r.ran.includes(s)) &&
    r.ran.indexOf("stage:ledger") > r.ran.indexOf("gate:forgery"), show(r));
  ok("⭐ the chain exits 3, forgery's own code (UNTESTED stays distinguishable from FAIL)", r.status === 3, show(r));
  ok("the closing summary names gate:forgery's exit", /gate:forgery[^\n]*\b3\b/.test(r.out), r.out.trim().split("\n").slice(-3).join(" | "));
}

section("3 — 🚨 gate:forgery FAIL (exit 1): the same — the ledgers are staged, the chain exits 1");
{
  const r = runSegment({ "gate:forgery": 1 });
  ok("⭐⭐ the three gates ran", AFTER.every((s) => r.ran.includes(s)), show(r));
  ok("⭐ exit 1 (FAIL), not 3 and never 0", r.status === 1, show(r));
}

section("4 — a red AFTER forgery still stops what follows it (unchanged `&&` semantics), and is not hidden");
{
  const r = runSegment({ "gate:spec": 1 });
  ok("gate:spec red → gate:deployloss and stage:ledger do NOT run", r.ran.includes("gate:spec") && !r.ran.includes("gate:deployloss") && !r.ran.includes("stage:ledger"), show(r));
  ok("…and the chain exits non-zero", r.status !== 0 && r.status !== null, show(r));
  const both = runSegment({ "gate:forgery": 3, "stage:ledger": 1 });
  ok("forgery 3 AND stage:ledger red → non-zero (forgery's 3), every gate ran", both.status === 3 && AFTER.every((s) => both.ran.includes(s)), show(both));
  ok("…the summary says stage:ledger failed too (a red is never swallowed by another)", /stage:ledger[^\n]*\b1\b/.test(both.out), both.out.trim().split("\n").slice(-4).join(" | "));
}

section("5 — what runs BEFORE forgery still gates it: an unverified deploy runs nothing after");
{
  const r = runSegment({ "gate:deployed": 1 });
  ok("gate:deployed red → nothing after it runs, exit non-zero", r.ran.join(",") === "gate:deployed" && r.status !== 0, show(r));
  const c = runSegment({ "capture:window": 1 });
  ok("capture:window red → gate:forgery and the rest do NOT run", !c.ran.includes("gate:forgery") && c.status !== 0, show(c));
}

section("6 — the wrapper itself fails closed");
{
  const W = join(REPO, "scripts/deferred-verdict.mjs");
  const call = (args) => spawnSync(process.execPath, [W, ...args], { cwd: REPO, encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB_LOG: join(dir, `w-${n++}`), STUB_EXITS: "{}" } });
  const noSep = call(["gate:forgery", "gate:spec"]);
  ok("no `--` → usage error (exit 2), runs nothing", noSep.status === 2, `exit ${noSep.status}`);
  const noRest = call(["gate:forgery", "--"]);
  ok("nothing after `--` → usage error (exit 2)", noRest.status === 2, `exit ${noRest.status}`);
  const noGate = call(["--", "gate:spec"]);
  ok("no gate before `--` → usage error (exit 2)", noGate.status === 2, `exit ${noGate.status}`);
  const missing = spawnSync(process.execPath, [W, "gate:forgery", "--", "gate:spec"], { cwd: REPO, encoding: "utf8",
    env: { ...process.env, PATH: "/nonexistent" } });
  ok("⭐ npm cannot be started → a red exit, never 0 (a gate that did not run did not pass)", missing.status !== 0 && missing.status !== null, `exit ${missing.status}`);
}

section("7 — the other suites' order pins read the EXPANDED chain");
{
  const steps = chainSteps(chain);
  ok("chainSteps expands the wrapper: stage:ledger is the last step that runs", steps.at(-1) === "npm run stage:ledger", steps.slice(-5).join(" | "));
  ok("…gate:forgery appears exactly once", steps.filter((s) => s === "npm run gate:forgery").length === 1);
  ok("…and the raw chain has no `gate:forgery &&` (nothing after it depends on its exit)", !/gate:forgery\s*&&/.test(chain), chain.slice(chain.indexOf("capture:window")));
  ok("this suite is in test:all", (pkg.suites || []).includes("test:deferredverdict"));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0\n`);
