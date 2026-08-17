// spike-phase0d-discover.mjs — READ-ONLY. NO MONEY. Discovers the approve TARGET before any tx.
//
// Phase 0c hit "Permit generation failed" — which happens BEFORE the swap.execute calldata (and its
// `to`) exists, so we never learned the AdapterContract address the SCA must approve. This finds it
// without moving anything: the failing permit is an EIP-712 authorization whose `message.spender`
// IS the AdapterContract. We intercept the typed-data at signTypedData time, capture spender, and
// cross-check it has code on Arc. It also captures any prepared-request `to` if one is reached.
//
// This moves NO money and executes NOTHING: signTypedData is a signature request (no chain write),
// every prepared execute() is neutered, and the wallet is fresh + unfunded. Output = the exact
// address to approve, for you to eyeball before the approve step is written.
//
// RUN: read -rs KIT_KEY && export KIT_KEY   # paste at the prompt — never in argv or history
//         node --env-file=.env scripts/spikes/spike-phase0d-discover.mjs

import { AppKit } from "@circle-fin/app-kit";
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";
import { circle } from "../../netlify/functions/_circle.mjs";
import { ARC, CONTRACTS } from "../../netlify/functions/_arc.mjs";
import { rpcCall, assertChain } from "../../shared/dd/rpc.mjs";
import { getChain } from "../../shared/dd/chains.mjs";

import { requireKitKey } from "../_kit-key.mjs";
const KIT_KEY = requireKitKey();
const KNOWN = new Set([CONTRACTS.USDC.toLowerCase(), CONTRACTS.EURC.toLowerCase(), "0x0000000000000000000000000000000000000000"]);
const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const log = (s = "") => console.log(s);
const ok = (s) => log(`  ✅ ${s}`);
const no = (s) => log(`  ⚠️  ${s}`);
const info = (s) => log(`  ·  ${s}`);

if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET || !KIT_KEY) {
  console.error("Need CIRCLE_API_KEY+CIRCLE_ENTITY_SECRET (.env). KIT_KEY is supplied per-run — see scripts/_kit-key.mjs (never from the production Netlify env).");
  process.exit(2);
}

class AbortExecute extends Error { constructor() { super("execute() blocked (read-only)"); this.name = "AbortExecute"; } }
const candidates = new Map(); // address -> how we saw it

// Collect any 0x40-hex address from an arbitrary object graph (the permit message, prepared reqs…).
function harvest(o, why, depth = 0, seen = new WeakSet()) {
  if (o == null || depth > 6) return;
  if (typeof o === "string") { if (isAddr(o) && !KNOWN.has(o.toLowerCase())) candidates.set(o.toLowerCase(), why); return; }
  if (typeof o !== "object" || seen.has(o)) return;
  seen.add(o);
  // prefer explicit spender-ish keys as strong signals
  for (const [k, v] of Object.entries(o)) {
    const w = /spender|adapter|verifyingcontract|to\b/i.test(k) ? `${why} (${k})` : why;
    harvest(v, w, depth + 1, seen);
  }
}

function guardAdapter(adapter) {
  return new Proxy(adapter, {
    get(t, p, r) {
      const name = String(p);
      const v = Reflect.get(t, p, r);
      if (typeof v !== "function") return v;
      if (name === "signTypedData") {
        return async (...args) => {
          // The permit typed-data carries the spender BEFORE any signing happens. Capture, then
          // still call through (read-only); if it throws — the permit wall — we already have it.
          harvest(args, "signTypedData permit");
          try { return await v.apply(t, args); } catch (e) { info(`signTypedData threw (expected on SCA permit): ${e.message.split("\n")[0]}`); throw e; }
        };
      }
      if (name === "prepareAction" || name === "prepare") {
        return async (...a) => {
          const prepared = await v.apply(t, a);
          try { if (typeof prepared?.getCallData === "function") harvest(prepared.getCallData(), `${name}(${a[0] ?? ""}) getCallData`); } catch {}
          harvest(prepared, `${name}(${a[0] ?? ""}) prepared`);
          return new Proxy(prepared, { get(tt, pp, rr) { if (pp === "execute") return async () => { throw new AbortExecute(); }; const vv = Reflect.get(tt, pp, rr); return typeof vv === "function" ? vv.bind(tt) : vv; } });
        };
      }
      if (/^(execute|send|sendTransaction|submit|writeContract|createContractExecutionTransaction|broadcast|signAndSend)$/.test(name)) return async () => { throw new AbortExecute(); };
      return v.bind(t);
    },
  });
}

log(`\n════ PHASE 0d · DISCOVER the approve target · READ-ONLY, nothing executes ════\n`);

// fresh unfunded wallet (backstop) — needs no balance to build/permit
let walletAddress;
try {
  const client = circle();
  const ws = await client.createWalletSet({ name: `spike-0d ${new Date().toISOString()}` });
  const wallets = await client.createWallets({ blockchains: [ARC.blockchain], count: 1, walletSetId: ws.data?.walletSet?.id ?? "", accountType: "SCA" });
  walletAddress = wallets.data?.wallets?.[0]?.address;
  ok(`fresh unfunded SCA ${walletAddress}`);
} catch (e) { console.error(`provision failed: ${e.message}`); process.exit(2); }

const adapter = guardAdapter(createCircleWalletsAdapter({ apiKey: process.env.CIRCLE_API_KEY, entitySecret: process.env.CIRCLE_ENTITY_SECRET }));
const kit = new AppKit();
log("\nDriving kit.swap() to the permit step (read-only) to capture the spender…");
try {
  await kit.swap({ from: { adapter, chain: "Arc_Testnet", address: walletAddress }, tokenIn: "USDC", tokenOut: "EURC", amountIn: "1", allowanceStrategy: "approve", config: { kitKey: KIT_KEY, slippageBps: 100 } });
  no("kit.swap returned unexpectedly — inspect candidates below; nothing should have executed (unfunded).");
} catch (e) {
  info(`pipeline stopped: ${e?.message?.split("\n")[0]}`);
  harvest(e, "error object"); // the error may name the spender/adapter too
}

// cross-check candidates on-chain (independent dd/rpc)
log(`\nCandidate approve targets (non-USDC/EURC addresses seen), cross-checked on Arc:`);
if (!candidates.size) {
  no("no candidate address surfaced. The permit failed before naming a spender. Fallback: read the");
  no("spender from a REAL past prod swap's USDC Approval event on-chain — tell me a prod swap tx hash");
  no("or the prod agent wallet and I'll pull the ground-truth AdapterContract from chain instead.");
} else {
  const chain = getChain("arc-testnet");
  try { await assertChain(chain); } catch (e) { no(`chain assert failed: ${e.message}`); }
  for (const [addr, why] of candidates) {
    try {
      const { result } = await rpcCall({ endpoint: chain.rpc, method: "eth_getCode", params: [addr, "latest"] });
      const bytes = (result.length - 2) / 2;
      (bytes > 0 ? ok : info)(`${addr} — ${bytes} bytes${bytes ? "" : " (EMPTY — not a contract, ignore)"}  [seen via: ${why}]`);
    } catch (e) { info(`${addr} — code read failed: ${e.message.split("\n")[0]}  [via: ${why}]`); }
  }
  log(`\n→ The APPROVE TARGET is the contract-bearing address flagged "spender"/"adapter" above.`);
  log(`  Paste this output back; I'll confirm the target and only THEN write the approve step.`);
}
log(`\nNo money moved. signTypedData/prepare/getCallData/eth_getCode only — nothing signed on-chain, nothing submitted.\n`);
