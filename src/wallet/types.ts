// src/wallet/types.ts
export type WalletKind = "modular" | "metamask";
export const CHAIN_LABEL = "Arc Testnet";

// Execution surface the app's panels depend on. The modular wallet already
// implements these (createJobAsUser/fundJobAsUser); MetaMask implements them
// in Pass 2. Named to match existing call sites so no child component changes.
export interface ExecutingWallet {
  readonly kind: WalletKind;
  readonly address: string | null;
  createJobAsUser(question: string): Promise<bigint>;
  fundJobAsUser(jobId: number, amountUsdc: number): Promise<{ txHash: string }>;
  // Hop A: move USDC from this LOGIN wallet into the user's own agent SCA. The
  // destination is resolved server-side (/api/my-wallet → ensureOwnerWallet(session)) and
  // passed in — both connectors refuse the shared agent wallet. This is the only path by
  // which a per-user agent wallet gets funded, and everything downstream (delegate grant,
  // Gateway deposit, spend) depends on it.
  fundAgentWallet(toAgentSca: string, amountUsdc: number): Promise<{ txHash: string }>;
}

export interface ConnectorInfo {
  kind: WalletKind;
  label: string;
  isAvailable(): boolean;
}
