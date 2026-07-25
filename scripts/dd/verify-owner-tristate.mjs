// verify-owner-tristate.mjs — proves the DD engine's defect-A fix, and that NOTHING ELSE MOVED.
//
// Defect A (milder form): owner-powers.mjs caught EVERY owner-read failure — including an
// RPC-exhausted read that never reached the chain — and reported `no-owner-fn`, indistinguishable
// from a genuine "no owner() function". After adopting shared/onchain-facts' classifyOwnerType, a
// transport-defeated read is INDETERMINATE (`unreadable` / `unreadable-kind`), never the reassuring
// "no owner". This file is the dd/ analogue of scripts/verify-vault-degraded.mjs: the fix is only
// real if the failure path is exercised, so it fault-injects the reads.
//
// THREE PARTS, matching the acceptance test:
//   A. classifyOwnerType is tri-state-correct on every input (the shared primitive).
//   B. the OLD output classes are UNCHANGED — same type strings, same catalogue (no ripple).
//   C. end-to-end through owner-powers.run() with an injected client: RPC-exhausted → unreadable;
//      a genuine revert → no-owner-fn (unchanged); a healthy read → eoa (unchanged).
//
//   node scripts/dd/verify-owner-tristate.mjs
// Zero money, zero network — the client is injected.

import { UNREADABLE, classifyOwnerType, POWER_SIGS, sel } from "../../shared/onchain-facts/index.mjs";
import { run as ownerPowers } from "./checks/owner-powers.mjs";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};

const ADDR = "0x00000000000000000000000000000000000000aa";
const OWNER_EOA = "0x5b967871bb9b2ce1ac7e3a3a2ab2ec5c1e4b8a2f";
const word = (addr) => "0x" + "0".repeat(24) + addr.replace(/^0x/, "");
const ZERO_WORD = "0x" + "0".repeat(64);
// Bytecode fragments that contain the fingerprint selectors, so classifyOwnerType can detect a Safe
// or a timelock from injected owner code.
const codeWith = (sigs) => "0x" + sigs.map((s) => sel(s)).join("") + "6000";
const SAFE_CODE = codeWith(["getThreshold()", "getOwners()"]);
const TIMELOCK_CODE = codeWith(["getMinDelay()", "TIMELOCK_ADMIN_ROLE()"]);

console.log("\n── PART A · classifyOwnerType is tri-state-correct (the shared primitive) ──");
{
  check("UNREADABLE owner → 'unreadable' (NOT renounced)", classifyOwnerType(UNREADABLE, undefined).type === "unreadable");
  check("null owner → 'no-owner-fn' (a real 'no owner()' answer)", classifyOwnerType(null, undefined).type === "no-owner-fn");
  check("undefined owner → 'no-owner-fn'", classifyOwnerType(undefined, undefined).type === "no-owner-fn");
  check("confirmed ZERO address → 'renounced' (the ONLY path to renounced)", classifyOwnerType("0x0000000000000000000000000000000000000000", undefined).type === "renounced");
  check("real addr + code '0x' → 'eoa'", classifyOwnerType(OWNER_EOA, "0x").type === "eoa");
  check("real addr + UNREADABLE code → 'unreadable-kind' (NOT eoa)", classifyOwnerType(OWNER_EOA, UNREADABLE).type === "unreadable-kind");
  check("real addr + Safe code → 'multisig'", classifyOwnerType(OWNER_EOA, SAFE_CODE).type === "multisig");
  check("real addr + timelock code → 'timelock'", classifyOwnerType(OWNER_EOA, TIMELOCK_CODE).type === "timelock");
  check("real addr + other contract code → 'contract'", classifyOwnerType(OWNER_EOA, "0xdeadbeef").type === "contract");
}

console.log("\n── PART B · the OLD classes are UNCHANGED (no ripple past defect A) ──");
{
  // The catalogue this engine scans must equal its historical ALL_SIGS: nine groups, this exact
  // order. A change here would move powersPresent ordering on a real scan — a silent regression.
  const EXPECTED_GROUPS = ["emergencyWithdraw", "feesSettable", "setStrategy", "setFeeRecipient", "transferOwnership", "pausable", "upgradeable", "denylist", "withdrawalDelay"];
  check("catalogue == historical ALL_SIGS (9 groups, same order)", JSON.stringify(Object.keys(POWER_SIGS)) === JSON.stringify(EXPECTED_GROUPS), Object.keys(POWER_SIGS).length + " groups");
  check("denylist still scanned (would regress under a vault-only catalogue)", Array.isArray(POWER_SIGS.denylist) && POWER_SIGS.denylist.length === 5);
  check("withdrawalDelay still scanned", Array.isArray(POWER_SIGS.withdrawalDelay) && POWER_SIGS.withdrawalDelay.length === 3);
}

// ── Injected client: no network. Non-proxy (zero impl+admin slots), non-empty own code. ──
function fakeClient({ ownerThrow, ownerResult, ownerCodeThrow, ownerCodeResult }) {
  const OWN_CODE = "0x" + "60".repeat(32);
  const q = { endpoint: "inj", method: "inj", params: [], reproduce: "inj" };
  return {
    chain: { explorer: "https://x", rpc: "inj", id: 5042002, name: "arc-testnet" },
    assert: async () => 5042002,
    pin: async () => ({ number: 1, tag: "0x1", pinnedBy: "test" }),
    call: async ({ method, params }) => {
      if (method === "eth_getCode") {
        if (params[0].toLowerCase() === ADDR.toLowerCase()) return { result: OWN_CODE, query: q, evidence: {} };
        if (ownerCodeThrow) throw Object.assign(new Error("code read failed"), { transient: ownerCodeThrow === "transient", query: q });
        return { result: ownerCodeResult ?? "0x", query: q, evidence: {} };
      }
      if (method === "eth_getStorageAt") return { result: ZERO_WORD, query: q, evidence: {} }; // non-proxy
      if (method === "eth_call") {
        if (ownerThrow) throw Object.assign(new Error(ownerThrow === "transient" ? "request limit reached" : "execution reverted"), { transient: ownerThrow === "transient", query: q });
        return { result: ownerResult, query: q, evidence: {} };
      }
      throw new Error("unexpected call: " + method);
    },
  };
}
const ownerOf = async (opts) => (await ownerPowers({ address: ADDR, chain: "arc-testnet", client: fakeClient(opts) })).result.owner;

console.log("\n── PART C · end-to-end through owner-powers.run() with an injected client ──");
{
  const healthy = await ownerOf({ ownerResult: word(OWNER_EOA), ownerCodeResult: "0x" });
  check("CONTROL healthy read → eoa (unchanged)", healthy.type === "eoa", healthy.type);
  check("CONTROL healthy read keeps dd/'s label", healthy.label === "a single externally-owned key controls this contract");

  const transient = await ownerOf({ ownerThrow: "transient" });
  check("🚨 THE FIX: RPC-exhausted owner() → 'unreadable' (was 'no-owner-fn')", transient.type === "unreadable", transient.type);
  check("     …and the error string is preserved", typeof transient.error === "string" && /request limit/.test(transient.error));

  const reverted = await ownerOf({ ownerThrow: "revert" });
  check("CONTROL genuine revert → 'no-owner-fn' (unchanged)", reverted.type === "no-owner-fn", reverted.type);

  const zero = await ownerOf({ ownerResult: ZERO_WORD });
  check("CONTROL zero-address owner → 'renounced' (unchanged)", zero.type === "renounced", zero.type);

  const codeUnread = await ownerOf({ ownerResult: word(OWNER_EOA), ownerCodeThrow: "transient" });
  check("🚨 THE FIX (2nd read): owner code RPC-exhausted → 'unreadable-kind' (was 'no-owner-fn')", codeUnread.type === "unreadable-kind", codeUnread.type);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed. Zero money, zero network.`);
process.exit(fail === 0 ? 0 : 1);
