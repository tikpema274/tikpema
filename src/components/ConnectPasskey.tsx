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
      <h2>Create your wallet</h2>
      <div className="sub">
        {w.activeKind === "metamask"
          ? "Connected with MetaMask — used only to sign in. Your wallet below holds your funds and pays for jobs, gaslessly."
          : "Secured by a passkey — no password, no seed phrase. Just your fingerprint or face, and it's free to use."}
      </div>

      {!w.address ? (
        <>
          <div className="row">
            <input
              placeholder="Pick a name for your wallet"
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
            Already have one?{" "}
            <button
              className="linkbtn"
              disabled={w.busy}
              onClick={() => w.connectLogin()}
            >
              Log in with your passkey
            </button>
            {w.connectors.find((c) => c.kind === "metamask")?.isAvailable() && (
              <>
                {"  ·  "}
                <button
                  className="linkbtn"
                  disabled={w.busy}
                  onClick={() => w.connectMetaMask()}
                >
                  Use MetaMask instead
                </button>
              </>
            )}
          </div>
        </>
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
