// spike-B1-direct-calldata.mjs — READ-ONLY. Proves the CLEAN calldata path B1 (v3: viem-adapter getCallData).
//
// GROUNDED REWRITE (v3) — every input traced to the SDK, none hand-rolled:
//   Auth: the SDK sends `Bearer ${apiKey}` with the key AS-STORED (already begins "KIT_KEY:";
//     apiKeySchema /^KIT_KEY:…:…$/ — provider index.mjs:9749/10276/11943). Do NOT re-prepend it
//     (that was the v2 double-prefix → HTTP 401 "Invalid credentials"). Now fixed: verbatim key.
//   Extraction: the createSwap response carries NO ready adapter calldata — transaction.executionParams
//     .instructions[] are INNER DEX legs (e.g. 0xf992EFCB…), NOT the adapter. The submittable swap.execute
//     calldata (to == 0xbbd70b01…) is built by AdapterContract.execute(executeParams, tokenInputs, signature).
//   getCallData() is defined ONLY on the VIEM adapter (adapter-viem-v2:18586 — pure encodeFunctionData,
//     no chain write / no signing). The Circle-Wallets adapter has NO getCallData (grep-confirmed): its
//     prepared actions only .execute() (submit). So B1 = viem-adapter prepareAction('swap.execute').getCallData().
//   We do NOT drive kit.swap + intercept execute — that is the fragile B2 execute-neuter (what phase0e used
//     as a one-time proof). B1 never touches an execute pipeline; getCallData is structurally incapable of submitting.
//
// SDK-VERBATIM WIRING (swap-kit prepareEvmSwapAction:14128-14165 → adapter swap.execute handler
//   adapter-viem-v2:16523-16535 targets chain.kitContracts.adapter, fn 'execute', args executeParams/tokenInputs/signature):
//     executeParams = { instructions:[{target,data,value:BigInt,tokenIn,amountToApprove:BigInt,tokenOut,minTokenOut:BigInt}],
//                       tokens:[{token,beneficiary}], execId:BigInt, deadline:BigInt, metadata }
//     tokenInputs   = [ createFallbackTokenInput(tokenIn, amount) ]  // allowanceStrategy 'approve' → PermitType.NONE
//                     = [{ permitType:0, token:USDC, amount, permitCalldata:'0x' }]
//     context       = resolveOperationContext logic: { chain: resolveChainIdentifier('Arc_Testnet'), address: WALLET }
//   If getCallData yields to == 0xbbd70b01… → B1 proven → agentSwap uses it (HTTP quote → calldata →
//   createContractExecutionTransaction{contractAddress:to, callData:data} → authoritative Circle id). NEVER B2.
//
// SAFETY: HTTP quote (no chain write) + pure encodeFunctionData (getCallData) + eth_getCode only.
// NEVER kit.swap(), prepared.execute(), or createContractExecutionTransaction. Nothing signed, nothing submitted.
//
// PRECONDITION: a wallet with allowance ≥1 USDC to 0xbbd70b01… (phase0e-approved) so tokenInputs stays
//   allowance-based (PermitType.NONE) — isolates the extraction mechanism from the permit issue.
//
// RUN: read -rs KIT_KEY && export KIT_KEY   # paste at the prompt — never in argv or history
//        WALLET_ADDRESS=0x<approved> node --env-file=.env scripts/spikes/spike-B1-direct-calldata.mjs
//   NOTE: pass KIT_KEY VERBATIM (it already carries the "KIT_KEY:" prefix) — do NOT sed-strip it.

import { createPublicClient, http } from "viem";
import { createViemAdapterFromProvider, resolveChainIdentifier } from "@circle-fin/adapter-viem-v2";
import { CONTRACTS, ARC } from "../../netlify/functions/_arc.mjs";
import { rpcCall, assertChain } from "../../shared/dd/rpc.mjs";
import { getChain } from "../../shared/dd/chains.mjs";

import { requireKitKey } from "../_kit-key.mjs";
const KIT_KEY = requireKitKey();
const WALLET = (process.env.WALLET_ADDRESS || "").toLowerCase();
const ADAPTER = "0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b";
const SWAP_URL = "https://api.circle.com/v1/stablecoinKits/swap";
const AMOUNT_BASE = "1000000";
const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isData = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{8,}$/.test(v);
const log = (s = "") => console.log(s);
const ok = (s) => log(`  ✅ ${s}`);
const no = (s) => log(`  ⚠️  ${s}`);
const info = (s) => log(`  ·  ${s}`);
const keys = (o) => (o && typeof o === "object" ? Object.keys(o).join(", ") : String(o));
const shortHex = (v) => (typeof v === "string" && v.startsWith("0x") && v.length > 22 ? `${v.slice(0, 14)}…(${(v.length - 2) / 2}B)` : v);

if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET) { console.error("Need CIRCLE_API_KEY+CIRCLE_ENTITY_SECRET (.env). KIT_KEY is supplied per-run — see scripts/_kit-key.mjs (never from the production Netlify env)."); process.exit(2); }
if (!isAddr(WALLET)) { console.error("Set WALLET_ADDRESS=0x… — the phase0e-approved wallet (allowance ≥1 USDC to the adapter)."); process.exit(2); }
// SDK contract (provider apiKeySchema, index.mjs:9749): the key is sent verbatim as `Bearer ${apiKey}`
// and MUST already start with "KIT_KEY:". Catch a sed-stripped / mis-prefixed value here, not at a 401.
if (!/^KIT_KEY:[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$/.test(KIT_KEY)) { console.error(`KIT_KEY is not in the expected KIT_KEY:<id>:<secret> form (got prefix "${KIT_KEY.slice(0, 8)}…"). Pass it VERBATIM — do NOT strip the "KIT_KEY:" prefix; the SDK requires it.`); process.exit(2); }

log(`\n════ B1 v3 · HTTP createSwap → viem-adapter getCallData → { to, data } · READ-ONLY ════`);
log(`wallet ${WALLET.slice(0, 10)}… · USDC→EURC · adapter must == ${ADAPTER.slice(0, 12)}…\n`);

// ── Stage 1 — createSwap over HTTP (the exact call the SDK's internal createSwap makes; quote+signature, no chain write).
log("Stage 1  createSwap over HTTP (quote+signature — NO chain write, NO adapter)");
let resp = null;
try {
  const res = await fetch(SWAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KIT_KEY}` }, // key verbatim — matches SDK's `Bearer ${apiKey}`
    body: JSON.stringify({ tokenInAddress: CONTRACTS.USDC, tokenOutAddress: CONTRACTS.EURC, tokenInChain: "Arc_Testnet", fromAddress: WALLET, toAddress: WALLET, amount: AMOUNT_BASE }),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) { no(`HTTP ${res.status}: ${typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body).slice(0, 300)}`); }
  else { resp = body?.data ?? body; ok(`createSwap 200 — response keys: ${keys(resp)}`); }
} catch (e) { no(`createSwap fetch failed: ${e.message.split("\n")[0]}`); }

if (!resp?.transaction) { log(`\n⚠️  no transaction in response — cannot proceed (see Stage 1). No money moved.\n`); process.exit(1); }

// ── Stage 2 — GROUNDING DUMP: the exact shape prepareEvmSwapAction reads (executionParams / instructions / tokens / signature).
log("\nStage 2  DUMP transaction structure (what the SDK transform consumes)");
const T = resp.transaction;
const EP = T.executionParams;
info(`transaction keys: ${keys(T)}`);
info(`signature: ${T.signature ? `present (${(T.signature.length - 2) / 2}B)` : "MISSING"}   gasLimit: ${T.gasLimit ?? "—"}`);
if (!EP) no("transaction.executionParams MISSING — SDK transform cannot run");
else {
  info(`executionParams keys: ${keys(EP)}`);
  info(`  execId=${EP.execId}  deadline=${EP.deadline}  metadata=${shortHex(EP.metadata)}`);
  info(`  tokens (${EP.tokens?.length ?? 0}): ${JSON.stringify(EP.tokens)?.slice(0, 160)}`);
  info(`  instructions (${EP.instructions?.length ?? 0}):`);
  (EP.instructions ?? []).forEach((i, n) => info(`    [${n}] target=${i.target} tokenIn=${i.tokenIn} tokenOut=${i.tokenOut} value=${i.value} amountToApprove=${i.amountToApprove} minTokenOut=${i.minTokenOut} data=${shortHex(i.data)}`));
}

// ── Stage 3 — Path A: is there ready calldata TO THE ADAPTER in the response? (reject inner-leg false positives.)
log("\nStage 3  Path A — ready { to, data } that targets the ADAPTER (inner-leg matches rejected)");
function findAdapterCallData(o, path = "$", depth = 0, seen = new WeakSet()) {
  if (o == null || depth > 6 || typeof o !== "object" || seen.has(o)) return null;
  seen.add(o);
  const to = o.to ?? o.target;
  if (isAddr(to) && to.toLowerCase() === ADAPTER && isData(o.data)) return { to, data: o.data, path }; // adapter is the GATE, not the first match
  for (const [k, v] of Object.entries(o)) { const r = findAdapterCallData(v, `${path}.${k}`, depth + 1, seen); if (r) return r; }
  return null;
}
let cd = findAdapterCallData(resp);
if (cd) ok(`ready adapter calldata at ${cd.path} → to=${cd.to} data=${shortHex(cd.data)} — Path A (no adapter build needed)`);
else info("no ready adapter-targeted calldata in the response (expected — instructions are inner legs) → Path B");

// ── Stage 4 — Path B: viem adapter builds AdapterContract.execute(...) calldata via getCallData() (pure encoding).
if (!cd && EP) {
  log("\nStage 4  Path B — viem adapter prepareAction('swap.execute').getCallData()  (pure encodeFunctionData; never execute)");
  try {
    const chain = getChain("arc-testnet");
    const publicClient = createPublicClient({ chain: { id: ARC.chainId, name: "arc-testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [ARC.rpc] } } }, transport: http(ARC.rpc) });
    // Read-only viem adapter: developer-controlled + explicit address. getWalletClient (signing) is lazy and
    // NEVER invoked by getCallData — the stub provider only exists to satisfy construction.
    const adapter = await createViemAdapterFromProvider({
      provider: { request: async () => { throw new Error("read-only spike: provider must never be called (getCallData does not sign)"); } },
      getPublicClient: () => publicClient,
      capabilities: { addressContext: "developer-controlled" },
    });

    // SDK-verbatim transform (prepareEvmSwapAction:14128-14165). BigInt = the SDK's safeBigInt.
    const executeParams = {
      instructions: EP.instructions.map((i) => ({ target: i.target, data: i.data, value: BigInt(i.value), tokenIn: i.tokenIn, amountToApprove: BigInt(i.amountToApprove), tokenOut: i.tokenOut, minTokenOut: BigInt(i.minTokenOut) })),
      tokens: EP.tokens.map((t) => ({ token: t.token, beneficiary: t.beneficiary })),
      execId: BigInt(EP.execId), deadline: BigInt(EP.deadline), metadata: EP.metadata,
    };
    const inputAmount = BigInt(resp.amount ?? AMOUNT_BASE);
    const tokenInAddress = resp.tokenInAddress ?? CONTRACTS.USDC;
    const tokenInputs = [{ permitType: 0, token: tokenInAddress, amount: inputAmount, permitCalldata: "0x" }]; // createFallbackTokenInput (PermitType.NONE)
    const context = { chain: resolveChainIdentifier("Arc_Testnet"), address: WALLET };

    const prepared = await adapter.prepareAction("swap.execute", { executeParams, tokenInputs, signature: T.signature, inputAmount, tokenInAddress }, context);
    if (typeof prepared?.getCallData !== "function") no(`prepared[${prepared?.type ?? "?"}] has NO getCallData() — cannot extract read-only`);
    else {
      const c = prepared.getCallData();
      if (c && isAddr(c.to) && isData(c.data)) { cd = { to: c.to, data: c.data, path: "prepareAction('swap.execute').getCallData()" }; ok(`getCallData() → to=${c.to} data=${shortHex(c.data)}`); }
      else no(`getCallData() returned no usable { to, data }: ${JSON.stringify(c)}`);
    }
  } catch (e) { no(`Path B build failed: ${e.message.split("\n")[0]}`); }
}

// ── Stage 5 — adapter invariant + on-chain code check.
if (cd) {
  const match = cd.to.toLowerCase() === ADAPTER;
  (match ? ok : no)(`\nadapter-address invariant: calldata.to ${match ? "==" : "!="} ${ADAPTER}${match ? "" : "  ← MISMATCH (agentSwap would abort)"}`);
  try { const chain = getChain("arc-testnet"); await assertChain(chain); const { result } = await rpcCall({ endpoint: chain.rpc, method: "eth_getCode", params: [cd.to, "latest"] }); ok(`target ${cd.to} has ${(result.length - 2) / 2} bytes on Arc`); } catch (e) { info(`on-chain check unavailable: ${e.message}`); }
}

// ── VERDICT ──────────────────────────────────────────────────────────────────────────────────
log(`\n════════════════════════════ VERDICT ════════════════════════════`);
if (cd && cd.to.toLowerCase() === ADAPTER) {
  log(`✅ B1 WORKS — swap.execute { to, data } obtained via ${cd.path.startsWith("$") ? "ready calldata (Path A)" : "viem-adapter getCallData (Path B)"}.`);
  log(`   Pure encodeFunctionData — NO kit.swap, NO execute pipeline, NO B2 neuter. Nothing signed/submitted.`);
  log(`   → agentSwap: HTTP createSwap → this { to, data } → createContractExecutionTransaction{contractAddress:to, callData:data} → Circle id → waitForTx.`);
} else if (resp?.transaction) {
  log(`⚠️  createSwap 200 (quote+signature returned) but no adapter-targeted { to, data } yet.`);
  log(`   Read Stage 2 (real shape) + Stage 4 (Path B build). If getCallData is absent or the transform`);
  log(`   field-names differ from the dump, that's the point to resolve before agentSwap. Do NOT fall back to B2.`);
}
log(`\nNo money moved. HTTP quote / getCallData (pure encoding) / eth_getCode only.\n`);
