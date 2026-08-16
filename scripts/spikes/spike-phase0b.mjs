// spike-phase0b.mjs — Phase 0 FOLLOW-UP. READ-ONLY. NO MONEY. Never executes.
//
// Phase 0 landed MIDDLE-WITH-A-SURFACE: estimate exposes no calldata, but the adapter has
// prepare/prepareAction. The type surface then told us the exact path:
//   1. createSwap({ tokenInAddress, tokenOutAddress, tokenInChain, fromAddress, toAddress,
//                   amount, apiKey:'KIT_KEY:…' })  → a service QUOTE that returns
//        transaction.executeParams + transaction.signature (EIP-712, signed by Circle's proxy
//        service) + amount + tokenInAddress. NO on-chain write — a signed authorization only.
//   2. adapter.prepareAction('swap.execute', { executeParams, tokenInputs, signature,
//        inputAmount, tokenInAddress }, ctx)  → PreparedChainRequest for AdapterContract.execute(…)
//   3. prepared.getCallData?.()  → { to, data }  ← the submittable calldata we're after.
//
// THE KNOWN RISK (why this is a probe, not a foregone conclusion): swap.execute's `tokenInputs`
// wants EIP-2612 PERMIT signatures ("adapter.signTypedData()"). An SCA can't produce a permit
// (ecrecover rejects ERC-1271) — the exact wall that made _swap.mjs force allowanceStrategy:
// "approve". So step 2 may snag on tokenInputs for THIS adapter. If it does, that snag IS the
// finding, not a bug in the probe.
//
// SAFETY: calls only resolveSwapParams / createSwap(service quote) / prepareAction / getCallData /
// eth_getCode. It NEVER calls prepared.execute(), kit.swap(), or createContractExecutionTransaction.
// We deliberately reject the tempting "kit.swap() with execute monkey-patched to throw": a silently
// failed patch would submit a real swap. Pure reconstruction's worst case is "couldn't reach it".
//
// RUN:
//   read -rs KIT_KEY && export KIT_KEY   # paste at the prompt — never in argv or history
//     WALLET_ADDRESS=0x… node --env-file=.env scripts/spikes/spike-phase0b.mjs
//   (WALLET_ADDRESS optional — defaults to a throwaway; the quote doesn't care whose address.)

import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";
import { CONTRACTS } from "../../netlify/functions/_arc.mjs";
import { rpcCall, assertChain } from "../../shared/dd/rpc.mjs";
import { getChain } from "../../shared/dd/chains.mjs";

import { requireKitKey } from "../_kit-key.mjs";
const KIT_KEY = requireKitKey();
const FROM = (process.env.WALLET_ADDRESS || "0x000000000000000000000000000000000000dEaD").toLowerCase();
const AMOUNT_BASE = "1000000"; // 1 USDC (6 dp) — quoted only, never spent
const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isCallData = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{8,}$/.test(v);
const log = (s = "") => console.log(s);
const ok = (s) => log(`  ✅ ${s}`);
const no = (s) => log(`  ⚠️  ${s}`);
const info = (s) => log(`  ·  ${s}`);
const keys = (o) => (o && typeof o === "object" ? Object.keys(o).join(", ") : String(o));

if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET || !KIT_KEY) {
  console.error("Need CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET (.env) and KIT_KEY (Netlify prod env). See header.");
  process.exit(2);
}

log(`\n════ PHASE 0b · swap-calldata reconstruction · READ-ONLY, nothing executes ════`);
log(`USDC ${CONTRACTS.USDC.slice(0, 10)}… → EURC ${CONTRACTS.EURC.slice(0, 10)}… · from ${FROM.slice(0, 10)}…\n`);

const adapter = createCircleWalletsAdapter({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
});

// Stage 1 — resolve the Arc ChainDefinition + canonical token addresses (for ctx + the quote).
log("Stage 1  resolve Arc chain + tokens (swap-kit)");
let chainDef = null;
try {
  const sk = await import("@circle-fin/swap-kit");
  info(`swap-kit exports getSupportedChains=${typeof sk.getSupportedChains} getChainByEnum=${typeof sk.getChainByEnum} SwapChain.Arc*=${sk.SwapChain?.Arc_Testnet ?? sk.SwapChain?.ArcTestnet ?? "?"}`);
  const chains = sk.getSupportedChains?.() || [];
  chainDef = chains.find?.((c) => /arc/i.test(JSON.stringify(c))) || null;
  if (!chainDef && sk.getChainByEnum) {
    for (const g of [sk.SwapChain?.Arc_Testnet, "Arc_Testnet", "ARC_TESTNET"]) {
      try { chainDef = sk.getChainByEnum(g); if (chainDef) break; } catch { /* try next */ }
    }
  }
  chainDef ? ok(`Arc ChainDefinition resolved (${keys(chainDef)})`) : no("could not resolve an Arc ChainDefinition — ctx below is best-effort");
} catch (e) {
  no(`swap-kit import failed: ${e.message}`);
}

// Stage 2 — reach createSwap (the service quote+sign). Self-discovering: try the named export,
// then the provider class's own methods. This is a QUOTE — no chain write.
log("\nStage 2  createSwap service quote (signed authorization — NO on-chain write)");
async function reachCreateSwap() {
  // (a) named export on the provider package or app-kit
  for (const spec of ["@circle-fin/provider-stablecoin-service-swap", "@circle-fin/swap-kit", "@circle-fin/app-kit"]) {
    try {
      const m = await import(spec);
      if (typeof m.createSwap === "function") return { call: m.createSwap, how: `${spec}::createSwap` };
      // (b) provider class with a create/swap/quote method
      if (typeof m.StablecoinServiceSwapProvider === "function") {
        const inst = new m.StablecoinServiceSwapProvider({ apiKey: `KIT_KEY:${KIT_KEY}` });
        const meth = ["createSwap", "create", "swap", "getSwap"].find((n) => typeof inst[n] === "function");
        if (meth) return { call: inst[meth].bind(inst), how: `${spec}::StablecoinServiceSwapProvider.${meth}` };
        info(`${spec}: provider methods = ${Object.getOwnPropertyNames(Object.getPrototypeOf(inst)).filter((n) => typeof inst[n] === "function").join(", ")}`);
      }
    } catch (e) { info(`${spec}: ${e.message.split("\n")[0]}`); }
  }
  return null;
}
let resp = null;
const cs = await reachCreateSwap();
if (!cs) {
  no("createSwap is not reachable from any installed package — see method dumps above.");
} else {
  info(`reached via ${cs.how}`);
  try {
    resp = await cs.call({
      tokenInAddress: CONTRACTS.USDC,
      tokenOutAddress: CONTRACTS.EURC,
      tokenInChain: "Arc_Testnet",
      fromAddress: FROM,
      toAddress: FROM,
      amount: AMOUNT_BASE,
      apiKey: `KIT_KEY:${KIT_KEY}`,
    });
    ok(`createSwap returned (${keys(resp)})`);
    info(`transaction: ${keys(resp?.transaction)}`);
    if (resp?.transaction?.executeParams) info(`executeParams present (${keys(resp.transaction.executeParams)}) — has deadline? ${"deadline" in (resp.transaction.executeParams || {})}`);
    if (resp?.transaction?.signature) info(`service signature present: ${String(resp.transaction.signature).slice(0, 14)}…`);
  } catch (e) {
    no(`createSwap threw: ${e.message.split("\n")[0]}`);
  }
}

// Stage 3 — prepareAction('swap.execute') → getCallData(). Try tokenInputs variants (SCA can't
// permit, so try empty/allowance-based first). NEVER call .execute().
log("\nStage 3  prepareAction('swap.execute') → getCallData()   (never .execute())");
let callData = null;
if (resp?.transaction) {
  const ctx = { chain: chainDef ?? "Arc_Testnet", address: FROM };
  const base = {
    executeParams: resp.transaction.executeParams,
    signature: resp.transaction.signature,
    inputAmount: (() => { try { return BigInt(resp.amount ?? AMOUNT_BASE); } catch { return AMOUNT_BASE; } })(),
    tokenInAddress: resp.tokenInAddress ?? CONTRACTS.USDC,
  };
  const tokenInputVariants = [
    ["from service response", resp.tokenInputs],
    ["empty (allowance-based, SCA approve-strategy)", []],
    ["single no-permit", [{ token: CONTRACTS.USDC, amount: base.inputAmount, permitCalldata: "0x" }]],
  ].filter(([, v]) => v !== undefined);
  for (const [label, tokenInputs] of tokenInputVariants) {
    try {
      const prepared = await adapter.prepareAction("swap.execute", { ...base, tokenInputs }, ctx);
      if (typeof prepared?.getCallData === "function") {
        const cd = prepared.getCallData();
        if (cd && isAddr(cd.to) && isCallData(cd.data)) { callData = cd; ok(`tokenInputs=${label} → to=${cd.to} data=${cd.data.slice(0, 14)}… (${(cd.data.length - 2) / 2} bytes)`); break; }
        no(`tokenInputs=${label}: getCallData() gave no usable { to, data }: ${JSON.stringify(cd)}`);
      } else {
        no(`tokenInputs=${label}: prepared, but getCallData() is NOT implemented on this adapter's prepared request`);
        break; // if the adapter simply lacks getCallData, other tokenInputs won't add it
      }
    } catch (e) {
      info(`tokenInputs=${label}: ${e.message.split("\n")[0]}`);
    }
  }
} else {
  info("no service response to prepare from — Stage 2 must succeed first.");
}

// Stage 4 — cross-check the extracted target on-chain via the independent dd/rpc stack.
if (callData) {
  log("\nStage 4  cross-check target on-chain (independent dd/rpc.mjs, chain-id asserted)");
  try {
    const chain = getChain("arc-testnet");
    await assertChain(chain);
    const { result } = await rpcCall({ endpoint: chain.rpc, method: "eth_getCode", params: [callData.to, "latest"] });
    const bytes = (result.length - 2) / 2;
    (bytes > 0 ? ok : no)(`target ${callData.to} — ${bytes} bytes of code on Arc${bytes ? " (the AdapterContract)" : " (EMPTY — calldata targets nothing!)"}`);
  } catch (e) { no(`on-chain cross-check unavailable: ${e.message}`); }
}

// ── VERDICT ──────────────────────────────────────────────────────────────────────────────────
log(`\n════════════════════════════ VERDICT ════════════════════════════`);
if (callData) {
  log(`✅ TOP ROW (via deeper import) — swap calldata { to, data } IS extractable read-only.`);
  log(`   Path: createSwap() → prepareAction('swap.execute') → getCallData().`);
  log(`   → Submit that { to, data } via createContractExecutionTransaction → authoritative Circle`);
  log(`     tx id → waitForTx, exactly like _bridge.mjs. Log-scan / sibling-ambiguity / robust-id`);
  log(`     debt all deletable by refactor. No custody migration needed.`);
  log(`   RESIDUAL RISKS to clear in the money-phase (do NOT skip — they're why this isn't free):`);
  log(`     • executeParams carries a DEADLINE — the createSwap→submit split has a validity window;`);
  log(`       confirm the Circle tx lands inside it (Arc confirms in ~2–3s, quotes usually last longer).`);
  log(`     • The input-token approve leg is SEPARATE (SCA can't permit) — do approve(AdapterContract,`);
  log(`       amount) via contractExecution first, like bridge's approve+bridge pair.`);
} else if (resp?.transaction) {
  log(`⚠️  MIDDLE — the service quote is reachable, but prepareAction('swap.execute')/getCallData()`);
  log(`   did NOT yield submittable { to, data } for the Circle Wallets (SCA) adapter.`);
  log(`   Read the Stage 3 lines: if it snagged on tokenInputs/permit, that is the SCA-permit wall`);
  log(`   reappearing at the adapter-contract layer — the same reason _swap.mjs forces "approve".`);
  log(`   → Keep the hand-built confirm path. The money-path migration does not remove the log-scan.`);
} else {
  log(`⚠️  MIDDLE (unreached) — createSwap could not be driven from outside the SDK (Stage 2).`);
  log(`   The calldata may still be reachable to a real refactor that imports deeper than a probe`);
  log(`   should, but it is NOT externally drivable as tested → treat as MIDDLE until proven otherwise.`);
}
log(`\nNo money moved. quote/prepare/getCallData/eth_getCode only — nothing signed on-chain, nothing submitted.\n`);
