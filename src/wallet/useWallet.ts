// src/wallet/useWallet.ts
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useModularWallet } from "./useModularWallet";
import {
  connectMetaMask as connectMetaMaskConnector,
  isMetaMaskAvailable,
  type MetaMaskWallet,
} from "./connectors/metamask";
import type { ConnectorInfo, WalletKind } from "./types";

type SessionIdentity = { address: string; method: WalletKind };
type Session = { token: string; exp: number; identity: SessionIdentity };
const SESSION_KEY = "tikpema.session";

export function useWallet() {
  const modular = useModularWallet();
  const [activeKind, setActiveKind] = useState<WalletKind | null>(null);

  // Which wallet the user last interacted with — drives which path's status/busy
  // the panel shows. Distinct from `activeKind` (the connected/executing wallet).
  const [lastTouched, setLastTouched] = useState<WalletKind | null>(null);

  // MetaMask (EOA) path state, held alongside the modular hook.
  const [mmWallet, setMmWallet] = useState<MetaMaskWallet | null>(null);
  const [mmBalance, setMmBalance] = useState<string | null>(null);
  const [mmBusy, setMmBusy] = useState(false);
  const [mmStatus, setMmStatus] = useState("");

  // --- Session auth (Brick 1) ---------------------------------------------
  // The short-lived token proving the connected wallet's owner authorized this
  // browser. Included on money-moving requests. Restored from sessionStorage so
  // a reload doesn't force a re-sign, but only reused for the matching wallet.
  const [session, setSession] = useState<Session | null>(() => {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw) as Session;
      return s?.token && s.exp * 1000 > Date.now() ? s : null;
    } catch {
      return null;
    }
  });
  // Dedupe concurrent auth attempts (e.g. login effect + a hire click racing).
  const authInFlight = useRef<Promise<string> | null>(null);

  const persistSession = useCallback((s: Session | null) => {
    setSession(s);
    try {
      if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* private mode / disabled storage — in-memory session still works */
    }
  }, []);

  const clearSession = useCallback(() => {
    authInFlight.current = null;
    persistSession(null);
  }, [persistSession]);

  const connectRegister = useCallback(
    async (username: string) => {
      setLastTouched("modular");
      clearSession(); // a new wallet must not inherit an old session
      const r = await modular.connectRegister(username);
      setActiveKind("modular");
      return r;
    },
    [modular, clearSession]
  );
  const connectLogin = useCallback(async () => {
    setLastTouched("modular");
    clearSession();
    const r = await modular.connectLogin();
    setActiveKind("modular");
    return r;
  }, [modular, clearSession]);

  const connectMetaMask = useCallback(async () => {
    setLastTouched("metamask");
    clearSession();
    setMmBusy(true);
    setMmStatus("Connecting MetaMask…");
    try {
      const w = await connectMetaMaskConnector();
      setMmWallet(w);
      setMmBalance(await w.refreshBalance().catch(() => null));
      setActiveKind("metamask");
      setMmStatus("");
      return w;
    } catch (e: any) {
      setMmStatus(`Error: ${e?.message || "MetaMask connection failed"}`);
      throw e;
    } finally {
      setMmBusy(false);
    }
  }, [clearSession]);

  // Resolve the active wallet's identity + message signer for auth.
  const authContext = useCallback((): {
    address: string;
    method: WalletKind;
    sign: (message: string) => Promise<string>;
  } | null => {
    if (activeKind === "metamask" && mmWallet) {
      return { address: mmWallet.address, method: "metamask", sign: mmWallet.signMessage };
    }
    if (modular.address) {
      return { address: modular.address, method: "modular", sign: modular.signAuthMessage };
    }
    return null;
  }, [activeKind, mmWallet, modular.address, modular.signAuthMessage]);

  // Return a valid session token for the connected wallet, authenticating (one
  // signature) if we don't already hold a live one. The auth proof is a plain
  // message signature — no funds move. Called lazily before the first protected
  // request, so the passkey account is already deployed by then.
  const ensureSession = useCallback(async (): Promise<string> => {
    const ctx = authContext();
    if (!ctx) throw new Error("Connect a wallet first");

    // Reuse a live token that belongs to THIS wallet.
    if (
      session &&
      session.exp * 1000 > Date.now() + 5000 &&
      session.identity.address.toLowerCase() === ctx.address.toLowerCase()
    ) {
      return session.token;
    }
    if (authInFlight.current) return authInFlight.current;

    // The server speaks "passkey" | "metamask"; our internal kind is "modular".
    const method = ctx.method === "metamask" ? "metamask" : "passkey";

    const run = (async () => {
      const chRes = await fetch("/api/auth-challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: ctx.address, method }),
      });
      const ch = await chRes.json();
      if (!chRes.ok) throw new Error(ch?.error || "Could not start authentication");

      const signature = await ctx.sign(ch.message);

      const vRes = await fetch("/api/auth-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: ctx.address, method, nonce: ch.nonce, signature }),
      });
      const data = await vRes.json();
      if (!vRes.ok) throw new Error(data?.error || "Authentication failed");

      persistSession({ token: data.token, exp: data.exp, identity: data.identity });
      return data.token as string;
    })();

    authInFlight.current = run;
    try {
      return await run;
    } finally {
      authInFlight.current = null;
    }
  }, [authContext, session, persistSession]);

  // Best-effort login-time auth for MetaMask (an EOA is always "deployed", so it
  // verifies immediately). Passkey auth is deferred to the first protected action
  // because the smart account must be deployed (its first user-op) before the
  // server can verify its ERC-1271 signature — so we don't prompt-then-fail here.
  useEffect(() => {
    if (activeKind === "metamask" && mmWallet && !session) {
      ensureSession().catch(() => {
        /* user dismissed the signature — they'll be prompted again at hire */
      });
    }
  }, [activeKind, mmWallet, session, ensureSession]);

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

  const isMetaMask = activeKind === "metamask" && !!mmWallet;
  const onMeta = lastTouched === "metamask";

  return {
    ...modular,
    address: isMetaMask ? mmWallet!.address : modular.address,
    usdcBalance: isMetaMask ? mmBalance : modular.usdcBalance,
    status: onMeta ? mmStatus : modular.status,
    busy: onMeta ? mmBusy : modular.busy,
    refreshBalance: isMetaMask ? mmRefreshBalance : modular.refreshBalance,
    sendUsdc: isMetaMask ? mmWallet!.sendUsdc : modular.sendUsdc,
    createJobAsUser: isMetaMask ? mmWallet!.createJobAsUser : modular.createJobAsUser,
    fundJobAsUser: isMetaMask ? mmWallet!.fundJobAsUser : modular.fundJobAsUser,
    connectRegister,
    connectLogin,
    connectMetaMask,
    activeKind,
    connectors,
    // Session auth surface for the panels.
    ensureSession,
    clearSession,
    sessionIdentity: session?.identity ?? null,
    isAuthenticated: !!session && session.exp * 1000 > Date.now(),
  };
}
