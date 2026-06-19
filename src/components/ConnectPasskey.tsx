import { useState } from "react";
import type { ModularWallet } from "../wallet/useModularWallet";

export default function ConnectPasskey({ wallet: w }: { wallet: ModularWallet }) {
  const [to, setTo] = useState("");
  const [username, setUsername] = useState("");

  return (
    <div className="plane">
      <h2>Human plane</h2>
      <div className="sub">Modular passkey wallet · gasless · keys on device</div>

      {!w.address ? (
        <div className="row">
          <input
            placeholder="choose a username"
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
          </div>
          {w.usdcBalance === "0.00" && (
            <div className="sub">
              Need test USDC? Get some at{" "}
              <a
                href="https://faucet.circle.com"
                target="_blank"
                rel="noreferrer"
              >
                faucet.circle.com
              </a>
            </div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <input
              placeholder="recipient 0x…"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
            <button
              className="emerald"
              disabled={w.busy || !to}
              onClick={() => w.sendUsdc(to as `0x${string}`, 100000n)}
            >
              Send 0.1 USDC
            </button>
          </div>
        </>
      )}

      {w.status && <div className="status">{w.status}</div>}
    </div>
  );
}
