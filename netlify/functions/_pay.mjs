import { AppKit } from "@circle-fin/app-kit";
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";

/** Where a committed-but-unminted spend leaves its attestation. Read by hand; nothing sweeps it yet. */
export const PAY_STRAND_STORE = "pay-strands";

// PAY PLANE. The agent pays USDC from its Gateway (Unified Balance) to any
// recipient on Arc Testnet. Same-chain Arc->Arc, NO forwarder.
//
// ⭐⭐ THE SCA SIGNS FOR ITSELF (app-kit >=1.14.0). This used to read: the agent wallet is a
// dev-controlled SCA which CANNOT sign Gateway spends, so an authorized EOA delegate signs while
// funds come from the SCA. Gateway now validates ERC-1271, so the account that holds the balance
// authorises the spend. `DELEGATE_ADDRESS` is no longer read on this path.
//
// ⛔ IT IS NOT GONE FROM THE APP, AND SAYING SO WOULD BE THE OVERCLAIM. `_x402-vanilla.mjs` still
// requires the EOA — the batched x402 header scheme needs `ecrecover(sig) == from` and accepts NO
// contract signature, so the Researcher's EIP-3009 data buys are unaffected by this upgrade.
// `_delegate.mjs` still owns the authorization machinery. What changed is one plane, not the model.
//
// ✅ ERC-1271 IS ACCEPTED — PROVEN 2026-09-10, and this is the claim the upgrade existed to earn.
// A live `pay_for_service` produced a valid burn intent: Gateway ATTESTED it and Circle's ledger
// committed 0.1035 USDC. An attestation only exists if the signature validated, so the SCA signing
// for itself works. Under 1.8.1 this died at `invalid_signature` with nothing committed.
//
// ⛔⛔ AND THE SAME RUN EXPOSED A LIMIT THIS HEADER USED TO HIDE. It said tx 0xbf56e6be…7133501 was
// "the exact shape proven on-chain" WITHOUT recording that its recipient must be a wallet WE
// CONTROL. It must. `to` passes a destination `adapter` and NO forwarder, so App Kit submits
// `gatewayMint` itself, through that adapter, FROM `to.address` — the recipient. Circle holds no
// wallet for a third party and answers "Requested resource not found". The mint never runs and the
// burn stays committed. That omission is what made a third-party test look reasonable.
//
// ⚠️ AND THE OBVIOUS FIX IS NOT AVAILABLE HERE. `_ubspend.mjs` avoids this with `useForwarder:true`
// and no destination adapter — the relayer mints, so any recipient works. The forwarder carries a
// FLAT ~0.2055 USDC fee and a 10 USDC floor: on a 0.1 payment the fee is twice the payment and the
// floor forbids it outright. That is WHY this path has no forwarder. The honest statement is a
// CONSTRAINT, not a bug: small same-chain Gateway pays require a recipient we control; arbitrary
// recipients need a forwarder and a much larger amount.
//
// The Circle Wallets adapter submits async; App Kit's waitForTransaction throws
// (code 1098 / "transaction hash required", sometimes surfaced as a 5001 mint
// "error" whose nested cause is 1098) EVEN THOUGH the spend lands on-chain. We
// catch that family and report submitted-pending, mirroring _swap.mjs.
//
// ⚠️ NO ENV FALLBACK for the source. `sourceAccount` is REQUIRED and comes from the
// caller's server-resolved session wallet (executeAction's ctx.walletAddress). This
// function previously read AGENT_WALLET_ADDRESS, which meant a per-user pay would have
// drawn down the SHARED Gateway balance — the cap-bypass seam. Missing ⇒ throw.
export async function agentPay({ recipientAddress, amountUsdc, sourceAccount }) {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const owner = sourceAccount;                      // the SCA: holds the balance AND signs (ERC-1271)
  if (!apiKey || !entitySecret) throw new Error("Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET");
  if (!owner) throw new Error("agentPay requires a `sourceAccount` (the session's agent SCA)");
  // ⛔ THE `DELEGATE_ADDRESS` REQUIREMENT IS GONE, and removing it is deliberate rather than tidy:
  // a precondition on a variable the path no longer reads would refuse a spend for a reason that
  // has stopped existing — a guard that fails closed on nothing. It is still required by
  // _x402-vanilla.mjs and _delegate.mjs, which is why the ENV VAR stays set.

  const amount = String(amountUsdc);
  const kit = new AppKit();
  const adapter = createCircleWalletsAdapter({ apiKey, entitySecret });

  const params = {
    amount,
    token: "USDC",
    from: [{
      adapter,
      // ⭐⭐ THE SCA SIGNS FOR ITSELF — app-kit >=1.14.0, ERC-1271. There is no delegate here and
      // no `sourceAccount`: the account that HOLDS the balance is the account that AUTHORISES the
      // spend, which is what a self-custodial claim should have looked like all along.
      //
      // WHAT THIS REPLACED: `address: delegate, sourceAccount: owner`. Gateway used to accept only
      // ECDSA, so an SCA could not sign its own spend and an authorised EOA (DELEGATE_ADDRESS) had
      // to sign while funds were drawn from the SCA. 1.14.0's Gateway validates ERC-1271 and the
      // SDK detects a contract signer from on-chain bytecode, marking the request `contractSigner`.
      //
      // ⚠️ THE DETECTION HAS THREE DEFAULT-FALSE PATHS, read verbatim from 1.14.0's
      // `isContractSigner`: bytecode `0x` or undefined (an EOA *or* an UNDEPLOYED SCA), a
      // `readBytecode` that THROWS (logged to a console.warn nobody reads), and a call site that
      // defaults false when the adapter is not EVM-like. ⭐ ALL THREE FAIL CLOSED AT GATEWAY —
      // `contractSigner:false` makes it expect ecrecover, a contract signature is refused, and NO
      // FUNDS MOVE. The cost is an intermittent refusal with no visible reason, not a loss.
      //
      // ⭐ THE UNDEPLOYED-SCA PATH IS UNREACHABLE THROUGH THIS APP, and it is worth knowing WHY,
      // because the reason is not the delegate we just deleted. `ubDeposit` submits
      // `approve(USDC, gateway)` FROM THE SCA before the deposit — a first transaction that DEPLOYS
      // the account. So bytecode exists before anything signs, independently of `ensureDelegate`.
      // MEASURED 2026-09-10: both live SCAs read 209 bytes. ⚠️ The one way in is an EXTERNAL
      // permissionless `depositFor` crediting an SCA that never transacted; this app never does it.
      address: owner,           // the SCA holds the balance AND signs for it (ERC-1271)
      // ⭐ NO `allocations` — this is how AUTO-ALLOCATION IS ENABLED. Supplying the key (for any
      // source) disables it and pins the draw to whatever we name. Omitting it makes the kit call
      // getBalances and pick chains itself, greedily: tier 1 = SAME CHAIN AS THE DESTINATION,
      // tier 2 = other non-Ethereum chains by balance descending, tier 3 = Ethereum last.
      //
      // ⚠️ SAFE HERE BY GEOMETRY, not by luck: this spend is SAME-CHAIN (Arc -> Arc, see `to`
      // below), so Arc IS tier 1 and auto-allocation picks it first whenever Arc can cover the
      // amount. This path therefore behaves identically to the old hardcoded allocation for as
      // long as the Arc balance suffices — and if it ever does NOT, drawing from elsewhere is the
      // behaviour we want rather than a failure.
      //
      // Runtime-verified, not assumed: @circle-fin/unified-balance-kit@1.2.1 declares
      // `allocations: z.union([...]).optional()` in spendSourceSchema, so omission is accepted by
      // the VALIDATOR, not merely permitted by the types.
    }],
    to: {
      adapter,
      chain: "Arc_Testnet",
      address: recipientAddress,
      recipientAddress,
    },
  };

  try {
    const result = await kit.unifiedBalance.spend(params);
    return { state: "completed", recipientAddress, amountUsdc: amount, result };
  } catch (e) {
    const msg = e?.message || "";
    // ⚠️ `JSON.stringify` THROWS ON A BigInt, and viem/SDK errors carry them freely. This line used
    // to be a bare stringify: a spend error whose cause held one BigInt would have thrown a
    // TypeError FROM THE CATCH BLOCK, replacing the real failure with a serialisation error and
    // losing the 1098 classification below. Never seen in the wild; one BigInt away from it.
    const causeStr = safeJson(e?.cause) ?? "";
    const isAsyncWaiterQuirk =
      e?.code === 1098 ||
      /transaction hash is required/i.test(msg) ||
      (e?.code === 5001 && /transaction hash is required/i.test(causeStr));
    if (isAsyncWaiterQuirk) {
      // Spend submitted; the mint lands shortly. Not a failure.
      return { state: "submitted", pending: true, recipientAddress, amountUsdc: amount };
    }
    // 🚨 THE BURN MAY ALREADY BE COMMITTED. Record the recovery material (the attestation in
    // cause.trace) BEFORE we drop it — this is the ONLY place it survives.
    await recordStrandNeverThrows({ owner, recipientAddress, amountUsdc: amount, error: e, causeStr, msg });
    // ⛔ AND DO NOT RETHROW THE RAW ERROR. `throw e` carried e.cause (the ~600-char attestation
    // calldata) and a message telling the user to "reattempt via config.retry" — advice they
    // cannot act on and a BLIND-RETRY TRAP (it produced a SECOND off-chain reservation on
    // 2026-09-12, 10:49 then 10:50). Same class as agent-ub-spend's 500 blanket catch (18c0396),
    // on the pay plane. Classify to a clean refusal; the raw detail lives in the strand + this log.
    console.error(`[pay] spend failed owner=${owner} -> ${recipientAddress} code=${e?.code ?? "?"} name=${e?.name ?? "?"}: ${msg}`);
    const c = classifyPayThrow(e, { recipientAddress, amountUsdc: amount });
    const clean = new Error(c.body.error);      // ⛔ a NEW error — never `throw e` (it holds calldata)
    clean.payClassified = true;
    clean.payStatus = c.status;
    clean.payBody = c.body;
    clean.code = e?.code ?? null;               // keep the typed code for any downstream inspector
    if (e?.name) clean.name = e.name;
    throw clean;
  }
}

// ⭐⭐ A RECIPIENT THAT CANNOT RECEIVE IS A 4xx, AND NO CALLDATA LEAKS IN EITHER BRANCH.
// The pay-plane sibling of classifySpendThrow (18c0396). App Kit submits `gatewayMint` FROM the
// RECIPIENT; for a non-Circle-Gateway address Circle holds no wallet and the mint reverts (code
// 5001 ONCHAIN_TRANSACTION_REVERTED, "Requested resource not found") — a deterministic user/config
// condition that WILL NOT succeed on retry, not a fault to page an operator for.
// ⭐ MEASURED 2026-09-12: on-chain Gateway availableBalance never moved (1.51 throughout); the burn
// was only an off-chain RESERVATION that releases. So: name the condition, say no payment was made,
// and DROP the SDK's calldata and its "reattempt via config.retry" advice.
// ⛔ Everything else stays a 500 but SANITISED — the raw viem/SDK message carries calldata, so it is
// logged + stranded, never returned in the body. Exported so a suite drives it directly.
// [[check-whose-failure-mode-is-a-pass]] [[verification-method-must-not-mutate]]
export function classifyPayThrow(e, { recipientAddress, amountUsdc } = {}) {
  const msg = e?.message || "";
  // The phrase can arrive in the message OR nested in cause.trace; check both. Tested against `msg`
  // (a prose local) directly, not a composed haystack, so verify-no-prose-state-recovery SEES this
  // as the third-party-text match it is and the _pay.mjs exemption actually covers it.
  const causeStr = safeJson(e?.cause) ?? "";
  const recipientUnpayable =
    /requested resource not found/i.test(msg) ||
    /requested resource not found/i.test(causeStr) ||
    (e?.code === 5001 && /mint failure/i.test(msg));
  if (recipientUnpayable) {
    return { status: 400, body: {
      error: `That recipient can't receive a Gateway payment${recipientAddress ? ` (${recipientAddress})` : ""} — it isn't a Circle Gateway account, so there is nowhere for the payment to land. No payment was made, and retrying will not change that.`,
      recipientUnpayable: true, blocked: true,
      recipientAddress: recipientAddress ?? null,
      amountUsdc: amountUsdc ?? null,
    } };
  }
  return { status: 500, body: {
    error: `The payment could not be completed and its status is unconfirmed. Check your balance before retrying.`,
  } };
}

/** JSON that cannot throw — BigInts, cycles and getters all degrade instead of raising.
 *  ⭐ EXPORTED FOR ITS TEST. A pure function guarding a catch block is worth driving directly:
 *  asserting it by regex would pin the SHAPE and never exercise the BigInt that motivated it. */
export function safeJson(v) {
  if (v === undefined || v === null) return null;
  const seen = new WeakSet();
  try {
    return JSON.stringify(v, (_k, val) => {
      if (typeof val === "bigint") return `${val}n`;
      if (typeof val === "function") return "[function]";
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[circular]";
        seen.add(val);
      }
      return val;
    });
  } catch {
    return null;
  }
}

// ═══ 🚨 A COMMITTED BURN WITH A FAILED MINT MUST NOT LOSE ITS OWN RECOVERY MATERIAL ═══════════
//
// MEASURED 2026-09-10, and this function exists because of it. A `pay_for_service` to a THIRD-PARTY
// recipient produced a valid ERC-1271 burn intent — Gateway attested it and Circle's ledger
// committed 0.1035 USDC (0.1 + fee) — and then the MINT leg failed, because this path passes a
// destination `adapter` and no forwarder, so App Kit submits `gatewayMint` FROM `to.address`. That
// is the recipient, and Circle holds no wallet for a third party: "Requested resource not found".
//
// ⛔ THE OLD CATCH RETHREW AND KEPT NOTHING. The error's own text said what was being discarded —
// *"Use the attestation and signature in `error.cause.trace` to reattempt via `config.retry`"* —
// and that attestation is the ONLY thing that can complete or recover a burn Circle has already
// committed. It existed in one browser error message and nowhere else.
//
// ⭐ THE ATTESTATION IS NOT A CREDENTIAL. It authorises a mint TO A NAMED RECIPIENT for a fixed
// amount; holding it does not let anyone redirect the funds. Storing it is safe.
//
// ⛔⛔ AND IT IS NOT A FUNDS-RECOVERY MECHANISM — I built it believing it was, and the measurement
// says otherwise. MEASURED 2026-09-10, the SAME incident, watched to completion:
//
//   Circle's ledger (/v1/balances) 1.5100 -> 1.4065 -> 1.5100      reserved, then RELEASED
//   on-chain availableBalance()    1.510000 THROUGHOUT              never moved at all
//
// A committed-but-unminted burn intent EXPIRES AND RELEASES BACK. The whole episode lived in
// Circle's off-chain ledger; nothing was ever burned on Arc, and no funds were at risk in either
// direction. ⚠️ So the urgent-sounding framing this comment first carried was WRONG.
//
// ⭐ WHAT THE RECORD ACTUALLY BUYS, stated at its real size: the user still WANTED to pay. The
// attestation lets that payment be COMPLETED — submitted by a wallet we do control — instead of
// re-signing and re-committing a second reservation. It is a completion aid and a diagnostic, not
// a rescue. ⚠️ Do not let a future reader infer money is at stake from the fact that we save this.
//
// ⚠️ NEVER THROWS, and AWAITED — the same two rules as writeReceiptNeverThrows, for the same two
// reasons: the money may already be gone by the time we are called, so a Blobs hiccup must not
// replace a real failure with a different one; and a Netlify function can freeze the instant the
// handler returns, so an un-awaited write may simply never happen.
//
// ⚠️ SCOPE: _ubspend.mjs has the SAME exposure and does NOT have this yet. It uses a forwarder, so
// its mint is relayer-submitted and this exact failure cannot occur — but a committed burn failing
// for any other reason would discard the same material there.
async function recordStrandNeverThrows({ owner, recipientAddress, amountUsdc, error, causeStr, msg }) {
  try {
    const { getStore } = await import("@netlify/blobs");
    const at = new Date().toISOString();
    await getStore(PAY_STRAND_STORE).setJSON(`strand:${String(owner).toLowerCase()}:${at}`, {
      at,
      owner,
      recipientAddress,
      amountUsdc,
      code: error?.code ?? null,
      message: msg,
      // The recovery material. `cause.trace` is where the attestation and signature live.
      cause: causeStr,
      name: error?.name ?? null,
    });
    console.warn(`[pay-strand] recorded a failed spend for ${owner} -> ${recipientAddress} (${amountUsdc} USDC)`);
  } catch (writeErr) {
    // Swallowed ON PURPOSE — see the block comment. The original error is what the caller needs.
    console.error(`[pay-strand] RECORD FAILED (swallowed) owner=${owner} — ${writeErr?.message}`);
  }
}
