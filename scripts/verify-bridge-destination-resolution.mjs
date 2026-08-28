#!/usr/bin/env node
// verify-bridge-destination-resolution.mjs — A DESTINATION KEY MUST NOT SILENTLY BECOME ANOTHER CHAIN.
//
//   node scripts/verify-bridge-destination-resolution.mjs   (also: npm run test:bridgedest)
//
// ═══ 🚨 THE DEFECT THIS PINS, OBSERVED ON A REAL BRIDGE 2026-08-28 ═════════════════════════════
// The manual bridge panel shipped a hand-typed dropdown: `base-sepolia` and `avalanche-fuji`.
// Neither is a destination key. `resolveDestination` has a LOOSE contains-match so an agent's
// free text still resolves — and "base-sepolia" fell into it, matched **ETHEREUM** (iterated
// first, and the string contains "sepolia"), and 2.000000 USDC burned toward the wrong chain.
//
// ⛔ THE FAILURE MODE IS THE POINT. A wrong identifier that ERRORS is a bug you find in seconds.
// A wrong identifier that RESOLVES ANYWAY produces a successful quote, a successful burn, and a
// mistake visible only on a chain the user never chose. Nothing in the pipeline objected.
//
// ⭐ TWO INDEPENDENT PROPERTIES ARE ASSERTED, because either alone would have missed it:
//   1. the user path resolves STRICTLY — an almost-right key must FAIL, not fuzzy-match;
//   2. every offered option ROUND-TRIPS to itself — resolve(key).key === key.
// (2) is what a served list guarantees and a typed list cannot.

import {
  resolveDestination, resolveDestinationStrict, destinationOptions, BRIDGE_DESTINATIONS,
} from "../netlify/functions/_bridge.mjs";

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? `  — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  BRIDGE DESTINATIONS — a key must not become another chain          ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("1 — 🚨 the exact string that mis-routed a real bridge");
{
  const loose = resolveDestination("base-sepolia");
  // The loose matcher STILL does this — deliberately unchanged, the agent path needs free text.
  check("the loose matcher still resolves 'base-sepolia' to the WRONG chain (documented, not fixed)",
    loose?.key === "ethereum",
    `loose → ${loose?.key ?? "null"} — this is why the user path must not use it`);
  check("⭐⭐ the STRICT matcher REFUSES it",
    resolveDestinationStrict("base-sepolia") === null,
    "an almost-right key fails instead of becoming Ethereum");
  check("⭐ …and refuses 'avalanche-fuji' too — which resolved CORRECTLY by luck",
    resolveDestinationStrict("avalanche-fuji") === null,
    "one of the two typed values happened to work; luck is not a property");
}

section("2 — ⭐⭐ every offered option ROUND-TRIPS to itself");
{
  const opts = destinationOptions();
  check("the option list is non-empty", opts.length > 0, `${opts.length} destinations`);
  const bad = opts.filter((o) => resolveDestinationStrict(o.key)?.key !== o.key);
  check("⭐⭐ resolveStrict(option.key).key === option.key, for EVERY option",
    bad.length === 0,
    bad.length ? `broken: ${bad.map((b) => b.key).join(", ")}` : `${opts.length}/${opts.length} round-trip`);
  const domains = opts.map((o) => o.cctpDomain);
  check("…and every option carries a cctpDomain", domains.every((d) => Number.isInteger(d)));
  check("⭐ the list is DERIVED from BRIDGE_DESTINATIONS, not a parallel copy",
    opts.length === Object.keys(BRIDGE_DESTINATIONS).length,
    `${opts.length} options vs ${Object.keys(BRIDGE_DESTINATIONS).length} destinations`);
}

section("3 — ⭐⭐ the USER PATH ACTUALLY CALLS THE STRICT RESOLVER");
{
  // 🚨 THIS ASSERTION EXISTS BECAUSE ITS ABSENCE WAS CAUGHT BY INJECTION. The first version of
  // this suite proved the strict resolver BEHAVES correctly and that the panel serves its options
  // — and would still have passed with the user path reverted to the loose matcher. Two correct
  // components wired to nothing is the gap; a suite that tests parts and not the wiring cannot see
  // it. Reverting `resolveDestinationStrict` → `resolveDestination` in _user-bridge.mjs produced
  // ZERO failures until this block existed.
  const gate = await import("node:fs").then((fs) =>
    fs.readFileSync("netlify/functions/_user-bridge.mjs", "utf8"));
  const code = gate.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("⭐⭐ priceAndGate resolves via resolveDestinationStrict",
    /resolveDestinationStrict\(destination\)/.test(code),
    "comments stripped — the property is about code, not prose");
  check("🚨 …and does NOT call the loose resolveDestination anywhere",
    !/[^t]resolveDestination\(/.test(code),
    "the loose matcher is what routed a real bridge to the wrong chain");
}

section("4 — the panel offers ONLY served options (no hardcoded list)");
{
  const panel = await import("node:fs").then((fs) =>
    fs.readFileSync("src/components/ManualBridgePanel.tsx", "utf8"));
  const code = panel.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  // 🚨 A hardcoded <option value="..."> is exactly what shipped and mis-routed.
  const hardcoded = [...code.matchAll(/<option\s+value="([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
  check("🚨 NO hardcoded destination values in the panel",
    hardcoded.length === 0,
    hardcoded.length ? `found: ${hardcoded.join(", ")}` : "options come from the server");
  check("⭐ …and it renders the SERVED list", /destinations\.map\(/.test(code));
  check("⭐ …and cannot quote until one is chosen — no default to submit blindly",
    /disabled=\{busy \|\| !destination\}/.test(code));
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0`);
console.log(`⭐ An almost-right key now FAILS instead of becoming another chain.\n`);
