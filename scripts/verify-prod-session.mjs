// verify-prod-session.mjs — the prod-probe credential guard, exercised through REAL subprocesses.
//
// ⭐ WHY SUBPROCESSES: the guard refuses via `process.exit(2)`. Stubbing `process.exit` would test the
// stub. Each case runs a real `node -e` with a real environment and reads the real exit code.
//
// 🚨 THE CENTRAL CASE IS THE DEV-SECRET REFUSAL. That single comparison is what separates "your token
// is wrong" from "the endpoint is broken" — the confusion that cost a whole session (PROGRESS.md:7511)
// and the reason this guard exists at all. It is tested against a FIXTURE .env, never against the real
// one, so the suite neither reads nor depends on the developer's actual secret.
//
//   node scripts/verify-prod-session.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEV = "dev-secret-0123456789abcdef-NOT-PROD";
const PROD = "prod-secret-fedcba9876543210-DIFFERENT";

const dir = mkdtempSync(join(tmpdir(), "prodsess-"));
const envFile = join(dir, ".env");
writeFileSync(envFile, `FOO=bar\nSESSION_SECRET=${DEV}\nBAZ=qux\n`);
const emptyEnvFile = join(dir, "empty.env");
writeFileSync(emptyEnvFile, `FOO=bar\n`);

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };

function run(secret, envPath = envFile) {
  const env = { ...process.env };
  delete env.SESSION_SECRET;
  if (secret !== undefined) env.SESSION_SECRET = secret;
  try {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e",
      `import {requireProdSessionSecret} from "./scripts/_prod-session.mjs";` +
      `const s = requireProdSessionSecret({envFile: ${JSON.stringify(envPath)}});` +
      `console.log("ACCEPTED:" + (s === process.env.SESSION_SECRET.trim()));`,
    ], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
    return { code: 0, out };
  } catch (e) {
    // ⚠️ A killed child reports code null; `?? 0` would render a timeout as success.
    if (e?.killed || e?.signal) return { code: "TIMEOUT", out: String(e?.stdout ?? "") + String(e?.stderr ?? "") };
    return { code: typeof e?.status === "number" ? e.status : "NO-STATUS",
             out: String(e?.stdout ?? "") + String(e?.stderr ?? "") };
  }
}

console.log("\nverify-prod-session — the authenticated-prod-probe credential guard\n");

// ── accept ──────────────────────────────────────────────────────────────────────────────────────
const ok = run(PROD);
check("⭐ a distinct, well-formed secret is accepted", ok.code === 0, `exit ${ok.code}`);
check("⭐ …and returned unchanged", /ACCEPTED:true/.test(ok.out));
check("⚠️ …and surrounding whitespace is tolerated, not silently a different secret",
  run(`  ${PROD}  `).code === 0);

// ── 🚨 the central case ─────────────────────────────────────────────────────────────────────────
const dev = run(DEV);
check("🚨🚨 the DEV secret from .env is REFUSED before any request is sent", dev.code === 2, `exit ${dev.code}`);
check("🚨 …and the refusal explains the 401-looks-like-a-bug trap, not just 'wrong value'",
  /indistinguishable from an endpoint bug/.test(dev.out));
check("⭐ …and it is matched from the .env FILE, not from process.env (which never holds it)",
  /DEV value from/.test(dev.out));
check("⚠️ …while the same secret is ACCEPTED when .env has no SESSION_SECRET to conflict with",
  run(DEV, emptyEnvFile).code === 0, "the check is a comparison, not a blocklist");

// ── the empty-var trap, distinct from unset ─────────────────────────────────────────────────────
const empty = run("");
check("🚨 an EXPORTED EMPTY secret is refused", empty.code === 2, `exit ${empty.code}`);
check("🚨 …and is diagnosed as the `| tail -1` trap, not merely as 'not set'",
  /EMPTY/.test(empty.out) && /tail -1/.test(empty.out));
check("⚠️ …and it is a DIFFERENT message from unset — conflating them hides the trap",
  !/is not set/.test(empty.out) && /is not set/.test(run(undefined).out));
check("⚠️ whitespace-only is treated as empty, not as a 33-char secret",
  /EMPTY/.test(run("    ").out));

// ── the other locally-detectable wrongness ──────────────────────────────────────────────────────
const noval = run("No value set for SESSION_SECRET");
check("🚨 Netlify's \"No value set\" message is refused", noval.code === 2 && /No value set/i.test(noval.out));
const short = run("tooshort");
check("⚠️ a secret below _auth.mjs's 16-char floor is refused", short.code === 2 && /too short/.test(short.out));

// ── 🚨 no leakage ───────────────────────────────────────────────────────────────────────────────
const canary = "LEAKCANARY-prod-secret-never-print-me";
const leak = run(canary);
check("🚨🚨 an ACCEPTED secret is never echoed", leak.code === 0 && !/LEAKCANARY/.test(leak.out));
const leakDev = run(DEV);
check("🚨🚨 a REFUSED secret is never echoed either", !new RegExp(DEV).test(leakDev.out));

// ── the guard reaches for nothing ───────────────────────────────────────────────────────────────
// Comments stripped first: the module documents the `netlify env:get` recipe in prose, and a raw
// source regex would flag the warning as if it were a use.
const raw = await import("node:fs").then((fs) => fs.readFileSync("scripts/_prod-session.mjs", "utf8"));
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
check("⚠️ the comment-stripper actually stripped (guards this check's own premise)",
  /PROGRESS\.md/.test(raw) && !/PROGRESS\.md/.test(code));
check("⭐⭐ the guard never spawns, fetches, or shells out — it reads env and one file",
  !/child_process|execFile|spawnSync|\bfetch\(/.test(code));

// ── the token is minted by the REAL auth module, not a reimplementation ─────────────────────────
// ⭐ If this ever became a hand-rolled HMAC, every probe would keep passing while proving only that
// the probe agrees with itself.
check("⭐⭐ mintProdToken imports the deployed _auth.mjs rather than reimplementing the signature",
  /_auth\.mjs/.test(code) && /issueSession/.test(code));

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
