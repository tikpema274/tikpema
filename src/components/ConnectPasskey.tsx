import { useState } from "react";
import type { useWallet } from "../wallet/useWallet";

type UnifiedWallet = ReturnType<typeof useWallet>;

// Shorten an address for readable confirmations: 0x1234…abcd.
const shortAddr = (a: string) =>
  a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

export default function ConnectPasskey({ wallet: w }: { wallet: UnifiedWallet }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("0.1");
  const [username, setUsername] = useState("");
  const [sendConfirm, setSendConfirm] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  // Whether the deliberate "create a new wallet" sub-flow is showing. Default
  // false: the entry screen leads with ONE passkey button that logs a returning
  // user straight in — creation is not a co-equal primary path anymore.
  const [showCreate, setShowCreate] = useState(false);

  // Is there a passkey/wallet already on THIS device? (The stored credential the
  // deterministic-restore login writes to localStorage.) Drives the smart button.
  const hasPasskey = w.hasStoredCredential?.() ?? false;

  // The one smart passkey action. Returning user on this device → log straight
  // into their existing wallet (deterministic restore); no name prompt, no chance
  // to spawn a duplicate. Genuinely new here → guide them to create a fresh one.
  function handlePasskey() {
    if (w.hasStoredCredential?.()) {
      w.connectLogin().catch(() => {});
    } else {
      setShowCreate(true);
    }
  }

  const amountNum = Number(amount);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;

  // Send from the user's AGENT wallet (the funded one) — resolved server-side
  // from the session. Not the login wallet (which is identity-only now).
  async function send() {
    if (!to || !amountValid) return;
    setSendConfirm("");
    setSendError("");
    setSending(true);
    try {
      await w.sendFromAgent(to as `0x${string}`, amountNum);
      setSendConfirm(`Sent ${amountNum} USDC to ${shortAddr(to)}`);
    } catch (e: any) {
      setSendError(e?.message || "Send failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="plane">
      <div className="panel-eyebrow">Step 01 · Your wallet</div>
      <h2>Your wallet</h2>
      <div className="sub">
        {w.activeKind === "metamask"
          ? "Connected with MetaMask — used only to sign in. Your wallet below holds your funds and pays for jobs, gaslessly."
          : "Secured by a passkey — no password, no seed phrase. Just your fingerprint or face, and it's free to use."}
      </div>

      {!w.address ? (
        !showCreate ? (
          // ── Smart entry: ONE passkey button that does the right thing ──────
          // Returning user → logs in (restore). New user → create sub-flow. No
          // always-available "create" that lets a returning user spawn duplicates.
          <>
            <button
              className="emerald"
              style={{ width: "100%", marginTop: 4 }}
              disabled={w.busy}
              onClick={handlePasskey}
            >
              {w.busy
                ? "Working…"
                : hasPasskey
                ? "Continue with your passkey"
                : "Continue with passkey"}
            </button>
            <div className="sub" style={{ marginTop: 10, marginBottom: 0 }}>
              {hasPasskey
                ? "You have a wallet on this device — this logs you back into it."
                : "Creates your wallet on first use, secured by a passkey."}
            </div>

            {w.connectors.find((c) => c.kind === "metamask")?.isAvailable() && (
              <div className="sub" style={{ marginTop: 12, marginBottom: 0 }}>
                <button
                  className="linkbtn"
                  disabled={w.busy}
                  onClick={() => w.connectMetaMask()}
                >
                  Use MetaMask instead
                </button>
              </div>
            )}

            {/* Deliberate, secondary escape hatch — only for a returning user who
                genuinely wants a different/fresh wallet. Not the default; muted. */}
            {hasPasskey && (
              <div style={{ marginTop: 18 }}>
                <button
                  className="linkbtn"
                  disabled={w.busy}
                  onClick={() => setShowCreate(true)}
                  style={{ color: "var(--muted)", fontSize: "0.8rem" }}
                >
                  Use a different wallet
                </button>
              </div>
            )}
          </>
        ) : (
          // ── Create-a-new-wallet sub-flow (new user, or the escape hatch) ────
          // Honest copy: a new passkey = a FRESH wallet; it does not reach the
          // funds of a wallet you already have.
          <>
            <div
              style={{
                padding: "12px 14px",
                background: "var(--amber-soft)",
                border: "1px solid var(--amber-line)",
                borderRadius: 10,
                marginBottom: 14,
                fontSize: "0.88rem",
                lineHeight: 1.5,
                color: "var(--paper-dim)",
              }}
            >
              <b style={{ color: "var(--paper)" }}>This creates a brand-new wallet</b> with a
              new passkey. It does <b>not</b> access the funds of any wallet you already have.
              {hasPasskey
                ? " You already have a wallet on this device — log in to get back to it (and its balance) instead."
                : " To return to an existing wallet later, log in with its passkey. (Recovery to a previous wallet is coming soon.)"}
            </div>
            <div className="row">
              <input
                placeholder="Pick a name for your new wallet"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && username.trim() && !w.busy)
                    w.connectRegister(username.trim());
                }}
              />
              <button
                className="emerald"
                disabled={w.busy || !username.trim()}
                onClick={() => w.connectRegister(username.trim())}
              >
                {w.busy ? "Creating…" : "Create wallet"}
              </button>
            </div>
            <div className="sub" style={{ marginTop: 12, marginBottom: 0 }}>
              <button
                className="linkbtn"
                disabled={w.busy}
                onClick={() => w.connectLogin().catch(() => {})}
              >
                Log in with your passkey instead
              </button>
              {"  ·  "}
              <button
                className="linkbtn"
                disabled={w.busy}
                onClick={() => setShowCreate(false)}
              >
                Back
              </button>
            </div>
          </>
        )
      ) : w.loginError ? (
        // Saved-passkey login failed. Surface a CLEAR state with explicit
        // recovery — never a silent fall-through to creating a new wallet.
        <div className="status" style={{ marginTop: 10 }}>
          <div style={{ color: "var(--warn)" }}>{w.loginError}</div>
          <div style={{ marginTop: 12, display: "flex", gap: 12, alignItems: "center" }}>
            <button
              className="emerald"
              disabled={w.busy}
              onClick={() => w.connectLogin().catch(() => {})}
            >
              Try again
            </button>
            <button className="linkbtn" disabled={w.busy} onClick={() => w.startOver()}>
              Start over
            </button>
          </div>
        </div>
      ) : !w.agentWallet ? (
        // Connected, but the agent wallet is still resolving from the session
        // (or auth was dismissed). This is the wallet that pays for jobs.
        <div className="status" style={{ marginTop: 10 }}>
          <span className="spinner" /> Preparing your wallet…
          {!w.isAuthenticated && (
            <div style={{ marginTop: 8 }}>
              <button className="linkbtn" onClick={() => w.ensureSession().catch(() => {})}>
                Tap to finish setup
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* The AGENT wallet is the user's wallet: what jobs pay from, what they
              fund, what they send from. The login wallet is identity-only and no
              longer surfaced as a separate fundable wallet. */}
          <div style={{ color: "var(--success)", fontSize: "0.9rem", fontWeight: 500 }}>
            ✓ Wallet ready
          </div>
          <div
            className="status"
            style={{
              marginTop: 10,
              padding: "12px 14px",
              background: "var(--field)",
              border: "1px solid var(--line)",
              borderRadius: 10,
            }}
          >
            <div style={{ color: "var(--muted)", fontSize: "0.75rem", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>
              Your wallet address
            </div>
            <div className="mono" style={{ color: "var(--paper)", wordBreak: "break-all", fontSize: "0.85rem" }}>
              {w.agentWallet.address}
            </div>
            <div className="row" style={{ marginTop: 12, alignItems: "baseline" }}>
              <span style={{ fontSize: "1.35rem", fontWeight: 600, color: "var(--paper)" }}>
                {w.agentWallet.balance ?? "…"}{" "}
                <span style={{ fontSize: "0.85rem", color: "var(--muted)", fontWeight: 400 }}>USDC</span>
              </span>
              <button disabled={w.busy} onClick={() => w.refreshAgentWallet()} style={{ padding: "6px 12px", fontSize: "0.82rem" }}>
                Refresh
              </button>
            </div>
          </div>

          {/* Step 02 — funding. Points at the AGENT wallet (the one jobs pay from)
              so funding here actually unblocks the research loop. */}
          {w.agentWallet.balance === "0.00" ? (
            <div
              style={{
                marginTop: 14,
                padding: "16px 18px",
                background: "var(--amber-soft)",
                border: "1px solid var(--amber-line)",
                borderRadius: 12,
              }}
            >
              <div className="panel-eyebrow" style={{ marginBottom: 6 }}>
                Step 02 · Add test USDC
              </div>
              <div style={{ fontSize: "0.9rem", color: "var(--paper-dim)", marginBottom: 12, lineHeight: 1.5 }}>
                Your wallet is empty. Copy your address above, open the faucet,
                choose <b style={{ color: "var(--paper)" }}>Arc Testnet</b>, paste your
                address, then come back and tap Refresh.
              </div>
              <a
                href="https://faucet.circle.com"
                target="_blank"
                rel="noreferrer"
                style={{ borderBottom: "none" }}
              >
                <button className="emerald" style={{ pointerEvents: "none" }}>
                  Open the faucet ↗
                </button>
              </a>
            </div>
          ) : (
            <div className="sub" style={{ marginTop: 12, marginBottom: 0 }}>
              Need more?{" "}
              <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
                Get test USDC from the faucet ↗
              </a>
            </div>
          )}

          <div
            style={{
              marginTop: 22,
              paddingTop: 20,
              borderTop: "1px solid var(--line)",
            }}
          >
            <h3 style={{ margin: "0 0 4px" }}>Send USDC</h3>
            <div className="sub" style={{ marginBottom: 12 }}>Optional — send from your wallet to any address</div>
            <div className="row">
              <input
                placeholder="recipient 0x…"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setSendConfirm("");
                }}
              />
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <input
                type="number"
                min="0"
                step="0.01"
                style={{ maxWidth: 120 }}
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setSendConfirm("");
                }}
              />
              <span className="status" style={{ margin: 0 }}>
                USDC
              </span>
              <button
                className="emerald"
                disabled={sending || !to || !amountValid}
                onClick={send}
              >
                {sending
                  ? "Sending…"
                  : `Send ${amountValid ? amountNum : 0} USDC`}
              </button>
            </div>
            {sendConfirm && (
              <div className="status" style={{ color: "var(--emerald)" }}>
                {sendConfirm}
              </div>
            )}
            {sendError && (
              <div className="status" style={{ color: "var(--warn)" }}>{sendError}</div>
            )}
          </div>
        </>
      )}

      {w.status && <div className="status">{w.status}</div>}
    </div>
  );
}
