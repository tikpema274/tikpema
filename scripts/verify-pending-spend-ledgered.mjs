// verify-pending-spend-ledgered.mjs — FINDING A: "WE STOPPED WAITING" IS NOT "NO MONEY MOVED".
//
//   node --experimental-test-module-mocks scripts/verify-pending-spend-ledgered.mjs   (npm run test:pendingspend)
//
// ═══ ZERO MONEY, ZERO NETWORK ═══ Blobs in-memory; circle(), waitForTx, the session, the wallet,
// the pause switch and the balance read are all scripted. Nothing is submitted anywhere.
//
// ═══ 🚨 THE DEFECT THIS PINS ═════════════════════════════════════════════════════════════════
// Every fund-moving path here ends at `waitForTx` (_circle.mjs, DEADLINE_MS = 60_000). A timeout
// raises TxPendingError. **That throw says the deadline passed. It says NOTHING about the chain.**
// agent-send.mjs used to hand `txId` to the CLIENT and ledger nothing — and it writes to no store,
// so the id left the server and the spend was never counted. A pending-then-landed send silently
// WIDENED the day ceiling, permanently, on a wired route. Same shape in `transfer_usdc`.
//
// It is the same claim `_dca.mjs:71` makes ("BUDGET INTACT — never a phantom fill"), which the
// chain refuted 3 for 3 on 2026-07-18/19 — and STRICTLY WEAKER, because DCA at least kept a claim
// with the circleId, so those fills could be resolved a month later. This kept nothing.
//
// ═══ ⭐ WHAT IS ASSERTED IS THE PROPERTY, NOT THE WORDING ═════════════════════════════════════
// Not "the file contains recordAgentSpend". These drive the real handler and then RE-READ the
// ledger: did the counter move, is the charge RESOLVABLE, and is a confirmed one untouchable.
import { mock } from "node:test";
import assert from "node:assert/strict";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

// ── in-memory blobs (one map per store name; cleared between cases) ───────────────────────────
const maps = [];
let etagSeq = 0;
const memStore = (name) => {
  const nm = typeof name === "string" ? name : name?.name ?? "default";
  let m = maps.find((x) => x._n === nm);
  if (!m) { m = new Map(); m._n = nm; maps.push(m); }
  return {
    async get(k, opts) { const e = m.get(k); if (e == null) return null; return opts?.type === "json" ? e.value : JSON.stringify(e.value); },
    async getJSON(k) { return m.get(k)?.value ?? null; },
    async setJSON(k, v, opts) {
      const cur = m.get(k);
      if (opts?.onlyIfNew && cur) return { modified: false };
      if (opts?.onlyIfMatch && cur?.etag !== opts.onlyIfMatch) return { modified: false };
      m.set(k, { value: v, etag: `e${++etagSeq}` }); return { modified: true };
    },
    async setIfNew(k, v) { if (m.has(k)) return false; m.set(k, { value: v, etag: `e${++etagSeq}` }); return true; },
    // ⚠️ _budget's defaultStore() builds getWithEtag/setIfMatch FROM these two. Mocking the derived
    // pair instead left the adapter calling an absent getWithMetadata → every read "UNREADABLE".
    async getWithMetadata(k) { const e = m.get(k); return e ? { data: e.value, etag: e.etag } : null; },
    async list(pfx) {
      const p = typeof pfx === "string" ? pfx : pfx?.prefix ?? "";
      const keys = [...m.keys()].filter((x) => x.startsWith(p));
      return typeof pfx === "string" ? keys : { blobs: keys.map((key) => ({ key })) };
    },
  };
};
const resetStores = () => { for (const m of maps) m.clear(); };
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: memStore } });

// ── the handler's collaborators, scripted ────────────────────────────────────────────────────
const OWNER = "0x6fb28d6366e755e0e27307692282490c6682fc58";
const WALLET = "0x058957deff333c47c15c208a4425420af6947f9e";
const TO = "0x" + "cd".repeat(20);
const TX_ID = "circle-tx-id-0001";

class TxPendingError extends Error {
  constructor(txId) { super(`still pending after 60s`); this.name = "TxPendingError"; this.txId = txId; }
}
let waitBehaviour = "confirm";           // "confirm" | "pending"
let ledgerShouldThrow = false;

mock.module("../netlify/functions/_circle.mjs", { namedExports: {
  TxPendingError,
  circle: () => ({ createContractExecutionTransaction: async () => ({ data: { id: TX_ID } }) }),
  waitForTx: async () => {
    if (waitBehaviour === "pending") throw new TxPendingError(TX_ID);
    return "0xdeadbeef";
  },
}});
mock.module("../netlify/functions/_auth.mjs", { namedExports: {
  requireSession: () => ({ address: OWNER }), requireInternal: () => true,
}});
mock.module("../netlify/functions/_agent-wallets.mjs", { namedExports: {
  ensureOwnerWallet: async () => ({ walletAddress: WALLET, pending: false }),
  isWalletUnresolvable: () => false,
  WALLET_PROVISIONING_STATUS: 503, walletProvisioningRefusal: () => ({}),
  WALLET_UNRESOLVABLE_STATUS: 503, walletUnresolvableRefusal: () => ({}),
}});
mock.module("../netlify/functions/_pause.mjs", { namedExports: { assertNotPaused: async () => null }});
mock.module("../netlify/functions/_predict.mjs", { namedExports: {
  publicClient: () => ({ readContract: async () => 999_000_000n }),   // plenty of balance
}});

const budget = await import("../netlify/functions/_budget.mjs");
const { handler } = await import("../netlify/functions/agent-send.mjs");

// A ledger that fails on demand, to exercise the swallow-but-shout path without patching the module.
const realRecord = budget.recordAgentSpend;

const send = async (amountUsdc = 5) =>
  handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ to: TO, amountUsdc }) });

const auditEntries = async () => {
  const s = memStore("data-budget");
  const keys = await s.list("audit:");
  const out = [];
  for (const k of keys) out.push(await s.getJSON(k));
  return out;
};

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  FINDING A — a pending spend is COUNTED and RECOVERABLE, not lost    ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — 🚨 THE PENDING BRANCH: the spend is COUNTED");
resetStores(); waitBehaviour = "pending";
{
  const res = await send(0.5);
  check("the caller still gets 202 pending — the contract is unchanged", res.statusCode === 202, `got ${res.statusCode}`);
  const body = JSON.parse(res.body);
  check("  …and still carries the txId", body.txId === TX_ID);

  const day = await budget.daySpend({ owner: WALLET });
  check("🚨🚨 THE DAY CEILING ADVANCED — this is the whole defect, and it is closed", day === 0.5, `daySpend=${day}`);

  const entries = await auditEntries();
  check("⭐ an audit entry exists at all", entries.length === 1, `${entries.length} entries`);
  check("⭐⭐ …marked confirmation:'submitted' — the audit asserts no more than was observed",
    entries[0]?.confirmation === "submitted", `confirmation=${entries[0]?.confirmation}`);
  check("⭐⭐ …and carries the AUTHORITATIVE circleId, without which it is unresolvable forever",
    entries[0]?.circleId === TX_ID, `circleId=${entries[0]?.circleId}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⭐⭐ AND IT IS RECOVERABLE — the property, not the field");
{
  const open = await budget.listUnresolvedCharges({ olderThanMs: 0 });
  check("🚨🚨 step 8 CAN SEE the charge — it is reversible if the send really failed",
    open.length === 1 && open[0].circleId === TX_ID, `${open.length} unresolved`);

  // The control that makes the above non-vacuous: reverse it and watch the counter come back.
  const rev = await budget.reverseAgentSpend({ entry: open[0], reason: "test: proven reversible" });
  check("⭐ …and reverseAgentSpend actually accepts it", rev.reversed === true, JSON.stringify(rev.refused ?? ""));
  const after = await budget.daySpend({ owner: WALLET });
  check("⭐ …returning the headroom, so an over-count is CORRECTABLE rather than permanent", after === 0, `daySpend=${after}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐ THE CONFIRMED BRANCH: counted, and UNREVERSIBLE by construction");
resetStores(); waitBehaviour = "confirm";
{
  const res = await send(0.3);
  check("a confirmed send returns 200", res.statusCode === 200, `got ${res.statusCode}`);
  const day = await budget.daySpend({ owner: WALLET });
  check("  …and is counted", day === 0.3, `daySpend=${day}`);

  const entries = await auditEntries();
  check("⭐⭐ it records confirmation:'confirmed' — an ABSENT value could not distinguish " +
    "'this caller does not know' from 'this caller never checked'",
    entries[0]?.confirmation === "confirmed", `confirmation=${entries[0]?.confirmation}`);

  const open = await budget.listUnresolvedCharges({ olderThanMs: 0 });
  check("🚨🚨 a CONFIRMED charge is invisible to the sweeper — a real spend can never be reversed",
    open.length === 0, `${open.length} unresolved`);
  const rev = await budget.reverseAgentSpend({ entry: entries[0], reason: "must be refused" });
  // ⚠️ ASSERTED ON THE CODE, NOT THE SENTENCE. This check used to read /confirmation/ off `refused`,
  // which made a copy edit able to turn it red for no reason — the mirror image of the defect
  // `verify-no-prose-state-recovery` exists to forbid. The prose is still printed as the detail.
  check("⭐ …and reverseAgentSpend REFUSES it even if handed the entry directly (GUARD 1)",
    rev.reversed === false && rev.refusal === budget.REVERSAL_REFUSAL.NOT_SUBMITTED,
    `refusal=${rev.refusal} refused=${rev.refused}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⚠️ THE PRECONDITION IN _budget.mjs IS CHECKED, NOT ASSUMED");
{
  const src = (await import("node:fs")).readFileSync("netlify/functions/agent-send.mjs", "utf8");
  check("⭐⭐ agent-send writes NO paired sub-ledger — so submit-time charging here does NOT trip " +
    "the atomic-pair precondition", !/recordDcaSpend/.test(src));
  const actions = (await import("node:fs")).readFileSync("netlify/functions/_actions.mjs", "utf8");
  // ⚠️ lastIndexOf, NOT indexOf. Both anchors appear TWICE: the first pair is the per-transaction
  // CAP CHECK (~line 168), the second is the EXECUTION branch. Slicing on the first pair read the
  // cap block, found no ledger call, and reported absence — a filtered read is not a measurement of
  // absence, and the slice bounds were part of the hypothesis.
  const txStart = actions.lastIndexOf('if (step.type === "transfer_usdc")');
  const txEnd = actions.lastIndexOf('if (step.type === "bridge_usdc")');
  const txBlock = actions.slice(txStart, txEnd);
  check("⭐ the slice really is the EXECUTION branch, not the cap check — else the checks below are vacuous",
    txStart < txEnd && /createContractExecutionTransaction/.test(txBlock) && /waitForTx/.test(txBlock),
    `${txEnd - txStart} chars`);
  check("⭐ transfer_usdc likewise writes no paired sub-ledger", !/recordDcaSpend/.test(txBlock));
  check("⭐⭐ …and it ledgers on its OWN pending branch rather than throwing past the ledger",
    /TxPendingError/.test(txBlock) && /confirmation: "submitted"/.test(txBlock));
  const budgetSrc = (await import("node:fs")).readFileSync("netlify/functions/_budget.mjs", "utf8");
  check("⚠️ the precondition still states the RULE generally, not narrowed to one caller",
    /THE RULE ABOVE IS GENERAL/.test(budgetSrc) && /PAIRED SUB-LEDGER/.test(budgetSrc));
  check("⭐ …and its list of submit-time chargers names agent-send, so the list is not stale",
    /agent-send\.mjs on the TxPendingError branch/.test(budgetSrc));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — 🚨 THE SCOPE TRAP THIS SUITE ACTUALLY CAUGHT");
{
  // The first version of the fix declared `doLedger` with `const` INSIDE the try and called it from
  // the catch. Block scoping made the pending branch throw ReferenceError — a 500, and STILL no
  // ledger: strictly worse than the bug being fixed, and invisible to any source-grep guard.
  const src = (await import("node:fs")).readFileSync("netlify/functions/agent-send.mjs", "utf8");
  const decl = src.indexOf("const doLedger");
  const tryAt = src.indexOf("\n  try {\n    const client = circle();");
  // ⚠️ THIS POSITIONAL CHECK IS A PROXY, AND A WEAK ONE — recorded rather than dressed up.
  // Wrapping the helper in a bare `{ }` block defeats the scope while leaving the POSITION intact,
  // so this assertion would still pass. Proven by mutation: the bare-block variant sails past this
  // line and is caught only by the behavioural check below (ReferenceError: doLedger is not defined,
  // exit 1). ⭐ The position is a readable hint; the DRIVEN HANDLER is the actual guard. Kept both,
  // with the weaker one labelled — an unlabelled proxy is how a guard comes to certify nothing.
  check("⭐ (proxy) the ledger helper is declared ABOVE the try — readable hint, not the guard",
    decl > 0 && tryAt > decl, `doLedger@${decl} try@${tryAt}`);
  resetStores(); waitBehaviour = "pending";
  const res = await send(0.25);
  check("⭐ …proven behaviourally: the pending path returns 202, not a ReferenceError 500",
    res.statusCode === 202, `got ${res.statusCode}`);
  check("  …and it ledgered on the way out", (await budget.daySpend({ owner: WALLET })) === 0.25);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — ⭐ A LEDGER FAILURE IS SWALLOWED BUT SHOUTED, NEVER SILENT");
{
  const src = (await import("node:fs")).readFileSync("netlify/functions/agent-send.mjs", "utf8");
  // ⚠️ COMMENTS STRIPPED — the first version of this check went red on the comment that QUOTES the
  // old silent form. The property is about code, not prose (same trap as the CREATE_GATED check).
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("🚨🚨 the silent `.catch(() => {})` is GONE from agent-send's CODE", !/\.catch\(\(\) => \{\}\)/.test(code));
  check("⭐ …replaced by the SHARED shoutLedgerFailure, not a second copy of it",
    /shoutLedgerFailure/.test(src) && !/function shoutLedgerFailure/.test(src));
  const actions = (await import("node:fs")).readFileSync("netlify/functions/_actions.mjs", "utf8");
  check("⭐⭐ _actions.mjs no longer DEFINES it — one definition, in _budget.mjs beside the ledger",
    !/function shoutLedgerFailure/.test(actions) && /shoutLedgerFailure/.test(actions));
  check("⭐ …and _budget.mjs exports it", /export function shoutLedgerFailure/.test(
    (await import("node:fs")).readFileSync("netlify/functions/_budget.mjs", "utf8")));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — ⭐⭐ IDEMPOTENT CHARGE (`chargeId`) — DRIVEN, NOT GREPPED");
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════════════════════
// 2026-08-22: dca-tick charges the day ceiling AT SUBMIT, and the reconcile charges the SAME fill
// again when it confirms. Without idempotency every slow fill is DOUBLE-COUNTED — which restricts
// rather than widens, but is still a wrong ceiling and would strand users below their real limit.
// ⭐ The mechanism mirrors `reversedIds`: membership test and arithmetic inside ONE CAS mutate, so
// there is no check-then-write window. These drive the real primitive and RE-READ the counter.
{
  const budget = await import("../netlify/functions/_budget.mjs");
  const OWNER = "0x" + "5a".repeat(20);
  const AT = Date.parse("2026-08-22T12:00:00.000Z");
  const spend = (amountUsdc, opts = {}) => budget.recordAgentSpend({
    owner: OWNER, amountUsdc, source: "swap_tokens", justification: "idempotency probe", at: AT, ...opts,
  });

  resetStores();
  const first = await spend(1.5, { confirmation: "submitted", circleId: "cid-A", chargeId: "cid-A" });
  const dayAfterFirst = await budget.daySpend({ owner: OWNER, at: AT });
  check("⭐ the submit-time charge advances the day counter", dayAfterFirst === 1.5, `day=${dayAfterFirst}`);
  check("⭐ …and reports it applied", first.applied === true);

  const second = await spend(1.5, { confirmation: "confirmed", circleId: "cid-A", chargeId: "cid-A" });
  const dayAfterSecond = await budget.daySpend({ owner: OWNER, at: AT });
  check("⭐⭐ the RECONCILE's re-charge of the same id is a NO-OP — the fill is not double-counted",
    dayAfterSecond === 1.5, `day=${dayAfterSecond} (would be 3 without idempotency)`);
  check("⭐⭐ …and it reports alreadyCharged rather than an error — a correct no-op must not read as a ledger FAILURE",
    second.applied === false && second.alreadyCharged === true);

  // 🚨 The counter and the trail must agree. A second audit row for a suppressed charge would make
  // agentBreakdown report spending the ceiling never saw, AND would hand the step-8 sweeper a
  // second "open" charge for one transaction to resolve or reverse independently.
  // ⚠️ COUNTED FROM THE RAW STORE, NOT FROM listUnresolvedCharges — and the difference is the whole
  // assertion. The first version used the open-charges list, which filters to
  // `confirmation === "submitted"`. The duplicate row this is hunting is written by the RECONCILE,
  // i.e. `confirmation:"confirmed"`, so the filter excluded exactly the row under test and the
  // check passed against a deliberately broken build. ⭐ Caught only because the mutation run
  // produced 1 red instead of 2 — the filter WAS part of the hypothesis
  // ([[filtered-read-is-not-absence]]).
  const budgetMap = maps.find((x) => x._n === "data-budget");
  const auditRowsA = [...(budgetMap?.entries() ?? [])]
    .filter(([k]) => k.startsWith("audit:"))
    .map(([, e]) => e.value)
    .filter((v) => v?.circleId === "cid-A");
  check("🚨🚨 …and NO second audit entry was appended — one transaction, one charge row",
    auditRowsA.length === 1,
    `${auditRowsA.length} audit row(s) for cid-A: ${auditRowsA.map((r) => r.confirmation).join(",")}`);

  // A DIFFERENT id must still charge — idempotency must not become a global mute.
  await spend(2, { confirmation: "submitted", circleId: "cid-B", chargeId: "cid-B" });
  const dayAfterB = await budget.daySpend({ owner: OWNER, at: AT });
  check("⭐ a DIFFERENT id still charges — the guard is per-transaction, not a global mute",
    dayAfterB === 3.5, `day=${dayAfterB}`);

  // ⚠️ OMITTING chargeId MUST KEEP THE OLD BEHAVIOUR. Every existing caller passes none.
  resetStores();
  await spend(1);
  await spend(1);
  const dayNoId = await budget.daySpend({ owner: OWNER, at: AT });
  check("⚠️ WITHOUT a chargeId the old behaviour is EXACT — two calls, two charges",
    dayNoId === 2, `day=${dayNoId}`);
  // Read the raw day record straight out of the mocked store: the point is the SHAPE on disk,
  // and daySpend() would only show the total, which is exactly what this assertion is not about.
  const dayMap = maps.find((x) => x._n === "data-budget");
  const dayRec = [...(dayMap?.values() ?? [])].map((e) => e.value)
    .find((v) => v && typeof v.spentUsdc === "number" && v.owner);
  check("⭐ …and no `chargedIds` field is written for them — not a migration, nothing to migrate",
    dayRec !== undefined && dayRec.chargedIds === undefined,
    dayRec ? `keys: ${Object.keys(dayRec).join(",")}` : "day record not found");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("8 — 🚨 REVERSAL STILL WORKS ON AN IDEMPOTENT CHARGE, and does not re-open it");
{
  const budget = await import("../netlify/functions/_budget.mjs");
  const OWNER = "0x" + "7c".repeat(20);
  const AT = Date.parse("2026-08-22T12:00:00.000Z");
  resetStores();
  await budget.recordAgentSpend({
    owner: OWNER, amountUsdc: 4, source: "swap_tokens", justification: "DCA mandate m1 (submitted)",
    at: AT, confirmation: "submitted", circleId: "cid-R", chargeId: "cid-R",
  });
  check("the charge landed", (await budget.daySpend({ owner: OWNER, at: AT })) === 4);

  // This is the exact call dca-tick's reconcile makes on a WITNESSED FAILED/CANCELLED/DENIED.
  const rev = await budget.reverseChargeById({ circleId: "cid-R", reason: "swap failed", at: AT + 1000 });
  const afterRev = await budget.daySpend({ owner: OWNER, at: AT });
  check("⭐⭐ a witnessed failure gives the budget back — the runner the submit-charge requires",
    rev.reversed === true && afterRev === 0, `reversed=${rev.reversed} day=${afterRev}`);
  check("⭐ …and it is NOT reported anomalous — the charge was found", rev.anomalous !== true);

  // 🚨 THE ONE THAT COULD GO FAIL-OPEN. After a reversal the id REMAINS in chargedIds, so a
  // re-charge under the same id is still suppressed. That is correct — the charge happened once
  // and was reversed once — but it must be PINNED, because the tempting "fix" if someone sees a
  // suppressed re-charge is to clear chargedIds on reversal, which would permit a double-charge
  // AND, paired with reversedIds, an unbounded charge/reverse cycle on one id.
  await budget.recordAgentSpend({
    owner: OWNER, amountUsdc: 4, source: "swap_tokens", justification: "re-charge attempt",
    at: AT, confirmation: "submitted", circleId: "cid-R", chargeId: "cid-R",
  });
  const afterRecharge = await budget.daySpend({ owner: OWNER, at: AT });
  check("🚨🚨 a REVERSED id cannot be re-charged under the same id — reversal does not clear chargedIds",
    afterRecharge === 0, `day=${afterRecharge}`);

  const revTwice = await budget.reverseChargeById({ circleId: "cid-R", reason: "again", at: AT + 2000 });
  check("⭐ …and reversing twice does not credit twice",
    revTwice.reversed !== true && (await budget.daySpend({ owner: OWNER, at: AT })) === 0);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("9 — ⭐⭐ THE STATE TRAVELS AS A CODE, NOT AS A SENTENCE");
// Two consumers gate `markChargeResolved` on ALREADY_REVERSED — `reverseChargeById` here and the
// sweeper in budget-sweep.mjs. It means "a previous attempt reversed the money and died before
// writing the marker", and it MUST still mark, or the charge stays queued for the backstop forever.
// It used to be recovered with /already reversed/.test(r.refused) at BOTH sites: a reword of the
// primitive's sentence silently made both false, and a false there is indistinguishable from a
// correct one. These checks pin the code and, more importantly, pin that the PROSE IS INERT.
{
  const budget = await import("../netlify/functions/_budget.mjs");
  const OWNER = "0x" + "9d".repeat(20);
  // ⚠️ IN THE PAST, ON PURPOSE. `listUnresolvedCharges` filters on age, so a fixture stamped in the
  // future is invisible to it and the whole section would go vacuously green on an empty list.
  const AT = Date.parse("2026-08-22T09:00:00.000Z");
  resetStores();
  await budget.recordAgentSpend({
    owner: OWNER, amountUsdc: 2.5, source: "swap_tokens", justification: "typed-refusal fixture",
    at: AT, confirmation: "submitted", circleId: "cid-T",
  });
  const open = await budget.listUnresolvedCharges({ at: AT + 1000, olderThanMs: 0 });
  check("the fixture charge is visible to the sweeper", open.length === 1, `${open.length} open`);

  const first = await budget.reverseAgentSpend({ entry: open[0], reason: "first reversal", at: AT + 1000 });
  check("the FIRST reversal succeeds", first.reversed === true, JSON.stringify(first));
  check("⭐ …and a success carries NO refusal code — the field is not always-on",
    first.refusal === undefined, `refusal=${first.refusal}`);
  check("⭐ wasAlreadyReversed is FALSE on a real reversal — the pairwise inequality that stops " +
    "the predicate collapsing to a constant",
    budget.wasAlreadyReversed(first) === false, JSON.stringify(first));

  // THE STATE THE CONSUMERS ACT ON.
  const second = await budget.reverseAgentSpend({ entry: open[0], reason: "second attempt", at: AT + 2000 });
  check("🚨 the SECOND reversal refuses", second.reversed === false, JSON.stringify(second));
  check("🚨🚨 …with the TYPED code, which is what both consumers branch on. If this is red, " +
    "reverseChargeById and budget-sweep.mjs both stop calling markChargeResolved and every " +
    "already-reversed charge stays queued for the backstop forever",
    second.refusal === budget.REVERSAL_REFUSAL.ALREADY_REVERSED, `refusal=${second.refusal}`);
  check("⭐ …and the shared predicate agrees", budget.wasAlreadyReversed(second) === true);
  check("⭐ the money is not credited twice", (await budget.daySpend({ owner: OWNER, at: AT })) === 0);

  // ⛔ THE ASSERTIONS THAT MAKE THE FIX REAL RATHER THAN INCIDENTAL ─────────────────────────────
  // A typed field that is merely PRESENT beside a prose match has fixed nothing. These two pin the
  // direction of the dependency, and they are the pair that goes red if anyone reintroduces parsing.
  check("⭐⭐ REWORDING the sentence changes NOTHING — the predicate ignores `refused` entirely",
    budget.wasAlreadyReversed({ ...second, refused: "totally different wording, nothing matches" }) === true,
    "the predicate still reads the prose");
  check("⭐⭐ …and the SENTENCE ALONE is not enough — prose without the code is FALSE",
    budget.wasAlreadyReversed({ reversed: false, refused: "already reversed (id present in reversedIds)" }) === false,
    "a hand-built object with only the sentence satisfied the predicate");

  check("⭐ the closed set is frozen", Object.isFrozen(budget.REVERSAL_REFUSAL));
  check("⭐ …and every refusal code is distinct — a collapsed set compares equal to itself",
    new Set(Object.values(budget.REVERSAL_REFUSAL)).size === Object.keys(budget.REVERSAL_REFUSAL).length,
    JSON.stringify(budget.REVERSAL_REFUSAL));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
