// VAULT PLANE — inspect an ERC-4626 vault, then deposit/withdraw the agent's USDC.
//
// TWO HALVES, deliberately coupled:
//   1. inspectVault()  — READ-ONLY. Reports conformance, underlying asset, funded-vs-shell,
//      withdraw mechanics (lock/delay/fee), and OWNER POWERS as plain disclosure a user would
//      want BEFORE depositing. Framed as disclosure, never accusation.
//   2. vaultDeposit()/vaultWithdraw() — MOVE FUNDS. Reuse the bridge's proven approve→call
//      pattern (_bridge.mjs:165–192). The Executor (_actions.executeAction) is the ONLY secure
//      caller: it enforces the allowlist (resolveVault), the fail-closed cap (vaultDepositCapUsdc),
//      the day-ceiling, and the inspection GATE (gateDeposit) BEFORE either function runs.
//
// This is a MAINNET DRESS REHEARSAL against XyloVault on Arc testnet. The inspection is written
// to be vault-general (source-independent: it reads bytecode and calls the chain, never a
// block-explorer API), so the same disclosure will work on mainnet where it actually matters.
//
// ⚠️ ALLOWLISTED ≠ WARNING SILENCED. Being on VAULT_ALLOWLIST only passes the ALLOWLIST gate
// (resolveVault). It does NOT touch inspection. XyloVault's real owner powers (emergencyWithdraw,
// settable fees up to 20%, an EOA owner) MUST still trip the WARN and MUST still require the
// plain-language ack before a deposit proceeds. If XyloVault ever stopped tripping the WARN,
// that is a BUG — verify-vault.mjs asserts it does.

import { getAddress, formatUnits } from "viem";
import { createHash } from "node:crypto";
import { circle, waitForTx } from "./_circle.mjs";
import { ARC, CONTRACTS, USDC_DECIMALS } from "./_arc.mjs";
import { publicClient } from "./_predict.mjs";
// Shared fact-production primitives (single source of truth; also consumed by scripts/dd/). The
// tri-state UNREADABLE, the selector-in-bytecode primitives, the owner-power catalogue (a UNION —
// see below), and the PURE owner classifier all live there. Transport (the reads) stays here.
import {
  UNREADABLE,
  unread,
  hasSel,
  hasAny,
  POWER_SIGS,
  EIP1967_IMPL_SLOT,
  classifyOwnerType,
} from "../../shared/onchain-facts/index.mjs";

// ── The allowlist. One entry today — recon found exactly one live vault on Arc testnet and no
// registry (see PROGRESS). A vault the agent may run against is a CONFIG decision, exactly like
// bridge destinations (BRIDGE_DESTINATIONS) and swap tokens (SWAP_TOKENS) — never a free-form
// contract address off the wire. Adding one is a line here + an env cap, never arbitrary
// execution. ─────────────────────────────────────────────────────────────────────────────────
//
// ⚠️⚠️ WHAT ADDING AN ENTRY HERE ACTUALLY ARMS. ⚠️⚠️
// The four fail-open defects this warning used to enumerate are FIXED (A and B by the tri-state in
// the reading layer; C and D by telling the truth about what is not checked). The disclosure no
// longer asserts anything it did not establish. What remains is COVERAGE — things the inspector
// cannot see and now says so, which is honest but still limits what a second entry is safe to be:
//
//   1. ⭐ PARTLY CLOSED 2026-08-16 — and the remaining half is narrower than this used to claim.
//      This said "a vault with a WITHDRAWAL QUEUE is not detected". That is no longer true: the DD
//      report scans the `withdrawalDelay` group (`withdrawalDelay()`, `updateWithdrawalDelay`,
//      `initiateWithdrawal`), so a two-step exit now raises a WARN. ⚠️ What is STILL unmeasured is
//      the DURATION — and the locks/cooldowns below. `withdraw.lock/delay/cooldown` remain `null`
//      (UNKNOWN, never "absent"): we can now say a delay mechanism EXISTS, and still cannot say how
//      long you wait. The warn wording says exactly that rather than implying a bound.
//   2. ⭐ SCANNED SINCE STEP 2, BUT DELIBERATELY NOT DISCLOSED — and the distinction now matters.
//      This used to read "DECLARED BUT NOT SCANNED: setStrategy / setFeeRecipient /
//      transferOwnership". That is NO LONGER TRUE: the disclosure comes from the DD report, which
//      checks all nine catalogue groups (measured 13/13 on XyloVault, 2026-08-16) — so the SCAN gap
//      is closed. What remains is a DISCLOSURE decision, recorded per group in POWER_DISCLOSURE.
//      🚨 AND THE MEASUREMENT IS UNCOMFORTABLE: setStrategy (`funds-movement`), setFeeRecipient and
//      transferOwnership are all PRESENT on XyloVault right now and none of them raises a warn. The
//      card is silent about a funds-movement power the owner actually holds. That is a pending
//      decision with a row of its own, not an unknown.
//   3. PROXY COVERAGE IS THE EIP-1967 IMPLEMENTATION SLOT ONLY. No beacon slot, no admin slot, no
//      EIP-1167 clones, no diamonds. A vault behind any of those is scanned as its own stub. It
//      BLOCKs as `not-erc4626` today, which is fail-closed but blind, and excludes most real vaults.
//   4. STILL LOSSY ON A DEGRADED READ: an unreadable totalAssets does not fire the empty-shell
//      BLOCK, and an unreadable performanceFee drops that WARN. See the collapse comment in
//      inspectVault — fail-closed on persistence (the digest moves, live acks die), not on
//      occurrence (a user can still ack the degraded disclosure in the moment).
//
// A second entry — especially a non-proxy vault on mainnet — is what makes these matter. The
// inspector is now honest about its blind spots, but honest ≠ covered.
//
// 📄 READ VAULT_INSPECT_DEFECTS.md BEFORE WIDENING THIS LIST for line refs and the blast-radius
// argument. It is a report with a fix log, not a changelog — check the code, not its status lines.
// ─────────────────────────────────────────────────────────────────────────────────────────────
export const VAULT_ALLOWLIST = {
  "xylo-usdc": {
    key: "xylo-usdc",
    address: "0x240Eb85458CD41361bd8C3773253a1D78054f747", // XyloVault (verified on arcscan)
    label: "XyloNet USDC Vault (xyUSDC)",
    asset: "USDC",
    assetAddress: CONTRACTS.USDC, // the underlying we EXPECT; inspection BLOCKs on a mismatch
    shareSymbol: "xyUSDC",
    chainId: ARC.chainId,
    note: "Testnet dress-rehearsal target. Custom, unaudited ERC-4626 by ForgeLabs.",
  },
};

// Resolve a vault KEY (never an address off the wire) to its allowlist entry, or null.
export function resolveVault(key) {
  const k = String(key ?? "").trim().toLowerCase();
  if (!k) return null;
  return VAULT_ALLOWLIST[k] ?? null;
}

export const SUPPORTED_VAULT_KEYS = Object.keys(VAULT_ALLOWLIST);

// ── Inspection knobs ─────────────────────────────────────────────────────────────────────────
// A CURRENT withdraw fee above this is a BLOCK: a vault charging >1% to exit is not a place we
// deposit on the user's behalf without a hard stop. This is a constant, not env — a safety
// ceiling read from env would be one more fail-open surface, and the whole point here is that a
// bad reading refuses. (The OWNER being able to raise the fee to MAX_FEE is a separate WARN.)
const WITHDRAW_FEE_BLOCK_BPS = 100; // 1.00%
// EIP1967_IMPL_SLOT now imported from shared/onchain-facts (single source of truth).
// Multicall3 (canonical address, deployed on Arc testnet — see Arc docs contract-addresses). The
// value reads go through ONE multicall instead of a burst of ~11 parallel eth_calls: the public
// RPC throttles bursts, and a throttled read that silently returns null would MISREPORT the vault
// (e.g. read totalAssets as 0 and wrongly flag a funded vault as an empty shell). One call, robust.
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Retry a single RPC read a few times before giving up — the public RPC occasionally rejects a
// call under load.
//
// ═══ 🚨 THERE IS NO `fallback` PARAMETER, AND THAT IS THE POINT ═══════════
// It used to take one, and two of seven call sites passed a value that IS a valid reading:
//   `"0x"` for getBytecode  → "this address holds no code" → reported as "not a deployed contract"
//   `null` for a receipt    → "this tx is not mined"       → reported as "your shares are still in
//                                                             the vault"
// Three failed RPC calls became a confident statement about the chain, and about where a user's
// funds are. ⛔ Fixing those two arguments would have left the NEXT call site free to pass `0`,
// `""` or `false`. So the argument is gone: an exhausted retry now returns UNREADABLE — a Symbol
// that is not falsy, equals nothing, is not a bigint, is not an array and throws on arithmetic.
// A caller that ignores it gets a TypeError, not a plausible answer.
//
// ⭐ THE RULE: A RETRY THAT EXHAUSTS MUST RETURN SOMETHING THE CALLER CANNOT MISTAKE FOR A READING.
// The five sites that already passed UNREADABLE / a Symbol are unchanged in behaviour; the two that
// did not are now forced to say what they actually learned, which is nothing.
async function withRetry(fn, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch {
      if (i < tries - 1) await sleep(150 * (i + 1));
    }
  }
  return UNREADABLE;
}

// ── THE THIRD STATE — now shared/onchain-facts ───────────────────────────────────────────────
// UNREADABLE / unread moved to shared/onchain-facts (imported above). A read has THREE outcomes:
// a VALUE, a confirmed ABSENCE (`null`), and UNREADABLE (could not ask). Collapsing the third into
// the second is defects A and B (VAULT_INSPECT_DEFECTS.md). See the shared module for the full rule.

// ── Function signatures we look for ────────────────────────────────────────────────────────
// Conformance is detected by SELECTOR-IN-BYTECODE (works for state-changing functions too — the
// Solidity dispatcher embeds every external selector), never by a block-explorer ABI. That keeps
// the inspector source-independent and mainnet-portable.
const ERC4626_REQUIRED = [
  "asset()",
  "totalAssets()",
  "convertToShares(uint256)",
  "convertToAssets(uint256)",
  "maxDeposit(address)",
  "maxWithdraw(address)",
  "previewDeposit(uint256)",
  "previewRedeem(uint256)",
  "deposit(uint256,address)",
  "mint(uint256,address)",
  "withdraw(uint256,address,address)",
  "redeem(uint256,address,address)",
];

// Owner-power catalogue, selector primitives (sel/hasSel/hasAny) and the owner fingerprints
// (SAFE_SIGS/TIMELOCK_SIGS) now live in shared/onchain-facts. POWER_SIGS imported above is the
// UNION of what all callers scan for — nine groups.
//
// 🚨 THIS INSPECTOR SCANS ONLY FOUR OF THEM — emergencyWithdraw, feesSettable, pausable, upgradeable
// (see the owner-powers section of inspectVault). The other five (setStrategy, setFeeRecipient,
// transferOwnership, denylist, withdrawalDelay) are in the catalogue but are DELIBERATELY NOT
// scanned here. This scan SELECTION is frozen: wiring any of them in raises a new warn code, which
// moves disclosureDigest(), which INVALIDATES every outstanding ack token. That is money-path work
// with its own proof run — never a cleanup. (VAULT_INSPECT_DEFECTS.md, defect D.)

// Minimal single-method ABIs for the value reads (each wrapped in try/catch → null on absence).
const uintFn = (name) => [{ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }];
const addrFn = (name) => [{ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
const strFn = (name) => [{ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }];
const u8Fn = (name) => [{ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }];
const BAL_ABI = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }];
const ALLOWANCE_ABI = [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] }];

async function tryRead(pc, address, abi, functionName, args = []) {
  try {
    return await pc.readContract({ address, abi, functionName, args });
  } catch {
    return null;
  }
}

// Strict balance read for a MONEY WITNESS: retries hard, then THROWS if it still cannot read. It
// never returns a fallback value, because a fabricated balance corrupts a delta silently. This is
// the fix for the 70.772 bug: a withdraw's `usdcBefore` used `?? 0n`, so a single failed read made
// the "amount received" delta equal the wallet's ENTIRE balance. A witness that guesses is not a
// witness — if we cannot read it, we refuse rather than invent a number.
async function readBalanceStrict(pc, token, owner) {
  const v = await withRetry(
    () => pc.readContract({ address: token, abi: BAL_ABI, functionName: "balanceOf", args: [owner] }),
    6
  );
  if (typeof v !== "bigint") throw new Error("balance read failed");
  return v;
}

// Batch many single-return view reads into ONE Multicall3 call. allowFailure → an absent/reverting
// method comes back null (not a thrown call), so a general vault missing withdrawFee()/MAX_FEE()/
// owner() degrades gracefully. Retried as a unit; a total failure yields all-null.
// ⚠️ The two failure modes here are NOT the same thing, and the whole tri-state depends on the
// distinction: a PER-CALL failure is a real observation (the aggregate call succeeded, the chain
// executed this sub-call and it reverted / the method is absent) → `null`. A TOTAL failure means the
// multicall itself never landed after 5 tries, so we learned NOTHING about ANY field → UNREADABLE,
// every entry. Before this, both collapsed to `null` and an RPC outage was indistinguishable from
// eleven confirmed absences.
async function multiRead(pc, calls) {
  const res = await withRetry(
    () => pc.multicall({ allowFailure: true, multicallAddress: MULTICALL3, contracts: calls }),
    5 // this read carries the value fields; a total failure would misreport the vault, so try hard
  );
  if (!Array.isArray(res)) return calls.map(() => UNREADABLE);
  return res.map((r) => (r && r.status === "success" ? r.result : null));
}

// Classify the vault's owner. The owner TYPE decision is the shared, defect-A-free primitive
// (classifyOwnerType, shared/onchain-facts); this wrapper does the reads (transport stays here) and
// attaches _vault's human labels. `renounced` is reachable ONLY from a confirmed zero-address read.
//
// The labels are _vault-specific prose ("...this vault") and stay here on purpose — the shared
// classifier returns type + address only, so one caller's wording can never leak into another's.
// disclosureDigest() depends on the owner TYPE (via warn codes), never on this label text.
const OWNER_LABELS = {
  unreadable: "⚠️ The owner could not be read — who controls this vault is UNKNOWN. This is NOT a renounced or absent owner; the read failed",
  "no-owner-fn": "⚠️ This contract exposes no owner() — ownership is not disclosed by that convention. A role-based admin may still hold every power above",
  renounced: "Ownership renounced (owner is the zero address)",
  "unreadable-kind": "⚠️ The owner's code could not be read — whether it is a single key, a multisig or a timelock is UNKNOWN",
  eoa: "A single externally-owned key (EOA) controls this vault",
  multisig: "Owner is a multisig (Gnosis Safe-shaped)",
  timelock: "Owner is a timelock contract",
  contract: "Owner is a contract (not identified as a known multisig or timelock)",
};
async function classifyOwner(pc, owner) {
  // Read the owner's own bytecode ONLY for a real, non-zero address — the unread / absent / zero
  // classes are decided without it, exactly as before (those paths never touched the chain). Same
  // read, same UNREADABLE fallback; relocated out of the classifier so the classifier can be pure.
  let ownerCode;
  const realAddr = !unread(owner) && owner != null && !/^0x0+$/.test(String(owner));
  if (realAddr) ownerCode = await withRetry(() => pc.getBytecode({ address: getAddress(owner) }));
  const { address, type } = classifyOwnerType(owner, ownerCode);
  return { address, type, label: OWNER_LABELS[type] };
}

// ── INSPECT ────────────────────────────────────────────────────────────────────────────────
// Reads the chain read-only and returns a DISCLOSURE object. Never signs, never writes.
export async function inspectVault(address) {
  const addr = getAddress(address);
  const pc = publicClient();

  // ⛔ THIS READ USED TO PASS `"0x"` AS ITS FALLBACK — the exact value that means "no code here".
  // Three failed RPC calls therefore produced the BLOCK "No bytecode at this address — it is not a
  // deployed contract": a confident, false statement about a third-party address, on the FIRST read
  // of the inspection, in the file whose own header forbids collapsing UNREADABLE into absence.
  const codeRaw = await withRetry(() => pc.getBytecode({ address: addr }));
  const codeUnreadable = unread(codeRaw);
  const code = codeUnreadable ? "0x" : String(codeRaw || "0x").toLowerCase();
  // ⭐ THREE STATES, NOT TWO. `isContract` now means "we read the bytecode and there was some";
  // `codeUnreadable` means "we could not ask". Everything derived from the bytecode — the ERC-4626
  // selector scan below — is meaningless in the third state, so it must not be reported as a finding.
  const isContract = !codeUnreadable && code !== "0x" && code.length > 2;

  // Conformance (bytecode selector scan).
  const missing = isContract ? ERC4626_REQUIRED.filter((s) => !hasSel(code, s)) : ERC4626_REQUIRED.slice();
  const erc4626 = isContract && missing.length === 0;

  // Value reads — ONE multicall (allowFailure), so a burst can't get throttled into false nulls.
  const VALUE_CALLS = [
    { address: addr, abi: addrFn("asset"), functionName: "asset" },
    { address: addr, abi: uintFn("totalAssets"), functionName: "totalAssets" },
    { address: addr, abi: u8Fn("decimals"), functionName: "decimals" },
    { address: addr, abi: strFn("symbol"), functionName: "symbol" },
    { address: addr, abi: strFn("name"), functionName: "name" },
    { address: addr, abi: uintFn("totalSupply"), functionName: "totalSupply" },
    { address: addr, abi: uintFn("withdrawFee"), functionName: "withdrawFee" },
    { address: addr, abi: uintFn("depositFee"), functionName: "depositFee" },
    { address: addr, abi: uintFn("performanceFee"), functionName: "performanceFee" },
    { address: addr, abi: uintFn("MAX_FEE"), functionName: "MAX_FEE" },
    { address: addr, abi: addrFn("owner"), functionName: "owner" },
  ];
  let values = await multiRead(pc, VALUE_CALLS);
  // A null result for a method whose SELECTOR IS PRESENT in the bytecode is a transient RPC
  // failure, not a missing method — re-read rather than misreport (a flaky asset() read must never
  // surface as an "asset-mismatch", and a flaky totalAssets() must never look like an empty shell).
  // asset() is the load-bearing one (drives conformance + the deposit asset-match gate), so we key
  // the re-read on it.
  const assetSelPresent = isContract && hasSel(code, "asset()");
  for (let i = 0; i < 3 && assetSelPresent && (values[0] == null || unread(values[0])); i++) {
    await sleep(250 * (i + 1));
    values = await multiRead(pc, VALUE_CALLS);
  }

  // owner() keeps its THIRD STATE all the way to classifyOwner — it is the field where conflating
  // unreadable with absent produced defect A.
  const ownerRaw = values[10];

  // ⚠️ THE OTHER TEN FIELDS DELIBERATELY COLLAPSE UNREADABLE → null, AND THIS IS NOT "ALSO FIXED".
  // It is safe for these ten only because `null` already renders as UNKNOWN rather than as a safety
  // claim: an unread withdrawFee gives `withdrawFeePct: null` and reversibility "unknown", and the
  // digest records `wf:n`. Nothing here asserts a reassuring fact from an absent read, which is what
  // made A and B defects. TWO known lossy cases remain and are NOT fixed by this change:
  //   · an unreadable totalAssets leaves `isShell` false, so the empty-shell BLOCK does not fire;
  //   · an unreadable performanceFee drops the `performance-fee` WARN from the disclosure.
  // Both are fail-closed on PERSISTENCE (the digest changes, so an outstanding ack stops matching)
  // but not on OCCURRENCE (a user can still ack the degraded disclosure in the moment). Widening
  // them means new warn codes, which moves disclosureDigest() and invalidates every live ack —
  // money-path work that needs its own proof run, exactly like the unscanned powers.
  const collapse = (v) => (unread(v) ? null : v);
  const [assetAddr, totalAssets, decimals, symbol, name, totalSupply, withdrawFee, depositFee, performanceFee, maxFee] =
    values.slice(0, 10).map(collapse);

  const withdrawFeeBps = withdrawFee === null ? null : Number(withdrawFee);
  const depositFeeBps = depositFee === null ? null : Number(depositFee);
  const performanceFeeBps = performanceFee === null ? null : Number(performanceFee);
  const maxFeeBps = maxFee === null ? null : Number(maxFee);
  const totalAssetsUsdc = totalAssets === null ? null : Number(totalAssets) / 10 ** USDC_DECIMALS;
  const isShell = totalAssets !== null && Number(totalAssets) === 0;

  // Owner powers (selector scan) + owner identity.
  const emergency = hasAny(code, POWER_SIGS.emergencyWithdraw);
  const feesSet = hasAny(code, POWER_SIGS.feesSettable);
  const pausable = hasAny(code, POWER_SIGS.pausable).length > 0;
  // Upgradeability: an upgrade selector OR a non-zero EIP-1967 implementation slot.
  const upgradeSel = hasAny(code, POWER_SIGS.upgradeable).length > 0;
  // 🚨 DEFECT B WAS THE FALLBACK ON THIS LINE. It was `null` → falsy → `proxyImpl` false →
  // "Not upgradeable — logic is fixed at this address (no proxy slot, no upgrade function)", a
  // positive claim that the slot was read and found empty, from a read that never landed.
  //
  // ⚠️ AN UNREADABLE SLOT IS A **BLOCK**, NOT A WARN — and that is a stronger rule than it looks.
  // Every selector-derived finding in this whole inspection (conformance, emergency-withdraw,
  // settable fees, pausable) is a scan of THIS address's own bytecode, and is only meaningful if
  // this address is not a delegating proxy. A proxy's stub contains none of the implementation's
  // selectors, so an undetected proxy does not make one field wrong — it makes the entire report a
  // scan of the wrong contract, and reports it as CLEAN. That is the worst output this inspector
  // can produce (proven shape: Circle's GatewayWallet proxy is ~163 bytes with 0 of 5 power
  // selectors; the implementation behind it has 5 of 5).
  //
  // This is also NOT a tightening: a KNOWN proxy already BLOCKs here as `not-erc4626`, because
  // conformance scans the stub. An UNKNOWN proxy status must not be treated more favourably than a
  // confirmed one.
  const implSlotRaw = await withRetry(() => pc.getStorageAt({ address: addr, slot: EIP1967_IMPL_SLOT }));
  // Closed outcome set: anything that is not a string we can test is UNREADABLE, never "empty".
  const proxySlotUnreadable = unread(implSlotRaw) || typeof implSlotRaw !== "string";
  const proxyImpl = !proxySlotUnreadable && !/^0x0*$/.test(implSlotRaw);
  const upgradeable = upgradeSel || proxyImpl;
  const ownerIdentity = await classifyOwner(pc, ownerRaw);

  // Withdraw mechanics. No lock/delay/cooldown selector is a WARN or BLOCK on its own; the fee is
  // reported plainly, and a CURRENT fee over the ceiling is a BLOCK.
  const withdraw = {
    // ⚠️ NOT CHECKED — null means UNKNOWN, never "absent". No selector scan, storage read, or call
    // is performed for withdrawal locks/delays/cooldowns, for ANY vault. These were previously
    // hardcoded `false`, which made the disclosure state "no lock/delay" as an established fact for
    // a check that does not exist (VAULT_INSPECT_DEFECTS.md, defect C). Until the check is written,
    // the honest value is UNKNOWN. Do not compare these with `!x` — that treats unknown as absent,
    // which is the whole bug.
    lock: null,
    delay: null,
    cooldown: null,
    // ⚠️ THE SAME FACT IS NOW ESTABLISHED TWICE — here by this module's own bytecode scan, and in the
    // VERDICT by the DD report (`pausable` warns since 2026-08-16). This field is DISPLAY ONLY and
    // feeds no gate: the warn, the level and the digest all come from the report, so there is one
    // source of truth for the DECISION even though two instruments observe the fact.
    // ⭐ verify-dd-report asserts the two AGREE for the live vault, which turns the duplication into
    // a cross-check rather than a drift risk. If they ever disagree, that is a real finding about one
    // of the two scans — not a cosmetic mismatch.
    pausable,
    withdrawFeeBps,
    withdrawFeePct: withdrawFeeBps === null ? null : `${(withdrawFeeBps / 100).toFixed(2)}%`,
    roundTripRetainedPct: withdrawFeeBps === null ? null : `${((10000 - withdrawFeeBps) / 100).toFixed(2)}%`,
    // Reports ONLY what was measured (the fee), and names what was not (lock/delay/cooldown).
    // It must not say "no lock/delay" or "NOT a one-way trap" — neither was established.
    reversibility:
      withdrawFeeBps === null
        ? "unknown"
        : `A withdraw retains ~${((10000 - withdrawFeeBps) / 100).toFixed(2)}% (a ${(withdrawFeeBps / 100).toFixed(2)}% exit fee). ⚠️ Withdrawal locks, delays and cooldowns are NOT CHECKED by this inspector — whether an exit is immediate is UNKNOWN, not confirmed absent. Exit terms can also be changed by the owner (see owner powers).`,
  };

  const ownerPowers = {
    owner: ownerIdentity.address,
    // eoa | multisig | timelock | contract | renounced | unreadable | unreadable-kind | no-owner-fn
    // ⚠️ `renounced` means a CONFIRMED zero-address read and nothing else. The last three are the
    // classes that used to masquerade as it (defect A) — do not treat them as ownerless.
    ownerIdentity: ownerIdentity.type,
    ownerIdentityLabel: ownerIdentity.label,
    settableFees: {
      present: feesSet.length > 0,
      via: feesSet,
      currentBps: { deposit: depositFeeBps, withdraw: withdrawFeeBps, performance: performanceFeeBps },
      maxBps: maxFeeBps,
      maxPct: maxFeeBps === null ? null : `${(maxFeeBps / 100).toFixed(2)}%`,
      note:
        feesSet.length > 0
          ? `The owner can change fees${maxFeeBps !== null ? ` up to a hard cap of ${(maxFeeBps / 100).toFixed(2)}%` : ""}. Your exit fee could be raised after you deposit.`
          : "No fee-setter found.",
    },
    emergencyWithdraw: {
      present: emergency.length > 0,
      via: emergency,
      note:
        emergency.length > 0
          ? "The owner can withdraw tokens from the vault directly — including the underlying USDC. This is a drain/rug vector: if exercised, your withdraw could fail because the funds are gone. Strictly worse than an irreversible-deposit trap, because there the funds at least remain yours."
          : "No owner emergency-withdraw / sweep found.",
    },
    upgradeable: {
      // `present` is TRI-STATE: true / false / null. null means UNKNOWN — never read it as "no".
      present: upgradeSel ? true : proxySlotUnreadable ? null : proxyImpl,
      viaSelector: upgradeSel,
      viaProxySlot: proxySlotUnreadable ? null : proxyImpl,
      proxySlotUnreadable,
      note: proxySlotUnreadable
        ? "⚠️ Whether this address is a proxy could NOT be determined — the EIP-1967 implementation slot was not read. This is not a claim that the slot is empty. Because every finding above comes from scanning THIS address's bytecode, and a proxy holds its logic elsewhere, the whole inspection is unverified while this is unknown."
        : upgradeable
          ? "The vault's logic can be replaced (proxy/upgradeable). Its rules can change without moving your funds."
          : "Not upgradeable — logic is fixed at this address (no proxy slot, no upgrade function).",
    },
    pausable: {
      present: pausable,
      note: pausable ? "The vault can be paused; deposits/withdrawals may be halted." : "No pause function found — withdrawals cannot be frozen by a pause switch.",
    },
  };

  // ── VERDICT ──────────────────────────────────────────────────────────────────────────────
  const blocks = [];
  const warns = [];
  // 🚨 THE UNREADABLE CASE BLOCKS ON ITS OWN TERMS. It must not borrow "not-a-contract"'s sentence:
  // that one asserts a fact about the chain, and an unread byte range establishes nothing about it.
  // Both refuse the deposit — the difference is what the user is told, and whether they are led to
  // believe a legitimate vault is fake.
  if (codeUnreadable) {
    blocks.push({
      code: "bytecode-unreadable",
      detail:
        "Could not read this address's bytecode after several attempts, so whether it is a contract " +
        "at all is UNKNOWN. Every check below reads that bytecode, so none of them ran. This is not " +
        "a finding about the vault — it is the absence of one.",
    });
  } else if (!isContract) {
    blocks.push({ code: "not-a-contract", detail: "No bytecode at this address — it is not a deployed contract." });
  }
  if (isContract && !erc4626) blocks.push({ code: "not-erc4626", detail: `Missing ERC-4626 methods: ${missing.join(", ")}.` });
  if (isShell) blocks.push({ code: "empty-shell", detail: "totalAssets() is 0 — the vault holds nothing; a deposit would be the only funds in it." });
  if (withdrawFeeBps !== null && withdrawFeeBps > WITHDRAW_FEE_BLOCK_BPS)
    blocks.push({ code: "withdraw-fee-too-high", detail: `Current withdraw fee ${(withdrawFeeBps / 100).toFixed(2)}% exceeds the ${(WITHDRAW_FEE_BLOCK_BPS / 100).toFixed(2)}% ceiling.` });

  // 🚨 DEFECT B (see the implementation-slot read): an unreadable proxy status invalidates every
  // selector-derived finding in this report, so it BLOCKS rather than warns. Blocks are not part of
  // disclosureDigest() and do not need to be — gateDeposit() refuses on BLOCK before the ack is
  // consulted, so there is no disclosure for a user to acknowledge their way past.
  if (proxySlotUnreadable)
    blocks.push({ code: "proxy-status-unreadable", detail: "Could not read the EIP-1967 implementation slot, so whether this address is a proxy is UNKNOWN. Every check above scans this address's own bytecode and would report a proxy stub as clean, so the inspection cannot be trusted. Refusing rather than disclosing an unverified vault." });

  // ═══ ⭐⭐ THE SEVEN MIGRATED WARNS ARE GONE FROM HERE — STEP 2 IS DONE ════════════════════════
  // `emergency-withdraw`, `fees-settable`, `upgradeable` and the four owner-identity codes are now
  // derived by `applyReportDisclosure()` from the DD report. They were RETAINED and marked
  // `deleteWhen: "gateDeposit reads … from the DD report"`; that condition is now met, so they go.
  //
  // 🚨 AND THE ORDER MATTERED. Deleting them BEFORE the gate read the report would have dropped
  // `level` from WARN to OK for a vault whose only warns were these — a deposit proceeding with no
  // acknowledgement at all. The gate now REFUSES any inspection that has not been through
  // `applyReportDisclosure`, so there is no window in which nothing covers them.
  //
  // ⚠️ `performance-fee` STAYS. It derives from a fee VALUE the report does not read, so it has no
  // replacement and never had a `deleteWhen`.
  if (performanceFeeBps !== null && performanceFeeBps > 0) warns.push({ code: "performance-fee", detail: `A ${(performanceFeeBps / 100).toFixed(2)}% performance fee is taken on harvested yield.` });

  const level = blocks.length ? "BLOCK" : warns.length ? "WARN" : "OK";

  return {
    address: addr,
    chainId: ARC.chainId,
    conformance: { isContract, erc4626, missingMethods: missing },
    asset: {
      address: assetAddr ? getAddress(assetAddr) : null,
      symbol: assetAddr && getAddress(assetAddr) === getAddress(CONTRACTS.USDC) ? "USDC" : null,
      isUsdc: !!assetAddr && getAddress(assetAddr) === getAddress(CONTRACTS.USDC),
    },
    funded: {
      totalAssets: totalAssets === null ? null : totalAssets.toString(),
      totalAssetsUsdc,
      shareSymbol: symbol,
      shareName: name,
      shareDecimals: decimals === null ? null : Number(decimals),
      totalSupply: totalSupply === null ? null : totalSupply.toString(),
      isShell,
    },
    withdraw,
    ownerPowers,
    verdict: { level, blocks, warns },
  };
}

// ═══ ⭐⭐ STEP 2 — THE DISCLOSURE NOW COMES FROM THE DD REPORT ════════════════════════════════
//
// `inspectVault` no longer derives the seven migrated warns. They are derived HERE, from the same
// signed artifact `/api/dd-analyze` sells and `/api/agent-dd-report` shows the owner — so the card
// and the deposit gate cannot disagree about what a vault's owner can do. They read one object.
//
// ⭐ PURE, OVER VALUES THE CALLER ALREADY FETCHED — the rule this whole module follows. The report
// arrives as a parameter; nothing here touches the wire. That is also what keeps `_vault.mjs` free
// of a dependency on the analyze engine's transport.
//
// ═══ 🚨 EVERY WAY THE REPORT CAN FAIL TO ESTABLISH SOMETHING IS A **BLOCK** ═══════════════════
// This is the whole risk of the migration, and it runs in one direction only. Before, the powers
// came from a scan that always produced an answer. Now they come from a second subsystem that can
// be missing, stale, about the wrong contract, or a refusal — and every one of those must refuse
// the deposit rather than resolve to "no powers found".
//
//   · no report            → BLOCK. An absent report is not an absence of powers.
//   · report.refusal       → BLOCK. A refusal established NOTHING; it is indeterminate, not clean.
//   · different address    → BLOCK. 🚨 A report about another contract would disclose another
//                            contract's powers under this vault's name — the single most dangerous
//                            shape available here, and the reason subject binding is asserted
//                            rather than assumed.
//   · different chainId    → BLOCK. The same address holds different code on different chains.
//   · a power group in `notChecked` → a WARN naming it. Not established is NOT absent.
//
// ⚠️ THE COST, STATED PLAINLY: the deposit path now depends on the analyze engine, which is ~9 RPC
// calls through a quorum against an RPC that has throttled this repo. An engine outage BLOCKS
// deposits that previously succeeded. That is fail-closed and correct — `proxy-status-unreadable`
// already blocks on an unreadable read for the same reason — but it is a real availability trade
// and it is written down rather than discovered.
//
// ⚠️ THIS IS A MIGRATION, NOT A WIDENING. Exactly the same three power warns and four owner warns
// as before. The report also knows about `denylist`, `setStrategy`, `setFeeRecipient`,
// `transferOwnership`, `pausable` and `withdrawalDelay` — `denylist` in particular can freeze a
// holder's funds — and warning on those would be a genuine improvement AND a behaviour change that
// makes more vaults require an ack. That is a decision to take deliberately, not a side effect of
// moving where these seven come from.

/**
 * ⭐⭐ THE DISCLOSURE DECISION FOR **EVERY** CATALOGUE GROUP — including the ones that do NOT warn.
 *
 * The previous shape listed only the groups that warn, which meant the other six were excluded by
 * SILENCE. Nothing recorded that a decision had been taken about them, and — the part that actually
 * bites — a TENTH group added to `POWER_SIGS` later would have been excluded automatically, by an
 * omission nobody wrote. That is absence-reads-as-safe aimed at the disclosure itself.
 *
 * ⭐ So every group appears here with an explicit `warn`, and a non-warning group must say WHY.
 * `assertDisclosureComplete()` (called at module load) throws if this table and the catalogue ever
 * disagree in either direction — a new power cannot reach a user's vault card by default, and a
 * deleted one cannot leave a stale row behind.
 *
 * ⚠️ THE THROW IS AT MODULE LOAD, ON THE MONEY PATH, DELIBERATELY. It can only fire on a code-level
 * inconsistency between two constants in this repo, which every test run catches long before a
 * deploy. Taking the vault path DOWN is the correct failure: the alternative is serving a disclosure
 * that silently omits a power somebody added to the catalogue on purpose.
 */
export const POWER_DISCLOSURE = Object.freeze({
  // ── warns ──────────────────────────────────────────────────────────────────────────────────
  emergencyWithdraw: { warn: true, code: "emergency-withdraw",
    detail: "The owner can withdraw assets outside the normal redeem path." },
  feesSettable: { warn: true, code: "fees-settable",
    detail: "The owner can change fees, up to the contract's maximum." },
  upgradeable: { warn: true, code: "upgradeable",
    detail: "The implementation can be replaced, changing every rule above." },
  // ⭐⭐ ADDED 2026-08-16 — THE DENYLIST WIDENING, a deliberate behaviour change and not a migration.
  // A denylist is not about what the owner can take; it is about whether YOU can leave. A holder who
  // is denylisted may be unable to withdraw their own funds while every other disclosure on the card
  // still reads as normal — the vault is solvent, the fees are fine, and the exit is shut for you
  // specifically. That asymmetry is why it belongs in the acknowledged set.
  denylist: { warn: true, code: "denylist",
    detail: "The owner can block specific addresses. A blocked holder may be unable to withdraw their own funds, while the vault continues to look healthy to everyone else." },

  // ── deliberately silent, each for its own reason ────────────────────────────────────────────
  // ⭐⭐ ADDED 2026-08-16 — CONSISTENCY, NOT EXPANSION. `setStrategy` carries severity
  // `funds-movement`, the SAME class as `emergencyWithdraw`, which has always warned. Two powers in
  // one severity class, one disclosed and one silent, is not a threshold — it is an inconsistency,
  // and it was silent on the live vault while the card claimed to disclose what the owner can do.
  setStrategy: { warn: true, code: "set-strategy",
    detail: "The owner can change where the vault's assets are deployed. Your funds can be moved into a different strategy without your consent." },

  // ── deliberately silent, each decided on its own terms ─────────────────────────────────────
  // ⭐⭐ transferOwnership DOES NOT WARN, AND THE REASON IS THAT A WARN WOULD NOT FIX ITS PROBLEM.
  // It adds no power; it makes the OWNER-IDENTITY disclosure PERISHABLE — the holder you
  // acknowledged can be replaced and the card's claim about who holds these powers silently becomes
  // false. A warn would say "this can happen" once, at acknowledgement time, and then never fire
  // again when it actually did. ⭐ THE FIX IS IN THE DIGEST: `holder` and `holderKind` are digest
  // inputs (see disclosureDigest v2), so an ownership transfer invalidates every outstanding
  // acknowledgement at the moment the holder ACTUALLY changes — which is the right trigger, and the
  // one a warn cannot provide.
  transferOwnership: { warn: false,
    why: "Adds no power; it makes the owner-identity claim perishable. Handled in the DIGEST instead — holder/holderKind are digest inputs, so an ack dies when the holder actually changes. A warn would fire once at ack time and never when it mattered." },
  // ⭐ DECIDED ON ITS OWN TERMS, not deferred. It redirects WHERE fees go, which is a matter between
  // the owner and a recipient. The DEPOSITOR's exposure is the fee AMOUNT, and that is already
  // covered by `feesSettable`. ⚠️ Warning on it would add a line that does not change what a
  // depositor stands to lose — and this card's value depends on every line mattering.
  setFeeRecipient: { warn: false,
    why: "Redirects WHERE fees go, between owner and recipient. The depositor's exposure is the fee AMOUNT, already covered by feesSettable. A line that changes nothing for the depositor is noise on a card whose value depends on every line mattering." },
  // ⭐⭐ DECIDED 2026-08-16 — BOTH WARN, and both for the SAME reason: they are the exit path.
  //
  // `denylist` was admitted on the argument that it is "not about what the owner can TAKE; it is
  // about whether YOU can leave". These two are the rest of that argument. A pause and a withdrawal
  // queue reach the same outcome — your funds stay put — by different routes.
  //
  // ⚠️ AND SELECTOR PRESENCE CANNOT ESTABLISH THE BENIGN READING, which is what settles it. We can
  // see `pause()`; we CANNOT see whether the pause spares withdrawals. We can see `withdrawalDelay()`;
  // we CANNOT see whether the delay is an hour or unbounded. Staying silent would assert the
  // comfortable half of an unknown — the exact fail-open family this whole module exists to close.
  // The wording therefore says what was found AND what could not be established.
  //
  // ⚠️ UBIQUITY IS NOT A REASON TO HIDE A MATERIAL FACT. A pause is near-universal good practice, so
  // this warn will fire on most well-built vaults. That makes the disclosure often non-empty, which
  // is honest; it does not make the fact less true. The `setFeeRecipient` test is MATERIALITY — does
  // it change what a depositor stands to lose — and an exit that can be closed plainly does.
  pausable: { warn: true, code: "pausable",
    detail: "The owner can pause this vault. We can see the pause switch but NOT what it halts — if it covers withdrawals, you cannot exit while it is on." },
  withdrawalDelay: { warn: true, code: "withdrawal-delay",
    detail: "Withdrawals are not a single call: this vault has a delay or two-step queue. We can see the mechanism but NOT how long the wait is, and nothing establishes an upper bound." },
});

/** 🚨 Catalogue and disclosure must account for each other, in BOTH directions. */
export function assertDisclosureComplete(sigs = POWER_SIGS, table = POWER_DISCLOSURE) {
  const missing = Object.keys(sigs).filter((g) => !(g in table));
  const stale = Object.keys(table).filter((g) => !(g in sigs));
  if (missing.length || stale.length) {
    throw new Error(
      `POWER_DISCLOSURE is out of step with the power catalogue — ` +
      `${missing.length ? `no disclosure decision for: ${missing.join(", ")}. ` : ""}` +
      `${stale.length ? `decision for non-existent group(s): ${stale.join(", ")}. ` : ""}` +
      `Every catalogue group must be either warned on or explicitly silent WITH A REASON.`
    );
  }
  const unexplained = Object.entries(table).filter(([, d]) => !d.warn && (!d.why || d.why.length < 20)).map(([g]) => g);
  if (unexplained.length) {
    throw new Error(`POWER_DISCLOSURE: silent group(s) with no stated reason: ${unexplained.join(", ")}`);
  }
  return true;
}
assertDisclosureComplete();

/** The warning subset, DERIVED so it can never drift from the decision table above. */
export const REPORT_POWER_WARNS = Object.freeze(Object.fromEntries(
  Object.entries(POWER_DISCLOSURE).filter(([, d]) => d.warn).map(([g, d]) => [g, { code: d.code, detail: d.detail }])
));

/** Owner kind → warn. ⭐ `multisig`, `timelock` and `renounced` raise none, exactly as before. */
export const REPORT_OWNER_WARNS = Object.freeze({
  eoa: { code: "owner-is-eoa", detail: "The owner is an externally-owned account. A single compromised key can exercise every owner power above." },
  contract: { code: "owner-is-unidentified-contract", detail: "The owner is a contract we could not identify as a multisig or timelock." },
  unreadable: { code: "owner-unreadable", detail: "The owner could not be read. Treat every owner power above as held by an unknown party." },
  "unreadable-kind": { code: "owner-unreadable", detail: "The owner address is known but its code could not be read, so who holds these powers is unknown." },
  "no-owner-fn": { code: "owner-not-exposed", detail: "This contract exposes no owner(). That is NOT proof it is ownerless — a role-based admin holds every power without one." },
});

/**
 * Merge the DD report's disclosure into an inspection. Returns a NEW inspection.
 *
 * ⭐⭐ THE RESULT CARRIES `disclosure.source`, AND `gateDeposit` REFUSES WITHOUT IT. That flag is
 * what makes the migration safe by construction rather than by every call site remembering: an
 * inspection that never went through here CANNOT be gated on, so there is no path where the powers
 * silently go undisclosed. Tested by calling the gate with a raw inspection.
 */
export function applyReportDisclosure(inspection, report) {
  const blocks = [...(inspection?.verdict?.blocks ?? [])];
  const warns = [...(inspection?.verdict?.warns ?? [])];
  const addr = String(inspection?.address ?? "").toLowerCase();

  const refuse = (code, detail) => ({
    ...inspection,
    verdict: { level: "BLOCK", blocks: [...blocks, { code, detail }], warns },
    disclosure: { source: "report", established: false, reason: code },
  });

  if (!report || typeof report !== "object") {
    return refuse("dd-report-missing",
      "No due-diligence report was supplied, so the owner's powers were not established. An absent report is not an absence of powers.");
  }
  if (report.refusal) {
    return refuse("dd-report-indeterminate",
      `The due-diligence report is a refusal (${report.refusal.reason}) — it established nothing about this contract. This is INDETERMINATE, not a clean bill.`);
  }
  const subj = String(report?.subject?.address ?? "").toLowerCase();
  if (!subj || subj !== addr) {
    return refuse("dd-report-subject-mismatch",
      `The report describes ${subj || "an unknown address"}, not ${addr}. Refusing rather than disclosing another contract's powers under this vault's name.`);
  }
  if (inspection?.chainId != null && report?.subject?.chainId != null &&
      Number(report.subject.chainId) !== Number(inspection.chainId)) {
    return refuse("dd-report-chain-mismatch",
      `The report is for chain ${report.subject.chainId}, not ${inspection.chainId}. The same address holds different code on different chains.`);
  }

  // ── the powers ────────────────────────────────────────────────────────────────────────────
  const present = new Set(Array.isArray(report.powersPresent) ? report.powersPresent : []);
  const groupOf = (e) => e?.group ?? (typeof e?.id === "string" && e.id.startsWith("power:") ? e.id.slice(6) : null);
  const notChecked = new Set((report?.coverage?.notChecked ?? []).map(groupOf).filter(Boolean));

  const unestablished = [];
  for (const [group, w] of Object.entries(REPORT_POWER_WARNS)) {
    // ⚠️ NOT-CHECKED IS TESTED BEFORE PRESENT — the same ordering evaluatePolicy uses, and for the
    // same reason: asking `present` first lets an unchecked group fall through to "absent".
    if (notChecked.has(group)) { unestablished.push(group); continue; }
    if (present.has(group)) warns.push({ code: w.code, detail: w.detail, from: "dd-report" });
  }
  if (unestablished.length) {
    warns.push({
      code: "owner-powers-unreadable",
      detail: `These owner powers could not be established: ${unestablished.join(", ")}. Not established is NOT absent — treat them as possibly present.`,
      from: "dd-report",
    });
  }

  // ── the owner ─────────────────────────────────────────────────────────────────────────────
  // ⚠️ AN UNRECOGNISED KIND IS NOT A SILENT PASS. `multisig`/`timelock`/`renounced`/`not-applicable`
  // deliberately raise nothing; anything OUTSIDE the whole known set means the vocabulary moved
  // underneath us and the safe reading is "we do not know who holds these powers".
  const KNOWN_QUIET = new Set(["multisig", "timelock", "renounced", "not-applicable"]);
  const kind = report?.owner?.kind ?? null;
  const ow = REPORT_OWNER_WARNS[kind];
  if (ow) warns.push({ code: ow.code, detail: ow.detail, from: "dd-report" });
  else if (!KNOWN_QUIET.has(kind)) {
    warns.push({
      code: "owner-unreadable",
      detail: `The report classified the owner as ${JSON.stringify(kind)}, which this gate does not recognise. Treating the holder as unknown rather than assuming it is benign.`,
      from: "dd-report",
    });
  }

  return {
    ...inspection,
    verdict: { level: blocks.length ? "BLOCK" : warns.length ? "WARN" : "OK", blocks, warns },
    disclosure: {
      source: "report",
      established: true,
      reportSubject: subj,
      // ⭐⭐ THE HOLDER IS A DISCLOSURE INPUT, because it is a DIGEST input (v2). Carried here so
      // `disclosureDigest` never has to reach back into the report, and so the value the ack is
      // bound to is the value that was displayed.
      holder: report?.owner?.address ? String(report.owner.address).toLowerCase() : null,
      holderKind: kind ?? null,
      reportBlock: report?.subject?.blockNumber ?? null,
      reportSources: report?.sources?.mode ?? null,
      // ⚠️ A SPLIT RIDES ALONG. It bears on every fact above, not just the slot that split.
      providerDisagreement: report?.sources?.integrity?.providerDisagreement ?? null,
    },
  };
}

// ── ACK TOKEN (fail-closed) ────────────────────────────────────────────────────────────────
// The ack is bound to the SPECIFIC disclosure the user saw. It is a deterministic digest over
// the vault + its warn codes + its current fees. So:
//   · a missing or malformed ack REFUSES (fail-closed),
//   · an ack for a DIFFERENT disclosure (warns or fees changed since it was issued) no longer
//     matches → REFUSES, forcing a re-review. You cannot pre-mint an ack that survives the vault
//     getting worse.
export function disclosureDigest(inspection) {
  const warnCodes = [...(inspection?.verdict?.warns ?? [])].map((w) => w.code).sort().join(",");
  const wf = inspection?.withdraw?.withdrawFeeBps ?? "n";
  const df = inspection?.ownerPowers?.settableFees?.currentBps?.deposit ?? "n";
  // ═══ ⭐⭐ v2 — THE HOLDER IS IN THE DIGEST ═══════════════════════════════════════════════════
  // 🚨 THE HOLE v1 HAD. The digest was `address | warn codes | withdrawFee | depositFee`, and THE
  // OWNER WAS NOT IN IT. So an ownership transfer from one EOA to a DIFFERENT EOA left every input
  // identical — the warn code is still `owner-is-eoa` — the digest did not move, and an
  // acknowledgement taken against "the owner is 0xABC" stayed valid for a vault now owned by 0xDEF.
  // The user acked a holder claim that had silently become false.
  //
  // ⚠️ AND IT FAILED ASYMMETRICALLY, WHICH IS WORSE THAN FAILING ALWAYS. EOA → multisig DID move the
  // digest, because the warn code disappeared. So the transitions that changed the disclosure's
  // CHARACTER invalidated acks, while the transitions that merely changed WHO HOLDS THE KEYS did
  // not — exactly backwards from what a depositor cares about.
  //
  // ⭐ BOTH ADDRESS AND KIND. `renounced` is address 0x000…0 while `no-owner-fn` has no address at
  // all; without the kind those two would be distinguishable only by a null, and "we asked and there
  // is no owner()" must never collapse into "ownership was renounced".
  // ⚠️ `none` is an explicit marker, not an empty string — an absent holder must not render as a
  // prefix of, or collide with, any real value.
  const holder = inspection?.disclosure?.holder ?? "none";
  const holderKind = inspection?.disclosure?.holderKind ?? "none";
  return `${String(inspection?.address ?? "").toLowerCase()}|warns:${warnCodes}|wf:${wf}|df:${df}|holder:${holder}|kind:${holderKind}|v2`;
}
export function ackTokenFor(inspection) {
  return createHash("sha256").update(disclosureDigest(inspection)).digest("hex");
}

// ── GATE ───────────────────────────────────────────────────────────────────────────────────
// The deposit gate. Given a FRESH inspection (the caller re-inspects at execute time), decide:
//   BLOCK          → refuse outright.
//   WARN + no/bad ack → refuse (fail-closed): the user must acknowledge the disclosure first.
//   WARN + valid ack  → allow.
//   OK             → allow.
// `expectedAssetAddress` folds in the deposit-context asset check: the allowlisted vault's
// on-chain asset() MUST match what we allowlisted, else BLOCK (defense in depth).
export function gateDeposit({ inspection, ackToken, expectedAssetAddress }) {
  // ═══ 🚨🚨 THE MIGRATION'S SAFETY CATCH — FAIL-CLOSED BY CONSTRUCTION ═════════════════════════
  // Since step 2, the owner powers and the holder's identity come from the DD report via
  // `applyReportDisclosure`. An inspection that never went through it carries NONE of them, and its
  // `warns` would therefore look reassuringly short — a deposit sailing through on a disclosure that
  // silently omits every power the owner holds.
  //
  // ⭐ SO THE GATE REQUIRES THE FLAG RATHER THAN TRUSTING CALL SITES TO REMEMBER. This is the one
  // check that makes deleting the seven warns safe: there is no path from a raw inspection to an
  // approved deposit. ⚠️ Asserted by CALLING the gate with a raw inspection, not by grepping.
  if (inspection?.disclosure?.source !== "report") {
    return {
      ok: false,
      blocked:
        "the vault disclosure has not been established from a due-diligence report — refusing rather " +
        "than depositing against a disclosure that omits the owner's powers",
      disclosure: {
        level: "BLOCK",
        blocks: [{ code: "disclosure-not-established", detail: "applyReportDisclosure() was not applied to this inspection." }],
        warns: [],
        digest: null,
        withdrawFeeBps: inspection?.withdraw?.withdrawFeeBps ?? null,
        depositFeeBps: inspection?.ownerPowers?.settableFees?.currentBps?.deposit ?? null,
      },
    };
  }
  // ⭐⭐ THE DISCLOSURE CARRIES EVERY INPUT ITS OWN DIGEST IS COMPUTED FROM.
  //
  // `disclosureDigest` is `address | warn codes | withdrawFee | depositFee`. Shipping only
  // {level, blocks, warns, digest} meant a consumer could see the digest MOVE and be unable to say
  // WHY — a fee-only change is invisible, because the fees were never in the payload.
  //
  // ⚠️ THAT MATTERS BECAUSE A MOVED DIGEST INVALIDATES AN ACKNOWLEDGEMENT. Telling a user "this
  // changed, look again" without showing WHAT changed leaves them to diff two things they cannot
  // see, and a re-tick nobody can check is a formality — trained click-through, which this codebase
  // has already recorded as a hazard. The digest's inputs must travel with it or the change cannot
  // be explained.
  const disclosure = {
    level: inspection.verdict.level,
    blocks: [...inspection.verdict.blocks],
    warns: [...inspection.verdict.warns],
    digest: disclosureDigest(inspection),
    // The remaining digest inputs. `address` is already known to any caller.
    withdrawFeeBps: inspection?.withdraw?.withdrawFeeBps ?? null,
    depositFeeBps: inspection?.ownerPowers?.settableFees?.currentBps?.deposit ?? null,
    // ⭐⭐ ADDED WITH v2, AND NOT OPTIONAL. Shipping a new digest input WITHOUT shipping the input
    // itself would recreate the `unexplained` case that 63e7dac fixed: the digest moves, the ack
    // dies, and the panel can show the user nothing that accounts for it. An ownership transfer is
    // precisely the change most worth explaining, so it must be the most explainable.
    holder: inspection?.disclosure?.holder ?? null,
    holderKind: inspection?.disclosure?.holderKind ?? null,
  };

  // Asset mismatch is a hard BLOCK, evaluated here because only the deposit context knows the
  // expected underlying.
  if (expectedAssetAddress) {
    const on = inspection.asset?.address ? getAddress(inspection.asset.address) : null;
    if (!on || on !== getAddress(expectedAssetAddress)) {
      disclosure.level = "BLOCK";
      disclosure.blocks = [...disclosure.blocks, { code: "asset-mismatch", detail: `Vault underlying ${on ?? "unknown"} does not match the expected ${getAddress(expectedAssetAddress)}.` }];
    }
  }

  if (disclosure.level === "BLOCK") {
    const reasons = disclosure.blocks.map((b) => `${b.code} (${b.detail})`).join("; ");
    return { ok: false, blocked: `vault failed inspection: ${reasons}`, disclosure };
  }

  if (disclosure.level === "WARN") {
    if (typeof ackToken !== "string" || !/^[0-9a-f]{64}$/.test(ackToken)) {
      return { ok: false, blocked: "this vault has owner-power warnings you must acknowledge before depositing (acknowledgment missing or malformed)", disclosure };
    }
    const expected = ackTokenFor(inspection);
    if (ackToken !== expected) {
      return { ok: false, blocked: "your acknowledgment does not match the vault's current disclosure — re-review and acknowledge again before depositing", disclosure };
    }
  }

  return { ok: true, disclosure };
}

// ── MOVE: DEPOSIT (approve → deposit) — mirrors _bridge.mjs:165–192 ───────────────────────────
// Reuses the bridge's on-chain approve→call pattern: read allowance, approve only if short, then
// the deposit call, each awaited via waitForTx. Receipt is verified by SHARE-BALANCE DELTA (not a
// computed share count) — XyloVault reports decimals()=18 while its supply tracks ~1:1 in 6-dec
// terms, so we trust the chain delta, exactly as the swap receipt does.
const toMinor = (usdc) => BigInt(Math.round(Number(usdc) * 10 ** USDC_DECIMALS));

export async function vaultDeposit({ walletAddress, vault, amountUsdc }) {
  const owner = getAddress(walletAddress);
  const vaultAddr = getAddress(vault.address);
  const amountMinor = toMinor(amountUsdc);
  const client = circle();
  const pc = publicClient();

  const sharesBefore = (await tryRead(pc, vaultAddr, BAL_ABI, "balanceOf", [owner])) ?? 0n;

  // 1) Ensure allowance ≥ amount (on-chain approve — SCA-safe, no permit). Same as the bridge.
  const allowance = (await tryRead(pc, getAddress(vault.assetAddress), ALLOWANCE_ABI, "allowance", [owner, vaultAddr])) ?? 0n;
  if (BigInt(allowance) < amountMinor) {
    const apTx = await client.createContractExecutionTransaction({
      walletAddress,
      blockchain: ARC.blockchain,
      contractAddress: vault.assetAddress,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [vaultAddr, amountMinor.toString()],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    await waitForTx(client, apTx.data?.id);
  }

  // 2) deposit(assets, receiver=self).
  const depTx = await client.createContractExecutionTransaction({
    walletAddress,
    blockchain: ARC.blockchain,
    contractAddress: vaultAddr,
    abiFunctionSignature: "deposit(uint256,address)",
    abiParameters: [amountMinor.toString(), owner],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const depHash = await waitForTx(client, depTx.data?.id);

  const sharesAfter = (await tryRead(pc, vaultAddr, BAL_ABI, "balanceOf", [owner])) ?? sharesBefore;
  const sharesReceived = BigInt(sharesAfter) - BigInt(sharesBefore);

  return {
    depositHash: depHash,
    depositTx: `${ARC.explorer}/tx/${depHash}`,
    amountUsdc: Number(amountUsdc),
    sharesReceivedRaw: sharesReceived.toString(),
    verifiedBy: "share-balance-delta",
    shareSymbol: vault.shareSymbol,
  };
}

// ── MOVE: WITHDRAW (redeem) — single call, NO approve ────────────────────────────────────────
// redeem(shares, receiver=self, owner=self). msg.sender == owner, so the vault's allowance path
// is skipped (see XyloVault source). `shares` is in the share token's base units (raw).
//
// `usdcReceived` is the REAL on-chain USDC balance delta of the SCA (after − before), read from the
// chain — never a shares×price estimate, never an SDK-returned figure. Same balance-delta-as-witness
// discipline as the swap and deposit receipts. Returns a discriminated result:
//   { confirmed: true,  usdcReceived, withdrawTx, … }  — mined status:success AND a real +delta read
//   { confirmed: false, reason, withdrawHash? }        — anything unproven; the caller reports failure
// It NEVER returns a computed/placeholder amount for an unproven reclaim (that was the 70.772 bug and
// yesterday's "received ? USDC").
export async function vaultWithdraw({ walletAddress, vault, shares }) {
  const owner = getAddress(walletAddress);
  const vaultAddr = getAddress(vault.address);
  const assetAddr = getAddress(vault.assetAddress);
  const client = circle();
  const pc = publicClient();

  // WITNESS #1 (fail-closed): USDC balance BEFORE. If we cannot read it we cannot form a truthful
  // delta, so we refuse BEFORE signing — nothing is submitted, the shares are untouched.
  let usdcBefore;
  try {
    usdcBefore = await readBalanceStrict(pc, assetAddr, owner);
  } catch {
    return { confirmed: false, reason: "couldn't read your balance to verify the reclaim — not attempted; your shares are unchanged" };
  }

  const redTx = await client.createContractExecutionTransaction({
    walletAddress,
    blockchain: ARC.blockchain,
    contractAddress: vaultAddr,
    abiFunctionSignature: "redeem(uint256,address,address)",
    abiParameters: [String(shares), owner, owner],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const redHash = await waitForTx(client, redTx.data?.id); // COMPLETE → hash; FAILED/timeout → throws

  // The redeem must be MINED with status:success on-chain. (For an ERC-4337 SCA the OUTER tx can be
  // 'success' while the inner redeem reverted and moved nothing — WITNESS #2 below catches that.)
  // ═══ 🚨 AN UNREADABLE RECEIPT IS NOT AN UNMINED ONE, AND IT MUST NOT SKIP WITNESS #2 ══════
  // This read used to fall back to `null`, which is exactly what "this tx is not mined" looks like.
  // Six failed reads therefore returned "your shares are still in the vault" — a positive claim
  // about WHERE THE USER'S FUNDS ARE, made from an absence nobody observed. If the redeem had in
  // fact succeeded, that sentence was false about the one thing the user cares about.
  //
  // ⭐ AND THE EARLY RETURN MADE IT UNFALSIFIABLE. WITNESS #2 — the USDC balance delta — can settle
  // this without any receipt at all, and it sat below a `return` that fired first. An unreadable
  // receipt now FALLS THROUGH to the witness that can answer, instead of guessing in its place.
  const receipt = await withRetry(() => pc.getTransactionReceipt({ hash: redHash }), 6);
  const receiptUnreadable = unread(receipt);
  if (!receiptUnreadable && (!receipt || receipt.status !== "success")) {
    return { confirmed: false, withdrawHash: redHash, reason: "reclaim didn't confirm on-chain — your shares are still in the vault" };
  }

  // WITNESS #2 (fail-closed): USDC balance AFTER. The delta is the truth of what returned.
  let usdcAfter;
  try {
    usdcAfter = await readBalanceStrict(pc, assetAddr, owner);
  } catch {
    return { confirmed: false, withdrawHash: redHash, reason: "reclaim submitted, but we couldn't read the amount returned — check your wallet balance before retrying" };
  }
  const deltaMinor = BigInt(usdcAfter) - BigInt(usdcBefore);
  // ⛔ THE UNREADABLE-RECEIPT PATH RESOLVES HERE, ON THE BALANCE, NOT ON A GUESS.
  // A positive delta means USDC arrived: the redeem happened, whatever the receipt read did. A
  // non-positive delta with an unreadable receipt is genuinely undetermined — and it says so,
  // WITHOUT claiming where the shares are, because nothing here establishes that.
  if (receiptUnreadable && deltaMinor <= 0n) {
    return {
      confirmed: false,
      withdrawHash: redHash,
      reason:
        "we could not read the transaction receipt, and no USDC has arrived yet — so we cannot tell " +
        "whether this reclaim went through. Check your wallet before retrying; retrying could redeem twice.",
    };
  }
  if (deltaMinor <= 0n) {
    // Mined 'success' but no USDC arrived → the redeem did not actually return funds. Honest failure,
    // never a fabricated number.
    return { confirmed: false, withdrawHash: redHash, reason: "reclaim didn't confirm — no USDC was returned; your shares are still in the vault" };
  }

  return {
    confirmed: true,
    withdrawHash: redHash,
    withdrawTx: `${ARC.explorer}/tx/${redHash}`,
    sharesRedeemedRaw: String(shares),
    usdcReceived: Number(deltaMinor) / 10 ** USDC_DECIMALS, // REAL on-chain balance delta
    verifiedBy: "usdc-balance-delta",
  };
}

// ── READ: the caller's LIVE on-chain share balance ───────────────────────────────────────────
// The single source of truth for "how many shares does this wallet hold in this vault, right now".
// Used by the share-balance endpoint (to show the user) AND by the withdraw path (to derive exactly
// what to redeem) — so a returning user with shares from a PRIOR session can still reclaim, without
// any session receipt or typed amount.
//
// ⚠️ SAFETY-CRITICAL, FAILS CLOSED. The reclaim amount is derived from this read, so a read that
// cannot complete must THROW — never return 0. `0n` means "genuinely no shares" (→ nothing to
// reclaim); a failed read must NOT masquerade as that, or a returning user's balance could be
// silently erased. balanceOf on a real ERC-20/4626 either returns a uint or the call reverts; a
// revert/timeout exhausts the retries and throws. `decimals()` is cosmetic (formatting only) and is
// best-effort — its absence never blocks the balance itself.
export async function readShareBalance({ walletAddress, vault }) {
  const owner = getAddress(walletAddress);
  const vaultAddr = getAddress(vault.address);
  const pc = publicClient();

  const raw = await withRetry(
    () => pc.readContract({ address: vaultAddr, abi: BAL_ABI, functionName: "balanceOf", args: [owner] }),
    5 // try hard: this read is the reclaim's amount, so a transient RPC hiccup must not become a throw prematurely
  );
  if (typeof raw !== "bigint") throw new Error("could not read your share balance on-chain");

  const decRaw = await tryRead(pc, vaultAddr, u8Fn("decimals"), "decimals", []);
  const decimals = typeof decRaw === "bigint" ? Number(decRaw) : typeof decRaw === "number" ? decRaw : USDC_DECIMALS;
  return { raw, decimals, formatted: formatUnits(raw, decimals) };
}
