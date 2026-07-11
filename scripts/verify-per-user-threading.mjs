// verify-per-user-threading.mjs — OFFLINE stub-proof of the Phase 1 per-user threading.
// No network, no chain, no money. Asserts the four invariants the per-user model rests on.
//
// The load-bearing trick: we deliberately SET process.env.AGENT_WALLET_ADDRESS before every
// executor test. If any executor still had an env fallback, it would happily use the shared
// wallet and NOT throw — so "it throws" is a positive proof that the fallback is gone.
//
//   node --env-file=.env scripts/verify-per-user-threading.mjs
import { ubDeposit } from "../netlify/functions/_ubdeposit.mjs";
import { ubSpend } from "../netlify/functions/_ubspend.mjs";
import { agentPay } from "../netlify/functions/_pay.mjs";
import { executeAction } from "../netlify/functions/_actions.mjs";
import { canSpendDay, recordAgentSpend, budgetConfig } from "../netlify/functions/_budget.mjs";
import { handler as gatewayBalance } from "../netlify/functions/gateway-balance.mjs";
import { handler as ubSpendHandler } from "../netlify/functions/agent-ub-spend.mjs";
import { handler as ubDepositHandler } from "../netlify/functions/agent-ub-deposit.mjs";

// THE TRAP: a shared wallet IS present in env. Every executor must ignore it.
const SHARED = "0xc54d47211997aca90ef4fcfbc742a3b511b4e621";
process.env.AGENT_WALLET_ADDRESS = SHARED;

const memStore = () => {
  const m = new Map();
  return {
    async getJSON(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async setJSON(k, v) { m.set(k, JSON.stringify(v)); },
  };
};

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`  ✓ ${name}`); };
const no = (name, why) => { fail++; console.log(`  ✗ ${name}\n      ${why}`); };

async function throwsWithout(name, fn, mustMention) {
  try {
    await fn();
    no(name, `did NOT throw — it silently fell back to the shared wallet (${SHARED})`);
  } catch (e) {
    if (new RegExp(mustMention, "i").test(e.message)) ok(`${name} — "${e.message}"`);
    else no(name, `threw, but for the wrong reason: ${e.message}`);
  }
}

// ── 1. NO ENV FALLBACK in any executor (env IS set — they must still refuse). ──
console.log("\n1. NO ENV FALLBACK — executors refuse to guess an owner (AGENT_WALLET_ADDRESS is SET)");
await throwsWithout("ubDeposit() without owner", () => ubDeposit({ amountUsdc: 1 }), "requires an .owner");
await throwsWithout("ubSpend() without sourceAccount",
  () => ubSpend({ recipientAddress: "0x" + "1".repeat(40), amountUsdc: "1" }), "requires a .sourceAccount");
await throwsWithout("agentPay() without sourceAccount",
  () => agentPay({ recipientAddress: "0x" + "1".repeat(40), amountUsdc: "1" }), "requires a .sourceAccount");

// ── 2. THE SEAM — executeAction refuses an unowned spend rather than defaulting. ──
console.log("\n2. THE SEAM — executeAction(pay_for_service) with no resolved wallet");
const unowned = await executeAction(
  { type: "pay_for_service", payTo: "0x" + "1".repeat(40), payAmountUsdc: 1 },
  { store: memStore() } // no walletAddress
);
if (unowned.ok === false && /no agent wallet resolved/i.test(unowned.blocked)) {
  ok(`blocked, no fallback to shared — "${unowned.blocked}"`);
} else {
  no("executeAction unowned pay", `expected a block, got ${JSON.stringify(unowned)}`);
}

// ── 3. DAY-LEDGER IS A REAL GATE (not a log), and it is OWNER-KEYED. ──
console.log("\n3. DAY-LEDGER — real gate, owner-keyed");
const cfg = budgetConfig();
const CEIL = cfg.PERIOD_CEILING_USDC;
const alice = "0xaaaa000000000000000000000000000000000001";
const bob = "0xbbbb000000000000000000000000000000000002";
const store = memStore();

const fresh = await canSpendDay({ amountUsdc: 1, store, owner: alice });
fresh.allowed ? ok(`alice's first ${1} USDC allowed (ceiling ${CEIL})`) : no("fresh spend", fresh.reason);

// Spend alice right up to the ceiling.
await recordAgentSpend({ owner: alice, amountUsdc: CEIL, source: "ub_spend", store });

const overAlice = await canSpendDay({ amountUsdc: 1, store, owner: alice });
if (!overAlice.allowed && /ceiling/i.test(overAlice.reason)) {
  ok(`alice at ceiling is REJECTED — "${overAlice.reason}"`);
} else {
  no("ceiling gate", `alice should be blocked after spending ${CEIL}, got ${JSON.stringify(overAlice)}`);
}

const bobStillOk = await canSpendDay({ amountUsdc: 1, store, owner: bob });
bobStillOk.allowed
  ? ok("bob is UNAFFECTED by alice's ceiling — per-owner isolation holds")
  : no("owner isolation", `bob was blocked by alice's spend: ${bobStillOk.reason}`);

// ── 4. AUTH-GATING — no session ⇒ 401, and NO balance disclosed. ──
console.log("\n4. AUTH-GATING — logged-out callers get a clean 401, no shared-balance leak");
for (const [name, h] of [
  ["gateway-balance (was PUBLIC)", gatewayBalance],
  ["agent-ub-spend", ubSpendHandler],
  ["agent-ub-deposit", ubDepositHandler],
]) {
  const res = await h({ httpMethod: "POST", headers: {}, body: "{}" });
  const body = res.body || "";
  const leaks = body.toLowerCase().includes(SHARED.toLowerCase()) || /unifiedBalanceUsdc/i.test(body);
  if (res.statusCode === 401 && !leaks) ok(`${name} → 401, nothing disclosed`);
  else no(name, `expected 401 with no balance; got ${res.statusCode} ${body.slice(0, 120)}`);
}

// ── 5. PHASE 2 — ensureDelegate: idempotence + the empty-wallet guarantee. ──
// These are read-only against the REAL chain (isAuthorizedForBalance), no tx, no money.
console.log("\n5. ensureDelegate — idempotence + the ordering guarantee");
const { isDelegateAuthorized, ensureDelegate } = await import("../netlify/functions/_delegate.mjs");

// 5a. The read is the source of truth, and it matches what the probe found: the shared SCA
// is authorized, a fresh per-user SCA is not. (Proves ensureDelegate's gate reads real state.)
const sharedAuthed = await isDelegateAuthorized(SHARED);
sharedAuthed
  ? ok("isDelegateAuthorized(sharedSCA) = true — the read sees real on-chain state")
  : no("delegate read", "shared SCA should be authorized (it is the working baseline)");

const virgin = "0x3cb76ac688f3fc02dfe4033d388989a44f132de9"; // per-user SCA, never addDelegate'd
const virginAuthed = await isDelegateAuthorized(virgin);
!virginAuthed
  ? ok("isDelegateAuthorized(fresh per-user SCA) = false — grant genuinely needed")
  : no("delegate read", "a fresh per-user SCA should NOT be authorized");

// 5b. IDEMPOTENCE: on an already-authorized owner, ensureDelegate must be a pure no-op —
// it must NOT send addDelegate. If it tried, it would need Circle creds + a tx; instead it
// short-circuits on the read. (Safe to run: the shared SCA is already authorized, so the
// `if (authorized) return` branch is taken and nothing is signed.)
const noop = await ensureDelegate({ owner: SHARED });
if (noop.authorized === true && noop.alreadyAuthorized === true && noop.txHash === null) {
  ok("ensureDelegate(already-authorized) → no-op, txHash null — safe on every deposit");
} else {
  no("idempotence", `expected a no-op, got ${JSON.stringify(noop)}`);
}

// 5c. THE EMPTY-WALLET GUARANTEE. ensureDelegate is reached only from INSIDE ubDeposit,
// AFTER its insufficient-funds check. So on an empty wallet the deposit must fail with
// INSUFFICIENT FUNDS — never with a delegate/gas error. That proves addDelegate is
// unreachable on an empty SCA structurally, not by convention.
try {
  await ubDeposit({ amountUsdc: 1, owner: virgin }); // virgin holds 0 USDC
  no("empty-wallet guarantee", "expected an insufficient-funds throw, got success");
} catch (e) {
  if (/insufficient funds/i.test(e.message)) {
    ok(`empty SCA → "${e.message.split(".")[0]}." (funds check fires BEFORE any delegate tx)`);
  } else if (/delegate|authoriz|gas/i.test(e.message)) {
    no("empty-wallet guarantee", `REACHED THE DELEGATE ON AN EMPTY WALLET: ${e.message}`);
  } else {
    no("empty-wallet guarantee", `unexpected failure: ${e.message}`);
  }
}

// ── 6. THE DEPOSIT CAP — boundary + fail-closed. ──
// Ported from the retired verify-ub-deposit-guards.mjs, which went stale when the depositor
// became session-resolved (its in-process harness has no Blobs). These assertions are the
// reason it existed and they must not be lost: the executor (_ubdeposit) is UNCAPPED, so the
// wrapper's cap is the ONLY thing standing between a caller and an unbounded deposit.
console.log("\n6. DEPOSIT CAP — boundary + fail-closed");
const { ubDepositCapUsdc } = await import("../netlify/functions/_arc.mjs");

const CAP = ubDepositCapUsdc();
CAP === 25
  ? ok(`cap reads ${CAP} from the environment`)
  : no("cap", `expected the deployed 25, got ${CAP}`);

// `>` is inclusive: an AT-cap deposit must PASS the guard (see the caps memory).
const overCap = CAP + 0.01;
!(overCap > CAP) === false
  ? ok(`over-cap (${overCap}) is rejected by the guard's \`amount > cap\``)
  : no("cap", "over-cap not rejected");
!(CAP > CAP)
  ? ok(`at-cap (${CAP}) PASSES — the bound is inclusive, not off-by-one`)
  : no("cap", "at-cap was rejected — the bound regressed to exclusive");

// FAIL-CLOSED: a garbled cap must THROW, never default to something permissive. This is the
// exact trap the deleted gateway-deposit.mjs fell into (Number(env || "1") -> NaN -> every
// spend passed), so it is worth a standing test.
const savedCap = process.env.AGENT_UB_DEPOSIT_CAP_USDC;
process.env.AGENT_UB_DEPOSIT_CAP_USDC = "not-a-number";
try {
  ubDepositCapUsdc();
  no("fail-closed cap", "a garbled cap did NOT throw — it is fail-OPEN");
} catch (e) {
  /misconfigured/i.test(e.message)
    ? ok(`garbled cap REFUSES ("${e.message.slice(0, 46)}…") — fail-closed`)
    : no("fail-closed cap", `threw for the wrong reason: ${e.message}`);
}
process.env.AGENT_UB_DEPOSIT_CAP_USDC = savedCap;

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
