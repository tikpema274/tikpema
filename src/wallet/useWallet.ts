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

  // The user's OWN per-user agent wallet (Brick 2a), provisioned + resolved from
  // the session by /api/my-wallet. Distinct from the login/signing wallet above;
  // not yet used by the job lifecycle (that's 2b).
  const [agentWallet, setAgentWallet] = useState<{ address: string; balance: string | null } | null>(null);

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
    setAgentWallet(null); // a new/cleared session must re-resolve its own wallet
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

  // Resolve the active wallet's identity + how to answer an auth challenge.
  // MetaMask signs a message (ecrecover); passkey signs a hash off-chain
  // (WebAuthn assertion) — no on-chain step, works before the SCA is deployed.
  type AuthCtx =
    | { address: string; kind: "metamask"; signMessage: (m: string) => Promise<string> }
    | {
        address: string;
        kind: "passkey";
        credentialId: string;
        publicKey: string;
        signHash: (h: `0x${string}`) => Promise<{ signature: string; webauthn: unknown }>;
      };
  const authContext = useCallback((): AuthCtx | null => {
    if (activeKind === "metamask" && mmWallet) {
      return { address: mmWallet.address, kind: "metamask", signMessage: mmWallet.signMessage };
    }
    if (modular.address && modular.credentialId && modular.credentialPublicKey) {
      return {
        address: modular.address,
        kind: "passkey",
        credentialId: modular.credentialId,
        publicKey: modular.credentialPublicKey,
        signHash: modular.signPasskeyChallenge,
      };
    }
    return null;
  }, [
    activeKind,
    mmWallet,
    modular.address,
    modular.credentialId,
    modular.credentialPublicKey,
    modular.signPasskeyChallenge,
  ]);

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

    const method = ctx.kind; // server speaks "passkey" | "metamask"

    const run = (async () => {
      const chRes = await fetch("/api/auth-challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: ctx.address,
          method,
          ...(ctx.kind === "passkey" ? { credentialId: ctx.credentialId } : {}),
        }),
      });
      const ch = await chRes.json();
      if (!chRes.ok) throw new Error(ch?.error || "Could not start authentication");

      let verifyBody: Record<string, unknown>;
      if (ctx.kind === "metamask") {
        const signature = await ctx.signMessage(ch.message);
        verifyBody = { address: ctx.address, method, nonce: ch.nonce, signature };
      } else {
        // Passkey: sign the challenge hash → off-chain WebAuthn assertion.
        const { signature, webauthn } = await ctx.signHash(ch.hash);
        verifyBody = {
          address: ctx.address,
          method,
          credentialId: ctx.credentialId,
          publicKey: ctx.publicKey, // used only on first-use registration
          nonce: ch.nonce,
          signature,
          webauthn,
        };
      }

      const vRes = await fetch("/api/auth-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(verifyBody),
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

  // Best-effort login-time auth for BOTH paths. Passkey now verifies OFF-CHAIN
  // (WebAuthn), so it no longer needs a deployed smart account — a fresh passkey
  // user can get a session immediately at login with no on-chain step.
  useEffect(() => {
    if ((activeKind === "metamask" || activeKind === "modular") && !session && authContext()) {
      ensureSession().catch(() => {
        /* user dismissed the passkey/signature — they'll be prompted again at hire */
      });
    }
  }, [activeKind, mmWallet, modular.address, session, ensureSession, authContext]);

  // Resolve (provisioning on first call) the user's OWN agent wallet from their
  // session. Idempotent server-side — a second call returns the same wallet.
  const refreshAgentWallet = useCallback(async () => {
    const token = session?.token;
    if (!token) return null;
    // 202 = "provisioning" (a rare sub-convergence race): the mapping exists but
    // hasn't propagated to reads yet. Retry a few times; the store converges in
    // ~11s. The common paths (first provision, or a returning user) return 200.
    for (let i = 0; i < 6; i++) {
      const r = await fetch("/api/my-wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      });
      if (r.status === 202) {
        await new Promise((res) => setTimeout(res, 3000));
        continue;
      }
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "Could not load your wallet");
      setAgentWallet({ address: data.address, balance: data.balance ?? null });
      return data;
    }
    return null; // still provisioning; a later refresh will resolve it
  }, [session]);

  // Once a session exists (login, hire-time auth, or a restored session), resolve
  // the user's own wallet so the UI can show it. Best-effort.
  useEffect(() => {
    if (session && !agentWallet) refreshAgentWallet().catch(() => {});
  }, [session, agentWallet, refreshAgentWallet]);

  // Send USDC FROM the user's OWN agent wallet (the funded one). The agent wallet
  // is dev-controlled, so the transfer runs server-side (session-resolved) — not
  // the login wallet. Refreshes the agent balance after.
  const sendFromAgent = useCallback(
    async (to: `0x${string}`, amountUsdc: number) => {
      const token = await ensureSession();
      const r = await fetch("/api/agent-send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ to, amountUsdc }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || "Send failed");
      refreshAgentWallet().catch(() => {});
      return data;
    },
    [ensureSession, refreshAgentWallet]
  );

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
    // Per-user agent wallet (Brick 2a): the caller's own provisioned wallet.
    agentWallet,
    refreshAgentWallet,
    sendFromAgent,
  };
}
