// src/wallet/useWallet.ts
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useModularWallet } from "./useModularWallet";
import {
  connectMetaMask as connectMetaMaskConnector,
  isMetaMaskAvailable,
  type MetaMaskWallet,
} from "./connectors/metamask";
import type { ConnectorInfo, WalletKind } from "./types";
import { errorWithPayload } from "../lib/httpError";
import { readJson } from "../lib/readJson";
import { describeError } from "../lib/describeError";

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
  const [agentWallet, setAgentWallet] = useState<{
    address: string;
    balance: string | null; // USDC
    eurcBalance: string | null; // EURC — a second, distinct amount (not summed)
  } | null>(null);

  // Set when a returning user's SAVED passkey login fails (passkey deleted, wrong
  // device, or the prompt was dismissed). Surfaced as a CLEAR "couldn't log in"
  // state so the user never silently drops back to the create-wallet form and
  // mints a new, empty wallet — the old bug. Recovery is explicit: Try again, or
  // Start over (see startOver).
  const [loginError, setLoginError] = useState<string | null>(null);

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
      setLoginError(null);
      clearSession(); // a new wallet must not inherit an old session
      const r = await modular.connectRegister(username);
      setActiveKind("modular");
      return r;
    },
    [modular, clearSession]
  );

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
      setMmStatus(`Error: ${describeError(e)}`);
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
  const ensureSession = useCallback(async (ctxOverride?: AuthCtx): Promise<string> => {
    // The restore-login path passes an explicit ctx (its just-restored credential)
    // so it doesn't have to wait for React state to flush before authenticating.
    const ctx = ctxOverride ?? authContext();
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

  // Log a returning user back into their EXISTING wallet.
  //   1. Same-device fast path: rebuild the exact wallet from the stored
  //      (non-secret) credential, then authenticate with a TARGETED passkey tap.
  //      Deterministic — it lands on the same address + balance every time.
  //   2. New device / cleared storage: fall back to Circle's discoverable lookup.
  // If the stored credential exists but authentication FAILS, we surface a clear
  // error (loginError) — we do NOT silently fall through to creating a new wallet.
  const connectLogin = useCallback(async () => {
    setLastTouched("modular");
    clearSession();
    setLoginError(null);

    const restored = await modular.restoreLogin().catch(() => null);
    if (restored) {
      setActiveKind("modular");
      try {
        await ensureSession({
          address: restored.address,
          kind: "passkey",
          credentialId: restored.credentialId,
          publicKey: restored.credentialPublicKey,
          signHash: modular.signPasskeyChallenge,
        });
      } catch (e: any) {
        // Stored credential present, but we couldn't authenticate it on this
        // device. Stop here with a clear state — the restored address keeps the
        // create-wallet form hidden, so there is no silent re-register.
        setLoginError(
          "Couldn't log in with your saved passkey. Tap Try again, or Start over to create a new wallet."
        );
        throw e;
      }
      return restored.account;
    }

    // Nothing stored on this device — discoverable lookup (may prompt the user
    // to pick a passkey). On success the credential is persisted for next time.
    const r = await modular.connectLoginDiscoverable();
    setActiveKind("modular");
    return r;
  }, [modular, clearSession, ensureSession]);

  // Explicit escape hatch after a failed saved-passkey login: forget the stored
  // credential and reset to a clean slate so the user can DELIBERATELY create a
  // new wallet. User-initiated only — never a silent fallback.
  const startOver = useCallback(() => {
    modular.clearStoredCredential();
    modular.disconnect();
    clearSession();
    setLoginError(null);
    setActiveKind(null);
    setLastTouched(null);
  }, [modular, clearSession]);

  // Session-only logout: end the session and clear the IN-MEMORY wallet, but
  // deliberately KEEP the stored passkey credential in localStorage. This is
  // startOver MINUS clearStoredCredential — so a returning user reconnects with
  // their passkey (deterministic restore) instead of being pushed to register a
  // new, empty wallet (the duplicate-wallet footgun). Clears both the passkey
  // (modular) and MetaMask in-memory state so the UI returns cleanly to the
  // logged-out entry, not the "Preparing…" limbo clearSession alone would leave.
  const logout = useCallback(() => {
    modular.disconnect(); // in-memory only; does NOT touch the stored credential
    setMmWallet(null);
    setMmBalance(null);
    clearSession();
    setLoginError(null);
    setActiveKind(null);
    setLastTouched(null);
  }, [modular, clearSession]);

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
      setAgentWallet({
        address: data.address,
        balance: data.balance ?? null,
        eurcBalance: data.eurcBalance ?? null,
      });
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
      const data = await readJson(r);
      if (!r.ok) throw new Error(data?.error || "Send failed");
      refreshAgentWallet().catch(() => {});
      return data;
    },
    [ensureSession, refreshAgentWallet]
  );

  // Swap USDC<->EURC from the caller's agent wallet. A single swap is executed as
  // a ONE-STEP plan through /api/agent-execute-plan — the existing structured-
  // action executor. That route enforces the per-action cap + cumulative day-
  // ceiling BEFORE running the step (agent-execute-plan.mjs:104 / :114) and calls
  // the shared executeAction (:128), which runs agentSwap. So this inherits the
  // SAME caps as a swap step in a multi-step plan, and agentSwap/kit.swap is NEVER
  // called directly from the client. No LLM parse, no confirm round-trip: the
  // form's submit IS the confirmation, and the tokens/amount are already structured.
  const swapFromAgent = useCallback(
    async (tokenIn: "USDC" | "EURC", tokenOut: "USDC" | "EURC", amountIn: number) => {
      const token = await ensureSession();
      const plan = [{ type: "swap_tokens", tokenIn, tokenOut, amountIn }];
      const r = await fetch("/api/agent-execute-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ plan }),
      });
      const data = await readJson(r);
      if (!r.ok) throw new Error(data?.error || "Swap failed");
      // The executor returns a per-step result array. A cap/ceiling block comes
      // back as HTTP 200 with results[0].ok=false + a `blocked` reason — so inspect
      // the STEP, not just the HTTP status, and surface the block as an error.
      const step0 = Array.isArray(data?.results) ? data.results[0] : null;
      if (!step0 || step0.ok !== true) {
        throw new Error(step0?.blocked || step0?.error || "Swap did not execute");
      }
      refreshAgentWallet().catch(() => {});
      return step0; // { ok, kind:"swap_tokens", swap, tx } — state lives at swap.state, NOT top level
    },
    [ensureSession, refreshAgentWallet]
  );

  // Bridge USDC cross-chain from the caller's agent wallet. POSTs to the DEDICATED
  // /api/agent-bridge endpoint — the ONE guaranteed cap-enforcing door: it runs the
  // per-bridge cap (AGENT_BRIDGE_CAP_USDC) + live fee-floor + day-ceiling inside the
  // shared executeAction BEFORE any funds move (agent-bridge.mjs:46 → _actions.mjs:91).
  // NOT agent-execute-plan, NOT the bridge kit directly. Returns after the Arc burn
  // lands; the destination mint is async (~10–20 min) — poll with checkBridgeStatus.
  const bridgeFromAgent = useCallback(
    async (amountUsdc: number, destination: string, ackToken?: string) => {
      const token = await ensureSession();
      const r = await fetch("/api/agent-bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ amountUsdc, destination, ackToken }),
      });
      const data = await readJson(r);
      if (!r.ok) throw new Error(data?.error || "Bridge failed");
      // A cap / fee-floor block returns HTTP 200 { executed:false, blocked } — surface
      // it as an error rather than a silent no-op.
      //
      // ⭐ EXCEPT the high-fee band, which is SATISFIABLE: it carries a feeDisclosure and
      // an ackToken, and the caller is meant to show the disclosure and retry WITH the
      // token. Throwing there would turn "confirm you accept this" into "it failed", and
      // the user would have no way to proceed. Returned, not thrown.
      if (data?.executed === false && data?.feeDisclosure?.ackToken) return data;
      if (data?.executed === false) throw new Error(data?.blocked || "Bridge did not execute");
      refreshAgentWallet().catch(() => {});
      return data; // { executed, state, burnHash, tx, destination, feeUsdc, netUsdc } | 202 { pending }
    },
    [ensureSession, refreshAgentWallet]
  );

  // One-shot read of a forwarded bridge's destination-mint status (no polling loop).
  // POSTs the Arc burn hash + destination key to the read-only status endpoint.
  const checkBridgeStatus = useCallback(
    async (burnHash: string, destinationKey: string) => {
      const token = await ensureSession();
      const r = await fetch("/api/agent-bridge-status", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ burnHash, destinationKey }),
      });
      const data = await readJson(r);
      if (!r.ok) throw new Error(data?.error || "Status check failed");
      return data; // { state: "pending" | "minted" | "failed", mintTx?, mintTxHash? }
    },
    [ensureSession]
  );

  // The caller's OWN bridge receipts, owner-scoped SERVER-SIDE from the session — there is
  // no parameter here that selects whose receipts come back.
  //
  // ⭐ This is what makes a reload survivable. burnHash used to live in BridgePanel's
  // component state, so refreshing the page stranded the user with funds mid-flight and no
  // way to ask about them. Persisting server-side without this read would have been
  // localStorage with extra steps: the client could not name the key.
  const listBridgeReceipts = useCallback(async () => {
    const token = await ensureSession();
    const r = await fetch("/api/bridge-receipts", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await readJson(r);
    if (!r.ok) throw new Error(data?.error || "Could not load bridge receipts");
    // `degraded` distinguishes "none in flight" from "we couldn't look" — the caller must
    // not render an empty list as certainty.
    return data as { receipts: any[]; degraded: boolean };
  }, [ensureSession]);

  // ── VAULT AGENT ────────────────────────────────────────────────────────────
  // Inspect an allowlisted ERC-4626 vault (READ-ONLY). Returns the on-chain disclosure plus, if
  // the vault raises a WARN, the exact `ackToken` a deposit must echo back. Moves nothing.
  const inspectVault = useCallback(
    async (vault: string) => {
      const token = await ensureSession();
      const r = await fetch("/api/agent-vault-inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ vault }),
      });
      const data = await readJson(r);
      if (!r.ok) throw new Error(data?.error || "Inspection failed");
      return data; // { vault, inspection, gate, depositable, ackRequired, ackToken }
    },
    [ensureSession]
  );

  // ── DD REPORT (read-only) ──────────────────────────────────────────────────
  // The SAME signed due-diligence report /api/dd-analyze sells over x402, session-authed instead of
  // paid, plus the caller's standing policy evaluated against it.
  //
  // ⚠️ THE FULL REPORT COMES BACK AND IS RETURNED UNTOUCHED. No projection here — the card renders
  // less, the wire carries everything. A client-side trim would be the "lite report" the server
  // deliberately refuses to produce, reintroduced one layer up: the moment the UI reads from a
  // narrower object than the buyer receives, the policy verdict stops being about a verifiable
  // artifact.
  //
  // ⚠️ POLICY IS DISPLAY-ONLY on this cut and the response says so (`policy.authority`). It gates
  // nothing, here or on the server.
  const ddReport = useCallback(
    async (address: string, policy?: unknown) => {
      const token = await ensureSession();
      const r = await fetch("/api/agent-dd-report", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ address, chain: "arc-testnet", ...(policy ? { policy } : {}) }),
      });
      const data = await readJson(r);
      // ⚠️ A REFUSAL IS A REPORT, NOT AN ERROR — the server's whole contract. A 503
      // `service-unverified` carries a full schema-valid body, so throwing away the payload on
      // !r.ok would discard exactly the disclosure the caller needs. Only a genuinely bodiless
      // failure becomes a throw.
      if (!r.ok && !data?.report && !data?.refusal) {
        throw new Error(data?.error || "Could not load the due-diligence report");
      }
      return data as {
        subject?: { address: string; chain: string };
        report?: any;
        policy?: any;
        verifiability?: { attestation: string | null; note: string };
        refusal?: { reason: string; detail: string };
      };
    },
    [ensureSession]
  );

  // ── STANDING POLICY (read-only with respect to money) ──────────────────────────────────────
  // ⚠️ The DIGEST is never sent — it is computed server-side, because a future override token binds
  // to it and a caller-supplied digest would bind an override to rules nobody stored. The server
  // REJECTS a body carrying one rather than ignoring it.
  const getPolicy = useCallback(async () => {
    const token = await ensureSession();
    const r = await fetch("/api/agent-policy", { headers: { Authorization: `Bearer ${token}` } });
    const data = await readJson(r);
    if (!r.ok) throw new Error(data?.error || "Could not read your policy");
    return data as { state: string; meaning: string | null; policy: any; digest: string | null;
                     invalid?: boolean; errors?: string[]; authority: string };
  }, [ensureSession]);

  const savePolicy = useCallback(async (policy: unknown) => {
    const token = await ensureSession();
    const r = await fetch("/api/agent-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ policy }),
    });
    const data = await readJson(r);
    // ⚠️ A REJECTION CARRIES THE REASONS — an unknown group name or an unsatisfiable threshold is
    // actionable, and throwing away `errors` would leave the user with "rejected" and nothing to fix.
    if (!r.ok) throw Object.assign(new Error(data?.error || "Policy rejected"), { errors: data?.errors });
    return data as { ok: true; state: string; meaning: string | null; digest: string; storedAt: string };
  }, [ensureSession]);

  // Deposit USDC into an allowlisted vault. `ackToken` is REQUIRED whenever the vault raised a
  // WARN — the server re-inspects and refuses if it is missing/mismatched (fail-closed), so this
  // only forwards what the user acknowledged; it cannot bypass the gate.
  const depositToVault = useCallback(
    async (vault: string, amountUsdc: number, ackToken?: string) => {
      const token = await ensureSession();
      const r = await fetch("/api/agent-vault-deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ vault, amountUsdc, ackToken }),
      });
      const data = await readJson(r);
      if (!r.ok) {
        // ⭐⭐ THE BODY MUST SURVIVE THE THROW. A gate refusal is a 409 carrying the FRESH
        // `disclosure` — the server says so at agent-vault-deposit.mjs: "carrying the disclosure so
        // the UI can render exactly what must be acknowledged". Throwing `new Error(data.error)`
        // discarded it, so that sentence described a capability with no consumer, and a user whose
        // acknowledgement had been invalidated got a bare refusal with no way to see what changed.
        // ⚠️ Attached rather than returned: every existing caller reads `e.message` and must keep
        // working. The payload is additive.
        throw errorWithPayload(data, "Deposit failed");
      }
      refreshAgentWallet().catch(() => {});
      return data; // { ok, kind:"vault_deposit", depositTx, sharesReceivedRaw, disclosure, ... }
    },
    [ensureSession, refreshAgentWallet]
  );

  // Read the caller's OWN live on-chain share balance in a vault (READ-ONLY). This is on-chain
  // truth, not a session receipt — so a returning user sees shares deposited in a prior session.
  // Throws on a fail-closed read error (the server returns 502 rather than a false zero).
  const vaultShareBalance = useCallback(
    async (vault: string) => {
      const token = await ensureSession();
      const r = await fetch("/api/agent-vault-shares", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ vault }),
      });
      const data = await readJson(r);
      if (!r.ok) throw new Error(data?.error || "Could not read your share balance");
      return data; // { shareBalanceRaw, shareBalanceFormatted, shareSymbol, hasShares, shareDecimals }
    },
    [ensureSession]
  );

  // Reclaim the caller's ENTIRE vault position → USDC in the agent wallet. A reclaim — uncapped and
  // never pause-blocked server-side. NO amount is sent: the server reads the live on-chain balance
  // and redeems exactly it, so a returning user reclaims prior-session shares and nothing can be
  // mis-scaled on the wire.
  const withdrawFromVault = useCallback(
    async (vault: string) => {
      const token = await ensureSession();
      const r = await fetch("/api/agent-vault-withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ vault }),
      });
      const data = await readJson(r);
      if (!r.ok) throw new Error(data?.error || "Withdraw failed");
      refreshAgentWallet().catch(() => {});
      return data; // { ok, reclaimed, withdrawTx?, usdcReceived?, message? }
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
    createJobAsUser: isMetaMask ? mmWallet!.createJobAsUser : modular.createJobAsUser,
    fundJobAsUser: isMetaMask ? mmWallet!.fundJobAsUser : modular.fundJobAsUser,
    // ⭐ METAMASK ONLY, AND `undefined` ELSEWHERE ON PURPOSE. The manual bridge signs with the
    // user's own key; the modular passkey wallet has no equivalent raw-calldata path, and a
    // stub that threw would look like a capability the panel could offer. The panel checks
    // `activeKind === "metamask"` and says so instead.
    manualBridgeBurn: isMetaMask ? mmWallet!.manualBridgeBurn : undefined,
    // Hop A — login wallet → the user's own agent SCA. Same connector-switch as the rest.
    fundAgentWallet: isMetaMask ? mmWallet!.fundAgentWallet : modular.fundAgentWallet,
    connectRegister,
    connectLogin,
    connectMetaMask,
    startOver,
    logout,
    loginError,
    activeKind,
    // ═══ ⭐⭐ PRESENCE, NOT ACTIVITY — and they are DIFFERENT QUESTIONS ═════════════════════════
    // `activeKind` answers "which wallet executes right now". This answers "is a MetaMask wallet
    // connected at all". A panel that can only see the first CANNOT TELL "not connected" from
    // "connected but the passkey wallet is active", and the manual bridge shipped telling the
    // second group to connect the thing they had already connected (PROGRESS.md:407).
    //
    // ⚠️ `connectors[].isAvailable` DOES NOT ANSWER THIS and must not be reached for instead: it
    // means "the extension is installed", which is true for a user who has never connected. The
    // fact needed is `mmWallet` existing, and until now it was held inside this hook and never
    // exported — which is why that defect was not fixable in the panel.
    //
    // ⭐ EXPORTED FOR BOTH MANUAL PANELS, not just the one whose bug found it. A second panel
    // deriving the same state its own way is the duplicate-source-of-truth shape this repo keeps
    // paying for.
    metamaskConnected: !!mmWallet,
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
    swapFromAgent,
    bridgeFromAgent,
    checkBridgeStatus,
    listBridgeReceipts,
    inspectVault,
    ddReport,
    getPolicy,
    savePolicy,
    depositToVault,
    vaultShareBalance,
    withdrawFromVault,
  };
}
