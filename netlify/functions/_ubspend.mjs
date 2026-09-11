import { AppKit } from "@circle-fin/app-kit";
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";

// UB SPEND PLANE (cross-chain) — the WRITE side of Unified Balance. The agent spends
// USDC from its Arc unified/Gateway balance to a recipient on ANOTHER chain (Base
// Sepolia) via the Forwarding Service.
//
// ⭐⭐ THE SCA SIGNS FOR ITSELF — app-kit >=1.14.0, ERC-1271. Same model as _pay.mjs now:
// from.address = the SPENDER'S OWN SCA (the account that HOLDS the balance IS the account
// that AUTHORISES the spend), source chain Arc_Testnet. There is no delegate here and no
// signer/source split. to = { chain: dest, recipientAddress, useForwarder:true } — NO
// destination adapter; the Forwarding Service submits the destination mint (async).
//
// WHAT THIS REPLACED (2026-09-11, `95635d7`+): `address: DELEGATE_ADDRESS, sourceAccount:
// owner`. Gateway used to accept only ECDSA, so an SCA could not sign its own Gateway spend
// and an authorised EOA (DELEGATE_ADDRESS) signed while funds were drawn from the SCA. That
// left the self-custody property — "the account that holds the balance authorises the spend"
// — TRUE on the same-chain plane (_pay.mjs, fixed 2026-09-10 `c03372a`) and FALSE on this
// cross-chain one. One signing model on both planes; the property is now true everywhere.
//
// 🚨 THE CROSS-CHAIN SIGNATURE IS UNPROVEN THROUGH THE FORWARDER. _pay.mjs proved ERC-1271
// at Gateway on a SAME-CHAIN spend with useForwarder:FALSE. This path is cross-chain with
// useForwarder:TRUE, and the Forwarding Service is a DIFFERENT consumer of that attestation
// that has never seen a contract signature from us. First exercise of this whole path since
// app-kit 1.8.x (2026-07-08, pre-1.14.0). "Should still work" is a prediction until a live
// spend measures it — see PROGRESS.md "THE UB-SPEND FIX, PRE-REGISTERED".
//
// ⚠️ SAME async-waiter quirk as _pay.mjs/_swap.mjs: App Kit's waitForTransaction can throw
// 1098 ("transaction hash required") though the spend lands — caught here, state:"submitted".
//
// ⚠️ NO CAP HERE. The caller (agent-ub-spend.mjs) MUST enforce the per-spend cap and floor
// and reject BEFORE calling this. This executor validates shape + spends only.
//
// ⚠️ NO ENV FALLBACK for the source. `sourceAccount` is a REQUIRED param, resolved by the
// caller from the verified session. Reading AGENT_WALLET_ADDRESS here would let a caller
// that forgot to thread the session silently spend the SHARED wallet's balance — the
// cap-bypass/per-user leak. Missing sourceAccount ⇒ throw, never guess.
//
// ⛔ `DELEGATE_ADDRESS` IS NO LONGER READ ON THIS PATH — and its precondition is gone with it,
// deliberately: a required-check on a variable the path no longer reads would refuse a spend
// for a reason that has stopped existing. The ENV VAR itself STAYS SET: _delegate.mjs and
// _x402-vanilla.mjs still use it, and _ubdeposit.mjs still grants the per-user delegate.
export async function ubSpend({ recipientAddress, amountUsdc, destinationChain = "Base_Sepolia", sourceAccount }) {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const owner = sourceAccount;                      // SCA — holds the balance AND signs (ERC-1271)
  if (!apiKey || !entitySecret) throw new Error("Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET");
  if (!owner) throw new Error("ubSpend requires a `sourceAccount` (the session's agent SCA)");

  const amount = String(amountUsdc);
  const kit = new AppKit();
  const adapter = createCircleWalletsAdapter({ apiKey, entitySecret });

  const params = {
    amount,
    token: "USDC",
    from: [{
      adapter,
      address: owner,           // the SCA holds the balance AND signs for it (ERC-1271)
      // ⭐ NO `allocations` — AUTO-ALLOCATION ENABLED. Supplying the key disables it; omitting it
      // makes the kit call getBalances and allocate greedily: tier 1 = SAME CHAIN AS THE
      // DESTINATION, tier 2 = other non-Ethereum chains by balance descending, tier 3 = Ethereum.
      //
      // 🚨 UNLIKE _pay.mjs, THIS IS NOT A PERMANENT NO-OP. That path is same-chain (Arc -> Arc), so
      // Arc is tier 1 forever. THIS path is CROSS-CHAIN (Arc -> Base_Sepolia), so the destination
      // chain is tier 1 — meaning the moment a Base Sepolia balance exists, auto-allocation will
      // PREFER BASE and stop drawing from Arc. That is the economically right choice (it avoids the
      // crosschain transfer fee entirely) but it is a REAL BEHAVIOUR CHANGE triggered by a DATA
      // condition, with no code change and no deploy.
      //
      // ⚠️ WHAT IS THEREFORE STILL UNPROVEN: a Base_Sepolia-SOURCED draw through the FORWARDER.
      // The signing fix makes the SCA sign for itself (ERC-1271), but that contract signature has
      // only ever been accepted at Gateway on a SAME-CHAIN spend (useForwarder:false, _pay.mjs).
      // A Base-sourced cross-chain draw needs the Forwarding Service — a different consumer of the
      // attestation — to accept it there. Measured 2026-07-30: every wallet's Base Sepolia unified
      // balance is 0.0, so today the greedy pass has exactly one candidate and picks Arc, identical
      // to the old hardcoded allocation. ⭐ THE PROOF SPEND STILL SOURCES FROM ARC (Base is empty):
      // it PROVES THE SHAPE IS ACCEPTED, THE FORWARDER TAKES THE CONTRACT SIG, AND THE ARC PATH
      // STILL WORKS; IT DOES NOT PRE-PROVE THE BASE-SOURCED DRAW. Fund Base and this path changes
      // source chain silently — prove the Base draw through the forwarder BEFORE that happens.
      //
      // Runtime-verified: unified-balance-kit@1.2.1 spendSourceSchema declares
      // `allocations: z.union([...]).optional()`.
    }],
    to: {
      chain: destinationChain,  // e.g. Base_Sepolia
      recipientAddress,         // minted here by the Forwarding Service
      useForwarder: true,       // no destination adapter — the relayer mints
    },
  };

  try {
    const result = await kit.unifiedBalance.spend(params);
    return {
      state: "completed",
      recipientAddress, amountUsdc: amount, destinationChain,
      transferId: result?.transferId ?? null,
      txHash: result?.txHash ?? null,
      explorerUrl: result?.explorerUrl ?? null,
      result,
    };
  } catch (e) {
    const msg = e?.message || "";
    const causeStr = JSON.stringify(e?.cause || {});
    const isAsyncWaiterQuirk =
      e?.code === 1098 ||
      /transaction hash is required/i.test(msg) ||
      (e?.code === 5001 && /transaction hash is required/i.test(causeStr));
    if (isAsyncWaiterQuirk) {
      // Spend submitted; the source burn landed and the destination mint follows.
      return { state: "submitted", pending: true, recipientAddress, amountUsdc: amount, destinationChain };
    }
    throw e;
  }
}
