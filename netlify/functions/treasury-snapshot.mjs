// treasury-snapshot.mjs — GET: every USDC pocket of the signed-in user, their treasury targets, and the
// PROPOSED moves that would close the drift. READ-ONLY. Nothing here signs or moves money; each proposal is
// confirmed on #/unified or #/bridge, where that move's caps, pause, ledger and fee quote already live.
//
// Pockets (decided 2026-09-19 — the ones we can READ and MOVE today):
//   arc_sca   — the user's Arc agent SCA, native USDC (+ EURC shown, never summed)   walletTokenBalances
//   unified   — the Gateway unified balance, Arc domain 26 + Base Sepolia domain 6   gateway-balance's reader
//   dest:*    — USDC at a destination-chain address the user NAMED in their policy   DESTINATION_CHAINS + rpcFallback
// Every read is independent (Promise.allSettled). An unreadable pocket is `usdc:null, ok:false` — and the
// planner then refuses to propose anything, because shares are unknown. [[absence-must-never-read-as-safe]]
import { connectBlobs } from "./_blobs.mjs";
import { json, bridgeCapUsdc, ubDepositMaxPerTxUsdc } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet, WALLET_PROVISIONING_STATUS, walletProvisioningRefusal, WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal, isWalletUnresolvable } from "./_agent-wallets.mjs";
import { walletTokenBalances } from "./_balances.mjs";
import { CHAINS as GATEWAY_CHAINS, readDomain } from "./gateway-balance.mjs";
import { DESTINATION_CHAINS, rpcFallback } from "./_receipt.mjs";
import { readTreasuryPolicy } from "./_treasury-policy.mjs";
import { planRebalance, destPocketId, POCKET } from "../../shared/treasury/plan.mjs";

const BALANCE_OF = "0x70a08231";
const pad = (a) => String(a).slice(2).toLowerCase().padStart(64, "0");
/** 6dp string from a hex uint256 balance (USDC has 6 decimals on every destination we read). */
function hexToUsdc(hex) {
  const u = BigInt(hex); const s = u.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}

/** USDC at `address` on a destination chain, or { ok:false } — never throws. */
export async function readDestinationUsdc(chainKey, address) {
  const chain = DESTINATION_CHAINS[chainKey];
  if (!chain) return { ok: false, reason: `unknown chain ${chainKey}` };
  try {
    const got = await rpcFallback(chain, "eth_call", [{ to: chain.usdc, data: BALANCE_OF + pad(address) }, "latest"]);
    if (typeof got?.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(got.result)) return { ok: false, reason: "no result" };
    return { ok: true, usdc: hexToUsdc(got.result === "0x" ? "0x0" : got.result), rpc: got.rpc };
  } catch (e) {
    return { ok: false, reason: e?.message ?? String(e) };
  }
}

/** The pockets, read in parallel. Exported for the suite (crafted readers injected). */
export async function readPockets({ walletAddress, policy, readers = {} }) {
  const arc = readers.arc ?? (() => walletTokenBalances({ walletAddress }));
  const gw = readers.gateway ?? ((domain) => readDomain(walletAddress, domain));
  const dst = readers.dest ?? readDestinationUsdc;
  const destRows = policy?.targets?.dest ?? [];
  const settled = await Promise.allSettled([
    arc(),
    ...GATEWAY_CHAINS.map((c) => gw(c.domain)),
    ...destRows.map((d) => dst(d.chain, d.address)),
  ]);
  const val = (i) => (settled[i].status === "fulfilled" ? settled[i].value : null);
  const pockets = [];
  const a = val(0);
  pockets.push({ id: POCKET.ARC_SCA, label: "Agent wallet", chain: "Arc", address: walletAddress, usdc: a?.usdc ?? null, ok: a?.usdc != null, note: "on-chain read" });
  pockets.push({ id: "arc_sca_eurc", label: "Agent wallet (EURC)", chain: "Arc", address: walletAddress, asset: "EURC", usdc: a?.eurc ?? null, ok: a?.eurc != null, note: "shown, never summed — no USD rate" });
  // Unified = the sum over Gateway domains, but ONLY if every domain read OK — a partial sum is a false total.
  const gws = GATEWAY_CHAINS.map((c, i) => ({ chain: c.chain, domain: c.domain, v: val(1 + i) }));
  const allOk = gws.every((g) => g.v?.ok);
  let sum = 0n;
  if (allOk) for (const g of gws) { const s = String(g.v.usdc); const [w, f = ""] = s.split("."); sum += BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, "0").slice(0, 6)); }
  const sumStr = allOk ? `${(sum / 1_000_000n).toString()}.${(sum % 1_000_000n).toString().padStart(6, "0")}` : null;
  pockets.push({ id: POCKET.UNIFIED, label: "Unified balance", chain: gws.map((g) => g.chain).join(" + "), address: walletAddress, usdc: sumStr, ok: allOk, note: "Circle Gateway · off-chain figure · exit takes about seven days", perDomain: gws.map((g) => ({ chain: g.chain, domain: g.domain, usdc: g.v?.ok ? g.v.usdc : null, ok: !!g.v?.ok })) });
  destRows.forEach((d, i) => {
    const v = val(1 + GATEWAY_CHAINS.length + i);
    pockets.push({ id: destPocketId(d.chain, d.address), label: `${d.chain} address`, chain: d.chain, address: d.address, usdc: v?.ok ? v.usdc : null, ok: !!v?.ok, note: v?.ok ? "on-chain read (named address — not movable from here)" : `unreadable: ${v?.reason ?? "no answer"}` });
  });
  return pockets;
}

export async function handler(event) {
  if (event.httpMethod !== "GET") return json(405, { error: "GET only" });
  if (event.blobs) connectBlobs(event);
  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  let w;
  try { w = await ensureOwnerWallet(session); }
  catch (e) {
    if (!isWalletUnresolvable(e)) throw e;
    return json(WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal(e));
  }
  if (w?.pending) return json(WALLET_PROVISIONING_STATUS, walletProvisioningRefusal());
  const walletAddress = w?.walletAddress;
  if (!walletAddress) return json(503, { error: "could not resolve your agent wallet — nothing was read; try again" });

  const pol = await readTreasuryPolicy(session.address);
  if (!pol.readable) return json(503, { error: pol.error });
  const pockets = await readPockets({ walletAddress, policy: pol.policy });
  const caps = { bridgeCapUsdc: String(bridgeCapUsdc()), ubDepositMaxPerTxUsdc: String(ubDepositMaxPerTxUsdc()) };
  const plan = planRebalance({ pockets, policy: pol.policy, caps });
  return json(200, { walletAddress, owner: session.address, pockets, policy: pol.policy, policyWarning: pol.error ?? null, caps, plan, readAt: new Date().toISOString() });
}
