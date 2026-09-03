import { BRIDGE_TIMING, MINT_TIMING } from "../../shared/bridge-timing.mjs";
import { useEffect, useState } from "react";
import type { useWallet } from "../wallet/useWallet";
import { BridgeReceiptStatus } from "./bridgeReceiptStatus";
import { BridgeQuoteSummary } from "./BridgeQuoteSummary";
import { describeError } from "../lib/describeError";
import { displayAmount } from "../lib/formatAmount";

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
  // ═══ ⭐⭐ THE QUOTE COUNTDOWN — FROM A DURATION AND OUR OWN ELAPSED TIME ══════════════════════
  //
  // ⛔ NEVER `serverDeadline - Date.now()`. That subtracts a SERVER instant from the DEVICE clock,
  // so every second of skew is a second of wrong countdown — and a fast device would show a live
  // quote as expired, or an expired one as live. The server sends how LONG the quote is good for;
  // the client measures how long IT has waited. No shared clock, nothing to disagree about.
  //
  // ⭐ WHY IT MATTERS MORE THAN IT USED TO. Under CCTP upfront fees the quote carries its own
  // deadline and a burn submitted past it REVERTS on chain — after the approve has confirmed. The
  // window is ~120s, which a human confirm step can genuinely exhaust. `expiresInMs` is the tighter
  // of our seal's TTL and the quote's own window, computed server-side.
  const [quotedAt, setQuotedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!quote || quotedAt == null) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [quote, quotedAt]);
  // ⚠️ `tick` is read so the interval actually re-renders this value; without it the countdown
  // would be computed once and frozen — a stale number that looks live.
  void tick;
  const msLeft = quote && quotedAt != null && Number.isFinite(Number(quote.expiresInMs))
    ? Number(quote.expiresInMs) - (Date.now() - quotedAt) : null;
  const secondsLeft = msLeft == null ? null : Math.max(0, Math.ceil(msLeft / 1000));
  // ⛔ `null` is NOT expired. A quote whose window the server did not send is one we cannot time,
  // and treating "we don't know" as "it's dead" would block a bridge that would have worked.
  const quoteExpired = !!quote && secondsLeft !== null && secondsLeft <= 0;

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
    // ⚠️ AND ITS STAMP WITH IT. A cleared quote beside a live `quotedAt` would leave the countdown
    // running against nothing — the clear must cover every piece of the quote's state, not the
    // piece that happens to be rendered.
    setQuote(null); setQuotedAt(null);
  };

  // ═══ ⭐⭐ TURN 1 — PRICE IT, SHOW IT, MOVE NOTHING ═════════════════════════════════════════════
  // The ordinary case used to go straight to the burn: the fee was priced server-side and thrown
  // away unless it was bad enough to refuse, so the only bridges that ever showed a figure first
  // were the ones being blocked. Now every bridge is quoted first.
  async function getQuote() {
    if (!amountValid || !destination) return;
    setError(""); setQuote(null); setQuotedAt(null); setDisclosure(null); setAcked(false); setRun(null);
    setBridging(true);
    try {
      const res: any = await w.bridgeFromAgent(amountNum, destination, undefined, { quoteOnly: true });
      // ⭐ THE STAMP IS TAKEN THE MOMENT THE ANSWER LANDS, on the CLIENT clock — the same clock
      // the countdown reads from. Stamping from anything server-side would reintroduce the skew
      // the duration exists to avoid.
      if (res?.quoted) { setQuote(res.quote); setQuotedAt(Date.now()); }
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
      setQuote(null); setQuotedAt(null);
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
      {/* ⭐ ZONE 1 — STATE. What the user HAS, and the one standing constraint on the action.
          ⚠️ THE CAPS CLAIM STAYS UP HERE DELIBERATELY. verify-bridge-panel-copy:87 pins it as being
          "in the lead as well"; moving it to zone 3 would satisfy the regex while falsifying what
          the assertion means. The other two lead sentences describe HOW BRIDGING WORKS and are now
          numbered steps in zone 3 — present, below the action, not in the way. */}
      <div className="sub">Bridges run within your per-bridge and daily safety caps.</div>

      <div className="status" style={{ marginTop: 0, marginBottom: 18 }}>
        Bridging from{" "}
        <span className="mono">{shortAddr(w.agentWallet.address)}</span>
        {" · balance "}
        <span className="mono">{displayAmount(w.agentWallet.balance)}</span> USDC
      </div>

      {/* ═══ ⭐⭐ ZONE 2 — INPUTS, THEN WHAT IT COSTS, THEN THE ACTION ══════════════════════════════
          The sequence is the point. This was inputs and act → then cost, so the user committed
          before the panel had told them anything. */}

      {/* ⭐ FROM IS A DISABLED SELECT, NOT STATIC TEXT. Arc is the only source either way — the
          question is how the constraint READS. A greyed control that cannot be changed says "this
          is fixed"; a text field says "this was never a control", which presents a limit as a design
          choice. The first is honest about the constraint; the second hides that there is one.
          ⚠️ `disabled` also removes it from the tab order, so the keyboard path goes straight to the
          destination — the only choice actually available here. */}
      <div className="field-pair">
        <div className="field">
          <label htmlFor="br-from">From</label>
          <select id="br-from" disabled value="arc">
            {/* ⛔ THE CHAIN, NOT THE BALANCE. "Bridging from 0x…c21 · balance 340.00 USDC" sits two
                lines above, so a balance here is the same number twice — and the field's job is to
                name the SOURCE, which is a chain. */}
            <option value="arc">Arc Testnet</option>
          </select>
        </div>
        <div className="field">
          {/* ⭐ THE LABEL MOVED ABOVE THE CONTROL. "destination" sat BELOW the select — the only
              label in the panel positioned that way, and below reads as naming something that
              already happened rather than what is being chosen. */}
          <label htmlFor="br-dest">To</label>
          <select id="br-dest" value={destination}
            onChange={(e) => { setDestination(e.target.value); reset(); }}>
            {DESTINATIONS.map((d) => (<option key={d.key} value={d.key}>{d.label}</option>))}
          </select>
        </div>
      </div>

      {/* ⭐ THE TOKEN SITS INSIDE THE FIELD, not floating beside it. Static here because a bridge
          moves USDC only — on swap this position needs a select, which is why the shape does not
          generalise unchanged. */}
      <div className="amount-field">
        <label className="amount-label" htmlFor="br-amt">Amount</label>
        <div className="amount-wrap">
          <span className="amount-prefix">USDC</span>
          <input id="br-amt" className="amount-input" type="number" min="0" step="0.01"
            inputMode="decimal" value={amount}
            onChange={(e) => { setAmount(e.target.value); reset(); }} />
        </div>
        {/* ⛔ NO "MAX", AND THE OMISSION IS DELIBERATE — two independent reasons. The per-bridge cap
            lives server-side (bridgeCapUsdc() in _arc.mjs, read at _actions.mjs:228) and is never
            sent to the client, so a MAX filling the balance would routinely produce a figure the
            server refuses. And the fee comes OUT OF the amount, so "spend everything" does not mean
            here what it means on a send. A fraction of a balance the client legitimately holds is
            honest; a maximum it cannot compute is not.
            ⚠️ verify-send-copy:75 pins the sibling principle — never print a cap number it cannot
            know. This is the same rule applied to a control instead of a sentence. */}
        <div className="pct-row">
          {[25, 50, 75].map((p) => (
            <button key={p} type="button" className="pct" disabled={bridging}
              onClick={() => {
                // ⭐⭐ COMPUTED FROM THE UNROUNDED BALANCE, ROUNDED ONCE AT THE END. The producer used to
                // emit .toFixed(2), so this multiplied an already-truncated number and truncated again —
                // the error compounded rather than cancelled. MEASURED at a 0.409999 balance: 25% sent
                // 0.10 instead of 0.102499 — 2.44% short, on the button a user presses to avoid doing
                // the arithmetic themselves. With the producer emitting full precision this reads the
                // real balance, and the single .toFixed(6) is the only rounding. 6dp because USDC and
                // EURC are 6-dp on Arc: rounding a SEND amount to 2dp discards money the wallet holds.
                const bal = Number(w.agentWallet?.balance);
                if (!Number.isFinite(bal) || bal <= 0) return;
                setAmount(((bal * p) / 100).toFixed(6));
                reset();
              }}>{p}%</button>
          ))}
        </div>
      </div>

      {/* ⭐⭐ THE SUMMARY SITS BETWEEN THE INPUTS AND THE ACTION, always present. Showing the rows
          before the values is what makes the panel read as complete rather than sparse — the user
          knows what they will be told before they ask. Em-dashes where a value is not yet known;
          Settlement and Route are known from the destination alone. */}
      {/* ⛔ HIDDEN ONCE THE BURN LANDS, NOT BLANKED. Passing `null` here rendered the rows as
          em-dashes directly above a confirmation carrying the real figures — two contradictory
          answers to "what did this cost", stacked. The confirmation supersedes the summary, so the
          summary goes rather than empties. [[absence-must-never-read-as-safe]] */}
      {!run && <BridgeQuoteSummary quote={quote} destinationLabel={destLabel} secondsLeft={secondsLeft} />}

      {/* ⭐ ONE FULL-WIDTH BUTTON WHOSE LABEL CHANGES, not two. Two buttons would imply two
          independent actions; this is one sequence with a priced gate in the middle. Editing the
          amount or destination calls reset(), clearing the quote and returning the label to
          "Get quote" — so re-quoting needs no control of its own.
          ⚠️ The acknowledge gate is untouched: at ≥25% the button stays disabled until the box
          below is ticked.
          ⛔ AN EXPIRED QUOTE DISABLES THE BURN, AND THE LABEL SAYS WHY. Under upfront fees a burn
          submitted past the quote's deadline REVERTS on chain — after the approve has confirmed —
          so letting the press through would cost gas and leave a standing allowance for nothing.
          ⚠️ `quoteExpired` is false when the window is UNKNOWN: we do not block on ignorance. */}
      <button className="emerald btn-wide"
        disabled={bridging || !amountValid || !destination || quoteExpired ||
          (!!quote && disclosure?.band === "acknowledge" && !acked)}
        onClick={quote ? bridge : getQuote}>
        {bridging ? (quote ? "Bridging…" : "Pricing…")
          : quoteExpired ? "Quote expired — price it again"
          : quote ? `Bridge ${amountValid ? amountNum : 0} USDC → ${destLabel}` : "Get quote"}
      </button>

      {/* ⭐⭐ UNCONDITIONAL, AND THAT IS THE FIX. This first sat INSIDE the quote block, which
          renders only once a quote exists — so the refusal conditions were invisible until after
          you had already been quoted, and absent entirely from the default render (caught by
          verify-bridge-panel-copy:84 going red). A rule about WHY a quote might be refused has to
          be readable BEFORE asking for one. Same shape as FeeDisclosureBox being conditional.
          [[state-behind-a-transition-is-untested-by-default]] */}
      <div className="summary-hazard">
        Bridges over your per-bridge cap, or too small to cover the fee, are refused before any
        funds move.
      </div>

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

      {/* ═══ ⭐⭐ ZONE 3 — EXPLANATION, BELOW THE ACTION ═══════════════════════════════════════════
          🚨 THIS IS THE RESOLUTION OF THE CLUTTER PROBLEM, not a deletion of it. Every objection to
          shortening this panel was "a user who skipped the marketing page needs this" — and that
          dissolves once the explanation is on the SAME PAGE, below. Nothing is gone; it is simply
          no longer between the reader and the action.
          ⭐ Numbered because these are sequential facts about a process, and a numbered list is
          scannable in a way a paragraph is not. */}
      <div className="explain">
        <div className="explain-title">How this works</div>
        {/* ⛔ THE SELF-SIGNED LINK IS NOT A STEP AND IS NOT LISTED HERE. It was the only numbered
            item that was not part of the sequence — a navigation option among explanations of how
            bridging works — and it duplicated the cross-link above, which is where someone deciding
            between the two paths actually looks. Three steps is the whole sequence.
            [[duplicate-source-of-truth-is-the-recurring-bug]] */}
        <ol>
          <li>Move USDC from Arc to another chain via CCTP — gasless, from your wallet.</li>
          {/* ⚠️ THE RANGE IS STATED WITHOUT NAMING CHANGES, because the data does not exist:
              BRIDGE_DESTINATIONS carries label, cctpDomain, explorerTx and aliases — no timing
              field, for any of the eight chains. Naming fast and slow chains would be inventing it.
              ⭐ And this wording is VERBATIM the manual panel's, so the two do not quote the same
              range differently. */}
          <li>{BRIDGE_TIMING}.</li>
          <li>The exact delivered amount appears once we have read the destination chain — until
            then the arrival is an estimate.</li>
        </ol>
      </div>

      {/* ── THE FEE BAND — disclosure, then explicit acceptance ─────────────────────────
          The fee-floor only refuses when the fee is as large as the amount. Between that and "worth
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
          {/* ⭐ THIS IS AN ESTIMATE AND MUST SAY SO. netUsdc is arithmetic — the amount burned
              minus the fee that was BOUND for this bridge — not an observation of what landed.
              The exact delivered figure appears below once the destination chain has been
              read. A "~" alone did not carry that distinction. */}
          Bridge submitted ✓ — <b>estimated</b> {Number(run.netUsdc).toFixed(4)} USDC to arrive on{" "}
          {run.destination?.label ?? destLabel} — {MINT_TIMING}
          {run.feeUsdc != null && (
            <>
              {" "}
              {/* ⚠️ THIS SENTENCE HAS BEEN WRONG TWICE, IN DIFFERENT HALVES, AND BOTH ARE FIXED HERE.
                  First "quoted at execution" — the fee is priced BEFORE the burn, sealed, and signed
                  unchanged, so the figure is the one the user accepted.
                  🚨 Then "is taken out of the amount", which upfront fees INVERTED: the fee is
                  charged on the SOURCE, in addition to the amount, and the recipient receives the
                  FULL amount — measured on Base Sepolia, where a burn of 1 minor unit credited
                  exactly 1. Saying it comes out of the amount understates what left the wallet by
                  exactly the fee, on the confirmation screen. */}
              — a flat network fee of {Number(run.feeUsdc).toFixed(4)} USDC, the figure you
              accepted, charged on top: the full amount arrives
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
