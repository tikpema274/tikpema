// verify-error-honesty.tsx — A FAILURE MESSAGE MUST NOT NARRATE A SERVER RESPONSE THAT NEVER CAME.
//
//   npx tsx scripts/verify-error-honesty.tsx      (also: npm run test:errorhonesty)
//
// ═══ 🚨 THE INCIDENT ════════════════════════════════════════════════════════════════════════════
// 2026-08-23. A Send threw a value with no `message`. `SendPanel` rendered `e?.message || "Send
// failed"` and the user saw exactly:
//
//     Send failed
//
// The server had NOT failed the send. `agent-send` was never invoked — nor was `auth-challenge`,
// `auth-verify`, `agents` or `my-wallet` for thirty minutes. Nothing left the browser. The sentence
// asserted a server verdict that did not exist, and an hour of diagnosis ran against it.
//
// ⭐ SAME RULE AS verify-activity-fallback: raw looks like a gap, a plausible label looks like a
// fact, and the second is worse. This suite is that rule applied to the error slot instead of the
// activity row.
//
// ⚠️ BOTH DIRECTIONS, or the fix is worthless: a REAL message must survive byte-identical. A
// "fix" that warned on everything would pass every presence check below and destroy every useful
// error in the app.
import { describeError } from "../src/lib/describeError";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
};

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  ERROR HONESTY — no verdict we did not observe                      ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

console.log("\n── a REAL message survives untouched (the load-bearing direction) ──");
{
  check("a server refusal passes through verbatim",
    describeError(new Error("exceeds per-transaction limit of 10 USDC")) === "exceeds per-transaction limit of 10 USDC");
  check("a network failure passes through verbatim",
    describeError(new TypeError("Failed to fetch")) === "Failed to fetch");
  check("⚠️ it does NOT warn on an error that HAS a message",
    !/unknown error/.test(describeError(new Error("Connect a wallet first"))));
  check("surrounding whitespace is trimmed, not treated as a message",
    describeError(new Error("  spaced  ")) === "spaced");
}

console.log("\n── NO message: name the raw thing, never invent a verdict ──────────");
{
  const cases: Array<[string, unknown, string]> = [
    ["an Error with an empty message", new Error(""), "Error"],
    ["a TypeError with no message", new TypeError(), "TypeError"],
    ["a DOMException-shaped throw", { name: "NotAllowedError" }, "NotAllowedError"],
    ["a thrown plain object", {}, "object"],
    ["a thrown string", "boom", "string"],
    ["a thrown null", null, "null"],
    ["a thrown undefined", undefined, "undefined"],
  ];
  for (const [label, thrown, expectedName] of cases) {
    const t = describeError(thrown);
    check(`${label} → names it "${expectedName}"`, t.includes(`(${expectedName})`), t.slice(0, 60));
  }
}

console.log("\n── 🚨 THE ASSERTION THE INCIDENT IS ABOUT ──────────────────────────");
{
  // The literal 2026-08-23 shape: something threw with no message on the Send path.
  const t = describeError(new TypeError());
  check("🚨 it does NOT say 'Send failed'", !/send failed/i.test(t), t);
  check("🚨 it does not assert ANY action failed", !/\b(failed|rejected|refused|denied)\b/i.test(t), t);
  check("⭐ it says a reason was not reported", /no reason was reported/i.test(t));
  check("⭐⭐ it states the thing we actually could not determine",
    /cannot tell whether this reached the server/i.test(t));
  check("it is marked as a gap, not prose", t.startsWith("⚠️"));
}

// ═══ ⭐ THE CALL SITES — A GUARD ON STRUCTURE, NOT ON A WHOLE-FILE REGEX ═════════════════════
// ⚠️ Three assertions in this repo have gone red on their own explanatory COMMENTS, and each time
// the tempting fix was to edit the code to satisfy the guard. `describeError.ts` documents the
// defect by quoting it, so a naive grep matches the very file that fixes it. Comments are stripped
// first — the property is about executable code, so the check must be too.
console.log("\n── no thrown-value fallback survives in shipped code ───────────────");
{
  const { readFileSync, readdirSync, statSync } = await import("fs");
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
    const p = `${d}/${f}`;
    return statSync(p).isDirectory() ? walk(p) : (/\.tsx?$/.test(p) ? [p] : []);
  });
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const OFFENDER = /\be\??\.message\s*\|\|\s*["`]/;
  const bad = walk("src").filter((f) => OFFENDER.test(stripComments(readFileSync(f, "utf8"))));
  check("⭐ zero `e?.message || \"…\"` fallbacks remain in executable code",
    bad.length === 0, bad.length ? bad.join(", ") : `${walk("src").length} files scanned`);
  // ⚠️ A guard that scans nothing passes. Prove it actually reads the files.
  const scanned = walk("src").length;
  check("⚠️ the guard actually scanned files (a zero-file scan trivially passes)", scanned > 20, `${scanned} files`);
  // ⭐ And prove the pattern it hunts is real, by running it against the shape it must catch.
  check("⭐ the pattern DOES match the defect it is looking for",
    OFFENDER.test(stripComments('  setSendError(e?.message || "Send failed");')));
  check("…and comment-stripping does not blind it to real code",
    !OFFENDER.test(stripComments('// setSendError(e?.message || "Send failed");')));
}

console.log("\n════════════════════════════════════════════════════════════════════════");
console.log(`${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log("⭐ A known reason is shown; an unknown one is named as unknown.\n");
