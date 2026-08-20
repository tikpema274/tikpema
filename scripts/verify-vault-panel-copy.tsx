// verify-vault-panel-copy.tsx — THE VAULT PANEL'S CLAIMS, RENDERED, BOTH DIRECTIONS.
//
//   npx tsx scripts/verify-vault-panel-copy.tsx        (also: npm run test:vault)
//
// ═══ 🚨 WHY THIS EXISTS — AND WHAT WRITING IT FOUND ═════════════════════════════════════════
// `VaultPanel` was the first item on the guard registry's debt list: claim-bearing copy on the
// money path that no suite rendered. Writing this suite found a live fail-open in the first hour.
//
// 🚨 "NOTHING TO RECLAIM — YOU HOLD NO SHARES IN THIS VAULT" WAS THE TERMINAL STATE FOR A USER WHO
// HAD NEVER BEEN LOOKED AT. `refreshShares()` returns early — setting no error — when the user is
// signed out or the agent wallet has not provisioned. With `shares` null, `sharesErr` empty and
// `loadingShares` starting false, the render fell through to the empty-state line. The component's
// own comment promised the opposite: "fail-safe, so a read glitch never looks like an empty
// balance". ⭐ IT WAS BUILT FOR THE WRONG ABSENCE — a read that FAILED, not one that never
// happened. Fixed with `sharesProbed`; sections 2 and 3 hold that fix down.
//
// ═══ ⭐⭐ AND THE HEADLINE ABSOLUTE IS CONTINGENT, NOT INVARIANT ═════════════════════════════
// "Always available, never blocked by a pause" is TRUE — measured on-chain 2026-08-20, both RPCs
// agreeing: the one allowlisted vault exposes NO `pause()`, `unpause()`, `paused()` or
// `withdrawalDelay()`, and all three EIP-1967 slots are empty so the code cannot be swapped behind
// it. ⚠️ BUT IT IS A FINDING ABOUT THIS VAULT, WRITTEN AS A PROPERTY OF THE ACTION.
// `_vault.mjs:411` proves the codebase knows the difference — it derives that sentence per vault:
//   pausable ? "deposits/withdrawals may be halted" : "withdrawals cannot be frozen by a pause"
// and `_vault.mjs:585` says plainly: "if it covers withdrawals, you cannot exit while it is on."
// 🚨 SO THE SECOND A SECOND VAULT IS ALLOWLISTED, THE SENTENCE CAN BE FALSE WITH NO EDIT AND NO
// SIGNAL. Section 4 binds the copy to the allowlist that makes it true.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VAULT_ALLOWLIST } from "../netlify/functions/_vault.mjs";

const VaultPanel = (await import("../src/components/VaultPanel")).default;

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

const wallet = (over: any = {}) => ({
  agentWallet: { address: "0x" + "ab".repeat(20), balance: "12.3456" },
  address: "0x" + "cd".repeat(20), usdcBalance: "12.3456", busy: false, isAuthenticated: true,
  ensureSession: async () => "t", inspectVault: async () => ({}), vaultShareBalance: async () => ({}),
  depositToVault: async () => ({}), withdrawFromVault: async () => ({}),
  refreshAgentWallet: async () => {}, refreshBalance: async () => {}, ...over,
});
const render = (over: any = {}) =>
  renderToStaticMarkup(<VaultPanel wallet={wallet(over) as any} />)
    .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ").trim();

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  VAULT PANEL COPY — rendered; present AND absent                     ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("0 — the panel renders at all");
const signedIn = render();
check("⚠️ non-empty render (every absence check below is vacuous otherwise)",
  signedIn.length > 300, `${signedIn.length} chars`);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⭐ THE EXIT IS DESCRIBED, AND DESCRIBED AS UNGATED");
check("⭐ the reclaim redeems the WHOLE on-chain balance, with no amount to type",
  /Redeems your entire on-chain balance/.test(signedIn) && /there is no amount to type/.test(signedIn));
check("⭐⭐ …and it is stated as available without inspecting first",
  /Always available/.test(signedIn));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — 🚨 NEVER LOOKED ≠ NOTHING THERE (the fail-open this suite found)");
// ⭐ THE SIGNED-OUT CASE IS TERMINAL, not transient: refreshShares returns immediately, so whatever
// renders here is the user's FINAL answer about their own money.
// ⚠️ THE ABSENCE PATTERN IS THE FULL EMPTY-STATE SENTENCE, NOT THE SUBSTRING. My first version
// matched /you hold no shares/ — which also matches the FIX'S OWN COPY, "this is not a statement
// that you hold no shares". The guard was defeated by the very sentence that closes the defect, and
// it failed while the component was correct. ⭐ Same shape as the citation check that matched the
// prose it was checking against: when a negative pattern appears inside the positive one, it stops
// being a measurement.
const EMPTY_STATE = /Nothing to reclaim — you hold no shares in this vault/;
const signedOut = render({ isAuthenticated: false });
check("🚨🚨 signed out, the page does NOT claim the user holds no shares",
  !EMPTY_STATE.test(signedOut));
check("⭐ …it says the balance has not been checked yet", /haven't checked your vault balance yet/.test(signedOut));
check("⭐⭐ …and explicitly refuses the safe reading", /not.{0,10}a statement that you hold no shares/.test(signedOut));

// ⭐ THE UNPROVISIONED CASE IS SAFE BY A DIFFERENT ROUTE, and asserting my guess instead of the
// behaviour cost a failure: with no agent wallet the panel SHORT-CIRCUITS (107 chars, "Set up your
// wallet first") and never reaches the reclaim block at all. Two routes, one property — the empty
// state cannot render before a real look. What matters is the property, so both are pinned as
// themselves rather than forced into one shape.
const noWallet = render({ agentWallet: null });
check("🚨 an unprovisioned agent wallet never reaches the empty state either",
  !EMPTY_STATE.test(noWallet));
check("⭐ …it short-circuits with an instruction instead of a balance claim",
  /Set up your wallet first/.test(noWallet) && !/reclaim/i.test(noWallet));

// ⚠️ FIRST PAINT for a signed-in user, before the effect resolves — the same absence, briefly.
check("🚨 …and the FIRST PAINT of a signed-in session does not claim it either",
  !EMPTY_STATE.test(signedIn));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐ BUT THE EMPTY STATE MUST STILL EXIST, or the fix just deletes a true answer");
// 🚨 BOTH DIRECTIONS. A component that never says "nothing to reclaim" would pass section 2 while
// having lost the ability to tell a user the truth — the failure mode of fixing an over-claim by
// removing the claim entirely.
const src = (await import("node:fs")).readFileSync("src/components/VaultPanel.tsx", "utf8");
check("⭐ the empty-state line still exists in the component",
  /Nothing to reclaim — you hold no shares in this vault/.test(src));
check("⭐⭐ …and it is now guarded by `sharesProbed`, so it can only render after a real look",
  /!sharesProbed \?/.test(src) && /setSharesProbed\(true\)/.test(src));
check("⭐ …with the probe marked on BOTH success and failure, so 'could not read' stays distinct",
  /finally \{[\s\S]{0,400}setSharesProbed\(true\)/.test(src));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⭐⭐ THE PAUSE ABSOLUTE IS BOUND TO THE ALLOWLIST THAT MAKES IT TRUE");
// 🚨 THIS IS THE SHELF-LIFE CHECK. The sentence is a FINDING about one vault, written as a
// PROPERTY of the action. It stays true only while the allowlist holds vaults with no pause switch.
const KNOWN_PAUSE_FREE = {
  "xylo-usdc": "0x240Eb85458CD41361bd8C3773253a1D78054f747",
};
const keys = Object.keys(VAULT_ALLOWLIST);
check("⭐⭐ the allowlist still contains ONLY vaults measured to have no pause switch",
  keys.length === Object.keys(KNOWN_PAUSE_FREE).length &&
  keys.every((k) => VAULT_ALLOWLIST[k].address === KNOWN_PAUSE_FREE[k]),
  keys.length === 1
    ? `${keys[0]} @ ${VAULT_ALLOWLIST[keys[0]].address}`
    : `🚨 allowlist changed (${keys.join(", ")}) — "never blocked by a pause" must become DERIVED from the inspect result, not asserted`);
check("⭐ …and the panel still makes the claim the allowlist is licensing",
  /never blocked by a pause/.test(signedIn));
console.log("     ⚠️ EVIDENCE (2026-08-20, two RPCs agreeing): pause()/unpause()/paused()/withdrawalDelay()");
console.log("        all ABSENT from 7,811 bytes; all three EIP-1967 slots empty, so not a proxy.");
console.log("        ⭐ If this section fails, do NOT loosen it — derive the sentence per vault, as");
console.log("        _vault.mjs:411 already does for the disclosure card.");

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
