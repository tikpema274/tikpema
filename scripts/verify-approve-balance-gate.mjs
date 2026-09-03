// verify-approve-balance-gate.mjs — ZERO-MONEY proof of the pre-flight balance gate.
//   node --experimental-test-module-mocks scripts/verify-approve-balance-gate.mjs
//
// job #155341 approved a 10 USDC bridge against a 6.30 wallet → burn reverted on-chain
// (INSUFFICIENT_TOKEN) → raw 500 + standing allowance. This gate reads the balance BEFORE
// the burn and rejects cleanly. Proves:
//   1. balance < amount → 402 need/have/walletAddress, and executeAction is NEVER called
//      (no burn submitted — the whole point).
//   2. balance >= amount → proceeds to execution as before (funded path unchanged).
//   3. balance == amount → proceeds (>= is inclusive; sponsored gas means amount suffices).
//   + ordering: on reject, NO lock is written and NO burn is submitted.
import { mock } from "node:test";

// ⭐⭐ SPREAD THE REAL MODULE, OVERRIDE ONLY WHAT THIS SUITE NEEDS. An explicit namedExports
// list breaks every time _agent-wallets gains an export — it has now done so TWICE
// (WALLET_PROVISIONING_STATUS, then WALLET_UNRESOLVABLE_STATUS), each time failing at module
// INSTANTIATION with a message about the export rather than about the test. Spreading makes the
// mock track the module instead of a snapshot of it.
const REAL_WALLETS = await import("../netlify/functions/_agent-wallets.mjs");

const OWNER = "0xc54d47211997aca90ef4fcfbc742a3b511b4e621";
const BURN = "0x" + "b1".repeat(32);

const stores = {};
const mkStore = (name) => {
  stores[name] ??= new Map();
  const m = stores[name];
  return { get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => void m.set(k, JSON.stringify(v)) };
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: mkStore } });
mock.module("../netlify/functions/_auth.mjs", { namedExports: { requireSession: () => ({ address: OWNER, method: "metamask" }), internalToken: () => "t", requireInternal: () => true } });
mock.module("../netlify/functions/_agent-wallets.mjs", { namedExports: { ...REAL_WALLETS,  ensureOwnerWallet: async () => ({ walletAddress: OWNER, pending: false }) } });

// ── the balance the pre-flight read returns (6-dp minor units) ──
let balanceMinor = 0n;
mock.module("../netlify/functions/_predict.mjs", {
  namedExports: { publicClient: () => ({ readContract: async () => balanceMinor }) },
});

// executeAction: instrumented so we can PROVE it is not called on the reject path.
let execCalls = 0;
mock.module("../netlify/functions/_actions.mjs", {
  namedExports: {
    executeAction: async (step) => {
      execCalls++;
      return { ok: true, kind: "bridge_usdc", state: "submitted", burnHash: BURN, tx: `x/${BURN}`, destination: step.destination, feeUsdc: 0.2, netUsdc: step.amountUsdc - 0.2, recipient: OWNER };
    },
  },
});
// ═══ ⭐⭐ THE GATE NOW QUOTES, SO THE MOCK MUST ANSWER A QUOTE ═════════════════════════════════
// The balance gate requires `amount + fee` from the SAME quote whose `signedQuote` is submitted, so
// this endpoint fetches and seals one in-request. A bare 202 for every fetch made `bridgeFee` throw
// ("res.json is not a function") and the gate returned 409 — a refusal for the wrong reason, which
// looked exactly like the 402 not firing.
// ⚠️ THE FEE IS A FIXTURE AND IT IS DELIBERATELY LARGE ENOUGH TO MATTER: 0.054129 on a 10 USDC
// bridge moves the requirement to 10.054129, which is the whole point of the change. A fee of 0
// would let every assertion below pass under the OLD rule too.
// ⚠️ The endpoint now SEALS the quote it fetched, so the seal secret must exist. Set before the
// module is imported — `quoteSecret()` reads it at call time, but nothing here should depend on that.
process.env.SESSION_SECRET ||= ["approve", "balance", "gate", "suite", "not", "a", "credential"].join("-");
const QUOTE_FEE_MINOR = 54_129n;
const FAR_DEADLINE = 4102444800;
const SIGNED_QUOTE = "0x01" + "00".repeat(31) + "20"
  + "00" + BigInt(FAR_DEADLINE).toString(16).padStart(62, "0") + "ab".repeat(32);
globalThis.fetch = async (url) => {
  if (String(url).includes("/v2/quote/burn/")) {
    return { ok: true, status: 200, json: async () => ({
      signedQuote: SIGNED_QUOTE, issuedAt: FAR_DEADLINE - 120,
      expiry: { mode: "TIMESTAMP", expiresAt: FAR_DEADLINE },
      feeTotalAmount: QUOTE_FEE_MINOR.toString(),
      feeToken: "0x3600000000000000000000000000000000000000",
    }) };
  }
  return { status: 202, ok: true }; // verifier trigger, swallowed
};

const { handler } = await import("../netlify/functions/job-bridge-approve.mjs");

const runs = mkStore("job-runs"), deliv = mkStore("job-deliverables");
const seed = async (amount) => {
  stores["job-runs"].clear(); stores["job-deliverables"].clear();
  await runs.setJSON("run:r1", { runId: "r1", owner: OWNER, jobId: "job-1", walletAddress: OWNER });
  await deliv.setJSON("job-1", {
    status: "completed", canonicalReport: "{}", deliverableHash: "0xh", brief: {},
    proposal: { action: "bridge_usdc", destination: "base", amountUsdc: amount, reasoning: "r" },
  });
};
const call = () => handler({ httpMethod: "POST", headers: {}, blobs: null, body: JSON.stringify({ runId: "r1" }) });
const parse = (r) => ({ status: r.statusCode, body: JSON.parse(r.body) });
const usdc = (n) => BigInt(Math.round(n * 1e6));

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

console.log("CASE 1: balance 6.30 < amount 10 → clean 402, NO burn (the #155341 scenario)");
{
  await seed(10); balanceMinor = usdc(6.30); execCalls = 0;
  const { status, body } = parse(await call());
  check("HTTP 402", status === 402, `got ${status}`);
  // ⭐⭐ THE REQUIREMENT IS amount + fee NOW, AND THAT IS THE CHANGE THIS CASE EXISTS TO PIN.
  // 🚨 The comment it replaced said "REQUIRED = amount, NO BUFFER — the fee comes out of the MINTED
  // side, not the wallet". That was a correct derivation of the mechanic upfront fees INVERT: the
  // fee is charged on the SOURCE, so the wallet parts with both and a gate requiring only the
  // amount would pass a wallet that cannot pay — putting back the INSUFFICIENT_TOKEN revert this
  // gate exists to prevent.
  check("⭐⭐ need == amount + fee, not amount", body.need === 10 + Number(QUOTE_FEE_MINOR) / 1e6,
    `${body.need} (fee ${Number(QUOTE_FEE_MINOR) / 1e6})`);
  check("🚨 …and it is STRICTLY MORE than the amount — the old rule would have said 10",
    body.need > 10, `${body.need} > 10`);
  check("have == 6.3", body.have === 6.3);
  check("walletAddress present", body.walletAddress === OWNER);
  check("executeAction NEVER called (no burn submitted)", execCalls === 0, `calls=${execCalls}`);
  check("NO lock written (receipt absent on reject)", (await deliv.get("job-1")).receipt === undefined);
  // ⚠️ THIS PINNED `Have 6.30 … need 10.00` — the 2dp rendering — and went red on 2026-09-03 when
  //    the directional-rounding fix landed. It went red CORRECTLY: it was pinned to a format that
  //    was itself the defect. A balance of 9.999 against a need of 10 rendered "Have 10.00, need
  //    10.00", a refusal whose own numbers say it should have passed.
  // ⭐ RE-PINNED TO THE PROPERTY, NOT THE FORMAT: both figures appear, at the token's full 6-dp
  //    precision, and the printed pair still reads as a genuine shortfall.
  const shown = body.error || "";
  check("message names have+need", /Have 6\.300000 USDC, need 10\.054129/.test(shown), shown);
  // ⭐ AND IT NAMES THE FEE SEPARATELY. "need 10.054129" against a 10 USDC bridge reads as an error
  // unless the fee is visible beside it — the reader must be able to see where the extra came from.
  check("⭐⭐ …and the message breaks the requirement into amount + fee",
    /10 to bridge plus a 0\.054129 USDC fee/.test(shown), shown);
  const nums = [...shown.matchAll(/(\d+\.\d+)/g)].map((m) => Number(m[1]));
  check("⭐⭐ …and the printed pair does NOT read as sufficient — have < need on the SHOWN figures",
    nums.length >= 2 && nums[0] < nums[1], `${nums.join(" vs ")}`);
}

console.log("\nCASE 2: balance 25.00 >= amount 10 → proceeds to execution (funded, no regression)");
{
  await seed(10); balanceMinor = usdc(25); execCalls = 0;
  const { status, body } = parse(await call());
  check("HTTP 200 executed:true", status === 200 && body.executed === true, `got ${status}`);
  check("executeAction WAS called (burn proceeds)", execCalls === 1, `calls=${execCalls}`);
  check("receipt burn_confirmed", (await deliv.get("job-1")).receipt.state === "burn_confirmed");
}

// ═══ ⭐⭐ THE BOUNDARY MOVED WITH THE REQUIREMENT, AND BOTH SIDES OF IT ARE PINNED ═══════════════
// This used to seed exactly the AMOUNT and expect a pass. Under upfront fees the wallet must cover
// `amount + fee`, so a balance of exactly the amount is now a SHORTFALL — and asserting only the
// new pass case would leave the old boundary untested in the direction that matters.
console.log("\nCASE 3a: balance 10.00 == amount but < amount + fee → 402 (the boundary that MOVED)");
{
  await seed(10); balanceMinor = usdc(10); execCalls = 0;
  const { status, body } = parse(await call());
  check("🚨 exactly the AMOUNT is no longer enough — the fee is charged on top",
    status === 402, `got ${status}`);
  check("  …and nothing was submitted", execCalls === 0, `calls=${execCalls}`);
  check("⭐ …and the shortfall is only the fee, which the message must make visible",
    /need 10\.054129/.test(body.error || "") && /plus a 0\.054129 USDC fee/.test(body.error || ""),
    body.error);
}

console.log("\nCASE 3b: balance 10.054129 == amount + fee → proceeds (>= inclusive; sponsored gas)");
{
  await seed(10); balanceMinor = usdc(10) + QUOTE_FEE_MINOR; execCalls = 0;
  const { status, body } = parse(await call());
  check("HTTP 200 executed:true (boundary is inclusive at amount + fee)", status === 200 && body.executed === true, `got ${status}`);
  check("executeAction called at exact-balance", execCalls === 1, `calls=${execCalls}`);
}

console.log("\nORDERING: read → reject-or-proceed → (only if funded) burn");
{
  await seed(10); balanceMinor = usdc(9.999999); execCalls = 0; // one micro-USDC short
  const { status, body } = parse(await call());
  check("9.999999 < 10 → 402, still no burn", status === 402 && execCalls === 0, `status=${status} calls=${execCalls}`);
  // ═══ ⭐⭐ THIS CASE ALREADY DROVE THE DEFECT AND NEVER LOOKED AT IT ════════════════════════
  // 9.999999 against 10 is EXACTLY the shortfall that rendered "Have 10.00 USDC, need 10.00." — a
  // refusal whose own two numbers say it should have passed. The case existed, produced the string,
  // and asserted only `status` and `execCalls`. ⛔ A suite that EXERCISES a defect without asserting
  // on it is not neutral: it is evidence the path was covered.
  const msg = body.error || "";
  const seen = [...msg.matchAll(/(\d+\.\d+)/g)].map((m) => Number(m[1]));
  check("⭐⭐ …and at ONE MICRO-USDC short the message still reads as a shortfall",
    seen.length >= 2 && seen[0] < seen[1], msg);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money.`);
process.exit(fail === 0 ? 0 : 1);
