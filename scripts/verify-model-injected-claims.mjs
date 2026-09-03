#!/usr/bin/env node
// verify-model-injected-claims.mjs — ⛔ A CLAIM WE HAND TO THE MODEL IS COPY WE CANNOT INSPECT.
//
//   node scripts/verify-model-injected-claims.mjs      (also: npm run test:injectedclaims)
//   --list  prints every model-injected string found, with its classification
//
// ═══ 🚨 A NEW CONSUMER CLASS, FOUND 2026-09-03 ═══════════════════════════════════════════════
// `_bridge-fee-table.mjs:69` renders, as grounding injected into a paid research brief:
//
//     "It is taken out of the amount, so the recipient nets amount − fee."
//
// That is the SAME claim `MyAgentPanel`, `BridgePanel`, `ManualBridgePanel` and `site/index.html`
// make — and it is the one copy of it that NO COPY GUARD CAN CHECK AT THE POINT OF USE, because
// the point of use is generated prose. Every other surface renders a string we can assert on. This
// one hands a sentence to a model and the model restates it, paraphrased, inside a brief a customer
// paid for. [[assert-on-rendered-output-not-source-regex]] cannot reach it: there is no stable
// rendered output to assert against.
//
// ⚠️ THE CLAIM IS TRUE TODAY. This file is not a defect report — it is the population, recorded
// BEFORE the mechanics move. Circle shipped CCTP upfront fees on 2026-09-02: under
// `depositForBurnWithFees` the fee is collected on the SOURCE chain in addition to the amount and
// the recipient receives the FULL amount, which inverts that sentence exactly. We have not adopted
// it. The point of knowing the population now is that adoption must not have to rediscover it.
//
// ═══ ⭐ WHAT THIS GUARD CAN AND CANNOT DO, STATED ════════════════════════════════════════════
//   CAN     enumerate every authored string that reaches a model prompt, force each to be declared
//           as claim-bearing or instruction-only, and assert that the fee-mechanics sentence still
//           says what the rest of the product says.
//   CANNOT  check the model's OUTPUT. Nothing can, short of grading generated prose. So the
//           discipline is at the INPUT: if the sentence we hand over is wrong, everything
//           downstream is wrong and invisible.
// ⛔ Declaring a string INSTRUCTION is a judgement that it asserts nothing about us. It is checked
// only in the weak sense that the file lists it — this table is a record, and it is honest about
// being one.

import { readdirSync, readFileSync } from "node:fs";

let pass = 0, fail = 0;
const fails = [];
const ok = (l, c, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; fails.push(l); console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

const SURFACES = ["netlify/functions", "shared"];
const walk = (d) => readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
const files = SURFACES.flatMap(walk).filter((f) => /\.mjs$/.test(f));

/** An authored string that reaches a model prompt. Detected by DECLARATION SHAPE, not by tracing a
 *  call graph into the SDK — a prompt constant is what a maintainer adds, and it is what must be
 *  classified before it ships. */
const INJECTED = /^(?:export )?(?:const|function|export function)\s+([A-Za-z_$][\w$]*(?:GroundingText|SYSTEM_PROMPT|SYSTEM|_PROMPT|_SYSTEM)[\w$]*)\s*[=(]|(systemPrompt)\s*:/;

/**
 * CLAIM   — asserts something about OUR product, OUR measurements, or OUR mechanics. The model will
 *           restate it as fact in prose no guard reads. These are the ones that can go false.
 * INSTRUCTION — shapes behaviour or output format and asserts nothing about us.
 */
const CLASS = { CLAIM: "CLAIM", INSTRUCTION: "INSTRUCTION" };

const DECLARED = {
  "feeTableGroundingText": { klass: CLASS.CLAIM, feeMechanics: true,
    what: "OUR measured per-destination bridge fee, AND the sentence 'It is taken out of the " +
          "amount, so the recipient nets amount − fee'. The fee-mechanics claim, injected." },
  "swapRateGroundingText": { klass: CLASS.CLAIM, feeMechanics: false,
    what: "OUR measured USDC/EURC rate, its two independent sources, whether they agree, and what " +
          "an aggregator's advertised rate IS. Measurement claims about us." },
  "SYSTEM_PROMPT@netlify/functions/agent-act.mjs": { klass: CLASS.CLAIM, feeMechanics: false,
    what: "product mechanics: which actions exist, that a bridge 'burns USDC on Arc and mints it " +
          "on the destination chain', and the supported destination list. States no fee claim — " +
          "which is why upfront fees would NOT falsify it." },
  "SYSTEM_PROMPT@netlify/functions/plan-quote.mjs": { klass: CLASS.CLAIM, feeMechanics: false,
    what: "product scope: the two supported actions, the destination list, and 'ONLY these two " +
          "tokens exist on Arc'. Scope claims, no fee claim." },
  "SYSTEM_PROMPT@netlify/functions/job-quote.mjs": { klass: CLASS.INSTRUCTION,
    what: "accept/decline policy for research questions plus the JSON shape; the budget bounds are " +
          "INTERPOLATED from constants rather than retyped." },
  "BRIEF_SYSTEM_PROMPT": { klass: CLASS.INSTRUCTION, what: "how to write a grounded brief; asserts nothing about us." },
  "BRIEF_SYSTEM_PROMPT_EXA": { klass: CLASS.INSTRUCTION, what: "the Exa variant of the same instruction." },
  "EVALUATOR_SYSTEM_PROMPT": { klass: CLASS.INSTRUCTION, what: "how to grade a brief; asserts nothing about us." },
  "DATA_DECISION_SYSTEM": { klass: CLASS.INSTRUCTION, what: "whether one data fetch would improve a brief." },
  "PAPER_FILTER_SYSTEM": { klass: CLASS.INSTRUCTION, what: "a strict relevance filter over arXiv results." },
  "BRIEF_SYSTEM": { klass: CLASS.INSTRUCTION, what: "the autonomy-test harness's brief prompt; not a production path." },
  "systemPrompt": { klass: CLASS.INSTRUCTION, what: "Exa's own retrieval hint — 'Prefer authoritative and primary sources.'" },
};

// ⭐ RATCHET on the CLAIM-bearing subset. It may only fall: each entry is a sentence a customer can
// be told as fact, in prose nobody reviews.
const MAX_CLAIM_BEARING = 4;

const found = [];
for (const f of files) {
  readFileSync(f, "utf8").split("\n").forEach((raw, i) => {
    const line = raw.replace(/^\s*\/\/.*$/, "");
    const m = INJECTED.exec(line);
    if (!m) return;
    const name = m[1] ?? m[2];
    // ⚠️ Two files both define `SYSTEM_PROMPT`, and they say DIFFERENT things. Keying on the bare
    //    name would let one declaration cover both — a shared key for two separate claims is the
    //    duplicate-source shape this repo keeps paying for. Qualify by file where it collides.
    const qualified = `${name}@${f}`;
    const decl = DECLARED[qualified] ?? DECLARED[name] ?? null;
    found.push({ file: f, line: i + 1, name, key: DECLARED[qualified] ? qualified : name, decl,
                 text: raw.trim().slice(0, 90) });
  });
}

const claims = found.filter((x) => x.decl?.klass === CLASS.CLAIM);
const instructions = found.filter((x) => x.decl?.klass === CLASS.INSTRUCTION);
const undeclared = found.filter((x) => !x.decl);

console.log("\nverify-model-injected-claims — what do we hand the model as fact?");
console.log(
  `\n     files scanned ${files.length}  ·  model-injected strings ${found.length}` +
  `  ·  CLAIM-bearing ${claims.length}  ·  instruction-only ${instructions.length}` +
  `  ·  UNDECLARED ${undeclared.length}`);
console.log(`     fee-mechanics-dependent: ${claims.filter((c) => c.decl.feeMechanics).length}` +
  ` — ${claims.filter((c) => c.decl.feeMechanics).map((c) => `${c.file}:${c.line}`).join(", ") || "none"}`);
if (process.argv.includes("--list")) {
  for (const x of found) {
    console.log(`     ${(x.decl?.klass ?? "UNDECLARED").padEnd(11)} ${x.file}:${x.line}  ${x.name}`);
    if (x.decl) console.log(`                 ${x.decl.what}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⭐ THE POPULATION IS KNOWN, and a new prompt must be classified before it ships");
{
  ok("⭐⭐ every model-injected string is DECLARED",
    undeclared.length === 0,
    undeclared.map((x) => `${x.file}:${x.line}  ${x.name}`).join("\n      "));
  ok("the scan is non-empty and reaches the grounding producers",
    found.length > 5 && found.some((x) => x.name === "feeTableGroundingText"),
    `${found.length} found`);
  ok("⭐ both classes are populated — a scan that found only one is not classifying",
    claims.length > 0 && instructions.length > 0, `${claims.length} claim / ${instructions.length} instruction`);
  ok(`⭐ the claim-bearing ratchet holds — ${claims.length} of ceiling ${MAX_CLAIM_BEARING}`,
    claims.length <= MAX_CLAIM_BEARING, `${claims.length} > ${MAX_CLAIM_BEARING}`);
  const stale = Object.keys(DECLARED).filter((k) => !found.some((x) => x.key === k));
  ok("⛔ no stale declaration — an entry for a string that no longer exists is a record nobody re-reads",
    stale.length === 0, stale.join(", "));
  ok("⭐ every declaration says WHAT the string claims, not merely that it exists",
    Object.values(DECLARED).every((d) => typeof d.what === "string" && d.what.length > 30));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — 🚨 THE FEE-MECHANICS SENTENCE, asserted at the INPUT because the output is unreachable");
{
  const { feeTableGroundingText } = await import("../netlify/functions/_bridge-fee-table.mjs");
  const rendered = feeTableGroundingText({
    at: "2026-09-03T00:00:00.000Z",
    rows: [
      { chain: "base", label: "Base (Sepolia)", feeUsdc: 0.053196, available: true },
      { chain: "ethereum", label: "Ethereum (Sepolia)", feeUsdc: null, available: false, why: "no forwarding tier" },
    ],
  });

  ok("⭐ it renders as ONE timestamped grounding entry", /as of 2026-09-03T00:00:00\.000Z/.test(rendered), rendered.slice(0, 80));
  ok("⭐ …and carries the measured per-destination figure", /0\.053196/.test(rendered));
  ok("⭐ …and says a destination is NOT bridgeable rather than omitting it",
    /not bridgeable right now/.test(rendered), rendered);

  // ⛔ THE CLAIM ITSELF. This is the assertion that goes red the day the mechanics change — the only
  //    place this sentence can be caught, because downstream it becomes somebody's paraphrase.
  ok("🚨🚨 the FEE-MECHANICS CLAIM is present and says the fee comes OUT OF the amount. " +
    "If this goes red, the model is being handed a false fact and no other guard will see it: " +
    "the output is generated prose.",
    /taken out of the amount/.test(rendered) && /nets amount − fee/.test(rendered), rendered);

  // ⭐ AND IT AGREES WITH THE PRODUCER. The sentence is a claim about `bridgeNetUsdc`; asserting the
  //   words alone would let the words and the arithmetic drift apart, which is the whole defect.
  const { bridgeNetUsdc } = await import("../netlify/functions/_bridge.mjs");
  const net = bridgeNetUsdc({ amountMinor: 1_000_000n, maxFee: 53_196n });
  ok("⭐⭐ …and the CODE still behaves the way the sentence says — net + fee === amount",
    Math.abs(net + 0.053196 - 1.0) < 1e-9, `net=${net}`);
  ok("⛔ …so the words and the arithmetic cannot drift apart silently",
    net < 1.0, `net=${net} is not strictly less than the amount`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
const total = pass + fail;
console.log("\n" + "─".repeat(92));
console.log(`${fail === 0 ? "✅" : "❌"} verify-model-injected-claims — ${pass}/${total} passed, ${fail} failed`);
if (fail) {
  console.log(`\n   FAILED: ${fails.join(" · ")}`);
  console.log(`\n   ⛔ A string handed to a model is claim-bearing copy whose OUTPUT no guard can`);
  console.log(`      inspect. Declare a new prompt as CLAIM or INSTRUCTION, and say what it asserts.`);
}
console.log("─".repeat(92) + "\n");
process.exit(fail === 0 ? 0 : 1);
