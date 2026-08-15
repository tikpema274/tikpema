// code-exists — is there bytecode at this address, on this chain, at this block?
//
// THE ARCENT CHECK. Arcent's README says "The first x402 implementation on Arc Network"; its
// executor hardcodes `usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e'` and calls
// transferWithAuthorization on it. That address is Base Sepolia's USDC. On Arc it holds NO CODE, so
// the call can only ever hit a non-contract. One `eth_getCode` settles a headline claim that a
// hackathon jury, a README and a badge all missed.
//
// ⚠️ THIS CHECK DOES NOT CONCLUDE. It reports `hasCode: false`. It does NOT report "broken",
// "fake", or "fails". Empty bytecode is damning for a token the code calls, and completely normal
// for an EOA — the difference is context a human has and this function does not. Handing that
// judgement to the engine would make it wrong in exactly the cases that matter most.
//
// `codeHash` is here for check 2: the same bytecode hash appearing on another chain is what turns
// "this address is empty here" into "…because it was copy-pasted from over there".

import { observed, failed, sha256, normalizeAddress } from "../fact.mjs";
import { chainClient } from "../../../shared/dd/client.mjs";

export const id = "code-exists";
export const describe = "eth_getCode at a pinned block: does this address hold bytecode on this chain?";
export const usage = "--address 0x… --chain <name> [--block <n>]";

/**
 * @param {object} a
 * @param {object} [a.client] - a pooled chainClient. Supplied by the batch runner so the guard and
 *   the block pin resolve ONCE per chain instead of once per address. Omitted (CLI single-shot), we
 *   make our own. The fact shape is identical either way — this is an internal economy, not a
 *   contract change.
 */
export async function run({ address, chain: chainName, block, client }) {
  const input = { address, chain: chainName ?? client?.chain?.name, block: block ?? null };

  // Reject junk AT THE GATE. A malformed address must never reach an RPC and come back as
  // something that reads like "no code here".
  const addr = normalizeAddress(address);
  if (!addr) return failed({ check: id, input, error: `not a 20-byte hex address: ${JSON.stringify(address)}` });

  let c;
  try {
    c = client ?? chainClient(chainName, { block });
  } catch (e) {
    return failed({ check: id, input, error: e });
  }
  const chain = c.chain;

  try {
    // Guard first: are we really talking to the chain we claim? Then pin the block. Both memoized
    // on the client, so in a batch this costs nothing after the first address.
    const chainId = await c.assert();
    const blk = await c.pin();

    const { result, query, evidence } = await c.call({
      method: "eth_getCode",
      params: [addr, blk.tag],
    });

    const bytes = result === "0x" ? 0 : (result.length - 2) / 2;
    return observed({
      check: id,
      input: { ...input, address: addr },
      result: {
        hasCode: bytes > 0,
        bytecodeBytes: bytes,
        codeHash: bytes > 0 ? sha256(result) : null,
        chainId,
        blockNumber: blk.number,
        blockPinnedBy: blk.pinnedBy,
      },
      evidence: { ...evidence, bytecode: result },
      query: { ...query, explorer: `${chain.explorer}/address/${addr}` },
    });
  } catch (e) {
    // Transport/JSON-RPC/chain-mismatch failure. NOT a fact — carries no result, so nothing
    // downstream can read this as "the address is empty".
    return failed({ check: id, input, error: e, query: e.query ?? null });
  }
}
