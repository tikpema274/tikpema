import { useState } from "react";
import type { ModularWallet } from "../wallet/useModularWallet";

// Shorten an address for readable confirmations: 0x1234…abcd.
const shortAddr = (a: string) =>
  a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

export default function ConnectPasskey({ wallet: w }: { wallet: ModularWallet }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("0.1");
  const [username, setUsername] = useState("");
  const [sendConfirm, setSendConfirm] = useState("");

  const amountNum = Number(amount);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;

  // Presentation wrapper around the unchanged sendUsdc: convert the entered
  // amount to USDC base units and surface a human-readable confirmation on
  // success. The signing path inside sendUsdc is untouched.
  async function send() {
    if (!to || !amountValid) return;
    setSendConfirm("");
    try {
      await w.sendUsdc(to as `0x${string}`, BigInt(Math.round(amountNum * 1e6)));
      setSendConfirm(`Sent ${amountNum} USDC to ${shortAddr(to)}`);
    } catch {
      // w.status already carries the error message for display below.
    }
  }

  return (
    <div className="plane">
      <h2>Human plane</h2>
      <div className="sub">
        Create your wallet here · modular passkey · gasless · keys on device
      </div>

      {!w.address ? (
        <div className="row">
          <input
            placeholder="Choose a username, then tap Register passkey →"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <button
            disabled={w.busy || !username.trim()}
            onClick={() => w.connectRegister(username.trim())}
          >
            Register passkey
          </button>
          <button disabled={w.busy} onClick={() => w.connectLogin()}>
            Login
          </button>
        </div>
      ) : (
        <>
          <div className="mono status">Smart account: {w.address}</div>
          <div className="row" style={{ marginTop: 8 }}>
            <span className="status">
              Balance: {w.usdcBalance ?? "…"} USDC
            </span>
            <button disabled={w.busy} onClick={() => w.refreshBalance()}>
              Refresh
            </button>
            {/* Always reachable for a connected user, regardless of balance. */}
            <a
              className="status"
              href="https://faucet.circle.com"
              target="_blank"
              rel="noreferrer"
              style={{ marginTop: 0 }}
            >
              Get test USDC ↗
            </a>
          </div>
          {w.usdcBalance === "0.00" && (
            <div className="sub">
              Balance is empty — grab some test USDC at{" "}
              <a
                href="https://faucet.circle.com"
                target="_blank"
                rel="noreferrer"
              >
                faucet.circle.com
              </a>
            </div>
          )}
          <div style={{ marginTop: 16 }}>
            <h3 style={{ margin: "0 0 4px" }}>Send</h3>
            <div className="sub">Send test USDC to any address</div>
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
                disabled={w.busy || !to || !amountValid}
                onClick={send}
              >
                {w.busy
                  ? "Sending…"
                  : `Send ${amountValid ? amountNum : 0} USDC`}
              </button>
            </div>
            {sendConfirm && (
              <div className="status" style={{ color: "var(--emerald)" }}>
                {sendConfirm}
              </div>
            )}
          </div>
        </>
      )}

      {w.status && <div className="status">{w.status}</div>}
    </div>
  );
}
