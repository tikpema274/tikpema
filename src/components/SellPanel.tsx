import { useState } from "react";
import type { useWallet } from "../wallet/useWallet";
import { formatUsdc } from "../lib/formatUsdc";
import type { PublicOrder } from "./PayPanel";

type UnifiedWallet = ReturnType<typeof useWallet>;

// ═══ SELL — make a checkout link: "pay ME this much for THIS" ═══════════════════════════════════
//
// Minimal by decision (2026-09-18): amount + description → a `#/pay?order=<id>` link to share. The
// payee is the signed-in user's LOGIN wallet (`w.address`) — the same address Receive shows — and
// that is stated on this page in the same breath as the one thing a seller must know about v1:
// buyers pay DIRECTLY, there is no escrow, and a refund is the seller sending it back. The order is
// created by /api/checkout-create (session-bound; the server names the merchant from the session,
// never from this form), which also refuses an amount above the per-transaction send cap WITH THE
// CAP NAMED — a link nobody can pay is a defect at creation. Nothing here moves money.

/** The link a buyer opens. Origin + the hash route the server returned; composed in ONE place. */
export function checkoutLink(origin: string, orderId: string): string {
  return `${origin}/#/pay?order=${orderId}`;
}

/** The created order, restated as the buyer will see it, with the link. Exported for the copy suite. */
export function SellResult({ origin, order, path }: { origin: string; order: PublicOrder; path: string }) {
  const link = `${origin}${path}`;
  return (
    <div className="status" style={{ borderLeft: "3px solid var(--success)", paddingLeft: ".9rem" }}>
      <b>Checkout link created.</b> Anyone who opens it sees exactly this: <b>{order.description}</b> ·{" "}
      <b>{formatUsdc(order.amountUsdc)} USDC</b> · paid to your wallet.
      <div className="mono" style={{ marginTop: 6, wordBreak: "break-all" }}>{link}</div>
    </div>
  );
}

export default function SellPanel({ wallet: w }: { wallet: UnifiedWallet }) {
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ order: PublicOrder; path: string } | null>(null);
  const [shareNote, setShareNote] = useState("");
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const address = w.address;

  async function create() {
    setError("");
    setCreated(null);
    setBusy(true);
    try {
      const token = await w.ensureSession();
      const r = await fetch("/api/checkout-create", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ amountUsdc: amount.trim(), description }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      setCreated({ order: data.order, path: data.path });
      setAmount("");
      setDescription("");
    } catch (e: any) {
      setError(e?.message || "Could not create the link");
    } finally {
      setBusy(false);
    }
  }

  // Share, else copy — and say which happened. A control that silently does nothing is worse than
  // none (ReceivePanel's rule). Both branches exist because a fallback that only exists on the happy
  // path is the failure this repo keeps finding.
  async function share() {
    if (!created) return;
    const link = `${origin}${created.path}`;
    const canShare = typeof navigator !== "undefined" && typeof (navigator as any).share === "function";
    if (canShare) {
      try {
        await (navigator as any).share({ title: "Pay with USDC on Arc", text: `${created.order.description} — ${formatUsdc(created.order.amountUsdc)} USDC`, url: link });
        return;
      } catch { /* dismissed — fall through to copy */ }
    }
    try {
      await navigator.clipboard.writeText(link);
      setShareNote("Link copied — paste it into a message or email.");
      setTimeout(() => setShareNote(""), 2400);
    } catch {
      setShareNote("Could not copy automatically — select the link above and copy it.");
    }
  }

  return (
    <div className="plane">
      <div className="panel-eyebrow">Sell</div>
      <h2>Make a checkout link</h2>
      <div className="sub">
        Name what you are selling and the price. You get a link; whoever opens it sees exactly that and can pay it
        from their Tikpema agent wallet.
      </div>

      {!address ? (
        <div className="status" style={{ borderLeft: "3px solid var(--warn)", paddingLeft: ".9rem" }}>
          You are not signed in, so there is no wallet to be paid to yet. Open your{" "}
          <button className="linkbtn" onClick={() => (window.location.hash = "/wallet")}>Wallet</button> to get one.
        </div>
      ) : (
        <>
          {/* ⛔ THE SELLER'S SIDE OF THE IRREVERSIBILITY CLAIM, stated where the link is made. */}
          <div className="status" style={{ borderLeft: "3px solid var(--warn)", paddingLeft: ".9rem" }}>
            <b>Payments arrive directly in your wallet</b> — <span className="mono" style={{ wordBreak: "break-all" }}>{address}</span>.
            There is no escrow: Tikpema does not hold the money and cannot reverse a payment. If you owe a buyer a
            refund, that is you sending it back.
          </div>

          <div className="row" style={{ marginTop: 8, alignItems: "center", gap: 8 }}>
            <label className="status" style={{ margin: 0 }}>Amount</label>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              style={{ maxWidth: 140 }}
            />
            <span className="status" style={{ margin: 0 }}>USDC</span>
          </div>
          <div className="row" style={{ marginTop: 8, alignItems: "center", gap: 8 }}>
            <label className="status" style={{ margin: 0 }}>What is it for?</label>
            <input
              placeholder="shown to the buyer"
              maxLength={140}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={{ width: "100%", maxWidth: 520 }}
            />
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="emerald" disabled={busy || !amount || !description.trim()} onClick={create}>
              {busy ? "Creating…" : "Create checkout link"}
            </button>
          </div>
          {error && <div className="status" style={{ color: "var(--warn)" }}>{error}</div>}

          {created && (
            <>
              <SellResult origin={origin} order={created.order} path={created.path} />
              <div className="row" style={{ gap: 12, alignItems: "center" }}>
                <button className="linkbtn" onClick={share}>Share or copy the link</button>
                {shareNote && <span className="status" style={{ margin: 0 }}>{shareNote}</span>}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
