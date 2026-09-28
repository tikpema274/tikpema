#!/usr/bin/env node
// run-lock.mjs — ONE run at a time, for the things T launches from a terminal that must never run twice at once.
//
//   node scripts/run-lock.mjs --lock <name> [--reentrant] [--break-stale-lock] -- <command> [args…]
//   node scripts/run-lock.mjs --assert-held --lock <name>
//
// ═══ WHY (PROGRESS 2026-09-28, the deploy 6ab98b57 double-append) ════════════════════════════════════
// `deploy:prod` was launched twice, 19 s apart, on 2026-09-27. Both chains passed every gate, two production deploys
// were created 16 ms apart and BOTH published (6ab98b57b824 was live ~1.3 s before 6ab98b57bb2c replaced it), and
// each chain appended to the ledgers. The same double launch happened on 09-25, hidden only because one chain failed
// its tests. Nothing refused the second run. This does.
//
// ═══ THE RULES (T, 2026-09-28) ═══════════════════════════════════════════════════════════════════════
//   · A lockfile naming the holder, taken FIRST. A second launch REFUSES, loudly — the running PID, when it started,
//     its log — and starts nothing. It never queues, waits or retries.
//   · Acquired ATOMICALLY: the content is written to a temp file, then `link()`ed into place. link fails with EEXIST
//     if a lock exists, so of any number of simultaneous launches exactly one wins, and a crash can never leave a
//     half-written lock (test:runlock races 8 processes).
//   · STALE only when PROVEN dead: another boot (boot_id), no such process (kill 0 → ESRCH, or its /proc entry gone),
//     or the PID REUSED (alive, but its /proc start time is not the recorded one). Anything that cannot be
//     established — another host, /proc unreadable — is UNKNOWN, and unknown blocks.
//   · ⛔ Even a proven-stale lock is NOT taken over. "Proven dead" still rests on reading /proc correctly, and being
//     wrong means two concurrent deploys — the thing this prevents. It takes --break-stale-lock, which re-proves it
//     and RENAMES the lock to <name>.lock.stale-<ts> (evidence kept), never deletes it.
//   · ⛔ Never delete another run's lock (release checks the token). Never proceed on an unreadable lock.
//
// ═══ HOW A CHAIN USES IT ═════════════════════════════════════════════════════════════════════════════
// The wrapper holds the lock for the whole command and exports TIKPEMA_LOCK_TOKEN_<NAME> to it. Inside:
//   · `--assert-held` (the first step of deploy:prod:chain): refuses unless that token holds the live lock, so the
//     chain cannot be run around the wrapper.
//   · `--reentrant` (capture:window, gate:deployloss, stage:ledger, sweep:deploys, deploy:site*): inside the holder's
//     run, the token matches and the command runs; run by hand, it takes the lock like anything else, and during a
//     deploy it is refused.
// Released when the command exits (its exit code passes through) and on SIGINT / SIGTERM (forwarded to the command).
// A `kill -9` or a dead machine leaves a stale lock: see --break-stale-lock.
//
// ⚠️ LIMITS, STATED: one machine (the lock lives in ~/.cache/tikpema; another host sees none — the Netlify-side check
// is scoped-not-built, trigger: a second machine or a second operator). Linux /proc (WSL here); on macOS the start
// time needs `ps -o lstart=` and its own test. `node scripts/<x>.mjs` run directly bypasses an npm-level wrapper;
// deploy:prod:chain guards itself with --assert-held, and escrow-reclaim takes its lock in-process.

import { mkdirSync, writeFileSync, readFileSync, linkSync, unlinkSync, renameSync, readlinkSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const LOCK_SCHEMA = "tikpema-lock/1";
/** Exit codes: the refusal kinds are distinct so a log or a caller can tell them apart. */
export const LOCK_EXIT = Object.freeze({ held: 3, stale: 4, unreadable: 5, notHeld: 6, usage: 2 });

export const lockDir = (env = process.env) => env.TIKPEMA_LOCK_DIR || join(homedir(), ".cache", "tikpema");
export const lockPath = (name, dir = lockDir()) => join(dir, `${name}.lock`);
export const tokenVar = (name) => `TIKPEMA_LOCK_TOKEN_${String(name).toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

/** The real system. Every call here can FAIL, and a failure is never read as "dead" or "absent". */
export const realSys = {
  pid: () => process.pid,
  hostname: () => hostname(),
  bootId() {
    const b = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!b) throw new Error("boot_id is empty");
    return b;
  },
  /** /proc/<pid>/stat field 22 (starttime, clock ticks since boot). null = the process is GONE; unreadable → throws. */
  startTime(pid) {
    let raw;
    try { raw = readFileSync(`/proc/${pid}/stat`, "utf8"); }
    catch (e) { if (e?.code === "ENOENT") return null; throw e; }
    // The command name (field 2) is in parentheses and may contain spaces; the fields after the LAST ')' start at 3.
    const rest = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/);
    const st = rest[19];
    if (!/^\d+$/.test(st ?? "")) throw new Error(`/proc/${pid}/stat has no start time`);
    return st;
  },
  /** true = exists (EPERM: exists, another user's); false = ESRCH; anything else throws. */
  alive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (e) { if (e?.code === "ESRCH") return false; if (e?.code === "EPERM") return true; throw e; }
  },
  cmdline(pid = process.pid) {
    try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" "); } catch { return process.argv.join(" "); }
  },
  /** Where this process's stdout goes — under `nohup … > deploy-logs/X.log`, that log. */
  stdoutPath() { try { return readlinkSync("/proc/self/fd/1"); } catch { return null; } },
  token: () => randomBytes(16).toString("hex"),
};

const REQUIRED = [["schema", (v) => v === LOCK_SCHEMA], ["name", (v) => typeof v === "string" && !!v], ["pid", (v) => Number.isInteger(v) && v > 0],
  ["startTime", (v) => typeof v === "string" && /^\d+$/.test(v)], ["bootId", (v) => typeof v === "string" && !!v], ["host", (v) => typeof v === "string" && !!v],
  ["token", (v) => typeof v === "string" && !!v], ["startedAt", (v) => typeof v === "string" && !!v]];

/** @returns {{ok:true, lock} | {ok:false, absent:true} | {ok:false, why:string}} — unreadable is never "absent". */
export function readLock(path) {
  let raw;
  try { raw = readFileSync(path, "utf8"); }
  catch (e) { return e?.code === "ENOENT" ? { ok: false, absent: true } : { ok: false, why: `the lock at ${path} cannot be read (${e?.code ?? e?.message})` }; }
  let lock;
  try { lock = JSON.parse(raw); } catch { return { ok: false, why: `the lock at ${path} is not JSON${raw.length ? "" : " (it is empty)"}` }; }
  const bad = REQUIRED.filter(([k, test]) => !test(lock?.[k])).map(([k]) => k);
  if (bad.length) return { ok: false, why: `the lock at ${path} is missing or has malformed: ${bad.join(", ")}` };
  return { ok: true, lock };
}

/**
 * Is the recorded holder live? Only PROOF makes it stale; anything unestablished is unknown.
 * @returns {{state:"live"} | {state:"stale", proof:string} | {state:"unknown", why:string}}
 */
export function classifyLock(lock, sys = realSys) {
  const unknown = (why) => ({ state: "unknown", why });
  let host, boot, alive, st;
  try { host = sys.hostname(); } catch (e) { return unknown(`this host's name cannot be read (${e?.message})`); }
  if (lock.host !== host) return unknown(`it is held on another host (${lock.host}); this machine cannot see that process`);
  try { boot = sys.bootId(); } catch (e) { return unknown(`the boot id cannot be read (${e?.message})`); }
  if (lock.bootId !== boot) return { state: "stale", proof: `it was taken in another boot (boot_id ${String(lock.bootId).slice(0, 8)}…, now ${boot.slice(0, 8)}…) — no process survives a reboot` };
  try { alive = sys.alive(lock.pid); } catch (e) { return unknown(`whether PID ${lock.pid} exists cannot be established (${e?.message})`); }
  if (!alive) return { state: "stale", proof: `no such process: PID ${lock.pid} does not exist` };
  try { st = sys.startTime(lock.pid); } catch (e) { return unknown(`PID ${lock.pid}'s start time cannot be read (${e?.message})`); }
  if (st === null) return { state: "stale", proof: `no such process: PID ${lock.pid}'s /proc entry is gone` };
  if (st !== lock.startTime) return { state: "stale", proof: `PID ${lock.pid} was reused: that process's start time is ${st}, the lock recorded ${lock.startTime}` };
  return { state: "live" };
}

/**
 * Take the lock, atomically. Refuses (never waits) when it is held, stale, or cannot be judged.
 * @returns {{ok:true, token, lock, path} | {ok:false, code:"held"|"stale"|"unreadable", why?, proof?, lock?, path}}
 */
export function acquireLock({ name, dir = lockDir(), sys = realSys, now = () => new Date() } = {}) {
  const path = lockPath(name, dir);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(name ?? ""))) return { ok: false, code: "unreadable", why: `bad lock name ${JSON.stringify(name)}`, path };
  const pid = sys.pid();
  let startTime, bootId, host;
  try { startTime = sys.startTime(pid); bootId = sys.bootId(); host = sys.hostname(); }
  catch (e) { return { ok: false, code: "unreadable", why: `this process cannot describe itself (${e?.message}); a lock it cannot prove is not taken`, path }; }
  if (!/^\d+$/.test(startTime ?? "")) return { ok: false, code: "unreadable", why: "this process's own start time cannot be read", path };
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { return { ok: false, code: "unreadable", why: `the lock directory ${dir} cannot be created (${e?.code})`, path }; }
  const token = sys.token();
  const lock = { schema: LOCK_SCHEMA, name, pid, startTime, bootId, host, token, startedAt: now().toISOString(),
    log: sys.stdoutPath(), cmdline: sys.cmdline(pid) };
  for (let i = 0; i < 3; i++) {
    const tmp = `${path}.tmp-${pid}-${token}`;
    try {
      writeFileSync(tmp, JSON.stringify(lock, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      try { linkSync(tmp, path); return { ok: true, token, lock, path }; }
      catch (e) { if (e?.code !== "EEXIST") return { ok: false, code: "unreadable", why: `the lock could not be created (${e?.code})`, path }; }
    } finally { try { unlinkSync(tmp); } catch { /* already gone */ } }
    const r = readLock(path);
    if (r.absent) continue; // released between our link and our read: try again
    if (!r.ok) return { ok: false, code: "unreadable", why: r.why, path };
    const c = classifyLock(r.lock, sys);
    if (c.state === "live") return { ok: false, code: "held", lock: r.lock, path };
    if (c.state === "stale") return { ok: false, code: "stale", proof: c.proof, lock: r.lock, path };
    return { ok: false, code: "unreadable", why: c.why, lock: r.lock, path };
  }
  return { ok: false, code: "unreadable", why: "the lock kept appearing and disappearing; refusing rather than guessing", path };
}

/** Remove the lock ONLY if it is still this run's (the token). Never another run's. */
export function releaseLock({ name, dir = lockDir(), token }) {
  const path = lockPath(name, dir);
  const r = readLock(path);
  if (!r.ok) return { released: false, why: r.absent ? "no lock" : r.why };
  if (r.lock.token !== token) return { released: false, why: `the lock is held by another run (PID ${r.lock.pid}); not touched` };
  try { unlinkSync(path); return { released: true }; } catch (e) { return { released: false, why: `could not remove the lock (${e?.code})` }; }
}

/**
 * --break-stale-lock: re-prove staleness NOW, then RENAME the lock aside (kept as evidence). Refuses a live or an
 * unreadable lock. If the file renamed turns out not to be the one proven stale (it changed in between), it is put back.
 */
export function breakStaleLock({ name, dir = lockDir(), sys = realSys, now = () => new Date() } = {}) {
  const path = lockPath(name, dir);
  const r = readLock(path);
  if (r.absent) return { ok: false, absent: true, why: "there is no lock to break" };
  if (!r.ok) return { ok: false, code: "unreadable", why: `${r.why} — an unreadable lock is not proven stale; inspect it by hand` };
  const c = classifyLock(r.lock, sys);
  if (c.state === "live") return { ok: false, code: "held", lock: r.lock, why: `PID ${r.lock.pid} is alive and is the holder; not broken` };
  if (c.state === "unknown") return { ok: false, code: "unreadable", lock: r.lock, why: `${c.why} — not proven stale; not broken` };
  const movedTo = `${path}.stale-${now().toISOString().replace(/[:.]/g, "-")}-${r.lock.token.slice(0, 8)}`;
  try { renameSync(path, movedTo); } catch (e) { return { ok: false, code: "unreadable", why: `could not move the stale lock aside (${e?.code})` }; }
  const m = readLock(movedTo);
  if (!m.ok || m.lock.token !== r.lock.token) {
    // We moved a DIFFERENT lock than the one proven stale. Put it back; never leave another run without its lock.
    try { linkSync(movedTo, path); unlinkSync(movedTo); return { ok: false, code: "held", why: "the lock changed while it was being broken; it was restored, nothing broken" }; }
    catch (e) { return { ok: false, code: "unreadable", why: `🚨 the lock changed while it was being broken and could not be restored (${e?.code}); the moved file is ${movedTo} — inspect by hand` }; }
  }
  return { ok: true, movedTo, proof: c.proof };
}

/** Does `token` hold the live lock `name`? (What --assert-held and --reentrant ask.) */
export function lockHeldBy({ name, dir = lockDir(), token, sys = realSys }) {
  if (!token) return false;
  const r = readLock(lockPath(name, dir));
  if (!r.ok || r.lock.token !== token) return false;
  return classifyLock(r.lock, sys).state === "live";
}

/** The loud refusal. Names the holder and its log; says nothing was started; says what to do. */
export function refusalMessage(res, name) {
  const l = res?.lock ?? {};
  if (res?.code === "held") {
    return `⛔ ${name} is already running — PID ${l.pid}, started ${l.startedAt}, log ${l.log ?? "(unknown)"}.\n` +
      `   Nothing was started. Watch that run instead${l.log ? `: tail -f ${l.log}` : "."}`;
  }
  if (res?.code === "stale") {
    return `⛔ ${name} has a STALE lock — ${res.proof}.\n` +
      `   Nothing was started. The lock is kept: ${res.path}\n` +
      `   If you have checked that no ${name} run is in progress, re-run with --break-stale-lock (it re-proves the lock is dead\n` +
      `   and RENAMES it aside; it never deletes it).`;
  }
  return `⛔ ${name}: the lock could not be read or judged — ${res?.why ?? "unknown"}.\n` +
    `   Nothing was started, and nothing was changed${res?.path ? `: ${res.path}` : ""}. Inspect it by hand.`;
}

// ═══ CLI ════════════════════════════════════════════════════════════════════════════════════════════
function parseArgs(argv) {
  const sep = argv.indexOf("--");
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const cmd = sep === -1 ? [] : argv.slice(sep + 1);
  const i = own.indexOf("--lock");
  return { name: i === -1 ? null : own[i + 1], reentrant: own.includes("--reentrant"), breakStale: own.includes("--break-stale-lock"),
    assertHeld: own.includes("--assert-held"), cmd };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.name) { console.error("usage: run-lock.mjs --lock <name> [--reentrant] [--break-stale-lock] -- <command…> | --assert-held --lock <name>"); process.exit(LOCK_EXIT.usage); }
  const envToken = process.env[tokenVar(a.name)];

  if (a.assertHeld) {
    if (lockHeldBy({ name: a.name, token: envToken })) process.exit(0);
    console.error(`⛔ this must run under the "${a.name}" lock (through its wrapper, e.g. \`npm run deploy:prod\`), not on its own. Nothing was started.`);
    process.exit(LOCK_EXIT.notHeld);
  }
  if (!a.cmd.length) { console.error("run-lock: no command after `--`"); process.exit(LOCK_EXIT.usage); }

  // Inside the holder's own run: the command runs; the lock is the holder's to release, not ours.
  if (a.reentrant && envToken && lockHeldBy({ name: a.name, token: envToken })) {
    const child = spawn(a.cmd[0], a.cmd.slice(1), { stdio: "inherit" });
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
    child.on("error", (e) => { console.error(`run-lock: could not start ${a.cmd[0]}: ${e.message}`); process.exit(1); });
    child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    return;
  }

  if (a.breakStale) {
    const b = breakStaleLock({ name: a.name });
    if (b.ok) console.error(`⚠️ ${a.name}: a stale lock was broken — ${b.proof}. Kept as ${b.movedTo}.`);
    else if (!b.absent) { console.error(`⛔ ${a.name}: --break-stale-lock refused — ${b.why}. Nothing was started.`); process.exit(b.code === "held" ? LOCK_EXIT.held : LOCK_EXIT.unreadable); }
  }

  const got = acquireLock({ name: a.name });
  if (!got.ok) { console.error(refusalMessage(got, a.name)); process.exit(LOCK_EXIT[got.code] ?? LOCK_EXIT.unreadable); }

  let released = false;
  const release = () => { if (!released) { released = true; releaseLock({ name: a.name, token: got.token }); } };
  process.on("exit", release);
  const child = spawn(a.cmd[0], a.cmd.slice(1), { stdio: "inherit", env: { ...process.env, [tokenVar(a.name)]: got.token } });
  // Forwarded, not handled: the command decides how to stop; the lock is released when it has.
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
  child.on("error", (e) => { console.error(`run-lock: could not start ${a.cmd[0]}: ${e.message}`); release(); process.exit(1); });
  child.on("exit", (code, signal) => { release(); process.exit(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)); });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
