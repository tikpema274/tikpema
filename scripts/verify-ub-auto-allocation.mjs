// verify-ub-auto-allocation.mjs — auto-allocation is ON, and the SDK still allows it.
//
//   node scripts/verify-ub-auto-allocation.mjs
//
// ═══ WHAT THIS GUARDS ════════════════════════════════════════════════════════════════════════
// Unified Balance Kit enables auto-allocation by the ABSENCE of `from.allocations`. Supplying the
// key — for ANY source — disables it and pins the draw to whatever we name. So the feature is
// switched by a MISSING FIELD, which means:
//
//   · a well-meaning "let's be explicit about the source chain" edit silently turns it OFF, and
//   · nothing fails, because pinning to Arc works fine today.
//
// That is a change with no symptom, which is exactly the class this repo keeps getting bitten by.
// Hence a test that asserts the absence.
//
// ⚠️ AND THE DEPENDENCY CAN REVOKE IT. `allocations` is optional in
// @circle-fin/unified-balance-kit's spendSourceSchema. If a future version makes it REQUIRED, our
// omission becomes a runtime validation error on a money path — discovered at spend time. The
// schema is asserted here so an npm bump fails the suite instead.
//
// Zero network. Zero money.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  UNIFIED BALANCE — auto-allocation is ON (asserted by ABSENCE)        ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SITES = ["netlify/functions/_pay.mjs", "netlify/functions/_ubspend.mjs"];

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("1 — every spend site OMITS allocations");
for (const f of SITES) {
  const code = strip(readFileSync(f, "utf8"));
  check(`⭐⭐ ${f.split("/").pop()} passes NO \`allocations\``,
    !/allocations\s*:/.test(code));
  check(`  …and still calls unifiedBalance.spend`, /unifiedBalance\.spend\(/.test(code));
  check(`  …and still pins the SOURCE ACCOUNT (auto-allocation picks CHAINS, never the wallet)`,
    /sourceAccount:/.test(code));
}
// The count is asserted so a NEW spend site cannot be added with allocations and go unnoticed.
{
  const all = ["netlify/functions", "shared", "scripts", "src"];
  const hits = [];
  for (const dir of all) {
    try {
      const out = execSync(`grep -rln "unifiedBalance.spend(" ${dir} 2>/dev/null || true`, { encoding: "utf8" });
      // exclude THIS suite — it contains the literal string it greps for
      for (const p of out.split("\n").filter(Boolean)) if (!p.endsWith("verify-ub-auto-allocation.mjs")) hits.push(p);
    } catch { /* dir may not exist */ }
  }
  check("⭐ exactly the two known spend sites exist — a third would need its own decision",
    hits.length === SITES.length, hits.join(", ") || "none found");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("2 — the SDK still PERMITS omission (dependency-drift guard)");
{
  const sdk = readFileSync("node_modules/@circle-fin/unified-balance-kit/index.mjs", "utf8");
  check("⭐⭐ spendSourceSchema declares allocations as OPTIONAL",
    /const spendSourceSchema[\s\S]{0,400}?allocations:[\s\S]{0,120}?\.optional\(\)/.test(sdk),
    "if this fails, an npm bump made it REQUIRED and our omission is now a runtime error");
  check("  …and the greedy allocator is present to do the work", /function greedyAllocate\(/.test(sdk));
  check("  …tier ordering is by destination chain first",
    /sort by balance descending|greedy: largest first/i.test(sdk));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("3 — the asymmetry is documented where it bites");
// _pay is same-chain (Arc->Arc): Arc is tier 1 forever, so auto-allocation is a PERMANENT no-op.
// _ubspend is cross-chain (Arc->Base): the DESTINATION is tier 1, so once Base is funded this path
// silently changes source chain. Those are different risks and the code must say so.
{
  const pay = readFileSync("netlify/functions/_pay.mjs", "utf8");
  const ub = readFileSync("netlify/functions/_ubspend.mjs", "utf8");
  check("_pay.mjs records that it is SAME-CHAIN, hence tier 1 forever",
    /SAME-CHAIN|same-chain/.test(pay) && /tier 1/i.test(pay));
  check("⭐⭐ _ubspend.mjs warns it is NOT a permanent no-op",
    /NOT A PERMANENT NO-OP/i.test(ub));
  check("⭐⭐ …and names the unproven Base delegate authorisation",
    /delegate/i.test(ub) && /Base/.test(ub) && /unproven|UNPROVEN/.test(ub));
  check("  …and records that enabling now does NOT pre-prove the Base draw",
    /DOES NOT PRE-PROVE/i.test(ub));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
