import { useEffect, useState } from "react";
import type { useWallet } from "../wallet/useWallet";
import { describeError } from "../lib/describeError";
import { formatUsdc } from "../lib/formatUsdc";
import { arcTestnet } from "../config/chain";
import { SendOutcome, type SendResult } from "./SendPanel";
import AddressDisplay from "./AddressDisplay";
import AgentWalletGate from "./AgentWalletGate";

const EXPLORER = arcTestnet.blockExplorers.default.url;
type UnifiedWallet = ReturnType<typeof useWallet>;

// ═══ PAY — a checkout link, paid from the buyer's AGENT wallet through the existing send path ═══
//
// #/pay?order=<id>. The order is a merchant's request ("pay ME this much for THIS"), read from
// /api/checkout-get, which is PUBLIC so a buyer can read what they are being asked for before a
// wallet exists (door, not wall). Paying is `w.sendFromAgent(order.merchant, amount)` — the SAME
// /api/agent-send that the Send page uses, with the same caps, pause, day ceiling and receipt shapes.
// Nothing here signs or moves money by any other route. After the send, the buyer's client reports
// the outcome to /api/checkout-paid, and the SERVER decides whether the order is paid by reading the
// receipt from the chain — the client's word marks nothing.
//
// ⛔ THE ONE CLAIM THIS SURFACE EXISTS TO MAKE, BEFORE THE SEAL: a direct payment cannot be reversed
// by Tikpema. v1 is direct settlement to the merchant's own wallet — no escrow — so a refund is the
// merchant sending it back, and the buyer reads that ABOVE the button, not after the click.
// Pinned by verify-checkout-copy (present AND before the seal in the markup).
export const IRREVERSIBLE_LINE =
  "This pays the merchant directly from your agent wallet. It cannot be reversed by Tikpema — a refund is the merchant sending it back.";

export type PublicOrder = {
  id: string;
  merchant: string;
  amountUsdc: string;
  description: string;
  settlement: string;
  status: "open" | "submitted" | "paid" | "expired" | string;
  createdAt: string;
  expiresAt: string;
  paidTx: string | null;
  paidAt: string | null;
  circleId: string | null;
  /** The Arc head when the order was minted; a payment must be mined after it. `null` = an order
   *  created before binding (2026-09-19) — UNBOUND, the server refuses every payment of it, so the
   *  seal is not offered. */
  createdAtBlock?: number | null;
};

/** What /api/checkout-paid said about the order after the send (or why it could not say).
 *  ⚠️ `unverified` (503) and `refused` (409) are DIFFERENT facts: the first is "could not read", the
 *  second is a VERDICT from a receipt the server read. Rendering a verdict as "could not yet verify"
 *  would promise the buyer a paid order that will never come. */
export type Mark =
  | { status: "paid"; paidTx?: string | null }
  | { status: "submitted" }
  | { unverified: string }
  | { refused: string; code: "replay" | "predates" | "unbound" | "receipt" | string; paidOrderId: string | null }
  | null;

// Read the order id from the hash query ONCE, at mount (the SendPanel payment-link pattern): re-reading
// would fight the user, and a malformed id is dropped, never coerced.
const ORDER_ID_RE = /^o_[0-9a-z]{1,12}_[0-9a-f]{16}$/;
export function orderIdFromHash(hash: string): string | null {
  const q = hash.split("?")[1] ?? "";
  const id = (new URLSearchParams(q).get("order") ?? "").trim();
  return ORDER_ID_RE.test(id) ? id : null;
}

const Status = ({ children, tone }: { children: React.ReactNode; tone?: "warn" | "success" | "muted" }) => (
  <div
    className="status"
    style={tone ? { borderLeft: `3px solid var(--${tone === "muted" ? "line" : tone})`, paddingLeft: ".9rem" } : undefined}
  >
    {children}
  </div>
);

/** The door: #/pay with no order. Explains, and links the seller side — every live route is linked. */
export function PayDoor() {
  return (
    <div className="plane">
      <div className="panel-eyebrow">Pay</div>
      <h2>Pay a checkout link</h2>
      <div className="sub">
        A checkout link looks like <span className="mono">…/#/pay?order=o_…</span> — someone who wants to be paid made
        it, and it names what you are paying for, who receives it, and how much. Open the link you were sent and this
        page fills in. Want to be paid yourself?{" "}
        <button className="linkbtn" onClick={() => (window.location.hash = "/sell")}>Sell something →</button>
      </div>
    </div>
  );
}

/**
 * The order, rendered by its state. Exported so every state can be rendered with crafted props by
 * verify-checkout-copy — SSR cannot click Pay.
 */
export function PayOrderView({
  order,
  wallet: w,
  paying,
  result,
  payError,
  mark,
  onPay,
}: {
  order: PublicOrder;
  wallet: UnifiedWallet;
  paying: boolean;
  result: SendResult | null;
  payError: string;
  mark: Mark;
  onPay: () => void;
}) {
  const amount = formatUsdc(order.amountUsdc);
  const agentAddress = w.agentWallet?.address ?? "";
  // 🚨 UNBOUND: no createdAtBlock (an order minted before 2026-09-19 binding). The server refuses every
  // payment of it — and this page sends FIRST, reports SECOND. Offering the seal would move the money
  // and never mark the order. So an unbound order is not `open` here: no seal, the reason on the page.
  const unbound = order.status === "open" && (order.createdAtBlock === null || order.createdAtBlock === undefined);
  const open = order.status === "open" && !unbound;

  return (
    <div className="plane">
      <div className="panel-eyebrow">Pay</div>
      <h2>Pay a checkout link</h2>
      <div className="sub">
        Someone made this link to collect a payment. Read what it is for, who receives it and how much, then
        settle it from your agent wallet — gasless on Arc.
      </div>

      {open && w.agentWallet && (
        <div className="status row" style={{ marginTop: 0, marginBottom: 18, gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <span>Paying from</span> <AddressDisplay address={agentAddress} />
          {w.agentWallet.balance != null ? <span>· USDC <span className="mono">{formatUsdc(w.agentWallet.balance)}</span></span> : null}
        </div>
      )}

      {/* ⭐ THE SUMMARY BLOCK — the SwapPanel shape: what / to whom / how much as rows, the
          mechanic rows beneath, the hazard bordered off inside the block, then the seal. The merchant
          address is the payee and stays UNTRUNCATED here (an ellipsis hides exactly the characters a
          substituted link would change); the "Paying from" line above may shorten. */}
      <div className="summary-block">
        <div className="summary-row"><span>For</span><b>{order.description}</b></div>
        {/* Masked by default with click-to-expand + Copy (T, 2026-09-18). ⚠️ AddressDisplay's own header
            says masking is wrong where the address IS the content; here the payee is the disclosure, so
            the full address stays ONE TAP away and Copy always copies the full one. */}
        <div className="summary-row"><span>To</span><AddressDisplay address={order.merchant} /></div>
        <div className="summary-row"><span>Amount</span><b className="mono">{amount} USDC</b></div>
        {open && w.agentWallet && (
          <>
            {/* Same claim as SendPanel's rail: this IS the agent send path. */}
            <div className="summary-row"><span>Signed by</span><span>a server key, from your agent wallet — agent spending limits apply (per-transaction cap and daily ceiling, enforced on the server)</span></div>
            {/* ⛔ BEFORE THE SEAL. See IRREVERSIBLE_LINE. A hazard, not a value — bordered off. */}
            <div className="summary-hazard"><b>Cannot be undone.</b> {IRREVERSIBLE_LINE}</div>
          </>
        )}
      </div>

      {order.status === "paid" && (
        <Status tone="success">
          <b>Paid.</b> This order was settled on Arc
          {order.paidTx ? (
            <>
              {" "}— <span className="mono" style={{ wordBreak: "break-all" }}>{order.paidTx}</span>{" "}
              <a href={`${EXPLORER}/tx/${order.paidTx}`} target="_blank" rel="noreferrer">view the transfer ↗</a>
            </>
          ) : null}
          . Nothing more to pay.
        </Status>
      )}

      {order.status === "submitted" && (
        <Status tone="warn">
          <b>Submitted — has not landed on Arc yet.</b> A payment for this order was accepted by Circle
          {order.circleId ? <> (Circle id <span className="mono">{order.circleId}</span>)</> : null} but has not landed,
          so there is no transaction hash yet and this order is <b>not yet paid</b>. Paying again would be a second
          payment; wait for it to land.
        </Status>
      )}

      {order.status === "expired" && (
        <Status tone="warn">
          <b>This checkout link has expired.</b> Ask the seller for a new one.
        </Status>
      )}

      {unbound && (
        <Status tone="warn">
          <b>This checkout link cannot be settled.</b> It predates payment binding (the order records no creation
          block, so no transfer can be shown to belong to it) and the server will refuse any payment of it. Nothing
          has been paid. Ask the seller for a new checkout link.
        </Status>
      )}

      {/* ⭐ FOUR states behind "no agent wallet", each with its own copy, and the buyer never loses
          the order: only the no-wallet case leaves the page, and it leaves with a return-to.
          (2026-09-19 live proof: the old single sentence sent a connected buyer away, dropped the
          order id, and hid a failed resolve as "set up your wallet".) */}
      {open && !w.agentWallet && <AgentWalletGate wallet={w} verb="pay" nothingHappened="Nothing was paid." />}

      {open && w.agentWallet && (
        <button className="emerald btn-wide" disabled={paying || !!result} onClick={onPay}>
          {paying ? "Paying…" : `Pay ${amount} USDC`}
        </button>
      )}

      {/* The outcome of the send, exactly as the Send page renders it — one receipt implementation. */}
      <SendOutcome result={result} error={payError} to={order.merchant} amount={Number(order.amountUsdc)} agentAddress={agentAddress} />

      {/* What the SERVER concluded about the ORDER, which is a separate fact from the send. */}
      {mark && "status" in mark && mark.status === "paid" && (
        <Status tone="success">Order <b>marked paid</b> — the server read your transfer on Arc.</Status>
      )}
      {mark && "status" in mark && mark.status === "submitted" && (
        <Status tone="warn">Order marked <b>submitted</b>, not paid — it becomes paid once the transfer lands and is verified.</Status>
      )}
      {mark && "unverified" in mark && (
        <Status tone="warn">
          <b>Could not yet verify</b> this payment against the order ({mark.unverified}). Your transfer is what the
          receipt above says it is; the order will show paid once the server can read it. Do not pay again.
        </Status>
      )}
      {/* A 409 is a VERDICT: the server read the receipt and it does not pay THIS order. Say which
          kind, and — for a replay — name and link the order the transaction DID pay. */}
      {mark && "refused" in mark && (
        <Status tone="warn">
          <b>Not a payment of this order.</b>{" "}
          {mark.code === "replay" && mark.paidOrderId ? (
            <>
              This transaction already paid order{" "}
              <a href={`#/pay?order=${mark.paidOrderId}`} className="mono">{mark.paidOrderId}</a>. One transfer settles one
              order; this order remains unpaid and nothing was marked. Paying it would be a second transfer.
            </>
          ) : mark.code === "unbound" ? (
            <>
              This checkout link cannot be settled: it predates payment binding, and the server refuses every payment
              of it. This order remains unpaid. Ask the seller for a new checkout link.
            </>
          ) : (
            <>
              The server did not mark this order paid ({mark.refused}). This order remains unpaid and nothing was
              marked.
            </>
          )}
          {mark.code === "replay" || mark.code === "unbound" ? <> <span className="muted">({mark.refused})</span></> : null}
        </Status>
      )}
    </div>
  );
}

export default function PayPanel({ wallet: w }: { wallet: UnifiedWallet }) {
  const [id] = useState(() => orderIdFromHash(typeof window === "undefined" ? "" : window.location.hash));
  const [load, setLoad] = useState<{ state: "loading" } | { state: "ready"; order: PublicOrder } | { state: "missing" } | { state: "unreadable"; reason: string }>({ state: "loading" });
  const [paying, setPaying] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [payError, setPayError] = useState("");
  const [mark, setMark] = useState<Mark>(null);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/checkout-get?id=${encodeURIComponent(id)}`);
        const data = await r.json().catch(() => ({}));
        if (!alive) return;
        if (r.status === 404) setLoad({ state: "missing" });
        else if (!r.ok) setLoad({ state: "unreadable", reason: data?.error || `HTTP ${r.status}` });
        else setLoad({ state: "ready", order: data.order });
      } catch (e: any) {
        if (alive) setLoad({ state: "unreadable", reason: describeError(e) });
      }
    })();
    return () => { alive = false; };
  }, [id]);

  async function pay() {
    if (load.state !== "ready" || !w.agentWallet) return;
    const order = load.order;
    setPayError("");
    setResult(null);
    setMark(null);
    setPaying(true);
    let data: SendResult | null = null;
    try {
      // THE money movement — the existing agent send, unchanged.
      data = (await w.sendFromAgent(order.merchant as `0x${string}`, Number(order.amountUsdc))) as SendResult;
      setResult(data);
    } catch (e: any) {
      setPayError(describeError(e));
      setPaying(false);
      return;
    }
    // Report the outcome; the server verifies on chain before it marks anything.
    try {
      const token = await w.ensureSession();
      const body = "txHash" in data ? { id: order.id, txHash: data.txHash } : { id: order.id, circleId: data.txId };
      const r = await fetch("/api/checkout-paid", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.order?.status === "paid") setMark({ status: "paid", paidTx: j.order.paidTx });
      else if (r.ok && j?.order?.status === "submitted") setMark({ status: "submitted" });
      // 409 = a verdict from a receipt the server READ; everything else (503, network) = could not read.
      else if (r.status === 409 && typeof j?.error === "string") setMark({ refused: j.error, code: j.code ?? "receipt", paidOrderId: j.paidOrderId ?? null });
      else setMark({ unverified: j?.error || `HTTP ${r.status}` });
    } catch (e: any) {
      setMark({ unverified: describeError(e) });
    } finally {
      setPaying(false);
    }
  }

  if (!id) return <PayDoor />;
  if (load.state === "loading") {
    return (
      <div className="plane">
        <div className="panel-eyebrow">Pay</div>
        <h2>Pay a checkout link</h2>
        <div className="sub">Reading the order…</div>
      </div>
    );
  }
  if (load.state === "missing") {
    return (
      <div className="plane">
        <div className="panel-eyebrow">Pay</div>
        <h2>Pay a checkout link</h2>
        <Status tone="warn">No order with that id. Check the link you were sent, or ask the seller for a new one.</Status>
      </div>
    );
  }
  if (load.state === "unreadable") {
    return (
      <div className="plane">
        <div className="panel-eyebrow">Pay</div>
        <h2>Pay a checkout link</h2>
        <Status tone="warn">The order could not be read right now ({load.reason}). Nothing was paid. Try again in a moment.</Status>
      </div>
    );
  }
  return <PayOrderView order={load.order} wallet={w} paying={paying} result={result} payError={payError} mark={mark} onPay={pay} />;
}
