#!/usr/bin/env node
// verify-redemption-signal.mjs — maxRedeem is interpreted ONLY under a recognised vault profile.
//
//   node --experimental-test-module-mocks scripts/verify-redemption-signal.mjs   (npm run test:redemptionsignal)
//
// ═══ THE DEFECT (measured 2026-09-26, PROGRESS "MORPHO V2 ON ARC MAINNET") ═══════════════════════
// `maxRedeem` means different things per vault type, and two sites read it as if it meant one thing:
//   · inspectVault (_vault.mjs)           — full | partial | BLOCKED | unknown
//   · state-reads.mjs (the mandate check) — the same, feeding `redemption-restricted`
// On Morpho Vault V2 `maxRedeem` ALWAYS returns 0, by design ("Gross underestimation because being
// revert-free cannot be guaranteed when calling the gate" — VaultV2.sol). So a V2 holder read as
// "blocked": a FALSE redemption-restricted finding ("you can redeem none of your shares") on a vault
// that is fully liquid. The third site is any liquidity reader that trusts an inner vault's max* —
// the 2026-09-26 probe read 0% where the vault was 100% redeemable.
//
// ═══ THE RULE ═════════════════════════════════════════════════════════════════════════════════
// A read whose MEANING depends on the vault type is interpreted only under a RECOGNISED profile —
// the same rule the recognition gate (4bc0d03) applies to owner powers. Each profile declares its
// redemption signal: xylo → maxRedeem; morpho-v2 → exit liquidity + a simulated redeem (not built);
// unrecognised → UNKNOWN with a reason. Never "blocked", never "full".
//
// ⚠️ The new module is loaded DEFENSIVELY, so on the pre-fix code the behavioural sections still run
// and show the defect red (a V2 holder reading "blocked"), rather than the suite dying at import.

import { mock } from "node:test";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { toFunctionSelector } from "viem";
import { codeWith } from "./dd/_mock-chain.mjs";
import { readStateAtAnchor } from "../shared/vault-mandate/state-reads.mjs";
import { observeMandateCheck } from "../shared/vault-mandate/observe.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const show = (o) => JSON.stringify(o ?? null, (k, v) => (typeof v === "bigint" ? v.toString() : v))?.slice(0, 200);
const attempt = (fn) => { try { return fn(); } catch (e) { return { threw: String(e?.message ?? e) }; } };

const SIG = await import("../shared/vault-redemption.mjs").catch((e) => ({ __missing: String(e?.message ?? e) }));
const CHECK = await import("../netlify/functions/_vault-mandate-check.mjs");
const MAX_REDEEM = "max-redeem"; // the declared signal name; pinned against the module below

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  maxRedeem is read only under a RECOGNISED profile                   ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — the declaration: which profile's maxRedeem means what");
{
  ok("the module exists (shared/vault-redemption.mjs)", !SIG.__missing, SIG.__missing ?? "");
  const f = SIG.redemptionSignalFor;
  ok("xylo → maxRedeem (xylo's maxRedeem is its balanceOf, verified source)", f?.("xylo")?.signal === MAX_REDEEM && SIG.REDEMPTION_SIGNAL?.MAX_REDEEM === MAX_REDEEM, show(f?.("xylo")));
  const u = f?.(null);
  ok("⭐ an UNRECOGNISED vault (no profile) → no signal, with a reason", u?.signal === null && typeof u?.why === "string" && /not recogni/i.test(u.why), show(u));
  ok("  a profile name nobody declared → no signal", f?.("some-future-profile")?.signal === null);
  const v2 = f?.("morpho-v2");
  ok("⭐ the shape accommodates morpho-v2: declared as exit liquidity, and NOT BUILT → no signal yet, says so",
    SIG.PROFILE_REDEMPTION_SIGNAL?.["morpho-v2"] === SIG.REDEMPTION_SIGNAL?.EXIT_LIQUIDITY && v2?.signal === null && /not built/i.test(v2?.why ?? ""), show(v2));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ONE classifier for both sites");
{
  const c = (o) => SIG.classifyRedemption?.({ signal: MAX_REDEEM, maxRedeem: 100n, shares: 100n, ...o });
  ok("xylo semantics unchanged: maxRedeem ≥ balance → full", c({})?.state === "full");
  ok("  0 < maxRedeem < balance → partial, with the redeemable shares", c({ maxRedeem: 40n })?.state === "partial" && c({ maxRedeem: 40n })?.redeemableShares === 40n);
  ok("  maxRedeem a confirmed 0 with shares held → blocked", c({ maxRedeem: 0n })?.state === "blocked");
  ok("  no shares held → full (nothing is withheld)", c({ shares: 0n, maxRedeem: 0n })?.state === "full");
  ok("  an unread maxRedeem → unknown, never blocked", c({ maxRedeem: null })?.state === "unknown");
  const v2 = SIG.classifyRedemption?.({ signal: null, why: "not recognised", maxRedeem: 0n, shares: 5n * 10n ** 18n });
  ok("⭐⭐ NO signal + maxRedeem 0 + shares held → UNKNOWN, not blocked", v2?.state === "unknown", show(v2));
  ok("  …and it carries the reason", /not recognised/.test(v2?.why ?? ""));
  const v2full = SIG.classifyRedemption?.({ signal: null, why: "x", maxRedeem: 10n ** 30n, shares: 1n });
  ok("⭐ NO signal never reads FULL either, whatever maxRedeem says", v2full?.state === "unknown", show(v2full));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐⭐ site 1: inspectVault, end to end on synthetic bytecode");
const USDC = "0x3600000000000000000000000000000000000000";
const EOA = "0x5b967871bb9b2ce1ac7e3a3a2ab2ec5c1e4b8a2f";
const HOLDER = "0x3d7d4c52305ed0c394e01c7184701a522116097d";
const VAULT = "0x240Eb85458CD41361bd8C3773253a1D78054f747";
const ERC4626 = ["asset()", "totalAssets()", "convertToShares(uint256)", "convertToAssets(uint256)", "maxDeposit(address)",
  "maxWithdraw(address)", "previewDeposit(uint256)", "previewRedeem(uint256)", "deposit(uint256,address)", "mint(uint256,address)",
  "withdraw(uint256,address,address)", "redeem(uint256,address,address)", "maxRedeem(address)", "balanceOf(address)"];
const XYLO_GOV = ["setFees(uint256,uint256,uint256)", "emergencyWithdraw(address,uint256)", "owner()"];
// The governance selectors MEASURED in the deployed Morpho VaultV2 bytecode on Arc mainnet (2026-09-26).
const V2_GOV = ["submit(bytes)", "revoke(bytes)", "setIsSentinel(address,bool)", "setIsAllocator(address,bool)", "setCurator(address)",
  "setOwner(address)", "setPerformanceFee(uint256)", "setManagementFee(uint256)", "setSendSharesGate(address)", "abdicate(bytes4)",
  "forceDeallocate(address,bytes,uint256,address)", "liquidityAdapter()", "owner()"];
const SHARES = 5n * 10n ** 18n;
const fakeClient = (code, { maxRedeem, shares }) => () => ({
  getBytecode: async ({ address }) => (address.toLowerCase() === VAULT.toLowerCase() ? code : "0x"),
  multicall: async ({ contracts }) => contracts.map((c) => {
    const v = {
      asset: USDC, totalAssets: 8_000_000_000_000n, decimals: 18, symbol: "mv", name: "Mock Vault", totalSupply: 8n * 10n ** 24n,
      withdrawFee: 10n, depositFee: 0n, performanceFee: 0n, MAX_FEE: 2000n, owner: EOA,
      convertToAssets: 1_000_000n, previewRedeem: 999_000n, maxRedeem, balanceOf: shares,
    }[c.functionName];
    return v === undefined ? { status: "failure", error: new Error("absent") } : { status: "success", result: v };
  }),
  readContract: async ({ functionName }) => ({ maxRedeem, balanceOf: shares })[functionName],
  getStorageAt: async () => "0x" + "0".repeat(64),
});
const inspectWith = async (gov, vals) => {
  mock.restoreAll();
  mock.module("../netlify/functions/_predict.mjs", { namedExports: { publicClient: fakeClient(codeWith([...ERC4626, ...gov]), vals) } });
  const { inspectVault } = await import(`../netlify/functions/_vault.mjs?t=${Math.random()}`);
  return inspectVault(VAULT, { owner: HOLDER });
};
{
  const v2 = await inspectWith(V2_GOV, { maxRedeem: 0n, shares: SHARES });
  ok("(control) the V2-shaped vault is UNRECOGNISED by the registry", v2?.powers?.profile === null || v2?.ownerPowers?.profile === null || JSON.stringify(v2).includes("power-surface-unrecognised"));
  ok("⭐⭐ V2-shaped (maxRedeem 0, shares held, fully liquid) → redemption is NOT 'blocked'", v2?.redemption?.state !== "blocked", show(v2?.redemption?.state));
  ok("⭐⭐  …it is 'unknown', with a reason naming the unrecognised vault type", v2?.redemption?.state === "unknown" && /not recogni/i.test(v2?.redemption?.why ?? ""), show({ s: v2?.redemption?.state, why: v2?.redemption?.why }));
  ok("  …no redeemable figure is invented (null = unknown)", v2?.redemption?.redeemableShares === null, show(v2?.redemption?.redeemableShares));
  ok("  …the position itself is still reported (balanceOf is not type-dependent)", v2?.redemption?.positionShares === SHARES.toString());

  const xb = await inspectWith(XYLO_GOV, { maxRedeem: 0n, shares: SHARES });
  ok("⭐ xylo UNCHANGED: maxRedeem 0 with shares held → blocked", xb?.redemption?.state === "blocked", show(xb?.redemption));
  const xf = await inspectWith(XYLO_GOV, { maxRedeem: SHARES, shares: SHARES });
  ok("  xylo: maxRedeem = balance → full", xf?.redemption?.state === "full", show(xf?.redemption?.state));
  const xp = await inspectWith(XYLO_GOV, { maxRedeem: SHARES / 2n, shares: SHARES });
  ok("  xylo: half → partial, with the redeemable shares", xp?.redemption?.state === "partial" && xp?.redemption?.redeemableShares === (SHARES / 2n).toString(), show(xp?.redemption));
}
mock.restoreAll();

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⭐⭐ site 2: the mandate check's state reads → observe");
const ANCHOR = { blockNumber: 999, blockHash: "0x" + "11".repeat(32) };
const MVAULT = { key: "some-v2-vault", address: VAULT, assetAddress: "0x" + "36".repeat(20), chainId: 31337 }; // fixture chain id (test:literals)
function reader(endpoint, { maxRedeem, shares }) {
  const seen = [];
  const vals = { withdrawFee: 10n, depositFee: 0n, decimals: 18n, balanceOf: shares, maxRedeem, convertToAssets: 1_000_000n, previewRedeem: 999_000n, totalAssets: 1n, MAX_FEE: 2000n };
  return { endpoint, seen,
    async read({ address, fn }) { seen.push(fn); return fn === "balanceOf" && String(address).toLowerCase() === MVAULT.assetAddress ? 10n ** 12n : vals[fn]; },
    async simulateRedeem() { return { outcome: "returned", assetsRaw: "5000000" }; } };
}
const read = (signal, vals, ep = "https://a.example") => { const r = reader(ep, vals); return readStateAtAnchor({ reader: r, vault: MVAULT, holder: HOLDER, anchor: ANCHOR, cashOnly: false, redemptionSignal: signal }).then((x) => ({ x, seen: r.seen })); };
{
  const noSig = SIG.redemptionSignalFor?.(null) ?? { signal: null, why: "not recognised" };
  const { x: v2, seen } = await read(noSig, { maxRedeem: 0n, shares: SHARES });
  ok("⭐⭐ V2-shaped reader, no signal → redemption is NOT 'blocked'", v2?.redemption?.state !== "blocked", show(v2?.redemption));
  ok("⭐⭐  …it is 'unknown' with the reason", v2?.redemption?.state === "unknown" && /not recogni/i.test(v2?.redemption?.why ?? ""), show(v2?.redemption));
  ok("  …maxRedeem is not even READ without a signal (a vault lacking it cannot fail the reading)", !seen.includes("maxRedeem"), seen.join(","));
  ok("  …the reading as a whole is still ok (fees, position, payability)", v2?.ok === true && v2?.redemption?.positionShares === SHARES.toString(), show(v2?.why ?? v2?.ok));
  const { x: b } = await read(noSig, { maxRedeem: 0n, shares: SHARES }, "https://b.example");
  const obs = observeMandateCheck({ rules: [{ id: "r1", kind: "state", subject: "redemption-restricted", onFinding: "pause" }],
    vault: { address: VAULT, chainId: 31337 }, anchor: ANCHOR, maxReportAgeBlocks: 0, report: null, reportFailure: "n/a", stateReadings: [v2, b] });
  const o = obs?.observations?.r1;
  ok("⭐⭐ observe: redemption-restricted on a V2 holder is UNESTABLISHED (inconclusive), NOT a finding", o?.status === "unestablished" && o?.cause === "inconclusive", show(o));

  const xylo = SIG.redemptionSignalFor?.("xylo") ?? { signal: MAX_REDEEM };
  const { x: xb } = await read(xylo, { maxRedeem: 0n, shares: SHARES });
  ok("⭐ xylo UNCHANGED in the mandate reads: maxRedeem 0 with shares → blocked", xb?.redemption?.state === "blocked", show(xb?.redemption));
  const { x: xf } = await read(xylo, { maxRedeem: SHARES, shares: SHARES });
  ok("  xylo: full", xf?.redemption?.state === "full");
  const { x: xp } = await read(xylo, { maxRedeem: 1n, shares: SHARES });
  ok("  xylo: partial", xp?.redemption?.state === "partial");
  const { x: missing } = await read(undefined, { maxRedeem: SHARES, shares: SHARES });
  ok("⭐ a caller that passes NO signal gets unknown (fail-safe), never the old maxRedeem reading", missing?.redemption?.state === "unknown", show(missing?.redemption));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — the allowlist declaration, beside CASH_ONLY_VAULTS");
{
  const d = CHECK.VAULT_PROFILE_OF;
  ok("xylo-usdc is declared a xylo-profile vault", d?.["xylo-usdc"] === "xylo", show(d));
  ok("  …so its signal is maxRedeem", CHECK.redemptionSignalForVault?.("xylo-usdc")?.signal === MAX_REDEEM);
  ok("  an undeclared vault key → no signal", CHECK.redemptionSignalForVault?.("not-a-vault")?.signal === null);
  // ⭐ Widening the allowlist without declaring the new vault's profile must go red here.
  const { VAULT_ALLOWLIST } = await import(`../netlify/functions/_vault.mjs?t=${Math.random()}`);
  const undeclared = Object.keys(VAULT_ALLOWLIST).filter((k) => !d || !(k in d));
  ok("⭐ EVERY allowlisted vault declares its profile (widening without a declaration is red)", d && undeclared.length === 0, undeclared.join(","));
  const pd = CHECK.productionDeps?.({ health: async () => ({}), resolveVault: () => null });
  ok("production wiring passes the declaration to the check", typeof pd?.redemptionSignal === "function" && pd.redemptionSignal("xylo-usdc")?.signal === MAX_REDEEM);
  const src = readFileSync("netlify/functions/_vault-mandate-check.mjs", "utf8");
  ok("runMandateCheck hands every reading its redemption signal", /redemptionSignal:\s*deps\.redemptionSignal/.test(src));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — site 3: nothing else reads max* and interprets it");
{
  const walk = (dir) => !existsSync(dir) ? [] : readdirSync(dir).flatMap((n) => { const p = `${dir}/${n}`; return n === "node_modules" || n.startsWith(".") ? [] : statSync(p).isDirectory() ? walk(p) : [p]; });
  const files = ["netlify/functions", "shared", "src"].flatMap(walk).filter((f) => /\.(mjs|js|ts|tsx)$/.test(f));
  // A CALL of maxRedeem/maxWithdraw: functionName: "maxRedeem" or read("maxRedeem" …), not a selector list or ABI line.
  const calls = files.filter((f) => /functionName:\s*"max(Redeem|Withdraw)"|\bread\(\s*"max(Redeem|Withdraw)"/.test(readFileSync(f, "utf8")));
  const allowed = ["netlify/functions/_vault.mjs", "shared/vault-mandate/state-reads.mjs"];
  ok("⭐ only the two sites read maxRedeem/maxWithdraw", calls.every((f) => allowed.includes(f)), calls.join(", "));
  ok("  …and both interpret it ONLY through classifyRedemption", allowed.every((f) => /classifyRedemption\(/.test(readFileSync(f, "utf8"))));
  const stateSrc = readFileSync("shared/vault-mandate/state-reads.mjs", "utf8");
  ok("  state-reads.mjs no longer maps maxRedeem to a state itself", !/maxRedeem === 0n \? "blocked"/.test(stateSrc));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — off the DD surface");
{
  const stamp = readFileSync("scripts/stamp-build.mjs", "utf8");
  const dirs = JSON.parse(stamp.match(/const DD_SURFACE_DIRS = (\[[^\]]*\])/)[1]);
  const filesList = [...stamp.match(/const DD_SURFACE_FILES = \[([\s\S]*?)\n\];/)[1].matchAll(/^\s*"([^"]+)"/gm)].map((m) => m[1]);
  const changed = execFileSync("git", ["diff", "--name-only", "HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean)
    .concat(execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter(Boolean));
  const onSurface = changed.filter((f) => dirs.some((d) => f.startsWith(`${d}/`)) || filesList.includes(f));
  ok("⭐ no changed or new file is on the DD surface (no ddTree rotation)", onSurface.length === 0, onSurface.join(", ") || `${changed.length} files checked`);
  ok("  the new module is not under a DD directory", !dirs.some((d) => "shared/vault-redemption.mjs".startsWith(`${d}/`)));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
