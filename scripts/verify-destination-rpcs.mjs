#!/usr/bin/env node
// verify-destination-rpcs.mjs — is every destination RPC we would verify a mint against ALIVE,
// and is it the chain we think it is?
//
//   node scripts/verify-destination-rpcs.mjs            # the gate
//   node scripts/verify-destination-rpcs.mjs --strict   # transient failures fail too
//
// ═══ 🚨 WHY THIS EXISTS — TWELVE DAYS, ~1,730 FAILURES, ONE DEAD DNS NAME ════════════════════
// `o/0xfd801d08…/0xccc02035…` — 1 USDC bridged to Polygon Amoy on 2026-08-02 — could never be
// verified. Circle's IRIS reported the mint as COMPLETE; our own read of the destination chain
// failed every single time, and the receipt sat at `mint_unconfirmed` for twelve days while the
// sweeper re-triggered it every ten minutes.
//
// The cause, measured 2026-08-15: **`rpc-amoy.polygon.technology` HAS NO DNS RECORD.** Two
// independent resolvers agree — the local one returns NO RESOLUTION, Google's public DoH returns
// NOERROR with an SOA and no A record, while `polygon.technology` itself resolves normally. The
// endpoint was decommissioned. `fetch` could not resolve it, threw, and the caller filed
// `rpc_error`.
//
// ⭐⭐ THE FAILURE WAS 100%, WHICH IS THE TELL NOBODY READ. Rate limits and flaky nodes are
// INTERMITTENT; a dead name fails every time. A permanent config fault spent twelve days wearing
// the costume of a transient one, and nothing in the system was capable of noticing — because
// nothing ever asked "is this endpoint alive?" outside of a money-path verification that only runs
// when a bridge happens to need it.
//
// ⭐ SO THE FIX IS NOT THE URL. The URL is one line. The fix is that a decommissioned endpoint now
// FAILS A GATE IN ONE SECOND instead of decaying silently into a twelve-day mystery.
//
// ═══ WHAT IT CHECKS, PER CHAIN ══════════════════════════════════════════════════════════════
//   1. the endpoint answers eth_chainId at all
//   2. that chainId EQUALS the pinned one — a working RPC for the WRONG chain is worse than a
//      dead one, because verifyMintOnChain's chain-pin would reject every mint while the endpoint
//      looked perfectly healthy
//   3. eth_getTransactionReceipt is permitted — some public endpoints answer eth_chainId and
//      refuse the method we actually depend on, which would fail ONLY on the money path
//   4. the PINNED USDC contract has code at that address on that chain — proof the endpoint really
//      is the chain claimed AND that the address we match Transfer logs against is real
//
// ⚠️ (3) AND (4) EXIST BECAUSE (1) IS NOT ENOUGH. An endpoint that passes only the liveness check
// can still be useless in exactly the way that matters, and it would fail for the first time on a
// user's bridge — the same "untested by construction" shape the receipt suite was built to close.
//
// ═══ ⚠️ WHY A TRANSIENT FAILURE DOES NOT FAIL THIS GATE ══════════════════════════════════════
// This runs in `deploy:prod`. If a third-party testnet node having a bad minute could block a
// deploy, the gate would be disabled within a week — and a disabled gate protects nothing.
// So the SAME discriminator the receipt now records applies here:
//   · `unreachable` (DNS/refused/cert) -> FAIL. Permanent, ours, fixable in one line.
//   · `transient`   (timeout/5xx)      -> WARN. Someone else's node, probably fine in a minute.
// ⭐ That split is what makes a blocking gate survivable. `--strict` fails on both, for a run where
// you want certainty rather than deployability.

import { DESTINATION_CHAINS, classifyRpcFailure } from "../netlify/functions/_receipt.mjs";

const STRICT = process.argv.includes("--strict");
const TIMEOUT_MS = 15_000;

let fail = 0, warn = 0, pass = 0;
const results = [];

async function call(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}

console.log("\nverify-destination-rpcs — can we actually read every chain we bridge to?\n");

for (const [key, chain] of Object.entries(DESTINATION_CHAINS)) {
  const row = { key, rpc: chain.rpc, problems: [], kind: null };

  // 1 + 2 — alive, and the chain it claims to be.
  let sawChainId = null;
  try {
    sawChainId = Number(BigInt(await call(chain.rpc, "eth_chainId", [])));
    if (sawChainId !== chain.chainId) {
      // ⚠️ ALWAYS FATAL, never "transient". A healthy endpoint serving the wrong chain is a
      // misconfiguration that no amount of waiting fixes, and verifyMintOnChain would refuse
      // every mint while this looked green.
      row.problems.push(`CHAIN MISMATCH — pinned ${chain.chainId}, endpoint reports ${sawChainId}`);
      row.kind = "unreachable";
    }
  } catch (e) {
    const c = classifyRpcFailure(e);
    row.kind = c.failureKind;
    row.problems.push(`eth_chainId failed [${c.failureKind}] — ${c.detail}`);
  }

  // 3 + 4 — only meaningful if the endpoint answered at all.
  if (sawChainId !== null && row.problems.length === 0) {
    try {
      // An unknown hash must return null, NOT an error. An error here means the method is
      // unavailable — which would surface for the first time on a real bridge.
      await call(chain.rpc, "eth_getTransactionReceipt", ["0x" + "00".repeat(31) + "01"]);
    } catch (e) {
      const c = classifyRpcFailure(e);
      row.kind = row.kind ?? c.failureKind;
      row.problems.push(`eth_getTransactionReceipt unavailable [${c.failureKind}] — ${c.detail}`);
    }
    try {
      const code = await call(chain.rpc, "eth_getCode", [chain.usdc, "latest"]);
      const bytes = typeof code === "string" ? (code.length - 2) / 2 : 0;
      if (bytes === 0) {
        // The pinned USDC has no code here. Either the address is wrong or this is not that
        // chain — and Transfer-log matching would silently never match. Permanent either way.
        row.problems.push(`PINNED USDC ${chain.usdc} HAS NO CODE on this endpoint`);
        row.kind = "unreachable";
      } else {
        row.usdcBytes = bytes;
      }
    } catch (e) {
      const c = classifyRpcFailure(e);
      row.kind = row.kind ?? c.failureKind;
      row.problems.push(`eth_getCode failed [${c.failureKind}] — ${c.detail}`);
    }
  }

  if (row.problems.length === 0) {
    pass++;
    console.log(`  ✓ ${key.padEnd(10)} chainId ${chain.chainId}, receipts OK, USDC ${row.usdcBytes}B — ${chain.rpc}`);
  } else if (row.kind === "unreachable" || STRICT) {
    fail++;
    console.log(`  ✗ ${key.padEnd(10)} ${chain.rpc}`);
    for (const p of row.problems) console.log(`      ${p}`);
  } else {
    warn++;
    console.log(`  ⚠ ${key.padEnd(10)} ${chain.rpc} — TRANSIENT, not failing the gate`);
    for (const p of row.problems) console.log(`      ${p}`);
  }
  results.push(row);
}

console.log("\n" + "─".repeat(92));
if (fail === 0) {
  console.log(`✅ DESTINATION RPCs OK — ${pass} healthy${warn ? `, ${warn} transient (warned, not failed)` : ""}.`);
  if (warn > 0) {
    console.log("   ⚠️ A transient failure is NOT proof the endpoint is fine — it is proof we could not");
    console.log("      tell today. Re-run, or use --strict, before concluding anything about it.");
  }
  console.log("─".repeat(92) + "\n");
  process.exit(0);
}
console.log(`❌ ${fail} DESTINATION RPC(s) UNUSABLE — a mint to these chains CANNOT be verified.`);
console.log("   This is the twelve-day failure mode: verification fails 100% of the time, the receipt");
console.log("   parks at `mint_unconfirmed`, and the sweeper re-triggers it forever. Fix the endpoint");
console.log("   in netlify/functions/_receipt.mjs — DESTINATION_CHAINS.");
console.log("─".repeat(92) + "\n");
process.exit(1);
