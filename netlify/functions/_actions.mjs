import { circle, waitForTx } from "./_circle.mjs";
import { ARC, CONTRACTS, USDC_DECIMALS, sendCapUsdc, bridgeCapUsdc, swapCapUsdc, vaultDepositCapUsdc } from "./_arc.mjs";
import { agentSwap, valueInUsdc, SWAP_TOKENS } from "./_swap.mjs";
import { agentPay } from "./_pay.mjs";
import { agentBridge, bridgeFee, resolveDestination } from "./_bridge.mjs";
import { resolveVault, inspectVault, gateDeposit, vaultDeposit, vaultWithdraw, readShareBalance } from "./_vault.mjs";
import { canSpendDay, recordAgentSpend } from "./_budget.mjs";
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
export async function valueOfStep(step) {
  const type = step?.type;
  if (type === "transfer_usdc") return Number(step.amountUsdc);
  if (type === "pay_for_service") return Number(step.payAmountUsdc);
  if (type === "swap_tokens") {
    return await valueInUsdc({ token: String(step.tokenIn).toUpperCase(), amount: Number(step.amountIn) });
  }
  // A bridge moves its full face amount OFF Arc (the fee is deducted from it on
  // the destination), so the full amount is what counts against the day-ceiling.
  if (type === "bridge_usdc") return Number(step.amountUsdc);
  // A vault deposit commits its full face amount into the vault — counts in full against the
  // day-ceiling, like transfer/bridge.
  if (type === "vault_deposit") return Number(step.amountUsdc);
  // A vault withdraw RECLAIMS funds back to the SCA — it is not a spend, so it costs nothing
  // against the ceiling. (executeAction returns it early, before valuation; this is here only so
  // valueOfStep is total across the vocabulary — e.g. if a plan sums its steps.)
  if (type === "vault_withdraw") return 0;
  throw new Error(`unknown step type "${type}"`);
}

// Validate a step's SHAPE (not the cap). Returns null if ok, or a reason string.
export function validateStepShape(step) {
  const type = step?.type;
  if (type === "transfer_usdc") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(step.to || ""))) return "invalid recipient";
    if (!(Number(step.amountUsdc) > 0)) return "amountUsdc must be > 0";
    return null;
  }
  if (type === "pay_for_service") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(step.payTo || ""))) return "invalid payTo address";
    if (!(Number(step.payAmountUsdc) > 0)) return "payAmountUsdc must be > 0";
    return null;
  }
  if (type === "swap_tokens") {
    const tIn = String(step.tokenIn || "").toUpperCase();
    const tOut = String(step.tokenOut || "").toUpperCase();
    if (!VALID_TOKENS.includes(tIn) || !VALID_TOKENS.includes(tOut)) return "unsupported token (USDC/EURC only)";
    if (tIn === tOut) return "tokenIn and tokenOut must differ";
    if (!(Number(step.amountIn) > 0)) return "amountIn must be > 0";
    return null;
  }
  if (type === "bridge_usdc") {
    if (!(Number(step.amountUsdc) > 0)) return "amountUsdc must be > 0";
    if (!resolveDestination(step.destination)) return `unsupported destination "${step.destination}"`;
    return null;
  }
  // Vault target is ALLOWLISTED by key — never a free-form contract address off the wire, matching
  // the bridge-destination / swap-token precedent. The inspection GATE (BLOCK/WARN/ack) is a
  // separate check in executeAction, not part of shape validation.
  if (type === "vault_deposit") {
    if (!resolveVault(step.vault)) return `unsupported vault "${step.vault}" (not on the allowlist)`;
    if (!(Number(step.amountUsdc) > 0)) return "amountUsdc must be > 0";
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
export async function executeAction(step, ctx) {
  const { walletAddress, store } = ctx;
  if (!walletAddress) return { ok: false, blocked: "no agent wallet resolved for this caller" };

  // Which agent's kill switch governs this step. vault_* steps are the VAULT agent's; everything
  // else is the EXECUTOR's. So pausing the Vault agent stops vault deposits without touching the
  // Executor, and vice-versa (each agent honours its OWN switch — see _agents.mjs / _pause.mjs).
  const stepAgent = String(step?.type || "").startsWith("vault_") ? AGENT.VAULT : AGENT.EXECUTOR;
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
    if (paused) return { ok: false, blocked: paused };
  }

  const shapeErr = validateStepShape(step);
  if (shapeErr) return { ok: false, blocked: shapeErr };

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
      return { ok: false, blocked: `could not read your on-chain share balance — withdraw not attempted (${e.message})` };
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
      return { ok: false, blocked: wd.reason, unconfirmed: true, withdrawHash: wd.withdrawHash ?? null };
    }
    return { ok: true, kind: "vault_withdraw", vault: vw.key, reclaimed: true, ...wd };
  }

  // Per-transaction SEND cap (transfers only). Checked FIRST so an over-cap send
  // returns the cap message rather than the day-ceiling one. Applies to BOTH
  // user-directed and autonomous transfers routed through here.
  if (step.type === "transfer_usdc") {
    const cap = sendCapUsdc();
    if (Number(step.amountUsdc) > cap) {
      return { ok: false, blocked: `exceeds per-transaction limit of ${cap} USDC` };
    }
  }

  // Per-BRIDGE cap — cross-chain is the highest-stakes action (funds leave Arc),
  // so it has its own bound, checked first (like the send cap) so an over-cap
  // bridge returns the cap message rather than the day-ceiling one.
  if (step.type === "bridge_usdc") {
    const bcap = bridgeCapUsdc();
    if (Number(step.amountUsdc) > bcap) {
      return { ok: false, blocked: `exceeds per-bridge limit of ${bcap} USDC` };
    }
  }

  // Per-VAULT-DEPOSIT cap — checked first (like send/bridge) so an over-cap deposit returns the
  // cap message rather than the day-ceiling one. amountUsdc is face USDC. vaultDepositCapUsdc()
  // is fail-closed: a garbled env THROWS here (nothing signs) — the same discipline as the other
  // caps, which also throw uncaught.
  if (step.type === "vault_deposit") {
    const vcap = vaultDepositCapUsdc();
    if (Number(step.amountUsdc) > vcap) {
      return { ok: false, blocked: `exceeds per-vault-deposit limit of ${vcap} USDC` };
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

  // Budget spine: per-day ceiling backstop (shared with research purchases).
  let dayValue;
  try {
    dayValue = await valueOfStep(step);
  } catch (e) {
    return { ok: false, blocked: `cannot value step: ${e.message}` };
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
      return {
        ok: false,
        blocked: `exceeds per-swap limit of ${scap} USDC (${Number(step.amountIn)} ${String(step.tokenIn).toUpperCase()} ≈ ${dayValue.toFixed(2)} USDC)`,
      };
    }
  }

  // Per-user day ceiling: keyed to THIS caller's own agent wallet (server-
  // resolved), so one user's spend never blocks another's. The gate and the
  // ledger below MUST use the same owner (walletAddress) to read/write one bucket.
  const day = await canSpendDay({ amountUsdc: dayValue, store, owner: walletAddress });
  if (!day.allowed) return { ok: false, blocked: day.reason };

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
    }).catch(() => {});

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
      amountIn: Number(step.amountIn).toFixed(2),
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
    await ledger({ confirmation: swap.state });
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
      amountUsdc: Number(step.payAmountUsdc).toFixed(2),
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
    const txHash = await waitForTx(client, tx.data?.id);
    await ledger();
    return { ok: true, kind: "transfer_usdc", tx: `${ARC.explorer}/tx/${txHash}` };
  }

  if (step.type === "bridge_usdc") {
    const dest = resolveDestination(step.destination);
    const amount = Number(step.amountUsdc);
    // FEE-FLOOR refusal: the (volatile) forwarder fee is taken OUT of the amount.
    // If it meets/exceeds the amount, the recipient nets ≤ 0 and the bridge is
    // un-settleable — refuse BEFORE any funds move. This re-checks live at
    // execution time (the fee may have moved since the proposal).
    let fee;
    try {
      fee = await bridgeFee({ amountUsdc: amount, cctpDomain: dest.cctpDomain });
    } catch (e) {
      return { ok: false, blocked: `cannot price bridge to ${dest.label}: ${e.message}` };
    }
    if (fee.maxFee >= fee.amountMinor) {
      return {
        ok: false,
        blocked: `amount too small — the bridge fee to ${dest.label} is ~${fee.feeUsdc.toFixed(2)} USDC right now (≥ your ${amount} USDC), so nothing would arrive`,
      };
    }
    const r = await agentBridge({ walletAddress, destination: dest.key, amountUsdc: amount });
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
      feeUsdc: r.feeUsdc,
      netUsdc: r.netUsdc,
      recipient: r.recipient,
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
      return { ok: false, blocked: `cannot inspect vault ${v.label}: ${e.message}` };
    }
    const gate = gateDeposit({ inspection, ackToken: step.ackToken, expectedAssetAddress: v.assetAddress });
    if (!gate.ok) return { ok: false, blocked: gate.blocked, disclosure: gate.disclosure };

    const dep = await vaultDeposit({ walletAddress, vault: v, amountUsdc: amount });
    await ledger();
    return { ok: true, kind: "vault_deposit", vault: v.key, ...dep, disclosure: gate.disclosure };
  }

  return { ok: false, blocked: `unknown step type "${step.type}"` };
}
