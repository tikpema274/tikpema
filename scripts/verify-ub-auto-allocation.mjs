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
import { safeJson } from "../netlify/functions/_pay.mjs";

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
  // ═══ ⭐⭐ TWO SHAPES NOW, ONE PROPERTY — updated 2026-09-10 with the app-kit 1.14.0 upgrade ═════
  // This asserted `sourceAccount:` literally, which was asserting the MECHANISM, not the property.
  // The mechanism changed under a CORRECT fix and the check went red:
  //   · _ubspend.mjs — delegate shape: `address: delegate, sourceAccount: owner`. An EOA signs
  //     because Gateway used to accept only ecrecover.
  //   · _pay.mjs — ERC-1271 shape: `address: owner`, NO sourceAccount. There is no signer/source
  //     split any more; the account that HOLDS the balance is the one that AUTHORISES it.
  // ⭐ THE PROPERTY IS UNCHANGED AND IS WHAT MATTERS: the wallet is pinned EXPLICITLY, from the
  // caller's session. Auto-allocation picks CHAINS; it must never pick the WALLET.
  const pinned = /sourceAccount:\s*owner\b/.test(code) || /address:\s*owner\b/.test(code);
  check(`  …and still pins the wallet FROM THE SESSION (auto-allocation picks CHAINS, never the wallet)`,
    pinned, pinned ? "" : "neither `sourceAccount: owner` nor `address: owner` — the kit would choose");
  // ⛔ AND NEVER FROM ENV. AGENT_WALLET_ADDRESS is not the spender: a per-user spend sourced from a
  // shared env wallet is the cap-bypass seam _pay.mjs's own header was written about.
  check(`  ⛔ …and never names a spend wallet from env`,
    !/(address|sourceAccount):\s*process\.env/.test(code));
}
// ═══ 🚨 A COMMITTED BURN MUST NOT LOSE ITS OWN RECOVERY MATERIAL — added 2026-09-10 ═══════════
// MEASURED that day: a live pay_for_service produced a VALID ERC-1271 burn intent, Gateway attested
// it, Circle's ledger committed 0.1035 USDC — and the MINT failed, because this path passes a
// destination adapter and no forwarder so App Kit submits gatewayMint FROM the recipient, which
// Circle does not hold a wallet for. The old catch rethrew and kept NOTHING, while the error itself
// said what was being discarded: "Use the attestation and signature in error.cause.trace to
// reattempt". That attestation is the only thing that can complete or recover a committed burn.
section("3 — the failure path KEEPS what a recovery would need");
{
  const pay = strip(readFileSync("netlify/functions/_pay.mjs", "utf8"));
  check("⭐⭐ a non-quirk failure RECORDS before it rethrows",
    /recordStrandNeverThrows\(/.test(pay) && pay.indexOf("recordStrandNeverThrows(") < pay.lastIndexOf("throw e"),
    "order is the mechanism: a rethrow first would lose the attestation");
  check("⭐ …and it carries the CAUSE, where the attestation lives",
    /cause:\s*causeStr/.test(pay));
  check("⛔ …and the recorder cannot turn a spend failure into a different one",
    /catch \(writeErr\)/.test(pay) && /swallowed/i.test(pay),
    "the money may already be committed — a Blobs hiccup must not replace the real error");
  check("⭐ the record is AWAITED — a Netlify function can freeze the moment it returns",
    /await recordStrandNeverThrows\(/.test(pay));
}

// ═══ ⚠️ AND THE CATCH BLOCK'S OWN SERIALISER MUST NOT THROW ═══════════════════════════════════
// `causeStr` was a bare JSON.stringify. JSON.stringify THROWS on a BigInt, and viem/SDK errors
// carry them freely — so one BigInt in a cause would have thrown a TypeError FROM INSIDE THE CATCH,
// replacing the real failure and losing the 1098 classification that depends on causeStr.
// ⭐ Driven as a FUNCTION, not asserted by regex: a shape check would never exercise the BigInt.
{
  check("⭐⭐ safeJson survives a BigInt", safeJson({ a: 1n }) === '{"a":"1n"}', String(safeJson({ a: 1n })));
  const cyc = {}; cyc.self = cyc;
  check("⭐ …and a circular reference", safeJson(cyc) === '{"self":"[circular]"}', String(safeJson(cyc)));
  check("⭐ …and returns null rather than throwing on nothing", safeJson(undefined) === null && safeJson(null) === null);
  check("⛔ …while still serialising an ordinary cause faithfully",
    safeJson({ trace: "0xdeadbeef", code: 5001 }) === '{"trace":"0xdeadbeef","code":5001}');
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
//
// ⭐⭐ UPDATED 2026-09-11 WITH THE DELEGATE->OWNER SIGNING FIX — AND CHECKED FOR VACUOUS PASS.
// The "NOT A PERMANENT NO-OP" property is about CHAIN allocation (destination is tier 1 on a
// cross-chain spend), which the signing fix does not touch — so it stays true and this assertion
// still means something. But the SECOND assertion used to pin on the word "delegate", the MECHANISM
// that the fix DELETED. Left as-is it would pass on a stale comment; updated to remove "delegate" it
// would go red on a correct file. So it is repinned on the PROPERTY that is still unproven: a Base-
// sourced draw through the FORWARDER accepting a CONTRACT (ERC-1271) signature — which _pay.mjs's
// same-chain, useForwarder:false proof does NOT establish. [[guard-pinned-to-location-not-behaviour]]
{
  const pay = readFileSync("netlify/functions/_pay.mjs", "utf8");
  const ub = readFileSync("netlify/functions/_ubspend.mjs", "utf8");
  check("_pay.mjs records that it is SAME-CHAIN, hence tier 1 forever",
    /SAME-CHAIN|same-chain/.test(pay) && /tier 1/i.test(pay));
  check("⭐⭐ _ubspend.mjs warns it is NOT a permanent no-op (chain allocation — unchanged by the signing fix)",
    /NOT A PERMANENT NO-OP/i.test(ub));
  // ⛔ Pins on the PROPERTY (forwarder + contract signature unproven), never on the deleted mechanism.
  // A regression that re-introduced `delegate` signing would NOT satisfy these terms.
  check("⭐⭐ …and names the STILL-unproven property: a Base draw through the forwarder with a contract signature",
    /forwarder/i.test(ub) && /Base/.test(ub) && /(ERC-?1271|contract sig)/i.test(ub) && /unproven|UNPROVEN/.test(ub));
  check("  ⛔ …and no longer describes the signer as a delegate (the fix deleted it from this path)",
    !/delegate('s)? (authority|authorisation|signs|signer) (on|for|there)/i.test(ub),
    "a stale 'delegate signs' comment here would be describing a path that no longer exists");
  check("  …and records that enabling now does NOT pre-prove the Base draw",
    /DOES NOT PRE-PROVE/i.test(ub));
  // ⭐⭐ THE SIGNING MODEL IS NOW THE SAME ON BOTH PLANES — asserted so a revert of the fix reddens here.
  check("⭐⭐ _ubspend.mjs signs as the owner (ERC-1271), NOT via a delegate address",
    /address:\s*owner\b/.test(strip(ub)) && !/address:\s*delegate\b/.test(strip(ub)));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
