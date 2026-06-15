import { useState } from "react";
import { useModularWallet } from "../wallet/useModularWallet";

export default function ConnectPasskey() {
  const w = useModularWallet();
  const [to, setTo] = useState("");
  const [flushNonceStr, setFlushNonceStr] = useState("");

  return (
    <div className="plane">
      <h2>Human plane</h2>
      <div className="sub">Modular passkey wallet · gasless · keys on device</div>

      {!w.address ? (
        <div className="row">
          <button disabled={w.busy} onClick={() => w.connectRegister()}>
            Register passkey
          </button>
          <button disabled={w.busy} onClick={() => w.connectLogin()}>
            Login
          </button>
        </div>
      ) : (
        <>
          <div className="mono status">Smart account: {w.address}</div>
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

          {/* TEMP: flush a stuck/orphaned userOp. Paste the nonce from the
              dashboard (decimal or 0x hex) and flush — removable once cleared. */}
          <div className="row" style={{ marginTop: 12 }}>
            <input
              placeholder="stuck nonce (decimal or 0x…) to flush"
              value={flushNonceStr}
              onChange={(e) => setFlushNonceStr(e.target.value)}
            />
            <button
              disabled={w.busy || !flushNonceStr}
              onClick={() => {
                try {
                  w.flushNonce(BigInt(flushNonceStr.trim()));
                } catch {
                  alert("Invalid nonce — paste a decimal or 0x-hex value");
                }
              }}
            >
              Flush nonce
            </button>
          </div>
        </>
      )}

      {w.status && <div className="status">{w.status}</div>}
    </div>
  );
}
