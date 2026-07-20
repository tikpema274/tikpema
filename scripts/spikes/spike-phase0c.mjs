// spike-phase0c.mjs — Phase 0 FOLLOW-UP #2. READ-ONLY. NEVER executes. Reaches the REAL Stage 3.
//
// phase0b failed on EXTERNAL wiring (couldn't hand-build App Kit's providers/context), so it never
// reached the real question. This one uses App Kit's OWN correctly-wired pipeline — the exact setup
// _swap.mjs runs real swaps with (new AppKit() + createCircleWalletsAdapter + the same swapParams,
// allowanceStrategy:"approve") — and INTERCEPTS the prepared request to read its calldata at PREPARE
// time, before any execute. The pipeline itself wires createSwap → prepareAction('swap.execute')
// correctly; we just read what it built and refuse to let it submit.
//
// TWO INDEPENDENT SAFETY LAYERS (either alone makes an accidental swap impossible):
//   1. The adapter is wrapped in a Proxy. Every prepared request it returns has execute() replaced
//      with a sentinel THROW, and every submit-ish adapter method (execute/send/submit/writeContract/
//      createContractExecutionTransaction/broadcast) throws too. Calldata is captured BEFORE that.
//   2. The wallet is FRESH and UNFUNDED. On Arc, USDC is gas — an unfunded SCA cannot pay for a swap
//      or an approve, so even a missed interception REVERTS on-chain. No funds can move, period.
//   We call getCallData()/signTypedData/estimate freely (all read-only); we NEVER call execute().
//
// RUN:
//   KIT_KEY="$(netlify env:get KIT_KEY --context production | sed 's/^KIT_KEY://')" \
//     node --env-file=.env scripts/spike-phase0c.mjs
//   (Reuse a KNOWN-EMPTY wallet instead of provisioning: WALLET_ID=… WALLET_ADDRESS=0x… — but only
//    if you have CONFIRMED it holds 0 USDC; the fresh-provision default guarantees that for you.)

import { AppKit } from "@circle-fin/app-kit";
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";
import { circle } from "../netlify/functions/_circle.mjs";
import { ARC, CONTRACTS } from "../netlify/functions/_arc.mjs";
import { rpcCall, assertChain } from "./dd/rpc.mjs";
import { getChain } from "./dd/chains.mjs";

const KIT_KEY = process.env.KIT_KEY;
const APPROVE_SELECTOR = "0x095ea7b3"; // approve(address,uint256)
const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isCallData = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{8,}$/.test(v);
const log = (s = "") => console.log(s);
const ok = (s) => log(`  ✅ ${s}`);
const no = (s) => log(`  ⚠️  ${s}`);
const info = (s) => log(`  ·  ${s}`);

if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET || !KIT_KEY) {
  console.error("Need CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET (.env) and KIT_KEY (Netlify prod env). See header.");
  process.exit(2);
}

class AbortExecute extends Error { constructor() { super("execute() blocked by spike (read-only)"); this.name = "AbortExecute"; } }
const SUBMIT_METHODS = /^(execute|send|sendTransaction|submit|writeContract|createContractExecutionTransaction|broadcast|signAndSend)$/;

// Captured calldata, one entry per prepared request the pipeline builds.
const captured = [];

// Wrap a prepared request so execute() throws but getCallData()/estimate/type pass through.
function neuterPrepared(prepared, label) {
  // Read the calldata NOW, before anything can execute.
  let cd = null;
  try { if (typeof prepared?.getCallData === "function") cd = prepared.getCallData(); } catch (e) { info(`${label}: getCallData() threw: ${e.message.split("\n")[0]}`); }
  const type = prepared?.type ?? prepared?.action ?? "?";
  const kind = cd && isCallData(cd.data) && String(cd.data).toLowerCase().startsWith(APPROVE_SELECTOR)
    ? "approve"
    : (cd && isAddr(cd.to) ? "adapter/swap" : "unknown");
  if (cd && isAddr(cd.to) && isCallData(cd.data)) {
    captured.push({ label, type, kind, to: cd.to, data: cd.data });
    ok(`prepared [${type}] kind=${kind} → to=${cd.to} data=${String(cd.data).slice(0, 14)}… (${(cd.data.length - 2) / 2} bytes)`);
  } else {
    info(`prepared [${type}]: no usable { to, data } exposed (getCallData ${typeof prepared?.getCallData})`);
  }
  return new Proxy(prepared, {
    get(t, p, r) {
      if (p === "execute") return async () => { throw new AbortExecute(); };
      const v = Reflect.get(t, p, r);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

// Proxy the adapter: intercept prepare*, block submits, pass everything else (incl. signTypedData,
// so a permit attempt on the SCA surfaces as itself rather than being hidden).
function guardAdapter(adapter) {
  return new Proxy(adapter, {
    get(t, p, r) {
      const name = String(p);
      const v = Reflect.get(t, p, r);
      if (typeof v !== "function") return v;
      if (name === "prepareAction" || name === "prepare") {
        return async (...args) => {
          const prepared = await v.apply(t, args);
          const label = name === "prepareAction" ? `prepareAction(${args[0]})` : "prepare";
          return neuterPrepared(prepared, label);
        };
      }
      if (SUBMIT_METHODS.test(name)) return async () => { throw new AbortExecute(); };
      return v.bind(t);
    },
  });
}

log(`\n════ PHASE 0c · REAL App Kit pipeline · READ-ONLY (execute neutered + unfunded wallet) ════`);

// ── fresh, unfunded wallet — the money-safety backstop ──────────────────────────────────────────
let walletAddress = process.env.WALLET_ADDRESS;
if (!walletAddress) {
  try {
    const client = circle();
    const ws = await client.createWalletSet({ name: `spike-phase0c ${new Date().toISOString()}` });
    const wallets = await client.createWallets({ blockchains: [ARC.blockchain], count: 1, walletSetId: ws.data?.walletSet?.id ?? "", accountType: "SCA" });
    walletAddress = wallets.data?.wallets?.[0]?.address;
    if (!walletAddress) throw new Error("no wallet returned");
    ok(`fresh UNFUNDED SCA ${walletAddress} — 0 USDC = 0 gas on Arc, so nothing can execute`);
  } catch (e) { console.error(`could not provision a fresh wallet: ${e.message}`); process.exit(2); }
} else {
  no(`using supplied ${walletAddress} — you MUST have confirmed it holds 0 USDC (else the backstop is gone)`);
}
log(`USDC ${CONTRACTS.USDC.slice(0, 10)}… → EURC ${CONTRACTS.EURC.slice(0, 10)}…\n`);

// ── drive the REAL pipeline; capture at prepare; never submit ────────────────────────────────────
const rawAdapter = createCircleWalletsAdapter({ apiKey: process.env.CIRCLE_API_KEY, entitySecret: process.env.CIRCLE_ENTITY_SECRET });
const adapter = guardAdapter(rawAdapter);
const kit = new AppKit();
const swapParams = {
  from: { adapter, chain: "Arc_Testnet", address: walletAddress },
  tokenIn: "USDC",
  tokenOut: "EURC",
  amountIn: "1",
  allowanceStrategy: "approve", // the only SCA-viable strategy (permit needs ecrecover; SCA is ERC-1271)
  config: { kitKey: KIT_KEY, slippageBps: 100 },
};

log("Driving kit.swap() — it builds createSwap → prepareAction('swap.execute'); we read, then abort at execute");
try {
  await kit.swap(swapParams);
  no("kit.swap() RETURNED without hitting our execute block — unexpected. Inspect captured[] and the wallet; nothing should have submitted (unfunded), but investigate before trusting anything.");
} catch (e) {
  if (e instanceof AbortExecute || /execute\(\) blocked by spike/.test(e?.message || "")) {
    ok("pipeline reached execute() and we aborted it — no submission, as designed");
  } else {
    // A non-sentinel throw is itself the finding — most likely the SCA-permit wall or an approve gate.
    no(`pipeline threw BEFORE our execute block: ${e?.message?.split("\n")[0]}`);
    if (/permit|signTypedData|ecrecover|1271|typed data/i.test(e?.message || "")) info("↳ looks like the SCA-permit wall (tokenInputs wanted a permit the SCA can't sign).");
  }
}

// ── did we capture the swap.execute (adapter) calldata? cross-check it on-chain ──────────────────
const swapHit = captured.find((c) => c.kind === "adapter/swap");
const approveHit = captured.find((c) => c.kind === "approve");
if (swapHit) {
  log("\nCross-check swap target on-chain (independent dd/rpc.mjs, chain-id asserted)");
  try {
    const chain = getChain("arc-testnet");
    await assertChain(chain);
    const { result } = await rpcCall({ endpoint: chain.rpc, method: "eth_getCode", params: [swapHit.to, "latest"] });
    const bytes = (result.length - 2) / 2;
    (bytes > 0 ? ok : no)(`swap target ${swapHit.to} — ${bytes} bytes on Arc${bytes ? " (the AdapterContract)" : " (EMPTY!)"}`);
  } catch (e) { no(`cross-check unavailable: ${e.message}`); }
}

// ── VERDICT ──────────────────────────────────────────────────────────────────────────────────
log(`\n════════════════════════════ VERDICT ════════════════════════════`);
if (swapHit) {
  log(`✅ TOP ROW — the pipeline built submittable swap calldata { to, data } and we read it read-only.`);
  log(`   → to=${swapHit.to}`);
  log(`   → Submit via createContractExecutionTransaction({ contractAddress: to, callData: data }) →`);
  log(`     authoritative Circle tx id → waitForTx, exactly like _bridge.mjs. Log-scan / sibling-`);
  log(`     ambiguity / robust-id debt deletable by refactor; no custody migration needed.`);
  log(`   RESIDUAL RISKS to clear in the money-phase (don't skip):`);
  log(`     • executeParams carries a DEADLINE — the quote→submit split has a validity window.`);
  log(`     • The approve leg is separate${approveHit ? ` (its calldata was ALSO captured → to=${approveHit.to})` : ""} — do approve(AdapterContract)`);
  log(`       via contractExecution first, then the swap.execute call, like bridge's approve+bridge pair.`);
} else if (approveHit) {
  log(`⚠️  MIDDLE (approve-gated) — the pipeline built the APPROVE calldata but aborted before the`);
  log(`   swap.execute prepare, because allowanceStrategy:"approve" gates the swap on a REAL on-chain`);
  log(`   approve landing first. A pure read-only run can't cross that gate.`);
  log(`   DEFINITIVE next step (minimal money, YOU run): do the ONE approve on-chain (moves NO USDC —`);
  log(`   just sets an allowance), then re-run this probe. If swap.execute { to, data } then builds →`);
  log(`   TOP via a two-tx (approve + swap) contractExecution refactor. If it still snags → MIDDLE final.`);
} else {
  log(`⚠️  MIDDLE (permit/wall or unreached) — no swap.execute calldata was captured. Read the throw`);
  log(`   above: a permit/signTypedData/1271 error is the SCA-permit wall — swap can't get a clean id`);
  log(`   on the SCA, so keep the hand-built confirm path and build the banked robust-id fix. Any other`);
  log(`   error means the pipeline broke before Stage 3 — paste it and we'll read it together.`);
}
log(`\nNo money moved. All executes neutered; wallet unfunded. quote/prepare/getCallData/eth_getCode only.\n`);
