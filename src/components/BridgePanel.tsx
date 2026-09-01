import { useEffect, useState } from "react";
import type { useWallet } from "../wallet/useWallet";
import { BridgeReceiptStatus } from "./bridgeReceiptStatus";
import { describeError } from "../lib/describeError";

type UnifiedWallet = ReturnType<typeof useWallet>;

const shortAddr = (a: string) =>
  a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

// The CCTP-forwarded destinations agent-bridge accepts (keys mirror
// BRIDGE_DESTINATIONS in _bridge.mjs; the endpoint resolves the key server-side).
// Testnet labels kept honest — this is Arc Testnet.
const DESTINATIONS = [
  { key: "base", label: "Base (Sepolia)" },
  { key: "ethereum", label: "Ethereum (Sepolia)" },
  { key: "arbitrum", label: "Arbitrum (Sepolia)" },
  { key: "optimism", label: "Optimism (Sepolia)" },
  { key: "avalanche", label: "Avalanche (Fuji)" },
  { key: "polygon", label: "Polygon (Amoy)" },
  { key: "unichain", label: "Unichain (Sepolia)" },
  { key: "linea", label: "Linea (Sepolia)" },
];

// BridgePanel — cross-chain USDC bridge (Arc → 8 EVM testnets via CCTP), matching
// SendPanel/SwapPanel. It POSTs to /api/agent-bridge — the ONE endpoint that
// enforces the per-bridge cap (AGENT_BRIDGE_CAP_USDC) + live fee-floor + day-ceiling
// inside the shared executeAction BEFORE any funds move (agent-bridge.mjs:46 →
// _actions.mjs:91). It does NOT call executeAction/the bridge kit directly.
//
// UX = Option A (fire-and-inform): the Arc burn is synchronous, but the destination
// mint is async (~10–20 min, done by Circle's relayer). On submit we show the burn
// tx + net arrival and let the user leave — the bridge completes server-side. One
// optional "Check status" polls the mint ONCE (no blocking loop).
export default function BridgePanel({ wallet: w }: { wallet: UnifiedWallet }) {
  const [destination, setDestination] = useState("base");
  const [amount, setAmount] = useState("5");
  const [bridging, setBridging] = useState(false);
  const [run, setRun] = useState<any>(null); // agent-bridge response
  const [error, setError] = useState("");
  const [mint, setMint] = useState<any>(null); // one-shot status-check result
  const [checking, setChecking] = useState(false);
  // Server-side receipts. These are the reason a reload no longer strands anyone: the
  // burn is recorded server-side under the caller's own owner scope, so the client can
  // ask "what do I have in flight?" without holding the burnHash in memory.
  const [receipts, setReceipts] = useState<any[]>([]);
  const [receiptsDegraded, setReceiptsDegraded] = useState(false);
  // High-fee band: the server REFUSES until the disclosure is acknowledged, and hands back
  // the exact token for the disclosure it showed. Same grammar as the vault owner-power
  // card — disclose, require a tick, and enforce it SERVER-SIDE (the tick alone only
  // enables the button; _actions re-derives the expected token and compares).
  const [disclosure, setDisclosure] = useState<any>(null);
  // ⭐ The sealed quote and the figures it carries. `quote` is what the user is shown BEFORE the
  // burn; `quote.quoteToken` is opaque and returned verbatim so the fee shown is the fee signed.
  const [quote, setQuote] = useState<any>(null);
  const [acked, setAcked] = useState(false);

  const loadReceipts = async () => {
    try {
      const d = await w.listBridgeReceipts();
      setReceipts(d.receipts || []);
      setReceiptsDegraded(!!d.degraded);
    } catch {
      // A listing failure must never take the bridge form down — but it must not read as
      // "nothing in flight" either.
      setReceiptsDegraded(true);
    }
  };

  useEffect(() => {
    if (w.agentWallet) loadReceipts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.agentWallet?.address]);

  const amountNum = Number(amount);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;
  const destLabel = DESTINATIONS.find((d) => d.key === destination)?.label ?? destination;

  const reset = () => {
    setRun(null);
    setError("");
    setMint(null);
    // A changed amount or destination invalidates the disclosure AND its acknowledgment —
    // the ackToken binds to both, so a stale tick must never carry over to a new quote.
    setDisclosure(null);
    setAcked(false);
    // ⭐⭐ AND THE SEALED QUOTE, FOR THE SAME REASON AND A SHARPER ONE. The quote binds owner,
    // destination and amount, so the server would REFUSE a carried-over token — but the user would
    // have seen a figure for the OLD amount sitting above the new one until it did. Clearing here
    // means the panel never shows a price that does not belong to what is in the field.
    setQuote(null);
  };

  // ═══ ⭐⭐ TURN 1 — PRICE IT, SHOW IT, MOVE NOTHING ═════════════════════════════════════════════
  // The ordinary case used to go straight to the burn: the fee was priced server-side and thrown
  // away unless it was bad enough to refuse, so the only bridges that ever showed a figure first
  // were the ones being blocked. Now every bridge is quoted first.
  async function getQuote() {
    if (!amountValid || !destination) return;
    setError(""); setQuote(null); setDisclosure(null); setAcked(false); setRun(null);
    setBridging(true);
    try {
      const res: any = await w.bridgeFromAgent(amountNum, destination, undefined, { quoteOnly: true });
      if (res?.quoted) setQuote(res.quote);
      else setError(res?.blocked || "Could not price this bridge.");
    } catch (e: any) {
      setError(describeError(e));
    } finally {
      setBridging(false);
    }
  }

  async function bridge() {
    if (!amountValid) return;
    // Captured BEFORE reset(), which clears the disclosure. Relying on the closure to
    // out-race a setState is the kind of subtlety that breaks silently later.
    const ack = acked ? disclosure?.ackToken : undefined;
    reset();
    setBridging(true);
    try {
      const res = await w.bridgeFromAgent(amountNum, destination, ack, { quoteToken: quote?.quoteToken });
      // A high-fee refusal is satisfiable: show the disclosure and let the user accept it.
      if (res?.executed === false && res?.feeDisclosure) {
        setDisclosure(res.feeDisclosure);
        setAcked(false);
        setError(res.blocked || "This bridge needs your acknowledgment before it can run.");
        return;
      }
      setDisclosure(null);
      setRun(res);
      // ⭐ A SPENT QUOTE IS GONE. It is bound to this amount and destination and has just been
      // consumed; leaving it would show a pre-burn price beside a completed burn.
      setQuote(null);
      // Blobs is eventually consistent (~11s), so the receipt we just wrote may not be
      // visible yet. Refresh now AND after the window, rather than concluding absence
      // from one early miss.
      loadReceipts();
      setTimeout(loadReceipts, 12000);
    } catch (e: any) {
      setError(describeError(e));
    } finally {
      setBridging(false);
    }
  }

  async function checkStatus() {
    if (!run?.burnHash || !run?.destination?.key) return;
    setChecking(true);
    try {
      const s = await w.checkBridgeStatus(run.burnHash, run.destination.key);
      setMint(s);
    } catch (e: any) {
      setMint({ state: "error", error: e?.message });
    } finally {
      setChecking(false);
    }
  }

  // Gate identically to Send/Swap: nothing to bridge from before a wallet exists.
  if (!w.agentWallet) {
    return (
      <div className="plane">
        <div className="panel-eyebrow">Bridge</div>
        <h2>Bridge USDC cross-chain</h2>
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
          to connect one, then come back here to bridge.
        </div>
      </div>
    );
  }

  const done = run?.executed && run?.burnHash;
  const pendingBurn = run && !error && !run.burnHash; // 202: burn still confirming

  return (
    <div className="plane">
      <div className="panel-eyebrow">Bridge</div>
      <h2>Bridge USDC cross-chain</h2>
      <div className="sub">
        Move USDC from Arc to another chain via CCTP — gasless, from your wallet. The
        Arc burn is instant; the destination mint follows in a few minutes (up to
        ~20 for some chains). Bridges run within your per-bridge and daily safety caps.
      </div>

      <div className="status" style={{ marginTop: 0, marginBottom: 18 }}>
        Bridging from{" "}
        <span className="mono">{shortAddr(w.agentWallet.address)}</span>
        {" · balance "}
        <span className="mono">{w.agentWallet.balance ?? "…"}</span> USDC
      </div>

      <div className="row">
        <select
          value={destination}
          onChange={(e) => {
            setDestination(e.target.value);
            reset();
          }}
        >
          {DESTINATIONS.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>
        <span className="status" style={{ margin: 0 }}>
          destination
        </span>
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
            reset();
          }}
        />
        <span className="status" style={{ margin: 0 }}>
          USDC
        </span>
        {/* Acceptance gates the button, exactly as the vault card gates its deposit. The
            server refuses independently — this is the affordance, not the enforcement. */}
        {/* ⭐⭐ TWO TURNS, AND THE FIRST ONE MOVES NOTHING. Price → show → confirm → burn. The
            acknowledge gate is unchanged and still sits between: at ≥25% the button stays disabled
            until the box below is ticked. Only the ordinary case has changed, and only by gaining
            a figure it never had. */}
        {!quote ? (
          <button className="emerald" disabled={bridging || !amountValid || !destination} onClick={getQuote}>
            {bridging ? "Pricing…" : "Get quote"}
          </button>
        ) : (
          <button
            className="emerald"
            disabled={bridging || !amountValid || (disclosure?.band === "acknowledge" && !acked)}
            onClick={bridge}
          >
            {bridging ? "Bridging…" : `Bridge ${amountValid ? amountNum : 0} USDC → ${destLabel}`}
          </button>
        )}
      </div>

      <div className="sub" style={{ marginTop: 6, fontSize: "0.8rem" }}>
        {/* ⚠️ THIS SENTENCE PROMISED MORE THAN THE CONFIRMATION DELIVERS. It said "you'll see the
            exact fee and net arrival on the confirmation" — but the confirmation below deliberately
            says ESTIMATED for the arrival, and its own comment explains why: netUsdc is arithmetic
            (burned minus the quoted fee), not an observation of what landed. ⭐ "Exact" was true of
            the FEE and false of the ARRIVAL, and attaching one adjective to both is what made the
            page promise above what it hedges below — the advertised-vs-delivered gap this codebase
            closes everywhere else. The exact delivered figure does exist; it just arrives later,
            once the destination chain has been read. */}
        A live cross-chain fee (taken from the amount) applies — the confirmation shows the
        exact fee quoted at execution and an <b>estimated</b> arrival; the exact delivered
        amount appears once we have read the destination chain. Bridges over your per-bridge
        cap, or too small to cover the fee, are refused before any funds move.
      </div>

      {/* ═══ ⭐⭐ THE QUOTE, SHOWN BEFORE THE BURN ═══════════════════════════════════════════════
          🚨 THIS FIGURE IS THE ONE THAT WILL BE CHARGED, and the wording says exactly that and no
          more. The manual bridge's `maxFee` is a CEILING signed into a transaction the user holds;
          this one is a server-side quote sealed for a few minutes and bound to the burn. Same
          number-before-the-button, DIFFERENT guarantee — so it must not borrow the manual panel's
          sentence, which asserts a binding this path does not have.
          ⚠️ 4dp MINIMUM: at 2dp a small bridge's fee and arrival collapse into the same displayed
          number and the user cannot see that most of it went to fees. */}
      {quote && !run && (
        <div className="status" style={{ border: "1px solid var(--line-strong)", borderRadius: 12, padding: 12, marginTop: 10 }}>
          <div>
            Fee <b className="mono">{Number(quote.feeUsdc).toFixed(4)} USDC</b> ·
            {" "}<b className="mono">{Number(quote.netUsdc).toFixed(4)} USDC</b> arrives on {quote.destination.label}.
          </div>
          <div className="sub" style={{ marginTop: 6, fontSize: "0.8rem" }}>
            This is the fee that will be charged — quoted just now and held for this bridge, not
            re-read when it runs. Price it again if you wait.
          </div>
        </div>
      )}

      {/* ⭐ THE ENTRY POINT. A live route nothing links to is reachable only by typing the hash —
          #/dca sat that way for 22 days. This link ships WITH the route, not after it. */}
      <div className="status" style={{ opacity: 0.85 }}>
        Prefer to sign it yourself?{" "}
        <button className="linkbtn" onClick={() => (window.location.hash = "/bridge-manual")}>
          Bridge from your connected wallet
        </button>{" "}
        — your own key, your own funds, and agent caps do not apply.
      </div>

      {error && (
        <div className="status" style={{ color: "var(--warn)" }}>
          {error}
        </div>
      )}

      {/* ── THE FEE BAND — disclosure, then explicit acceptance ─────────────────────────
          The fee-floor only refuses when NOTHING would arrive. Between that and "worth
          doing" is a gap where the bridge succeeds and most of the money becomes fee:
          0.1 USDC to Base loses ~53%, and it clears the floor. A warning someone scrolls
          past is not consent, so at/above the acknowledge band the action stays DISABLED
          until this is ticked — and the server refuses independently if the token is
          missing or stale (fail-closed, exactly like the vault deposit gate). */}
      {disclosure?.band === "acknowledge" && (
        <div className="status" style={{ border: "1px solid var(--warn)", borderRadius: 8, padding: 12, marginTop: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            This bridge loses {(disclosure.feeRatio * 100).toFixed(1)}% to fees
          </div>
          <div style={{ lineHeight: 1.5 }}>
            The cross-chain fee is flat, so it costs the same whether you bridge 0.1 or 100 USDC —
            on a small amount that is most of it. Bridging a larger amount at once, or not bridging,
            both leave you with more.
          </div>
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 10, cursor: "pointer" }}>
            <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} style={{ marginTop: 3 }} />
            <span style={{ lineHeight: 1.5 }}>
              I understand most of this amount will be spent on the network fee, and I want to bridge anyway.
            </span>
          </label>
        </div>
      )}

      {pendingBurn && (
        <div className="status">
          Bridge submitted — the Arc burn is still confirming. Check back shortly.
        </div>
      )}

      {done && (
        <div className="status" style={{ color: "var(--emerald)" }}>
          {/* ⭐ THIS IS AN ESTIMATE AND MUST SAY SO. netUsdc is arithmetic — the amount
              burned minus the fee quoted at execution — not an observation of what landed.
              The exact delivered figure appears below once the destination chain has been
              read. A "~" alone did not carry that distinction. */}
          Bridge submitted ✓ — <b>estimated</b> {Number(run.netUsdc).toFixed(4)} USDC to arrive on{" "}
          {run.destination?.label ?? destLabel} in a few minutes (up to ~20 for some chains)
          {run.feeUsdc != null && (
            <>
              {" "}
              — a flat network fee of {Number(run.feeUsdc).toFixed(4)} USDC, quoted at execution,
              is taken out of the amount
            </>
          )}
          .
          {run.tx && (
            <>
              {" "}
              <a href={run.tx} target="_blank" rel="noreferrer">
                View burn tx
              </a>
            </>
          )}
          <div className="sub" style={{ marginTop: 6 }}>
            You can leave this page — the bridge completes on its own.
          </div>
          <div style={{ marginTop: 8 }}>
            <button className="linkbtn" disabled={checking} onClick={checkStatus}>
              {checking ? "Checking…" : "Check status"}
            </button>
            {mint?.state === "pending" && (
              <span className="status" style={{ marginLeft: 8 }}>
                Still bridging — the mint hasn't landed yet.
              </span>
            )}
            {mint?.state === "minted" && (
              <span className="status" style={{ marginLeft: 8, color: "var(--emerald)" }}>
                ✓ Arrived on {run.destination?.label ?? destLabel}.
                {mint.mintTx && (
                  <>
                    {" "}
                    <a href={mint.mintTx} target="_blank" rel="noreferrer">
                      View mint tx
                    </a>
                  </>
                )}
              </span>
            )}
            {mint?.state === "failed" && (
              <span className="status" style={{ marginLeft: 8, color: "var(--warn)" }}>
                Bridge failed on the destination.
              </span>
            )}
            {mint?.state === "error" && (
              <span className="status" style={{ marginLeft: 8, color: "var(--warn)" }}>
                Couldn't check status — {mint.error}.
              </span>
            )}
          </div>
        </div>
      )}

      {/* ══ YOUR BRIDGES — server-side receipts, four states, never two ══════════════
          Survives a reload: the burnHash lives in the receipt store under this owner,
          not in component state.

          ⭐ The estimate/measured distinction is carried by `delivery`, which the SERVER
          sets and only ever advances to "measured" after it has read the destination
          chain itself. The UI must not infer it — a receipt that reached a terminal
          state without a successful chain read still reads "predicted", and is shown
          as an estimate, not as an arrival. */}
      {(receipts.length > 0 || receiptsDegraded) && (
        <div style={{ marginTop: 22 }}>
          <div className="panel-eyebrow">Your bridges</div>
          {receiptsDegraded && (
            <div className="status" style={{ color: "var(--warn)" }}>
              Couldn't load your bridge history just now — this is <b>not</b> confirmation that
              nothing is in flight. Try again shortly.
            </div>
          )}
          {receipts.map((r) => {
            return (
              // A provisional receipt has no burnHash — key on whichever identity it has,
              // or React collapses every pending row into one.
              <div key={r.burnHash ?? r.txId} className="status" style={{ marginTop: 8 }}>
                <span className="mono">{Number(r.amountRequested).toFixed(4)}</span> USDC →{" "}
                {r.destinationLabel ?? r.destinationKey}
                {" · "}
                {/* ⭐ THE COPY LIVES IN bridgeReceiptStatus.tsx — a pure component with no hooks,
                    no wallet and no props but the receipt, so scripts/verify-bridge-copy.tsx can
                    RENDER it and assert on the text a browser actually paints. It was inline here,
                    guarded only by a source regex that broke four times across four commits — every
                    break caused by text moving rather than meaning changing, and each "fix" widened
                    the regex, loosening the guard by way of its own false alarms. */}
                <BridgeReceiptStatus r={r} />
                {r.burnTx && (
                  <>
                    {" · "}
                    <a href={r.burnTx} target="_blank" rel="noreferrer">
                      burn tx
                    </a>
                  </>
                )}
                {r.mintTx && (
                  <>
                    {" · "}
                    <a href={r.mintTx} target="_blank" rel="noreferrer">
                      mint tx
                    </a>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
