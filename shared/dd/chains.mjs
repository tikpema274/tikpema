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
    rpc: "https://rpc.testnet.arc.io",
    explorer: "https://testnet.arcscan.app",
    label: "Arc Testnet",
  },
  // ═══ ARC MAINNET (DD Morpho V2, step 1, 2026-10-02) ══════════════════════════════════════════════════════════
  // ⛔ REGISTERED, NOT SOLD: the paid endpoint still accepts arc-testnet only (_dd-descriptor SUPPORTED_CHAINS, 09-28
  // decision 1). This entry lets DD READ mainnet; selling reports on it is a separate, deliberate step.
  // ⭐ THE PINS: the exact runtime keccak of each singleton the V2 exit path rests on. Read at block 23889038 on BOTH
  // rpc.mainnet.arc.io and arc-mainnet.drpc.org (agreed), REPRODUCED from Morpho's tagged source by a local forge build,
  // verified on explorer.arc.io by T, approved by T (PROGRESS "DD MORPHO V2 — STEP 0"). Instances (vaults, adapters)
  // are NOT pinned by hash (their immutables differ per instance): they are recognised by their factory's attestation.
  // A contract that matched no tagged build would get NO pin and refuse. Changing a pin rotates ddTree: intended.
  // Pinned by test:ddmainnetregistry; proven against the chain by scripts/dd/prove-mainnet-pins.mjs.
  "arc-mainnet": {
    id: 5042,
    rpc: "https://rpc.mainnet.arc.io",
    explorer: "https://explorer.arc.io",
    label: "Arc mainnet",
    pins: Object.freeze({
      morphoBlue: Object.freeze({
        address: "0x34CD04070dD72b14E241112F6d83812Df5Af7fCD",
        codeHash: "0xeb0972f2c33d0d3443136e2c42688082b9eef4ff1594a32e890f4f08669f1b08",
        source: "morpho-blue v1.0.0 (55d2d99), solc 0.8.19, via-IR, 999999 runs, paris",
        match: "masked", // the one immutable, DOMAIN_SEPARATOR, = keccak(typehash, 5042, this): checked
        // ⚠️ THE ONE DEVIATION (T ruled 2026-10-02: pin it, recorded). The tag's foundry.toml appends an ipfs metadata
        // hash; the deployed trailer is `a1 64 'solc' 43 000813` (none). Executable code identical.
        deviation: "built with bytecode_hash=none (the tag's foundry.toml leaves the ipfs default); the deployed metadata trailer carries no hash, solc 0.8.19; executable code identical",
      }),
      adaptiveCurveIrm: Object.freeze({
        address: "0xF02615d094Fc02fC031C35fe705e175aA4653f20",
        codeHash: "0xb89ab90e08f8cf6f3ff4916f5d64d27ea1b86bdcb02c92c18690677184074d43",
        source: "morpho-blue-irm 2025-11-24, its own foundry.toml (999999 runs, paris, bytecode_hash none)",
        match: "masked", // MORPHO immutable = Morpho Blue
      }),
      vaultV2Factory: Object.freeze({
        address: "0x3b0eefaBfa22ec7CF2c73877ac16e78D76749f12",
        codeHash: "0xba55eb73d42937607d7e3c77f68353c2517c4fad4df02f0c9bbd2e4248475503",
        source: "vault-v2 2026-08-13 (2b139002), its own foundry.toml (solc 0.8.28, via-IR, 100000 runs, cancun, bytecode_hash none)",
        match: "exact",
      }),
      morphoMarketV1AdapterV2Factory: Object.freeze({
        address: "0x6C2FF5114E45b50bc7195c2F1f87C98cbdad62Cc",
        codeHash: "0x6b28fe49a51d2abbe3a345b618e16c26b94e381c5390d7532511fd888935c2db",
        source: "vault-v2 2026-08-13 (2b139002), its own foundry.toml",
        match: "masked", // immutables morpho = Morpho Blue, adaptiveCurveIrm = the pinned IRM
      }),
      morphoVaultV1AdapterFactory: Object.freeze({
        address: "0x77788033B22CEaB8D51Ec8F9dFD4a40E54F380B0",
        codeHash: "0x4e1024d5bfd17914a3ca6ad49905eabdfd60122ccd5a577406e7a4a765bd49ad",
        source: "vault-v2 2026-08-13 (2b139002), its own foundry.toml",
        match: "exact",
      }),
    }),
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
