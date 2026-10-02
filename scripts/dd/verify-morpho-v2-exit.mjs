// verify-morpho-v2-exit.mjs — DD Morpho V2, STEP 4: the EXIT-LIQUIDITY FACT, PROVEN BY A SIMULATED REDEEM.
//
//   npm run test:morphov2exit          (offline: mock chain keyed by target + calldata; the probe's override is ignored)
//
// The design (09-26 / 09-28 records; T 2026-10-02):
//   · redeemable-now = idle + what the LIQUIDITY ADAPTER's route can pay (a market adapter: the vault's position in the ONE
//     market named by liquidityData, capped by that market's free liquidity; a vault-wrapping adapter: the inner vault's
//     own route, depth 1, only if the inner vault is itself attested V2). That computed amount R is a CANDIDATE.
//   · ⭐ THE PROOF is a simulated redeem: a probe contract placed by state override (never deployed) holding shares by
//     override calls withdraw(R) and withdraw(R + δ) and RETURNS (ok, revertData), so both endpoints agree on a revert
//     as an ordinary value. Confirmed = R succeeds AND R + δ reverts.
//   · ⛔⛔ An UNREADABLE simulation gives redeemable-now NO VALUE, never 0. On Galaxy today a proven 0 and an unreadable
//     simulation would look identical as a number; they mean "nothing can leave" vs "we could not tell".
//   · A simulation that CONTRADICTS the computation (R reverts, or R + δ succeeds) → no value + a finding; never pick one.
//   · An exit gate set → no value (whether a given holder can exit depends on the gate, not on liquidity).

import { encodeFunctionData, encodeFunctionResult, encodeAbiParameters, parseAbi, keccak256, toFunctionSelector } from "viem";
import { analyze } from "../../shared/onchain-analyze/index.mjs";
import { sel, EIP1967_IMPL_SLOT } from "../../shared/onchain-facts/index.mjs";
import { ERC4626_METHODS } from "../../shared/onchain-facts/vault-profiles.mjs";
const V2 = await import("../../shared/onchain-analyze/morpho-v2.mjs").catch((e) => ({ __loadError: e }));

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 70 - t.length))}`);
const TIMELOCKED = ["setIsAllocator(address,bool)", "setReceiveSharesGate(address)", "setSendSharesGate(address)", "setReceiveAssetsGate(address)", "setSendAssetsGate(address)",
  "setAdapterRegistry(address)", "addAdapter(address)", "removeAdapter(address)", "increaseTimelock(bytes4,uint256)", "decreaseTimelock(bytes4,uint256)", "abdicate(bytes4)",
  "setPerformanceFee(uint256)", "setManagementFee(uint256)", "setPerformanceFeeRecipient(address)", "setManagementFeeRecipient(address)",
  "increaseAbsoluteCap(bytes,uint256)", "increaseRelativeCap(bytes,uint256)", "setForceDeallocatePenalty(address,uint256)"];
ok("the V2 module loads", !V2.__loadError, String(V2.__loadError?.message ?? "").slice(0, 120));
ok("the probe address and runtime are exported", typeof V2.PROBE_ADDRESS === "string" && /^0x[0-9a-fA-F]{40}$/.test(V2.PROBE_ADDRESS ?? "") && /^0x[0-9a-f]{100,}$/.test(V2.PROBE_RUNTIME ?? ""));

// ── fixture world (a recognised V2 vault; step 2's reads answered, plus the power reads) ─────────────────────────────
const A = (n) => "0x" + n.toString(16).padStart(40, "0");
const VAULT = A(0x1001), OWNER = A(0x1002), ASSET = A(0x1003), CURATOR = A(0x1004), FEE_REC = A(0x1005), GATE = A(0x1006);
const VF = A(0x2001), MMF = A(0x2002), V1F = A(0x2003), BLUE = A(0x2004), IRM = A(0x2005), AD = A(0x3001), ZERO = A(0);
const code = (t) => "0x6080" + Buffer.from(t).toString("hex") + "00";
const FC = { [VF]: code("vf"), [MMF]: code("mmf"), [V1F]: code("v1f"), [BLUE]: code("blue"), [IRM]: code("irm") };
const pin = (a) => Object.freeze({ address: a, codeHash: keccak256(FC[a]), source: "fixture", match: "exact" });
const PINS = Object.freeze({ morphoBlue: pin(BLUE), adaptiveCurveIrm: pin(IRM), vaultV2Factory: pin(VF), morphoMarketV1AdapterV2Factory: pin(MMF), morphoVaultV1AdapterFactory: pin(V1F) });
const FP = V2.V2_FINGERPRINT ?? ["liquidityAdapter()", "adaptersLength()", "curator()", "isAllocator(address)", "abdicated(bytes4)", "timelock(bytes4)"];
const VCODE = "0x60806040" + [...ERC4626_METHODS, ...FP, "owner()"].map(sel).join("") + "00";
const ABI = parseAbi([
  "function isVaultV2(address) view returns (bool)", "function isMorphoMarketV1AdapterV2(address) view returns (bool)", "function isMorphoVaultV1Adapter(address) view returns (bool)",
  "function adaptersLength() view returns (uint256)", "function adapters(uint256) view returns (address)", "function liquidityAdapter() view returns (address)",
  "function isAdapter(address) view returns (bool)", "function asset() view returns (address)", "function balanceOf(address) view returns (uint256)", "function realAssets() view returns (uint256)",
  "function timelock(bytes4) view returns (uint256)", "function abdicated(bytes4) view returns (bool)", "function owner() view returns (address)", "function curator() view returns (address)",
  "function performanceFee() view returns (uint96)", "function managementFee() view returns (uint96)", "function performanceFeeRecipient() view returns (address)",
  "function managementFeeRecipient() view returns (address)", "function receiveSharesGate() view returns (address)", "function sendSharesGate() view returns (address)",
  "function receiveAssetsGate() view returns (address)", "function sendAssetsGate() view returns (address)", "function adapterRegistry() view returns (address)",
  "function maxRate() view returns (uint64)", "function forceDeallocatePenalty(address) view returns (uint256)",
]);
const d = (fn, args = []) => encodeFunctionData({ abi: ABI, functionName: fn, args });
const W = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");
const WA = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const S4 = (sig) => toFunctionSelector(sig);
const DAY = 86400;

/** timelocks: {sig: seconds}, abdicated: [sig], default 0 / false. */
function world({ timelocks = {}, abdicated = [], overrides = {} } = {}) {
  const h = {};
  const put = (to, data, v) => { h[`call@${to.toLowerCase()}@${data}`] = v; };
  h[`code@${VAULT.toLowerCase()}`] = VCODE;
  h[`slot@${VAULT.toLowerCase()}@${EIP1967_IMPL_SLOT}`] = "0x" + "0".repeat(64);
  put(VAULT, "0x8da5cb5b", WA(OWNER)); h[`code@${OWNER.toLowerCase()}`] = "0x";
  for (const [a, c] of Object.entries(FC)) h[`code@${a.toLowerCase()}`] = c;
  put(VF, d("isVaultV2", [VAULT]), W(1));
  put(VAULT, d("adaptersLength"), W(1)); put(VAULT, d("adapters", [0n]), WA(AD)); h[`code@${AD.toLowerCase()}`] = code("ad");
  put(MMF, d("isMorphoMarketV1AdapterV2", [AD]), W(1)); put(V1F, d("isMorphoVaultV1Adapter", [AD]), W(0)); put(AD, d("realAssets"), W(900));
  put(VAULT, d("liquidityAdapter"), WA(ZERO)); put(VAULT, d("asset"), WA(ASSET)); put(ASSET, d("balanceOf", [VAULT]), W(100));
  for (const sig of TIMELOCKED) { put(VAULT, d("timelock", [S4(sig)]), W(timelocks[sig] ?? 0)); put(VAULT, d("abdicated", [S4(sig)]), W(abdicated.includes(sig) ? 1 : 0)); }
  put(VAULT, d("owner"), WA(OWNER)); put(VAULT, d("curator"), WA(CURATOR));
  put(VAULT, d("performanceFee"), W(10n ** 17n)); put(VAULT, d("managementFee"), W(0)); put(VAULT, d("performanceFeeRecipient"), WA(FEE_REC)); put(VAULT, d("managementFeeRecipient"), WA(ZERO));
  put(VAULT, d("receiveSharesGate"), WA(ZERO)); put(VAULT, d("sendSharesGate"), WA(ZERO)); put(VAULT, d("receiveAssetsGate"), WA(GATE)); put(VAULT, d("sendAssetsGate"), WA(ZERO));
  put(VAULT, d("adapterRegistry"), WA(ZERO)); put(VAULT, d("maxRate"), W(0)); put(VAULT, d("forceDeallocatePenalty", [AD]), W(10n ** 16n));
  Object.assign(h, overrides);
  return h;
}
const THROW = () => { throw Object.assign(new Error("request limit reached"), { transient: true, query: { endpoint: "mock://", method: "m", params: [], reproduce: "# mock" } }); };
function client(handlers) {
  return { chain: { name: "fixture-mainnet", pins: PINS }, assert: async () => 5042, pin: async () => ({ number: 1000, tag: "0x3e8" }),
    async call({ method, params }) {
      const key = method === "eth_getCode" ? `code@${String(params[0]).toLowerCase()}`
        : method === "eth_getStorageAt" ? `slot@${String(params[0]).toLowerCase()}@${String(params[1]).toLowerCase()}`
        : method === "eth_call" ? `call@${String(params[0]?.to).toLowerCase()}@${String(params[0]?.data)}` : method;
      const v = handlers[key];
      if (v === undefined) throw Object.assign(new Error(`mock: unhandled ${key}`), { transient: false, query: { endpoint: "mock://", method, params, reproduce: "# mock" } });
      if (typeof v === "function") return v();
      return { result: v, query: { endpoint: "mock://", method, params, reproduce: `# mock ${key}` }, evidence: { httpStatus: 200 } };
    } };
}
const run = (o) => analyze(VAULT, { client: client(world(o)) });
const P = (r, name) => r.powersV2?.powers?.find((p) => p.power === name);


// ── the exit layer on top of the fixture world ─────────────────────────────────────────────────────────────────
const XABI = parseAbi(["function totalSupply() view returns (uint256)", "function totalAssets() view returns (uint256)", "function decimals() view returns (uint8)",
  "function liquidityData() view returns (bytes)", "function isAdapter(address) view returns (bool)",
  "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)", "function position(bytes32,address) view returns (uint256,uint128,uint128)",
  "function probe(address vault, uint256 assets) returns (bool ok, bytes ret)", "function liquidityAdapter() view returns (address)",
  "function probeRedeem(address vault, uint256 shares) returns (bool ok, bytes ret)", "function previewRedeem(uint256) view returns (uint256)",
  "function sendSharesGate() view returns (address)", "function receiveAssetsGate() view returns (address)", "function balanceOf(address) view returns (uint256)"]);
const X = (fn, args = []) => encodeFunctionData({ abi: XABI, functionName: fn, args });
const R_ = (fn, v) => encodeFunctionResult({ abi: XABI, functionName: fn, result: v });
const PROBE = V2.PROBE_ADDRESS ?? "0x00000000000000000000000000000000000dd0d0";
const MP = { loanToken: ASSET, collateralToken: A(0x4001), oracle: A(0x4002), irm: IRM, lltv: 860000000000000000n };
const MARKET_ID = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
  [MP.loanToken, MP.collateralToken, MP.oracle, MP.irm, MP.lltv]));
const LDATA = encodeAbiParameters([{ type: "tuple", components: [{ type: "address", name: "loanToken" }, { type: "address", name: "collateralToken" }, { type: "address", name: "oracle" }, { type: "address", name: "irm" }, { type: "uint256", name: "lltv" }] }], [MP]);
const UNIT = 10n ** 6n; // decimals 6
const REVERT_DATA = "0xace2a47e"; // TransferReverted()
/** sims: Map amount → "ok" | "revert" | THROW */
function exitWorld({ idle = 100n, liq = false, free = 0n, pos = 900n, totalAssets = 10n ** 12n, ceiling, sims = {}, redeemAll, gate = false, extra = {} } = {}) {
  const o = {};
  const put = (to, data, v) => { o[`call@${to.toLowerCase()}@${data}`] = v; };
  put(ASSET, X("balanceOf", [VAULT]), W(idle));
  put(VAULT, X("totalSupply"), W(10n ** 18n)); put(VAULT, X("totalAssets"), W(totalAssets)); put(ASSET, X("decimals"), W(6));
  put(VAULT, X("previewRedeem", [10n ** 18n]), W(ceiling ?? totalAssets)); // what the whole supply redeems for
  if (redeemAll) put(PROBE, X("probeRedeem", [VAULT, 10n ** 18n]), typeof redeemAll === "function" ? redeemAll : R_("probeRedeem", redeemAll === "ok" ? [true, "0x"] : [false, "0x4e487b710000000000000000000000000000000000000000000000000000000000000011"]));
  if (liq) {
    put(VAULT, X("liquidityAdapter"), WA(AD)); put(VAULT, X("isAdapter", [AD]), W(1)); put(VAULT, X("liquidityData"), R_("liquidityData", LDATA));
    // supply = pos + free + 1000 (others' 1000), borrow = supply − free; position shares = pos (1:1 shares)
    put(BLUE, X("market", [MARKET_ID]), R_("market", [pos + free + 1000n, pos + free + 1000n, pos + 1000n, 0n, 0n, 0n]));
    put(BLUE, X("position", [MARKET_ID, AD]), R_("position", [pos, 0n, 0n]));
  }
  // The shared fixture sets a receive-assets gate (for step 3's value check); the exit cases default to NO gate.
  put(VAULT, X("receiveAssetsGate"), WA(ZERO));
  if (gate) put(VAULT, X("sendSharesGate"), WA(A(0x5005)));
  for (const [amt, outcome] of Object.entries(sims)) {
    put(PROBE, X("probe", [VAULT, BigInt(amt)]), typeof outcome === "function" ? outcome : R_("probe", outcome === "ok" ? [true, "0x"] : [false, REVERT_DATA]));
  }
  return { ...o, ...extra };
}
const runX = (o) => analyze(VAULT, { client: client(world({ overrides: exitWorld(o) })) });
const RN = (r) => r.exitPath?.redeemableNow;

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — idle only (no liquidity adapter): R = idle, PROVEN by the simulation");
{
  const r = await runX({ idle: 100n, sims: { 100: "ok", [String(100n + UNIT)]: "revert" } });
  ok("⭐ confirmed: value 100 (raw units), basis idle", RN(r)?.status === "confirmed" && RN(r)?.value === "100" && /idle/.test(RN(r)?.basis ?? ""), JSON.stringify(RN(r)));
  ok("…the proof names both simulations: withdraw(R) ok, withdraw(R + δ) reverted (with the revert data)",
    RN(r)?.proof?.atR?.ok === true && RN(r)?.proof?.aboveR?.ok === false && RN(r)?.proof?.aboveR?.revertData === REVERT_DATA, JSON.stringify(RN(r)?.proof));
  ok("…and states the share of totalAssets in bps", typeof RN(r)?.bps === "number");
  ok("⭐ a CONFIRMED exit fact lifts the no-verdict (refusal null)", r.refusal === null, r.refusal?.reason);
}

section("2 — ⭐⭐ idle 0, no route (Galaxy today): a PROVEN 0 vs an UNREADABLE simulation");
{
  const z = await runX({ idle: 0n, sims: { [String(UNIT)]: "revert" } });
  ok("⭐ proven: withdraw(δ) reverts → value \"0\", status confirmed (a REAL zero, with its proof)",
    RN(z)?.status === "confirmed" && RN(z)?.value === "0" && RN(z)?.proof?.aboveR?.ok === false, JSON.stringify(RN(z)));
  const u = await runX({ idle: 0n, sims: { [String(UNIT)]: THROW } });
  ok("⛔⛔ the SAME vault, simulation UNREADABLE → value null, status no-value — NEVER \"0\"",
    RN(u)?.value === null && RN(u)?.status === "no-value" && /simulat/i.test(RN(u)?.reason ?? ""), JSON.stringify(RN(u)));
  ok("…and the two are distinguishable by status AND value, not only by a note", RN(z)?.status !== RN(u)?.status && RN(z)?.value !== RN(u)?.value);
  ok("an unreadable exit fact keeps the report a NO-VERDICT (exit-fact-no-value)", u.refusal?.reason === "exit-fact-no-value", u.refusal?.reason);
}

section("3 — a simulation that CONTRADICTS the computation → no value + a finding (never pick one)");
{
  const a = await runX({ idle: 100n, sims: { 100: "revert", [String(100n + UNIT)]: "revert" } });
  ok("withdraw(R) reverts where the state says it should pay → no-value", RN(a)?.status === "no-value" && RN(a)?.value === null, JSON.stringify(RN(a)));
  ok("…with a finding naming the contradiction", (a.exitPath?.findings ?? []).some((f) => /contradict/i.test(f.text)), JSON.stringify(a.exitPath?.findings));
  const b = await runX({ idle: 100n, sims: { 100: "ok", [String(100n + UNIT)]: "ok" } });
  ok("withdraw(R + δ) SUCCEEDS (more than computed) → no-value too", RN(b)?.status === "no-value" && RN(b)?.value === null);
}

section("4 — the market route: idle + min(position, the market's free liquidity)");
{
  const f = await runX({ idle: 100n, liq: true, free: 50n, pos: 900n, sims: { 150: "ok", [String(150n + UNIT)]: "revert" } });
  ok("⭐ free liquidity binds: R = 100 idle + 50 free = 150, confirmed", RN(f)?.status === "confirmed" && RN(f)?.value === "150", JSON.stringify(RN(f)));
  ok("…basis names the liquidity adapter's market", /market/.test(RN(f)?.basis ?? ""));
  ok("…and says the pool is SHARED (first come, first served)", /shared/i.test(RN(f)?.note ?? ""), RN(f)?.note);
  const p = await runX({ idle: 100n, liq: true, free: 5000n, pos: 900n, sims: { 1000: "ok", [String(1000n + UNIT)]: "revert" } });
  ok("the vault's position binds: R = 100 + 900 = 1000, confirmed", RN(p)?.status === "confirmed" && RN(p)?.value === "1000", JSON.stringify(RN(p)));
}

section("5 — no value where the route or the holder is not understood");
{
  const g = await runX({ idle: 100n, gate: true, sims: { 100: "ok", [String(100n + UNIT)]: "revert" } });
  ok("an EXIT GATE set → no-value (exit depends on the holder, not on liquidity)", RN(g)?.status === "no-value" && /gate/i.test(RN(g)?.reason ?? ""), JSON.stringify(RN(g)));
  // ⭐ AT THE SUPPLY CEILING (measured on 0xD392…2eC5: withdraw(totalAssets) needs more shares than exist → Panic 0x11):
  const full = await runX({ idle: 100n, totalAssets: 100n, ceiling: 99n, redeemAll: "ok" });
  ok("⭐ liquidity ≥ what the whole supply redeems for → proven by redeem(totalSupply), value = that ceiling (99), not totalAssets",
    RN(full)?.status === "confirmed" && RN(full)?.value === "99" && RN(full)?.proof?.redeemAll?.ok === true && /every share/.test(RN(full)?.basis ?? ""), JSON.stringify(RN(full)));
  const fullBad = await runX({ idle: 100n, totalAssets: 100n, ceiling: 99n, redeemAll: "revert" });
  ok("…redeem(totalSupply) reverting there → no value + the contradiction finding", RN(fullBad)?.status === "no-value" && (fullBad.exitPath?.findings ?? []).some((f) => /contradict/.test(f.text)));
  const fullU = await runX({ idle: 100n, totalAssets: 100n, ceiling: 99n, redeemAll: THROW });
  ok("⛔ …and UNREADABLE there → no value, never a number", RN(fullU)?.status === "no-value" && RN(fullU)?.value === null);
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0\n`);
