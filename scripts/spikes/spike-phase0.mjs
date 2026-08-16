// spike-phase0.mjs — Phase 0 of the Agent-Stack money-path spike. READ-ONLY. NO MONEY.
//
// THE ONE QUESTION THIS ANSWERS (and it is two questions that turned out to be one):
//   • Migration money-path: can SWAP get an AUTHORITATIVE Circle transaction id on Arc, so it
//     rides the same `createContractExecutionTransaction → waitForTx` rail bridge/deposit already
//     use — instead of `kit.swap()`'s async 1098 event-scrape?
//   • The banked robust-path brief's open "submit half": can we get the swap ROUTER CALLDATA
//     ({ to, data }) to hand to a direct contractExecution?
//   Both reduce to: does App Kit expose the prepared swap calldata to THIS (Circle Wallets) adapter?
//
// It decides that WITHOUT moving a cent:
//   estimateSwap returns PRICING (estimatedOutput), not calldata. The submittable { to, data }
//   lives on a PREPARED chain request via `getCallData()` — which the SDK marks OPTIONAL
//   (`getCallData?()`), so whether the Circle Wallets adapter implements it is an empirical fact,
//   not a documented one. We probe it.
//
// SAFETY (non-negotiable): this script NEVER signs, submits, or executes. It calls only
// estimate*/prepare*/getCallData()/eth_getCode/eth_call. It must NEVER call `.execute()`,
// `kit.swap()`, `kit.bridge()`, or `createContractExecutionTransaction` (those move money/gas).
// Provisioning a wallet is a free Circle API call (no on-chain tx). On-chain cross-checks go
// through the INDEPENDENT scripts/dd/rpc.mjs stack (raw fetch, chain-id asserted) — the auditor
// must not depend on the audited.
//
// RUN (KIT_KEY is supplied per-run and never stored; CIRCLE_* are in .env):
//   read -rs KIT_KEY && export KIT_KEY   # paste at the prompt — never in argv or history
//     node --env-file=.env scripts/spike-phase0.mjs
//   # reuse an existing wallet instead of provisioning a fresh one:
//   WALLET_ID=<uuid> WALLET_ADDRESS=0x… KIT_KEY=… node --env-file=.env scripts/spike-phase0.mjs

import { AppKit } from "@circle-fin/app-kit";
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";
import { circle } from "../netlify/functions/_circle.mjs";
import { ARC, CONTRACTS } from "../netlify/functions/_arc.mjs";
import { estimateSwapOnly } from "../netlify/functions/_swap.mjs";
import { rpcCall, assertChain } from "./dd/rpc.mjs";
import { getChain } from "./dd/chains.mjs";

const SWAP_CHAIN = "Arc_Testnet"; // App Kit's chain identifier for Arc Testnet
const AMOUNT_IN = "1"; // 1 USDC — priced/prepared only, never spent

let notes = [];
const line = (s = "") => console.log(s);
const ok = (s) => line(`  ✅ ${s}`);
const no = (s) => line(`  ⚠️  ${s}`);
const info = (s) => line(`  ·  ${s}`);

// ── guards ────────────────────────────────────────────────────────────────────────────────────
for (const k of ["CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET", "KIT_KEY"]) {
  if (!process.env[k]) {
    console.error(`Missing ${k}. CIRCLE_* are in .env; KIT_KEY is in the Netlify prod env — see header.`);
    process.exit(2);
  }
}

// A value looks like submittable calldata if it has a 0x address `to` and a 0x-hex `data` payload.
const isHex = (v) => typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v);
const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isCallData = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{8,}$/.test(v); // >=4-byte selector

// Recursively hunt an object graph for { to, data } pairs and getCallData() functions.
function deepFindCallData(root, maxDepth = 6) {
  const found = [];
  const seen = new WeakSet();
  (function walk(o, path, depth) {
    if (o == null || depth > maxDepth) return;
    if (typeof o === "function") return;
    if (typeof o !== "object") return;
    if (seen.has(o)) return;
    seen.add(o);
    // getCallData() surface (the documented extraction point on a prepared request)
    if (typeof o.getCallData === "function") found.push({ kind: "getCallData()", path });
    // an explicit { to, data } pair anywhere in the graph
    const to = o.to, data = o.data;
    if (isAddr(to) && isCallData(data)) found.push({ kind: "callData", path, to, data });
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === "object") walk(v, `${path}.${k}`, depth + 1);
    }
  })(root, "$", 0);
  return found;
}

// Enumerate function-valued property names (own + prototype chain) matching a filter.
function methodsMatching(obj, re) {
  const names = new Set();
  let o = obj;
  for (let i = 0; o && i < 4; i++, o = Object.getPrototypeOf(o)) {
    for (const n of Object.getOwnPropertyNames(o)) {
      try { if (typeof obj[n] === "function" && re.test(n)) names.add(n); } catch { /* getter throws */ }
    }
  }
  return [...names].sort();
}

line(`\n════════ PHASE 0 · money-path spike · READ-ONLY, no funds move ════════`);
line(`Arc Testnet (${ARC.chainId}) · USDC ${CONTRACTS.USDC.slice(0, 10)}… → EURC ${CONTRACTS.EURC.slice(0, 10)}…\n`);

// ── P0.1 — provision (or reuse) a dev-controlled SCA wallet ────────────────────────────────────
line("P0.1  Wallet (Circle API only — no on-chain tx, no gas, no funds)");
let walletId = process.env.WALLET_ID;
let walletAddress = process.env.WALLET_ADDRESS;
try {
  if (walletId && walletAddress) {
    ok(`reusing wallet ${walletId} (${walletAddress})`);
  } else {
    const client = circle();
    const ws = await client.createWalletSet({ name: `spike-phase0 ${new Date().toISOString()}` });
    const walletSetId = ws.data?.walletSet?.id ?? "";
    const wallets = await client.createWallets({
      blockchains: [ARC.blockchain], count: 1, walletSetId, accountType: "SCA",
    });
    const w = wallets.data?.wallets?.[0];
    if (!w) throw new Error("wallet creation returned no wallet");
    walletId = w.id; walletAddress = w.address;
    ok(`provisioned SCA ${walletId}`);
    info(`address ${walletAddress}  (same account type as prod, so results transfer)`);
  }
} catch (e) {
  no(`could not provision/resolve a wallet: ${e.message}`);
  line("\nCannot continue without a wallet id+address. Fix creds/network and re-run.");
  process.exit(2);
}

// ── P0.2 — estimateContractExecutionFee proves Circle's authoritative rail accepts Arc calls ───
line("\nP0.2  contractExecution rail live on Arc? (read-only fee estimate — no submit)");
try {
  const client = circle();
  const est = await client.estimateContractExecutionFee({
    walletId,
    contractAddress: CONTRACTS.USDC,
    abiFunctionSignature: "approve(address,uint256)",
    abiParameters: [CONTRACTS.EURC, "0"], // approve 0 — a no-op shape; we NEVER submit it
  });
  const fee = est?.data ?? est;
  ok(`estimateContractExecutionFee returned on ARC-TESTNET`);
  info(`fee tiers present: ${Object.keys(fee || {}).join(", ") || "(unexpected shape — inspect below)"}`);
  info(`this is the same rail bridge/deposit ride to an authoritative Circle tx id`);
} catch (e) {
  no(`estimateContractExecutionFee failed: ${e.message}`);
  notes.push("P0.2 failed — docs say ARC-TESTNET is supported on /contractExecution/estimateFee; investigate creds/SDK version before drawing conclusions.");
}

// ── P0.3 — THE DECIDER: is the swap router calldata { to, data } extractable read-only? ─────────
line("\nP0.3  ⭐ Swap router calldata exposed to the Circle Wallets adapter? (decides top vs middle)");

const adapter = createCircleWalletsAdapter({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
});
const kit = new AppKit();
const swapParams = {
  from: { adapter, chain: SWAP_CHAIN, address: walletAddress },
  tokenIn: "USDC",
  tokenOut: "EURC",
  amountIn: AMOUNT_IN,
  allowanceStrategy: "approve",
  config: { kitKey: process.env.KIT_KEY, slippageBps: 100 },
};

const hits = []; // extracted { to, data } payloads, from any avenue

// Avenue A — deep-scan the estimate result (public, stable). Likely pricing-only, but check.
line("\n  Avenue A — kit.estimateSwap() result");
try {
  const est = await estimateSwapOnly({ walletAddress, tokenIn: "USDC", tokenOut: "EURC", amountIn: Number(AMOUNT_IN) });
  info(`estimate keys: ${Object.keys(est || {}).join(", ")}`);
  info(`priced: ${JSON.stringify(est?.estimatedOutput ?? null)}`);
  const f = deepFindCallData(est);
  if (f.some((x) => x.kind === "callData")) {
    for (const x of f.filter((x) => x.kind === "callData")) { hits.push(x); ok(`calldata in estimate at ${x.path} → to=${x.to}`); }
  } else if (f.length) {
    info(`no { to, data } in estimate, but a getCallData() surface exists at: ${f.map((x) => x.path).join(", ")}`);
  } else {
    info(`estimate carries pricing only — no calldata, no getCallData() (as expected)`);
  }
} catch (e) {
  no(`estimateSwap threw: ${e.message}`);
}

// Avenue B — a PREPARED swap request via a public prepare* method, then getCallData(). No execute().
line("\n  Avenue B — prepared swap request → getCallData()  (NEVER .execute())");
const kitPrepMethods = methodsMatching(kit, /prepare|quote|route/i);
const adapterPrepMethods = methodsMatching(adapter, /prepare|calldata|quote|route/i);
info(`kit prepare-ish methods:     ${kitPrepMethods.join(", ") || "(none public)"}`);
info(`adapter prepare-ish methods: ${adapterPrepMethods.join(", ") || "(none public)"}`);

async function tryPrepared(label, thunk) {
  try {
    const prepared = await thunk();
    if (!prepared) return info(`${label}: returned nothing`);
    const graph = deepFindCallData(prepared);
    // If a getCallData() is reachable, call it (read-only — returns built calldata, does not submit).
    if (typeof prepared.getCallData === "function") {
      const cd = prepared.getCallData();
      if (cd && isAddr(cd.to) && isCallData(cd.data)) { hits.push({ kind: "callData", path: `${label}.getCallData()`, to: cd.to, data: cd.data }); return ok(`${label}.getCallData() → to=${cd.to} data=${cd.data.slice(0, 12)}…`); }
      return no(`${label}.getCallData() returned no usable { to, data }: ${JSON.stringify(cd)}`);
    }
    for (const g of graph.filter((x) => x.kind === "getCallData()")) {
      const holder = g.path; // best-effort: report; deep auto-call is unsafe to generalize
      info(`${label}: getCallData() present at ${holder} (call it in the follow-up spike)`);
    }
    const cds = graph.filter((x) => x.kind === "callData");
    if (cds.length) { for (const x of cds) { hits.push(x); ok(`${label}: calldata at ${x.path} → to=${x.to}`); } }
    else info(`${label}: prepared, but no { to, data } / callable getCallData surfaced`);
  } catch (e) {
    info(`${label}: not drivable from here — ${e.message.split("\n")[0]}`);
  }
}

// Best-effort concrete avenues, each fully guarded. Context shape is best-effort; a throw here is
// information ("this surface isn't externally drivable"), not a failure of the spike.
const ctx = { chain: SWAP_CHAIN, address: walletAddress, kitKey: process.env.KIT_KEY };
if (typeof kit.prepareSwap === "function") await tryPrepared("kit.prepareSwap", () => kit.prepareSwap(swapParams));
if (typeof adapter.prepareAction === "function") await tryPrepared("adapter.prepareAction('swap')", () => adapter.prepareAction("swap", swapParams, ctx));
if (typeof adapter.prepare === "function") await tryPrepared("adapter.prepare", () => adapter.prepare(swapParams, ctx));
if (!kitPrepMethods.length && !adapterPrepMethods.length) info("no public prepare* surface on kit or adapter — see verdict");

// ── on-chain cross-check (independent dd/rpc stack): any extracted `to` must be a real contract ──
if (hits.length) {
  line("\n  Cross-check extracted router target on-chain (independent dd/rpc.mjs, chain-id asserted)");
  try {
    const chain = getChain("arc-testnet");
    await assertChain(chain); // proves we're actually talking to Arc before we trust any code read
    for (const h of [...new Map(hits.map((x) => [x.to, x])).values()]) {
      const { result } = await rpcCall({ endpoint: chain.rpc, method: "eth_getCode", params: [h.to, "latest"] });
      const bytes = (result.length - 2) / 2;
      (bytes > 0 ? ok : no)(`router ${h.to} — ${bytes} bytes of code on Arc${bytes > 0 ? "" : " (EMPTY — calldata targets nothing!)"}`);
    }
  } catch (e) {
    no(`on-chain cross-check unavailable: ${e.message}`);
  }
}

// ── VERDICT ─────────────────────────────────────────────────────────────────────────────────────
const usable = hits.filter((h) => h.kind === "callData");
line(`\n════════════════════════════ VERDICT ════════════════════════════`);
if (usable.length) {
  line(`✅ TOP ROW — swap calldata IS extractable read-only ({ to, data } obtained).`);
  line(`   → Swap can be submitted via createContractExecutionTransaction({ contractAddress: to,`);
  line(`     callData: data }) → authoritative Circle tx id → waitForTx, exactly like bridge/deposit.`);
  line(`   → DELETABLE BY REFACTOR (no custody migration needed):`);
  line(`       • _swap-confirm.mjs PATH 2 (two-legged log-scan)`);
  line(`       • the sibling-ambiguity handling (the tx id disambiguates identical-shape fills)`);
  line(`       • the robust-id design debt — this WAS its open "submit half"; now closed`);
  line(`       • agentSwap's kit.swap() 1098 event-scrape → replace with the id path`);
  line(`   → The money-path migration argument dissolves into a local refactor onto a rail you own.`);
} else {
  const surfaceExists = hits.length > 0 || /* getCallData seen but not callable */ false;
  line(`⚠️  MIDDLE ROW (as far as a read-only probe can reach) — no submittable { to, data } was`);
  line(`   extracted for the Circle Wallets adapter. Swap stays bound to kit.swap()'s async path,`);
  line(`   so PATH 2 / sibling-ambiguity survive and the money-path migration does NOT remove them.`);
  line(`   BEFORE banking this as final, run the one follow-up it points to (still read-only):`);
  line(`     • If Avenue B printed a getCallData() surface, write a 10-line spike that imports the`);
  line(`       adapter's prepare path directly and calls getCallData() (NOT execute). If it yields`);
  line(`       { to, data } → you're actually TOP ROW via a deeper import than a probe should force.`);
  line(`     • If no prepare* surface exists at all on kit/adapter → MIDDLE ROW is confirmed.`);
}
if (notes.length) { line(`\nCaveats (read before trusting the verdict):`); for (const n of notes) line(`  • ${n}`); }
line(`\nNo money moved. estimate/prepare/getCallData/eth_getCode only — nothing signed or submitted.\n`);
