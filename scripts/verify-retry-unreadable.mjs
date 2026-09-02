// verify-retry-unreadable.mjs — ⛔ AN EXHAUSTED RETRY MUST RETURN SOMETHING UNMISTAKABLE.
//
//   node scripts/verify-retry-unreadable.mjs   (also: npm run test:retryunreadable)
//
// ═══ 🚨 THE DEFECT ════════════════════════════════════════════════════════
// `withRetry(fn, fallback)` let each call site choose what an exhausted read returns, and two of
// seven chose a value that IS a valid reading:
//   getBytecode → "0x"  = "this address holds no code"  → "it is not a deployed contract"
//   getReceipt  → null  = "this tx is not mined"        → "your shares are still in the vault"
// Three (or six) failed RPC calls became a confident statement about the chain, and about where a
// user's funds are.
//
// ⭐⭐ THE FIX IS THE SHAPE, NOT THE TWO ARGUMENTS. Correcting those two would leave the NEXT call
// site free to pass 0, "" or false. The parameter is GONE: an exhausted retry returns UNREADABLE, a
// Symbol that is not falsy, not a bigint, not an array, equal to nothing, and throws on arithmetic.
// ⛔ So this suite does NOT check the two fixed sites. It checks that the unsafe form is UNSAYABLE.

import { readFileSync } from "node:fs";
import { UNREADABLE, unread } from "../shared/onchain-facts/index.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } return !!c; };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`);
const src = readFileSync(new URL("../netlify/functions/_vault.mjs", import.meta.url), "utf8");
// ⛔ TRAILING comments stripped too, not just whole-line ones. A trailing `// …, so try hard`
// contains a COMMA, which split an argument list and produced a false positive — the checker
// reporting a defect that was punctuation. Strip what you are not parsing.
const noComments = src
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^\s*\/\/.*$/gm, " ")
  .replace(/([^:"'`])\/\/[^\n]*/g, "$1");

section("1 — ⛔ THE UNSAFE FORM IS UNSAYABLE: withRetry takes NO fallback");
{
  const def = /async function withRetry\(([^)]*)\)/.exec(noComments);
  check("⭐ withRetry is declared", !!def, def?.[1]);
  check("⛔ …and its signature has no `fallback` parameter", !!def && !/fallback/.test(def[1]), def?.[1]);
  check("🚨 …and it returns UNREADABLE when the attempts run out",
    /return UNREADABLE;\s*\}/.test(noComments.slice(noComments.indexOf("async function withRetry"))));
}

section("2 — 🚨 NO CALL SITE PASSES A SECOND ARGUMENT THAT ISN'T A COUNT");
{
  // ⭐ Derived by scanning EVERY call, not by listing the seven known ones — a new site must be
  // covered the moment it exists, which is the whole reason the parameter was removed.
  const bad = [];
  // ⭐ The DEFINITION is not a call site. Matching `withRetry(` blind caught `async function
  // withRetry(fn, tries = 3)` and reported its own parameter as a fallback.
  const re = /(?<!function )withRetry\(/g; let m;
  while ((m = re.exec(noComments))) {
    let i = m.index + m[0].length, depth = 1, args = "";
    while (i < noComments.length && depth > 0) {
      const c = noComments[i];
      if (c === "(") depth++; else if (c === ")") depth--;
      if (depth > 0) args += c;
      i++;
    }
    // split on top-level commas
    const parts = []; let d = 0, last = 0;
    for (let j = 0; j < args.length; j++) {
      const c = args[j];
      if ("([{".includes(c)) d++; else if (")]}".includes(c)) d--;
      else if (c === "," && d === 0) { parts.push(args.slice(last, j)); last = j + 1; }
    }
    parts.push(args.slice(last));
    const extra = parts.slice(1).map((x) => x.trim()).filter(Boolean);
    // The only legal second argument is a retry COUNT: a bare integer literal.
    for (const e of extra) if (!/^\d+$/.test(e.split("//")[0].trim())) {
      bad.push(`${noComments.slice(0, m.index).split("\n").length}: ${e.slice(0, 40)}`);
    }
  }
  check("⛔ every withRetry call passes only a retry COUNT, never a fallback value",
    bad.length === 0, bad.join(" · ") || "all call sites clean");
}

section("3 — ⭐ UNREADABLE CANNOT BE MISTAKEN FOR ANY READING IT REPLACES");
check("not falsy — `!x` does not fire", !!UNREADABLE);
check("not a bigint — a balance check rejects it", typeof UNREADABLE !== "bigint");
check("not an array — a multicall check rejects it", !Array.isArray(UNREADABLE));
check('not the string "0x" — a bytecode check rejects it', UNREADABLE !== "0x");
check("not null — a receipt check rejects it", UNREADABLE !== null);
check("⭐ and `unread()` names it positively", unread(UNREADABLE) && !unread("0x") && !unread(null));

section("4 — 🚨 THE TWO CLAIMS THAT COLLAPSED NOW SEPARATE THE THIRD STATE");
check("⛔ an unreadable bytecode read blocks under its OWN code, not not-a-contract",
  /codeUnreadable/.test(noComments) && /bytecode-unreadable/.test(noComments));
check("  …and says the checks below it did NOT run",
  /none of them ran|it is the absence of one/.test(src));
check("⛔ an unreadable receipt no longer claims where the shares are",
  /receiptUnreadable/.test(noComments));
// ⭐⭐ THE STRUCTURAL ONE: the early return must not sit between the receipt read and WITNESS #2.
{
  const readAt = noComments.indexOf("getTransactionReceipt");
  const witnessAt = noComments.indexOf("usdcAfter = await readBalanceStrict");
  const guard = noComments.slice(readAt, witnessAt);
  check("🚨 …and an unreadable receipt FALLS THROUGH to the balance witness that can settle it",
    /!receiptUnreadable &&/.test(guard), "the early return is gated on the receipt being READABLE");
  check("  …and the undetermined case warns against retrying", /redeem twice/.test(src));
}

console.log(`\n╔${"═".repeat(37)}`);
console.log(`║  ${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}`);
console.log(`╚${"═".repeat(37)}`);
if (!fail) console.log("⭐ An exhausted read cannot be mistaken for a reading.");
process.exit(fail ? 1 : 0);
