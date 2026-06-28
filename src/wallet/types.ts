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
}

export interface ConnectorInfo {
  kind: WalletKind;
  label: string;
  isAvailable(): boolean;
}
