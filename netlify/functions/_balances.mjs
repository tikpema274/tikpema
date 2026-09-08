// _balances.mjs — ONE PRODUCER FOR "WHAT DOES THIS WALLET HOLD ON ARC".
//
// ═══ ⭐⭐ WHY THIS IS A MODULE AND NOT TWO COPIES ═══════════════════════════════════════════════
// Two surfaces now answer the same question about the same wallet: the My Agent panel renders
// `my-wallet`'s numbers, and the agent itself answers `show_balance` in a sentence. Those are two
// renderings of ONE fact, and a claim copied into a second place always drifts — the sentence would
// eventually disagree with the number printed directly above it, on the same screen, at the same
// moment. So there is one read, and both surfaces are readers of it.
// [[duplicate-source-of-truth-is-the-recurring-bug]] · [[one-claim-two-producers]]
//
// ⛔ THIS IS NOT A GENERAL BALANCE LAYER. Eleven other call sites read balanceOf for their own
// purposes (a pre-flight before a send, a swap's input check, the DCA tick). Those are GUARDS
// reading a quantity to decide something, not producers of a user-facing claim, and folding them in
// here would be a refactor of the money path disguised as a tidy-up. What is shared here is
// precisely the pair of surfaces that must agree in front of the user.
//
// ═══ ⭐⭐ FULL PRECISION AT THE PRODUCER, ROUNDING ONLY AT A RENDER ════════════════════════════
// `my-wallet` used to return .toFixed(2) on a 6-dp token and every consumer inherited the loss —
// including one doing arithmetic on it. That rounding cannot live here: a producer that rounds
// makes the loss unrecoverable for all readers at once. formatUnits, nothing else.
//
// ═══ ⛔ A BALANCE THAT COULD NOT BE READ IS `null`, NEVER `0` ══════════════════════════════════
// Zero is a CLAIM ("you hold nothing") and an RPC hiccup is not entitled to make it. A reader that
// sees null must say so — "…" on a panel, "could not read" in a sentence — and must never let the
// absence read as an empty wallet. [[absence-must-never-read-as-safe]]

import { formatUnits } from "viem";
import { CONTRACTS, USDC_DECIMALS } from "./_arc.mjs";
import { publicClient } from "./_predict.mjs";

const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

/** One token's balance for one holder, at full precision. `null` on ANY read failure. */
async function readOne(token, holder) {
  try {
    const raw = await publicClient().readContract({
      address: token,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [holder],
    });
    return formatUnits(raw, USDC_DECIMALS);
  } catch {
    return null;
  }
}

/**
 * The two Arc tokens this app deals in, for one wallet.
 *
 * ⚠️ RETURNED AS TWO AMOUNTS, NEVER SUMMED. EURC is not a dollar; adding them would mint a
 * "total" that is true in no currency. Any surface wanting one figure has to choose a rate and
 * own that choice explicitly.
 *
 * ⚠️ INDEPENDENT READS. One token failing degrades to the other rather than losing both — the
 * same allSettled discipline gateway-balance uses per chain.
 */
export async function walletTokenBalances({ walletAddress }) {
  if (!walletAddress) throw new Error("walletTokenBalances requires a walletAddress");
  const [usdc, eurc] = await Promise.all([
    readOne(CONTRACTS.USDC, walletAddress),
    readOne(CONTRACTS.EURC, walletAddress),
  ]);
  return { address: walletAddress, usdc, eurc };
}
