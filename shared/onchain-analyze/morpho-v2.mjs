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

import { encodeFunctionData, parseAbi, keccak256 } from "viem";
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

/** One eth_call through the coverage door. Returns the decoded value, or UNREADABLE (never a default). */
async function read(cov, client, blk, id, to, fn, args, dec) {
  const data = encodeFunctionData({ abi: ABI, functionName: fn, args });
  const r = await cov.runCheck(id, { kind: "v2" }, async () => {
    const out = await client.call({ method: "eth_call", params: [{ to, data }, blk.tag] });
    return { ...out, result: DEC[dec](out.result) };
  });
  return r.ok ? r.value : UNREADABLE;
}
/** keccak of the runtime code at an address, or null for no code, or UNREADABLE. */
async function codeHash(cov, client, blk, id, address) {
  const r = await cov.runCheck(id, { kind: "v2" }, async () => {
    const out = await client.call({ method: "eth_getCode", params: [address, blk.tag] });
    const c = String(out.result ?? "");
    return { ...out, result: c === "0x" || c === "" ? null : keccak256(c) };
  });
  return r.ok ? r.value : UNREADABLE;
}
const pinCheck = (h, pin) => (unread(h) ? null : h === pin.codeHash);

/**
 * Recognise a Morpho Vault V2 by the PINNED factory's attestation.
 * @returns null when this chain has no V2 pins (NO read made); else
 *   { status: "attested" | "not-v2" | "factory-mismatch" | "unreadable" | "contradictory", ... }
 */
export async function recogniseV2(cov, client, addr, blk, effCode) {
  const f = client.chain?.pins?.vaultV2Factory;
  if (!f) return null;
  const fh = await codeHash(cov, client, blk, "v2:code@vaultV2Factory", f.address);
  const factory = { address: f.address, codeHash: unread(fh) ? null : fh, codeHashMatchesPin: pinCheck(fh, f) };
  const fingerprint = typeof effCode === "string" && !unread(effCode)
    ? (V2_FINGERPRINT.every((s) => hasSel(effCode, s)) ? "agrees" : "disagrees") : "unreadable";
  const base = { method: "factory-attestation", factory, fingerprint, fingerprintSelectors: V2_FINGERPRINT };
  if (unread(fh)) return { ...base, status: "unreadable", why: "the pinned VaultV2Factory's code could not be read, so its attestation cannot be trusted or refused" };
  if (factory.codeHashMatchesPin !== true) return { ...base, status: "factory-mismatch", why: "the code at the pinned VaultV2Factory address does not match its pin: its attestation counts for nothing" };
  const att = await read(cov, client, blk, "v2:isVaultV2", f.address, "isVaultV2", [addr], "bool");
  if (unread(att)) return { ...base, status: "unreadable", attested: null, why: "isVaultV2 could not be read" };
  if (att !== true) return { ...base, status: "not-v2", attested: false, why: "the pinned VaultV2Factory does not attest this address (a V2-looking fingerprint does not make it V2)" };
  if (fingerprint !== "agrees") return { ...base, status: "contradictory", attested: true, why: "the pinned factory attests this vault, but its code lacks V2's governance selectors: the two disagree" };
  return { ...base, status: "attested", attested: true, profile: "morpho-v2" };
}

/** The exit-path guard for an ATTESTED V2 vault. Never throws for a chain answer; reads go through the coverage door. */
export async function exitPathGuardV2(cov, client, addr, blk) {
  const pins = client.chain.pins;
  const blueH = await codeHash(cov, client, blk, "v2:code@morphoBlue", pins.morphoBlue.address);
  const morphoBlue = { address: pins.morphoBlue.address, codeHash: unread(blueH) ? null : blueH, codeHashMatchesPin: pinCheck(blueH, pins.morphoBlue) };

  // The adapter factories that may vouch for an adapter: each counts only if ITS code matches ITS pin.
  const vouchers = [];
  for (const [kind, key, fn] of [["morphoMarketV1AdapterV2", "morphoMarketV1AdapterV2Factory", "isMorphoMarketV1AdapterV2"],
    ["morphoVaultV1Adapter", "morphoVaultV1AdapterFactory", "isMorphoVaultV1Adapter"]]) {
    const p = pins[key];
    if (!p) continue;
    const h = await codeHash(cov, client, blk, `v2:code@${key}`, p.address);
    vouchers.push({ kind, key, fn, address: p.address, codeHashMatchesPin: pinCheck(h, p) });
  }

  const n = await read(cov, client, blk, "v2:adaptersLength", addr, "adaptersLength", [], "uint");
  const list = [];
  let listReadable = !unread(n) && n <= BigInt(MAX_ADAPTERS_READ);
  if (listReadable) {
    for (let i = 0n; i < n; i++) {
      const a = await read(cov, client, blk, `v2:adapters(${i})`, addr, "adapters", [i], "address");
      if (unread(a)) { listReadable = false; break; }
      list.push(a);
    }
  }
  const liq = await read(cov, client, blk, "v2:liquidityAdapter", addr, "liquidityAdapter", [], "address");
  const asset = await read(cov, client, blk, "v2:asset", addr, "asset", [], "address");
  const idle = unread(asset) ? UNREADABLE : await read(cov, client, blk, "v2:idle", asset, "balanceOf", [addr], "uint");

  /** Recognise one adapter by the pinned factories' attestations. */
  async function recognise(a) {
    const h = await codeHash(cov, client, blk, `v2:code@adapter:${lc(a)}`, a);
    let recognisedAs = null, attestedBy = null, attestation = "none";
    for (const v of vouchers) {
      if (v.codeHashMatchesPin !== true) continue; // a factory not matching its pin vouches for nothing
      const yes = await read(cov, client, blk, `v2:${v.fn}:${lc(a)}`, v.address, v.fn, [a], "bool");
      if (unread(yes)) { attestation = "unreadable"; continue; }
      if (yes) { recognisedAs = v.kind; attestedBy = v.address; attestation = "attested"; break; }
    }
    return { address: a, codeHash: unread(h) ? null : h, recognisedAs, attestedBy, attestation };
  }

  const adapters = [];
  for (const a of list) {
    const rec = await recognise(a);
    const real = await read(cov, client, blk, `v2:realAssets:${lc(a)}`, a, "realAssets", [], "uint");
    adapters.push({ ...rec, realAssets: unread(real) ? null : real.toString() });
  }
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
    const rec = inList ? { recognisedAs: inList.recognisedAs, attestedBy: inList.attestedBy, attestation: inList.attestation, codeHash: inList.codeHash } : await recognise(liq);
    const isAd = await read(cov, client, blk, "v2:isAdapter(liquidityAdapter)", addr, "isAdapter", [liq], "bool");
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
