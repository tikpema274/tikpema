import { AppKit } from "@circle-fin/app-kit";
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";

// SWAP PLANE. App Kit Swap with the Circle Wallets adapter — same dev-controlled
// creds as _circle.mjs, plus the free KIT_KEY for the swap router. This is a
// SEPARATE Circle entry point from _circle.mjs (different client, own execution).
// Arc Testnet supports USDC, EURC, cirBTC only.

export const SWAP_TOKENS = ["USDC", "EURC", "cirBTC"];

function kitAndAdapter() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const kitKey = process.env.KIT_KEY;
  if (!apiKey || !entitySecret) {
    throw new Error("Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET (server env)");
  }
  if (!kitKey) {
    throw new Error("Missing KIT_KEY (server env) — required for App Kit Swap");
  }
  const adapter = createCircleWalletsAdapter({ apiKey, entitySecret });
  return { kit: new AppKit(), adapter, kitKey };
}

// Estimate then execute a same-chain swap on Arc Testnet from the agent wallet.
// tokenIn/tokenOut are symbols from SWAP_TOKENS; amountIn is a human decimal
// string ("1.00"). Returns { estimate, txHash, explorerUrl }.
export async function agentSwap({ walletAddress, tokenIn, tokenOut, amountIn }) {
  const { kit, adapter, kitKey } = kitAndAdapter();
  const swapParams = {
    from: { adapter, chain: "Arc_Testnet", address: walletAddress },
    tokenIn,
    tokenOut,
    amountIn,
    // The agent wallet is a dev-controlled SCA. App Kit defaults to a USDC permit
    // (EIP-2612) signature, but permits use ecrecover, which rejects an SCA's
    // ERC-1271 signature — so the swap fails with "Transaction hash is required".
    // Forcing an onchain approve makes the SCA path work.
    allowanceStrategy: "approve",
    config: { kitKey },
  };
  // estimateSwap is free and gives the expected output up front. Returned to the
  // caller so the UI can show value-out. (Slippage: SDK default for now — add a
  // min-out / impact check here later if tightening is needed.)
  // Capture tx data from lifecycle events. The Circle Wallets (SCA) swap submits
  // async: the transaction lands on-chain, but App Kit's internal waitForTransaction
  // can throw INPUT_VALIDATION_FAILED ("Transaction hash is required") because the
  // hash isn't ready synchronously. The events carry the real hash, so we capture
  // it here and treat that specific post-submission throw as non-fatal.
  let eventTxHash = null;
  let eventExplorerUrl = null;
  kit.on("*", (payload) => {
    const v = payload?.values || payload;
    if (v?.txHash) eventTxHash = v.txHash;
    if (v?.explorerUrl) eventExplorerUrl = v.explorerUrl;
  });

  let estimate, result;
  try {
    estimate = await kit.estimateSwap(swapParams);
    result = await kit.swap(swapParams);
  } catch (e) {
    // The Circle Wallets (SCA) swap submits ASYNCHRONOUSLY: the transaction lands
    // on-chain (EURC arrives), but App Kit's internal waitForTransaction rejects
    // with code 1098 ("Transaction hash is required") because the hash isn't ready
    // synchronously — it loses a race against the async submission. This is NOT a
    // failure: the swap is in flight. Mirror the TxPendingError pattern in
    // _circle.mjs — treat it as submitted-not-confirmed. Prefer an event hash if
    // one arrived; otherwise return submitted with no hash (caller polls/checks).
    const isPostSubmitWaitError =
      e?.code === 1098 ||
      /transaction hash is required/i.test(e?.message || "");
    if (isPostSubmitWaitError) {
      result = {
        txHash: eventTxHash,
        explorerUrl: eventExplorerUrl,
        state: "submitted",
        pending: true,
      };
    } else {
      throw e;
    }
  }
  return {
    estimate,
    txHash: result?.txHash ?? eventTxHash ?? null,
    explorerUrl: result?.explorerUrl ?? eventExplorerUrl ?? null,
    state: result?.state ?? "submitted",
  };
}
