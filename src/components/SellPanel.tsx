import { useState, useEffect, useCallback } from "react";
import { goToWalletAndReturn } from "../lib/returnTo";
import type { useWallet } from "../wallet/useWallet";
import { formatUsdc } from "../lib/formatUsdc";
import { describeError } from "../lib/describeError";
import { arcTestnet } from "../config/chain";
import AddressDisplay from "./AddressDisplay";
import type { PublicOrder } from "./PayPanel";

type UnifiedWallet = ReturnType<typeof useWallet>;
const EXPLORER = arcTestnet.blockExplorers.default.url;

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

/** One row of the merchant's listing: the public view plus the merchant's own fields (checkout-list). */
export type LateReport = { txHash: string; by: string; at: string; verified: false } | { unreadable: true } | null;
export type MerchantOrderRow = PublicOrder & { paidBy?: string | null; paidUnits?: string | null; paidAtBlock?: number | null; lateReport?: LateReport };
export type MerchantListState =
  | { state: "loading" }
  | { state: "unreadable"; reason: string }
  | { state: "listed"; orders: MerchantOrderRow[]; listedAt: string; truncated: boolean; total?: number };

const LAG_LINE = "This list can lag by a few seconds — a link made moments ago may not be listed yet.";

function CopyLink({ link }: { link: string }) {
  const [note, setNote] = useState("");
  return (
    <span className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
      <span className="mono" style={{ wordBreak: "break-all", fontSize: ".85rem" }}>{link}</span>
      <button className="linkbtn" onClick={async () => { try { await navigator.clipboard.writeText(link); setNote("copied"); } catch { setNote("select and copy"); } }}>Copy</button>
      {note && <span className="status" style={{ margin: 0 }}>{note}</span>}
    </span>
  );
}

// ═══ YOUR CHECKOUT LINKS — the merchant's own orders, from /api/checkout-list ════════════════════
//
// A merchant who lost the tab had no way to find a link again (live, 2026-09-19). This lists what the
// session's m:<merchant>:* index holds. Two rules the copy carries:
//   ⚠️ THE LISTING IS EVENTUAL. An empty result is never rendered as "you have no orders": it says
//      nothing is LISTED, that a link made seconds ago may be missing, and that absence of a row is not
//      absence of an order. Unreadable is a THIRD state, distinct from empty. [[absence-must-never-read-as-safe]]
//   ⛔ NOTHING INVENTED. A paid row shows its real hash and an explorer link to THAT hash; a submitted
//      row has a Circle id and NO tx link; an unbound legacy row (no createdAtBlock) says "cannot be
//      settled — make a new link" in the pay page's words and offers no link to share.
// No cancel here — a separate decision. Nothing here moves money.
/**
 * The collapsed header's text — the ONE place the count is stated, so the honesty rules live in one
 * function: loading says "listing…" (no number); unreadable shows NO number (neither zero nor a total is
 * known); empty says "(none listed yet)" (never "(0)", which claims a known total against an eventual
 * listing); truncated states the server's total, never the page's 100.
 */
export function listHeader(state: MerchantListState): string {
  const base = "Your checkout links";
  if (state.state === "loading") return `${base} (listing…)`;
  if (state.state === "unreadable") return base;
  if (state.orders.length === 0) return `${base} (none listed yet)`;
  if (state.truncated) return `${base} (${typeof state.total === "number" ? state.total : `${state.orders.length}+`})`;
  return `${base} (${state.orders.length})`;
}

// ⛔ CANCEL (2026-09-19): the merchant's control, on OPEN rows only (incl. unbound legacy — cleanup). Not on
// submitted (money in flight), never on paid. Inline confirm names the consequence; the server re-checks
// everything (session = the record's merchant; the matrix; CAS against a concurrent payment). A cancelled
// row that carries a LATE REPORT — a payment the buyer reported after the cancel, NOT verified by us —
// warns the merchant to check their wallet: the buyer's real money must never reach a merchant who is
// told nothing.
export function MerchantOrders({ origin, state, open, onToggle, onRefresh, onCancel, confirmingId: confirmingProp }: {
  origin: string; state: MerchantListState; open: boolean; onToggle: () => void; onRefresh: () => void;
  onCancel?: (id: string) => Promise<void>;
  /** Test/preview seam: which row shows its inline confirm. */
  confirmingId?: string | null;
}) {
  const [confirmingLocal, setConfirming] = useState<string | null>(null);
  const [cancelNote, setCancelNote] = useState<Record<string, string>>({});
  const confirmingId = confirmingProp ?? confirmingLocal;
  async function doCancel(id: string) {
    if (!onCancel) return;
    setCancelNote((n) => ({ ...n, [id]: "Cancelling…" }));
    try { await onCancel(id); setCancelNote((n) => ({ ...n, [id]: "" })); }
    catch (e: any) { setCancelNote((n) => ({ ...n, [id]: describeError(e) })); }
    finally { setConfirming(null); }
  }
  return (
    <div style={{ marginTop: 28 }}>
      <div className="row" style={{ alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        {/* Collapsed by default: the header carries the (honest) count; everything else is behind the
            click. The empty state's "absence of a row is not absence of an order" line lives on EXPAND
            — the header says "(none listed yet)", which is already not a claim of zero. */}
        <button className="linkbtn" aria-expanded={open} onClick={onToggle} style={{ fontSize: "1.05rem", fontWeight: 600 }}>
          {open ? "▾" : "▸"} {listHeader(state)}
        </button>
        {open && <button className="linkbtn" onClick={onRefresh}>Refresh</button>}
      </div>
      {!open ? null : (
      <>
      {state.state === "loading" && <div className="status">Listing your checkout links…</div>}
      {state.state === "unreadable" && (
        <div className="status" style={{ borderLeft: "3px solid var(--warn)", paddingLeft: ".9rem" }}>
          <b>Your links could not be listed right now</b> ({state.reason}). This says nothing about whether you have
          any — try Refresh.
        </div>
      )}
      {state.state === "listed" && state.orders.length === 0 && (
        <div className="status">
          <b>No checkout links listed for this wallet yet.</b> {LAG_LINE} Absence of a row is not absence of an
          order — if you just made one, Refresh in a moment.
        </div>
      )}
      {state.state === "listed" && state.orders.length > 0 && (
        <>
          <div className="status" style={{ marginTop: 4 }}>
            {state.truncated ? <><b>Showing the newest 100 of {state.total ?? "more"}</b> — not all are listed. </> : null}
            {LAG_LINE}
          </div>
          {state.orders.map((o) => {
            const unbound = o.createdAtBlock === null || o.createdAtBlock === undefined;
            return (
              <div key={o.id} className="summary-block" style={{ marginTop: 10 }}>
                <div className="summary-row"><span>For</span><b>{o.description}</b></div>
                <div className="summary-row"><span>Amount</span><b className="mono">{formatUsdc(o.amountUsdc)} USDC</b></div>
                <div className="summary-row"><span>Status</span><b>{o.status}</b></div>
                <div className="summary-row"><span>Created</span><span title={o.createdAt}>{new Date(o.createdAt).toLocaleString()}</span></div>
                <div className="summary-row"><span>Order</span><span className="mono" style={{ wordBreak: "break-all" }}>{o.id}</span></div>
                {o.status === "cancelled" ? (
                  <div className="summary-row"><span>Cancelled</span><span>{o.cancelledAt ? new Date(o.cancelledAt).toLocaleString() : "by you"} — the link is void; nobody can pay it</span></div>
                ) : unbound ? (
                  <div className="summary-hazard">
                    <b>This link cannot be settled — make a new link.</b> It predates payment binding (no creation block);
                    the pay page offers no seal on it and the server refuses any payment of it.
                  </div>
                ) : (
                  <div className="summary-row"><span>Link</span><CopyLink link={checkoutLink(origin, o.id)} /></div>
                )}
                {o.status === "cancelled" && o.lateReport && "unreadable" in o.lateReport && (
                  <div className="summary-hazard">⚠️ Could not read whether a payment was reported against this cancelled order — check your wallet.</div>
                )}
                {o.status === "cancelled" && o.lateReport && "txHash" in o.lateReport && (
                  <div className="summary-hazard">
                    <b>⚠️ A payment was reported after you cancelled</b> ({new Date(o.lateReport.at).toLocaleString()}) —{" "}
                    <b>not verified</b> by Tikpema. Check your wallet:{" "}
                    <span className="mono" style={{ wordBreak: "break-all" }}>{o.lateReport.txHash}</span>{" "}
                    <a href={`${EXPLORER}/tx/${o.lateReport.txHash}`} target="_blank" rel="noreferrer">view on Arcscan ↗</a>.
                    If it is real, you may owe the buyer a refund — that is you sending it back.
                  </div>
                )}
                {o.status === "open" && onCancel && (
                  confirmingId === o.id ? (
                    <div className="summary-hazard">
                      <b>Void this link?</b> Anyone holding it will see it as cancelled and cannot pay it. A payment already
                      sent cannot be undone — if one lands after this, you will see it here and may owe a refund.{" "}
                      <button className="linkbtn" onClick={() => doCancel(o.id)}>Yes, cancel it</button> ·{" "}
                      <button className="linkbtn" onClick={() => setConfirming(null)}>Keep it</button>
                    </div>
                  ) : (
                    <div className="summary-row"><span></span><span><button className="linkbtn" onClick={() => setConfirming(o.id)}>Cancel link</button>{cancelNote[o.id] ? <> · <span className="status" style={{ margin: 0 }}>{cancelNote[o.id]}</span></> : null}</span></div>
                  )
                )}
                {o.status === "paid" && o.paidTx && (
                  <div className="summary-row">
                    <span>Paid</span>
                    <span>
                      <span className="mono" style={{ wordBreak: "break-all" }}>{o.paidTx}</span>{" "}
                      <a href={`${EXPLORER}/tx/${o.paidTx}`} target="_blank" rel="noreferrer">view the transfer ↗</a>
                      {o.paidAt ? <> · {new Date(o.paidAt).toLocaleString()}</> : null}
                      {o.paidBy ? <> · from <AddressDisplay address={o.paidBy} /></> : null}
                    </span>
                  </div>
                )}
                {o.status === "submitted" && (
                  <div className="summary-row">
                    <span>Submitted</span>
                    <span>accepted by Circle{o.circleId ? <> (Circle id <span className="mono">{o.circleId}</span>)</> : null}, not yet landed on Arc — <b>not paid</b> yet; no transaction hash</span>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
      </>
      )}
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
  const [list, setList] = useState<MerchantListState>({ state: "loading" });
  const [listOpen, setListOpen] = useState(false); // collapsed by default; a create opens it
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const address = w.address;

  // The merchant's own orders. Session-bound on the server (the prefix comes from the token). Refetched
  // after a create, knowing the listing may still lag — the copy says so.
  const refreshList = useCallback(async () => {
    if (!address) return;
    setList({ state: "loading" });
    try {
      const token = await w.ensureSession();
      const r = await fetch("/api/checkout-list", { headers: { Authorization: `Bearer ${token}` } });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setList({ state: "unreadable", reason: data?.error || `HTTP ${r.status}` }); return; }
      setList({ state: "listed", orders: Array.isArray(data.orders) ? data.orders : [], listedAt: data.listedAt, truncated: !!data.truncated, total: data.total });
    } catch (e: any) {
      setList({ state: "unreadable", reason: describeError(e) });
    }
  }, [address, w]);
  useEffect(() => { if (address) refreshList().catch(() => {}); }, [address, refreshList]);
  // The order just created is pinned at the TOP of the rows even before the eventual listing carries
  // it (dedupe by id once it does). The merchant sees what they just made without hunting.
  const withCreated: MerchantListState = (() => {
    const c = created?.order;
    if (!c || list.state !== "listed") return list;
    if (list.orders.some((o) => o.id === c.id)) return list;
    return { ...list, orders: [c, ...list.orders] };
  })();

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
      setListOpen(true); // show what was just made, at the top, without hunting
      refreshList().catch(() => {});
      setAmount("");
      setDescription("");
    } catch (e: any) {
      // describeError, never `e?.message || "…"`: an empty-message throw must not become a confident
      // sentence about what failed (verify-error-honesty).
      setError(describeError(e));
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
          <button className="linkbtn" onClick={goToWalletAndReturn}>Wallet</button> to get one.
        </div>
      ) : (
        <>
          <div className="status row" style={{ marginTop: 0, marginBottom: 18, gap: 8, alignItems: "baseline" }}>
            <span>Paid to</span> <AddressDisplay address={address} />
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
          {/* ⭐ THE SUMMARY BLOCK (the Swap/Pay shape): what the buyer will see, the mechanic, and the
              seller's side of the irreversibility claim bordered off as a hazard — stated where the link
              is made, above the seal. The payee address is UNTRUNCATED here. */}
          <div className="summary-block">
            <div className="summary-row"><span>Buyer sees</span><b>{description.trim() || "—"}</b></div>
            <div className="summary-row"><span>Amount</span><b className="mono">{amount ? `${amount} USDC` : "—"}</b></div>
            <div className="summary-row"><span>Paid to</span><AddressDisplay address={address} /></div>
            <div className="summary-row"><span>Settlement</span><span>direct — the buyer's agent wallet pays your wallet on Arc; no escrow</span></div>
            <div className="summary-hazard">
              <b>Payments arrive directly in your wallet and cannot be reversed by Tikpema.</b> Tikpema does not hold
              the money. If you owe a buyer a refund, that is you sending it back.
            </div>
          </div>
          <button className="emerald btn-wide" disabled={busy || !amount || !description.trim()} onClick={create}>
            {busy ? "Creating…" : "Create checkout link"}
          </button>
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

          <MerchantOrders
            origin={origin}
            state={withCreated}
            open={listOpen}
            onToggle={() => setListOpen((o) => !o)}
            onRefresh={() => { refreshList().catch(() => {}); }}
            onCancel={async (id) => {
              const token = await w.ensureSession();
              const r = await fetch("/api/checkout-cancel", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ id }) });
              const data = await r.json().catch(() => ({}));
              if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
              if (created?.order?.id === id) setCreated(null);
              await refreshList();
            }}
          />
        </>
      )}
    </div>
  );
}
