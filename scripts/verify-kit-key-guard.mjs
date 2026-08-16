// verify-kit-key-guard.mjs — the spike credential guard, exercised through REAL subprocesses.
//
// ⭐ WHY SUBPROCESSES: `requireKitKey()` refuses by calling `process.exit(2)`. Testing that in-process
// means stubbing `process.exit`, which tests a stub rather than the refusal. Each case below runs a
// real `node -e` with a real environment and reads the real exit code — the thing that actually
// happens when someone runs a spike.
//
// 🚨 THE PROPERTY THAT MATTERS MOST IS THE LAST ONE: the guard must never PRINT THE KEY. A guard that
// refuses correctly and then echoes the credential into a terminal (and a scrollback, and possibly a
// CI log) has moved the leak rather than closed it.
//
//   node scripts/spikes/verify-kit-key-guard.mjs

import { execFileSync } from "node:child_process";

const GOOD = "KIT_KEY:abc123.id-x:s3cr3t_value-ZZ";
let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };

/** Run the guard in a child with a given env; return {code, out}. Never throws on non-zero. */
function run(kitKey) {
  const env = { ...process.env };
  delete env.KIT_KEY;
  if (kitKey !== undefined) env.KIT_KEY = kitKey;
  try {
    const out = execFileSync(process.execPath, [
      "--input-type=module", "-e",
      `import {requireKitKey} from "./scripts/_kit-key.mjs"; ` +
      `const k = requireKitKey(); console.log("ACCEPTED:" + (k === process.env.KIT_KEY));`,
    ], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
    return { code: 0, out };
  } catch (e) {
    // ⚠️ A TIMEOUT MUST NOT READ AS A CLEAN EXIT. `err.code` is null when the child was KILLED, and
    // `?? 0` would render that as success — the exact fail-open this repo hit in capture:window.
    if (e?.killed || e?.signal) return { code: "TIMEOUT", out: String(e?.stdout ?? "") + String(e?.stderr ?? "") };
    return { code: typeof e?.status === "number" ? e.status : "NO-STATUS",
             out: String(e?.stdout ?? "") + String(e?.stderr ?? "") };
  }
}

console.log("\nverify-kit-key-guard — the spike credential guard\n");

// ── ACCEPT: only the verbatim form ───────────────────────────────────────────────────────────────
const ok = run(GOOD);
check("⭐ a VERBATIM KIT_KEY:<id>:<secret> is accepted", ok.code === 0, `exit ${ok.code}`);
check("⭐ …and is returned unchanged (not trimmed, re-prefixed or rewritten)",
  /ACCEPTED:true/.test(ok.out));

// ── REFUSE: every way it can be wrong-while-looking-present ──────────────────────────────────────
const cases = [
  ["🚨 unset", undefined, /is not set/],
  ["⚠️ empty string", "", /is not set/],
  ["⚠️ whitespace only", "   ", /is not set/],
  ["🚨 Netlify's \"No value set\" message (STDOUT at exit 0)", "No value set for KIT_KEY", /No value set/i],
  ["🚨 PREFIX-STRIPPED (the sed trap / B1 v2 401)", "abc123.id-x:s3cr3t_value-ZZ", /PREFIX-STRIPPED/],
  ["⚠️ double-prefixed", "KIT_KEY:KIT_KEY:abc:def", /malformed/],
  ["⚠️ prefix only, no body", "KIT_KEY:", /malformed/],
  ["⚠️ one segment (no secret half)", "KIT_KEY:abc123", /malformed/],
  ["⚠️ arbitrary junk", "not-a-key-at-all", /malformed/],
];
for (const [label, val, expect] of cases) {
  const r = run(val);
  check(`${label} → refused with exit 2`, r.code === 2, `exit ${r.code}`);
  check(`   …and names the reason`, expect.test(r.out));
}

// ── the instructions are actionable, and steer AWAY from the leaky shapes ────────────────────────
const msg = run(undefined).out;
check("⭐ the refusal teaches the history-safe recipe (`read -rs`)", /read -rs KIT_KEY/.test(msg));
check("🚨 …and explicitly warns against KEY=… in argv / shell history",
  /shell history/.test(msg) && /cmdline/.test(msg));
check("🚨 …and explicitly forbids sourcing from Netlify production",
  /Netlify production/.test(msg));
check("⚠️ …and forbids a file on disk (a named env file is .env's problem again)",
  /\.env or any other file/.test(msg));
check("⭐ …and says where a key legitimately comes from",
  /console\.circle\.com\/api-keys/.test(msg));

// ── 🚨 THE GUARD MUST NOT LEAK THE VALUE IT REFUSED ──────────────────────────────────────────────
const leaky = run("KIT_KEY:LEAKCANARY:should-never-be-printed-XYZ");
check("⭐ a well-formed key is accepted without being echoed",
  leaky.code === 0 && !/LEAKCANARY/.test(leaky.out), `exit ${leaky.code}`);
const badLeak = run("LEAKCANARY:should-never-be-printed-XYZ");
check("🚨🚨 a REFUSED key is never printed — only its shape",
  badLeak.code === 2 && !/LEAKCANARY/.test(badLeak.out) && !/should-never-be-printed/.test(badLeak.out));
check("⚠️ …while still reporting enough to act on (length + prefix presence, or the named trap)",
  /PREFIX-STRIPPED/.test(badLeak.out));

// ── isWellFormedKitKey: the non-throwing predicate the SKIP path depends on ──────────────────────
// 🚨 IT MUST AGREE WITH requireKitKey ON EVERY INPUT. If the predicate accepted something the guard
// refuses, a skipping script would take its LIVE branch on a key the guard considers unusable — the
// skip counter never increments, and "skipped" silently reads as "passed".
const { isWellFormedKitKey } = await import("../scripts/_kit-key.mjs");
const AGREE = [GOOD, "", "   ", "No value set for KIT_KEY", "abc123.id-x:s3cr3t",
               "KIT_KEY:", "KIT_KEY:abc123", "not-a-key-at-all", "KIT_KEY:KIT_KEY:abc:def"];
let agreed = 0;
for (const v of AGREE) {
  const predicate = isWellFormedKitKey(v);
  const guard = run(v).code === 0;
  if (predicate === guard) agreed++;
  else console.log(`     ↳ DISAGREE on shape: predicate=${predicate} guard=${guard}`);
}
check("⭐⭐ isWellFormedKitKey agrees with requireKitKey on every input",
  agreed === AGREE.length, `${agreed}/${AGREE.length}`);
check("⚠️ …and it reads process.env by default (so a bare call needs no argument)",
  typeof isWellFormedKitKey() === "boolean");
check("⭐ the predicate never throws, even on undefined", (() => {
  try { isWellFormedKitKey(undefined); isWellFormedKitKey(null); return true; } catch { return false; }
})());

// ── the guard reaches for nothing ────────────────────────────────────────────────────────────────
// 🚨 STRIP COMMENTS BEFORE ASSERTING. The first version of this check matched the guard's own PROSE
// — it documents the `netlify env:get` trap, so a raw source regex flagged the file for a string
// that is a warning ABOUT the thing, not a use OF it. That is the repo's own recorded blind-spot
// class (assert-on-rendered-output-not-source-regex): the property here is about CODE, so the
// comments have to go before the question is asked.
const raw = await import("node:fs").then((fs) => fs.readFileSync("scripts/_kit-key.mjs", "utf8"));
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
check("⚠️ the comment-stripper actually removed the prose (guards the guard's own test)",
  /netlify env:get/.test(raw) && !/netlify env:get/.test(code));
check("⭐⭐ the guard itself never invokes netlify, spawns, or fetches — it only READS the env",
  !/child_process|execFile|spawnSync|\bfetch\(|netlify env:get/.test(code));
check("⭐ …and the only env var it touches is KIT_KEY",
  (code.match(/process\.env\[?[A-Za-z_"'.]*/g) || []).every((m) => /process\.env\[?$|KIT_KEY_VAR/.test(m) || m === "process.env"));

console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
