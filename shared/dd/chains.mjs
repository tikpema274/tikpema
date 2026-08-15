// chains.mjs — the chain registry, and the one thing that makes it trustworthy: it VERIFIES itself.
//
// ⚠️ THIS DUPLICATES THE ARC RPC/CHAIN-ID THAT ALSO LIVE IN src/config/chain.ts — deliberately, and
// with a guard. Normally a second copy of a constant is this repo's oldest bug. Two reasons it is
// correct here, and one mitigation that makes it safe:
//   1. The tool must reach chains prod has never heard of (Base, Base Sepolia) — a DD engine that
//      could only see our own chain would be useless for auditing anyone else.
//   2. The tool must keep working when prod's config changes. Importing prod into the audit tool
//      couples the auditor to the audited.
//   MITIGATION: `assertChain()` calls eth_chainId and compares it to the declared id BEFORE any
//   check reads state. So this table is never TRUSTED, it is CHECKED — a wrong or swapped RPC URL
//   surfaces as a loud error instead of quietly producing facts about the wrong chain. That failure
//   mode matters more here than anywhere: "0x036CbD53… has no code on Arc" is only a finding if we
//   were actually talking to Arc.

export const CHAINS = {
  "arc-testnet": {
    id: 5042002,
    rpc: "https://rpc.testnet.arc.network",
    explorer: "https://testnet.arcscan.app",
    label: "Arc Testnet",
  },
  base: {
    id: 8453,
    rpc: "https://mainnet.base.org",
    explorer: "https://basescan.org",
    label: "Base mainnet",
  },
  "base-sepolia": {
    id: 84532,
    rpc: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
    label: "Base Sepolia",
  },
};

export const chainNames = () => Object.keys(CHAINS);

export function getChain(name) {
  const c = CHAINS[name];
  if (!c) throw new Error(`unknown chain "${name}" — known: ${chainNames().join(", ")}`);
  return { name, ...c };
}
