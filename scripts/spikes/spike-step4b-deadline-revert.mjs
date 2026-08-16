// spike-step4b-deadline-revert.mjs — STEP 4, PART B: the ON-CHAIN DEADLINE BACKSTOP.
//
// ═══ ⚠️ SPENDS GAS. THE PRINCIPAL MUST NOT MOVE — THAT IS THE ASSERTION. ═══
// Runs ~11 minutes (a real 630s wait). Requires --confirm; a bare run prints the plan and exits.
//
// WHAT IT PROVES — the 4-link chain the whole DCA confirm design leans on:
//   (1) an expired deadline makes the AdapterContract REVERT (not silently no-op, not half-execute)
//   (2) the revert undoes transferFrom → the principal never leaves
//   (3) Circle reports the tx as FAILED            ← the sneaky link
//   (4) FAILED → waitForTx throws (_circle.mjs:58) → executeAction's ledger() (_actions.mjs:260,
//       reached only after `await agentSwap` at :253) NEVER runs → no phantom day-ceiling charge and,
//       in dca-tick, no phantom spentAmount/recordDcaSpend.
//
// ═══ MECHANISM — ⚠️ DELIBERATE DEVIATION FROM THE BANKED SCOPE. READ THIS. ═══
// The scope said "backward-skew Date so the guard passes on an expired quote". That does NOT work
// here, for two reasons found while writing it:
//   (a) agentSwap fetches its OWN quote inside the call (_swap.mjs:213), so at guard time the quote is
//       always FRESH. Skewing the clock backward would let a VALID quote through — the chain would
//       accept it and we would move 1 USDC for real. The opposite of the test.
//   (b) mock.timers FREEZES time (it only advances when ticked). waitForTx loops on
//       `while (Date.now() < giveUpAt)` (_circle.mjs:51-54); under a frozen clock that loop's timeout
//       can never fire, and there is no clean moment mid-agentSwap to un-skew.
// So the delay is injected at the SUBMIT BOUNDARY instead: `createContractExecutionTransaction` is
// wrapped so the SWAP submit (discriminated by `callData`; the approve is untouched) sleeps 630s in
// REAL time before calling through to the real Circle SDK. The quote is fetched, the guard passes
// HONESTLY on a fresh quote, and by the time the tx is broadcast its deadline has genuinely passed.
// PAYLOAD IS NEVER TOUCHED (editing the signature-covered deadline would revert on SIGNATURE
// verification — a wrong-reason revert that reads as a pass). Everything else is real: real allowance
// read, real approve, real quote, real guard, real calldata, real submit, real waitForTx.
// BONUS: because the guard passes honestly, this also shows the guard alone is NOT sufficient — a tx
// legal at build time can still expire before it mines. That is exactly why the backstop must exist.
//
// ═══ ARC-SPECIFIC CORRECTION TO THE SCOPE: "USDC Δ0" IS THE WRONG ASSERTION ═══
// On Arc, USDC IS the native gas token (eth_getBalance ÷1e18 == balanceOf ÷1e6 — the same asset in two
// views). So gas REDUCES the USDC balanceOf. A correct run therefore shows USDC DOWN BY GAS. The clean
// witness that no swap occurred is **EURC Δ EXACTLY 0**, plus a USDC drop bounded to gas and nowhere
// near the 1.00 principal. Asserting a literal USDC Δ0 would have failed a passing run.
//
// EXPECTED SIDE EFFECTS (both intended, both reported):
//   • The APPROVE fires for real (SCA allowance ~0 after step-3 Part B) — real tx, real gas.
//   • ⚠️ THE APPROVE SURVIVES THE REVERT. Approve and swap are separate txs, so a reverted swap leaves
//     a ~1 USDC STANDING ALLOWANCE to the adapter. Bounded (one fill, ≤ cap) and consistent with the
//     Design-2 posture, but "a deadline-revert leaves zero residue" is FALSE. Optional: --revoke
//     appends an approve(adapter, 0) (costs gas).
//
// HONEST BANNER (step-2 lesson): every verdict below is computed from balances/receipts read back off
// the chain via dd/rpc. Nothing is asserted from the --confirm flag or from the SDK's say-so.
//
// RUN — ⚠️ NOT through an agent's shell: the 630s sleep exceeds a 600s tool ceiling. Your terminal:
//   read -rs KIT_KEY && export KIT_KEY   # paste at the prompt — never in argv or history
//     node --experimental-test-module-mocks --env-file=.env \
//       scripts/spikes/spike-step4b-deadline-revert.mjs --confirm
//   optional: --delay-sec=NNN (default 630)   --revoke (clean up the standing allowance afterwards)

process.env.PERIOD_CEILING_USDC ||= "60";
import { mock } from "node:test";
import { toFunctionSelector, decodeAbiParameters } from "viem";

const CONFIRM = process.argv.includes("--confirm");
const REVOKE = process.argv.includes("--revoke");
const DELAY_SEC = Number((process.argv.find((a) => a.startsWith("--delay-sec=")) || "").split("=")[1] || 630);
const WALLET = (process.env.WALLET_ADDRESS || "0x6fb28d6366e755e0e27307692282490c6682fc58").toLowerCase();
const SWAP_ADAPTER = "0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b";
const QUOTE_TTL_SEC = 600;        // step-4 phase 0
const GAS_BOUND_USDC = 0.5;       // a swap+approve on Arc costs far less; anything above this is not "gas"
const AMOUNT = "1.00";

if (!CONFIRM) {
  console.log(`\n⚠️  DRY RUN — nothing submitted. Part B costs GAS and takes ~${Math.ceil((DELAY_SEC + 60) / 60)} min.\n`);
  console.log(`  plan: approve(adapter, ${AMOUNT} USDC) [real] → createSwap quote [real] → guard passes on a FRESH quote`);
  console.log(`        → wait ${DELAY_SEC}s REAL time (quote TTL is ${QUOTE_TTL_SEC}s, so it genuinely expires)`);
  console.log(`        → submit the now-expired swap → expect on-chain REVERT → Circle FAILED → waitForTx throws → NO ledger.`);
  console.log(`  witnesses: dd/rpc balances (EURC Δ must be EXACTLY 0), receipt status, eth_call revert-reason decode, daySpend Δ0.`);
  console.log(`  re-run with --confirm to execute. Run it in YOUR terminal — the ${DELAY_SEC}s sleep exceeds an agent tool ceiling.\n`);
  process.exit(0);
}
if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET || !process.env.KIT_KEY) {
  console.error("Part B needs CIRCLE_API_KEY+CIRCLE_ENTITY_SECRET (.env) and KIT_KEY (prod env).");
  process.exit(2);
}
if (DELAY_SEC <= QUOTE_TTL_SEC) {
  console.error(`✖ --delay-sec=${DELAY_SEC} does not exceed the ${QUOTE_TTL_SEC}s quote TTL — the quote would still be VALID and the swap would EXECUTE FOR REAL. Refusing.`);
  process.exit(2);
}

// ── in-memory @netlify/blobs (budget/pause only; no real Blobs state touched) ──
const stores = {};
let etagSeq = 0;
const memStore = (name) => {
  const nm = typeof name === "string" ? name : name?.name ?? "default";
  const m = (stores[nm] ??= new Map());
  return {
    async get(k, opts) { const e = m.get(k); if (e == null) return null; return opts?.type === "json" ? e.value : JSON.stringify(e.value); },
    async getJSON(k) { return m.get(k)?.value ?? null; },
    async setJSON(k, v, opts) {
      const cur = m.get(k);
      if (opts?.onlyIfNew && cur) return { modified: false };
      if (opts?.onlyIfMatch && cur?.etag !== opts.onlyIfMatch) return { modified: false };
      const etag = `e${++etagSeq}`; m.set(k, { value: v, etag }); return { modified: true, etag };
    },
    async getWithMetadata(k) { const e = m.get(k); return e ? { data: e.value, etag: e.etag } : null; },
    async list(opts) { const p = opts?.prefix ?? ""; return { blobs: [...m.keys()].filter((x) => x.startsWith(p)).map((key) => ({ key })) }; },
  };
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: memStore } });

// ── the ONLY money-path mock: delay the SWAP submit (see header). Real client, real everything else. ──
const realCircleMod = await import("../../netlify/functions/_circle.mjs"); // imported BEFORE the mock → stays real for our own post-mortem queries
const events = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function realSleepWithProgress(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const left = Math.ceil((end - Date.now()) / 1000);
    console.log(`     … holding the built swap ${left}s more (quote expires ${QUOTE_TTL_SEC}s after it was issued)`);
    await sleep(Math.min(60_000, Math.max(1_000, end - Date.now())));
  }
}
function wrapClient(client) {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop !== "createContractExecutionTransaction") {
        return typeof value === "function" ? value.bind(target) : value; // bind: SDK clients use private state
      }
      return async (args) => {
        const isSwap = !!args?.callData;
        if (isSwap) {
          events.push({ kind: "swap-intent", to: String(args.contractAddress || "").toLowerCase(), callData: args.callData, at: Date.now() });
          console.log(`\n  ⏳ swap calldata built and addressed to ${args.contractAddress} — holding ${DELAY_SEC}s so its deadline passes…`);
          await realSleepWithProgress(DELAY_SEC * 1000);
          console.log(`  ▶ submitting the now-EXPIRED swap (payload untouched — only time has passed)\n`);
        }
        const res = await target.createContractExecutionTransaction(args);
        events.push({ kind: isSwap ? "swap" : "approve", id: res?.data?.id, at: Date.now() });
        return res;
      };
    },
  });
}
mock.module("../../netlify/functions/_circle.mjs", { namedExports: { ...realCircleMod, circle: () => wrapClient(realCircleMod.circle()) } });

// imports AFTER the mocks
const { executeAction } = await import("../../netlify/functions/_actions.mjs");
const { daySpend } = await import("../../netlify/functions/_budget.mjs");
const { CONTRACTS, USDC_DECIMALS, ARC } = await import("../../netlify/functions/_arc.mjs");
const { rpcCall, assertChain } = await import("../dd/rpc.mjs");
const { getChain } = await import("../dd/chains.mjs");

const chain = getChain("arc-testnet");
const rpc = (m, p) => rpcCall({ endpoint: chain.rpc, method: m, params: p }).then((r) => r.result);
const pad = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const tokenBal = async (t) => Number(BigInt(await rpc("eth_call", [{ to: t, data: "0x70a08231" + pad(WALLET) }, "latest"]))) / 10 ** USDC_DECIMALS;
const nativeBal = async () => Number(BigInt(await rpc("eth_getBalance", [WALLET, "latest"]))) / 1e18; // Arc native is 18-dp (see memory note)
const allowanceNow = async () => Number(BigInt(await rpc("eth_call", [{ to: CONTRACTS.USDC, data: "0xdd62ed3e" + pad(WALLET) + pad(SWAP_ADAPTER) }, "latest"]))) / 10 ** USDC_DECIMALS;

// dd/rpc.mjs:69 throws on a JSON-RPC error and DISCARDS error.data — which is exactly the revert payload
// we need. So the revert-reason probe uses a raw call that keeps the error object intact.
async function rawRpc(method, params) {
  const r = await fetch(chain.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return r.json();
}
const ERROR_STRING_SELECTOR = "0x08c379a0";
const CANDIDATES = {
  // If the selector matches one of these, the revert is attributable TO THE DEADLINE.
  deadline: ["DeadlineExpired()", "Expired()", "SwapExpired()", "DeadlinePassed()", "TransactionExpired()", "DeadlineExceeded()", "ExpiredDeadline()", "SignatureExpired()"],
  // If it matches one of THESE instead, the revert is real but for the WRONG REASON → false pass.
  otherReason: ["InvalidSignature()", "InsufficientAllowance()", "TransferFromFailed()", "SlippageExceeded()", "InsufficientOutputAmount()", "AlreadyExecuted()", "InvalidExecId()"],
};
const SELECTORS = Object.fromEntries(Object.entries(CANDIDATES).map(([k, sigs]) => [k, Object.fromEntries(sigs.map((s) => [toFunctionSelector(s), s]))]));
function decodeRevert(hex) {
  if (!hex || hex === "0x") return { kind: "empty", label: "no revert data (bare revert / OOG) — reason NOT attributable" };
  if (hex.startsWith(ERROR_STRING_SELECTOR)) {
    try { return { kind: "string", label: `Error("${decodeAbiParameters([{ type: "string" }], `0x${hex.slice(10)}`)[0]}")` }; }
    catch { return { kind: "string", label: `Error(string) — undecodable payload ${hex.slice(0, 42)}…` }; }
  }
  const sel = hex.slice(0, 10);
  if (SELECTORS.deadline[sel]) return { kind: "deadline", label: `custom error ${SELECTORS.deadline[sel]} (${sel})` };
  if (SELECTORS.otherReason[sel]) return { kind: "otherReason", label: `custom error ${SELECTORS.otherReason[sel]} (${sel}) ← NOT the deadline` };
  return { kind: "unknown", label: `unrecognized custom error selector ${sel} — reason INCONCLUSIVE (not in the candidate table)` };
}

let fails = 0, stops = [];
const check = (name, cond, detail = "") => { console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); if (!cond) fails++; };
const STOP = (msg) => { stops.push(msg); console.log(`  🛑 ${msg}`); };
const swapStep = () => ({ type: "swap_tokens", tokenIn: "USDC", tokenOut: "EURC", amountIn: AMOUNT, reasoning: "step4B deadline revert test" });

console.log(`\n════ STEP 4 · PART B · on-chain deadline backstop · ⚠️ GAS ONLY (principal must NOT move) ════\n`);
await assertChain(chain); // never read state from an endpoint we haven't proven is Arc testnet

const dayBefore = await daySpend({ owner: WALLET });
const usdcB = await tokenBal(CONTRACTS.USDC), eurcB = await tokenBal(CONTRACTS.EURC), natB = await nativeBal(), allowB = await allowanceNow();
console.log(`  before: daySpend=${dayBefore}   USDC ${usdcB.toFixed(6)}   EURC ${eurcB.toFixed(6)}   native ${natB.toFixed(6)}   allowance→adapter ${allowB.toFixed(6)}`);
console.log(`  plan:   swap ${AMOUNT} USDC→EURC, confirmSwap:true, submit delayed ${DELAY_SEC}s past a ${QUOTE_TTL_SEC}s quote TTL\n`);

const t0 = Date.now();
let threw = null, result = null;
try { result = await executeAction(swapStep(), { walletAddress: WALLET, confirmSwap: true }); }
catch (e) { threw = e; }
const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

const dayAfter = await daySpend({ owner: WALLET });
const usdcA = await tokenBal(CONTRACTS.USDC), eurcA = await tokenBal(CONTRACTS.EURC), natA = await nativeBal(), allowA = await allowanceNow();
const usdcDrop = Number((usdcB - usdcA).toFixed(6));
const eurcGain = Number((eurcA - eurcB).toFixed(6));
const natDrop = Number((natB - natA).toFixed(6));
const ledgerDelta = Number((dayAfter - dayBefore).toFixed(6));

const swapEvent = events.find((e) => e.kind === "swap");
const intentEvent = events.find((e) => e.kind === "swap-intent");
const approveEvent = events.find((e) => e.kind === "approve");

console.log(`\n  after (${elapsed}s): USDC ${usdcA.toFixed(6)} (−${usdcDrop})   EURC ${eurcA.toFixed(6)} (+${eurcGain})   native ${natA.toFixed(6)} (−${natDrop})   allowance ${allowA.toFixed(6)}`);
console.log(`  approve id: ${approveEvent?.id ?? "none (allowance already covered it)"}   ·   swap id: ${swapEvent?.id ?? "NONE — never accepted by Circle"}`);
console.log(`  executeAction: ${threw ? `THREW ${threw.name}: ${threw.message.split("\n")[0]}` : `returned ok=${result?.ok}`}\n`);

// ── INTERROGATE FIRST, CLASSIFY SECOND ─────────────────────────────────────────────────
// ⚠️ Classification is by **txHash**, not by whether Circle accepted the submit. OBSERVED 2026-07-21:
// Circle ISSUED AN ID and then asynchronously marked the tx FAILED / "ESTIMATION_ERROR" — never
// broadcasting it. An earlier version of this file discriminated on "the SDK threw at submit", which
// that outcome does not do, so it fell through to the on-chain branch and reported three ❌ for
// artifacts (gas, receipt, revert data) that cannot exist when nothing was broadcast. A tx either
// exists on-chain or it does not; that is the only honest discriminator.
const client = realCircleMod.circle(); // the REAL client (captured pre-mock)
let state = null, txHash = null, errorReason = null;
if (swapEvent?.id) {
  try {
    const { data } = await client.getTransaction({ id: swapEvent.id });
    state = data?.transaction?.state; txHash = data?.transaction?.txHash;
    errorReason = data?.transaction?.errorReason || data?.transaction?.errorDetails || null;
  } catch (e) { console.log(`  (getTransaction failed: ${e.message})`); }
}
let receipt = null;
if (txHash) { try { receipt = await rpc("eth_getTransactionReceipt", [txHash]); } catch (e) { console.log(`  (receipt read failed: ${e.message})`); } }

// CONTRACT-LEVEL PROBE — deliberately INDEPENDENT of broadcast. eth_call replays the SAME calldata from
// the SAME sender at latest: a pure read, no gas, no Circle. This is the same class of simulation
// Circle's estimation runs, so it stays meaningful even when nothing was broadcast — in the
// estimation-rejected class it is the ONLY remaining evidence about the CONTRACT's own behaviour.
// The approve survived, so the allowance is standing: an allowance-shaped revert here would be a
// genuine wrong-reason signal, not an artifact of missing approval.
let revert = { kind: "not-probed", label: "not probed" };
if (intentEvent?.callData) {
  const probe = await rawRpc("eth_call", [{ from: WALLET, to: SWAP_ADAPTER, data: intentEvent.callData }, "latest"]);
  const data = probe?.error?.data?.data ?? probe?.error?.data ?? null;
  revert = probe?.error
    ? { ...decodeRevert(typeof data === "string" ? data : null), rpcMessage: probe.error.message }
    : { kind: "no-revert", label: `eth_call did NOT revert at latest (returned ${String(probe?.result).slice(0, 20)}…)` };
}
const revertIsDeadline = revert.kind === "deadline" || (revert.kind === "string" && /deadline|expir/i.test(revert.label));

console.log(`  Circle state: ${state ?? "unknown"}${errorReason ? ` (${JSON.stringify(errorReason).slice(0, 160)})` : ""}`);
console.log(`  tx: ${txHash ? `${ARC.explorer}/tx/${txHash}` : "NO HASH — never broadcast"}   receipt status: ${receipt?.status ?? "n/a"}   gasUsed: ${receipt?.gasUsed ?? "n/a"}`);
console.log(`  contract probe (eth_call replay @latest, no gas): ${revert.label}${revert.rpcMessage ? `  ·  rpc: "${String(revert.rpcMessage).slice(0, 120)}"` : ""}\n`);

const BROADCAST = !!txHash;
const na = (name, why) => console.log(`  ⃠  N/A · ${name} — ${why}`);

// ── OUTCOME CLASS ──────────────────────────────────────────────────────────────────────
if (eurcGain > 0) {
  // The swap actually executed despite an expired deadline.
  console.log(`════ 🛑 STOP — THE DEADLINE IS ADVISORY ════`);
  STOP(`The swap EXECUTED on an expired deadline: EURC +${eurcGain}, USDC −${usdcDrop}. The AdapterContract does NOT enforce executionParams.deadline.`);
  STOP(`This falsifies the load-bearing assumption. The pre-submit guard (_swap.mjs:229-232) is then the ONLY protection, not a backstop, and the comment at _swap.mjs:225-228 is WRONG.`);
  STOP(`Nothing was lost (a swap happened at market), but STOP the re-prove and rethink the deadline posture before commit.`);
  process.exit(1);
}

if (!BROADCAST) {
  // ═══ ESTIMATION-REJECTED — a DISTINCT, SAFETY-EQUIVALENT OUTCOME CLASS. NOT A FAILURE. ═══
  // Circle refused it before broadcast (synchronously, or by issuing an id and then marking it FAILED
  // with ESTIMATION_ERROR). The SAFETY chain is fully exercised; the CONTRACT's own enforcement is not.
  console.log(`════ PART B — ESTIMATION-REJECTED (safety-equivalent; the on-chain path was never reached) ════`);
  console.log(`  Circle rejected the expired swap BEFORE broadcast${errorReason ? ` — ${JSON.stringify(errorReason).slice(0, 120)}` : ""}. No tx exists, so no gas, no receipt, no revert data.\n`);

  // These four ARE the safety chain, and they are all fully testable without a broadcast.
  check("LINK 2 · principal did NOT move: EURC Δ EXACTLY 0", eurcGain === 0, `EURC Δ${eurcGain}`);
  check("LINK 2 · USDC drop bounded (approve gas at most — no principal, no swap gas)", usdcDrop < GAS_BOUND_USDC, `USDC −${usdcDrop} (native −${natDrop})`);
  check("LINK 3 · Circle reports the transaction as FAILED", state === "FAILED" || (!swapEvent && !!threw), `state=${state ?? "never accepted"}`);
  check("LINK 4 · executeAction threw → ledger() never ran (no phantom day-ceiling charge)", !!threw && result === null && ledgerDelta === 0, `threw ${threw?.name ?? "nothing"}, daySpend ${dayBefore} → ${dayAfter}`);
  check("LINK 4 · routed to the FAILURE taxonomy, NOT the id-reconcile net", threw?.name !== "SwapPendingConfirm", `threw ${threw?.name ?? "nothing"}`);

  // These are NOT failures — they are unreachable in this class. Reporting them as ❌ would read as a
  // safety failure, which is precisely backwards (per the step-2 honest-banner lesson).
  console.log("");
  na("LINK 1 · receipt status 0x0", "no tx was broadcast — there is no receipt to read");
  na("LINK 1 · gas burned on a reverted swap", "no swap tx existed to burn gas");
  na("LINK 2 · balanceOf-vs-native gas cross-check", "no swap gas was spent, so there is nothing to cross-check");

  // The one piece of contract-level evidence that survives without a broadcast.
  console.log(`\n  CONTRACT-LEVEL EVIDENCE (simulation only, no tx): ${revert.label}`);
  if (revertIsDeadline) {
    console.log(`  → the adapter DOES reject this calldata under simulation, for the deadline. That is strong`);
    console.log(`    evidence for LINK 1 — and it is the same class of simulation Circle's estimation runs —`);
    console.log(`    but it is NOT a mined-transaction proof. Rigorous attribution needs the differential`);
    console.log(`    control (same calldata simulated BEFORE expiry → succeeds; AFTER → reverts).`);
  } else {
    console.log(`  → NOT deadline-attributable. LINK 1 remains genuinely unproven at the contract level.`);
  }

  console.log(`\n════ VERDICT — PART B · ESTIMATION-REJECTED ════`);
  if (fails === 0) {
    console.log(`⚠️  SAFE, BUT NOT THE PROOF WE CAME FOR — this is a PASS of the safety chain, not a FAILURE:`);
    console.log(`    • no funds moved (EURC Δ0), no phantom ledger (daySpend Δ0), failure taxonomy correct.`);
    console.log(`    • Circle's estimation is a THIRD guard, in front of the contract — depth increased, nothing regressed.`);
    console.log(`    ✋ LINK 1 (does the AdapterContract ITSELF revert on an expired deadline?) was NOT exercised on-chain.`);
    console.log(`       Do NOT record step 4 as an on-chain contract proof. See the note for whether that matters.`);
  } else {
    console.log(`❌ FAIL — ${fails} SAFETY assertion(s) failed above. These are real: they do not depend on a broadcast.`);
  }
  console.log(`   standing allowance to adapter: ${allowA.toFixed(6)} USDC${REVOKE ? " (revoking below)" : " — the approve survives; use --revoke to clear"}`);
  process.exit(fails === 0 ? 0 : 1);
}

// ── ASSERTIONS ─────────────────────────────────────────────────────────────────────────
// LINK 2 — the decisive fund witness. EURC arriving would mean the swap happened; nothing else is as clean.
check("LINK 2 · principal did NOT move: EURC Δ EXACTLY 0 (no swap output ever arrived)", eurcGain === 0, `EURC Δ${eurcGain}`);
check("LINK 2 · USDC drop is GAS ONLY, not the 1.00 principal (on Arc, gas IS USDC)", usdcDrop > 0 && usdcDrop < GAS_BOUND_USDC, `USDC −${usdcDrop} vs principal ${AMOUNT}`);
check("LINK 2 · cross-check: the two views of the same asset agree (balanceOf drop ≈ native drop)", Math.abs(usdcDrop - natDrop) < 0.01, `balanceOf −${usdcDrop} vs native −${natDrop}`);

// LINK 1 — did the contract itself reject it? Two valid envelopes; report which was observed.
const directRevert = receipt?.status === "0x0";
const aaEnvelope = receipt?.status === "0x1" && eurcGain === 0;
check("LINK 1 · the transaction did not succeed as a swap (receipt status 0x0, or a 0x1 AA envelope with no movement)", directRevert || aaEnvelope, `status=${receipt?.status ?? "n/a"} → ${directRevert ? "DIRECT REVERT" : aaEnvelope ? "0x1 outer tx, no funds moved → account-abstraction envelope swallowed the inner revert" : "unclassified"}`);
if (aaEnvelope) console.log(`     ⚠️ 0x1 outer status: the ERC-4337 entrypoint reports success while the inner call reverted. Links 1–2 still hold (nothing moved), but the receipt alone is NOT the evidence — the eth_call replay below is.`);
check("LINK 1 · ATTRIBUTION: the revert is the DEADLINE, not some other failure", revertIsDeadline, revert.label);
if (revert.kind === "otherReason") STOP(`Reverted for a DIFFERENT reason (${revert.label}) — this is a FALSE PASS, not evidence about the deadline. Re-scope before recording anything.`);
if (revert.kind === "unknown" || revert.kind === "empty") console.log(`     ⚠️ attribution INCONCLUSIVE: the tx did not execute the swap, but this run does not prove WHY. Do not record it as deadline-proven.`);

// LINK 3 — the sneaky one.
check("LINK 3 · Circle reports the transaction as FAILED", state === "FAILED", `state=${state}`);
if (state === "COMPLETE") STOP(`Circle reported COMPLETE on a transaction that moved nothing. waitForTx would return a hash and _actions.mjs:260 ledger() WOULD fire → PHANTOM CHARGE. This is the Drill #1 failure class. STOP.`);

// LINK 4 — the whole point: no phantom accounting.
check("LINK 4 · waitForTx threw → executeAction never returned ok", !!threw && result === null, threw ? `threw ${threw.name}: ${threw.message.split("\n")[0]}` : `returned ok=${result?.ok}`);
check("LINK 4 · day-ceiling ledger did NOT advance (no phantom charge)", ledgerDelta === 0, `daySpend ${dayBefore} → ${dayAfter} (Δ${ledgerDelta})`);
check("LINK 4 · routed to the FAILURE taxonomy, NOT the id-reconcile net", threw?.name !== "SwapPendingConfirm", `threw ${threw?.name ?? "nothing"}`);
if (threw?.name === "SwapPendingConfirm") STOP(`A permanent deadline-revert was handed to the id-reconcile net, which would poll a tx that can never succeed. Wrong taxonomy — fix before commit.`);

// Documented residue.
console.log(`\n  residue: standing allowance to adapter = ${allowA.toFixed(6)} USDC (was ${allowB.toFixed(6)}). The approve SURVIVED the revert — separate tx, not rolled back.`);
if (REVOKE) {
  try {
    const rv = await realCircleMod.circle().createContractExecutionTransaction({
      walletAddress: WALLET, blockchain: ARC.blockchain, contractAddress: CONTRACTS.USDC,
      abiFunctionSignature: "approve(address,uint256)", abiParameters: [SWAP_ADAPTER, "0"],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    await realCircleMod.waitForTx(realCircleMod.circle(), rv.data?.id);
    console.log(`  ✅ revoked — allowance now ${(await allowanceNow()).toFixed(6)} USDC (cost: one more gas payment)`);
  } catch (e) { console.log(`  ⚠️ revoke failed (${e.message}) — the standing allowance remains; clear it manually if you care.`); }
}

console.log(`\n════ VERDICT — PART B ════`);
if (fails === 0 && stops.length === 0) {
  console.log(`✅ PART B PASS — all four links proven in execution:`);
  console.log(`   expired deadline → contract rejected it → principal never moved (EURC Δ0, USDC down by gas only)`);
  console.log(`   → Circle FAILED → waitForTx threw → ledger() never ran (daySpend Δ0), routed as a FAILURE not a pending confirm.`);
  console.log(`   The on-chain backstop under _swap.mjs's deadline guard is REAL. Step 4 complete → id-reconcile net (step 5).`);
} else {
  console.log(`❌ PART B ${stops.length ? "STOP" : "FAIL"} — ${fails} failed assertion(s), ${stops.length} stop condition(s).`);
  stops.forEach((s) => console.log(`   🛑 ${s}`));
  console.log(`   Re-read the chain before re-running: ${txHash ? `${ARC.explorer}/tx/${txHash}` : "no tx hash"}`);
}
console.log(`\n  (verdict computed from balances, receipts and Circle state read back after the fact — never from the --confirm flag.)`);
process.exit(fails === 0 && stops.length === 0 ? 0 : 1);
