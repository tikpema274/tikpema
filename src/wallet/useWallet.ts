// src/wallet/useWallet.ts
import { useState, useMemo, useCallback } from "react";
import { useModularWallet } from "./useModularWallet";
import {
  connectMetaMask as connectMetaMaskConnector,
  isMetaMaskAvailable,
  type MetaMaskWallet,
} from "./connectors/metamask";
import type { ConnectorInfo, WalletKind } from "./types";

export function useWallet() {
  const modular = useModularWallet();
  const [activeKind, setActiveKind] = useState<WalletKind | null>(null);

  // MetaMask (EOA) path state. Held alongside — never replacing — the modular
  // hook, so the modular path stays byte-identical regardless of what connected.
  const [mmWallet, setMmWallet] = useState<MetaMaskWallet | null>(null);
  const [mmBalance, setMmBalance] = useState<string | null>(null);

  const connectRegister = useCallback(
    async (username: string) => {
      const r = await modular.connectRegister(username);
      setActiveKind("modular");
      return r;
    },
    [modular]
  );
  const connectLogin = useCallback(async () => {
    const r = await modular.connectLogin();
    setActiveKind("modular");
    return r;
  }, [modular]);

  const connectMetaMask = useCallback(async () => {
    const w = await connectMetaMaskConnector();
    setMmWallet(w);
    setMmBalance(await w.refreshBalance().catch(() => null));
    setActiveKind("metamask");
    return w;
  }, []);

  // Refresh + cache the MetaMask balance (the modular hook owns its own).
  const mmRefreshBalance = useCallback(async () => {
    if (!mmWallet) return undefined;
    const b = await mmWallet.refreshBalance();
    setMmBalance(b);
    return b;
  }, [mmWallet]);

  const connectors = useMemo<ConnectorInfo[]>(
    () => [
      { kind: "modular", label: "Use a passkey", isAvailable: () => true },
      { kind: "metamask", label: "Connect MetaMask", isAvailable: isMetaMaskAvailable },
    ],
    []
  );

  // Active-path routing: when MetaMask is the last-connected path, the job verbs
  // / address / balance resolve to the MetaMask object; otherwise they resolve
  // to the modular hook EXACTLY as before (each branch is `modular.*`, so the
  // modular path is unchanged). Everything else is spread straight from modular.
  const isMetaMask = activeKind === "metamask" && !!mmWallet;

  return {
    ...modular,
    address: isMetaMask ? mmWallet!.address : modular.address,
    usdcBalance: isMetaMask ? mmBalance : modular.usdcBalance,
    refreshBalance: isMetaMask ? mmRefreshBalance : modular.refreshBalance,
    createJobAsUser: isMetaMask ? mmWallet!.createJobAsUser : modular.createJobAsUser,
    fundJobAsUser: isMetaMask ? mmWallet!.fundJobAsUser : modular.fundJobAsUser,
    connectRegister,
    connectLogin,
    connectMetaMask,
    activeKind,
    connectors,
  };
}
