import { useState, useEffect } from "react";
import type { useWallet } from "../wallet/useWallet";
import YourMoney from "./YourMoney";

type UnifiedWallet = ReturnType<typeof useWallet>;

export default function ConnectPasskey({ wallet: w }: { wallet: UnifiedWallet }) {
  const [username, setUsername] = useState("");
  // Whether the deliberate "create a new wallet" sub-flow is showing.
  const [showCreate, setShowCreate] = useState(false);

  // Is there a passkey/wallet already on THIS device? (The stored credential the
  // deterministic-restore login writes to localStorage.) Adapts the copy and
  // keeps the create sub-flow's duplicate-wallet warning honest.
  const hasPasskey = w.hasStoredCredential?.() ?? false;

  // Both pockets the user can actually top up, read from the same shared wallet object the
  // block below reads. Only used to choose which faucet prompt to show — never to gate a
  // control.
  const agentBal = Number(w.agentWallet?.balance ?? 0);
  const loginBal = Number(w.usdcBalance ?? 0);

  // Deep-link intent: the Dashboard's "Set up a new wallet" button routes here as
  // #/wallet?new. Open the existing create sub-flow (which carries the
  // duplicate-wallet guard) and clear the intent so a refresh doesn't re-trigger.
  useEffect(() => {
    if ((window.location.hash.split("?")[1] || "") === "new") {
      setShowCreate(true);
      history.replaceState(null, "", "#/wallet");
    }
  }, []);

  return (
    <div className="plane">
      <div className="panel-eyebrow">Your wallet</div>
      <h2>Your wallet</h2>
      <div className="sub">
        {w.activeKind === "metamask"
          ? "Connected with MetaMask — used only to sign in. Your wallet below holds your funds and pays for jobs, gaslessly."
          : "Secured by a passkey — no password, no seed phrase. Just your fingerprint or face, and it's free to use."}
      </div>

      {!w.address ? (
        !showCreate ? (
          // ── Three explicit entry points ───────────────────────────────────
          // Passkey = sign in (returning user). New wallet = the deliberate
          // create path, which still shows the duplicate-wallet warning when a
          // credential already exists on this device (see the sub-flow below) —
          // the guard is preserved, just no longer hidden behind one button.
          <div style={{ display: "grid", gap: 12, marginTop: 4 }}>
            <div>
              <button
                className="emerald"
                style={{ width: "100%" }}
                disabled={w.busy}
                onClick={() => w.connectLogin().catch(() => {})}
              >
                {w.busy ? "Working…" : "Connect a passkey"}
              </button>
              <div className="sub" style={{ margin: "6px 0 0" }}>
                {hasPasskey
                  ? "Log back into your wallet on this device — Face ID or fingerprint."
                  : "Sign in with Face ID or fingerprint — no seed phrase."}
              </div>
            </div>

            {w.connectors.find((c) => c.kind === "metamask")?.isAvailable() && (
              <div>
                <button
                  style={{ width: "100%" }}
                  disabled={w.busy}
                  onClick={() => w.connectMetaMask().catch(() => {})}
                >
                  Connect MetaMask
                </button>
                <div className="sub" style={{ margin: "6px 0 0" }}>
                  Use your existing MetaMask wallet.
                </div>
              </div>
            )}

            <div>
              <button
                style={{ width: "100%" }}
                disabled={w.busy}
                onClick={() => setShowCreate(true)}
              >
                Set up a new wallet
              </button>
              <div className="sub" style={{ margin: "6px 0 0" }}>
                New here? Create a fresh agent wallet.
              </div>
            </div>
          </div>
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
          {/* ── THE CONNECTED STATE. ───────────────────────────────────────────────────
              This used to be a single card: the agent wallet's address, its USDC + EURC,
              and a Refresh. It showed ONE of the user's three pockets and called it "your
              wallet". The three-card "Your money" block below — moved here from the
              Dashboard, which is no longer where you look for your balance — shows all
              three, each with what it costs to get the money back out.

              The onboarding path above is untouched: not connected → create / restore a
              passkey exactly as before. Only THIS branch changed.

              Everything the old card showed survives: the agent's address and its EURC
              balance live on the "Agent's wallet" pocket; Refresh sits under the block;
              and the faucet link + Disconnect below are kept verbatim, because they exist
              NOWHERE in the block and would have been lost in the move. */}
          <div style={{ color: "var(--success)", fontSize: "0.9rem", fontWeight: 500, marginBottom: 14 }}>
            ✓ Wallet ready
          </div>

          <YourMoney wallet={w} />

          {/* Step 02 — funding. The faucet fills whichever address you paste it, so this
              no longer prescribes one: the block above labels "Your wallet" as the pocket
              to send USDC to, and offers Fund agent → to move it onward.
              The prominent amber version now fires when BOTH pockets are empty — the
              genuine "nothing to do but get test USDC" state. It used to key on the agent
              wallet alone, which shouted "your wallet is empty" at someone who had money
              in their login wallet and simply needed to Fund agent. */}
          {agentBal <= 0 && loginBal <= 0 ? (
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
                Add test USDC
              </div>
              <div style={{ fontSize: "0.9rem", color: "var(--paper-dim)", marginBottom: 12, lineHeight: 1.5 }}>
                Both your wallets are empty. Copy the <b style={{ color: "var(--paper)" }}>Your
                wallet</b> address above, open the faucet, choose{" "}
                <b style={{ color: "var(--paper)" }}>Arc Testnet</b>, paste it, then come back
                and tap Refresh.
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

          {/* Subtle, secondary. Ends the session but KEEPS the stored passkey
              credential (see useWallet.logout) — reconnect restores this exact
              wallet; it never forces a re-register / duplicate wallet. */}
          <div style={{ marginTop: 18 }}>
            <button
              className="linkbtn"
              disabled={w.busy}
              onClick={() => w.logout()}
              style={{ color: "var(--muted)", fontSize: "0.8rem" }}
            >
              Disconnect
            </button>
          </div>
        </>
      )}

      {/* Hidden in the logged-in view: w.status carries "Connected: <login SCA>",
          which is signing plumbing, not the user's funds wallet. Still shown while
          connecting / logged out so connect errors surface. */}
      {w.status && !w.agentWallet && <div className="status">{w.status}</div>}
    </div>
  );
}
