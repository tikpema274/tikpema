import { useState } from "react";
import type { useWallet } from "../wallet/useWallet";
import { describeError } from "../lib/describeError";

type UnifiedWallet = ReturnType<typeof useWallet>;

// Shorten an address for readable confirmations: 0x1234…abcd.
const shortAddr = (a: string) =>
  a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

// ═══ ⭐⭐ THIS PANEL IS CAPPED, AND UNTIL NOW IT NEVER SAID SO ═══════════════════════════════════
// It sends from the user's AGENT wallet through /api/agent-send, which enforces a per-transaction
// cap and a day ceiling. The panel's only description was "From your wallet to any address —
// gasless on Arc": true, and silent about the limits.
//
// 🚨 THE REASON THAT SILENCE HAD TO GO BEFORE THE MANUAL SEND SHIPPED. The manual panel's whole
// job is to say "agent spending caps do not apply here". Stating an absence against SILENCE is
// WORSE THAN SAYING NOTHING — the reader has no stated presence to contrast it with, so the
// sentence reads as noise on one panel and tells them nothing about the other. The contrast only
// exists if BOTH halves are stated, so the presence is stated first.
//
// ⚠️ NO CAP NUMBER HERE, DELIBERATELY. `sendCapUsdc()` reads AGENT_SEND_CAP_USDC from the
// environment (default 5) and is not exposed to the client. A number typed into this file would be
// a second source of truth for a claim about money, and a code default is not the deployed value
// ([[caps-from-deployed-env-not-code-defaults]]). The server names the exact limit when it refuses,
// and that message is the one the user sees.
//
// ⭐ THE DISTINCTION IS IN THE TITLE, not only in body copy. "Send from your agent wallet" vs
// "Send from your own wallet" — two send forms, one capped and one not, is a sharper confusion
// risk than bridge ever had, and a heading is what a scanning reader actually reads.
//
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
      setSendError(describeError(e));
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
        <h2>Send from your agent wallet</h2>
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
      <h2>Send from your agent wallet</h2>
      <div className="sub">From your agent wallet to any address — gasless on Arc.</div>

      {/* ⭐⭐ THE PRESENCE, STATED. Without this the manual panel's "caps do not apply here" has
          nothing to contrast against. No number: the server owns it and names it on refusal. */}
      <div
        className="status"
        style={{ borderLeft: "3px solid var(--accent)", paddingLeft: ".9rem" }}
      >
        <b>Agent spending limits apply here.</b> This sends from your agent wallet, so a
        per-transaction cap and a daily ceiling are enforced on the server — they bound what the
        agent may move on your behalf. If you go over, the error names the exact limit.
      </div>

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
      {/* ⭐ THE DOOR TO THE OTHER SEND. A live route nothing links to is reachable only by typing
          the hash — the state that hid a 22-day outage on #/dca. */}
      <div className="status" style={{ marginTop: 18 }}>
        Want to send from your own wallet instead, with your own key and no agent caps?{" "}
        <button className="linkbtn" onClick={() => (window.location.hash = "/send-manual")}>
          Send from your own wallet
        </button>
      </div>

      {sendError && (
        <div className="status" style={{ color: "var(--warn)" }}>
          {sendError}
        </div>
      )}
    </div>
  );
}
