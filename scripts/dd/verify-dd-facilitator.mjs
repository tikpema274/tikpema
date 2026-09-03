// verify-dd-facilitator.mjs — acceptance for the DD facilitator layer (netlify/functions/_dd-x402.mjs).
//
// ⭐ WHAT THIS SUITE IS ACTUALLY FOR. settle-gate.mjs already proves "charge for answers, not
// outages" as a PREDICATE. This proves the same rule survives contact with a facilitator, a balance
// read, and a blob store — the three things that were deliberately absent when the predicate was
// built. The interesting cases are all about the ORDER of irreversible acts:
//
//   · does the engine run before anything touches money?
//   · is the authorization provably UNSPENT when we say "not charged"?
//   · is a possible-broadcast reported as UNKNOWN rather than as "not charged"?
//   · is the artifact withheld until the chain agrees, and then served UNCHANGED?
//
//   node scripts/dd/verify-dd-facilitator.mjs     # zero network, zero money, zero real facilitator
//
// The facilitator, the RPC and the store are all FAKES that record what was asked of them. Nothing
// here can move funds; that is a property of the module's shape (everything is injected), not of the
// test being careful.

import { readFileSync } from "node:fs";
import { analyze } from "../../shared/onchain-analyze/index.mjs";
import { attachAttestation, unsignedAttestation } from "../../shared/onchain-analyze/attest.mjs";
import { POWER_SIGS, sel, EIP1967_IMPL_SLOT } from "../../shared/onchain-facts/index.mjs";
import {
  resolvePayTo,
  PAYTO_REASON,
  ddPaymentRequirements,
  challenge402,
  runPaidAnalysis,
  retrievePaid,
  makeSettler,
  SettleAborted,
  SettleIndeterminate,
  ABORT_REASON,
  DD_PRICE_ATOMIC,
  DD_VERIFYING_CONTRACT,
  SETTLE_FATE,
  FATE_FIELD,
  classifySettleFate,
  SETTLE_FAILURE_CLAIM,
} from "../../netlify/functions/_dd-x402.mjs";

// ⭐ A REAL BUILD ID, because "unknown" is exactly the bug this suite failed to catch. The build
// binding used to fall back to the literal string "unknown" on BOTH the canary and the endpoint, so
// it compared equal to itself and the deploy gate silently became a no-op. Every suite here ran in
// ONE process with ONE env, where both sides are trivially identical — which is why none of them
// could ever have seen it. A binding is only testable across the thing it binds, so these now run
// with a resolvable id and the cross-build cases live in verify-build-binding.mjs.
process.env.DD_BUILD_ID = process.env.DD_BUILD_ID || "test-build-0000000000000000000000000000000000000000";


let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
const body = (r) => JSON.parse(r.body);

const SUBJ = "0x1111111111111111111111111111111111111111";
const OWNER = "0x3333333333333333333333333333333333333333";
const PAYTO = "0xb407967319d56218c7e1c369125490e665a16ac4";
const ZERO_WORD = "0x" + "0".repeat(64);
const word = (a) => "0x" + a.replace(/^0x/, "").padStart(64, "0");
const codeWith = (sigs) => "0x60806040" + sigs.map((s) => sel(s)).join("") + "00";
const allPowerSigs = Object.values(POWER_SIGS).flat();

function mockClient(handlers = {}) {
  return {
    chain: { name: "mock-chain" },
    assert: async () => 5042002,
    pin: async () => ({ number: 1000, tag: "0x3e8" }),
    async call({ method, params }) {
      const key =
        method === "eth_getCode" ? `code@${String(params[0]).toLowerCase()}`
        : method === "eth_getStorageAt" ? `slot@${String(params[1]).toLowerCase()}`
        : method === "eth_call" ? `call@${String(params[0]?.data)}`
        : method;
      const h = handlers[key];
      if (h === undefined) throw Object.assign(new Error(`mock: unhandled ${key}`), { transient: false });
      if (typeof h === "function") return h();
      return { result: h, query: { endpoint: "mock://", method, params, reproduce: `# mock ${key}` }, evidence: { httpStatus: 200 } };
    },
  };
}

/** A HEALTHY subject — full coverage, refusal null. This is the only fixture that should ever pay. */
const healthyClient = () => mockClient({
  [`code@${SUBJ}`]: codeWith(allPowerSigs),
  [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD,
  [`call@0x8da5cb5b`]: word(OWNER),
  [`code@${OWNER}`]: "0x",
});

/** An OUTAGE — the chain is unreachable, so the engine returns a refusal report. Must never pay. */
const outageClient = () => ({
  chain: { name: "mock-chain" },
  assert: async () => { throw Object.assign(new Error("chain unreachable"), { transient: true }); },
  pin: async () => { throw Object.assign(new Error("chain unreachable"), { transient: true }); },
  call: async () => { throw Object.assign(new Error("chain unreachable"), { transient: true }); },
});

// ── the fakes ─────────────────────────────────────────────────────────────────────────────────
function fakeStore(opts = {}) {
  const data = new Map();
  return {
    data,
    writes: 0,
    async setJSON(k, v) {
      if (opts.failWrites) throw new Error("blob store unavailable");
      this.writes++;
      data.set(k, JSON.parse(JSON.stringify(v)));
    },
    async get(k) {
      if (opts.failReads) throw new Error("blob store unreadable");
      return data.get(k) ?? null;
    },
  };
}

function fakeFacilitator({ valid = true, settleResult = { success: true, transaction: "0xabc", payer: "0xpayer", network: "arc" }, verifyThrows = false, settleThrows = false, log } = {}) {
  return {
    async verify() {
      log?.push("VERIFY");
      if (verifyThrows) throw new Error("facilitator unreachable");
      return { isValid: valid, invalidReason: valid ? null : "insufficient-balance" };
    },
    async settle() {
      log?.push("SETTLE");
      if (settleThrows) throw new Error("settle transport blew up");
      return settleResult;
    },
  };
}

/** A Gateway balance read we fully control. `null` models an unreadable balance, never a zero one. */
function fakeRpc({ balances = [], log } = {}) {
  let i = 0;
  return async () => {
    log?.push("BASELINE");
    const v = balances[Math.min(i, balances.length - 1)];
    i++;
    if (v === null) throw new Error("rpc throttled");
    return "0x" + BigInt(v).toString(16);
  };
}

// ⭐ settleDecision requires a VERIFIABLE SIGNED attestation, so a chargeable fixture must carry one.
// The signer is a FAKE — no key, no Circle call, nothing real is signed. It exists so the paid path
// can be exercised offline; the real signature's validity is verify-attestation.mjs's job.
const signFixture = (report) => attachAttestation(report, {
  sign: async () => "0x" + "ab".repeat(65),
  agentId: "851891",
  verifyingContract: "0xc54D47211997aCA90Ef4fCfBc742a3b511B4e621",
  registry: "0x8004A8180E2Cb8B1D4Cb0eB0Cd5b0b8bA0Ee0000",
  chainId: "5042002",
});
/** A healthy, SIGNED report — the only fixture that should ever result in a charge. */
const payableReport = async () => signFixture(await analyze(SUBJ, { client: healthyClient() }));

const REQS = ddPaymentRequirements({ resource: "https://x/api/dd-analyze", payTo: PAYTO });

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  DD FACILITATOR — the ordering of irreversible acts                  ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═══════════ 1 — payTo resolution: fail closed, and NEVER guess ═══════════
section("1 — resolvePayTo: no fallback, ever");
{
  check("unset → refuses", resolvePayTo({}).ok === false && resolvePayTo({}).reason === PAYTO_REASON.UNSET);
  check("empty string → refuses", resolvePayTo({ DD_PAYTO_ADDRESS: "   " }).ok === false);
  check("malformed → refuses", resolvePayTo({ DD_PAYTO_ADDRESS: "not-an-address" }).reason === PAYTO_REASON.MALFORMED);
  check("truncated hex → refuses", resolvePayTo({ DD_PAYTO_ADDRESS: "0xb407967319d5" }).ok === false);

  // ⭐ THE ONE THAT MATTERS. SELLER_ADDRESS is x402-quote's payTo and is sitting in the same env.
  // Falling back to it would "work" while permanently destroying the zero-history property that
  // makes aggregate reconciliation attributable at all.
  const r = resolvePayTo({ SELLER_ADDRESS: "0xc70112c700000000000000000000000000000000" });
  check("⭐⭐ SELLER_ADDRESS present but DD_PAYTO unset → STILL refuses (no fallback)", r.ok === false && r.payTo === null, r.reason);
  check("  …and says why guessing would be wrong", /destroy|attributab/i.test(r.detail));
  check("  …and says it does NOT downgrade to free", /free/i.test(r.detail));

  const good = resolvePayTo({ DD_PAYTO_ADDRESS: "0xB407967319D56218C7E1C369125490E665A16AC4" });
  check("valid → ok and lowercased", good.ok === true && good.payTo === PAYTO, good.payTo);
}

// ═══════════ 2 — the 402 challenge ═══════════
section("2 — 402 challenge: quote the honest product");
{
  const r = challenge402({ requirements: REQS });
  const b = body(r);
  check("status 402", r.statusCode === 402);
  check("PAYMENT-REQUIRED header decodes to the requirements", (() => {
    const d = JSON.parse(Buffer.from(r.headers["PAYMENT-REQUIRED"], "base64").toString("utf8"));
    return d.accepts?.[0]?.maxAmountRequired === DD_PRICE_ATOMIC;
  })());
  check("price is $0.06 = 60000 atomic", REQS.maxAmountRequired === "60000", REQS.maxAmountRequired);
  check("payTo is bound into the requirements", REQS.payTo === PAYTO);
  check("resource binds the signature to this endpoint", REQS.resource === "https://x/api/dd-analyze");
  check("verifyingContract is the Gateway Wallet", REQS.extra.verifyingContract === DD_VERIFYING_CONTRACT);
  check("⭐ quotes coverage as a MANIFEST, not a clean bill", /not a clean bill/i.test(b.whatYouAreBuying.coverage));
  check("⭐ says an outage is NOT charged", /not charged|unspent/i.test(b.whatYouAreBuying.notCharged));
  check("⭐⭐ discloses AGGREGATE-ONLY attribution up front", /AGGREGATE-ONLY/.test(b.settlement.attribution));
  check("  …and does not promise per-payment attribution", !/per-payment attribution is|proves this payment/i.test(b.settlement.attribution));
}

// ═══════════ 3 — verification precedes the engine ═══════════
section("3 — an unverifiable payment never reaches the engine");
{
  for (const [label, fac] of [
    ["invalid authorization", fakeFacilitator({ valid: false })],
    ["facilitator unreachable", fakeFacilitator({ verifyThrows: true })],
  ]) {
    let ran = 0;
    const r = await runPaidAnalysis({
      facilitator: fac, rpcCall: fakeRpc({ balances: [0] }), store: fakeStore(),
      payload: {}, requirements: REQS, resource: "https://x/api/dd-analyze",
      produceReport: async () => { ran++; return payableReport(); },
    });
    check(`${label} → 402`, r.statusCode === 402);
    check(`  ⭐ the engine NEVER RAN (no free work for garbage input)`, ran === 0, `ran=${ran}`);
  }
}

// ═══════════ 4 — OUTAGE: the report is free and nothing is broadcast ═══════════
section("4 — engine outage → free report, settle never invoked");
{
  const log = [];
  const store = fakeStore();
  const r = await runPaidAnalysis({
    facilitator: fakeFacilitator({ log }), rpcCall: fakeRpc({ balances: [0], log }), store,
    payload: {}, requirements: REQS, resource: "https://x/api/dd-analyze",
    produceReport: async () => await analyze(SUBJ, { client: outageClient() }),
  });
  const b = body(r);
  check("status 200 (they get the report)", r.statusCode === 200);
  check("charged: false", b.charged === false);
  check("retryable: true", b.retryable === true);
  check("⭐⭐ facilitator.settle was NEVER invoked", !log.includes("SETTLE"), `log=[${log}]`);
  check("⭐ no baseline was even read (nothing money-adjacent happened)", !log.includes("BASELINE"), `log=[${log}]`);
  check("⭐ nothing was persisted", store.writes === 0, `writes=${store.writes}`);
  check("tells the caller the authorization is unspent", /unspent/i.test(b.payment));
  check("promises no deferred settlement", /none will be attempted later/i.test(b.payment));
}

// ═══════════ 4b — ⭐ SIGNER OUTAGE: a complete report, but not the one we quoted ═══════════
// The subtlest no-charge case, and the one most likely to be "fixed" by someone who reads it as a
// bug. The engine SUCCEEDED — full coverage, refusal null, every fact present. Only the signature is
// missing, because attachAttestation degrades instead of failing. Charging here would deliver a
// complete report against a price quoted for a SIGNED one: selling X and handing over not-X.
section("4b — signer outage → complete report, still free");
{
  const log = [];
  const store = fakeStore();
  const r = await runPaidAnalysis({
    facilitator: fakeFacilitator({ log }), rpcCall: fakeRpc({ balances: [1000], log }), store,
    payload: {}, requirements: REQS, resource: "https://x/api/dd-analyze",
    produceReport: async () => ({
      ...(await analyze(SUBJ, { client: healthyClient() })),
      attestation: unsignedAttestation("the signer was unavailable on this run"),
    }),
  });
  const b = body(r);
  check("status 200", r.statusCode === 200);
  check("⭐ the report is COMPLETE — this is not an engine failure", b.report?.coverage?.totals?.notChecked === 0,
    `notChecked=${b.report?.coverage?.totals?.notChecked}`);
  check("  …and the engine did not refuse", b.report?.refusal === null);
  check("⭐⭐ but it does NOT settle", b.charged === false, `reason=${b.reason}`);
  check("  …for the right reason", b.reason === "unsigned-attestation", b.reason);
  check("⭐⭐ facilitator.settle was NEVER invoked", !log.includes("SETTLE"), `log=[${log}]`);
  check("⭐ no baseline read, nothing persisted", !log.includes("BASELINE") && store.writes === 0);
  check("  …authorization explicitly unspent", /unspent/i.test(b.payment));
  check("  …and no silent keep-the-money later", /none will be attempted later/i.test(b.payment));
  check("⭐ the caller still GETS the report, free", b.report?.subject?.address === SUBJ);
  check("  …and can tell it is unsigned", b.report?.attestation?.status === "unsigned");
}

// ═══════════ 5 — ANSWER: the happy path, and the order of acts ═══════════
section("5 — engine answers → analyze, THEN baseline, THEN persist, THEN settle");
{
  const log = [];
  const store = fakeStore();
  const origSet = store.setJSON.bind(store);
  store.setJSON = async (k, v) => { log.push("PERSIST"); return origSet(k, v); };

  const r = await runPaidAnalysis({
    facilitator: fakeFacilitator({ log }), rpcCall: fakeRpc({ balances: [1000], log }), store,
    payload: {}, requirements: REQS, resource: "https://x/api/dd-analyze",
    produceReport: async () => { log.push("ANALYZE"); return payableReport(); },
  });
  const b = body(r);

  check("status 202 (accepted, NOT served)", r.statusCode === 202);
  // ⚠️ Asserted as RELATIVE order, not absolute indices. The first version pinned ANALYZE to index 0
  // and failed — because VERIFY legitimately precedes it, and there is a trailing PERSIST that writes
  // the settlement receipt back. Both are correct behaviour the test had simply not accounted for.
  // An index-pinned assertion tests the log's shape; the relative one tests the property that matters.
  const at = (x) => log.indexOf(x);
  check("⭐ verification comes before the engine runs", at("VERIFY") < at("ANALYZE"), `log=[${log}]`);
  check("⭐⭐ order is ANALYZE → BASELINE → PERSIST → SETTLE",
    at("ANALYZE") < at("BASELINE") && at("BASELINE") < at("PERSIST") && at("PERSIST") < at("SETTLE"),
    `log=[${log}]`);
  check("⭐⭐ the ENGINE RAN BEFORE ANYTHING TOUCHED MONEY", at("ANALYZE") < at("SETTLE"), `log=[${log}]`);
  check("settle invoked exactly once", log.filter((x) => x === "SETTLE").length === 1);
  check("a handle was issued", typeof b.handle === "string" && b.handle.length > 10);
  check("X-PAYMENT-HANDLE header carries it", r.headers["X-PAYMENT-HANDLE"] === b.handle);

  // ⛔ THE CENTRAL ASSERTION OF THE WHOLE SHAPE.
  check("⭐⭐⭐ the 202 body contains NO REPORT", b.report === undefined, Object.keys(b).join(","));
  check("  …and says acceptance is not payment", /NOT yet witnessed|not a receipt/i.test(b.payment.meaning));
  check("  …and discloses aggregate-only attribution", /AGGREGATE-ONLY/.test(b.payment.attribution));
  check("  …and states the entitlement is permanent", /PERMANENT/.test(b.entitlement));
  check("⭐ the FROZEN report was stored with the handle", store.data.get(b.handle)?.report?.subject?.address === SUBJ);
  check("  …with the pre-settle baseline", store.data.get(b.handle)?.baseline === "1000");
  check("  …marked accepted", store.data.get(b.handle)?.broadcast === "accepted");
}

// ═══════════ 6 — ⭐ BASELINE UNREADABLE: refuse to take money we could never confirm ═══════════
section("6 — unreadable baseline → nothing is broadcast");
{
  const log = [];
  const store = fakeStore();
  const r = await runPaidAnalysis({
    facilitator: fakeFacilitator({ log }), rpcCall: fakeRpc({ balances: [null], log }), store,
    payload: {}, requirements: REQS, resource: "https://x/api/dd-analyze",
    produceReport: payableReport,
  });
  const b = body(r);
  check("status 503", r.statusCode === 503);
  check("reason is baseline-unreadable", b.reason === ABORT_REASON.BASELINE_UNREADABLE, b.reason);
  check("⭐⭐ facilitator.settle was NEVER called", !log.includes("SETTLE"), `log=[${log}]`);
  check("⭐ nothing was persisted (no orphan handle)", store.writes === 0, `writes=${store.writes}`);
  check("charged: false, and provably so", b.charged === false && /unspent/i.test(b.payment));
  check("retryable", b.retryable === true);
}

// ═══════════ 7 — ⭐ PERSIST FAILS: abort before broadcast ═══════════
section("7 — pending record unwritable → abort BEFORE broadcast");
{
  const log = [];
  const r = await runPaidAnalysis({
    facilitator: fakeFacilitator({ log }), rpcCall: fakeRpc({ balances: [1000], log }), store: fakeStore({ failWrites: true }),
    payload: {}, requirements: REQS, resource: "https://x/api/dd-analyze",
    produceReport: payableReport,
  });
  const b = body(r);
  check("status 503", r.statusCode === 503);
  check("reason is pending-record-not-written", b.reason === ABORT_REASON.PERSIST_FAILED, b.reason);
  check("⭐⭐ settle NEVER called — a payment with no redeemable handle is worse than no payment",
    !log.includes("SETTLE"), `log=[${log}]`);
  check("authorization stated unspent", /unspent/i.test(b.payment));
}

// ═══════════ 8 — ⭐⭐ SETTLE THROWS: 'we do not know' must NOT read as 'not charged' ═══════════
section("8 — settle throws after submission → INDETERMINATE, with a handle");
{
  const store = fakeStore();
  const r = await runPaidAnalysis({
    facilitator: fakeFacilitator({ settleThrows: true }), rpcCall: fakeRpc({ balances: [1000] }), store,
    payload: {}, requirements: REQS, resource: "https://x/api/dd-analyze",
    produceReport: payableReport,
  });
  const b = body(r);
  check("status 502", r.statusCode === 502);
  check("⭐⭐ charged is NULL, not false — we genuinely do not know", b.charged === null, JSON.stringify(b.charged));
  check("  …and settled is NULL too", b.settled === null);
  check("⭐ explicitly denies being a 'you were not charged' statement", /not a statement that you were not charged/i.test(b.detail));
  check("⭐⭐ a handle SURVIVES the failure (persist-before-broadcast)", typeof b.handle === "string" && b.handle.length > 10);
  check("  …and the frozen report is behind it", store.data.get(b.handle)?.report?.subject?.address === SUBJ);
  check("  …and the record is marked indeterminate", store.data.get(b.handle)?.broadcast === "indeterminate");
  check("entitlement is permanent", /PERMANENT/.test(b.entitlement));
}

// ═══════════ 9 — settle rejects cleanly ═══════════
section("9 — settle returns success:false → 402, nothing served");
{
  const store = fakeStore();
  const r = await runPaidAnalysis({
    facilitator: fakeFacilitator({ settleResult: { success: false, errorReason: "insufficient-gateway-balance" } }),
    rpcCall: fakeRpc({ balances: [1000] }), store,
    payload: {}, requirements: REQS, resource: "https://x/api/dd-analyze",
    produceReport: payableReport,
  });
  const b = body(r);
  check("status 402", r.statusCode === 402);
  check("carries the facilitator's reason", b.reason === "insufficient-gateway-balance", b.reason);
  check("⭐ no report is served", b.report === undefined);
  check("re-challenges with the requirements", Array.isArray(b.accepts) && b.accepts[0].payTo === PAYTO);

  // ═══ 🚨 THE CLAIM ABOUT THE CALLER'S MONEY ═══════════════════════════════════════════════════
  // This branch used to say "Your authorization was not spent." — an unhedged absence claim about an
  // external agent's money, derived from the facilitator's report of its own failure. A settlement
  // can fail AFTER an authorization is consumed, the producer is a third party, and the buyer is an
  // agent with no other source of truth. These assertions are on the RENDERED BODY, not the source.
  // ⚠️ THE DENIAL CONTAINS THE PHRASE IT DENIES. A flat forbidden-phrase scan goes red on the
  // CORRECT copy — "this is NOT a statement that you were not charged" contains "were not charged".
  // So the denial clauses are removed FIRST and the assertion is made on what remains. Caught on the
  // first run of this check, against the fixed copy.
  const denialsStripped = JSON.stringify(b).replace(/NOT a statement that[^.\"]*/gi, "");
  check("⛔ it does NOT claim the authorization was unspent",
    !/was not spent|were not charged|remains unspent|nothing was spent/i.test(denialsStripped),
    denialsStripped.slice(0, 300));
  check("⭐⭐ …and it explicitly DENIES being such a statement, the way retrievePaid's " +
    "unreadable-store branch does",
    /NOT a statement that you were not charged/i.test(b.detail || ""), b.detail);
  check("⭐ it names the fate as UNKNOWN in words, not only in a code",
    /UNKNOWN/.test(b.detail || ""), b.detail);
  check("⭐ the typed fate travels beside the prose",
    b.authorizationFate === SETTLE_FATE.UNKNOWN, b.authorizationFate);

  // ⭐ BILLING AND SERVICE ARE SEPARATE CLAIMS — the :324 rule. One field may say "not served"; a
  // DIFFERENT one must carry the money claim, or an agent reads the refusal as a refund.
  check("⭐ the service claim says the report is not served", /NOT served/.test(b.detail || ""), b.detail);
  check("⭐⭐ …and the BILLING claim is a separate field that refuses to say zero",
    typeof b.billing === "string" && /UNKNOWN/.test(b.billing) && /not the same as zero/i.test(b.billing),
    b.billing);
  check("⭐ it names the misreading an agent would act on — reusing vs re-signing the authorization",
    /same authorization/i.test(b.billing || "") && /paying twice/i.test(b.billing || ""), b.billing);
  check("⛔ it emits no number it cannot back — no amount, no probability, no ETA",
    !/\b\d+(\.\d+)?\s*(USDC|%|min|minutes|seconds)\b/i.test(
      `${b.detail} ${b.billing} ${b.whatToDo}`),
    `${b.detail} ${b.billing} ${b.whatToDo}`);

  // ⭐⭐ THE HEDGE MUST BE RESOLVABLE. Telling an agent "we cannot tell" and handing it no way to
  // find out is half an answer — and the handle already existed, persisted BEFORE the broadcast.
  check("⭐⭐ the handle SURVIVES a rejected settlement (it used to be dropped)",
    typeof b.handle === "string" && b.handle.length > 10, String(b.handle));
  check("  …and the frozen report is behind it", store.data.get(b.handle)?.report?.subject?.address === SUBJ);
  check("  …and the record is marked rejected", store.data.get(b.handle)?.broadcast === "rejected");
  check("  …and a retrieve URL is given for it",
    typeof b.retrieve === "string" && b.retrieve.includes(b.handle), String(b.retrieve));
  check("⭐ the entitlement is permanent — a late-landing payment is still redeemable",
    /PERMANENT/.test(b.entitlement || ""), b.entitlement);
  check("  …and whatToDo points at that handle rather than at a retry",
    /Poll `retrieve`/.test(b.whatToDo || ""), b.whatToDo);
}

// ═══════════ 9b — ⭐⭐ THE CLAIM IS BOUND TO THE FIELD THAT WOULD LICENSE IT ═══════════
section("9b — the copy is licensed by a field, and fails when the field starts distinguishing");
{
  // ── the classifier, over the shapes the real SDK can actually produce ────────────────────────
  check("⭐ a bare rejection is UNKNOWN — the shape Circle returns today",
    classifySettleFate({ success: false, errorReason: "insufficient-gateway-balance" }) === SETTLE_FATE.UNKNOWN);
  check("⛔ a rejection carrying a transaction id is STILL UNKNOWN — `transaction` licenses nothing",
    classifySettleFate({ success: false, transaction: "0xabc", network: "eip155:5042002" }) === SETTLE_FATE.UNKNOWN);
  check("⛔ …and so is a null/absent settlement — an absence is not an answer",
    classifySettleFate(null) === SETTLE_FATE.UNKNOWN && classifySettleFate(undefined) === SETTLE_FATE.UNKNOWN);
  check("⛔ a TRUTHY NON-BOOLEAN does not become 'consumed' by coercion",
    classifySettleFate({ success: false, [FATE_FIELD]: "yes" }) === SETTLE_FATE.UNKNOWN,
    "a string in the fate field was coerced");
  check("⭐ only a real boolean discriminates — false → NOT_CONSUMED",
    classifySettleFate({ success: false, [FATE_FIELD]: false }) === SETTLE_FATE.NOT_CONSUMED);
  check("⭐ …and true → CONSUMED. The pairwise inequality: the classifier is not a constant",
    classifySettleFate({ success: false, [FATE_FIELD]: true }) === SETTLE_FATE.CONSUMED);

  // ── the claim map is total, and only the licensed entries make a definite statement ──────────
  const fates = Object.values(SETTLE_FATE);
  check("every fate has a claim — a hole would render `undefined` as the answer",
    fates.every((f) => SETTLE_FAILURE_CLAIM[f] && typeof SETTLE_FAILURE_CLAIM[f].detail === "string"),
    fates.filter((f) => !SETTLE_FAILURE_CLAIM[f]).join(","));
  check("⛔ ONLY the UNKNOWN claim is allowed to be uncertain, and ONLY the licensed ones definite",
    /NOT a statement that you were not charged/.test(SETTLE_FAILURE_CLAIM[SETTLE_FATE.UNKNOWN].detail) &&
    /nothing was spent/i.test(SETTLE_FAILURE_CLAIM[SETTLE_FATE.NOT_CONSUMED].detail) &&
    /is spent/i.test(SETTLE_FAILURE_CLAIM[SETTLE_FATE.CONSUMED].detail));

  // ═══ ⭐⭐⭐ THE BINDING ITSELF — READ FROM THE VENDOR'S OWN TYPE, NOT FROM OUR MEMORY OF IT ═══
  // The hedged copy is only correct while Circle's SettleResponse genuinely cannot say what happened
  // to the authorization. If a future version ships that field, the honest copy becomes an
  // UNDERSTATEMENT and this must go red rather than sit green on a stale reading of the contract.
  // ⚠️ AND AN UNREADABLE TYPE IS A FAILURE, NEVER A PASS: if the file moves, we have stopped
  // checking, and "we stopped checking" must not look like "the field is still absent".
  const TYPES = "node_modules/@circle-fin/x402-batching/dist/server/index.d.ts";
  let vendor = null, vendorErr = null;
  try { vendor = readFileSync(TYPES, "utf8"); } catch (e) { vendorErr = String(e?.message ?? e); }
  check("⭐ the vendored SettleResponse type is READABLE — unreadable is a failure, not a pass",
    typeof vendor === "string" && vendor.length > 0, `${TYPES} — ${vendorErr}`);

  const iface = vendor ? /interface SettleResponse \{([\s\S]*?)\}/.exec(vendor)?.[1] ?? null : null;
  check("⭐ …and the SettleResponse interface is actually found in it — a missed match would make " +
    "every assertion below vacuous",
    typeof iface === "string" && iface.includes("success"), String(iface).slice(0, 120));

  if (iface) {
    const fieldNames = [...iface.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]).sort();
    check(`⭐ the fields are exactly what the copy assumes — [${fieldNames.join(", ")}]`,
      fieldNames.join(",") === "errorReason,network,payer,success,transaction", fieldNames.join(","));
    check("⭐⭐⭐ THE LICENCE: the vendor type carries NO field stating the authorization's fate. " +
      "If this goes red, Circle now tells us — revisit SETTLE_FAILURE_CLAIM before shipping.",
      !new RegExp(`\\b${FATE_FIELD}\\b`).test(iface) && !/\bconsumed\b|\bspent\b|\bnonceUsed\b/i.test(iface),
      iface.trim().replace(/\s+/g, " "));
    check("⛔ …and `errorReason` is still an OPTIONAL free-form string — not an enum we could branch on",
      /errorReason\?:\s*string;/.test(iface), iface.trim().replace(/\s+/g, " "));
  }
}

// ═══════════ 10 — RETRIEVE: the artifact is withheld until the chain agrees ═══════════
section("10 — retrieve: withheld while pending, served on confirmation");
{
  // Set up a real pending record via the paid path, then drive retrieval against it.
  const store = fakeStore();
  const paid = await runPaidAnalysis({
    facilitator: fakeFacilitator(), rpcCall: fakeRpc({ balances: [1000] }), store,
    payload: {}, requirements: REQS, resource: "https://x/api/dd-analyze",
    produceReport: payableReport,
  });
  const handle = body(paid).handle;
  const frozen = JSON.stringify(store.data.get(handle).report);

  // unknown handle
  {
    const r = await retrievePaid({ handle: "nope", store, rpcCall: fakeRpc({ balances: [1000] }) });
    check("unknown handle → 404", r.statusCode === 404);
  }

  // store unreadable — NOT a statement that they did not pay
  {
    const r = await retrievePaid({ handle, store: fakeStore({ failReads: true }), rpcCall: fakeRpc({ balances: [1000] }) });
    check("⭐ unreadable store → 202, not 404", r.statusCode === 202);
    check("  …and explicitly not a denial of payment", /NOT a statement that you did not pay/i.test(body(r).detail));
    check("  …and serves no report", body(r).report === undefined);
  }

  // balance has NOT moved → pending
  {
    const r = await retrievePaid({ handle, store, rpcCall: fakeRpc({ balances: [1000] }) });
    const b = body(r);
    check("⭐⭐ balance unmoved → 202 PENDING, report WITHHELD", r.statusCode === 202 && b.report === undefined, b.status);
    check("  …evidence names the shortfall", b.evidence?.shortfall === "60000", b.evidence?.shortfall);
  }

  // balance UNREADABLE → indeterminate, still withheld
  {
    const r = await retrievePaid({ handle, store, rpcCall: fakeRpc({ balances: [null] }) });
    const b = body(r);
    check("⭐ unreadable balance → 202 indeterminate, report WITHHELD", r.statusCode === 202 && b.report === undefined, b.status);
    check("  …and is not reported as 'unpaid'", !/did not pay|unpaid/i.test(b.detail ?? ""));
  }

  // balance risen by LESS than the price → still pending (off-by-one guard)
  {
    const r = await retrievePaid({ handle, store, rpcCall: fakeRpc({ balances: [1000 + 59999] }) });
    check("⭐ one atomic unit short → still WITHHELD", r.statusCode === 202 && body(r).report === undefined);
  }

  // exact threshold → CONFIRMED
  {
    const r = await retrievePaid({ handle, store, rpcCall: fakeRpc({ balances: [1000 + 60000] }) });
    const b = body(r);
    check("⭐⭐ exact threshold → 200 SERVED", r.statusCode === 200 && b.served === true);
    check("⭐⭐⭐ the report served is BYTE-IDENTICAL to the one that was paid for",
      JSON.stringify(b.report) === frozen);
    check("  …the analysis was NOT re-run", b.report.subject.address === SUBJ);
    check("payment marked confirmed with evidence", b.payment.confirmed === true && b.payment.evidence.balanceNow === "61000");
    check("⭐ and STILL discloses aggregate-only attribution at the moment of serving",
      /AGGREGATE-ONLY/.test(b.payment.attribution) && /does not prove THIS payment/i.test(b.payment.attribution));
  }

  // re-retrieval is idempotent — an entitlement is not consumed by being used
  {
    const r = await retrievePaid({ handle, store, rpcCall: fakeRpc({ balances: [1000 + 60000] }) });
    check("⭐ re-retrieval still serves (entitlement is not consumed)", r.statusCode === 200 && body(r).served === true);
  }
}

// ═══════════ 11 — ⭐ the entitlement OUTLIVES the timeout ═══════════
section("11 — a late-confirming payment is still honoured");
{
  const store = fakeStore();
  const paid = await runPaidAnalysis({
    facilitator: fakeFacilitator(), rpcCall: fakeRpc({ balances: [1000] }), store,
    payload: {}, requirements: REQS, resource: "https://x/api/dd-analyze",
    produceReport: payableReport,
    now: () => 1_000_000,
  });
  const handle = body(paid).handle;

  // Long past RETRIEVE_TIMEOUT_MS (15 min), and still pending: advice expires, entitlement does not.
  const late = 1_000_000 + 60 * 60 * 1000;
  {
    const r = await retrievePaid({ handle, store, rpcCall: fakeRpc({ balances: [1000] }), now: () => late });
    const b = body(r);
    check("past the timeout while pending → still 202, never 'failed'", r.statusCode === 202);
    check("  …flagged timedOut for polling advice only", b.evidence?.timedOut === true);
    check("  …and the entitlement is still declared permanent", /PERMANENT/.test(b.entitlement));
  }
  {
    const r = await retrievePaid({ handle, store, rpcCall: fakeRpc({ balances: [61000] }), now: () => late });
    check("⭐⭐ confirming an HOUR late STILL serves 200", r.statusCode === 200 && body(r).served === true);
  }
}

// ═══════════ 12 — ⭐ confirmed but the artifact is gone: never a hollow 200 ═══════════
section("12 — confirmed payment, missing report → 202, not an empty 200");
{
  const store = fakeStore();
  const paid = await runPaidAnalysis({
    facilitator: fakeFacilitator(), rpcCall: fakeRpc({ balances: [1000] }), store,
    payload: {}, requirements: REQS, resource: "https://x/api/dd-analyze",
    produceReport: payableReport,
  });
  const handle = body(paid).handle;
  // Corrupt the stored artifact, leaving the payment record intact.
  const rec = store.data.get(handle);
  delete rec.report;
  store.data.set(handle, rec);

  const r = await retrievePaid({ handle, store, rpcCall: fakeRpc({ balances: [61000] }) });
  const b = body(r);
  check("⭐⭐ does NOT return a 200 with no report", r.statusCode !== 200, `status=${r.statusCode}`);
  check("returns 202 and says the payment stands", r.statusCode === 202 && /payment stands/i.test(b.detail));
  check("  …and names it as our failure, not theirs", /our failure/i.test(b.detail));
}

// ═══════════ 13 — the settler in isolation: throw classes are distinguishable ═══════════
section("13 — SettleAborted vs SettleIndeterminate are different types");
{
  const s1 = makeSettler({
    facilitator: fakeFacilitator(), rpcCall: fakeRpc({ balances: [null] }), store: fakeStore(),
    payload: {}, requirements: REQS,
  });
  let e1 = null;
  try { await s1({}); } catch (e) { e1 = e; }
  check("unreadable baseline throws SettleAborted", e1 instanceof SettleAborted, e1?.name);

  const s2 = makeSettler({
    facilitator: fakeFacilitator({ settleThrows: true }), rpcCall: fakeRpc({ balances: [0] }), store: fakeStore(),
    payload: {}, requirements: REQS,
  });
  let e2 = null;
  try { await s2({}); } catch (e) { e2 = e; }
  check("settle transport failure throws SettleIndeterminate", e2 instanceof SettleIndeterminate, e2?.name);
  check("⭐ they are NOT the same class (collapsing them would lie about the money)",
    !(e2 instanceof SettleAborted) && !(e1 instanceof SettleIndeterminate));
  check("  …and the indeterminate one carries a handle", typeof e2?.handle === "string");
}

// ═══════════ 14 — THE HANDLER LADDER: what is free, what is paid, and in what order ═══════════
// ⚠️ THIS SECTION EXISTS BECAUSE OF A NEAR-MISS. Sections 1-13 test _dd-x402.mjs in isolation, and
// they all passed while the handler wiring was entirely unexercised — because verify-endpoint.mjs's
// only healthy-path 200 assertion is behind `--live`. So the in-process suite could not have noticed
// if payment had been wired to the wrong rung. Module tests are not integration tests.
section("14 — handler ladder: free rungs stay free, paid rung is paid");
{
  process.env.DD_PUBLIC_ENABLED = "1";
  const { mock } = await import("node:test");
  const { SCHEMA_VERSION } = await import("../../shared/onchain-analyze/schema.mjs");
  const { codeIdentity } = await import("../../shared/dd-canary/health.mjs");
  const identity = codeIdentity({ schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS });
  mock.module("../../netlify/functions/_dd-health.mjs", {
    namedExports: {
      readHealth: async () => ({
        record: { verdict: "pass", producedAt: new Date().toISOString(), identity, fixtures: [] },
        readable: true,
      }),
      writeHealth: async () => true,
      DD_HEALTH_STORE: "mock",
      healthKey: () => "mock",
    },
  });
  const { handler } = await import("../../netlify/functions/dd-analyze.mjs");
  const post = (body, headers = {}) => handler({ httpMethod: "POST", body: JSON.stringify(body), headers });

  // ── the FREE rungs. These must stay free: charging for "that is not a well-formed question"
  //    quotes a price for something we answer for free, and rewards narrowing the supported set.
  delete process.env.DD_PAYTO_ADDRESS;
  {
    const r = await post({ address: "nonsense", chain: "arc-testnet" });
    check("⭐ malformed address → 400, FREE (no 402, no payTo needed)", r.statusCode === 400, String(r.statusCode));
    check("  …and it is a report, not an error envelope", body(r).refusal?.reason === "invalid-address");
  }
  {
    const r = await post({ address: SUBJ, chain: "base" });
    check("⭐ unsupported chain → 400, FREE", r.statusCode === 400 && body(r).refusal?.reason === "unsupported-chain");
  }
  {
    const r = await post({ address: SUBJ });
    check("⭐ missing chain → 400, FREE", r.statusCode === 400 && body(r).refusal?.reason === "chain-not-specified");
  }
  {
    const r = await handler({ httpMethod: "GET", body: "", headers: {} });
    check("wrong method → 405, FREE", r.statusCode === 405);
  }

  // ── payTo misconfigured: refuse, do NOT silently serve free.
  {
    const r = await post({ address: SUBJ, chain: "arc-testnet" });
    check("⭐⭐ valid request + DD_PAYTO_ADDRESS unset → 503, NOT a free 200",
      r.statusCode === 503 && body(r).refusal?.reason === "payment-misconfigured", `${r.statusCode}/${body(r).refusal?.reason}`);
  }

  // ── the PAID rung.
  process.env.DD_PAYTO_ADDRESS = PAYTO;
  {
    const r = await post({ address: SUBJ, chain: "arc-testnet" }, { host: "x.test" });
    const b = body(r);
    check("⭐⭐ valid request, no payment header → 402 (the service is PAID)", r.statusCode === 402, String(r.statusCode));
    check("  …PAYMENT-REQUIRED header is present", typeof r.headers["PAYMENT-REQUIRED"] === "string");
    check("  …quoting the dedicated revenue wallet", b.accepts[0].payTo === PAYTO, b.accepts[0].payTo);
    check("  …at 60000 atomic ($0.06)", b.accepts[0].maxAmountRequired === "60000");
    check("  …bound to this resource", /x\.test/.test(b.accepts[0].resource), b.accepts[0].resource);
    check("⭐ the engine did NOT run for an unpaid caller (no report in the 402)", b.report === undefined);
  }
  {
    const r = await post({ address: SUBJ, chain: "arc-testnet" }, { host: "x.test", "payment-signature": "!!!not-base64!!!" });
    check("malformed payment header → 400 report", r.statusCode === 400 && body(r).refusal?.reason === "malformed-payment", String(r.statusCode));
  }

  // ── ⭐ ORDER: the exposure gate still outranks everything, including a paid request.
  delete process.env.DD_PUBLIC_ENABLED;
  {
    const r = await post({ address: SUBJ, chain: "arc-testnet" }, { host: "x.test" });
    check("⭐⭐ exposure flag unset → 503 BEFORE any 402 (deploying ≠ publishing still holds)",
      r.statusCode === 503 && body(r).refusal?.reason === "service-not-enabled", `${r.statusCode}/${body(r).refusal?.reason}`);
  }
  {
    // A handle must not be redeemable while the service is unpublished either.
    const r = await handler({ httpMethod: "GET", body: "", headers: {}, queryStringParameters: { handle: "anything" } });
    check("⭐ retrieve is ALSO behind the exposure gate", r.statusCode === 503 && body(r).refusal?.reason === "service-not-enabled");
  }
  process.env.DD_PUBLIC_ENABLED = "1";
  delete process.env.DD_PAYTO_ADDRESS;
}

console.log(`\n${"═".repeat(72)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log("═".repeat(72));
process.exit(fail === 0 ? 0 : 1);
