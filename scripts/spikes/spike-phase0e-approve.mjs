// spike-phase0e-approve.mjs — the FIRST money-moving step. ONE approve tx, then a read-only rebuild.
//
// Target is GROUND-TRUTH CONFIRMED two independent ways: (1) 0d permit grab tagged it "(adapter)",
// (2) the real fill 0x204d94f8… on-chain shows the swapping SCA approved EXACTLY 1000000 to it and
// it pulled+routed the USDC. DD-characterized: EIP-1967 proxy → impl 0xb4d0aa6c (17,729 bytes),
// EOA owner (pausable/upgradeable), NOT the Gateway trap, NOT the BridgingKit. Exact-amount approve
// bounds worst-case exposure to 1 USDC — the same contract every prod swap already approves.
//
// WHAT EXECUTES: exactly ONE tx — approve(0xbbd70b01…, 1000000) on USDC. No USDC is transferred;
// it sets a 1-USDC allowance. The swap.execute rebuild that follows is READ-ONLY: the adapter is
// Proxy-wrapped so every prepared execute() throws a sentinel (the same interception that provably
// stopped phase0c at the permit wall before any execute), and the adapter's own submit methods throw
// too. Residual: the rebuild drives kit.swap on the now-funded throwaway wallet; if interception
// were bypassed the max loss is 1 USDC of testnet USDC from a wallet you created for this.
//
// MODES:
//   node scripts/spike-phase0e-approve.mjs --provision            # make a fresh SCA to fund (no money)
//   WALLET_ADDRESS=0x… KIT_KEY=… node … spike-phase0e-approve.mjs # DRY RUN: shows the exact call + preflight
//   WALLET_ADDRESS=0x… KIT_KEY=… node … spike-phase0e-approve.mjs --confirm   # sends the ONE approve, then rebuilds
//
// RUN with: read -rs KIT_KEY && export KIT_KEY   # paste at the prompt — never in argv or history
//              WALLET_ADDRESS=0x… node --env-file=.env scripts/spike-phase0e-approve.mjs [--confirm]

import { createPublicClient, http, parseAbi, getAddress, formatUnits } from "viem";
import { AppKit } from "@circle-fin/app-kit";
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";
import { circle, waitForTx } from "../netlify/functions/_circle.mjs";
import { ARC, CONTRACTS } from "../netlify/functions/_arc.mjs";
import { rpcCall } from "./dd/rpc.mjs";
import { getChain } from "./dd/chains.mjs";

// ── the confirmed target + amount, hardcoded exactly (no inference at runtime) ──────────────────
const SPENDER = "0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b"; // ground-truth swap adapter (fill 0x204d94f8…)
const AMOUNT = "1000000"; // 1 USDC, 6 dp — exact-amount approve, matching what a real swap approves
const USDC = CONTRACTS.USDC;

const CONFIRM = process.argv.includes("--confirm");
const PROVISION = process.argv.includes("--provision");
const WALLET = process.env.WALLET_ADDRESS;
const log = (s = "") => console.log(s);
const ok = (s) => log(`  ✅ ${s}`);
const no = (s) => log(`  ⚠️  ${s}`);
const info = (s) => log(`  ·  ${s}`);

for (const k of ["CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET"]) if (!process.env[k]) { console.error(`Missing ${k} (.env)`); process.exit(2); }

const pc = createPublicClient({ chain: { id: ARC.chainId, name: "arc-testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [ARC.rpc] } } }, transport: http(ARC.rpc) });

// Preflight reads go through dd/rpc's transient-retry backoff (the same rpcCall that read clean
// through the Arc throttle for the state diagnostic). pc (viem) is kept ONLY for the post-approve
// confirmation read in the send path, which is intentionally left unchanged.
const DDCHAIN = getChain("arc-testnet");
const rpc = (method, params) => rpcCall({ endpoint: DDCHAIN.rpc, method, params }).then((r) => r.result);
const pad32 = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

// ── --provision: make a throwaway SCA to fund (no money moves) ──────────────────────────────────
if (PROVISION) {
  const client = circle();
  const ws = await client.createWalletSet({ name: `spike-0e ${new Date().toISOString()}` });
  const wallets = await client.createWallets({ blockchains: [ARC.blockchain], count: 1, walletSetId: ws.data?.walletSet?.id ?? "", accountType: "SCA" });
  const w = wallets.data?.wallets?.[0];
  log(`\nProvisioned throwaway SCA:\n  ${w?.address}\n\nFund it with ~2 USDC from https://faucet.circle.com (Arc gas is USDC), then re-run:\n  WALLET_ADDRESS=${w?.address} KIT_KEY=… node --env-file=.env scripts/spike-phase0e-approve.mjs        # dry run\n  WALLET_ADDRESS=${w?.address} KIT_KEY=… node --env-file=.env scripts/spike-phase0e-approve.mjs --confirm  # send approve\n`);
  process.exit(0);
}
if (!WALLET || !/^0x[0-9a-fA-F]{40}$/.test(WALLET)) { console.error("Set WALLET_ADDRESS=0x… (a FUNDED throwaway SCA). Run with --provision to make one."); process.exit(2); }

// ── show the EXACT approve call ──────────────────────────────────────────────────────────────────
log(`\n════ PHASE 0e · ONE approve tx ${CONFIRM ? "(WILL SEND)" : "(DRY RUN)"} ════\n`);
log(`THE EXACT APPROVE CALL:`);
log(`  client.createContractExecutionTransaction({`);
log(`    walletAddress:        "${WALLET}",`);
log(`    blockchain:           "${ARC.blockchain}",`);
log(`    contractAddress:      "${USDC}",            // USDC`);
log(`    abiFunctionSignature: "approve(address,uint256)",`);
log(`    abiParameters:        ["${SPENDER}", "${AMOUNT}"],  // spender = swap adapter, amount = 1 USDC`);
log(`    fee: { type: "level", config: { feeLevel: "MEDIUM" } },`);
log(`  })  →  waitForTx(client, tx.data.id)`);
log(`  Effect: sets allowance(${WALLET.slice(0, 10)}…, ${SPENDER.slice(0, 10)}…) = 1 USDC. Transfers NO USDC.\n`);

// ── preflight reads (read-only) ──────────────────────────────────────────────────────────────────
log(`Preflight (read-only, via dd/rpc backoff — throttle-resilient):`);
try {
  const id = parseInt(await rpc("eth_chainId", []), 16); (id === ARC.chainId ? ok : no)(`chainId ${id}${id === ARC.chainId ? "" : ` — EXPECTED ${ARC.chainId}, ABORT`}`); if (id !== ARC.chainId) process.exit(1);
  const bal = BigInt(await rpc("eth_call", [{ to: USDC, data: "0x70a08231" + pad32(WALLET) }, "latest"]));
  (bal > 0n ? ok : no)(`wallet USDC balance ${formatUnits(bal, 6)} ${bal > 0n ? "(covers Arc gas)" : "— ZERO: fund it first, approve needs gas"}`); if (bal === 0n && CONFIRM) { no("refusing to send approve from an unfunded wallet"); process.exit(1); }
  const allow = BigInt(await rpc("eth_call", [{ to: USDC, data: "0xdd62ed3e" + pad32(WALLET) + pad32(SPENDER) }, "latest"]));
  info(`current allowance to spender: ${formatUnits(allow, 6)} USDC${allow >= BigInt(AMOUNT) ? " (already ≥ 1 — approve is idempotent/redundant but harmless)" : ""}`);
  const code = await rpc("eth_getCode", [SPENDER, "latest"]);
  const bytes = code && code !== "0x" ? (code.length - 2) / 2 : 0; (bytes > 0 ? ok : no)(`spender ${SPENDER} has ${bytes} bytes of code${bytes ? "" : " — NOT A CONTRACT, ABORT"}`); if (!bytes) process.exit(1);
} catch (e) { no(`preflight read failed: ${e.message.split("\n")[0]}`); process.exit(1); }

if (!CONFIRM) { log(`\nDRY RUN — nothing sent. Re-run with --confirm to send the ONE approve above.\n`); process.exit(0); }

// ── SEND the one approve ─────────────────────────────────────────────────────────────────────────
log(`\nSending the approve (the only tx this script executes)…`);
const client = circle();
let approveHash;
try {
  const tx = await client.createContractExecutionTransaction({
    walletAddress: WALLET,
    blockchain: ARC.blockchain,
    contractAddress: USDC,
    abiFunctionSignature: "approve(address,uint256)",
    abiParameters: [SPENDER, AMOUNT],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  approveHash = await waitForTx(client, tx.data?.id);
  ok(`approve landed — tx ${approveHash}`);
  info(`${ARC.explorer}/tx/${approveHash}`);
  const allow = await pc.readContract({ address: getAddress(USDC), abi: parseAbi(["function allowance(address,address) view returns (uint256)"]), functionName: "allowance", args: [getAddress(WALLET), getAddress(SPENDER)] });
  (allow >= BigInt(AMOUNT) ? ok : no)(`allowance now ${formatUnits(allow, 6)} USDC`);
} catch (e) { no(`approve failed: ${e.message.split("\n")[0]}`); process.exit(1); }

// ── read-only rebuild: does the allowance let swap.execute build WITHOUT a permit? ───────────────
log(`\nRead-only rebuild: does the allowance bypass the permit wall? (execute neutered — nothing submits)`);
class AbortExecute extends Error { constructor() { super("execute blocked (read-only)"); this.name = "AbortExecute"; } }
const SUBMIT = /^(execute|send|sendTransaction|submit|writeContract|createContractExecutionTransaction|broadcast|signAndSend)$/;
const captured = [];
const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isData = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{8,}$/.test(v);
function neuter(prepared, label) {
  try { if (typeof prepared?.getCallData === "function") { const cd = prepared.getCallData(); if (cd && isAddr(cd.to) && isData(cd.data)) { captured.push({ label, to: cd.to, data: cd.data, type: prepared?.type ?? "?" }); ok(`prepared [${prepared?.type ?? "?"}] → to=${cd.to} data=${cd.data.slice(0, 14)}… (${(cd.data.length - 2) / 2} bytes)`); } } } catch (e) { info(`${label}: getCallData threw ${e.message.split("\n")[0]}`); }
  return new Proxy(prepared, { get(t, p, r) { if (p === "execute") return async () => { throw new AbortExecute(); }; const v = Reflect.get(t, p, r); return typeof v === "function" ? v.bind(t) : v; } });
}
const adapter = new Proxy(createCircleWalletsAdapter({ apiKey: process.env.CIRCLE_API_KEY, entitySecret: process.env.CIRCLE_ENTITY_SECRET }), {
  get(t, p, r) { const n = String(p); const v = Reflect.get(t, p, r); if (typeof v !== "function") return v;
    if (n === "prepareAction" || n === "prepare") return async (...a) => neuter(await v.apply(t, a), `${n}(${a[0] ?? ""})`);
    if (SUBMIT.test(n)) return async () => { throw new AbortExecute(); };
    return v.bind(t); } });
try {
  await new AppKit().swap({ from: { adapter, chain: "Arc_Testnet", address: WALLET }, tokenIn: "USDC", tokenOut: "EURC", amountIn: "1", allowanceStrategy: "approve", config: { kitKey: process.env.KIT_KEY, slippageBps: 100 } });
  no("kit.swap returned without hitting the execute block — inspect captured[]; nothing should have submitted.");
} catch (e) {
  if (e instanceof AbortExecute) ok("pipeline reached execute() and we aborted it — no submission");
  else { no(`pipeline threw: ${e?.message?.split("\n")[0]}`); if (/permit|signTypedData|1271/i.test(e?.message || "")) info("↳ STILL the permit wall — allowance did NOT bypass it."); }
}

const swapHit = captured.find((c) => c.to.toLowerCase() !== USDC.toLowerCase() && !String(c.data).toLowerCase().startsWith("0x095ea7b3"));
log(`\n════════════════════════════ VERDICT ════════════════════════════`);
if (swapHit) {
  log(`✅ TOP ROW — with an allowance set, swap.execute built submittable calldata { to, data }:`);
  log(`   to=${swapHit.to}`);
  log(`   → The refactor is viable: approve(adapter) via contractExecution, then submit this calldata`);
  log(`     via createContractExecutionTransaction → authoritative Circle id → waitForTx (like bridge).`);
  log(`   → Log-scan / sibling-ambiguity / robust-id debt deletable. Residual: executeParams deadline`);
  log(`     (quote→submit window) — validate in the full money-path re-prove.`);
} else {
  log(`⚠️  MIDDLE FINAL — even WITH the allowance, swap.execute did not yield submittable calldata`);
  log(`   (permit wall held / no calldata). App Kit's SCA swap can't be decoupled into a self-submitted`);
  log(`   authoritative-id tx. Keep the hand-built confirm path; build the banked robust-id fix via`);
  log(`   an independently-reconstructed route, not by lifting App Kit's prepared calldata.`);
}
log(`\nOne approve executed; swap.execute was capture-and-abort. ${captured.length} calldata payload(s) captured.\n`);
