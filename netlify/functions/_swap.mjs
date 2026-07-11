import { AppKit } from "@circle-fin/app-kit";
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";

// SWAP PLANE. App Kit Swap with the Circle Wallets adapter — same dev-controlled
// creds as _circle.mjs, plus the free KIT_KEY for the swap router. This is a
// SEPARATE Circle entry point from _circle.mjs (different client, own execution).
// Arc Testnet supports USDC, EURC only.

export const SWAP_TOKENS = ["USDC", "EURC"];

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

// Value a token amount in USD via App Kit's cached token rates. USDC is treated
// as ~$1 (no lookup). For other tokens we read the single returned rate entry
// (avoids address-case bugs). Throws if no rate exists — callers fail-safe BLOCK.
export async function valueInUsdc({ token, amount }) {
  const t = String(token).toUpperCase();
  const amt = Number(amount);
  if (t === "USDC") return amt;
  const { kit, kitKey } = kitAndAdapter();
  const r = await kit.getTokenRates({ chain: "Arc_Testnet", tokens: [t], kitKey });
  const entry = Object.values(r?.rates?.Arc_Testnet || {})[0];
  if (!entry?.priceUSD) throw new Error(`no USD rate for ${t} on Arc Testnet`);
  return amt * Number(entry.priceUSD);
}

// Estimate then execute a same-chain swap on Arc Testnet from the agent wallet.
// tokenIn/tokenOut are symbols from SWAP_TOKENS; amountIn is a human decimal
// string ("1.00"). Returns { estimate, txHash, explorerUrl }.
// The swap request, built ONCE so the estimate and the execution can never drift apart.
// A proposal priced with different params than the swap that later executes would be a lie
// at approve time — the same class of bug the bridge avoids by re-pricing from IRIS.
function buildSwapParams({ walletAddress, tokenIn, tokenOut, amountIn }) {
  const { kit, adapter, kitKey } = kitAndAdapter();
  return {
    kit,
    swapParams: {
      from: { adapter, chain: "Arc_Testnet", address: walletAddress },
      tokenIn,
      tokenOut,
      // ⚠️ App Kit REQUIRES a human-decimal STRING here. Passing a number throws
      // "Invalid swap parameters: amountIn: Expected string, received number" — which
      // _proposal.mjs would then swallow as "cannot price it → no proposal", silently making
      // every swap unproposable. Callers used to coerce this themselves (_actions.mjs did,
      // validateSwapProposal didn't); coercing HERE means neither can get it wrong again.
      amountIn: String(amountIn),
      // The agent wallet is a dev-controlled SCA. App Kit defaults to a USDC permit
      // (EIP-2612) signature, but permits use ecrecover, which rejects an SCA's
      // ERC-1271 signature — so the swap fails with "Transaction hash is required".
      // Forcing an onchain approve makes the SCA path work.
      allowanceStrategy: "approve",
      // Explicit 1% slippage cap. USDC/EURC are stablecoins so the rate barely
      // moves, but setting this makes the tolerance intentional rather than relying
      // on an SDK default — the swap reverts rather than filling at a bad rate.
      config: { kitKey, slippageBps: 100 },
    },
  };
}

// READ-ONLY live re-price. The swap analogue of _bridge.mjs's bridgeFee(): _proposal.mjs
// calls this to price a swap proposal from the CHAIN rather than trusting the model's
// numbers, exactly as the bridge re-prices its fee from IRIS. estimateSwap is free and
// moves nothing — no approve, no swap, no signature.
//
// Priced against the USER'S OWN wallet (walletAddress), so the quote is the one that wallet
// would actually get. Throws on any failure — the caller must treat "cannot price it" as
// "cannot honestly propose it" and return null.
export async function estimateSwapOnly({ walletAddress, tokenIn, tokenOut, amountIn }) {
  const { kit, swapParams } = buildSwapParams({ walletAddress, tokenIn, tokenOut, amountIn });
  return kit.estimateSwap(swapParams);
}

export async function agentSwap({ walletAddress, tokenIn, tokenOut, amountIn }) {
  const { kit, swapParams } = buildSwapParams({ walletAddress, tokenIn, tokenOut, amountIn });
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
