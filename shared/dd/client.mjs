// client.mjs — one client per CHAIN per run, not one per address.
//
// WHAT IT ACTUALLY SAVES. Every check-1 does three RPC calls: eth_chainId (the guard), eth_blockNumber
// (the pin), eth_getCode (the read). Auditing a repo with 20 addresses would fire 60 calls, 40 of them
// re-asking questions whose answers cannot change mid-run. The client memoizes the guard and the pin
// per chain, so the same audit costs 1 + 1 + 20. That is not just speed: Arc's public RPC returned
// "request limit reached" during this session's recon at a handful of calls per second, so the naive
// version would rate-limit itself into a pile of ERROR facts and look like a finding.
//
// ⚠️ THE PIN IS THE REAL PRIZE. One block per chain per run means every fact in a batch describes the
// SAME chain state — a consistent snapshot, not 20 reads smeared across 20 different blocks. Without
// it, "A is empty but B is live" could be an artifact of reading them 40 seconds apart. With it, the
// comparison is sound and a reader can re-run the whole batch at those exact blocks.

import { getChain } from "./chains.mjs";
import { rpcCall, assertChain, resolveBlock } from "./rpc.mjs";

/**
 * A memoizing client for one chain. Guard and pin resolve at most once, lazily.
 *
 * `rpc` overrides the registry endpoint for the SAME chain — used by the quorum layer to reach the
 * same chain through a different provider. The override is deliberately NOT trusted: assertChain()
 * still compares eth_chainId against the registry's declared id, so an alternate endpoint that is
 * actually on another chain is excluded loudly instead of silently contributing a wrong-chain answer.
 */
export function chainClient(chainName, { block, rpc } = {}) {
  const chain = rpc ? { ...getChain(chainName), rpc } : getChain(chainName);
  let guardP = null;
  let blockP = null;

  return {
    chain,
    /** eth_chainId vs the registry. Memoized — one guard per chain per run. Throws on mismatch. */
    assert: () => (guardP ??= assertChain(chain)),
    /** The pinned block for this chain, for this run. Memoized. */
    pin: () => (blockP ??= resolveBlock(chain, block)),
    call: ({ method, params }) => rpcCall({ endpoint: chain.rpc, method, params }),
  };
}

/** Hands out one client per chain name, reusing it across every entry in a batch. */
export function clientPool({ block } = {}) {
  const pool = new Map();
  return {
    for(chainName) {
      if (!pool.has(chainName)) pool.set(chainName, chainClient(chainName, { block }));
      return pool.get(chainName);
    },
    chains: () => [...pool.keys()],
  };
}
