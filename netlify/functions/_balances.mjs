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
import { CONTRACTS, USDC_DECIMALS, USDC_NATIVE_DECIMALS } from "./_arc.mjs";
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

// ═══ 🚨 USDC IS READ NATIVELY. EURC IS READ AS AN ERC-20. THE ASYMMETRY IS THE POINT. ══════════
//
// It looks like an inconsistency somebody forgot to tidy, so: DO NOT MAKE THESE MATCH. On Arc USDC
// is the NATIVE gas token and the 6-dp `balanceOf` view of it is LOSSY — everything below 1e-6 USDC
// is invisible there. EURC is an ordinary ERC-20 with no native view at all; `balanceOf` is the only
// way to read it and is exact.
//
// ⛔ THE DEFECT THIS FIXES, and why it is not cosmetic. This file's own doctrine three paragraphs up
// is that "zero is a CLAIM ('you hold nothing') and an RPC hiccup is not entitled to make it" — and
// it guarded the RPC-failure path to a false zero while leaving the TRUNCATION path wide open.
//
// ⚠️ HONEST SCOPE, AND I GOT THIS WRONG FIRST: the draft of this comment asserted that gas leaves
// residue below the 6-dp floor so wallets "reliably" hold invisible dust. That was a PREDICTION and
// the measurement refutes it — MEASURED 2026-09-10 on both live wallets
// (agent SCA `0x058957de…6947f9e`, `0xc54d…e621`): the two views AGREE EXACTLY,
// native/1e12 == balanceOf, dust = 0.
// So this removes a LATENT falsehood, not one currently being told. It is still the right read:
// Circle's Arc guidance makes the native balance canonical for a wallet display, and the 6-dp view
// is lossy BY CONSTRUCTION whether or not anything is losing digits through it today.
//
// ⚠️ THE TWO VIEWS ARE ONE BALANCE — never summed, never shown as two rows. See _arc.mjs.
// ⚠️ AND THE PRECISION CHANGED: `usdc` is now an 18-dp decimal string, not 6-dp. Renders must round
// (`formatUsdc` already does, and agent-act's sentence now does). A consumer that pins 6 digits is
// asserting the lossy view, which is the thing being removed.

/** The NATIVE USDC balance — the canonical view. 18-dp string, `null` on ANY read failure. */
async function readNativeUsdc(holder) {
  try {
    const raw = await publicClient().getBalance({ address: holder });
    return formatUnits(raw, USDC_NATIVE_DECIMALS);
  } catch {
    return null;
  }
}

/** One ERC-20's balance for one holder, at full precision. `null` on ANY read failure. */
async function readErc20(token, holder) {
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
    readNativeUsdc(walletAddress),
    readErc20(CONTRACTS.EURC, walletAddress),
  ]);
  return { address: walletAddress, usdc, eurc };
}
