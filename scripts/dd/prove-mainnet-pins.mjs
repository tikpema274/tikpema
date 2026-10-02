#!/usr/bin/env node
// prove-mainnet-pins.mjs — DD Morpho V2 step 1, the READ-ONLY chain proof of the registry's Arc mainnet pins.
//
//   npm run probe:mainnetpins        (network; not in test:all)
//
// Reads the pins FROM THE REGISTRY (shared/dd/chains.mjs) and the endpoints FROM endpoints.mjs, so it proves what DD
// will trust, not a copy of it. On BOTH endpoints, at ONE block (resolved on the first, its hash checked on the second):
//   1. eth_chainId === the registry's id;
//   2. every pin: keccak(eth_getCode) === its codeHash;
//   3. the factory attestations for a known instance (Galaxy USDC + its adapter), which step 2's recognition rests on.
// Exit 0 only if every check holds on both. A read failure is UNREADABLE (exit 2), never a pass; a mismatch is exit 1.

import { createPublicClient, http, keccak256, parseAbi } from "viem";
import { getChain } from "../../shared/dd/chains.mjs";
import { ARC_MAINNET_QUORUM_ENDPOINTS } from "../../shared/onchain-analyze/endpoints.mjs";

// A sample instance for the attestation reads (Morpho API + chain, 2026-10-02). Not a pin: instances are recognised by
// attestation, which is exactly what this reads.
const GALAXY = "0x8E357432CC12ff425c36432F312968aEb16112AF";
const GALAXY_ADAPTER = "0xeE0080203a76690BcA40670dfd0cD1C30FAB7c2C";

const chain = getChain("arc-mainnet");
const clients = ARC_MAINNET_QUORUM_ENDPOINTS.map((url) => ({ url, c: createPublicClient({ transport: http(url, { timeout: 20_000 }) }) }));
let bad = 0, unreadable = 0;
const line = (sym, l, x = "") => console.log(`  ${sym} ${l}${x ? ` — ${x}` : ""}`);
const check = (l, cond, x) => { if (cond) line("✅", l, x); else { bad++; line("❌", l, x); } };

try {
  const head = await clients[0].c.getBlockNumber();
  const block = await clients[0].c.getBlock({ blockNumber: head - 5n });
  console.log(`prove-mainnet-pins — ${chain.label} (${chain.id}), block ${block.number} ${block.hash}`);
  const ABI = parseAbi(["function isVaultV2(address) view returns (bool)", "function isMorphoMarketV1AdapterV2(address) view returns (bool)",
    "function adapters(uint256) view returns (address)"]);
  for (const { url, c } of clients) {
    console.log(`\n== ${url}`);
    const id = await c.getChainId();
    check("eth_chainId is the registry's id", id === chain.id, String(id));
    const b = await c.getBlock({ blockNumber: block.number });
    check("same block hash as the first endpoint", b.hash === block.hash, b.hash);
    for (const [name, p] of Object.entries(chain.pins)) {
      const code = await c.getCode({ address: p.address, blockNumber: block.number });
      const h = code && code !== "0x" ? keccak256(code) : null;
      check(`${name} ${p.address}: code hash = pin`, h === p.codeHash, h ?? "NO CODE");
    }
    const at = { blockNumber: block.number };
    check("isVaultV2(Galaxy) on the pinned VaultV2Factory", await c.readContract({ address: chain.pins.vaultV2Factory.address, abi: ABI, functionName: "isVaultV2", args: [GALAXY], ...at }) === true);
    check("Galaxy's adapter(0) is the sample adapter", (await c.readContract({ address: GALAXY, abi: ABI, functionName: "adapters", args: [0n], ...at })).toLowerCase() === GALAXY_ADAPTER.toLowerCase());
    check("isMorphoMarketV1AdapterV2(adapter) on the pinned factory", await c.readContract({ address: chain.pins.morphoMarketV1AdapterV2Factory.address, abi: ABI, functionName: "isMorphoMarketV1AdapterV2", args: [GALAXY_ADAPTER], ...at }) === true);
  }
} catch (e) {
  unreadable++;
  line("⚠️", "UNREADABLE — a read failed; this is NOT a pass", String(e?.shortMessage ?? e?.message ?? e).slice(0, 200));
}

console.log(`\n${"─".repeat(72)}`);
if (unreadable) { console.log("⚠️ UNREADABLE — the proof did not complete (exit 2)."); process.exit(2); }
if (bad) { console.log(`❌ ${bad} check(s) FAILED — the registry does not match the chain.`); process.exit(1); }
console.log("✅ every pin matches the chain on both endpoints, and both attestations hold.");
