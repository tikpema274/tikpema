// deploy-liveness.mjs — is anything actually WORKING on this deploy right now?
//
// ═══ ⭐⭐ WHY THIS EXISTS: A TIMEOUT STOOD IN FOR EVIDENCE ═════════════════════════════════════
// `verify-deployed`'s check 5 finds production deploys that were created and never finished. A
// deploy in flight and a deploy abandoned mid-bundle are byte-identical in the API: state `new`,
// `error_message: null`, `required: []`, `updated_at == created_at`. The only difference is
// whether a process is still working on it.
//
// The original code did not ask that. It asked how OLD the record was, and presumed anything
// under 30 minutes was in flight. On 2026-08-15 that printed
//
//     ⚠️  6a80c2a3… is "new" and 9min old — presumed in flight, not orphaned
//
// about a deploy whose machine had REBOOTED since it was created, at the top of the session
// convened specifically to find out whether the deploy had landed. ⭐ The window covers exactly
// the minutes right after the failure, which is exactly when someone is looking — so the guess
// was at its most reassuring precisely when it was most wrong.
//
// ⭐⭐ THE CLASS: a guard that accepts a TIMEOUT in place of EVIDENCE has the same shape as the
// thing it guards against. verify-deployed exists because an absence (no error, nothing red) was
// read as a success; "30 minutes have not yet elapsed" is likewise an absence — of elapsed time —
// filling in for a presence of work. The fix is not a longer window. It is to test for the work.
//
// ═══ TWO POSITIVE TESTS, BOTH CHEAP AND IMMEDIATE ════════════════════════════════════════════
//   A. the deploy's created_at PREDATES THE CURRENT BOOT  → nothing that could work on it exists
//   B. no netlify/esbuild process is running at all       → nothing IS working on it
//
// A is decisive on its own: no process survives its machine. B is the independent second
// instrument (two instruments, not two reads of one — the same discipline as check 4), and it
// catches the case A cannot see: a CLI killed WITHOUT a reboot.
//
// ⚠️ EVERY FUNCTION RETURNS `null` FOR "COULD NOT TELL", NEVER A CONVENIENT ZERO OR EMPTY. A boot
// time of 0 makes every deploy predate the boot and read as dead; an empty process list where
// `ps` itself failed reads as "nothing is running". Both would be an absence silently filling a
// result slot — the exact shape this file was written against — so the unknown is carried out to
// the caller and reported as its own failure.
//
// ⚠️ SCOPE: both tests are about THIS machine. A deploy driven from another machine or from CI
// reads as dead here. That is the deliberate trade — the gate's question is "did I lose MY
// deploy", it runs on the box that deploys, and the costs are asymmetric: a false ORPHANED costs
// one redundant deploy, a false IN FLIGHT costs a change everyone believes shipped and nobody
// re-checks.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Epoch ms of the current boot, or null if it cannot be determined. */
export function bootTimeMs({ readFile = readFileSync, run = execFileSync } = {}) {
  // Linux: /proc/stat's `btime` IS the boot instant in epoch seconds — no arithmetic against an
  // uptime counter, and unaffected by the wall clock being adjusted after boot.
  try {
    const m = String(readFile("/proc/stat", "utf8")).match(/^btime (\d+)$/m);
    if (m) return Number(m[1]) * 1000;
  } catch { /* not Linux, or /proc unavailable — try the BSD path */ }
  try {
    const m = String(run("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 5_000 }))
      .match(/sec\s*=\s*(\d+)/);
    if (m) return Number(m[1]) * 1000;
  } catch { /* unknown */ }
  return null;
}

/** Our own pid and every process that spawned us — none of which can be a foreign deploy CLI. */
export function ownProcessTree({ pid: start = process.pid, readFile = readFileSync } = {}) {
  const mine = new Set();
  let pid = start;
  for (let depth = 0; depth < 64 && pid > 1; depth++) {
    mine.add(pid);
    try {
      const stat = String(readFile(`/proc/${pid}/stat`, "utf8"));
      // `comm` can itself contain spaces and parentheses, so ppid is counted from the LAST ")".
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (!Number.isInteger(ppid) || ppid <= 0) break;
      pid = ppid;
    } catch { break; }
  }
  return mine;
}

/**
 * Parse `ps -eo pid=,comm=,args=` output down to genuine build processes.
 * Pure, so the exclusions below are tested by CALLING rather than by trusting a regex on sight.
 */
export function parseBuildProcesses(psOutput, ownPids = new Set()) {
  const found = [];
  for (const line of String(psOutput).split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pidStr, comm, args] = m;
    if (ownPids.has(Number(pidStr))) continue;
    // ⭐ LOAD-BEARING EXCLUSION. `deploy:prod` is a single
    //     sh -c "npm run gate:watch && … && netlify deploy --prod --dir=dist && npm run gate:deployed"
    // so when this gate runs as the LAST link of that chain, the shell holding the whole chain is
    // still alive with the string "netlify deploy" sitting in its argv. Matching it would report a
    // CLI that already exited as still working — reintroducing the false "in flight" through the
    // back door. A command chain is a plan, not a running command.
    if (/&&|\|\||;|\|/.test(args)) continue;
    if (!/(?:^|\/|\s)netlify(?:\s|\/|$)/.test(args) && !/esbuild/.test(args)) continue;
    found.push({ pid: Number(pidStr), comm, args: args.slice(0, 90) });
  }
  return found;
}

/** Netlify/esbuild build processes on THIS machine, or null if `ps` could not be run. */
export function buildProcesses({ run = execFileSync, ownPids } = {}) {
  let raw;
  try {
    raw = run("ps", ["-eo", "pid=,comm=,args="], { encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return null; // ⚠️ `ps` being unavailable is not evidence of absence.
  }
  return parseBuildProcesses(raw, ownPids ?? ownProcessTree());
}

/**
 * Is this deploy still being worked on?
 * → { dead: true }  provably not — orphaned
 * → { dead: false } provably yes — in flight
 * → { dead: null }  neither test could run; the caller must NOT smooth this into either verdict
 */
export function livenessOf(createdAtIso, boot, procs) {
  const createdMs = Date.parse(createdAtIso);
  if (boot !== null && Number.isFinite(createdMs) && createdMs < boot) {
    return {
      dead: true,
      why: `created ${createdAtIso}, BEFORE this machine booted at ${new Date(boot).toISOString()} — every process that could have been working on it is gone`,
    };
  }
  if (procs !== null && procs.length === 0) {
    return { dead: true, why: "no netlify or esbuild process is running on this machine — nothing is bundling or uploading it" };
  }
  if (procs !== null) {
    return { dead: false, why: `still being worked on: ${procs.map((p) => `${p.comm}(${p.pid})`).join(", ")}` };
  }
  return { dead: null, why: "liveness could not be established — boot time unreadable AND `ps` unavailable" };
}
