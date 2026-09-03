// verify-fee-manager-live.mjs — THE PINNED THIRD-PARTY ADDRESSES, AGAINST THE LIVE CONTRACT.
//
//   npm run test:feemanagerlive
//
// ═══ ⛔ DELIBERATELY OUTSIDE `test:all` ═══════════════════════════════════════════════════════
// It reads Arc's PUBLIC RPC, which is recorded as throttled and has produced ETIMEDOUT mid-run
// before. A flaky network inside a BLOCKING aggregate manufactures tolerated red — species 3 —
// so this is run deliberately, like gate:pins and test:vanillabyteslive.
//
// ⭐ ITS OFFLINE HALF IS IN `test:all`. `verify-fee-reconcile.mjs` §9 asserts that the literals are
// pinned, that the getter check which justified them is recorded beside them, and that the failure
// direction is written down. What only THIS can see is the one thing no offline check ever could:
// that the addresses are still the ones the live contract names.
//
// ═══ WHAT IT PROVES, AND WHY A LITERAL IS ACCEPTABLE AT ALL ═══════════════════════════════════
// `_fee-reconcile.mjs` identifies the fee by the leg that moves it onward to the FeeManager. That
// address is an immutable of a contract we do not own. Reading the getter on every reconcile would
// add an RPC round trip to every verdict and make a detector's correctness depend on a second live
// call — so the address is a literal, and this suite is what keeps the literal honest.
//
// ⚠️ A STALE LITERAL DEGRADES TO `unreadable`, NEVER TO A FALSE `matched` — the forward leg simply
// stops matching. That is why the literal is safe; it is not why it is acceptable to leave wrong.
//
// Reads only. Signs nothing, submits nothing, spends nothing.

import { ARC } from "../netlify/functions/_arc.mjs";
import { TMWF, FEE_MANAGER } from "../netlify/functions/_fee-reconcile.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } return !!c; };

const lc = (s) => String(s).toLowerCase();

async function ethCall(to, data) {
  const r = await fetch(ARC.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "eth_call reverted");
  return j.result;
}

console.log(`\nverify-fee-manager-live — pinned addresses vs the live contract on ${ARC.rpc}\n`);

// ⚠️ THE CHAIN PIN FIRST. An endpoint answering for a different chain would make every reading
// below meaningless while looking perfectly healthy — the same reason rpcFallback pins per call.
try {
  const idHex = await ethCall(TMWF, "0x").catch(() => null);
  void idHex;
  const r = await fetch(ARC.rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  const seen = Number(BigInt((await r.json()).result));
  if (!check("⭐ the endpoint answers for Arc", seen === ARC.chainId, `saw ${seen}, expected ${ARC.chainId}`)) {
    console.log("\n⛔ STOPPING — every reading below would be about the wrong chain.\n");
    process.exit(1);
  }
} catch (e) {
  // ⛔ UNREACHABLE IS NOT A FAILING ASSERTION, AND IT IS NOT A PASS EITHER. Exit 2, its own outcome,
  // so a throttled RPC can never be read as "the addresses were verified".
  console.log(`\n⚠️  INCONCLUSIVE — could not reach Arc: ${e?.message}`);
  console.log("⛔ This is NOT a pass. Nothing was verified. Re-run when the RPC answers.\n");
  process.exit(2);
}

// ── the getter that justifies the literal ──────────────────────────────────────────────────────
// `feeManager()` = 0xd0fb0203. Measured 2026-09-03: it is the ONLY getter that exists —
// `FEE_MANAGER()`, `getFeeManager()` and `_FEE_MANAGER()` all revert.
const fm = await ethCall(TMWF, "0xd0fb0203");
check("⭐⭐ TMWF.feeManager() still returns the pinned FEE_MANAGER",
  fm && lc("0x" + fm.slice(-40)) === lc(FEE_MANAGER), `chain says 0x${(fm || "").slice(-40)}, pinned ${FEE_MANAGER}`);

// ⭐ A SECOND, INDEPENDENT ADDRESS FROM THE SAME CONTRACT. If TMWF itself were the wrong address,
// `feeManager()` would revert or answer for something else — and this pins that TMWF is the
// TokenMessengerWithFees we think it is, via the TokenMessengerV2 it fronts.
const tm = await ethCall(TMWF, "0x46117830"); // tokenMessenger()
check("⭐ …and TMWF.tokenMessenger() is Arc's TokenMessengerV2 — so TMWF itself is the right contract",
  tm && lc("0x" + tm.slice(-40)) === "0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa",
  `chain says 0x${(tm || "").slice(-40)}`);

console.log(`\n${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail ? 1 : 0);
