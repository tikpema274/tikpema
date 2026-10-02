// morpho-v2.mjs — DD Morpho V2, STEP 2: recognition by FACTORY ATTESTATION + the exit-path GUARD.
//
// ═══ THE DESIGN (PROGRESS 2026-09-28 "V2 EXIT PATH" + "BUILD ORDER"; T 2026-10-02) ══════════════════════════════
// ⭐ RECOGNITION: a vault is Morpho Vault V2 iff the PINNED VaultV2Factory (chain registry, code hash checked against its
//    pin on every check) says `isVaultV2(vault)`. The selector fingerprint is a CROSS-CHECK: an attested vault without
//    V2's governance selectors is a CONTRADICTION (refused), and a V2-looking vault the factory does not attest is NOT
//    V2. The fingerprint never decides.
// ⭐ THE GUARD: none of the exit-path contracts is a proxy; what changes is the WIRING (which adapters, which liquidity
//    adapter). So every check re-reads the wiring, and recognises each adapter by ITS pinned factory's attestation.
//    The structure records each instance's attestation and code hash at the block, so a later check can say WHAT
//    changed (compareExitPath), not only that something did.
// ⭐ NO VALUE, NEVER A GUESS: redeemable-now has NO value (never 0%, never 100%) when the route it depends on is not
//    understood: an unrecognised or non-adapter LIQUIDITY adapter, or Morpho Blue's code ≠ its pin. An unrecognised
//    OTHER adapter degrades only its own part, and the report states the share of assets it holds: a FINDING.
// ⚠️ STEP 2 ONLY: redeemable-now is COMPUTED in step 4 (the exit-liquidity fact); here it is "not-computed" or
//    "no-value". The power model (timelock · abdicated · current value) is step 3; until then a recognised V2 vault's
//    presence groups are NOT CHECKED and the report is a NO-VERDICT (index.mjs).
// ⛔ A chain with no V2 pins (arc-testnet, the paid path) never reaches this module: recogniseV2 returns null and makes
//    NO read, so testnet reports are unchanged.
//
// Transport is injected (the same `client` as analyze); every read goes through `cov.runCheck` (kind "v2"), so each
// is in the coverage manifest and in report.reads, reproducible.

import { encodeFunctionData, decodeFunctionResult, encodeAbiParameters, decodeAbiParameters, parseAbi, keccak256 } from "viem";
import { UNREADABLE, unread, hasSel } from "../onchain-facts/index.mjs";

/** V2's distinctive governance selectors (none is ERC-4626). The CROSS-CHECK, never the decision. */
export const V2_FINGERPRINT = Object.freeze([
  "liquidityAdapter()", "adaptersLength()", "curator()", "isAllocator(address)", "abdicated(bytes4)", "timelock(bytes4)",
]);

const ABI = parseAbi([
  "function isVaultV2(address) view returns (bool)",
  "function isMorphoMarketV1AdapterV2(address) view returns (bool)",
  "function isMorphoVaultV1Adapter(address) view returns (bool)",
  "function adaptersLength() view returns (uint256)",
  "function adapters(uint256) view returns (address)",
  "function liquidityAdapter() view returns (address)",
  "function isAdapter(address) view returns (bool)",
  "function asset() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function realAssets() view returns (uint256)",
]);
/** More adapters than this and the exit fact is not read (a bound on reads, stated, never silently truncated). */
export const MAX_ADAPTERS_READ = 32;

const ZERO = "0x0000000000000000000000000000000000000000";
const isZero = (a) => !a || /^0x0+$/.test(a);
const word = (hex) => {
  const h = String(hex ?? "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) throw Object.assign(new Error(`not one 32-byte word: ${h.slice(0, 20)}…`), { unreadableInput: true });
  return h;
};
const DEC = {
  bool: (h) => { const v = BigInt(word(h)); if (v > 1n) throw Object.assign(new Error("not a bool"), { unreadableInput: true }); return v === 1n; },
  uint: (h) => BigInt(word(h)),
  address: (h) => { const w = word(h); if (!/^0x0{24}/.test(w)) throw Object.assign(new Error("not an address word"), { unreadableInput: true }); return "0x" + w.slice(-40); },
};
const lc = (a) => String(a).toLowerCase();
const same = (a, b) => !!a && !!b && lc(a) === lc(b);

// ═══ READS: ORDERED PARALLEL BATCHES (T 2026-10-02) ════════════════════════════════════════════════════════════════
// Measured: 71 SERIAL quorum reads per endpoint took 6.6–10.4 s on Galaxy against the mandate's 10 s freshness ceiling.
// Independent reads now go through coverage.runChecks: ≤ V2_READ_CONCURRENCY in flight, RECORDED IN LIST ORDER, so the
// manifest and readIds (inside the signed body) are byte-identical run to run (test:morphov2parallel). A rejected read is
// recorded exactly as before: a rate-limited read stays UNREADABLE, never a value.
export const V2_READ_CONCURRENCY = 8;
const callSpec = (client, blk, id, to, abi, fn, args, decode, extraParams) => {
  const data = encodeFunctionData({ abi, functionName: fn, args });
  return { id, meta: { kind: "v2" }, fn: async () => {
    const out = await client.call({ method: "eth_call", params: extraParams ? [{ to, data }, blk.tag, extraParams] : [{ to, data }, blk.tag] });
    return { ...out, result: decode(out.result) };
  } };
};
const codeSpec = (client, blk, id, address) => ({ id, meta: { kind: "v2" }, fn: async () => {
  const out = await client.call({ method: "eth_getCode", params: [address, blk.tag] });
  const c = String(out.result ?? "");
  return { ...out, result: c === "0x" || c === "" ? null : keccak256(c) };
} });
/** Run specs in parallel (capped), record in order; each value or UNREADABLE (never a default). */
async function runAll(cov, specs) {
  if (!specs.length) return [];
  const rs = await cov.runChecks(specs, { concurrency: V2_READ_CONCURRENCY });
  return rs.map((r) => (r.ok ? r.value : UNREADABLE));
}
const byDEC = (k) => (h) => DEC[k](h);
const byABI = (abi, fn) => (h) => {
  try { return decodeFunctionResult({ abi, functionName: fn, data: h }); }
  catch { throw Object.assign(new Error(`${fn}: undecodable result`), { unreadableInput: true }); }
};
/** One eth_call through the coverage door. Returns the decoded value, or UNREADABLE (never a default). */
const rspec = (client, blk, id, to, fn, args, dec) => callSpec(client, blk, id, to, ABI, fn, args, byDEC(dec));
async function read(cov, client, blk, id, to, fn, args, dec) { return (await runAll(cov, [rspec(client, blk, id, to, fn, args, dec)]))[0]; }
const pinCheck = (h, pin) => (unread(h) ? null : h === pin.codeHash);

/**
 * Recognise a Morpho Vault V2 by the PINNED factory's attestation.
 * @returns null when this chain has no V2 pins (NO read made); else
 *   { status: "attested" | "not-v2" | "factory-mismatch" | "unreadable" | "contradictory", ... }
 */
export async function recogniseV2(cov, client, addr, blk, effCode) {
  const f = client.chain?.pins?.vaultV2Factory;
  if (!f) return null;
  const [fh, att] = await runAll(cov, [codeSpec(client, blk, "v2:code@vaultV2Factory", f.address),
    rspec(client, blk, "v2:isVaultV2", f.address, "isVaultV2", [addr], "bool")]);
  const factory = { address: f.address, codeHash: unread(fh) ? null : fh, codeHashMatchesPin: pinCheck(fh, f) };
  const fingerprint = typeof effCode === "string" && !unread(effCode)
    ? (V2_FINGERPRINT.every((s) => hasSel(effCode, s)) ? "agrees" : "disagrees") : "unreadable";
  const base = { method: "factory-attestation", factory, fingerprint, fingerprintSelectors: V2_FINGERPRINT };
  if (unread(fh)) return { ...base, status: "unreadable", why: "the pinned VaultV2Factory's code could not be read, so its attestation cannot be trusted or refused" };
  if (factory.codeHashMatchesPin !== true) return { ...base, status: "factory-mismatch", why: "the code at the pinned VaultV2Factory address does not match its pin: its attestation counts for nothing" };
  if (unread(att)) return { ...base, status: "unreadable", attested: null, why: "isVaultV2 could not be read" };
  if (att !== true) return { ...base, status: "not-v2", attested: false, why: "the pinned VaultV2Factory does not attest this address (a V2-looking fingerprint does not make it V2)" };
  if (fingerprint !== "agrees") return { ...base, status: "contradictory", attested: true, why: "the pinned factory attests this vault, but its code lacks V2's governance selectors: the two disagree" };
  return { ...base, status: "attested", attested: true, profile: "morpho-v2" };
}

/** The exit-path guard for an ATTESTED V2 vault. Never throws for a chain answer; reads go through the coverage door. */
export async function exitPathGuardV2(cov, client, addr, blk) {
  const pins = client.chain.pins;
  const VOUCH = [["morphoMarketV1AdapterV2", "morphoMarketV1AdapterV2Factory", "isMorphoMarketV1AdapterV2"],
    ["morphoVaultV1Adapter", "morphoVaultV1AdapterFactory", "isMorphoVaultV1Adapter"]].filter(([, key]) => pins[key]);
  // Batch 1 — independent: Morpho Blue's code, each adapter factory's code, the wiring getters.
  const b1 = await runAll(cov, [
    codeSpec(client, blk, "v2:code@morphoBlue", pins.morphoBlue.address),
    ...VOUCH.map(([, key]) => codeSpec(client, blk, `v2:code@${key}`, pins[key].address)),
    rspec(client, blk, "v2:adaptersLength", addr, "adaptersLength", [], "uint"),
    rspec(client, blk, "v2:liquidityAdapter", addr, "liquidityAdapter", [], "address"),
    rspec(client, blk, "v2:asset", addr, "asset", [], "address"),
  ]);
  const blueH = b1[0];
  const morphoBlue = { address: pins.morphoBlue.address, codeHash: unread(blueH) ? null : blueH, codeHashMatchesPin: pinCheck(blueH, pins.morphoBlue) };
  // The adapter factories that may vouch for an adapter: each counts only if ITS code matches ITS pin.
  const vouchers = VOUCH.map(([kind, key, fn], i) => ({ kind, key, fn, address: pins[key].address, codeHashMatchesPin: pinCheck(b1[1 + i], pins[key]) }));
  const [n, liq, asset] = b1.slice(1 + VOUCH.length);

  // Batch 2 — the adapter list (its length is known) and the idle balance (its asset is known).
  let listReadable = !unread(n) && n <= BigInt(MAX_ADAPTERS_READ);
  const nn = listReadable ? Number(n) : 0;
  const b2 = await runAll(cov, [
    ...Array.from({ length: nn }, (_, i) => rspec(client, blk, `v2:adapters(${i})`, addr, "adapters", [BigInt(i)], "address")),
    ...(unread(asset) ? [] : [rspec(client, blk, "v2:idle", asset, "balanceOf", [addr], "uint")]),
  ]);
  const list = b2.slice(0, nn);
  if (list.some((a) => unread(a))) listReadable = false;
  const idle = unread(asset) ? UNREADABLE : b2[nn];
  const liqSet0 = !unread(liq) && !isZero(liq);

  // Batch 3 — every adapter's code + attestations + realAssets, and the liquidity adapter's (if outside the list).
  const live = vouchers.filter((v) => v.codeHashMatchesPin === true); // a factory not matching its pin vouches for nothing
  const recogSpecs = (a, withReal) => [
    codeSpec(client, blk, `v2:code@adapter:${lc(a)}`, a),
    ...live.map((v) => rspec(client, blk, `v2:${v.fn}:${lc(a)}`, v.address, v.fn, [a], "bool")),
    ...(withReal ? [rspec(client, blk, `v2:realAssets:${lc(a)}`, a, "realAssets", [], "uint")] : []),
  ];
  const listed = listReadable ? list : [];
  const extraLiq = liqSet0 && !listed.some((a) => same(a, liq)) ? liq : null;
  const per = 1 + live.length;
  const b3 = await runAll(cov, [
    ...listed.flatMap((a) => recogSpecs(a, true)),
    ...(extraLiq ? recogSpecs(extraLiq, false) : []),
    ...(liqSet0 ? [rspec(client, blk, "v2:isAdapter(liquidityAdapter)", addr, "isAdapter", [liq], "bool")] : []),
  ]);
  const recogFrom = (a, vals) => {
    let recognisedAs = null, attestedBy = null, attestation = "none";
    live.forEach((v, i) => {
      if (recognisedAs) return;
      const yes = vals[1 + i];
      if (unread(yes)) { attestation = "unreadable"; return; }
      if (yes) { recognisedAs = v.kind; attestedBy = v.address; attestation = "attested"; }
    });
    return { address: a, codeHash: unread(vals[0]) ? null : vals[0], recognisedAs, attestedBy, attestation };
  };
  const adapters = listed.map((a, i) => {
    const vals = b3.slice(i * (per + 1), (i + 1) * (per + 1));
    const real = vals[per];
    return { ...recogFrom(a, vals), realAssets: unread(real) ? null : real.toString() };
  });
  let k = listed.length * (per + 1);
  const extraRec = extraLiq ? recogFrom(extraLiq, b3.slice(k, (k += per))) : null;
  const isAdLiq = liqSet0 ? b3[k] : undefined;
  const allReal = listReadable && !unread(idle) && adapters.every((x) => x.realAssets !== null);
  const total = allReal ? adapters.reduce((s, x) => s + BigInt(x.realAssets), idle) : null;
  for (const x of adapters) {
    x.shareBps = total && total > 0n ? Number((BigInt(x.realAssets) * 10000n) / total) : null;
    x.shareSource = "the adapter's own realAssets() over the vault's idle balance + Σ adapters' realAssets() (the sum VaultV2 uses for its total); rounded down";
  }

  const liqSet = !unread(liq) && !isZero(liq);
  let liquidityAdapter;
  if (unread(liq)) liquidityAdapter = { address: null, set: null, readable: false };
  else if (!liqSet) liquidityAdapter = { address: null, set: false, note: "unset: redemptions are served from the vault's idle balance only" };
  else {
    const inList = adapters.find((x) => same(x.address, liq));
    const rec = inList ? { recognisedAs: inList.recognisedAs, attestedBy: inList.attestedBy, attestation: inList.attestation, codeHash: inList.codeHash } : extraRec;
    const isAd = isAdLiq;
    liquidityAdapter = { address: liq, set: true, recognisedAs: rec.recognisedAs, attestedBy: rec.attestedBy, attestation: rec.attestation,
      codeHash: rec.codeHash ?? null, isAdapter: unread(isAd) ? null : isAd };
  }

  // ── findings (each a FINDING: a fact about this vault, not a gap in our reading) ──
  const findings = [];
  const pct = (bps) => `${(bps / 100).toFixed(2)}%`;
  for (const x of adapters) {
    if (x.recognisedAs !== null) continue;
    findings.push({ kind: "finding", code: "unrecognised-adapter", address: x.address, shareBps: x.shareBps,
      text: x.shareBps !== null
        ? `an adapter of unrecognised code holds ${pct(x.shareBps)} of this vault's assets`
        : "an adapter of unrecognised code holds an unknown share of this vault's assets (the vault's real assets could not all be read)" });
  }
  if (liqSet && liquidityAdapter.recognisedAs === null) {
    findings.push({ kind: "finding", code: "liquidity-adapter-unrecognised", address: liq,
      text: "redemptions are routed through an adapter of unrecognised code" });
  }
  if (liqSet && liquidityAdapter.isAdapter === false) {
    findings.push({ kind: "finding", code: "liquidity-adapter-not-an-adapter", address: liq,
      text: "the liquidity adapter is not an adapter of this vault: any redemption above the idle balance reverts (VaultV2 deallocates only from an adapter)" });
  }

  // ── redeemable-now: NO VALUE when the route is not understood; otherwise not computed until step 4 ──
  const noValue = [];
  if (morphoBlue.codeHashMatchesPin !== true) noValue.push(morphoBlue.codeHashMatchesPin === null ? "Morpho Blue's code could not be read, so it cannot be checked against its pin" : "Morpho Blue's code does not match its pin");
  if (!listReadable) noValue.push(unread(n) || n <= BigInt(MAX_ADAPTERS_READ) ? "the vault's adapter list could not be read" : `the vault has more than ${MAX_ADAPTERS_READ} adapters; they were not read`);
  if (unread(liq)) noValue.push("the vault's liquidity adapter could not be read");
  if (liqSet && liquidityAdapter.recognisedAs === null) noValue.push(liquidityAdapter.attestation === "unreadable" ? "the liquidity adapter's attestation could not be read" : "redemptions are routed through an adapter of unrecognised code");
  if (liqSet && liquidityAdapter.isAdapter !== true) noValue.push(liquidityAdapter.isAdapter === null ? "whether the liquidity adapter is an adapter of this vault could not be read" : "the liquidity adapter is not an adapter of this vault");
  const degraded = adapters.filter((x) => x.recognisedAs === null && !same(x.address, liq)).map((x) => x.address);
  const redeemableNow = noValue.length
    ? { value: null, status: "no-value", reason: noValue.join("; "), degraded }
    : { value: null, status: "not-computed", reason: "redeemable-now is the exit-liquidity fact (DD Morpho V2 step 4): not computed in this build", degraded };

  return { profile: "morpho-v2", morphoBlue, adapterFactories: vouchers.map(({ kind, address, codeHashMatchesPin }) => ({ kind, address, codeHashMatchesPin })),
    asset: unread(asset) ? null : asset, idleAssets: unread(idle) ? null : idle.toString(),
    adapters, liquidityAdapter, redeemableNow, findings };
}

/**
 * ⭐ WHAT changed between two exit-path records of the same vault (e.g. the finding check and the execution read).
 * Pure. Returns [] when nothing in the wiring or the recorded code changed.
 */
export function compareExitPath(a, b) {
  const out = [];
  const la = a?.liquidityAdapter?.address ?? null, lb = b?.liquidityAdapter?.address ?? null;
  if (!((la === null && lb === null) || same(la, lb))) out.push({ what: "liquidityAdapter", from: la, to: lb });
  if (la && lb && same(la, lb) && a.liquidityAdapter.codeHash !== b.liquidityAdapter.codeHash) {
    out.push({ what: "liquidityAdapterCodeHash", address: lb, from: a.liquidityAdapter.codeHash, to: b.liquidityAdapter.codeHash });
  }
  const am = new Map((a?.adapters ?? []).map((x) => [lc(x.address), x])), bm = new Map((b?.adapters ?? []).map((x) => [lc(x.address), x]));
  for (const [k, x] of am) if (!bm.has(k)) out.push({ what: "adapterRemoved", address: x.address });
  for (const [k, y] of bm) {
    const x = am.get(k);
    if (!x) { out.push({ what: "adapterAdded", address: y.address }); continue; }
    if (x.codeHash !== y.codeHash) out.push({ what: "adapterCodeHash", address: y.address, from: x.codeHash, to: y.codeHash });
    if (x.recognisedAs !== y.recognisedAs) out.push({ what: "adapterRecognition", address: y.address, from: x.recognisedAs, to: y.recognisedAs });
  }
  if ((a?.morphoBlue?.codeHash ?? null) !== (b?.morphoBlue?.codeHash ?? null)) out.push({ what: "morphoBlueCodeHash", from: a?.morphoBlue?.codeHash ?? null, to: b?.morphoBlue?.codeHash ?? null });
  return out;
}

// ═══ STEP 3 — THE V2 POWER MODEL (T 2026-10-02: decision (b) + exitPowers) ═════════════════════════════════════
// On V2 every vault has every power, so PRESENCE says nothing. Each power is reported by WHO can call it, its DELAY
// (`timelock(selector)` for the curator's timelocked functions; "not timelockable" for owner / allocator / sentinel
// functions, which never pass `timelocked()`), whether it is ABDICATED (permanent), and the CURRENT VALUE where one exists.
// Source: vault-v2 tag 2026-08-13 `src/VaultV2.sol` (the tag that reproduces every deployed vault-v2 contract on Arc).
// ⭐ A timelock is a TRUE lower bound: decreaseTimelock on X waits X's CURRENT timelock (VaultV2.sol:355).
// ⛔ Allocators, sentinels and pending submissions are MAPPINGS (`isAllocator`, `isSentinel`, `executableAt[data]`):
// NOT enumerated in this window (decision (b)); each is a stated notChecked entry, never an empty list read as "none".

const T = "timelocked", NT = "not-timelockable";
const P = (power, signature, caller, delay, scope, reach, value = null) => Object.freeze({ power, signature, caller, delay, scope, reach, value });
/** The catalogue: every non-view external function of VaultV2 that is a POWER over holders (30 of 42; the other 12 are
 *  user or permissionless functions: deposit/mint/withdraw/redeem/transfer/transferFrom/approve/permit/multicall/
 *  accrueInterest/forceDeallocate/submit). Pinned against the source list by test:morphov2powers. */
export const V2_POWER_CATALOGUE = Object.freeze([
  P("setOwner", "setOwner(address)", "owner", NT, "ownership-transfer", "hands every owner power to a new address, immediately", "owner"),
  P("setCurator", "setCurator(address)", "owner", NT, "ownership-transfer", "replaces who may submit every timelocked change, immediately", "curator"),
  P("setIsSentinel", "setIsSentinel(address,bool)", "owner", NT, "ownership-transfer", "adds or removes a sentinel (who may veto pending changes and de-risk)"),
  P("setName", "setName(string)", "owner", NT, "parameter-change", "renames the vault (cosmetic)"),
  P("setSymbol", "setSymbol(string)", "owner", NT, "parameter-change", "changes the share symbol (cosmetic)"),
  P("setIsAllocator", "setIsAllocator(address,bool)", "curator", T, "ownership-transfer", "appoints or removes an allocator: who can move liquidity and rewire the redemption route"),
  P("setReceiveSharesGate", "setReceiveSharesGate(address)", "curator", T, "access-restriction", "gates who may receive shares (deposit / transfer in)", "receiveSharesGate"),
  P("setSendSharesGate", "setSendSharesGate(address)", "curator", T, "access-restriction", "gates who may send shares: an EXIT gate (redeem / transfer out)", "sendSharesGate"),
  P("setReceiveAssetsGate", "setReceiveAssetsGate(address)", "curator", T, "access-restriction", "gates who may receive assets: an EXIT gate (withdraw)", "receiveAssetsGate"),
  P("setSendAssetsGate", "setSendAssetsGate(address)", "curator", T, "access-restriction", "gates who may send assets in (deposit)", "sendAssetsGate"),
  P("setAdapterRegistry", "setAdapterRegistry(address)", "curator", T, "funds-movement", "sets the registry that constrains which adapters may be added", "adapterRegistry"),
  P("addAdapter", "addAdapter(address)", "curator", T, "funds-movement", "adds a place the vault's assets may be deployed", "adapters"),
  P("removeAdapter", "removeAdapter(address)", "curator", T, "funds-movement", "removes an adapter", "adapters"),
  P("increaseTimelock", "increaseTimelock(bytes4,uint256)", "curator", T, "parameter-change", "lengthens a function's timelock"),
  P("decreaseTimelock", "decreaseTimelock(bytes4,uint256)", "curator", T, "parameter-change", "shortens a function's timelock (waits that function's own current timelock)"),
  P("abdicate", "abdicate(bytes4)", "curator", T, "parameter-change", "permanently disables a timelocked function"),
  P("setPerformanceFee", "setPerformanceFee(uint256)", "curator", T, "parameter-change", "changes the performance fee", "performanceFee"),
  P("setManagementFee", "setManagementFee(uint256)", "curator", T, "parameter-change", "changes the management fee", "managementFee"),
  P("setPerformanceFeeRecipient", "setPerformanceFeeRecipient(address)", "curator", T, "parameter-change", "redirects the performance fee", "performanceFeeRecipient"),
  P("setManagementFeeRecipient", "setManagementFeeRecipient(address)", "curator", T, "parameter-change", "redirects the management fee", "managementFeeRecipient"),
  P("increaseAbsoluteCap", "increaseAbsoluteCap(bytes,uint256)", "curator", T, "funds-movement", "raises how much may be allocated to an id (absolute)"),
  P("increaseRelativeCap", "increaseRelativeCap(bytes,uint256)", "curator", T, "funds-movement", "raises how much may be allocated to an id (relative)"),
  P("setForceDeallocatePenalty", "setForceDeallocatePenalty(address,uint256)", "curator", T, "parameter-change", "sets the cost of the force-exit route per adapter", "forceDeallocatePenalty"),
  P("decreaseAbsoluteCap", "decreaseAbsoluteCap(bytes,uint256)", "curator+sentinel", NT, "parameter-change", "lowers a cap (de-risking only)"),
  P("decreaseRelativeCap", "decreaseRelativeCap(bytes,uint256)", "curator+sentinel", NT, "parameter-change", "lowers a cap (de-risking only)"),
  P("revoke", "revoke(bytes)", "curator+sentinel", NT, "parameter-change", "cancels a pending timelocked change (the veto)"),
  P("allocate", "allocate(address,bytes,uint256)", "allocator", NT, "funds-movement", "moves idle assets into an adapter"),
  P("deallocate", "deallocate(address,bytes,uint256)", "allocator+sentinel", NT, "funds-movement", "moves assets back from an adapter"),
  P("setLiquidityAdapterAndData", "setLiquidityAdapterAndData(address,bytes)", "allocator", NT, "access-restriction", "rewires (or removes) the REDEMPTION ROUTE, immediately; measured on Galaxy USDC 2026-09-29 block 23403623", "liquidityAdapter"),
  P("setMaxRate", "setMaxRate(uint256)", "allocator", NT, "parameter-change", "caps how fast totalAssets may grow", "maxRate"),
]);
/** The powers over an EXIT, named so a rule can key on them (T 2026-10-02). */
export const V2_EXIT_POWERS = Object.freeze(["setSendSharesGate", "setReceiveAssetsGate", "setIsAllocator", "setLiquidityAdapterAndData", "setForceDeallocatePenalty"]);

const PABI = parseAbi([
  "function timelock(bytes4) view returns (uint256)", "function abdicated(bytes4) view returns (bool)",
  "function owner() view returns (address)", "function curator() view returns (address)",
  "function performanceFee() view returns (uint96)", "function managementFee() view returns (uint96)",
  "function performanceFeeRecipient() view returns (address)", "function managementFeeRecipient() view returns (address)",
  "function receiveSharesGate() view returns (address)", "function sendSharesGate() view returns (address)",
  "function receiveAssetsGate() view returns (address)", "function sendAssetsGate() view returns (address)",
  "function adapterRegistry() view returns (address)", "function maxRate() view returns (uint64)",
  "function forceDeallocatePenalty(address) view returns (uint256)",
]);
const pspec = (client, blk, id, to, fn, args, dec) => callSpec(client, blk, id, to, PABI, fn, args, byDEC(dec));
const sel4 = (sig) => "0x" + keccak256(new TextEncoder().encode(sig)).slice(2, 10);
const NOT_ENUM = "a mapping (isAllocator / isSentinel): not enumerable from state; the event scan is not built in this window (decision (b))";

/** Read the V2 power model of an ATTESTED vault. `exitPath` (step 2) supplies the adapters and liquidity adapter. */
export async function powersV2(cov, client, addr, blk, exitPath) {
  const v = {};
  const vals = [["owner", "address"], ["curator", "address"], ["performanceFee", "uint"], ["managementFee", "uint"], ["performanceFeeRecipient", "address"],
    ["managementFeeRecipient", "address"], ["receiveSharesGate", "address"], ["sendSharesGate", "address"], ["receiveAssetsGate", "address"],
    ["sendAssetsGate", "address"], ["adapterRegistry", "address"], ["maxRate", "uint"]];
  const adapters = (exitPath?.adapters ?? []).map((x) => x.address);
  const timed = V2_POWER_CATALOGUE.filter((p) => p.delay === T);
  // ONE batch: the values, the per-adapter penalties, every abdication and every timelock (decreaseTimelock: per target).
  const all = await runAll(cov, [
    ...vals.map(([fn, dec]) => pspec(client, blk, `v2:value:${fn}`, addr, fn, [], dec)),
    ...adapters.map((a) => pspec(client, blk, `v2:value:forceDeallocatePenalty:${lc(a)}`, addr, "forceDeallocatePenalty", [a], "uint")),
    ...timed.flatMap((p) => [pspec(client, blk, `v2:abdicated:${p.power}`, addr, "abdicated", [sel4(p.signature)], "bool"),
      ...(p.power === "decreaseTimelock" ? [] : [pspec(client, blk, `v2:timelock:${p.power}`, addr, "timelock", [sel4(p.signature)], "uint")])]),
  ]);
  let at = 0;
  for (const [fn] of vals) v[fn] = all[at++];
  const penalties = {};
  for (const a of adapters) { const p = all[at++]; penalties[a] = unread(p) ? null : p.toString(); }
  const tl = {};
  for (const p of timed) { tl[p.power] = { ab: all[at++], t: p.power === "decreaseTimelock" ? undefined : all[at++] }; }

  // The three mappings: a stated gap (decision (b)).
  cov.skip("v2:enumerate:allocators", { kind: "v2" }, `allocators: ${NOT_ENUM}`);
  cov.skip("v2:enumerate:sentinels", { kind: "v2" }, `sentinels: ${NOT_ENUM}`);
  cov.skip("v2:enumerate:pending", { kind: "v2" }, "pending timelocked submissions: `executableAt[data]` is keyed by full calldata, not enumerable from state; the Submit/Revoke/Accept event scan is not built in this window (decision (b))");

  const show = (x) => (unread(x) ? null : typeof x === "bigint" ? x.toString() : x);
  const valueOf = (p) => {
    if (p.value === "adapters") return adapters;
    if (p.value === "forceDeallocatePenalty") return penalties;
    if (p.value === "liquidityAdapter") return exitPath?.liquidityAdapter?.address ?? null;
    return p.value ? show(v[p.value]) : null;
  };
  const holdersOf = (p) => {
    if (p.caller === "owner") return unread(v.owner) ? { kind: "unreadable" } : { kind: "address", value: v.owner };
    if (p.caller === "curator") return unread(v.curator) ? { kind: "unreadable" } : { kind: "address", value: v.curator, note: "the curator SUBMITS; after the timelock anyone may execute" };
    if (p.caller === "curator+sentinel") return { kind: "partly-enumerated", value: unread(v.curator) ? null : v.curator, why: `the curator, plus every sentinel — sentinels are ${NOT_ENUM}` };
    return { kind: "not-enumerated", why: `${p.caller.replace("+", " or ")}s — ${NOT_ENUM}` };
  };

  const powers = [];
  for (const p of V2_POWER_CATALOGUE) {
    let delay, abdicated;
    if (p.delay === NT) { delay = { kind: "not-timelockable", seconds: "0", note: "never passes timelocked(): callable at once by its holder" }; abdicated = "not-applicable"; }
    else {
      const { ab, t } = tl[p.power];
      abdicated = unread(ab) ? null : ab;
      if (p.power === "decreaseTimelock") delay = { kind: "timelocked", seconds: "per-target", note: "waits the TARGET selector's own current timelock (VaultV2.sol:355), so no timelock can be shortcut" };
      else delay = { kind: "timelocked", seconds: unread(t) ? null : t.toString() };
    }
    powers.push({ power: p.power, signature: p.signature, selector: sel4(p.signature), caller: p.caller, holders: holdersOf(p), delay, abdicated,
      currentValue: valueOf(p), scope: p.scope, reach: p.reach, exit: V2_EXIT_POWERS.includes(p.power) });
  }

  const groups = { immediate: [], delayed: [], abdicated: [], unreadable: [] };
  for (const x of powers) {
    if (x.abdicated === true) groups.abdicated.push(x.power);
    else if (x.abdicated === null || x.delay.seconds === null) groups.unreadable.push(x.power);
    else if (x.delay.kind === "not-timelockable" || x.delay.seconds === "0") groups.immediate.push(x.power);
    else groups.delayed.push({ power: x.power, seconds: x.delay.seconds });
  }
  return {
    profile: "morpho-v2", catalogue: "vault-v2@2026-08-13 VaultV2.sol (30 powers of 42 non-view functions)",
    meaning: "On Vault V2 every vault holds every power: what matters is WHO can call it, how LONG before a change can land (a timelock is a true lower bound), whether it is ABDICATED (never), and its CURRENT value.",
    powers, groups,
    exitPowers: powers.filter((x) => x.exit).map(({ power, caller, holders, delay, abdicated, currentValue }) => ({ power, caller, holders, delay, abdicated, currentValue })),
    notEnumerated: ["allocators", "sentinels", "pending submissions"],
  };
}

/** Completeness over THIS profile's catalogue: every power exactly once, every one grouped exactly once. */
export function assertV2PowersComplete(pv) {
  const problems = [];
  const names = (pv?.powers ?? []).map((p) => p.power);
  for (const p of V2_POWER_CATALOGUE) {
    const n = names.filter((x) => x === p.power).length;
    if (n === 0) problems.push(`power "${p.power}" is in the V2 catalogue but not in the report`);
    if (n > 1) problems.push(`power "${p.power}" reported ${n} times`);
  }
  const g = pv?.groups ?? {};
  const grouped = [...(g.immediate ?? []), ...(g.delayed ?? []).map((x) => x.power), ...(g.abdicated ?? []), ...(g.unreadable ?? [])];
  for (const p of names) if (grouped.filter((x) => x === p).length !== 1) problems.push(`power "${p}" is not in exactly one group`);
  return { ok: problems.length === 0, problems };
}

// ═══ STEP 4 — THE EXIT-LIQUIDITY FACT, PROVEN BY A SIMULATED REDEEM (T 2026-10-02) ═══════════════════════════════
// redeemable-now = idle + what the LIQUIDITY ADAPTER's route can pay. That computed amount R is a CANDIDATE; the PROOF is
// a simulated redeem: RedeemProbe (below), placed at PROBE_ADDRESS by eth_call STATE OVERRIDE only (never deployed), holds
// the vault's whole totalSupply of shares (also by override: VaultV2.balanceOf is storage slot 12 in the pinned vault-v2
// @2026-08-13 build every attested vault reproduces) and calls withdraw(R) and withdraw(R + δ), RETURNING (ok, revertData)
// instead of reverting. So both endpoints agree on a revert as an ordinary VALUE, and an unreadable call stays unreadable.
// ⭐ confirmed = withdraw(R) succeeds AND withdraw(R + δ) reverts (δ = max(1 whole unit, R / 1000)).
// ⛔⛔ An UNREADABLE simulation → NO VALUE, never 0: on Galaxy today a proven 0 and an unread simulation look identical as a
//    number and mean "nothing can leave" vs "we could not tell".
// ⛔ A simulation that CONTRADICTS the computation → no value + a finding. Never pick one.
// ⭐ AT THE SUPPLY CEILING the proof is redeem(totalSupply), not withdraw(R): VaultV2's share math (virtual shares, round-up)
//    makes withdraw(totalAssets) need MORE shares than exist (measured 0xD392…2eC5: Panic 0x11), an amount no holder could
//    withdraw. The honest ceiling is previewRedeem(totalSupply): what every existing share redeems for.
// RedeemProbe source (solc 0.8.28, optimizer 200, paris, bytecode_hash none; 583 bytes):
//   contract RedeemProbe {
//     function probe(address vault, uint256 assets) external returns (bool ok, bytes memory ret) {
//       (ok, ret) = vault.call(abi.encodeWithSignature("withdraw(uint256,address,address)", assets, address(this), address(this))); }
//     function probeRedeem(address vault, uint256 shares) external returns (bool ok, bytes memory ret) {
//       (ok, ret) = vault.call(abi.encodeWithSignature("redeem(uint256,address,address)", shares, address(this), address(this))); } }
export const PROBE_ADDRESS = "0x00000000000000000000000000000000000dd0d0";
export const PROBE_RUNTIME = "0x608060405234801561001057600080fd5b50600436106100365760003560e01c8063cbaefbd11461003b578063e357a60514610065575b600080fd5b61004e610049366004610186565b610078565b60405161005c9291906101e2565b60405180910390f35b61004e610073366004610186565b610126565b60405160248101829052306044820181905260648201526000906060906001600160a01b0385169060840160408051601f198184030181529181526020820180516001600160e01b0316635d043b2960e11b179052516100d8919061021e565b6000604051808303816000865af19150503d8060008114610115576040519150601f19603f3d011682016040523d82523d6000602084013e61011a565b606091505b50909590945092505050565b60405160248101829052306044820181905260648201526000906060906001600160a01b0385169060840160408051601f198184030181529181526020820180516001600160e01b0316632d182be560e21b179052516100d8919061021e565b6000806040838503121561019957600080fd5b82356001600160a01b03811681146101b057600080fd5b946020939093013593505050565b60005b838110156101d95781810151838201526020016101c1565b50506000910152565b821515815260406020820152600082518060408401526102098160608501602087016101be565b601f01601f1916919091016060019392505050565b600082516102308184602087016101be565b919091019291505056fea164736f6c634300081c000a";
export const VAULTV2_BALANCEOF_SLOT = 12n;
const XABI = parseAbi([
  "function totalSupply() view returns (uint256)", "function totalAssets() view returns (uint256)", "function decimals() view returns (uint8)",
  "function liquidityData() view returns (bytes)", "function liquidityAdapter() view returns (address)", "function isAdapter(address) view returns (bool)",
  "function balanceOf(address) view returns (uint256)", "function convertToAssets(uint256) view returns (uint256)", "function morphoVaultV1() view returns (address)",
  "function isVaultV2(address) view returns (bool)",
  "function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32, address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function probe(address vault, uint256 assets) returns (bool ok, bytes ret)",
  "function probeRedeem(address vault, uint256 shares) returns (bool ok, bytes ret)",
  "function previewRedeem(uint256) view returns (uint256)",
]);
const MP_T = [{ type: "tuple", components: [{ type: "address", name: "loanToken" }, { type: "address", name: "collateralToken" }, { type: "address", name: "oracle" }, { type: "address", name: "irm" }, { type: "uint256", name: "lltv" }] }];
const xspec = (client, blk, id, to, fn, args = [], extraParams) => callSpec(client, blk, id, to, XABI, fn, args, byABI(XABI, fn), extraParams);
async function xread(cov, client, blk, id, to, fn, args = [], extraParams) { return (await runAll(cov, [xspec(client, blk, id, to, fn, args, extraParams)]))[0]; }

/** What a liquidity route can pay, at the block. Returns {reach, basis} or {noValue: reason}. depth limits recursion. */
async function routeReach(cov, client, blk, vault, depth, pins, tag) {
  const la = await xread(cov, client, blk, `v2:exit:${tag}liquidityAdapter`, vault, "liquidityAdapter");
  if (unread(la)) return { noValue: "the liquidity adapter could not be read" };
  if (isZero(la)) return { reach: 0n, basis: "none (no liquidity adapter)" };
  const mm = pins.morphoMarketV1AdapterV2Factory, v1 = pins.morphoVaultV1AdapterFactory;
  const [isMM0, isV10] = await runAll(cov, [
    ...(mm ? [rspec(client, blk, `v2:exit:${tag}isMM`, mm.address, "isMorphoMarketV1AdapterV2", [la], "bool")] : []),
    ...(v1 ? [rspec(client, blk, `v2:exit:${tag}isV1`, v1.address, "isMorphoVaultV1Adapter", [la], "bool")] : []),
  ]);
  const isMM = mm ? isMM0 : false;
  const isV1pre = v1 ? (mm ? isV10 : isMM0) : false;
  if (unread(isMM)) return { noValue: "the liquidity adapter's attestation could not be read" };
  if (isMM) {
    const ld = await xread(cov, client, blk, `v2:exit:${tag}liquidityData`, vault, "liquidityData");
    if (unread(ld)) return { noValue: "the liquidity adapter's market (liquidityData) could not be read" };
    let mp;
    try { [mp] = decodeAbiParameters(MP_T, ld); } catch { return { noValue: "the liquidity adapter's liquidityData is not a market (undecodable)" }; }
    const id = keccak256(encodeAbiParameters(MP_T, [mp]));
    const [m, p] = await runAll(cov, [xspec(client, blk, `v2:exit:${tag}market`, pins.morphoBlue.address, "market", [id]),
      xspec(client, blk, `v2:exit:${tag}position`, pins.morphoBlue.address, "position", [id, la])]);
    if (unread(m) || unread(p)) return { noValue: "the liquidity market's state could not be read" };
    const [tsa, tss, tba] = m;
    const pos = tss === 0n ? 0n : (p[0] * tsa) / tss;
    const free = tsa > tba ? tsa - tba : 0n;
    return { reach: pos < free ? pos : free, basis: `the liquidity adapter's market ${id.slice(0, 12)}… (position ${pos}, free ${free})`, shared: true };
  }
  const isV1 = isV1pre;
  if (unread(isV1)) return { noValue: "the liquidity adapter's attestation could not be read" };
  if (!isV1) return { noValue: "redemptions are routed through an adapter of unrecognised code" };
  if (depth >= 1) return { noValue: "the liquidity route wraps a vault inside a wrapped vault (beyond depth 1): not followed" };
  const inner = await xread(cov, client, blk, `v2:exit:${tag}inner`, la, "morphoVaultV1");
  if (unread(inner)) return { noValue: "the wrapped vault's address could not be read" };
  const att = await xread(cov, client, blk, `v2:exit:${tag}innerIsV2`, pins.vaultV2Factory.address, "isVaultV2", [inner]);
  if (unread(att)) return { noValue: "whether the wrapped vault is V2 could not be read" };
  if (att !== true) return { noValue: "the wrapped vault is not an attested Vault V2: its exit is not understood" };
  const innerIdle = await (async () => {
    const asset = await read(cov, client, blk, `v2:exit:${tag}innerAssetAddr`, inner, "asset", [], "address");
    if (unread(asset)) return UNREADABLE;
    return read(cov, client, blk, `v2:exit:${tag}innerIdle`, asset, "balanceOf", [inner], "uint");
  })();
  if (unread(innerIdle)) return { noValue: "the wrapped vault's idle balance could not be read" };
  const ir = await routeReach(cov, client, blk, inner, depth + 1, pins, `${tag}inner:`);
  if (ir.noValue) return { noValue: `the wrapped vault's route: ${ir.noValue}` };
  const sh = await xread(cov, client, blk, `v2:exit:${tag}claimShares`, inner, "balanceOf", [la]);
  const claim = unread(sh) ? UNREADABLE : await xread(cov, client, blk, `v2:exit:${tag}claim`, inner, "convertToAssets", [sh]);
  if (unread(claim)) return { noValue: "the wrapping adapter's claim on the wrapped vault could not be read" };
  const innerReach = innerIdle + ir.reach;
  return { reach: claim < innerReach ? claim : innerReach, basis: `the wrapped vault ${inner.slice(0, 10)}… (its idle + ${ir.basis}; this vault's claim ${claim})`, shared: true };
}

/** Compute redeemable-now for an ATTESTED V2 vault and PROVE it by a simulated redeem. Never throws for a chain answer. */
export async function exitLiquidityV2(cov, client, addr, blk, exitPath, pv) {
  const prev = exitPath.redeemableNow;
  if (prev?.status === "no-value") return prev;
  const noValue = (reason) => ({ value: null, status: "no-value", reason, degraded: prev?.degraded ?? [] });
  const gate = (name) => pv?.powers?.find((p) => p.power === name)?.currentValue;
  for (const [g, label] of [["setSendSharesGate", "send-shares"], ["setReceiveAssetsGate", "receive-assets"]]) {
    const v = gate(g);
    if (v === null || v === undefined) return noValue(`the ${label} exit gate could not be read`);
    if (!isZero(v)) return noValue(`an exit gate is set (${label} gate ${v}): whether a given holder can redeem depends on the gate, not on liquidity`);
  }
  if (exitPath.idleAssets === null) return noValue("the vault's idle balance could not be read");
  const idle = BigInt(exitPath.idleAssets);
  const [ta, ts, dec0] = await runAll(cov, [xspec(client, blk, "v2:exit:totalAssets", addr, "totalAssets"),
    xspec(client, blk, "v2:exit:totalSupply", addr, "totalSupply"),
    ...(exitPath.asset ? [xspec(client, blk, "v2:exit:decimals", exitPath.asset, "decimals")] : [])]);
  const dec = exitPath.asset ? dec0 : UNREADABLE;
  if (unread(ta) || unread(ts) || unread(dec)) return noValue("the vault's totals or the asset's decimals could not be read");
  const route = await routeReach(cov, client, blk, addr, 0, client.chain.pins, "");
  if (route.noValue) return noValue(route.noValue);
  const R = idle + route.reach;
  const unit = 10n ** BigInt(dec);
  const delta = R / 1000n > unit ? R / 1000n : unit;

  // ── the PROOF: the probe, by state override, holding the whole supply of shares ──
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [PROBE_ADDRESS, VAULTV2_BALANCEOF_SLOT]));
  const override = { [PROBE_ADDRESS]: { code: PROBE_RUNTIME }, [addr]: { stateDiff: { [slot]: "0x" + ts.toString(16).padStart(64, "0") } } };
  const sim = async (amount, id, fn = "probe") => {
    const v = await xread(cov, client, blk, id, PROBE_ADDRESS, fn, [addr, amount], override);
    return unread(v) ? null : { [fn === "probe" ? "amount" : "shares"]: amount.toString(), call: fn === "probe" ? "withdraw" : "redeem", ok: v[0], revertData: v[0] ? null : v[1] };
  };
  // The ceiling: what EVERY existing share redeems for. Liquidity at or above it (within δ) → prove it by redeem(totalSupply).
  const ceiling = ts > 0n ? await xread(cov, client, blk, "v2:exit:previewRedeemSupply", addr, "previewRedeem", [ts]) : 0n;
  if (unread(ceiling)) return noValue("previewRedeem(totalSupply) could not be read");
  if (ts > 0n && R + delta >= ceiling) {
    const all = await sim(ts, "v2:exit:simulate:redeemAll", "probeRedeem");
    if (all === null) return noValue("the redeem simulation could not be read (an unreadable simulation is NOT a zero)");
    if (all.ok !== true) {
      exitPath.findings.push({ kind: "finding", code: "redeem-simulation-contradicts", text: `the simulated redeem contradicts the computed redeemable-now (${R}, at the supply ceiling ${ceiling}): redeem(totalSupply) reverted` });
      return noValue("the simulated redeem contradicts the computation; no value is given rather than choosing one");
    }
    return {
      value: ceiling.toString(), status: "confirmed", bps: ta > 0n ? Number((ceiling * 10000n) / ta) : null, delta: delta.toString(),
      basis: `every share can be redeemed: liquidity (idle ${idle}${route.reach > 0n ? ` + ${route.basis}` : ""}) covers the whole supply's value ${ceiling}`,
      proof: { method: "eth_call state override: RedeemProbe at PROBE_ADDRESS holding the whole share supply", redeemAll: all },
      note: route.shared ? "point-in-time; the market's free liquidity is SHARED with every other supplier: first come, first served" : "point-in-time",
      degraded: prev?.degraded ?? [],
    };
  }
  const simSpec = (amount, id) => ({ ...xspec(client, blk, id, PROBE_ADDRESS, "probe", [addr, amount], override), amount });
  const [s1, s2] = await runAll(cov, [...(R > 0n ? [simSpec(R, "v2:exit:simulate:atR")] : []), simSpec(R + delta, "v2:exit:simulate:aboveR")]);
  const asSim = (v, amount) => (unread(v) ? null : { amount: amount.toString(), call: "withdraw", ok: v[0], revertData: v[0] ? null : v[1] });
  const atR = R > 0n ? asSim(s1, R) : undefined;
  const aboveR = asSim(R > 0n ? s2 : s1, R + delta);
  if (atR === null || aboveR === null) return noValue("the redeem simulation could not be read (an unreadable simulation is NOT a zero)");
  const contradicts = (atR && atR.ok !== true) || aboveR.ok !== false;
  if (contradicts) {
    exitPath.findings.push({ kind: "finding", code: "redeem-simulation-contradicts", text: `the simulated redeem contradicts the computed redeemable-now (${R}): withdraw(R) ${atR ? (atR.ok ? "succeeded" : "reverted") : "not run"}, withdraw(${R + delta}) ${aboveR.ok ? "succeeded" : "reverted"}` });
    return noValue("the simulated redeem contradicts the computation; no value is given rather than choosing one");
  }
  return {
    value: R.toString(), status: "confirmed", bps: ta > 0n ? Number((R * 10000n) / ta) : null, delta: delta.toString(),
    basis: `idle ${idle}${route.reach > 0n || !route.basis.startsWith("none") ? ` + ${route.basis}` : " (no liquidity adapter)"}`,
    proof: { method: "eth_call state override: RedeemProbe at PROBE_ADDRESS holding the whole share supply", atR: atR ?? null, aboveR: aboveR ?? null },
    note: route.shared ? "point-in-time; the market's free liquidity is SHARED with every other supplier: first come, first served" : "point-in-time",
    degraded: prev?.degraded ?? [],
  };
}
