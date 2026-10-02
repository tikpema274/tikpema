// verify-morpho-v2-profile.mjs — DD Morpho V2, STEP 2: recognition by FACTORY ATTESTATION + the exit-path guard.
//
//   npm run test:morphov2profile          (offline: a mock chain keyed by target + calldata)
//
// The recorded design (PROGRESS 2026-09-28 "V2 EXIT PATH" + "BUILD ORDER", T 2026-10-02):
//   1. Recognition is isVaultV2 on the PINNED factory (its code hash checked against the pin). The selector fingerprint
//      is a CROSS-CHECK, never the decision: a V2-looking vault the factory does not attest is UNRECOGNISED.
//   2. On V2 every vault has every power, so a PRESENCE scan says nothing. Until the V2 power model (step 3) exists,
//      a recognised V2 vault's presence groups are NOT CHECKED, with that reason, and the report is a NO-VERDICT.
//   3. An unrecognised LIQUIDITY adapter → redeemable-now has NO VALUE (never 0%, never 100%), with the finding.
//      An unrecognised OTHER adapter degrades its own part, and the report states the share of assets it holds.
//      Morpho Blue's code ≠ its pin → the exit fact has no value. A liquidity adapter that is not an adapter of the
//      vault → redemptions above idle revert (VaultV2.deallocateInternal requires isAdapter): a finding.
//   4. The structure records each instance's attestation and code hash at the block, so a later check can say WHAT
//      changed (compareExitPath).
//   5. A chain with NO V2 pins (arc-testnet: the paid path) is UNCHANGED: no V2 reads, no exitPath, same refusals.

import { encodeFunctionData, parseAbi, keccak256 } from "viem";
import { analyze } from "../../shared/onchain-analyze/index.mjs";
import { POWER_SIGS, sel } from "../../shared/onchain-facts/index.mjs";
import { ERC4626_METHODS } from "../../shared/onchain-facts/vault-profiles.mjs";
import { EIP1967_IMPL_SLOT } from "../../shared/onchain-facts/index.mjs";
const V2 = await import("../../shared/onchain-analyze/morpho-v2.mjs").catch((e) => ({ __loadError: e }));

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 70 - t.length))}`);

ok("the V2 module loads", !V2.__loadError, String(V2.__loadError?.message ?? "").slice(0, 120));

// ── fixture world ───────────────────────────────────────────────────────────────────────────────
const A = (n) => "0x" + n.toString(16).padStart(40, "0");
const VAULT = A(0x1001), OWNER_EOA = A(0x1002), ASSET = A(0x1003);
const VF = A(0x2001), MMF = A(0x2002), V1F = A(0x2003), BLUE = A(0x2004), IRM = A(0x2005);
const AD_MM = A(0x3001), AD_V1 = A(0x3002), AD_X = A(0x3003);
const ZERO = A(0);
const code = (tag) => "0x6080" + Buffer.from(tag).toString("hex") + "00";
const FACTORY_CODE = { [VF]: code("vault-factory"), [MMF]: code("mm-factory"), [V1F]: code("v1-factory"), [BLUE]: code("morpho-blue"), [IRM]: code("irm") };
const pin = (address) => Object.freeze({ address, codeHash: keccak256(FACTORY_CODE[address]), source: "fixture", match: "exact" });
const PINS = Object.freeze({ morphoBlue: pin(BLUE), adaptiveCurveIrm: pin(IRM), vaultV2Factory: pin(VF),
  morphoMarketV1AdapterV2Factory: pin(MMF), morphoVaultV1AdapterFactory: pin(V1F) });
const V2_SIGS = (V2.V2_FINGERPRINT ?? ["liquidityAdapter()", "adaptersLength()", "curator()", "isAllocator(address)", "abdicated(bytes4)", "timelock(bytes4)"]);
const V2_VAULT_CODE = "0x60806040" + [...ERC4626_METHODS, ...V2_SIGS, "owner()"].map(sel).join("") + "00";
const ABI = parseAbi([
  "function isVaultV2(address) view returns (bool)", "function isMorphoMarketV1AdapterV2(address) view returns (bool)",
  "function isMorphoVaultV1Adapter(address) view returns (bool)", "function adaptersLength() view returns (uint256)",
  "function adapters(uint256) view returns (address)", "function liquidityAdapter() view returns (address)",
  "function isAdapter(address) view returns (bool)", "function asset() view returns (address)",
  "function balanceOf(address) view returns (uint256)", "function realAssets() view returns (uint256)",
]);
const data = (fn, args = []) => encodeFunctionData({ abi: ABI, functionName: fn, args });
const W = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");
const WA = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const WB = (b) => W(b ? 1 : 0);

/** A world: { attested, adapters:[{a, kind:'mm'|'v1'|'x', real}], liquidity, idle, overrides } */
function world({ attested = true, adapters = [{ a: AD_MM, kind: "mm", real: 900n }], liquidity = ZERO, isAdapterLiq = true,
  idle = 100n, vaultCode = V2_VAULT_CODE, overrides = {} } = {}) {
  const h = {};
  const put = (to, d, v) => { h[`call@${to.toLowerCase()}@${d}`] = v; };
  h[`code@${VAULT.toLowerCase()}`] = vaultCode;
  h[`slot@${VAULT.toLowerCase()}@${EIP1967_IMPL_SLOT}`] = "0x" + "0".repeat(64);
  put(VAULT, "0x8da5cb5b", WA(OWNER_EOA));
  h[`code@${OWNER_EOA.toLowerCase()}`] = "0x";
  for (const [a, c] of Object.entries(FACTORY_CODE)) h[`code@${a.toLowerCase()}`] = c;
  put(VF, data("isVaultV2", [VAULT]), WB(attested));
  put(VAULT, data("adaptersLength"), W(adapters.length));
  adapters.forEach((ad, i) => {
    put(VAULT, data("adapters", [BigInt(i)]), WA(ad.a));
    h[`code@${ad.a.toLowerCase()}`] = code(`adapter-${ad.a}`);
    put(MMF, data("isMorphoMarketV1AdapterV2", [ad.a]), WB(ad.kind === "mm"));
    put(V1F, data("isMorphoVaultV1Adapter", [ad.a]), WB(ad.kind === "v1"));
    put(ad.a, data("realAssets"), W(ad.real));
  });
  put(VAULT, data("liquidityAdapter"), WA(liquidity));
  if (liquidity !== ZERO) {
    put(VAULT, data("isAdapter", [liquidity]), WB(isAdapterLiq));
    if (!adapters.some((x) => x.a === liquidity)) {
      h[`code@${liquidity.toLowerCase()}`] = code(`adapter-${liquidity}`);
      put(MMF, data("isMorphoMarketV1AdapterV2", [liquidity]), WB(false));
      put(V1F, data("isMorphoVaultV1Adapter", [liquidity]), WB(false));
    }
  }
  put(VAULT, data("asset"), WA(ASSET));
  put(ASSET, data("balanceOf", [VAULT]), W(idle));
  Object.assign(h, overrides);
  return h;
}
const THROW = () => { throw Object.assign(new Error("request limit reached"), { transient: true, query: { endpoint: "mock://", method: "m", params: [], reproduce: "# mock" } }); };
function client(handlers, { pins = PINS } = {}) {
  return {
    chain: { name: "fixture-mainnet", ...(pins ? { pins } : {}) },
    assert: async () => 5042,
    pin: async () => ({ number: 1000, tag: "0x3e8" }),
    async call({ method, params }) {
      const key = method === "eth_getCode" ? `code@${String(params[0]).toLowerCase()}`
        : method === "eth_getStorageAt" ? `slot@${String(params[0]).toLowerCase()}@${String(params[1]).toLowerCase()}`
        : method === "eth_call" ? `call@${String(params[0]?.to).toLowerCase()}@${String(params[0]?.data)}` : method;
      const v = handlers[key];
      if (v === undefined) throw Object.assign(new Error(`mock: unhandled ${key}`), { transient: false, query: { endpoint: "mock://", method, params, reproduce: "# mock" } });
      if (typeof v === "function") return v();
      return { result: v, query: { endpoint: "mock://", method, params, reproduce: `# mock ${key}` }, evidence: { httpStatus: 200 } };
    },
  };
}
const run = (h, o) => analyze(VAULT, { client: client(h, o) });
const powerNotChecked = (r) => r.coverage.notChecked.filter((n) => n.kind === "power");
const v2Reads = (r) => [...r.coverage.checked, ...r.coverage.notChecked].filter((e) => e.kind === "v2");
const noScore = (rn) => rn && rn.value === null && !/"(pct|percent|bps|redeemableBps|share)":\s*(0|10000|100)\b/.test(JSON.stringify(rn));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⭐⭐ RECOGNITION is the pinned factory's attestation, not the fingerprint");
{
  const r = await run(world());
  ok("attested by the PINNED factory → recognised as morpho-v2", r.recognition?.profile === "morpho-v2" && r.recognition?.method === "factory-attestation", JSON.stringify(r.recognition ?? null).slice(0, 140));
  ok("…the factory's code hash was checked against its pin", r.recognition?.factory?.codeHashMatchesPin === true);
  ok("…the fingerprint is recorded as a CROSS-CHECK that agrees", r.recognition?.fingerprint === "agrees");
  ok("…NOT refused as power-surface-unrecognised", r.refusal?.reason !== "power-surface-unrecognised", r.refusal?.reason);

  const n = await run(world({ attested: false }));
  ok("⭐⭐ a V2-LOOKING vault the factory does NOT attest → UNRECOGNISED (the fingerprint never decides)",
    n.refusal?.reason === "power-surface-unrecognised" && n.recognition?.profile !== "morpho-v2", `${n.refusal?.reason} / ${n.recognition?.status}`);
  ok("…and it gets no exitPath", n.exitPath === undefined || n.exitPath === null);

  const m = await run(world({ overrides: { [`code@${VF.toLowerCase()}`]: code("an-impostor-factory") } }));
  ok("⭐ the factory's code ≠ its pin → its attestation counts for nothing → not recognised, refused",
    m.recognition?.profile !== "morpho-v2" && m.refusal !== null && m.recognition?.factory?.codeHashMatchesPin === false, `${m.refusal?.reason} / ${m.recognition?.status}`);

  const u = await run(world({ overrides: { [`call@${VF.toLowerCase()}@${data("isVaultV2", [VAULT])}`]: THROW } }));
  ok("⭐ the attestation UNREADABLE → refused as recognition-unreadable, never 'unrecognised', never recognised",
    u.refusal?.reason === "recognition-unreadable" && u.recognition?.profile !== "morpho-v2", u.refusal?.reason);

  const fp = await run(world({ vaultCode: "0x60806040" + [...ERC4626_METHODS, "owner()"].map(sel).join("") + "00" }));
  ok("⭐ attested, but the code lacks V2's governance selectors → a CONTRADICTION → refused, not recognised",
    fp.refusal?.reason === "recognition-contradictory" && fp.recognition?.fingerprint === "disagrees", `${fp.refusal?.reason} / ${fp.recognition?.fingerprint}`);
}

section("2 — ⭐ on V2 a PRESENCE scan says nothing: the groups are NOT CHECKED until step 3, and it is a NO-VERDICT");
{
  const r = await run(world());
  ok("every presence group is in notChecked (none scanned)", powerNotChecked(r).length === Object.keys(POWER_SIGS).length && r.powers.length === 0, `${powerNotChecked(r).length}/${Object.keys(POWER_SIGS).length}`);
  ok("…each says WHY: presence is meaningless on V2; the power model (timelock · abdicated · current value) is step 3",
    powerNotChecked(r).every((x) => /V2/.test(x.why ?? "") && /timelock/.test(x.why ?? "") && /abdicat/.test(x.why ?? "")));
  ok("⭐⭐ the report is a NO-VERDICT (refusal v2-power-model-not-built), never a clean bill", r.refusal?.reason === "v2-power-model-not-built", r.refusal?.reason);
  ok("powersPresent is empty, not a list of 'present' powers", Array.isArray(r.powersPresent) && r.powersPresent.length === 0);
}

section("3 — the exit path: liquidity adapter unset, one attested market adapter");
{
  const r = await run(world());
  const e = r.exitPath;
  ok("exitPath is present on a recognised V2 vault", !!e && e.profile === "morpho-v2");
  ok("Morpho Blue's code hash = its pin", e?.morphoBlue?.codeHashMatchesPin === true);
  ok("the adapter is recognised as a MorphoMarketV1AdapterV2, attested by the pinned factory",
    e?.adapters?.[0]?.recognisedAs === "morphoMarketV1AdapterV2" && e.adapters[0].attestedBy === MMF);
  ok("⭐ each adapter's code hash at the block is recorded (so a later check can say WHAT changed)", /^0x[0-9a-f]{64}$/.test(e?.adapters?.[0]?.codeHash ?? ""));
  ok("its share of the vault's real assets is stated, with its source (900 / (100 idle + 900) = 90.00%)",
    e?.adapters?.[0]?.shareBps === 9000 && /realAssets/.test(e?.adapters?.[0]?.shareSource ?? ""), `${e?.adapters?.[0]?.shareBps}`);
  ok("the liquidity adapter is recorded as UNSET (redemptions are served from idle only)", e?.liquidityAdapter?.set === false);
  ok("⭐ redeemable-now carries NO number yet (computed in step 4), and says so", noScore(e?.redeemableNow) && e?.redeemableNow?.status === "not-computed", JSON.stringify(e?.redeemableNow));
  ok("no findings on a fully recognised path", Array.isArray(e?.findings) && e.findings.length === 0, JSON.stringify(e?.findings));
}

section("4 — ⭐⭐ an UNRECOGNISED LIQUIDITY adapter → redeemable-now has NO VALUE, never 0% or 100%");
{
  const r = await run(world({ adapters: [{ a: AD_MM, kind: "mm", real: 500n }, { a: AD_X, kind: "x", real: 400n }], liquidity: AD_X }));
  const e = r.exitPath;
  ok("the liquidity adapter is recorded as set and UNRECOGNISED", e?.liquidityAdapter?.set === true && e.liquidityAdapter.recognisedAs === null, JSON.stringify(e?.liquidityAdapter));
  ok("⭐⭐ redeemableNow.value is null, status no-value — no 0, no 100", noScore(e?.redeemableNow) && e?.redeemableNow?.status === "no-value", JSON.stringify(e?.redeemableNow));
  ok("⭐ the finding names it: redemptions are routed through an adapter of unrecognised code",
    (e?.findings ?? []).some((f) => /redemptions are routed through an adapter of unrecognised code/.test(f.text)), JSON.stringify(e?.findings));
}

section("5 — ⭐ an UNRECOGNISED OTHER adapter degrades its own part and states the share it holds");
{
  const r = await run(world({ adapters: [{ a: AD_MM, kind: "mm", real: 600n }, { a: AD_X, kind: "x", real: 300n }] }));
  const e = r.exitPath;
  ok("that adapter is recorded as unrecognised (its part degraded), the other stays recognised",
    e?.adapters?.find((x) => x.address === AD_X)?.recognisedAs === null && e?.adapters?.find((x) => x.address === AD_MM)?.recognisedAs === "morphoMarketV1AdapterV2");
  ok("⭐⭐ the finding states its share: 'an adapter of unrecognised code holds 30.00% of this vault's assets'",
    (e?.findings ?? []).some((f) => /an adapter of unrecognised code holds 30\.00% of this vault's assets/.test(f.text)), JSON.stringify(e?.findings));
  ok("…and that finding is a FINDING (kind finding), not a gap", (e?.findings ?? []).some((f) => f.kind === "finding" && /30\.00%/.test(f.text)));
  ok("…it does NOT by itself take the exit fact's value away (only its own part is degraded)", e?.redeemableNow?.status === "not-computed" && (e?.redeemableNow?.degraded ?? []).includes(AD_X), JSON.stringify(e?.redeemableNow));

  const u = await run(world({ adapters: [{ a: AD_MM, kind: "mm", real: 600n }, { a: AD_X, kind: "x", real: 300n }],
    overrides: { [`call@${AD_X.toLowerCase()}@${data("realAssets")}`]: THROW } }));
  ok("its realAssets unreadable → the share is stated as UNKNOWN, never a number", (u.exitPath?.findings ?? []).some((f) => /holds an unknown share/.test(f.text)) && !(u.exitPath?.findings ?? []).some((f) => /holds \d/.test(f.text)), JSON.stringify(u.exitPath?.findings));
  ok("…and no adapter carries a shareBps then (the denominator is unknown)", (u.exitPath?.adapters ?? []).every((x) => x.shareBps === null));
}

section("6 — Morpho Blue ≠ its pin → the exit fact has NO VALUE; a non-adapter liquidity adapter → finding");
{
  const r = await run(world({ overrides: { [`code@${BLUE.toLowerCase()}`]: code("not-morpho-blue") } }));
  ok("⭐ Morpho Blue's code hash ≠ pin → redeemableNow no-value, reason names Morpho Blue",
    noScore(r.exitPath?.redeemableNow) && r.exitPath?.redeemableNow?.status === "no-value" && /Morpho Blue/.test(r.exitPath?.redeemableNow?.reason ?? ""), JSON.stringify(r.exitPath?.redeemableNow));
  const b = await run(world({ overrides: { [`code@${BLUE.toLowerCase()}`]: THROW } }));
  ok("Morpho Blue's code UNREADABLE → no-value too (never assumed to match)", b.exitPath?.redeemableNow?.status === "no-value" && b.exitPath?.morphoBlue?.codeHashMatchesPin === null);

  const L = A(0x3009);
  const n = await run(world({ liquidity: L, isAdapterLiq: false }));
  ok("⭐ a liquidity adapter that is NOT an adapter of the vault → the finding: redemptions above idle revert",
    (n.exitPath?.findings ?? []).some((f) => /not an adapter of this vault/.test(f.text) && /revert/.test(f.text)), JSON.stringify(n.exitPath?.findings));
  ok("…and redeemable-now has no value", n.exitPath?.redeemableNow?.status === "no-value");
}

section("7 — the vault-wrapping adapter; an adapter factory whose code ≠ its pin");
{
  const r = await run(world({ adapters: [{ a: AD_V1, kind: "v1", real: 900n }] }));
  ok("attested by the pinned MorphoVaultV1AdapterFactory → recognised as morphoVaultV1Adapter", r.exitPath?.adapters?.[0]?.recognisedAs === "morphoVaultV1Adapter" && r.exitPath.adapters[0].attestedBy === V1F);
  const m = await run(world({ overrides: { [`code@${MMF.toLowerCase()}`]: code("impostor-mm-factory") } }));
  ok("⭐ the adapter factory's code ≠ its pin → its attestation counts for nothing → the adapter is unrecognised",
    m.exitPath?.adapters?.[0]?.recognisedAs === null, JSON.stringify(m.exitPath?.adapters?.[0]));
}

section("8 — ⭐ WHAT changed between two checks (compareExitPath)");
{
  const a = (await run(world({ adapters: [{ a: AD_MM, kind: "mm", real: 900n }] }))).exitPath;
  const b = (await run(world({ adapters: [{ a: AD_MM, kind: "mm", real: 900n }], liquidity: AD_MM }))).exitPath;
  const ch = typeof V2.compareExitPath === "function" ? V2.compareExitPath(a, b) : null;
  ok("⭐⭐ the liquidity adapter changed → detected, naming the old and new address",
    Array.isArray(ch) && ch.some((c) => c.what === "liquidityAdapter" && c.from === null && c.to === AD_MM), JSON.stringify(ch));
  const c2 = (await run(world({ overrides: { [`code@${AD_MM.toLowerCase()}`]: code("different-code-same-address") } }))).exitPath;
  const ch2 = typeof V2.compareExitPath === "function" ? V2.compareExitPath(a, c2) : null;
  ok("⭐ a different code hash at the SAME adapter address → detected", Array.isArray(ch2) && ch2.some((c) => c.what === "adapterCodeHash" && c.address === AD_MM), JSON.stringify(ch2));
  ok("no change → an empty list", typeof V2.compareExitPath === "function" && V2.compareExitPath(a, a).length === 0);
}

section("9 — ⛔ a chain with NO V2 pins (arc-testnet, the paid path) is UNCHANGED");
{
  const r = await run(world(), { pins: null });
  ok("⭐⭐ no V2 reads at all (no isVaultV2, no factory code)", v2Reads(r).length === 0, String(v2Reads(r).length));
  ok("no exitPath, no recognition block", r.exitPath === undefined && r.recognition === undefined);
  ok("the V2-shaped vault is refused exactly as before: power-surface-unrecognised", r.refusal?.reason === "power-surface-unrecognised", r.refusal?.reason);
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0\n`);
