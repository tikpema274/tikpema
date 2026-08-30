// decodeSwapCalldata.ts — read the swap the user is ABOUT TO SIGN, out of the bytes themselves.
//
// ═══ 🚨 WHY THIS DECODES BYTES AND NOT THE QUOTE JSON ═══════════════════════════════════════════
// MEASURED (docs/swap-adapter-payer-beneficiary-unbound.md): the AdapterContract does NOT bind the
// payer to the beneficiary. A payload issued for address X executes fine when submitted by a
// DIFFERENT address Y — pulling tokenIn from Y and delivering tokenOut to X. So:
//
//     who PAYS    = msg.sender          (the user, once they sign)
//     who RECEIVES = tokens[].beneficiary (inside the payload the SERVER handed us)
//
// ⛔ AND METAMASK CANNOT SHOW THE DIFFERENCE. It renders an opaque call to the adapter — a `to` and
// a calldata blob. The destination of the user's money appears nowhere in the signing prompt. We are
// the only surface that can show it, which is why this is a PREREQUISITE and not a nicety.
//
// ⭐⭐ AND WHY THE QUOTE JSON WOULD PROVE NOTHING. The threat IS that the response disagrees with the
// request. Reading the pretty fields the server sent alongside the bytes tells you what the server
// SAID; only decoding the bytes tells you what the user will SIGN. If the two ever disagree, the
// bytes win — they are what the chain executes.
//
// ⚠️ THE SERVER ALSO ASSERTS THIS (assertSwapBeneficiary, _swap.mjs). That is NOT a duplicated claim
// — it is the same fact derived independently on the other side of a trust boundary. The server
// checks Circle's response against the server's request; this checks the bytes being signed against
// the USER's own address. Neither can stand in for the other, and a disagreement between them is a
// finding, not a merge conflict. (scripts/verify-swap-calldata-decode.ts pins both against one REAL
// captured payload, so a tuple change that updates one and not the other fails loudly.)
import { decodeFunctionData, getAddress } from "viem";

// IAdapter.execute — copied from @circle-fin/adapter-viem-v2's `adapterContractAbi`. Only the shape
// needed to decode; the SDK is the source and the fixture test is what keeps this honest.
const ADAPTER_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    outputs: [],
    inputs: [
      {
        name: "params", type: "tuple",
        components: [
          {
            name: "instructions", type: "tuple[]",
            components: [
              { name: "target", type: "address" },
              { name: "data", type: "bytes" },
              { name: "value", type: "uint256" },
              { name: "tokenIn", type: "address" },
              { name: "amountToApprove", type: "uint256" },
              { name: "tokenOut", type: "address" },
              { name: "minTokenOut", type: "uint256" },
            ],
          },
          {
            name: "tokens", type: "tuple[]",
            components: [
              { name: "token", type: "address" },
              { name: "beneficiary", type: "address" },
            ],
          },
          { name: "execId", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "metadata", type: "bytes" },
        ],
      },
      {
        name: "tokenInputs", type: "tuple[]",
        components: [
          { name: "permitType", type: "uint8" },
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "permitCalldata", type: "bytes" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
  },
] as const;

export type DecodedSwap = {
  /** The address the OUTPUT is delivered to, read from the calldata. Checksummed. */
  beneficiary: string;
  /** The floor, in minor units, from the tokenOut LEG — not from any index. */
  minTokenOut: bigint;
  /** Unix seconds. The adapter reverts past this (DeadlineExpired, measured). */
  deadline: bigint;
  /** What leaves the wallet, in minor units, from the tokenInputs entry. */
  amountIn: bigint;
  tokenIn: string;
  tokenOut: string;
};

/** A refusal carries a reason the panel can show. It NEVER carries a partial decode. */
export class SwapDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapDecodeError";
  }
}

const eq = (a?: string, b?: string) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Decode the swap out of `calldata`, selecting the output leg BY TOKEN.
 *
 * ⭐ SELECTED BY TOKEN, NEVER BY INDEX. `instructions[0]` is the FEE leg, with `minTokenOut: 0` —
 * reading index 0 alone reports that the swap has no floor at all, which is a wrong conclusion this
 * investigation reached TWICE before it was pinned. An index is a filter, and a filter is a
 * hypothesis. The same rule governs `tokens[]`, whose order is likewise not ours to assume.
 *
 * ⛔ AMBIGUITY THROWS. Every case where the answer cannot be established uniquely — no matching
 * entry, entries that disagree, a token that is both in and out — refuses. The caller must block
 * the signature; there is no partial result and no fallback to a position.
 */
export function decodeSwapCalldata({
  calldata, tokenInAddress, tokenOutAddress,
}: { calldata: string; tokenInAddress: string; tokenOutAddress: string }): DecodedSwap {
  if (!/^0x[0-9a-fA-F]*$/.test(calldata || "") || calldata.length < 10) {
    throw new SwapDecodeError("The swap could not be read: the transaction data is missing or malformed.");
  }
  if (eq(tokenInAddress, tokenOutAddress)) {
    throw new SwapDecodeError("The swap could not be read: input and output are the same token, so the output leg is ambiguous.");
  }

  let args: any;
  try {
    ({ args } = decodeFunctionData({ abi: ADAPTER_ABI, data: calldata as `0x${string}` }));
  } catch {
    // A shape we cannot parse is a shape we cannot describe. Never wave it through.
    throw new SwapDecodeError("The swap could not be read: this does not look like a swap instruction we recognise.");
  }
  const [params, tokenInputs] = args as [any, any];

  // ── the OUTPUT LEG: the instruction whose tokenOut is the token being bought.
  const legs = (params?.instructions ?? []).filter((i: any) => eq(i?.tokenOut, tokenOutAddress));
  if (legs.length === 0) {
    throw new SwapDecodeError("The swap could not be read: it contains no step that produces the token you are buying.");
  }
  const floors = [...new Set(legs.map((l: any) => String(l.minTokenOut)))];
  if (floors.length > 1) {
    throw new SwapDecodeError("The swap could not be read: it contains conflicting minimum amounts, so the guaranteed amount is unclear.");
  }

  // ── the BENEFICIARY: the tokens[] entry for the token being bought.
  const recips = (params?.tokens ?? []).filter((t: any) => eq(t?.token, tokenOutAddress));
  if (recips.length === 0) {
    throw new SwapDecodeError("The swap could not be read: it does not say where the token you are buying would be sent.");
  }
  const dests = [...new Set(recips.map((t: any) => String(t.beneficiary).toLowerCase()))];
  if (dests.length > 1) {
    throw new SwapDecodeError("The swap could not be read: it names more than one destination for the token you are buying.");
  }

  // ── what LEAVES: the tokenInputs entry for the token being sold.
  const inputs = (tokenInputs ?? []).filter((t: any) => eq(t?.token, tokenInAddress));
  if (inputs.length === 0) {
    throw new SwapDecodeError("The swap could not be read: it does not say how much of your token would be spent.");
  }
  const amounts = [...new Set(inputs.map((t: any) => String(t.amount)))];
  if (amounts.length > 1) {
    throw new SwapDecodeError("The swap could not be read: it names more than one amount to spend.");
  }

  let beneficiary: string;
  try { beneficiary = getAddress(dests[0] as string); }
  catch { throw new SwapDecodeError("The swap could not be read: the destination address is malformed."); }

  return {
    beneficiary,
    minTokenOut: BigInt(floors[0] as string),
    deadline: BigInt(params.deadline),
    amountIn: BigInt(amounts[0] as string),
    tokenIn: getAddress(tokenInAddress),
    tokenOut: getAddress(tokenOutAddress),
  };
}

/**
 * ⭐ The panel's gate. Decode, then require the output to land on the CONNECTED wallet.
 * Returns the decode on success; throws with a user-readable reason otherwise. There is no
 * "warn and continue" — a swap whose destination we cannot vouch for is not offered for signature.
 */
export function decodeAndVerifySwap(opts: {
  calldata: string; tokenInAddress: string; tokenOutAddress: string; expectedBeneficiary: string;
}): DecodedSwap {
  const d = decodeSwapCalldata(opts);
  if (!eq(d.beneficiary, opts.expectedBeneficiary)) {
    throw new SwapDecodeError(
      `This swap would send the tokens you are buying to ${d.beneficiary}, which is not your wallet ` +
        `(${getAddress(opts.expectedBeneficiary)}). Refusing to offer it for signature.`
    );
  }
  return d;
}
