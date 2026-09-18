import { useState } from "react";
import type { useWallet } from "../wallet/useWallet";
import { describeError } from "../lib/describeError";
import { displayAmount } from "../lib/formatAmount";
import { arcTestnet } from "../config/chain";

const EXPLORER = arcTestnet.blockExplorers.default.url;

type UnifiedWallet = ReturnType<typeof useWallet>;

// Shorten an address for readable confirmations: 0x1234…abcd.
const shortAddr = (a: string) =>
  a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

// ═══ ⭐⭐ THE RECEIPT — what /api/agent-send answered, rendered as the server shaped it ═══════════
// A money surface that moves funds and shows no receipt is a defect every surface built on it
// inherits. This panel used to render "Sent N USDC to 0x1234…abcd" and drop the `txHash` the server
// had already returned. Two SUCCESS shapes exist and only one carries a hash:
//   200 { txHash, tx, from }        — confirmed on Arc: show the hash and an explorer link to it.
//   202 { pending, txId, message }  — Circle accepted, not yet confirmed: say SUBMITTED, name the
//                                     Circle id, and show NO tx link (there is no hash yet).
// A pending send rendered as "confirmed", or given an invented link, is the absence-reads-as-safe
// failure. On error there is no receipt at all — only the error. Exported so the post-send states,
// which SSR cannot click into, are rendered with crafted results by verify-send-copy (§9).
//
// ⭐⭐ THE CIRCLE ID IS A DEAD END FOR THE USER (traced 2026-09-18). budget-sweep resolves the
// day-ceiling CHARGE via getTransaction and stores an outcome, never a hash; the client polls
// nothing; no view maps txId → hash. So the 202 must name WHERE the transfer will show up, and the
// place must exist NOW: the agent wallet's own address page on the explorer (every tx from that
// address lists there once it lands) and the Wallet page balance (refreshed after the send and on
// a 30s poll). Hence `agentAddress` — the link is to the WALLET, not to a tx we do not have.
export type SendResult =
  | { txHash: string; tx?: string; from?: string }
  | { pending: true; txId: string; message?: string };

export function SendOutcome({
  result,
  error,
  to,
  amount,
  agentAddress,
}: {
  result: SendResult | null;
  error: string;
  to: string;
  amount: number;
  agentAddress: string;
}) {
  if (error) {
    return (
      <div className="status" style={{ color: "var(--warn)" }}>
        {error}
      </div>
    );
  }
  if (!result) return null;
  if ("txHash" in result) {
    return (
      <div className="status" style={{ borderLeft: "3px solid var(--success)", paddingLeft: ".9rem" }}>
        {/* ⭐ Recipient UNTRUNCATED: an ellipsis hides exactly the characters a wrong paste would
            change (ManualSendPanel's reasoning). The prose above the form may shorten; the receipt
            may not. */}
        Sent <b>{amount} USDC</b> to{" "}
        <span className="mono" style={{ wordBreak: "break-all" }}>{to}</span> ✓ — confirmed on Arc.{" "}
        <a href={`${EXPLORER}/tx/${result.txHash}`} target="_blank" rel="noreferrer">view the transfer ↗</a>
        <div className="mono" style={{ marginTop: 4, fontSize: "0.78rem", wordBreak: "break-all", color: "var(--muted)" }}>
          {result.txHash}
        </div>
      </div>
    );
  }
  return (
    <div className="status" style={{ borderLeft: "3px solid var(--warn)", paddingLeft: ".9rem" }}>
      Submitted <b>{amount} USDC</b> to{" "}
      <span className="mono" style={{ wordBreak: "break-all" }}>{to}</span> — Circle accepted it but it
      has not landed on Arc yet, so there is no transaction hash to show. Circle id{" "}
      <span className="mono">{result.txId}</span>. When it lands it will appear in your agent wallet's
      transaction list —{" "}
      <a href={`${EXPLORER}/address/${agentAddress}`} target="_blank" rel="noreferrer">view the wallet on Arcscan ↗</a>
      {" "}— and in the balance on the Wallet page.
    </div>
  );
}

// ═══ ⭐⭐ PAYMENT LINKS — #/send?to=0x…&amount=5 — AND THE INPUT IS UNTRUSTED ═══════════════════
// A payment link is a URL someone else wrote and sent you. Everything in it is ATTACKER-SUPPLIED,
// so it PREFILLS a form the user then reads and submits; it never pre-authorises anything.
//
// ⛔ THE ONE SECURITY PROPERTY: the recipient stays VISIBLE AND EDITABLE. A link that silently set
// a hidden destination would let a stranger choose where your money goes while the screen showed
// something else — the failure the self-signed confirmation work exists to prevent
// ([[manual-send-confirmation-names-nothing]]). The form is the disclosure; the link only fills it.
//
// ⚠️ A MALFORMED PARAM IS DROPPED, NEVER COERCED. `to` must match the address shape or it does not
// land in the field at all — half-parsing an address into an input the user then submits is worse
// than ignoring it. Same for a non-positive or unparseable amount, which falls back to the default
// rather than to 0 or NaN. [[nan-fail-open-cap-pattern]]
// ⚠️ Read ONCE at mount, not on every render: re-reading would fight the user's own edits.
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
export function paymentLinkParams(hash: string): { to?: string; amount?: string; note?: string } {
  const q = String(hash).split("?")[1];
  if (!q) return {};
  const p = new URLSearchParams(q);
  const out: { to?: string; amount?: string; note?: string } = {};
  const to = (p.get("to") || "").trim();
  if (ADDR_RE.test(to)) out.to = to;
  const amt = Number((p.get("amount") || "").trim());
  if (Number.isFinite(amt) && amt > 0) out.amount = String(amt);
  const note = (p.get("note") || "").trim();
  if (note) out.note = note.slice(0, 120);
  return out;
}

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
  // ⭐ Lazy initialiser, so the link is read exactly once — on mount — and never re-applied over
  // an edit the user has since made.
  const [linked] = useState(() =>
    paymentLinkParams(typeof window === "undefined" ? "" : window.location.hash));
  const [to, setTo] = useState(linked.to ?? "");
  const [amount, setAmount] = useState(linked.amount ?? "0.1");
  const [sendResult, setSendResult] = useState<SendResult | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");

  const amountNum = Number(amount);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;

  // Send from the user's AGENT wallet (the funded one) — resolved server-side
  // from the session. Not the login wallet (which is identity-only now).
  async function send() {
    if (!to || !amountValid) return;
    setSendResult(null);
    setSendError("");
    setSending(true);
    try {
      // The server's answer IS the receipt: 200 {txHash, tx} or 202 {pending, txId}. Keep it as
      // shaped; SendOutcome renders each honestly. (It used to be collapsed to a prose string.)
      const data = await w.sendFromAgent(to as `0x${string}`, amountNum);
      setSendResult(data as SendResult);
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
          {/* ⛔ NOT "connect and fund it". The gate here is `!w.agentWallet` — the wallet EXISTING,
              which follows from a session. Funding is not checked and does not unblock this page,
              so naming it made a precondition out of something that is not one, and sent a user
              with a connected empty wallet looking for a step they did not need. ⚠️ AGENT voice:
              needs a wallet, points at Wallet. Not to be merged with the self-signed voice, which
              needs MetaMask ACTIVE and points at the landing page. */}
          Set up your wallet first — open{" "}
          <button className="linkbtn" onClick={() => (window.location.hash = "/wallet")}>
            Wallet
          </button>{" "}
          to connect one, then come back here to send.
        </div>
      </div>
    );
  }

  return (
    <div className="plane">
      <div className="panel-eyebrow">Send</div>
      <h2>Send from your agent wallet</h2>
      <div className="sub">From your agent wallet to any address — gasless on Arc.</div>

      {/* ⛔ A PREFILLED FORM MUST SAY IT WAS PREFILLED. The fields below came from a link someone
          else wrote, and a reader who assumes they typed them is exactly the reader a payment link
          can rob. Naming the source is what turns attacker-supplied input into a disclosure the
          user can check. ⚠️ The recipient stays visible AND editable — the link fills the form, it
          never pre-authorises a destination. */}
      {linked.to && (
        <div className="status" style={{ borderLeft: "3px solid var(--warn)", paddingLeft: ".9rem" }}>
          <b>Filled in from a payment link.</b> Check the recipient and amount below before you
          send — anyone can create a link, and these values came from whoever sent you this one.
          {linked.note ? <> Their note: “{linked.note}”.</> : null}
        </div>
      )}

      {/* ⭐⭐ THE PRESENCE, STATED. Without this the manual panel's "caps do not apply here" has
          nothing to contrast against. No number: the server owns it and names it on refusal. */}
      <div
        className="status"
        // ⭐⭐ --success, DELIBERATELY NOT --warn. This rail is the contrast to the manual panels'
        // "caps do not apply" — same shape, opposite claim — so sharing their colour would collapse
        // the distinction this block exists to draw. Same axis as jobTimeline's
        // `caution ? --amber : --emerald`. ⛔ Was --accent, which is defined nowhere: the shorthand
        // went invalid at computed-value time and the rail rendered as border-style:none.
        style={{ borderLeft: "3px solid var(--success)", paddingLeft: ".9rem" }}
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
        <span className="mono">{displayAmount(w.agentWallet.balance)}</span> USDC
      </div>

      <div className="row">
        <input
          placeholder="recipient 0x…"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setSendResult(null);
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
            setSendResult(null);
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
      <SendOutcome result={sendResult} error={sendError} to={to} amount={amountNum} agentAddress={w.agentWallet.address} />
      {/* ⭐ THE DOOR TO THE OTHER SEND. A live route nothing links to is reachable only by typing
          the hash — the state that hid a 22-day outage on #/dca. */}
      <div className="status" style={{ marginTop: 18 }}>
        Want to send from your own wallet instead, with your own key and no agent caps?{" "}
        <button className="linkbtn" onClick={() => (window.location.hash = "/send-manual")}>
          Send from your own wallet
        </button>
      </div>
    </div>
  );
}
