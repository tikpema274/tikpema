#!/usr/bin/env node
// verify-deploy-liveness.mjs — the liveness tests behind verify-deployed's check 5.
//
//   node scripts/verify-deploy-liveness.mjs   (also: npm run test:liveness)
//
// ═══ 🚨 THE DEFECT THIS CLOSES, WHICH WAS SHIPPED ════════════════════════════════════════════
// Check 5 distinguishes a deploy IN FLIGHT from one ABANDONED mid-bundle. In the Netlify API the
// two are identical — state `new`, `error_message: null`, `required: []`, `updated_at ==
// created_at` — so the original code used the only thing left: elapsed time. Under 30 minutes old
// was presumed in flight. On 2026-08-15 it printed "presumed in flight, not orphaned" about a
// deploy created 9 minutes earlier whose machine had REBOOTED in between — at the top of the
// session convened to find out whether that very deploy had landed.
//
// ⭐⭐ A guard that accepts a TIMEOUT in place of EVIDENCE has the same shape as the thing it
// guards against. So these tests pin the EVIDENCE, and §5 pins the exact historical record so the
// elapsed-time rule cannot come back.
//
// ⭐ WHY THESE BRANCHES NEED A SUITE AT ALL: the live run during the 2026-08-15 redeploy exercised
// two of them for real (one deploy in flight with processes, one predating the boot). The other
// two — no process found, and both instruments unreadable — only ever fire when something is
// ALREADY going wrong, which is the worst moment to be running them for the first time.
//
// ⚠️ NO WALL CLOCK. Every timestamp here is injected. The quote suite's "defect" on 2026-08-15 was
// a hardcoded fixture ageing past a TTL, and a Date.now()-relative test fails at every commit once
// the clock passes the boundary — a defect that was never in the code.

import { bootTimeMs, ownProcessTree, parseBuildProcesses, livenessOf } from "./lib/deploy-liveness.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  DEPLOY LIVENESS — evidence, not elapsed time                        ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ⭐ THE REAL `ps -eo pid=,comm=,args=` OUTPUT captured during the 2026-08-15 redeploy, verbatim.
// It contains the trap: pid 2474 is the ONE `sh -c` holding the whole deploy:prod chain, and its
// argv contains the literal string "netlify deploy --prod --dir=dist".
const PS_DURING_REAL_DEPLOY = `
   2474 sh              sh -c npm run gate:watch && npm run gate:rpc && npm run build && netlify deploy --prod --dir=dist && npm run gate:deployed
   2933 node            node /home/salifu/.nvm/versions/node/v22.22.3/bin/netlify deploy --prod --dir=dist
   2995 esbuild         /home/salifu/.nvm/versions/node/v22.22.3/lib/node_modules/netlify-cli/node_modules/@esbuild/linux-x64/bin/esbuild --service=0.28.0 --ping
    398 bash            -bash
    127 cron            /usr/sbin/cron -f -P
`;

section("1 — THE REAL DEPLOY, PARSED");
{
  const procs = parseBuildProcesses(PS_DURING_REAL_DEPLOY);
  ok("⭐ the genuine CLI and its esbuild worker are both found", procs.length === 2, procs.map((p) => `${p.comm}(${p.pid})`).join(", "));
  ok("  …the netlify CLI process", procs.some((p) => p.pid === 2933));
  ok("  …and the esbuild worker", procs.some((p) => p.pid === 2995));
  ok("⭐⭐ the `sh -c` holding the CHAIN is NOT counted as a running deploy",
    !procs.some((p) => p.pid === 2474),
    "its argv contains \"netlify deploy --prod\" — a chain is a plan, not a running command");
  ok("  unrelated processes are ignored", !procs.some((p) => p.pid === 398 || p.pid === 127));
}

section("2 — THE EXCLUSIONS, ONE AT A TIME");
{
  // 🚨 THE BACK DOOR. gate:deployed is the LAST link of deploy:prod, so at the moment it runs the
  // CLI has exited but the chain's shell is still alive. Counting it would restore the exact false
  // "in flight" this whole change removes — with no elapsed-time rule anywhere in sight.
  const afterCliExits = "  2474 sh              sh -c npm run build && netlify deploy --prod --dir=dist && npm run gate:deployed";
  ok("⭐⭐ after the CLI exits, the surviving chain shell reads as NO build process",
    parseBuildProcesses(afterCliExits).length === 0);

  ok("a pipeline mentioning netlify is excluded too",
    parseBuildProcesses("  9001 bash            bash -c netlify deploy | tee log.txt").length === 0);

  ok("⭐ our own process tree is excluded",
    parseBuildProcesses("  4242 node            node /usr/bin/netlify api listSiteDeploys", new Set([4242])).length === 0,
    "the gate shells out to `netlify api` itself");

  ok("a filename that merely starts with `netlify` is not a build",
    parseBuildProcesses("  5555 vim             vim netlify-notes.txt").length === 0);

  ok("…but a real absolute-path invocation IS",
    parseBuildProcesses("  5556 node            /home/u/.nvm/bin/netlify deploy --prod").length === 1);

  ok("a blank/garbage line never becomes a process", parseBuildProcesses("\n\n   not a ps line\n").length === 0);
}

section("3 — livenessOf: THE FOUR OUTCOMES");
{
  const BOOT = Date.parse("2026-08-15T19:53:15.000Z");
  const AFTER = "2026-08-15T19:56:00.000Z";
  const BEFORE = "2026-08-15T19:48:51.556Z";
  const RUNNING = [{ pid: 2933, comm: "node" }];

  ok("⭐ created BEFORE the boot → provably dead", livenessOf(BEFORE, BOOT, RUNNING).dead === true);
  ok("⭐⭐ …even while build processes are running — they belong to a DIFFERENT deploy",
    livenessOf(BEFORE, BOOT, RUNNING).dead === true,
    "this is the live case from 2026-08-15: one deploy in flight, one already dead");
  ok("created after the boot with no build process → dead", livenessOf(AFTER, BOOT, []).dead === true);
  ok("created after the boot with a build process → in flight", livenessOf(AFTER, BOOT, RUNNING).dead === false);
  ok("  …and it names what is working on it", /node\(2933\)/.test(livenessOf(AFTER, BOOT, RUNNING).why));

  section("4 — ⭐⭐ THE UNKNOWN IS ITS OWN OUTCOME, NEVER THE CALM ONE");
  // 🚨 THE WHOLE FAMILY THIS REPO KEEPS RE-LEARNING: an absence quietly fills a result slot and
  // reads as safety. If an unreadable instrument collapsed to "in flight", the gate would go
  // quiet exactly when it had lost the ability to see.
  ok("⭐⭐ both instruments unreadable → null, not a verdict", livenessOf(AFTER, null, null).dead === null);
  ok("  …and it says so plainly", /could not be established/.test(livenessOf(AFTER, null, null).why));
  ok("⭐ boot unreadable but `ps` works → the process test alone still decides",
    livenessOf(AFTER, null, []).dead === true && livenessOf(AFTER, null, RUNNING).dead === false,
    "two independent instruments, either one sufficient");
  ok("⭐ `ps` unreadable and the deploy postdates the boot → unknown, NOT in flight",
    livenessOf(AFTER, BOOT, null).dead === null);
  ok("an unparseable created_at never silently passes the boot test",
    livenessOf("not-a-date", BOOT, RUNNING).dead === false, "falls through to the process test");
}

section("5 — 🚨 THE 2026-08-15 RECORD, REPLAYED EXACTLY");
{
  // The actual orphan, and the actual boot, both to the millisecond.
  const ORPHAN_CREATED = "2026-08-15T19:48:51.556Z";
  const BOOT = Date.parse("2026-08-15T19:53:15.000Z");
  const OBSERVED_AT = Date.parse("2026-08-15T19:58:00.000Z"); // when the gate was actually run
  const OLD_GRACE_MS = 30 * 60 * 1000;

  const ageMs = OBSERVED_AT - Date.parse(ORPHAN_CREATED);
  ok("the record was 9 minutes old — well inside the old 30-minute window",
    ageMs < OLD_GRACE_MS, `${(ageMs / 60000).toFixed(1)}min`);
  ok("⭐⭐ the OLD rule would have called this dead deploy \"presumed in flight\"",
    ageMs <= OLD_GRACE_MS, "which is exactly what it printed, in the session convened to check it");
  ok("⭐⭐ the NEW rule calls it what it is: orphaned",
    livenessOf(ORPHAN_CREATED, BOOT, [{ pid: 2933, comm: "node" }]).dead === true);
  ok("  …and gives the reason a human can check", /BEFORE this machine booted/.test(livenessOf(ORPHAN_CREATED, BOOT, []).why));
}

section("6 — THE INSTRUMENTS THEMSELVES RETURN null, NOT ZERO");
{
  // ⚠️ A boot time of 0 would make EVERY deploy predate the boot — every record instantly
  // "orphaned". The convenient falsy default is a wrong answer, not a missing one.
  const throws = () => { throw new Error("unavailable"); };
  ok("⭐⭐ bootTimeMs → null when neither /proc/stat nor sysctl can be read",
    bootTimeMs({ readFile: throws, run: throws }) === null);

  ok("bootTimeMs parses /proc/stat btime",
    bootTimeMs({ readFile: () => "cpu  1 2 3\nbtime 1786564395\nprocesses 42\n", run: throws }) === 1786564395000);

  ok("bootTimeMs falls back to sysctl on a BSD-shaped host",
    bootTimeMs({ readFile: throws, run: () => "{ sec = 1786564395, usec = 12 } Sat Aug 15 19:53:15 2026" }) === 1786564395000);

  // ownProcessTree walks ppid links; `comm` deliberately contains a space and parens.
  const fakeProc = { 100: "100 (my proc) S 50 …", 50: "50 (sh) S 1 …" };
  const tree = ownProcessTree({ pid: 100, readFile: (p) => fakeProc[p.split("/")[2]] ?? (() => { throw new Error("no"); })() });
  ok("⭐ ownProcessTree walks to every ancestor", tree.has(100) && tree.has(50), `[${[...tree].join(", ")}]`);
  ok("  …and stops cleanly at an unreadable parent", !tree.has(1));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
