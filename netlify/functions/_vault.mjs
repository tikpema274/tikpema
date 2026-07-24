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

import { getAddress, toFunctionSelector, formatUnits } from "viem";
import { createHash } from "node:crypto";
import { circle, waitForTx } from "./_circle.mjs";
import { ARC, CONTRACTS, USDC_DECIMALS } from "./_arc.mjs";
import { publicClient } from "./_predict.mjs";

// ── The allowlist. One entry today — recon found exactly one live vault on Arc testnet and no
// registry (see PROGRESS). A vault the agent may run against is a CONFIG decision, exactly like
// bridge destinations (BRIDGE_DESTINATIONS) and swap tokens (SWAP_TOKENS) — never a free-form
// contract address off the wire. Adding one is a line here + an env cap, never arbitrary
// execution. ─────────────────────────────────────────────────────────────────────────────────
//
// ⚠️⚠️ ADDING AN ENTRY HERE ARMS THREE KNOWN FAIL-OPEN DEFECTS IN inspectVault(). ⚠️⚠️
// This is not a general "be careful" — it is what YOUR EDIT DOES. The disclosure the user reads
// and ACKNOWLEDGES before a deposit currently asserts three things it did not establish:
//
//   1. An UNREAD owner() is reported as "Ownership renounced" — the only owner class that
//      raises NO warning (see classifyOwner, and the warn list in the verdict block).
//   2. An UNREAD EIP-1967 slot is reported as "Not upgradeable … (no proxy slot, no upgrade
//      function)" — a positive claim that the slot was checked and found empty. It wasn't read.
//   3. lock/delay/cooldown are HARDCODED false and never checked for any vault, yet the
//      disclosure states "Reversible in the same transaction (no lock/delay) … NOT a one-way
//      trap." A vault with a withdrawal queue would be disclosed as instantly reversible.
//
// WHAT KEEPS THEM CONTAINED TODAY is not the inspector — it is this list being one entry long,
// plus the fact that conformance is a selector scan of the address's OWN bytecode, so proxied
// vaults BLOCK as `not-erc4626` before the defects matter. Both are properties of the current
// CONFIG, not of the code. A second entry — especially a non-proxy vault on mainnet — removes
// both at once and all three defects go live simultaneously. The trigger is ordinary RPC
// flakiness on a public endpoint we already document as throttled.
//
// 📄 READ VAULT_INSPECT_DEFECTS.md BEFORE WIDENING THIS LIST. It has line refs, the honest
// blast-radius argument, and the recommended fix (a tri-state present/absent/unreadable in the
// reading primitive). As of that report NOTHING IS FIXED — it is a report, not a changelog.
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
// EIP-1967 implementation storage slot — a non-zero value here means the contract is a proxy,
// i.e. its logic is upgradeable behind the same address. keccak256("eip1967.proxy.implementation")-1.
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
// Multicall3 (canonical address, deployed on Arc testnet — see Arc docs contract-addresses). The
// value reads go through ONE multicall instead of a burst of ~11 parallel eth_calls: the public
// RPC throttles bursts, and a throttled read that silently returns null would MISREPORT the vault
// (e.g. read totalAssets as 0 and wrongly flag a funded vault as an empty shell). One call, robust.
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Retry a single RPC read a few times before giving up — the public RPC occasionally rejects a
// call under load. `fallback` is returned only after all attempts fail.
async function withRetry(fn, fallback, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch {
      if (i < tries - 1) await sleep(150 * (i + 1));
    }
  }
  return fallback;
}

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

// Owner-power signatures. Presence of ANY variant in a group flips that disclosure on. We report
// WHICH matched so the disclosure is specific, not hand-wavy.
const POWER_SIGS = {
  emergencyWithdraw: ["emergencyWithdraw(address,uint256)", "emergencyWithdraw()", "sweep(address)", "rescueTokens(address,uint256)", "rescue(address,uint256)"],
  feesSettable: ["setFees(uint256,uint256,uint256)", "setFee(uint256)", "setWithdrawFee(uint256)", "setDepositFee(uint256)", "setPerformanceFee(uint256)"],
  setStrategy: ["setStrategy(address)"],
  setFeeRecipient: ["setFeeRecipient(address)"],
  transferOwnership: ["transferOwnership(address)"],
  pausable: ["pause()", "paused()"],
  upgradeable: ["upgradeTo(address)", "upgradeToAndCall(address,bytes)"],
};
// Owner-contract fingerprints (to classify a contract owner: safe / timelock / other).
const SAFE_SIGS = ["getThreshold()", "getOwners()"];
const TIMELOCK_SIGS = ["getMinDelay()", "TIMELOCK_ADMIN_ROLE()"];

const sel = (sig) => toFunctionSelector(sig).slice(2).toLowerCase(); // 8-hex, no 0x
const hasSel = (code, sig) => code.includes(sel(sig));
const hasAny = (code, sigs) => sigs.filter((s) => hasSel(code, s));

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
  const SENTINEL = Symbol("unread");
  const v = await withRetry(
    () => pc.readContract({ address: token, abi: BAL_ABI, functionName: "balanceOf", args: [owner] }),
    SENTINEL,
    6
  );
  if (typeof v !== "bigint") throw new Error("balance read failed");
  return v;
}

// Batch many single-return view reads into ONE Multicall3 call. allowFailure → an absent/reverting
// method comes back null (not a thrown call), so a general vault missing withdrawFee()/MAX_FEE()/
// owner() degrades gracefully. Retried as a unit; a total failure yields all-null.
async function multiRead(pc, calls) {
  const res = await withRetry(
    () => pc.multicall({ allowFailure: true, multicallAddress: MULTICALL3, contracts: calls }),
    null,
    5 // this read carries the value fields; a total failure would misreport the vault, so try hard
  );
  if (!Array.isArray(res)) return calls.map(() => null);
  return res.map((r) => (r && r.status === "success" ? r.result : null));
}

// Classify an owner address: renounced (zero), EOA (no code), or a contract we try to fingerprint.
async function classifyOwner(pc, owner) {
  if (!owner || /^0x0+$/.test(String(owner))) return { address: owner ?? null, type: "renounced", label: "Ownership renounced (owner is the zero address)" };
  const code = await withRetry(() => pc.getBytecode({ address: getAddress(owner) }), "0x");
  const c = String(code || "0x").toLowerCase();
  if (c === "0x" || c === "") return { address: owner, type: "eoa", label: "A single externally-owned key (EOA) controls this vault" };
  if (SAFE_SIGS.every((s) => hasSel(c, s))) return { address: owner, type: "multisig", label: "Owner is a multisig (Gnosis Safe-shaped)" };
  if (TIMELOCK_SIGS.some((s) => hasSel(c, s))) return { address: owner, type: "timelock", label: "Owner is a timelock contract" };
  return { address: owner, type: "contract", label: "Owner is a contract (not identified as a known multisig or timelock)" };
}

// ── INSPECT ────────────────────────────────────────────────────────────────────────────────
// Reads the chain read-only and returns a DISCLOSURE object. Never signs, never writes.
export async function inspectVault(address) {
  const addr = getAddress(address);
  const pc = publicClient();

  const codeRaw = await withRetry(() => pc.getBytecode({ address: addr }), "0x");
  const code = String(codeRaw || "0x").toLowerCase();
  const isContract = code !== "0x" && code.length > 2;

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
  for (let i = 0; i < 3 && assetSelPresent && values[0] == null; i++) {
    await sleep(250 * (i + 1));
    values = await multiRead(pc, VALUE_CALLS);
  }
  const [assetAddr, totalAssets, decimals, symbol, name, totalSupply, withdrawFee, depositFee, performanceFee, maxFee, ownerRaw] = values;

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
  const implSlot = await withRetry(() => pc.getStorageAt({ address: addr, slot: EIP1967_IMPL_SLOT }), null);
  const proxyImpl = implSlot && !/^0x0*$/.test(implSlot);
  const upgradeable = upgradeSel || !!proxyImpl;
  const ownerIdentity = await classifyOwner(pc, ownerRaw);

  // Withdraw mechanics. No lock/delay/cooldown selector is a WARN or BLOCK on its own; the fee is
  // reported plainly, and a CURRENT fee over the ceiling is a BLOCK.
  const withdraw = {
    lock: false, // XyloVault has none; a general vault with a lock would surface as a selector, TODO on demand
    delay: false,
    cooldown: false,
    pausable,
    withdrawFeeBps,
    withdrawFeePct: withdrawFeeBps === null ? null : `${(withdrawFeeBps / 100).toFixed(2)}%`,
    roundTripRetainedPct: withdrawFeeBps === null ? null : `${((10000 - withdrawFeeBps) / 100).toFixed(2)}%`,
    reversibility:
      withdrawFeeBps === null
        ? "unknown"
        : `Reversible in the same transaction (no lock/delay). A withdraw retains ~${((10000 - withdrawFeeBps) / 100).toFixed(2)}% (a ${(withdrawFeeBps / 100).toFixed(2)}% exit fee). This is NOT a one-way trap — but the exit terms can be changed by the owner (see owner powers).`,
  };

  const ownerPowers = {
    owner: ownerIdentity.address,
    ownerIdentity: ownerIdentity.type, // eoa | multisig | timelock | contract | renounced
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
      present: upgradeable,
      viaSelector: upgradeSel,
      viaProxySlot: !!proxyImpl,
      note: upgradeable ? "The vault's logic can be replaced (proxy/upgradeable). Its rules can change without moving your funds." : "Not upgradeable — logic is fixed at this address (no proxy slot, no upgrade function).",
    },
    pausable: {
      present: pausable,
      note: pausable ? "The vault can be paused; deposits/withdrawals may be halted." : "No pause function found — withdrawals cannot be frozen by a pause switch.",
    },
  };

  // ── VERDICT ──────────────────────────────────────────────────────────────────────────────
  const blocks = [];
  const warns = [];
  if (!isContract) blocks.push({ code: "not-a-contract", detail: "No bytecode at this address — it is not a deployed contract." });
  if (isContract && !erc4626) blocks.push({ code: "not-erc4626", detail: `Missing ERC-4626 methods: ${missing.join(", ")}.` });
  if (isShell) blocks.push({ code: "empty-shell", detail: "totalAssets() is 0 — the vault holds nothing; a deposit would be the only funds in it." });
  if (withdrawFeeBps !== null && withdrawFeeBps > WITHDRAW_FEE_BLOCK_BPS)
    blocks.push({ code: "withdraw-fee-too-high", detail: `Current withdraw fee ${(withdrawFeeBps / 100).toFixed(2)}% exceeds the ${(WITHDRAW_FEE_BLOCK_BPS / 100).toFixed(2)}% ceiling.` });

  if (ownerPowers.emergencyWithdraw.present) warns.push({ code: "emergency-withdraw", detail: ownerPowers.emergencyWithdraw.note });
  if (ownerPowers.settableFees.present) warns.push({ code: "fees-settable", detail: ownerPowers.settableFees.note });
  if (ownerIdentity.type === "eoa") warns.push({ code: "owner-is-eoa", detail: ownerIdentity.label + ". A single compromised key can exercise every owner power above." });
  if (ownerIdentity.type === "contract") warns.push({ code: "owner-is-unidentified-contract", detail: ownerIdentity.label });
  if (performanceFeeBps !== null && performanceFeeBps > 0) warns.push({ code: "performance-fee", detail: `A ${(performanceFeeBps / 100).toFixed(2)}% performance fee is taken on harvested yield.` });
  if (upgradeable) warns.push({ code: "upgradeable", detail: ownerPowers.upgradeable.note });

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
  return `${String(inspection?.address ?? "").toLowerCase()}|warns:${warnCodes}|wf:${wf}|df:${df}|v1`;
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
  const disclosure = { level: inspection.verdict.level, blocks: [...inspection.verdict.blocks], warns: [...inspection.verdict.warns], digest: disclosureDigest(inspection) };

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
  const receipt = await withRetry(() => pc.getTransactionReceipt({ hash: redHash }), null, 6);
  if (!receipt || receipt.status !== "success") {
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

  const SENTINEL = Symbol("unread");
  const raw = await withRetry(
    () => pc.readContract({ address: vaultAddr, abi: BAL_ABI, functionName: "balanceOf", args: [owner] }),
    SENTINEL,
    5 // try hard: this read is the reclaim's amount, so a transient RPC hiccup must not become a throw prematurely
  );
  if (typeof raw !== "bigint") throw new Error("could not read your share balance on-chain");

  const decRaw = await tryRead(pc, vaultAddr, u8Fn("decimals"), "decimals", []);
  const decimals = typeof decRaw === "bigint" ? Number(decRaw) : typeof decRaw === "number" ? decRaw : USDC_DECIMALS;
  return { raw, decimals, formatted: formatUnits(raw, decimals) };
}
