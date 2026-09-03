import { amountFloorViolation } from "./_amount-floor.mjs";
import { circle, waitForTx } from "./_circle.mjs";
import { ARC, CONTRACTS, USDC_DECIMALS, sendCapUsdc, bridgeCapUsdc, swapCapUsdc, vaultDepositCapUsdc } from "./_arc.mjs";
import { agentSwap, valueInUsdc, SWAP_TOKENS } from "./_swap.mjs";
import { agentPay } from "./_pay.mjs";
import { agentBridge, bridgeFee, resolveDestination, bridgeFeeBand, bridgeAckToken, openBridgeQuote } from "./_bridge.mjs";
import { resolveVault, inspectVault, gateDeposit, applyReportDisclosure, vaultDeposit, vaultWithdraw, readShareBalance } from "./_vault.mjs";
import { vaultDdReport } from "./_vault-report.mjs";
import { canSpendDay, recordAgentSpend, shoutLedgerFailure, recordBlocked, REFUSAL } from "./_budget.mjs";
import { AGENT } from "./_agents.mjs";
import { assertNotPaused } from "./_pause.mjs";

// Shared action layer. Both agent-act (single action) and agent-execute-plan
// (a sequence) run actions through these helpers so the execution logic lives
// in ONE place.
//
// IMPORTANT: the spend cap is NOT enforced here. The caller enforces it —
// agent-act checks the single action against the cap; the plan path sums the
// USD value of ALL steps and checks the TOTAL against the cap before executing
// any of them. valueOfStep() is the shared valuation used for both.

const VALID_TOKENS = SWAP_TOKENS.map((t) => t.toUpperCase());

// USD value of a step, for cap math. Transfer/pay are face USDC; a swap is the
// USD value of its input token (EURC != $1, so value, not units).
export async function valueOfStep(step, resolved = {}) {
  const type = step?.type;
  if (type === "transfer_usdc") return Number(step.amountUsdc);
  if (type === "pay_for_service") return Number(step.payAmountUsdc);
  if (type === "swap_tokens") {
    // ═══ 🚨🚨 WHAT THIS RETURNS IS *NOT* THE AMOUNT THE EXECUTOR RECEIVES ═══════
    // It is a USDC-EQUIVALENT: `valueInUsdc(tokenIn, amountIn)`. The swap boundary hands the
    // executor `step.amountIn`, in tokenIn UNITS. For a EURC input those are different numbers, and
    // the ledger row written from this value records the equivalent, not the units.
    //
    // ⛔ THE FIELD NAME IS THE TRAP. It is stored as `amountUsdc`, sitting beside
    // `source: "swap_tokens"`, where it reads exactly like the swap's amount. On 2026-09-02 five
    // historical rows were compared against `toFixed(2)` of THIS value to measure what the rounding
    // boundary had executed. Every delta was arithmetic on the wrong quantity, and all five were
    // WITHDRAWN. The check that would have caught it was reading these four lines.
    //
    // ⛔ DO NOT COMPARE A LEDGER `amountUsdc` TO A TOKEN AMOUNT. They are only the same number when
    // tokenIn is USDC, and nothing in the record says which token it was.
    return await valueInUsdc({ token: String(step.tokenIn).toUpperCase(), amount: Number(step.amountIn) });
  }
  // ═══ ⭐⭐ A BRIDGE COSTS THE WALLET `amount + fee` — AND THAT IS A DECISION, NOT ARITHMETIC ═════
  //
  // 🚨 THIS RETURNED `amountUsdc` ALONE, AND ITS OLD COMMENT IS WHY THAT WOULD HAVE STAYED
  // INVISIBLE. It read: "A bridge moves its full face amount OFF Arc (the fee is deducted from it
  // on the destination), so the full amount is what counts against the day-ceiling." That is a
  // reasoned derivation, and it was correct — under the mechanic adoption INVERTS. ⛔ A wrong value
  // with no comment invites a question; a wrong value with a correct-sounding derivation answers it
  // in advance, and an auditor reading the ceiling would have moved on.
  //
  // ⛔ THE DEFECT IT WOULD HAVE PRODUCED IS MONEY-SAFETY, NOT COPY. Under upfront fees the wallet
  // parts with `amount + fee`. Counting only the amount leaves THE DAY CEILING WIDER THAN
  // CONFIGURED, BY THE FEE, ON EVERY BRIDGE — the same class as a lost ledger write.
  //
  // ── TAKEN: the cap and the ceiling bound THE WALLET DEBIT. ────────────────────────────────────
  // The ceiling exists to bound what leaves the user's control, and under upfront fees the fee
  // leaves it too. So the value is `amount + fee`.
  //
  // ── REJECTED: bounding the AMOUNT BRIDGED. ───────────────────────────────────────────────────
  // It reads naturally for something called a "per-bridge limit", and it is defensible — a user
  // asking "how much may I bridge at once" is asking about the amount. ⚠️ But it would let a
  // volatile third-party fee widen the effective ceiling with nobody watching, which is the
  // property a ceiling exists to deny. Both readings are written here because both are defensible
  // and the next editor must know which was taken rather than re-deriving it.
  //
  // ⛔ FAIL CLOSED WITHOUT A FEE. The fee is resolved ONCE by the caller (from the sealed quote, or
  // by quoting) and threaded in — never re-fetched here, which would be a second quote and a second
  // figure. If it is absent we THROW rather than fall back to the amount: falling back is exactly
  // the under-count above, and it must never be reachable by omission.
  if (type === "bridge_usdc") {
    const feeUsdc = Number(resolved?.bridgeFee?.feeUsdc);
    if (!Number.isFinite(feeUsdc)) {
      throw new Error("cannot value a bridge without its fee — the day ceiling bounds amount + fee");
    }
    return Number(step.amountUsdc) + feeUsdc;
  }
  // A vault deposit commits its full face amount into the vault — counts in full against the
  // day-ceiling, like transfer/bridge.
  if (type === "vault_deposit") return Number(step.amountUsdc);
  // A vault withdraw RECLAIMS funds back to the SCA — it is not a spend, so it costs nothing
  // against the ceiling. (executeAction returns it early, before valuation; this is here only so
  // valueOfStep is total across the vocabulary — e.g. if a plan sums its steps.)
  if (type === "vault_withdraw") return 0;
  throw new Error(`unknown step type "${type}"`);
}

// ⛔ THE ZERO FLOOR IS APPLIED HERE, ONCE, FOR EVERY TYPE THAT CARRIES AN AMOUNT — not at each
// executor. `Number(x) > 0` used to stand in for a floor and it is not one: 0.0000001 passes it and
// converts to 0n minor units, so the chain executes a transfer of nothing and reports success.
// See _amount-floor.mjs for why this is a DIFFERENT guard from the equality invariant.
// Validate a step's SHAPE (not the cap). Returns null if ok, or a reason string.
export function validateStepShape(step) {
  const type = step?.type;
  if (type === "transfer_usdc") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(step.to || ""))) return "invalid recipient";
    const f = amountFloorViolation(step.amountUsdc, { field: "amountUsdc" });
    if (f) return f;
    return null;
  }
  if (type === "pay_for_service") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(step.payTo || ""))) return "invalid payTo address";
    const f = amountFloorViolation(step.payAmountUsdc, { field: "payAmountUsdc" });
    if (f) return f;
    return null;
  }
  if (type === "swap_tokens") {
    const tIn = String(step.tokenIn || "").toUpperCase();
    const tOut = String(step.tokenOut || "").toUpperCase();
    if (!VALID_TOKENS.includes(tIn) || !VALID_TOKENS.includes(tOut)) return "unsupported token (USDC/EURC only)";
    if (tIn === tOut) return "tokenIn and tokenOut must differ";
    const f = amountFloorViolation(step.amountIn, { field: "amountIn" });
    if (f) return f;
    return null;
  }
  if (type === "bridge_usdc") {
    const f = amountFloorViolation(step.amountUsdc, { field: "amountUsdc" });
    if (f) return f;
    if (!resolveDestination(step.destination)) return `unsupported destination "${step.destination}"`;
    return null;
  }
  // Vault target is ALLOWLISTED by key — never a free-form contract address off the wire, matching
  // the bridge-destination / swap-token precedent. The inspection GATE (BLOCK/WARN/ack) is a
  // separate check in executeAction, not part of shape validation.
  if (type === "vault_deposit") {
    if (!resolveVault(step.vault)) return `unsupported vault "${step.vault}" (not on the allowlist)`;
    const f = amountFloorViolation(step.amountUsdc, { field: "amountUsdc" });
    if (f) return f;
    return null;
  }
  if (type === "vault_withdraw") {
    // No client-supplied amount: the reclaim redeems the caller's FULL on-chain share balance,
    // read server-side at execution time (see executeAction). Only the vault key is validated here
    // — there is deliberately no `shares` on the wire to mis-scale.
    if (!resolveVault(step.vault)) return `unsupported vault "${step.vault}" (not on the allowlist)`;
    return null;
  }
  return `unknown step type "${type}"`;
}

// Execute ONE validated action. The per-transaction cap is still enforced by the
// CALLER (agent-act / execute-plan). This function adds the shared budget-spine
// guardrails around the (unchanged) execution:
//   - per-DAY ceiling check (canSpendDay) before spending,
//   - ledger the spend (recordAgentSpend) after success.
//
// EVERY money-moving branch below sources funds from ctx.walletAddress — the CALLER'S OWN
// agent SCA, server-resolved from the verified session. No branch reads a wallet from env.
// ctx = { walletAddress, store? }. Returns { ok, kind, ... } or { ok:false, blocked }.
// ⚠️ `shoutLedgerFailure` MOVED to _budget.mjs on 2026-08-21 and is imported above. It lived here,
// private, while agent-send.mjs kept the silent `.catch(() => {})` this helper exists to replace —
// a remedy only one call site could reach. It now sits beside the ledger it reports on.

// The step's face amount, for the REFUSAL RECORD only — never a counter input. Best-effort by
// design: a step refused BECAUSE it could not be valued has no trustworthy amount, and 0 is the
// honest answer there rather than a guess.
const amountOfStep = (step) => {
  const n = Number(step?.amountUsdc ?? step?.amountIn ?? step?.payAmountUsdc);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export async function executeAction(step, ctx) {
  const { walletAddress, store } = ctx;
  // ⚠️ THE ONE REFUSAL THAT IS NOT RECORDED, AND IT IS NOT AN OVERSIGHT. The audit trail is keyed
  // BY OWNER, and this branch fires precisely because there is no owner to key it to. Recording it
  // under a placeholder would put an unattributable row in someone's trail or invent a bucket
  // nobody reads. There is also no user session to show it to — this is a caller-wiring bug, not a
  // policy refusal. ⭐ Left as a plain return DELIBERATELY, and labelled, so the next reader does
  // not "fix" the inconsistency by fabricating an owner. See REFUSAL.NO_WALLET, which exists for
  // any future caller that DOES know the owner and can attribute it.
  if (!walletAddress) return { ok: false, blocked: "no agent wallet resolved for this caller" };

  // Which agent's kill switch governs this step. vault_* steps are the VAULT agent's; everything
  // else is the EXECUTOR's. So pausing the Vault agent stops vault deposits without touching the
  // Executor, and vice-versa (each agent honours its OWN switch — see _agents.mjs / _pause.mjs).
  const stepAgent = String(step?.type || "").startsWith("vault_") ? AGENT.VAULT : AGENT.EXECUTOR;

  // ── ⭐⭐ EVERY REFUSAL BELOW IS RECORDED, NOT JUST RETURNED ───────────────────────────────────
  // Until 2026-08-22 executeAction refused by returning `{ok:false, blocked}` and writing NOTHING.
  // The refusal was enforced and then EVAPORATED: unless the caller happened to be watching the
  // response, "your agent tried to move money and a cap stopped it" left no trace anywhere.
  //
  // 🚨 AND THE WHOLE OBSERVABILITY CHAIN WAS ALREADY BUILT AND DARK FOR THIS PATH. recordBlocked
  // existed; agentBreakdown already tallied `blocked` and already excluded refusals from
  // `spentUsdc`; agents.mjs already shipped `blockedToday` and an `activity` trail whose comment
  // says "Includes REFUSALS"; AgentsPanel already rendered "N refused" and the reason line. The
  // RESEARCHER produced those records. The EXECUTOR — the agent that moves the user's money —
  // never did. ⚠️ So the executor's `blockedToday` could only ever read 0, which looks like
  // "nothing was refused" and meant "nothing is measured".
  //
  // ⭐ ONE CHOKE POINT, NOT FOURTEEN CALL SITES. There are fourteen refusal returns in this
  // function; recording at each would guarantee a missed one and drift
  // ([[duplicate-source-of-truth-is-the-recurring-bug]]). Same rule as the dry-run fix: gate at
  // the WRITE, not at each caller.
  //
  // 🚨 A FAILED RECORD MUST NEVER BECOME AN ALLOW. The refusal has already been decided; writing
  // it down is observability. So the write is caught and swallowed, and the refusal is returned
  // either way. The inverse — letting a logging failure propagate — would turn an audit-store
  // hiccup into a money-moving action.
  const refuse = async (code, blocked, extra = {}) => {
    try {
      await recordBlocked({
        owner: walletAddress, agent: stepAgent, source: String(step?.type ?? "unknown"),
        amountUsdc: Number(extra.amountUsdc ?? amountOfStep(step) ?? 0),
        reason: blocked, code, store,
      });
    } catch { /* enforcement already happened; observability must not undo it */ }
    const { amountUsdc, ...rest } = extra; // amountUsdc is for the RECORD, not the caller's shape
    return { ok: false, blocked, ...rest };
  };
  // A RECLAIM returns the user's funds — it must never be blocked by a pause. Same principle as
  // agent-withdraw: pause/cap bind what an agent may SPEND, never what the user may RECLAIM, so a
  // paused Vault agent cannot trap funds inside the vault. vault_withdraw redeems shares back to
  // the SCA, so it is a reclaim.
  const isReclaim = step?.type === "vault_withdraw";

  // ── THE KILL SWITCH — checked FIRST, before any cap, any valuation, any signing. ──
  // This is the MAIN chokepoint (agent-act, execute-plan, agent-bridge, and both approve
  // endpoints all land here), but it is NOT the only one: agent-send and agent-ub-spend move
  // funds without ever calling executeAction, so they check it themselves. A pause that one
  // path routes around is not a pause.
  //
  // Fail-closed: if the switch cannot be READ, _pause.mjs returns a reason and we refuse.
  if (!isReclaim) {
    const paused = await assertNotPaused({ owner: walletAddress, agent: stepAgent });
    if (paused) return refuse(REFUSAL.PAUSED, paused);
  }

  const shapeErr = validateStepShape(step);
  if (shapeErr) return refuse(REFUSAL.SHAPE, shapeErr);

  // ── RECLAIM: vault_withdraw returns funds to the SCA — no cap, no day-ceiling, no ledger-as-
  // spend (a reclaim is not a spend). Handled here, before all the spend machinery below. Shape
  // is already validated; pause is deliberately skipped above. ──
  if (step.type === "vault_withdraw") {
    const vw = resolveVault(step.vault);
    // Derive the reclaim amount from the LIVE chain, here at execution time — never a session
    // receipt, never a client value. A returning user whose shares came from a prior session
    // reclaims fine, because the amount is whatever balanceOf says right now.
    let bal;
    try {
      bal = await readShareBalance({ walletAddress, vault: vw });
    } catch (e) {
      // FAIL CLOSED: a balance we could not read is NOT treated as zero and NOT redeemed. Nothing
      // signs. (readShareBalance throws only on read failure; a genuine zero returns 0n below.)
      return refuse(REFUSAL.CANNOT_READ, `could not read your on-chain share balance — withdraw not attempted (${e.message})`);
    }
    if (bal.raw <= 0n) {
      // Genuinely no shares → "nothing to reclaim". Not an error, not a redeem(0); a clean no-op the
      // endpoint surfaces as a message.
      return { ok: true, kind: "vault_withdraw", vault: vw.key, reclaimed: false, shareBalanceRaw: "0" };
    }
    // Redeem EXACTLY the on-chain balance — nothing stranded, nothing over. redeem() burns precisely
    // this many shares; if the balance changed between read and redeem, the vault reverts (surfaced
    // as an error) rather than over-redeeming.
    const wd = await vaultWithdraw({ walletAddress, vault: vw, shares: bal.raw.toString() });
    // A reclaim is only a success if it is PROVEN on-chain (mined status:success + a real +USDC
    // delta). An unproven reclaim is an honest failure carrying its reason — never a fabricated
    // amount. The caller surfaces `blocked` to the user.
    if (!wd.confirmed) {
      return refuse(REFUSAL.UNCONFIRMED, wd.reason, { unconfirmed: true, withdrawHash: wd.withdrawHash ?? null });
    }
    return { ok: true, kind: "vault_withdraw", vault: vw.key, reclaimed: true, ...wd };
  }

  // Per-transaction SEND cap (transfers only). Checked FIRST so an over-cap send
  // returns the cap message rather than the day-ceiling one. Applies to BOTH
  // user-directed and autonomous transfers routed through here.
  if (step.type === "transfer_usdc") {
    const cap = sendCapUsdc();
    if (Number(step.amountUsdc) > cap) {
      return refuse(REFUSAL.PER_TX_CAP, `exceeds per-transaction limit of ${cap} USDC`);
    }
  }

  // Per-VAULT-DEPOSIT cap — checked first (like send/bridge) so an over-cap deposit returns the
  // cap message rather than the day-ceiling one. amountUsdc is face USDC. vaultDepositCapUsdc()
  // is fail-closed: a garbled env THROWS here (nothing signs) — the same discipline as the other
  // caps, which also throw uncaught.
  if (step.type === "vault_deposit") {
    const vcap = vaultDepositCapUsdc();
    if (Number(step.amountUsdc) > vcap) {
      return refuse(REFUSAL.PER_VAULT_CAP, `exceeds per-vault-deposit limit of ${vcap} USDC`);
    }
  }

  // NOTE: pay_for_service used to be BLOCKED here whenever a session was present, because
  // agentPay read the shared AGENT_WALLET_ADDRESS and a per-user pay would have drained the
  // shared Gateway balance. That fallback is gone — agentPay now REQUIRES a sourceAccount,
  // which we thread from ctx.walletAddress below. The block is therefore obsolete: a
  // per-user pay draws from the user's OWN Gateway balance, or fails.
  //
  // A caller with NO session (the internal/autonomous path) still supplies its own
  // ctx.walletAddress, so there is no unowned spend either way.

  // ═══ ⭐⭐ A BRIDGE IS PRICED BEFORE IT IS BOUNDED, BECAUSE ITS COST INCLUDES A FEE ═════════════
  //
  // The cap and the ceiling bound `amount + fee` (see valueOfStep), so the fee has to be known
  // before either can be applied. It is resolved ONCE here and threaded into everything below —
  // the valuation, the band, the calldata — so every figure comes from ONE quote.
  //
  // ⛔ THE TOKEN IS OPENED, NEVER TRUSTED AS DATA. `openBridgeQuote` verifies the HMAC and refuses a
  // quote for a different owner, destination or amount, and it is PURE — no I/O — so opening it
  // here costs nothing and cannot be a second read. A failure REFUSES; it never falls back to
  // pricing, because a silent fallback turns "the figure you saw" into "some figure".
  // ⚠️ NO TOKEN MEANS A FRESH QUOTE, AT EXECUTION. That is correct for a caller with no confirm
  // step to bind from, and it is why the un-bound path cannot disclose a fee in advance.
  const resolved = {};
  let boundFee = null;
  if (step.type === "bridge_usdc") {
    const dest0 = resolveDestination(step.destination);
    if (!dest0) return refuse(REFUSAL.SHAPE, `unsupported destination "${step.destination || ""}"`);
    if (step.quoteToken) {
      try {
        boundFee = openBridgeQuote(step.quoteToken, {
          owner: ctx.session?.address, destinationKey: dest0.key, amountUsdc: Number(step.amountUsdc) });
      } catch (e) {
        return { ok: false, blocked: `${e.message}`, quoteExpired: true };
      }
      resolved.bridgeFee = boundFee;
    } else {
      try {
        resolved.bridgeFee = await bridgeFee({ amountUsdc: Number(step.amountUsdc), cctpDomain: dest0.cctpDomain });
      } catch (e) {
        return refuse(REFUSAL.CANNOT_VALUE, `cannot price bridge to ${dest0.label}: ${e.message}`);
      }
    }
  }

  // Budget spine: per-day ceiling backstop (shared with research purchases).
  let dayValue;
  try {
    dayValue = await valueOfStep(step, resolved);
  } catch (e) {
    return refuse(REFUSAL.CANNOT_VALUE, `cannot value step: ${e.message}`);
  }

  // ═══ Per-BRIDGE cap — AFTER valuation, for the same reason the SWAP cap is ════════════════════
  // ⭐ It used to sit above, bounding `step.amountUsdc` directly. Under upfront fees that is not
  // what the bridge costs: the fee is charged ON TOP, so bounding the raw amount would let a
  // volatile third-party fee push the real debit past the cap while the check still passed.
  // ⚠️ This is EXACTLY the swap cap's history — `amountIn` in EURC is not a USDC bound — and the
  // remedy is the same: bound the valued quantity, not the typed one. It still runs BEFORE
  // canSpendDay, so an over-cap bridge returns the CAP message rather than the day-ceiling one.
  if (step.type === "bridge_usdc") {
    const bcap = bridgeCapUsdc();
    if (dayValue > bcap) {
      return refuse(
        REFUSAL.PER_BRIDGE_CAP,
        `exceeds per-bridge limit of ${bcap} USDC — ${Number(step.amountUsdc)} USDC plus a ` +
        `${Number(resolved.bridgeFee.feeUsdc).toFixed(6)} USDC fee is ${dayValue.toFixed(6)} USDC ` +
        `leaving your wallet`,
        { amountUsdc: dayValue },
      );
    }
  }

  // Per-SWAP cap. Unlike send/bridge (checked above, before valuation), this MUST run here —
  // AFTER valueOfStep — because a swap's amountIn may be EURC, and EURC != $1. valueOfStep
  // has already converted it to USDC-equivalent; bounding the raw amountIn would silently
  // mis-bound every EURC→USDC swap. But it still runs BEFORE canSpendDay, so an over-cap swap
  // returns the CAP message rather than the day-ceiling one — same behaviour as send/bridge.
  //
  // Swap was the only executable action with no per-transaction bound (day-ceiling only).
  // Reject, never clamp: nothing signs.
  if (step.type === "swap_tokens") {
    const scap = swapCapUsdc();
    if (dayValue > scap) {
      return refuse(
        REFUSAL.PER_SWAP_CAP,
        `exceeds per-swap limit of ${scap} USDC (${Number(step.amountIn)} ${String(step.tokenIn).toUpperCase()} ≈ ${dayValue.toFixed(2)} USDC)`,
        { amountUsdc: dayValue },
      );
    }
  }

  // Per-user day ceiling: keyed to THIS caller's own agent wallet (server-
  // resolved), so one user's spend never blocks another's. The gate and the
  // ledger below MUST use the same owner (walletAddress) to read/write one bucket.
  const day = await canSpendDay({ amountUsdc: dayValue, store, owner: walletAddress });
  if (!day.allowed) return refuse(REFUSAL.DAY_CEILING, day.reason, { amountUsdc: dayValue });

  // On any successful spend below, ledger it against today's ceiling + audit. Attributed to the
  // agent that acted (VAULT for a vault deposit, EXECUTOR otherwise) — not hardcoded, so the
  // Agents-page breakdown stays honest.
  //
  // `extra` lets a branch record what it actually KNOWS about on-chain confirmation at ledger time
  // (see the swap branch's `confirmation`). Branches that confirm inline before ledgering, or that
  // have nothing to add, call ledger() with no argument and the audit entry is unchanged.
  const ledger = (extra = {}) =>
    recordAgentSpend({
      agent: stepAgent,
      owner: walletAddress,
      amountUsdc: dayValue,
      source: step.type,
      justification: step.reasoning,
      store,
      ...extra,
    }).catch((err) => {
      // ⭐ STILL SWALLOWED — the action already succeeded and must not now report failure — but no
      // longer SILENT. See shoutLedgerFailure: a lost write here widens the day ceiling, it is not
      // a missing log line.
      shoutLedgerFailure({ agent: stepAgent, owner: walletAddress, amountUsdc: dayValue, source: step.type, err });
    });

  if (step.type === "swap_tokens") {
    const tokenIn = String(step.tokenIn).toUpperCase();
    const tokenOut = String(step.tokenOut).toUpperCase();
    // confirm: DCA-ONLY inline-confirm (dca-tick sets ctx.confirmSwap; it's scheduled, so it can wait to
    // COMPLETE). Manual/sync callers leave it unset → submit-and-return, keeping their existing async
    // verification and their 10s budget. A confirm:true swap that stays pending THROWS (SwapPendingConfirm /
    // Error) out of agentSwap — so `ledger()` below is reached ONLY on a confirmed swap (day-ceiling
    // stays confirm-gated for DCA). See _swap.agentSwap + dca-agentswap-refactor-state.
    const swap = await agentSwap({
      walletAddress,
      tokenIn: SWAP_TOKENS.find((t) => t.toUpperCase() === tokenIn),
      tokenOut: SWAP_TOKENS.find((t) => t.toUpperCase() === tokenOut),
      // ═══ ⭐⭐ THE EXECUTOR GETS THE VALUE THE CAP CHECKED AND THE LEDGER RECORDED ═══════════
      // This was `.toFixed(2)`, and toFixed ROUNDS: 1.237 executed as 1.24 — MORE than requested,
      // more than the cap was checked against, more than the audit row recorded.
      // ⛔ NOT ONLY A PRECISION DEFECT. `dayValue` (valueOfStep, full precision) is what the
      // per-action cap and the day ceiling are tested on and what recordAgentSpend writes, so a
      // rounded-up execution moves more than the cap was checked against — the ceiling permits more
      // total movement than it was configured for, by up to 0.005 USDC per action.
      // ⚠️ HOW OFTEN THAT HAPPENED IS UNMEASURED, and deliberately not guessed at here.
      // 🚨 `dayValue` IS NOT WHAT THIS BOUNDARY SENDS. It is valueOfStep — for a swap, the
      // USDC-EQUIVALENT of `amountIn` (see the note at valueOfStep, ~line 30). This line sends
      // `step.amountIn` in tokenIn UNITS. Rounding the equivalent and rounding the units are
      // arithmetic on two different numbers, and five historical deltas computed the first way were
      // withdrawn on 2026-09-02.
      // ⛔ `step.amountIn` is persisted NOWHERE, so no audit row can answer what was executed here.
      // That gap is the finding, not the deltas. See verify-executor-amount-integrity's fixture.
      // ⚠️ AND ROUNDING DOWN WAS AN ACCIDENTAL MARGIN. On a max-amount action the rounded value could
      // sit under the balance; at full precision a max equals the balance exactly, so
      // insufficient-funds failures on max sends after this change are EXPECTED, not a regression.
      amountIn: String(step.amountIn),
      confirm: ctx.confirmSwap === true,
    });
    // ⚠️ AUDIT HONESTY — the record must not assert more than the chain has said.
    // The MANUAL path (confirm:false) is submit-and-return: this ledger() runs at SUBMIT, before any
    // on-chain confirmation, and NOTHING reverses the day-ceiling charge if the swap later reverts or
    // is refused pre-broadcast (both classes proven real in step 4). That budget-reversal reconcile is
    // owed separately (step 8) — but the AUDIT ENTRY must not claim a completed swap in the meantime.
    // So it records what agentSwap actually returned: "submitted" (manual, outcome not yet verified)
    // or "confirmed" (DCA inline-confirm, which waits for COMPLETE before this line is reached).
    // `allowed` stays TRUE and unchanged — it means "authorized and counted against the ceiling",
    // which IS true; flipping it would make agentBreakdown report a BLOCKED action while the counter
    // still incremented, desyncing the audit from the ledger.
    //
    // `circleId` is the AUTHORITATIVE id the step-8 sweeper will resolve this charge against
    // (getTransaction({id})). Without it, `confirmation:"submitted"` says a charge is unresolved but
    // NOT which transaction to resolve it against — so the entry would be permanently unresolvable
    // and the sweeper must skip it rather than guess (guessing reverses a charge for a swap that
    // actually landed). agentSwap already returns it, so this is plumbing, not derivation.
    await ledger({ confirmation: swap.state, circleId: swap.circleId });
    return {
      ok: true,
      kind: "swap_tokens",
      swap,
      tx: swap.explorerUrl || (swap.txHash ? `${ARC.explorer}/tx/${swap.txHash}` : null),
    };
  }

  if (step.type === "pay_for_service") {
    // sourceAccount = the caller's OWN agent SCA (server-resolved from the session by
    // agent-act / agent-execute-plan). agentPay has NO env fallback, so if a caller ever
    // fails to thread a wallet here this throws rather than quietly draining the shared
    // Gateway balance. The delegate must be authorized on THIS SCA — ensureDelegate runs
    // at deposit time, and the Gateway itself rejects an unauthorized delegate.
    const pay = await agentPay({
      recipientAddress: String(step.payTo),
      // ⭐ Full precision — see the swap boundary above. toFixed ROUNDS UP, and the cap and ledger
      // both use the unrounded value, so a rounded execution moved more than either saw.
      amountUsdc: String(step.payAmountUsdc),
      sourceAccount: walletAddress,
    });
    await ledger();
    return { ok: true, kind: "pay_for_service", pay };
  }

  if (step.type === "transfer_usdc") {
    const client = circle();
    const amount = Number(step.amountUsdc);
    const units = BigInt(Math.round(amount * 10 ** USDC_DECIMALS)).toString();
    const tx = await client.createContractExecutionTransaction({
      walletAddress,
      blockchain: ARC.blockchain,
      contractAddress: CONTRACTS.USDC,
      abiFunctionSignature: "transfer(address,uint256)",
      abiParameters: [String(step.to), units],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    // ── 🚨 A TIMEOUT IS NOT A REFUSAL (finding A, 2026-08-21) ────────────────────────────────
    // waitForTx throwing TxPendingError means WE STOPPED WAITING — the transfer IS submitted to
    // Circle and may land seconds later. The old shape let that throw straight past `ledger()`,
    // so a pending-then-landed transfer was NEVER counted and the day ceiling silently widened.
    // Ledger it at SUBMIT with the authoritative id, then rethrow so the caller's 202 is unchanged.
    // ⭐ `confirmation:"submitted"` + `circleId` is exactly what step 8 resolves against, so the
    // charge is now RECOVERABLE instead of lost. No paired sub-ledger here — see _budget.mjs's
    // PRECONDITION, which this path was checked against rather than assumed compatible with.
    let txHash;
    try {
      txHash = await waitForTx(client, tx.data?.id);
    } catch (e) {
      if (e?.name === "TxPendingError") {
        await ledger({ confirmation: "submitted", circleId: tx.data?.id });
      }
      throw e;
    }
    await ledger({ confirmation: "confirmed", circleId: tx.data?.id });
    return { ok: true, kind: "transfer_usdc", tx: `${ARC.explorer}/tx/${txHash}` };
  }

  if (step.type === "bridge_usdc") {
    const dest = resolveDestination(step.destination);
    const amount = Number(step.amountUsdc);
    // ⭐ THE FEE WAS RESOLVED ONCE, ABOVE, AND IS REUSED HERE. It priced the cap and the ceiling and
    // it prices the band and the burn — one quote, one figure, no second read. Re-resolving here
    // would reintroduce exactly the drift the sealed quote exists to remove, one layer deeper.
    const fee = resolved.bridgeFee;

    // ═══ ⭐⭐ THE FEE-FLOOR — AND ITS OLD REASON IS NOW FALSE ═══════════════════════════════════
    //
    // 🚨 IT USED TO SAY "so nothing would arrive", AND UNDER UPFRONT FEES THAT IS WRONG. The fee is
    // charged on the SOURCE, in addition to the amount, and the recipient receives the FULL amount
    // — measured on Base Sepolia in PR-3, where a burn of 1 minor unit credited exactly 1. A bridge
    // whose fee exceeds its amount now DELIVERS FINE; it is simply a terrible trade.
    //
    // ⭐ SO THE REFUSAL SURVIVES AND ITS REASON CHANGES. It is no longer "this cannot settle" — it
    // is "this costs more to move than it moves". Same threshold, different claim, and the message
    // must not keep asserting a mechanism that stopped being true.
    // ⛔ A refusal that names a false mechanism is worse than none: it teaches the reader something
    // wrong about where their money went, on the surface where they are deciding.
    if (fee.feeMinor >= fee.amountMinor) {
      return {
        ok: false,
        blocked:
          `the fee to ${dest.label} is ~${fee.feeUsdc.toFixed(4)} USDC — as much as or more than the ` +
          `${amount} USDC you are moving. The full ${amount} would still arrive, but you would pay ` +
          `~${(amount + fee.feeUsdc).toFixed(4)} USDC to move it.`,
      };
    }

    // ── THE BAND GATE — disclosure alone is not consent ──────────────────────────────
    // The floor above only fires when the fee is as large as the amount. Between that and
    // "worth doing" sits a gap where a bridge succeeds while most of the money becomes
    // fee (0.1 USDC → 53% gone, and it clears the floor). At/above the acknowledge band
    // we REFUSE until the caller returns the exact ackToken for the disclosure they saw —
    // the same fail-closed shape as the vault deposit gate (_vault.mjs gateDeposit), and
    // for the same reason: a warning someone scrolls past is not acceptance.
    // ⚠️ The refusal is NOT a new floor. It is satisfiable — by acknowledging.
    const bandInfo = bridgeFeeBand({ amountUsdc: amount, feeUsdc: fee.feeUsdc, netUsdc: fee.netUsdc });
    const expected = bridgeAckToken({ owner: ctx.session?.address, destinationKey: dest.key, amountUsdc: amount, band: bandInfo.band });
    if (bandInfo.band === "acknowledge") {
      if (step.ackToken !== expected) {
        const pct = (bandInfo.feeRatio * 100).toFixed(1);
        return {
          ok: false,
          blocked:
            `this bridge would lose ${pct}% to fees — the fee to ${dest.label} is ~${fee.feeUsdc.toFixed(4)} USDC ` +
            `on top of the ${amount} USDC you are moving — the full ${amount} arrives, and ` +
            `~${(amount + fee.feeUsdc).toFixed(4)} USDC leaves your wallet. Confirm you accept that before it runs.`,
          // Threaded so the UI renders the disclosure and can return the ack — it never
          // re-derives the band from the two numbers.
          feeDisclosure: { ...bandInfo, destinationKey: dest.key, amountUsdc: amount, ackToken: expected },
        };
      }
    }
    // ⭐⭐ THE CONSENT CONTEXT MUST SURVIVE A THROW, AND IT MUST LEAVE HERE AS DATA.
    //
    // A userOp that has not settled within the deadline raises TxPendingError from inside
    // agentBridge. Everything needed to record WHAT THE USER ACCEPTED — the band we priced,
    // the ratio, whether a token was required and matched — lives in THIS scope and died
    // with the throw, so the 202 path wrote no consent evidence at all (observed live
    // 2026-08-14, on the first run that ever reached the acknowledge band).
    //
    // 🚨 WHY ATTACH RATHER THAN WRITE HERE. The receipt write belongs at the BOUNDARY, never
    // in the shared executor: `job-bridge-approve` has its own receipt system, and a write
    // in here would give it a SECOND receipt in a SECOND store, drifting independently.
    // ⚠️ `verify-bridge-fee-band.mjs` enforces that by SUBSTRING over this whole file, so even
    // NAMING the receipt helpers in a comment fails the build — as this comment originally
    // did. Blunt, and deliberately so: a guard that reads the file is one nobody can quietly
    // satisfy. The executor hands the facts outward; the boundary decides what to persist.
    let r;
    try {
      // ⭐ THE RESOLVED FEE REACHES THE CALLDATA — the same object the cap, the ceiling and the band
      // were computed from. Its `signedQuote` is what the contract enforces the fee against, so
      // "the figure shown is the figure charged" is now true by the chain's own assert, not only by
      // our threading. ⚠️ `boundFee` is passed so agentBridge can re-check the quote's deadline.
      // ⛔ THE RESOLVED FEE IS PASSED ALWAYS, BOUND OR NOT. It used to pass `boundFee ?? undefined`,
      // which let agentBridge fetch its OWN quote on the un-bound path — a SECOND quote, seconds
      // after the one that priced the cap and the ceiling, and it is the second one whose
      // `signedQuote` would have been submitted. The gates would have bounded one quote and the
      // chain enforced another.
      r = await agentBridge({ walletAddress, destination: dest.key, amountUsdc: amount, fee });
    } catch (e) {
      // Enrich and RETHROW — never swallow. The caller's error handling is unchanged;
      // it simply now has the disclosure attached if it wants to persist it.
      e.consent = {
        destinationKey: dest.key,
        destinationLabel: dest.label,
        // ⚠️ LOAD-BEARING, NOT DECORATION — and it can only be captured here. `verifyMintOnChain`
        // REFUSES with `bad_recipient` when this is missing, so a receipt later recovered without
        // it parks at `mint_unconfirmed` and gets re-checked every 10 minutes forever: the exact
        // unbounded shape of the 12-day Polygon record. agentBridge defaults the recipient to the
        // wallet address, and that wallet is the AGENT'S SCA — not the session owner — so nothing
        // downstream can re-derive it from the record's own keys.
        recipient: walletAddress,
        // ⚠️ THE SAME ADDRESS, A DIFFERENT CLAIM, AND THEY ARE ONLY EQUAL BY DEFAULT. `recipient`
        // is where the money is going; `payer` is which wallet it left. agentBridge happens to
        // default the recipient to the spender today — collapsing them into one field would make
        // the fee reading silently wrong the day a bridge sends somewhere else.
        payer: walletAddress,
        amountRequested: amount,
        // 🚨 THE SECOND DEFECT, AND THE FIX IS A DIFFERENT FIELD, NOT A DIFFERENT VALUE.
        // This path used to record the GATED fee under `feeUsdc` — the same field the SUCCESS path
        // fills from the SIGNED quote — so the same bridge reported a different fee depending on
        // whether the userOp happened to settle inside the deadline. A timing accident, presented
        // as a property of the money.
        // ⭐ `agentBridge` threw, so the signed fee is genuinely UNKNOWN here: it is `null`, not a
        // stand-in. What we do know is what was disclosed, and that is recorded as such.
        // ⚠️ `netUsdc` pairs with `feeCharged`, so it is null too. The disclosed net is
        // `amountRequested - feeDisclosed` and is derived by the exposure — not stored, for the
        // same reason the ratio is not.
        feeCharged: null,
        feeDisclosed: fee.feeUsdc,
        // ⭐ THE SAME QUOTE'S OWN INTEGER, so the post-burn fee reconciliation never has to convert
        // a float back into minor units to compare it against a chain log. It is taken from the
        // object `feeDisclosed` came from, not re-derived — a second source would be free to drift
        // from the figure the band gate actually evaluated.
        feeDisclosedMinor: String(fee.feeMinor),
        // ⭐ The mechanic travels with the disclosure even on the throw path: a recovered receipt
        // must be able to say where the fee was charged, and the consent object is the only thing
        // that survives a TxPendingError.
        feeMechanic: fee.mechanic ?? "unknown",
        netUsdc: null,
        feeBand: bandInfo.band,
        ackRequired: bandInfo.band === "acknowledge",
        acknowledged: bandInfo.band === "acknowledge",
        ackToken: bandInfo.band === "acknowledge" ? expected : null,
      };
      throw e;
    }
    await ledger();
    // Async two-stage: the Arc burn is done; the destination mint is completed by
    // Circle's relayer. Caller polls agent-bridge-status for the mint tx.
    return {
      ok: true,
      kind: "bridge_usdc",
      state: "submitted",
      burnHash: r.burnHash,
      tx: r.burnTx,
      destination: r.destination,
      // ═══ ⭐⭐ TWO FEES, NAMED FOR WHAT THEY ARE — NOT FOR WHICH QUOTE THEY CAME FROM ═══════
      // `agentBridge` re-prices internally, so this path holds two quotes: the one the band gate
      // evaluated, and the one actually signed. They are ~200 ms apart and the fee moves, so they
      // can differ.
      // 🚨 THIS USED TO EMIT `feeUsdc` FROM THE SIGNED QUOTE AND `feeRatio` FROM THE GATED ONE, so
      // a receipt could carry a fee and a ratio that are not arithmetically related. Reproduced
      // deterministically by injection in verify-receipt-fee-authority.mjs: feeUsdc 0.05 alongside
      // feeRatio 0.6 while feeUsdc/amount was 0.5.
      // ⭐ Each field now names what it IS, so no consumer needs to know a quote letter, and each
      // PAIR comes from a single quote: (feeCharged, netUsdc) from the signed one, (feeDisclosed,
      // feeBand) from the gated one.
      feeCharged: r.feeUsdc,      // what was actually taken — the fee signed into the calldata
      feeDisclosed: fee.feeUsdc,  // what the consent decision was made against
      // ⭐ THE DISCLOSED FIGURE'S OWN INTEGER, from the SAME quote object as `feeDisclosed` above.
      // The post-burn fee reconciliation compares against a chain log, which is in minor units;
      // carrying the quote's BigInt means that comparison never converts a float, and never has to
      // decide what to do about a rounding it could not perform exactly.
      feeDisclosedMinor: String(fee.feeMinor),
      // ⭐⭐ WHERE THE FEE WAS CHARGED, beside the figures it explains. `netUsdc` is meaningless
      // without it — the same number means "what arrives" on one path and "the amount, with the fee
      // on top" on the other.
      feeMechanic: r.feeMechanic ?? fee.mechanic ?? "unknown",
      netUsdc: r.netUsdc,         // pairs with feeCharged
      recipient: r.recipient,
      // ⭐⭐ WHO PAID — AND IT IS NOT `owner`. The spender is the caller's SCA, not the session
      // address, and nothing downstream can re-derive it from the record's own keys. Without it a
      // post-burn reading of the fee cannot scope the logs to the payer, and a bundler batching
      // several userOps into one transaction would put another wallet's movements in the same
      // receipt. Captured HERE because this is the only scope that knows it.
      payer: walletAddress,
      // ⭐ EVIDENCE THAT THE GATE RAN, SERVER-SOURCED. The band is what WE priced and
      // classified; `acknowledged` is true only because the token the caller returned
      // matched the one we recomputed here. A client-asserted "I accepted" would be worth
      // nothing — this is the server recording what it itself enforced. Persisted on the
      // receipt so "who accepted losing 53%, and when" survives the session.
      feeBand: bandInfo.band,
      // ⭐ NO `feeRatio`. It is `feeDisclosed / amountRequested` — both on the record — so storing
      // it was a duplicate source of truth, and THE DEFECT WAS THAT DUPLICATE DISAGREEING WITH ITS
      // SOURCE. Derived at read time instead, which makes self-reconciliation structural.
      ackRequired: bandInfo.band === "acknowledge",
      acknowledged: bandInfo.band === "acknowledge",
      ackToken: bandInfo.band === "acknowledge" ? expected : null,
    };
  }

  if (step.type === "vault_deposit") {
    const v = resolveVault(step.vault);
    const amount = Number(step.amountUsdc);

    // ── THE INSPECTION GATE. Re-inspect the vault on-chain at execution time (a stale disclosure
    // must not outrank the live one — same discipline as re-pricing a bridge/swap at approve),
    // then apply BLOCK / WARN+ack. This runs BEFORE any approve or deposit — nothing signs if the
    // gate refuses. Allowlisting only got us here; it did NOT silence this. ──
    let inspection;
    try {
      inspection = await inspectVault(v.address);
    } catch (e) {
      return refuse(REFUSAL.CANNOT_READ, `cannot inspect vault ${v.label}: ${e.message}`);
    }
    // ⭐ THE DISCLOSURE IS ESTABLISHED FROM THE DD REPORT, at execute time, on a FRESH read — the
    // same discipline the re-inspection already followed. A report fetched when the user was
    // reading the card is not evidence about the vault now.
    // ⚠️ A null report BLOCKS inside applyReportDisclosure; that decision is not duplicated here.
    inspection = applyReportDisclosure(inspection, await vaultDdReport(v.address));
    const gate = gateDeposit({ inspection, ackToken: step.ackToken, expectedAssetAddress: v.assetAddress });
    if (!gate.ok) return refuse(REFUSAL.DISCLOSURE, gate.blocked, { disclosure: gate.disclosure });

    const dep = await vaultDeposit({ walletAddress, vault: v, amountUsdc: amount });
    await ledger();
    return { ok: true, kind: "vault_deposit", vault: v.key, ...dep, disclosure: gate.disclosure };
  }

  return refuse(REFUSAL.UNKNOWN_STEP, `unknown step type "${step.type}"`);
}
