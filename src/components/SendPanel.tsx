import { useState } from "react";
import type { useWallet } from "../wallet/useWallet";

type UnifiedWallet = ReturnType<typeof useWallet>;

// Shorten an address for readable confirmations: 0x1234…abcd.
const shortAddr = (a: string) =>
  a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

// SendPanel — the Send USDC form, lifted verbatim out of ConnectPasskey (it was
// co-located there, sharing nothing but the `w` prop). The send() logic and the
// /api/agent-send call it hits are UNCHANGED. Critical: it is gated on
// w.agentWallet exactly as before — Send never appears before a wallet exists.
export default function SendPanel({ wallet: w }: { wallet: UnifiedWallet }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("0.1");
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

  // Gate: mirror the original placement inside ConnectPasskey's `w.agentWallet`
  // truthy branch. Before a wallet is resolved there is nothing to send from.
  if (!w.agentWallet) {
    return (
      <div className="plane">
        <div className="panel-eyebrow">Send</div>
        <h2>Send USDC</h2>
        <div className="sub" style={{ marginBottom: 0 }}>
          Set up your wallet first — open{" "}
          <button className="linkbtn" onClick={() => (window.location.hash = "/wallet")}>
            Wallet
          </button>{" "}
          to connect and fund it, then come back here to send.
        </div>
      </div>
    );
  }

  return (
    <div className="plane">
      <div className="panel-eyebrow">Send</div>
      <h2>Send USDC</h2>
      <div className="sub">From your wallet to any address — gasless on Arc.</div>

      <div
        className="status"
        style={{ marginTop: 0, marginBottom: 18 }}
      >
        Sending from{" "}
        <span className="mono">{shortAddr(w.agentWallet.address)}</span>
        {" · balance "}
        <span className="mono">{w.agentWallet.balance ?? "…"}</span> USDC
      </div>

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
          {sending ? "Sending…" : `Send ${amountValid ? amountNum : 0} USDC`}
        </button>
      </div>
      {sendConfirm && (
        <div className="status" style={{ color: "var(--emerald)" }}>
          {sendConfirm}
        </div>
      )}
      {sendError && (
        <div className="status" style={{ color: "var(--warn)" }}>
          {sendError}
        </div>
      )}
    </div>
  );
}
