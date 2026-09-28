#!/usr/bin/env node
// verify-run-lock.mjs — the lock on deploy:prod (and the rest of the deploy scope), and escrow-reclaim --confirm.
//
//   node scripts/verify-run-lock.mjs
//
// ═══ WHY (PROGRESS 2026-09-28, the deploy 6ab98b57 double-append) ════════════════════════════════════
// `deploy:prod` was launched twice, 19 s apart, on 2026-09-27: both chains passed, two production deploys were
// created 16 ms apart and BOTH published (b824 live ~1.3 s before bb2c replaced it), and each chain appended to the
// ledgers. The same double launch happened on 09-25, hidden because one chain failed its tests. Nothing refused it.
//
// ═══ THE DECISIONS (T, 2026-09-28) ═══════════════════════════════════════════════════════════════════
//   · A lockfile with the holder's PID, taken FIRST; a second launch REFUSES loudly (PID + log), never queues/waits.
//   · Stale = PROVEN dead (another boot · no such process · PID reused, by start time). Even then it is NOT taken
//     over: it takes --break-stale-lock, which RENAMES it (evidence kept), never deletes. "Proven dead" still rests
//     on reading /proc correctly, and being wrong means two concurrent deploys.
//   · Never delete another run's lock; never proceed on an unreadable one.
//   · Scope: deploy:prod, deploy:site(:prod), sweep:deploys and the ledger scripts run by hand share the `deploy`
//     lock; escrow-reclaim --confirm has its own. The Netlify-side check is scoped-not-built.
//
// ⚠️ Every test uses its own temp lock dir (TIKPEMA_LOCK_DIR / `dir`), never ~/.cache/tikpema.

import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, statSync, rmSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const attempt = (fn) => { try { return fn(); } catch (e) { return { threw: String(e?.message ?? e) }; } };
const show = (o) => JSON.stringify(o ?? null)?.slice(0, 220);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => mkdtempSync(join(tmpdir(), "run-lock-"));
// Spawn with the exit captured AT SPAWN, so a process that dies instantly cannot be missed by a later listener.
const run = (cmd, args, opts) => { const c = spawn(cmd, args, opts); c.exited = new Promise((r) => c.on("exit", (code) => r(code))); return c; };
const load = async (p) => { try { return await import(p); } catch (e) { return { __missing: String(e?.message ?? e) }; } };

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  RUN LOCK — one deploy at a time; a second launch refuses            ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

const L = await load("./run-lock.mjs");
const has = (n) => typeof L[n] === "function";

// A fake system: the holder described by `lock` is alive / dead / reused as the test says.
const fakeSys = (o = {}) => ({
  pid: () => o.pid ?? 4242, hostname: () => o.host ?? "hostA", bootId: () => { if (o.bootThrows) throw new Error("boot_id unreadable"); return o.boot ?? "boot-1"; },
  startTime: (pid) => { if (o.startThrows) throw new Error("/proc unreadable"); return o.startOf ? o.startOf(pid) : "1000"; },
  alive: (pid) => { if (o.aliveThrows) throw new Error("kill(0) failed: EINVAL"); return o.aliveOf ? o.aliveOf(pid) : true; },
  cmdline: () => "node scripts/run-lock.mjs --lock t -- npm run x", stdoutPath: () => "/logs/run.log", token: (() => { let n = 0; return () => `tok-${++n}`; })(),
});
const lockFile = (dir, name) => join(dir, `${name}.lock`);
const readJ = (p) => JSON.parse(readFileSync(p, "utf8"));
const leftovers = (dir) => readdirSync(dir).filter((f) => /\.tmp-/.test(f));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — acquire, and a second acquire while the holder is LIVE");
{
  ok("run-lock.mjs exists and exports the library", !L.__missing && ["acquireLock", "classifyLock", "releaseLock", "breakStaleLock", "lockHeldBy", "readLock"].every(has), L.__missing ?? "");
  const dir = tmp();
  const a = has("acquireLock") ? attempt(() => L.acquireLock({ name: "t", dir, sys: fakeSys() })) : null;
  const f = lockFile(dir, "t");
  ok("acquire on an empty dir → ok, with a token", a?.ok === true && typeof a?.token === "string", show(a));
  const j = existsSync(f) ? readJ(f) : {};
  ok("the lock records pid, startTime, bootId, host, token, startedAt, log, cmdline, name, schema",
    j.pid === 4242 && j.startTime === "1000" && j.bootId === "boot-1" && j.host === "hostA" && j.token === a?.token &&
    typeof j.startedAt === "string" && j.log === "/logs/run.log" && /run-lock/.test(j.cmdline ?? "") && j.name === "t" && j.schema === "tikpema-lock/1", show(j));
  ok("  …mode 0600, and no temp file left behind", existsSync(f) && (statSync(f).mode & 0o777) === 0o600 && leftovers(dir).length === 0, leftovers(dir).join(","));
  const b = has("acquireLock") ? attempt(() => L.acquireLock({ name: "t", dir, sys: fakeSys({ pid: 5555 }) })) : null;
  ok("⭐⭐ a second acquire while the holder is live → REFUSED as held, the lock untouched", b?.ok === false && b?.code === "held" && existsSync(f) && readJ(f).token === a?.token, show(b));
  const msg = has("refusalMessage") ? L.refusalMessage(b, "t") : "";
  ok("⭐ the refusal names the running PID and its LOG, and says nothing was started", /4242/.test(msg) && /\/logs\/run\.log/.test(msg) && /already running/i.test(msg) && /nothing was started/i.test(msg), msg.split("\n")[0]);
  ok("  …no temp file left by the losing acquire", leftovers(dir).length === 0);
  ok("⭐ EPERM-style 'exists, not ours' counts as ALIVE (the fake says alive) — still held", b?.code === "held");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⭐⭐ STALE only when PROVEN dead; refused even then (no takeover)");
{
  const seed = (dir, over = {}) => { const s = fakeSys(); const r = L.acquireLock({ name: "t", dir, sys: s }); return { r, f: lockFile(dir, "t") }; };
  const cases = [
    ["another boot (boot_id differs)", { boot: "boot-2" }, /boot/i],
    ["no such process", { aliveOf: () => false }, /no such process/i],
    ["PID reused (alive, but a DIFFERENT start time)", { startOf: () => "2000" }, /reused|start time/i],
  ];
  for (const [label, sysOver, re] of cases) {
    if (!has("acquireLock")) { ok(`${label} → stale`, false); continue; }
    const dir = tmp(); const { r, f } = seed(dir);
    const c = attempt(() => L.classifyLock(readJ(f), fakeSys(sysOver)));
    ok(`${label} → classified STALE, with the proof`, c?.state === "stale" && re.test(c?.proof ?? ""), show(c));
    const again = attempt(() => L.acquireLock({ name: "t", dir, sys: fakeSys({ pid: 7, ...sysOver }) }));
    ok(`  …acquire REFUSES (code stale) and the lock is NOT removed or replaced`, again?.ok === false && again?.code === "stale" && readJ(f).token === r.token, show(again));
  }
  const dir = tmp(); if (has("acquireLock")) L.acquireLock({ name: "t", dir, sys: fakeSys() });
  const f = lockFile(dir, "t");
  const u = (o) => (has("classifyLock") && existsSync(f) ? attempt(() => L.classifyLock(readJ(f), fakeSys(o))) : null);
  ok("⭐ held on ANOTHER HOST → unknown, never stale", u({ host: "hostB" })?.state === "unknown", show(u({ host: "hostB" })));
  ok("⭐ boot_id unreadable → unknown", u({ bootThrows: true })?.state === "unknown");
  ok("⭐ /proc start time unreadable → unknown", u({ startThrows: true })?.state === "unknown");
  ok("⭐ liveness itself unreadable → unknown", u({ aliveThrows: true })?.state === "unknown");
  const unk = has("acquireLock") ? attempt(() => L.acquireLock({ name: "t", dir, sys: fakeSys({ host: "hostB", pid: 9 }) })) : null;
  ok("⭐ acquire on an UNKNOWN lock → refused (never proceeds), lock untouched", unk?.ok === false && unk?.code === "unreadable" && existsSync(f), show(unk));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐⭐ an UNREADABLE lock never lets anything proceed, and is never touched");
{
  const variants = [
    ["an empty file", (f) => writeFileSync(f, "")],
    ["bad JSON", (f) => writeFileSync(f, "{not json")],
    ["missing fields", (f) => writeFileSync(f, JSON.stringify({ schema: "tikpema-lock/1", pid: 1 }))],
    ["a directory at the lock path", (f) => mkdirSync(f)],
  ];
  for (const [label, make] of variants) {
    const dir = tmp(); const f = lockFile(dir, "t"); make(f);
    const before = statSync(f).isDirectory() ? "dir" : readFileSync(f, "utf8");
    const r = has("acquireLock") ? attempt(() => L.acquireLock({ name: "t", dir, sys: fakeSys() })) : null;
    const after = existsSync(f) ? (statSync(f).isDirectory() ? "dir" : readFileSync(f, "utf8")) : "GONE";
    ok(`${label} → refused as unreadable, untouched`, r?.ok === false && r?.code === "unreadable" && after === before, show(r));
    // The refusal must name WHY (the read or the parse failed) — not fall through to some other path that happens to refuse.
    ok(`  …and the refusal names the actual failure (read / JSON / fields), not a fallback`, /cannot be read|not JSON|empty|missing or has malformed/.test(r?.why ?? ""), r?.why);
    const br = has("breakStaleLock") ? attempt(() => L.breakStaleLock({ name: "t", dir, sys: fakeSys() })) : null;
    ok(`  …and --break-stale-lock refuses it too (unreadable is not proven stale)`, br?.ok === false && existsSync(f), show(br));
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — release only your own; break only a PROVEN-stale lock, by RENAME");
{
  const dir = tmp(); const f = lockFile(dir, "t");
  const a = has("acquireLock") ? L.acquireLock({ name: "t", dir, sys: fakeSys() }) : {};
  const wrong = has("releaseLock") ? attempt(() => L.releaseLock({ name: "t", dir, token: "someone-else" })) : null;
  ok("⭐⭐ release with ANOTHER run's token → nothing removed", wrong?.released === false && existsSync(f), show(wrong));
  const right = has("releaseLock") ? attempt(() => L.releaseLock({ name: "t", dir, token: a.token })) : null;
  ok("release with its own token → removed", right?.released === true && !existsSync(f), show(right));

  const d2 = tmp(); const f2 = lockFile(d2, "t");
  if (has("acquireLock")) L.acquireLock({ name: "t", dir: d2, sys: fakeSys() });
  const live = has("breakStaleLock") ? attempt(() => L.breakStaleLock({ name: "t", dir: d2, sys: fakeSys() })) : null;
  ok("⭐⭐ breaking a LIVE lock → refused, untouched", live?.ok === false && existsSync(f2), show(live));
  const dead = has("breakStaleLock") ? attempt(() => L.breakStaleLock({ name: "t", dir: d2, sys: fakeSys({ aliveOf: () => false }) })) : null;
  const staleFiles = readdirSync(d2).filter((x) => /^t\.lock\.stale-/.test(x));
  ok("⭐⭐ breaking a PROVEN-stale lock → RENAMED to t.lock.stale-<ts> (evidence kept), not deleted", dead?.ok === true && !existsSync(f2) && staleFiles.length === 1, show({ dead, staleFiles }));
  ok("  …the kept file is the original lock, intact", staleFiles.length === 1 && readJ(join(d2, staleFiles[0])).pid === 4242);
  const after = has("acquireLock") ? attempt(() => L.acquireLock({ name: "t", dir: d2, sys: fakeSys({ pid: 99 }) })) : null;
  ok("  …and a normal acquire then wins", after?.ok === true, show(after));

  const d3 = tmp(); const a3 = has("acquireLock") ? L.acquireLock({ name: "t", dir: d3, sys: fakeSys() }) : {};
  const held = (tok, o) => (has("lockHeldBy") ? attempt(() => L.lockHeldBy({ name: "t", dir: d3, token: tok, sys: fakeSys(o) })) : null);
  ok("lockHeldBy: its own token + a live holder → true", held(a3.token) === true);
  ok("lockHeldBy: another token → false", held("nope") === false);
  ok("lockHeldBy: its token but the holder is dead → false", held(a3.token, { aliveOf: () => false }) === false);
  ok("lockHeldBy: no lock → false", (has("lockHeldBy") ? attempt(() => L.lockHeldBy({ name: "none", dir: d3, token: "x", sys: fakeSys() })) : null) === false);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — REAL processes: live, dead, reused, and a real race");
{
  const real = L.realSys;
  ok("realSys is exported", real && typeof real.startTime === "function");
  if (real) {
    const me = attempt(() => real.startTime(process.pid));
    ok("realSys reads this process's /proc start time", typeof me === "string" && /^\d+$/.test(me), show(me));
    const bid = attempt(() => real.bootId());
    ok("realSys reads the boot id", typeof bid === "string" && bid.length > 8, show(bid));
    const dir = tmp();
    const child = run(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { stdio: "ignore" });
    await sleep(150);
    const lk = { schema: "tikpema-lock/1", name: "t", pid: child.pid, startTime: real.startTime(child.pid), bootId: real.bootId(), host: real.hostname(),
      token: "x", startedAt: new Date().toISOString(), log: "/l", cmdline: "c" };
    ok("⭐ a real LIVE child → live", L.classifyLock(lk, real)?.state === "live", show(L.classifyLock(lk, real)));
    ok("⭐ the same PID with a WRONG start time → stale (reused)", /reused|start time/i.test(L.classifyLock({ ...lk, startTime: "1" }, real)?.proof ?? ""), show(L.classifyLock({ ...lk, startTime: "1" }, real)));
    child.kill("SIGKILL"); await child.exited; await sleep(50);
    ok("⭐ the child KILLED → stale, no such process", /no such process/i.test(L.classifyLock(lk, real)?.proof ?? ""), show(L.classifyLock(lk, real)));
    ok("a different boot id → stale", L.classifyLock({ ...lk, bootId: "not-this-boot" }, real)?.state === "stale");

    // ⭐⭐ THE RACE. Processes spawn tens of ms apart and an acquire takes microseconds, so without a barrier they never
    // overlap and a non-atomic check-then-write would pass. Each racer busy-waits to the SAME instant, then acquires.
    // 5 rounds × 12 racers: exactly one winner per round.
    const RL_PATH = new URL("./run-lock.mjs", import.meta.url).pathname;
    const rounds = [];
    for (let round = 0; round < 5; round++) {
      const rd = tmp(); const at = Date.now() + 1200;
      const script = `import(${JSON.stringify(RL_PATH)}).then((m)=>{while(Date.now()<${at}){}const r=m.acquireLock({name:"race",dir:${JSON.stringify(rd)}});console.log(JSON.stringify({ok:r.ok,code:r.code??null}));setTimeout(()=>{},600)})`;
      const kids = Array.from({ length: 12 }, () => run(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] }));
      const outs = await Promise.all(kids.map((k) => new Promise((res) => { let s = ""; k.stdout.on("data", (d) => (s += d)); k.exited.then(() => res(s.trim())); })));
      const parsed = outs.map((s) => { try { return JSON.parse(s); } catch { return { raw: s }; } });
      rounds.push({ winners: parsed.filter((p) => p.ok === true).length, refused: parsed.filter((p) => p.ok === false).length, left: leftovers(rd).length });
    }
    ok("⭐⭐ 5 rounds × 12 racers released at the same instant → EXACTLY ONE winner each round", rounds.every((r) => r.winners === 1 && r.refused === 11), show(rounds));
    ok("  …and no temp files left behind", rounds.every((r) => r.left === 0));
    // ⭐ THE MECHANISM, pinned: the lock file is created ONLY by link(tmp → lock), which fails with EEXIST. Nothing
    // writes or copies to the lock path directly (a check-then-write has a window a timing test may not hit).
    const rsrc = readFileSync(RL_PATH, "utf8");
    const acq = rsrc.slice(rsrc.indexOf("export function acquireLock"), rsrc.indexOf("export function releaseLock"));
    ok("⭐ acquireLock creates the lock only via linkSync(tmp, path) — no write/copy/exists-check on the lock path",
      /linkSync\(tmp, path\)/.test(acq) && !/writeFileSync\(path|copyFileSync|existsSync\(path|renameSync\(tmp, path/.test(acq));
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — the CLI wrapper: refuse, run, pass the exit code through, release");
{
  const RL = new URL("./run-lock.mjs", import.meta.url).pathname;
  const dir = tmp(); const env = { ...process.env, TIKPEMA_LOCK_DIR: dir };
  const marker = join(dir, "second-ran");
  const first = run(process.execPath, [RL, "--lock", "t", "--", process.execPath, "-e", "setTimeout(()=>{},2500)"], { env, stdio: ["ignore", "pipe", "pipe"] });
  for (let i = 0; i < 40 && !existsSync(lockFile(dir, "t")); i++) await sleep(50);
  ok("the first wrapper holds the lock while its command runs", existsSync(lockFile(dir, "t")) && readJ(lockFile(dir, "t")).pid === first.pid, show(existsSync(lockFile(dir, "t")) ? readJ(lockFile(dir, "t")) : null));
  const second = spawnSync(process.execPath, [RL, "--lock", "t", "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)},"x")`], { env, encoding: "utf8" });
  ok("⭐⭐ a second launch → exit 3, and its command NEVER ran", second.status === 3 && !existsSync(marker), `status=${second.status}`);
  ok("⭐ …stderr names the running PID and says nothing was started", new RegExp(String(first.pid)).test(second.stderr) && /already running/i.test(second.stderr) && /nothing was started/i.test(second.stderr), second.stderr.split("\n")[0]);
  const inner = spawnSync(process.execPath, [RL, "--assert-held", "--lock", "t"], { env, encoding: "utf8" });
  ok("⭐ --assert-held with NO token (a run outside the wrapper) → refused (exit 6)", inner.status === 6, `status=${inner.status} ${inner.stderr.trim().split("\n")[0]}`);
  await first.exited;
  ok("the first wrapper exits 0 and RELEASES the lock", (await first.exited) === 0 && !existsSync(lockFile(dir, "t")), `exit=${first.exitCode}`);

  const seven = spawnSync(process.execPath, [RL, "--lock", "t", "--", process.execPath, "-e", "process.exit(7)"], { env, encoding: "utf8" });
  ok("⭐ the command's exit code passes through (7), and the lock is released on failure", seven.status === 7 && !existsSync(lockFile(dir, "t")), `status=${seven.status}`);

  // Inside the wrapper: --assert-held and --reentrant see the token the wrapper exported.
  const nested = spawnSync(process.execPath, [RL, "--lock", "t", "--", process.execPath, RL, "--assert-held", "--lock", "t"], { env, encoding: "utf8" });
  ok("⭐ --assert-held INSIDE the wrapper → 0", nested.status === 0, `status=${nested.status} ${nested.stderr.trim().split("\n")[0]}`);
  const m2 = join(dir, "reentrant-ran");
  const re = spawnSync(process.execPath, [RL, "--lock", "t", "--", process.execPath, RL, "--lock", "t", "--reentrant", "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(m2)},"x")`], { env, encoding: "utf8" });
  ok("⭐ --reentrant inside the holder's own run → runs without re-acquiring", re.status === 0 && existsSync(m2), `status=${re.status} ${re.stderr.trim().split("\n")[0]}`);
  const hold = run(process.execPath, [RL, "--lock", "t", "--", process.execPath, "-e", "setTimeout(()=>{},2000)"], { env, stdio: "ignore" });
  for (let i = 0; i < 40 && !existsSync(lockFile(dir, "t")); i++) await sleep(50);
  const m3 = join(dir, "outsider-ran");
  const out = spawnSync(process.execPath, [RL, "--lock", "t", "--reentrant", "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(m3)},"x")`], { env, encoding: "utf8" });
  ok("⭐⭐ --reentrant WITHOUT the holder's token (a hand run during a deploy) → refused, exit 3, never ran", out.status === 3 && !existsSync(m3), `status=${out.status}`);
  hold.kill("SIGTERM"); await hold.exited;
  ok("⭐ SIGTERM to the wrapper → it releases the lock", !existsSync(lockFile(dir, "t")));

  // A stale lock via the CLI: refused without the flag; the flag renames it and runs.
  const sd = tmp(); const senv = { ...process.env, TIKPEMA_LOCK_DIR: sd };
  const dead = run(process.execPath, ["-e", "0"]); await dead.exited;
  writeFileSync(lockFile(sd, "t"), JSON.stringify({ schema: "tikpema-lock/1", name: "t", pid: dead.pid, startTime: "1", bootId: L.realSys?.bootId?.() ?? "x",
    host: L.realSys?.hostname?.() ?? "x", token: "old", startedAt: "2026-09-27T00:00:00Z", log: "/old.log", cmdline: "old" }));
  const m4 = join(sd, "ran");
  const noflag = spawnSync(process.execPath, [RL, "--lock", "t", "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(m4)},"x")`], { env: senv, encoding: "utf8" });
  ok("⭐⭐ a STALE lock without --break-stale-lock → exit 4, command not run, lock kept", noflag.status === 4 && !existsSync(m4) && existsSync(lockFile(sd, "t")), `status=${noflag.status} ${noflag.stderr.trim().split("\n")[0]}`);
  ok("  …and the refusal says how to break it", /--break-stale-lock/.test(noflag.stderr));
  const withflag = spawnSync(process.execPath, [RL, "--lock", "t", "--break-stale-lock", "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(m4)},"x")`], { env: senv, encoding: "utf8" });
  ok("⭐ with --break-stale-lock → the old lock is RENAMED (kept), the command runs, the new lock is released",
    withflag.status === 0 && existsSync(m4) && readdirSync(sd).some((x) => /^t\.lock\.stale-/.test(x)) && !existsSync(lockFile(sd, "t")), `status=${withflag.status}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — the wiring: the deploy scope shares `deploy`; escrow-reclaim --confirm has its own");
{
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const S = pkg.scripts;
  const WRAP = "node scripts/run-lock.mjs --lock deploy";
  ok("⭐⭐ deploy:prod IS the wrapper around deploy:prod:chain (the lock is taken before anything else)", S["deploy:prod"] === `${WRAP} -- npm run deploy:prod:chain`, S["deploy:prod"]);
  const steps = (S["deploy:prod:chain"] ?? "").split("&&").map((s) => s.trim());
  ok("⭐⭐ the chain's FIRST step asserts the lock is held (running the chain directly refuses)", steps[0] === "node scripts/run-lock.mjs --assert-held --lock deploy", steps[0]);
  ok("  …then gate:ledger, and stage:ledger stays LAST", steps[1] === "npm run gate:ledger" && steps.at(-1) === "npm run stage:ledger", `${steps[1]} … ${steps.at(-1)}`);
  ok("  …test:all is AFTER the lock (a doomed second launch costs nothing)", steps.indexOf("npm run test:all") > 0);
  for (const k of ["capture:window", "gate:deployloss", "stage:ledger", "sweep:deploys", "deploy:site", "deploy:site:prod"]) {
    ok(`⭐ ${k} runs under the deploy lock (--reentrant: inside the chain it runs; by hand it takes the lock)`, (S[k] ?? "").startsWith(`${WRAP} --reentrant -- `), S[k]);
  }
  // escrow-reclaim --confirm: its OWN lock, taken before anything else (it is run with `node` directly).
  const src = readFileSync("scripts/escrow-reclaim.mjs", "utf8");
  const main = src.slice(src.indexOf("if (import.meta.url === pathToFileURL("));
  const lockAt = main.search(/acquireLock\(\s*\{\s*name:\s*"escrow-reclaim"/), firstAwait = main.search(/\bawait\b/);
  ok("⭐ escrow-reclaim takes the \"escrow-reclaim\" lock BEFORE its first await (no network, no config read first)", lockAt > 0 && lockAt < firstAwait, `lock@${lockAt} await@${firstAwait}`);
  ok("  …only under --confirm (a dry run takes no lock)", /--confirm[\s\S]{0,200}acquireLock|acquireLock[\s\S]{0,40}CONFIRM/.test(main) || /const CONFIRM = process\.argv\.includes\("--confirm"\)/.test(main));
  const ed = tmp();
  if (has("acquireLock")) L.acquireLock({ name: "escrow-reclaim", dir: ed }); // held by THIS (live) process
  const er = spawnSync(process.execPath, ["scripts/escrow-reclaim.mjs", "--confirm"], { env: { ...process.env, TIKPEMA_LOCK_DIR: ed, ESCROW_RECLAIM_WALLET_ADDRESS: "" }, encoding: "utf8", timeout: 20000 });
  ok("⭐⭐ escrow-reclaim --confirm while another reclaim holds the lock → exit 3, names the holder, nothing else ran",
    er.status === 3 && new RegExp(String(process.pid)).test(er.stderr) && /already running/i.test(er.stderr) && !/REFUSED: ESCROW/.test(er.stderr), `status=${er.status} ${er.stderr.trim().split("\n")[0]}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("8 — ⭐⭐ SUCCESS IS SAID, not inferred: a line on acquire and on release (T, 2026-09-28)");
// The deploy 6abac4ec check could only INFER the lock ran (the assert passed, no refusal, the lock dir emptied): the
// wrapper was silent on success. Silence must not have to mean success.
{
  const RL = new URL("./run-lock.mjs", import.meta.url).pathname;
  const hasMsg = has("acquiredMessage") && has("releasedMessage");
  ok("  (the messages are exported, pure)", hasMsg);
  if (hasMsg) {
    const lk = { pid: 4242, log: "/logs/run.log", startedAt: "2026-09-28T19:33:40.000Z" };
    const a = L.acquiredMessage(lk, "deploy");
    ok("acquire line names the LOCK, the PID and the LOG", /deploy/.test(a) && /\b4242\b/.test(a) && a.includes("/logs/run.log") && /acquired/i.test(a), a);
    const r = L.releasedMessage(lk, "deploy", { released: true }, 0);
    ok("release line names the LOCK, the PID, the LOG and the command's exit", /deploy/.test(r) && /\b4242\b/.test(r) && r.includes("/logs/run.log") && /released/i.test(r) && /exit(ed)?\D*0\b/i.test(r), r);
    // startedAt is GIVEN here, so only the LOG can supply the "(unknown)" (a mutation survived when it was not).
    const u = L.acquiredMessage({ pid: 1, log: null, startedAt: "2026-09-28T00:00:00.000Z" }, "deploy");
    ok("an unknown log is SAID ('log (unknown)'), never left blank", /log \(unknown\)/.test(u), u);
    const nr = L.releasedMessage(lk, "deploy", { released: false, why: "the lock is held by another run (PID 9); not touched" }, 0);
    ok("⭐ a FAILED release says NOT released + why — never 'released'", /NOT released/.test(nr) && /another run/.test(nr) && !/lock released/i.test(nr), nr);
  }

  // The real wrapper, stdout redirected to a file (as `nohup … > deploy-logs/X.log` does): the log is that file.
  const dir = tmp(); const env = { ...process.env, TIKPEMA_LOCK_DIR: dir };
  const logf = join(dir, "run.log"); const fd = openSync(logf, "w");
  const w = spawnSync(process.execPath, [RL, "--lock", "t", "--", process.execPath, "-e", "console.error('CHILD-RAN')"], { env, stdio: ["ignore", fd, "pipe"], encoding: "utf8" });
  closeSync(fd);
  const err = w.stderr ?? "";
  const ia = err.search(/acquired/i), ic = err.indexOf("CHILD-RAN"), ir = err.search(/lock released/i);
  ok("⭐⭐ the real wrapper prints the acquire line BEFORE the command and the release line AFTER it", w.status === 0 && ia >= 0 && ic > ia && ir > ic, JSON.stringify(err).slice(0, 220));
  // The whole LINE, not a slice from the word "acquired" (which would cut the lock name off in front of it).
  const lineA = err.split("\n").find((x) => /acquired/i.test(x)) ?? "", lineR = err.split("\n").find((x) => /lock released/i.test(x)) ?? "";
  ok("  …the acquire line names the lock and the log the wrapper's stdout goes to", /(^|\s)t:/.test(lineA) && lineA.includes(logf), lineA);
  const pidA = lineA.match(/PID (\d+)/)?.[1], pidR = lineR.match(/PID (\d+)/)?.[1];
  ok("  …and the SAME PID on both lines (the holder's)", !!pidA && pidA === pidR, `${pidA} / ${pidR}`);
  ok("  …the release line carries the command's exit", /exit(ed)?\D*0\b/i.test(err.slice(ir)));
  // Exactly ONE release line of ANY kind: the child's exit and the process 'exit' hook both call release(), and only
  // the first may speak (a mutation that dropped the guard printed a second "NOT released" line).
  ok("⭐ exactly ONE release line, and no 'NOT released' on a normal run", (err.match(/released/gi) ?? []).length === 1 && !/NOT released/.test(err), JSON.stringify(err).slice(0, 220));
  const seven = spawnSync(process.execPath, [RL, "--lock", "t", "--", process.execPath, "-e", "process.exit(7)"], { env, encoding: "utf8" });
  ok("  a failing command → still ONE release line, naming exit 7 (and 7 passes through)", seven.status === 7 && (seven.stderr.match(/released/gi) ?? []).length === 1 && /lock released/i.test(seven.stderr) && /exit(ed)?\D*7\b/i.test(seven.stderr), seven.stderr.trim().split("\n").pop());

  // Only a run that ACQUIRED may say so.
  const re = spawnSync(process.execPath, [RL, "--lock", "t", "--", process.execPath, RL, "--lock", "t", "--reentrant", "--", process.execPath, "-e", "0"], { env, encoding: "utf8" });
  ok("⭐ a nested --reentrant run does NOT print a second acquire/release (it acquired nothing)",
    re.status === 0 && (re.stderr.match(/acquired/gi) ?? []).length === 1 && (re.stderr.match(/lock released/gi) ?? []).length === 1, JSON.stringify(re.stderr).slice(0, 200));
  const hold = run(process.execPath, [RL, "--lock", "t", "--", process.execPath, "-e", "setTimeout(()=>{},2000)"], { env, stdio: "ignore" });
  for (let i = 0; i < 40 && !existsSync(lockFile(dir, "t")); i++) await sleep(50);
  const refused = spawnSync(process.execPath, [RL, "--lock", "t", "--", process.execPath, "-e", "0"], { env, encoding: "utf8" });
  ok("⭐⭐ a REFUSED launch prints no acquire and no release line", refused.status === 3 && !/acquired/i.test(refused.stderr) && !/released/i.test(refused.stderr), refused.stderr.split("\n")[0]);
  hold.kill("SIGTERM"); await hold.exited;
  const asrt = spawnSync(process.execPath, [RL, "--lock", "t", "--", process.execPath, RL, "--assert-held", "--lock", "t"], { env, encoding: "utf8" });
  ok("  --assert-held adds no line of its own (one acquire, one release)", asrt.status === 0 && (asrt.stderr.match(/acquired/gi) ?? []).length === 1, JSON.stringify(asrt.stderr).slice(0, 160));

  // A release that FAILS is said, not swallowed: the command removes the lock before exiting.
  const gone = spawnSync(process.execPath, [RL, "--lock", "t", "--", process.execPath, "-e", `require("fs").unlinkSync(${JSON.stringify(lockFile(dir, "t"))})`], { env, encoding: "utf8" });
  ok("⭐⭐ the lock vanished mid-run → 'NOT released' with the reason, never 'lock released'", /NOT released/.test(gone.stderr) && !/lock released/i.test(gone.stderr), JSON.stringify(gone.stderr).slice(0, 200));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
