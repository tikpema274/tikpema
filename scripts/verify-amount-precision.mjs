// verify-amount-precision.mjs — PRODUCERS EMIT FULL PRECISION; ONLY RENDERS ROUND.
//
//   node scripts/verify-amount-precision.mjs      (also: npm run test:precision)
//
// ═══ 🚨 THE DEFECT ══════════════════════════════════════════════════════════════════════════════
// `my-wallet.mjs` returned `.toFixed(2)` on a 6-dp token. Eight display sites and one ARITHMETIC
// site received a value already missing four digits. A shown 0.40 EURC was anywhere in
// [0.395, 0.405), and the only way to learn what an agent swap returned was to diff that number
// across a refresh. BridgePanel's 25/50/75 buttons then MULTIPLIED it: at a real balance of
// 0.409999, "25%" sent 0.10 rather than 0.102499 — 2.44% short.
//
// ⛔ AND NOTHING GUARDED IT. Every copy suite stayed green through the fix, because their fixtures
// pass non-2dp strings and no assertion looked at precision. The rule was written in a comment and
// enforced by nobody, which is how it would come back at producer four.

import { readFileSync } from "node:fs";
import { displayAmount, exactAmount, requiredAmount, availableAmount } from "../src/lib/formatAmount.ts";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } return !!c; };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// ⭐ THE PRODUCERS, NAMED. Adding a fourth balance reader without adding it here is the gap this
// list makes visible — an include-list is wrong for a CLASS, but right for a short, known set whose
// membership is a deliberate architectural fact.
const PRODUCERS = [
  ["netlify/functions/my-wallet.mjs", /formatUnits\(raw, USDC_DECIMALS\)/],
  ["src/wallet/useModularWallet.ts", /formatUnits\(raw, USDC_DECIMALS\)/],
  ["src/wallet/connectors/metamask.ts", /formatUnits\(raw, USDC_DECIMALS\)/],
];

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  AMOUNT PRECISION — full at the producer, rounded only at a render   ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("1 — ⛔ NO BALANCE PRODUCER ROUNDS");
for (const [f, marker] of PRODUCERS) {
  const src = read(f);
  check(`⭐ ${f} still reads a balance — the check has something to be about`, marker.test(src));
  // ⚠️ A RETURN OR AN ASSIGNMENT, NOT AN INTERPOLATION. The first draft flagged
  // useModularWallet.ts:659 — `Insufficient funds. You have ${…toFixed(2)} USDC` — which is a
  // RENDER inside an error message, exactly what the rule permits. A guard that cannot tell a
  // producer from a message would push people to strip rounding from user-facing text, which is
  // the rule inverted. ⭐ The distinguishing feature is syntactic: rounding inside `${…}` is a
  // render; rounding in a `return` or a `const x =` is the value itself.
  const rounds = src.split("\n").some((line) => {
    if (!/formatUnits\([^)]*\)\)?\.toFixed\(\d\)/.test(line)) return false;
    if (/\$\{/.test(line)) return false;              // interpolated into a message → a render
    return /\breturn\b|\bconst\b|\blet\b|=/.test(line);
  });
  check(`⛔ …and does NOT round it at the source`, !rounds,
    rounds ? "a producer that rounds loses the digits for every consumer at once" : "emits full precision");
}

section("2 — ⭐ THE RENDER HELPER PRESERVES THE DISTINCTION IT IS GIVEN");
{
  // 🚨 THE PAIR THAT MATTERS. Two balances that differ in the 6th place must stay distinguishable
  // when a surface asks for 6 digits, and are ALLOWED to collapse only when it asks for 2.
  const a = "0.409999", b = "0.410000";
  check("⭐⭐ 6dp keeps two values that differ in the 6th place apart",
    displayAmount(a, 6) !== displayAmount(b, 6), `${displayAmount(a, 6)} vs ${displayAmount(b, 6)}`);
  check("⭐ …and 2dp is ALLOWED to collapse them — that is a render decision, not a data loss",
    displayAmount(a, 2) === displayAmount(b, 2), `both ${displayAmount(a, 2)}`);
  check("⭐⭐ the exact value survives for arithmetic regardless of any display choice",
    exactAmount(a) === 0.409999 && exactAmount(a) !== Number(displayAmount(a, 2)));
  // ⛔ Absence must not render as zero: an unknown balance and a zero balance are different facts.
  check("⛔ a missing balance renders as the placeholder, never as 0.00",
    displayAmount(null) === "…" && displayAmount(undefined) === "…" && displayAmount("") === "…");
  check("⛔ …and a non-numeric value does not become a number",
    displayAmount("banana") === "…");
}

section("3 — ⭐⭐ ARITHMETIC IS NEVER DONE ON A ROUNDED VALUE");
{
  const panel = read("src/components/BridgePanel.tsx");
  // The percentage buttons are the one place a balance becomes a SEND AMOUNT.
  const m = panel.match(/setAmount\(\(\(bal \* p\) \/ 100\)\.toFixed\((\d)\)\)/);
  check("⭐ the percentage buttons still compute from the balance", !!m, m ? `toFixed(${m[1]})` : "not found");
  check("⭐⭐ …and round to 6dp, not 2 — a send amount rounded to 2dp discards held funds",
    m && m[1] === "6", m ? `toFixed(${m[1]})` : "-");
  // The measured cost of getting this wrong, kept next to the assertion so it is not re-litigated.
  const truth = 0.409999, wasRounded = Number(truth.toFixed(2));
  const bad = Number(((wasRounded * 25) / 100).toFixed(2));
  const good = Number(((truth * 25) / 100).toFixed(6));
  check("⭐ the error this prevents is real and measurable",
    Math.abs(bad - good) / good > 0.02, `25% of ${truth}: rounded path ${bad}, true ${good} — ${((Math.abs(bad-good)/good)*100).toFixed(2)}% short`);
}

section("⭐⭐ ROUNDING HAS A DIRECTION WHEN THE NUMBER IS A REQUIREMENT");
{
  // The upfront-fee total that provoked this: 2 USDC + a 0.054121 forwarder fee.
  const TOTAL = 2.054121;
  check("⛔ nearest-rounding a REQUIREMENT understates it — 4dp is 21 millionths short",
    Number(displayAmount(TOTAL, 4)) < TOTAL, `${displayAmount(TOTAL, 4)} < ${TOTAL}`);
  check("⛔ …and 2dp is worse", Number(displayAmount(TOTAL, 2)) < TOTAL, `${displayAmount(TOTAL, 2)}`);

  // ⭐ THE PROPERTY, over a range rather than one lucky value.
  const VALUES = [2.054121, 0.054121, 1.999999, 0.000001, 123.456789, 2.05, 0, 7];
  let reqBelow = null, availAbove = null;
  for (const v of VALUES) for (const dp of [2, 4, 6]) {
    if (Number(requiredAmount(v, dp)) < v && reqBelow === null) reqBelow = `${v}@${dp} -> ${requiredAmount(v, dp)}`;
    if (Number(availableAmount(v, dp)) > v && availAbove === null) availAbove = `${v}@${dp} -> ${availableAmount(v, dp)}`;
  }
  check(`⭐⭐ requiredAmount is NEVER below the real figure (${VALUES.length} values x 3 precisions)`,
    reqBelow === null, String(reqBelow));
  check("⭐⭐ availableAmount is NEVER above it", availAbove === null, String(availAbove));

  // ⚠️ AND IT MUST NOT INFLATE A FIGURE THAT NEEDED NO ROUNDING. `2.05 * 100` is 204.99999999999997
  // in floating point; a naive ceil turns an exact 2.05 into 2.06 and the direction rule becomes a
  // rounding bug of its own.
  check("⛔ an EXACT figure is unchanged in both directions — the ceil does not inflate 2.05 to 2.06",
    requiredAmount(2.05, 2) === "2.05" && availableAmount(2.05, 2) === "2.05",
    `${requiredAmount(2.05, 2)} / ${availableAmount(2.05, 2)}`);
  check("  …and at 6dp on a 6-dp token there is no rounding at all",
    requiredAmount(TOTAL, 6) === "2.054121" && availableAmount(TOTAL, 6) === "2.054121");

  // ⭐ THE PAIRWISE PROPERTY — the one the refusal actually depends on. A genuine shortfall must
  //   never render as sufficient; the reverse (reading short when it is not) is the safe direction.
  const shortfalls = [[2.0512, 2.0549], [0.999999, 1.0], [1.994, 2.0]];
  let readsSufficient = null;
  for (const [have, need] of shortfalls) for (const dp of [2, 4, 6]) {
    if (Number(availableAmount(have, dp)) >= Number(requiredAmount(need, dp)) && readsSufficient === null) {
      readsSufficient = `have ${have} need ${need} @${dp} -> ${availableAmount(have, dp)} / ${requiredAmount(need, dp)}`;
    }
  }
  check("⭐⭐ a real shortfall NEVER renders as have >= need — the self-contradictory refusal is closed",
    readsSufficient === null, String(readsSufficient));
  check("⛔ …and the nearest-rounded pair DOES produce it, so the fix is doing the work",
    Number(displayAmount(2.0512, 2)) >= Number(displayAmount(2.0549, 2)),
    `${displayAmount(2.0512, 2)} vs ${displayAmount(2.0549, 2)}`);

  check("⭐ the absence placeholder survives both", requiredAmount(null) === "…" && availableAmount(undefined) === "…");
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0`);

console.log(`⭐ Producers emit full precision; only renders round; arithmetic reads the exact value.\n`);
