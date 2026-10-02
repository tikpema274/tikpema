// verify-morpho-v2-powers.mjs — DD Morpho V2, STEP 3: the V2 POWER MODEL (timelock · abdicated · current value).
//
//   npm run test:morphov2powers          (offline: a mock chain keyed by target + calldata)
//
// The decided design (PROGRESS "STEP 3 DESIGN", T 2026-10-02):
//   · On V2 every vault has every power, so PRESENCE says nothing. Each power reports who can call it, its DELAY
//     (a timelock read from `timelock(selector)`, or "not timelockable" by design), whether it is ABDICATED, and the
//     current value where one exists. Grouped: immediate / delayed / abdicated / unreadable.
//   · A timelock is a TRUE lower bound: decreaseTimelock on X waits X's current timelock (VaultV2.sol:355).
//   · Allocators, sentinels and pending submissions are MAPPINGS: NOT enumerated in this window (decision (b)): each is a
//     stated notChecked entry, never an empty list read as "none".
//   · `exitPowers` names the five powers over an exit (decision): setSendSharesGate, setReceiveAssetsGate,
//     setIsAllocator, setLiquidityAdapterAndData, setForceDeallocatePenalty.
//   · Completeness is over THIS profile's catalogue; an unreadable timelock never lands in immediate or delayed.
//
// ⭐ The SOURCE LIST below is VaultV2's 42 non-view external functions at vault-v2 tag 2026-08-13 (the tag that reproduces
// every deployed vault-v2 contract on Arc; forge build, ABI read 2026-10-02). Literal BY DESIGN: the catalogue is checked
// against it, so a power the catalogue forgets is a red here, not a silent gap.

import { encodeFunctionData, parseAbi, keccak256, toFunctionSelector } from "viem";
import { analyze } from "../../shared/onchain-analyze/index.mjs";
import { POWER_SIGS, sel, EIP1967_IMPL_SLOT } from "../../shared/onchain-facts/index.mjs";
import { ERC4626_METHODS } from "../../shared/onchain-facts/vault-profiles.mjs";
const V2 = await import("../../shared/onchain-analyze/morpho-v2.mjs").catch((e) => ({ __loadError: e }));

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 70 - t.length))}`);

const SOURCE_NON_VIEW = ["abdicate(bytes4)", "accrueInterest()", "addAdapter(address)", "allocate(address,bytes,uint256)", "approve(address,uint256)",
  "deallocate(address,bytes,uint256)", "decreaseAbsoluteCap(bytes,uint256)", "decreaseRelativeCap(bytes,uint256)", "decreaseTimelock(bytes4,uint256)",
  "deposit(uint256,address)", "forceDeallocate(address,bytes,uint256,address)", "increaseAbsoluteCap(bytes,uint256)", "increaseRelativeCap(bytes,uint256)",
  "increaseTimelock(bytes4,uint256)", "mint(uint256,address)", "multicall(bytes[])", "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
  "redeem(uint256,address,address)", "removeAdapter(address)", "revoke(bytes)", "setAdapterRegistry(address)", "setCurator(address)",
  "setForceDeallocatePenalty(address,uint256)", "setIsAllocator(address,bool)", "setIsSentinel(address,bool)", "setLiquidityAdapterAndData(address,bytes)",
  "setManagementFee(uint256)", "setManagementFeeRecipient(address)", "setMaxRate(uint256)", "setName(string)", "setOwner(address)", "setPerformanceFee(uint256)",
  "setPerformanceFeeRecipient(address)", "setReceiveAssetsGate(address)", "setReceiveSharesGate(address)", "setSendAssetsGate(address)", "setSendSharesGate(address)",
  "setSymbol(string)", "submit(bytes)", "transfer(address,uint256)", "transferFrom(address,address,uint256)", "withdraw(uint256,address,address)"];
const NOT_POWERS = ["accrueInterest()", "approve(address,uint256)", "deposit(uint256,address)", "forceDeallocate(address,bytes,uint256,address)", "mint(uint256,address)",
  "multicall(bytes[])", "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)", "redeem(uint256,address,address)", "submit(bytes)",
  "transfer(address,uint256)", "transferFrom(address,address,uint256)", "withdraw(uint256,address,address)"];
const TIMELOCKED = ["setIsAllocator(address,bool)", "setReceiveSharesGate(address)", "setSendSharesGate(address)", "setReceiveAssetsGate(address)", "setSendAssetsGate(address)",
  "setAdapterRegistry(address)", "addAdapter(address)", "removeAdapter(address)", "increaseTimelock(bytes4,uint256)", "decreaseTimelock(bytes4,uint256)", "abdicate(bytes4)",
  "setPerformanceFee(uint256)", "setManagementFee(uint256)", "setPerformanceFeeRecipient(address)", "setManagementFeeRecipient(address)",
  "increaseAbsoluteCap(bytes,uint256)", "increaseRelativeCap(bytes,uint256)", "setForceDeallocatePenalty(address,uint256)"];
const EXIT_POWERS = ["setSendSharesGate", "setReceiveAssetsGate", "setIsAllocator", "setLiquidityAdapterAndData", "setForceDeallocatePenalty"];

ok("the V2 module loads", !V2.__loadError, String(V2.__loadError?.message ?? "").slice(0, 120));

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
      // step 5: the pinned block's header (analyze binds the report to it); a test may still override it.
      const v = handlers[key] ?? (key === "eth_getBlockByNumber" ? { number: params[0], hash: "0x" + "ab".repeat(32), timestamp: "0x6abfdbf0" } : undefined);
      if (v === undefined) throw Object.assign(new Error(`mock: unhandled ${key}`), { transient: false, query: { endpoint: "mock://", method, params, reproduce: "# mock" } });
      if (typeof v === "function") return v();
      return { result: v, query: { endpoint: "mock://", method, params, reproduce: `# mock ${key}` }, evidence: { httpStatus: 200 } };
    } };
}
const run = (o) => analyze(VAULT, { client: client(world(o)) });
const P = (r, name) => r.powersV2?.powers?.find((p) => p.power === name);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⭐⭐ the catalogue IS VaultV2's control surface: 30 powers + 12 non-powers = the 42 non-view functions");
{
  const cat = V2.V2_POWER_CATALOGUE ?? [];
  const sigs = cat.map((p) => p.signature);
  ok("30 powers", cat.length === 30, String(cat.length));
  ok("⭐ powers ∪ non-powers = the source list exactly (nothing forgotten, nothing invented)",
    [...sigs, ...NOT_POWERS].sort().join("|") === [...SOURCE_NON_VIEW].sort().join("|"),
    SOURCE_NON_VIEW.filter((s) => !sigs.includes(s) && !NOT_POWERS.includes(s)).join(",") || sigs.filter((s) => !SOURCE_NON_VIEW.includes(s)).join(","));
  ok("the 18 timelocked powers are exactly the source's timelocked() callers", cat.filter((p) => p.delay === "timelocked").map((p) => p.signature).sort().join("|") === [...TIMELOCKED].sort().join("|"));
  ok("owner powers (setOwner, setCurator, setIsSentinel, setName, setSymbol) are not timelockable",
    ["setOwner", "setCurator", "setIsSentinel", "setName", "setSymbol"].every((n) => cat.find((p) => p.power === n)?.caller === "owner" && cat.find((p) => p.power === n)?.delay === "not-timelockable"));
  ok("⭐ allocator powers (allocate, deallocate, setLiquidityAdapterAndData, setMaxRate) are not timelockable",
    ["allocate", "deallocate", "setLiquidityAdapterAndData", "setMaxRate"].every((n) => cat.find((p) => p.power === n)?.delay === "not-timelockable" && /allocator/.test(cat.find((p) => p.power === n)?.caller ?? "")));
  ok("every power has a scope class and a reach", cat.every((p) => typeof p.scope === "string" && typeof p.reach === "string" && p.reach.length > 10));
  ok("⭐ exitPowers is exactly T's five", JSON.stringify([...(V2.V2_EXIT_POWERS ?? [])].sort()) === JSON.stringify([...EXIT_POWERS].sort()), JSON.stringify(V2.V2_EXIT_POWERS));
}

section("2 — ⭐ delay + abdication → the group (immediate / delayed / abdicated / unreadable)");
{
  const r = await run({ timelocks: { "addAdapter(address)": 7 * DAY, "increaseAbsoluteCap(bytes,uint256)": 7 * DAY }, abdicated: ["setSendSharesGate(address)", "setReceiveAssetsGate(address)"] });
  const g = r.powersV2?.groups ?? {};
  ok("powersV2 is present on a recognised V2 vault", !!r.powersV2);
  ok("⭐ timelock 0 (setPerformanceFee) → IMMEDIATE, delay {timelocked, 0}", g.immediate?.includes("setPerformanceFee") && P(r, "setPerformanceFee")?.delay?.kind === "timelocked" && P(r, "setPerformanceFee")?.delay?.seconds === "0", JSON.stringify(P(r, "setPerformanceFee")?.delay));
  ok("⭐ 7 days (addAdapter) → DELAYED, 604800 s", (g.delayed ?? []).some((x) => x.power === "addAdapter" && x.seconds === "604800"), JSON.stringify(g.delayed?.find((x) => x.power === "addAdapter")));
  ok("⭐ abdicated (setSendSharesGate) → ABDICATED, whatever its timelock", g.abdicated?.includes("setSendSharesGate") && !g.immediate?.includes("setSendSharesGate") && P(r, "setSendSharesGate")?.abdicated === true);
  ok("owner / allocator powers → immediate, abdication NOT APPLICABLE (they never pass timelocked())",
    g.immediate?.includes("setOwner") && g.immediate?.includes("setLiquidityAdapterAndData") && P(r, "setLiquidityAdapterAndData")?.abdicated === "not-applicable" && P(r, "setLiquidityAdapterAndData")?.delay?.kind === "not-timelockable");
  ok("decreaseTimelock's delay is stated as the TARGET's timelock (VaultV2.sol:355)", /target/i.test(P(r, "decreaseTimelock")?.delay?.note ?? ""), P(r, "decreaseTimelock")?.delay?.note);
  ok("every catalogue power is in exactly one group", (() => { const all = [...(g.immediate ?? []), ...(g.delayed ?? []).map((x) => x.power), ...(g.abdicated ?? []), ...(g.unreadable ?? [])];
    return all.length === 30 && new Set(all).size === 30; })());

  const u = await run({ overrides: { [`call@${VAULT.toLowerCase()}@${d("timelock", [S4("setIsAllocator(address,bool)")])}`]: THROW } });
  ok("⭐⭐ an UNREADABLE timelock → group unreadable, never immediate or delayed (no guess)",
    u.powersV2?.groups?.unreadable?.includes("setIsAllocator") && !u.powersV2.groups.immediate.includes("setIsAllocator") && P(u, "setIsAllocator")?.delay?.seconds === null, JSON.stringify(P(u, "setIsAllocator")?.delay));
  const ua = await run({ overrides: { [`call@${VAULT.toLowerCase()}@${d("abdicated", [S4("setSendSharesGate(address)")])}`]: THROW } });
  ok("an UNREADABLE abdication → unreadable too (an unread 'false' is not 'not abdicated')", ua.powersV2?.groups?.unreadable?.includes("setSendSharesGate") && P(ua, "setSendSharesGate")?.abdicated === null);
}

section("3 — holders and current values; the mappings are a STATED gap (decision (b))");
{
  const r = await run();
  ok("setOwner's holder is the owner address", P(r, "setOwner")?.holders?.kind === "address" && P(r, "setOwner").holders.value.toLowerCase() === OWNER.toLowerCase());
  ok("a curator power's holder is the curator address", P(r, "setPerformanceFee")?.holders?.value?.toLowerCase() === CURATOR.toLowerCase());
  ok("⭐ allocator powers: holders NOT ENUMERATED, with the reason (never an empty list)",
    P(r, "setLiquidityAdapterAndData")?.holders?.kind === "not-enumerated" && /mapping/.test(P(r, "setLiquidityAdapterAndData")?.holders?.why ?? ""));
  const nc = r.coverage.notChecked.map((x) => x.id);
  ok("⭐ coverage names the three gaps: allocators, sentinels, pending submissions",
    ["v2:enumerate:allocators", "v2:enumerate:sentinels", "v2:enumerate:pending"].every((id) => nc.includes(id)), nc.filter((x) => x.startsWith("v2:enumerate")).join(","));
  ok("current values: performance fee, fee recipient, the exit gate, owner, curator",
    P(r, "setPerformanceFee")?.currentValue === (10n ** 17n).toString() && P(r, "setPerformanceFeeRecipient")?.currentValue?.toLowerCase() === FEE_REC.toLowerCase()
    && P(r, "setReceiveAssetsGate")?.currentValue?.toLowerCase() === GATE.toLowerCase() && P(r, "setCurator")?.currentValue?.toLowerCase() === CURATOR.toLowerCase());
  ok("setForceDeallocatePenalty's value is per adapter", JSON.stringify(P(r, "setForceDeallocatePenalty")?.currentValue ?? null).includes((10n ** 16n).toString()));
}

section("4 — exitPowers in the report; the old presence vocabulary is not applied");
{
  const r = await run({ abdicated: ["setSendSharesGate(address)", "setReceiveAssetsGate(address)"] });
  const ex = r.powersV2?.exitPowers ?? [];
  ok("⭐ report.powersV2.exitPowers carries T's five, each with delay + abdicated", ex.length === 5 && EXIT_POWERS.every((n) => ex.some((x) => x.power === n && x.delay && "abdicated" in x)), JSON.stringify(ex.map((x) => x.power)));
  ok("…the exit gates read abdicated, setLiquidityAdapterAndData reads not-timelockable", ex.find((x) => x.power === "setSendSharesGate")?.abdicated === true && ex.find((x) => x.power === "setLiquidityAdapterAndData")?.delay?.kind === "not-timelockable");
  const pnc = r.coverage.notChecked.filter((n) => n.kind === "power");
  ok("the presence groups are notChecked as NOT THIS PROFILE'S VOCABULARY (see powersV2)", pnc.length === Object.keys(POWER_SIGS).length && pnc.every((x) => /powersV2/.test(x.why ?? "")));
  // Since step 4 the no-verdict rests on the exit fact alone; this fixture does not answer the redeem simulation.
  ok("⭐ no longer 'power model not built': the no-verdict now rests on the exit fact (exit-fact-no-value here)", r.refusal?.reason === "exit-fact-no-value", r.refusal?.reason);
}

section("5 — ⭐ completeness over THIS profile's catalogue");
{
  ok("assertV2PowersComplete exists", typeof V2.assertV2PowersComplete === "function");
  if (typeof V2.assertV2PowersComplete === "function") {
    const r = await run();
    ok("a full powersV2 passes", V2.assertV2PowersComplete(r.powersV2).ok === true, JSON.stringify(V2.assertV2PowersComplete(r.powersV2).problems));
    const cut = { ...r.powersV2, powers: r.powersV2.powers.filter((p) => p.power !== "setIsAllocator") };
    ok("⭐ one power missing → NOT ok, naming it", V2.assertV2PowersComplete(cut).ok === false && /setIsAllocator/.test(JSON.stringify(V2.assertV2PowersComplete(cut).problems)));
  }
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0\n`);
