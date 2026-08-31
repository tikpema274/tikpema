// ManualSwapPanel — swap USDC↔EURC from the CONNECTED wallet (MetaMask), user-signed.
//
// ═══ ⭐ WHAT IS DIFFERENT FROM SwapPanel, AND WHAT IS DELIBERATELY IDENTICAL ════════════════════
// Identical: the token pair and the amount input. Everything else differs, which is why this is a
// separate panel and not a toggle — `SwapPanel` has NO quote step at all (type an amount, press
// Swap, done), while this is quote → disclose → sign → confirm with a signature in the middle.
//
// ⛔ AGENT SPENDING CAPS DO NOT APPLY HERE, and it is SAID rather than left to be inferred. The
// agent panel one hash-route away states its caps out loud; sitting beside it, silence reads as
// capped. The user signs with their own key and spends their own funds — the same reasoning already
// settled for manual bridge, manual send, agent-withdraw and ub-withdraw.
//
// ═══ 🚨 THE PREREQUISITE THIS PANEL EXISTS TO SATISFY ══════════════════════════════════════════
// MEASURED: the swap AdapterContract does NOT bind the payer to the beneficiary. Who PAYS is
// msg.sender; who RECEIVES is a field inside the payload the SERVER built. And MetaMask renders an
// opaque call to the adapter — the destination of the user's money appears NOWHERE in the signing
// prompt. ⭐ We are the only surface that can show it.
//
// ═══ ⛔ THE FAR-ABOVE CASE IS AN ADVISORY, NOT A BAND — AND THAT IS A DECISION ═════════════════
// A guarantee far ABOVE mid-market is anomalous, not favourable: on a stablecoin FX pair the floor
// should sit slightly BELOW mid (a spread plus 3% slippage). Far above means the reference rate and
// the pool disagree, so the CHECK has failed — and a check that is wrong in the favourable
// direction today can be wrong in the unfavourable direction tomorrow, silently.
// ⭐ BUT IT IS NOT GATED, for two reasons. (1) Blocking on "your deal looks too good" asks the user
// to judge something they cannot: whether the rate source or the pool is wrong. (2) On this venue
// the condition is currently COMMON (the pool does not round-trip — see
// docs/swap-venue-price-disagreement.md), and a blocking box that always fires trains the exact
// click-through the band design exists to prevent.
// ⛔ AND IT IS NOT A FOURTH BAND VALUE. The band enum is the GATING vocabulary; adding a member
// changes consent semantics, which the bridge's FEE_BANDS header warns about at length. This is a
// separate, non-gating flag precisely so the gating vocabulary stays closed.
//
// So the panel DECODES the calldata it is about to hand to the wallet and displays the beneficiary
// IN FULL, beside the user's own address, before any signature is offered. ⛔ Not from the JSON the
// server sent alongside the bytes — the whole threat is that the two disagree — but from the bytes.
// A decode that cannot establish the destination BLOCKS the button; it never degrades to "sign
// anyway". Same job the manual send's confirm step does by showing a pasted address as WE parsed it.
import { useEffect, useState } from "react";
import type { useWallet } from "../wallet/useWallet";
import { describeError } from "../lib/describeError";
import { CONTRACTS } from "../config/contracts";
import CustodyNotice from "./CustodyNotice";
import WalletGuardNotice from "./WalletGuardNotice";
import { decodeAndVerifySwap, SwapDecodeError, type DecodedSwap } from "../lib/decodeSwapCalldata";

type UnifiedWallet = ReturnType<typeof useWallet>;
type Token = "USDC" | "EURC";

const usdc = (n: number | bigint) => (Number(n) / 1e6).toFixed(6);
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

type Quote = {
  adapter: string; calldata: `0x${string}`;
  tokenInAddress: string; tokenOutAddress: string;
  amountMinor: string; minTokenOut: string;
  estimatedAmount: string | null; deadline: number;
  band: "none" | "warn" | "acknowledge"; impliedLoss: number; rateCheckUnreliable?: boolean;
  expectedBeneficiary: string;
};

// ⭐ EXPORTED AND PURE so a suite can RENDER it with real numbers. A state reachable only after a
// live quote is a state no test ever sees — the recurring blind spot in this repo's copy guards.
export function SwapReview({
  decoded, owner, tokenIn, tokenOut, amountIn, band, impliedLoss, secondsLeft, rateCheckUnreliable,
}: {
  decoded: DecodedSwap; owner: string; tokenIn: Token; tokenOut: Token;
  amountIn: number; band: Quote["band"]; impliedLoss: number; secondsLeft: number;
  rateCheckUnreliable?: boolean;
}) {
  const matches = decoded.beneficiary.toLowerCase() === owner.toLowerCase();
  return (
    <div className="status" style={{ display: "block", lineHeight: 1.7 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Check this before you sign</div>
      <div>
        You are spending <b className="mono">{amountIn.toFixed(6)} {tokenIn}</b>.
      </div>
      {/* ⭐ THE FLOOR IS THE HEADLINE, NOT THE ESTIMATE. The estimate is what they will probably
          get; the floor is the number they are actually signing. */}
      <div>
        You are <b>guaranteed at least</b>{" "}
        <b className="mono">{usdc(decoded.minTokenOut)} {tokenOut}</b> — the swap reverts below this.
      </div>
      {/* ⭐ THE DIRECTION IS IN WORDS AND THE PERCENTAGE IS ALWAYS POSITIVE.
          🚨 THIS SHIPPED WRONG. "below" used to be hardcoded while the number carried its own sign,
          so a genuine −11.64% rendered as "is -11.64% below the mid-market value" — which reads as
          an 11.64% LOSS when it was an 11.64% GAIN. Observed live on the EURC→USDC run, and read
          exactly that way by the operator. ⛔ A reader must never have to parse a minus sign inside
          a sentence that already states a direction. */}
      <div>
        That guarantee is <b>{pct(Math.abs(impliedLoss))}</b>{" "}
        {impliedLoss >= 0 ? "below" : "above"} the mid-market value of what you are spending.
      </div>
      {/* ⭐⭐ AND WHEN IT IS FAR ABOVE, SAY THE CHECK IS UNRELIABLE — NOT THAT THE DEAL IS GOOD.
          A floor well ABOVE mid-market is not good news; it is evidence that the two prices being
          compared disagree, i.e. that this very check is not working. The user can act on "the
          price check is unreliable" (wait, use less, or proceed knowing it is not protecting them);
          they can do nothing with "you are getting a bargain".
          ⛔ ADVISORY, NOT A GATE — see the header. */}
      {rateCheckUnreliable && (
        <div style={{ marginTop: 8, color: "var(--warn)" }}>
          ⚠️ We could not price-check this swap: our reference rate and the pool disagree by more
          than a normal spread, so the comparison above is not reliable in either direction. The
          guaranteed minimum is still enforced on-chain and does not depend on it.
        </div>
      )}
      {/* ⭐⭐ THE ADDRESS, IN FULL, BOTH OF THEM — so a mismatch is VISIBLE, not merely caught.
          MetaMask cannot show this; it renders an opaque contract call. */}
      <div style={{ marginTop: 10 }}>
        The <b>{tokenOut}</b> will be sent to:
        <div className="mono" style={{ wordBreak: "break-all", color: matches ? "var(--emerald)" : "var(--warn)" }}>
          {decoded.beneficiary} {matches ? "✓ this is your wallet" : "⚠️ NOT your wallet"}
        </div>
        <div className="mono" style={{ wordBreak: "break-all", opacity: 0.75 }}>
          your wallet: {owner}
        </div>
        <div style={{ opacity: 0.75, fontSize: "0.92em" }}>
          Read from the transaction data itself, not from the quote — so it is what you would
          actually be signing.
        </div>
      </div>
      <div style={{ marginTop: 8, opacity: 0.85 }}>
        This quote expires in <b>{Math.max(0, secondsLeft)}s</b>. After that the swap would be
        rejected on-chain and nothing would move.
      </div>
      {band !== "none" && (
        <div style={{ marginTop: 8, color: "var(--warn)" }}>
          {band === "acknowledge"
            ? "⚠️ You would be giving up a large share of what you are spending. Read the guaranteed amount above before continuing."
            : "⚠️ The guaranteed amount is noticeably below the mid-market value of what you are spending."}
        </div>
      )}
    </div>
  );
}

export default function ManualSwapPanel({ wallet: w }: { wallet: UnifiedWallet }) {
  const [tokenIn, setTokenIn] = useState<Token>("USDC");
  const tokenOut: Token = tokenIn === "USDC" ? "EURC" : "USDC";
  const [amount, setAmount] = useState("1");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [decoded, setDecoded] = useState<DecodedSwap | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [eurc, setEurc] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  // ⭐ Set the instant the swap is signed and NEVER cleared on failure — it is the proof money
  // moved, and it is what makes re-signing unofferable. Same rule as the manual bridge.
  const [signedHash, setSignedHash] = useState<string | null>(null);
  const [result, setResult] = useState<{ received: number | null } | null>(null);

  const amountNum = Number(amount);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;
  const isMetaMask = w.activeKind === "metamask" && !!w.manualSwap;
  const secondsLeft = quote ? Math.floor((quote.deadline * 1000 - now) / 1000) : 0;
  const expired = !!quote && secondsLeft <= 0;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (w.refreshEurcBalance) w.refreshEurcBalance().then(setEurc).catch(() => {});
  }, [w.refreshEurcBalance]);

  const reset = () => { setQuote(null); setDecoded(null); setAcknowledged(false); setError(null); setResult(null); };

  // ── Step 1: approve FIRST (exact amount), THEN quote. ────────────────────────────────────────
  // ⭐ THE ORDER IS DELIBERATE. The approve amount is the amount the user typed — the quote is not
  // needed for it. Quoting first would start the 600s expiry clock BEFORE a human prompt and an
  // on-chain mine; quoting after starts it at the last possible moment, so expiry is a non-issue in
  // the normal case rather than a race the user can lose by hesitating.
  async function getQuote() {
    if (!amountValid) return;
    reset();
    setBusy(true);
    try {
      const token = await w.ensureSession();
      const r = await fetch("/api/user-swap-start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ tokenIn, tokenOut, amountIn: amountNum }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error || "Could not price this swap.");

      // ⛔ THE GATE. Decode the BYTES and refuse if the output would land anywhere but this wallet.
      // A failure here is terminal for this quote — no signature is offered, and there is no
      // "continue anyway".
      const d = decodeAndVerifySwap({
        calldata: data.calldata,
        tokenInAddress: data.tokenInAddress,
        tokenOutAddress: data.tokenOutAddress,
        expectedBeneficiary: w.address!,
      });
      setQuote(data as Quote);
      setDecoded(d);
    } catch (e: any) {
      // A decode refusal is not a generic failure — say plainly that nothing will be signed.
      setError(e instanceof SwapDecodeError ? `${e.message} Nothing has been signed.` : describeError(e));
    } finally {
      setBusy(false);
    }
  }

  // ── Step 2: the user signs. Exact-amount approve (only if short), then the swap. ─────────────
  async function signAndSwap() {
    if (!quote || !decoded || !w.manualSwap) return;
    setError(null);
    setBusy(true);
    let submitted: string | null = null; // ⭐ the discriminator: null until the swap is signed
    try {
      const res = await w.manualSwap({
        adapter: quote.adapter,
        tokenIn: quote.tokenInAddress,
        amountMinor: BigInt(quote.amountMinor),
        calldata: quote.calldata,
        onStatus: setStatusMsg,
      });
      submitted = res.swapHash;
      setSignedHash(res.swapHash);
      setStatusMsg("Waiting for the swap to confirm…");

      // ⛔ NO RECEIPT IS WRITTEN — delivery IS this transaction. Its own logs carry what arrived,
      // so the estimate→measured advance completes here rather than needing a record to travel
      // through. ⭐ The token address is pinned FIRST: Arc emits TWO Transfer logs per movement
      // (an 18-dp native one and the 6-dp ERC-20 one), so an unpinned sum is ~1e12 wrong.
      const receipt = await w.waitForSwapReceipt!(res.swapHash);
      const want = w.address!.toLowerCase();
      const out = quote.tokenOutAddress.toLowerCase();
      const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      let sum = 0n;
      for (const l of receipt.logs ?? []) {
        if ((l.address ?? "").toLowerCase() !== out) continue;
        if ((l.topics?.[0] ?? "").toLowerCase() !== TRANSFER) continue;
        if ((l.topics?.[2] ?? "").toLowerCase() !== `0x${want.slice(2).padStart(64, "0")}`) continue;
        sum += BigInt(l.data);
      }
      setResult({ received: sum > 0n ? Number(sum) / 1e6 : null });
      setStatusMsg("");
      if (w.refreshBalance) w.refreshBalance().catch(() => {});
      if (w.refreshEurcBalance) w.refreshEurcBalance().catch(() => {});
    } catch (e: any) {
      setStatusMsg("");
      setError(describeError(e));
      // 🚨 THE RE-ARM RULE, CARRIED OVER VERBATIM FROM THE MANUAL BRIDGE. Before a hash exists,
      // nothing moved and re-signing is safe. AFTER one exists the money is GONE from this wallet,
      // so the sign control is removed — a user must never re-sign to repair a display problem.
      if (submitted) setQuote(null);
    } finally {
      setBusy(false);
    }
  }

  if (!isMetaMask) {
    return (
      <div className="plane">
        <div className="panel-eyebrow">Swap · your own wallet</div>
        <h2>Swap from your own wallet</h2>
        {/* 🚨 THIS PANEL IS WHY THE COMPONENT EXISTS. It used to branch on `activeKind` alone and
            NEVER read `metamaskConnected`, so "MetaMask connected but another wallet active"
            rendered BYTE-IDENTICALLY to "MetaMask not connected" — telling the user to connect
            what they had already connected. The hook exported the distinguishing fact precisely so
            every panel would get it; this one did not use it. Now it cannot fail to. */}
        <WalletGuardNotice metamaskConnected={!!w.metamaskConnected} active={w.activeKind === "metamask"}
          verb="swap" twinLabel="Swap" twinRoute="/swap"
          onConnect={() => w.connectMetaMask().catch(() => {})} busy={w.busy}
          replacesSession={!!w.address} />
      </div>
    );
  }

  return (
    <div className="plane">
      <div className="panel-eyebrow">Swap · your own wallet</div>
      <h2>Swap from your own wallet</h2>
      <div className="sub">
        Convert between USDC and EURC on Arc, signed with your own key. You pay the gas.{" "}
        To swap from your agent wallet under its caps, open{" "}
        <button className="linkbtn" onClick={() => (window.location.hash = "/swap")}>Swap</button>.
      </div>

      {/* ⭐ SHARED, not restated — this panel used to carry its OWN wording ("Your agent's spending
          caps do not apply here — this is your wallet and your money"), which is how the drift
          started and how the suite regex got weakened to accommodate it.
          🚨 NO `token` PROP, DELIBERATELY: a swap spends USDC *or* EURC, and the shared sentence
          used to say "your own USDC" unconditionally — false for an EURC→USDC swap. This panel is
          the one that proves the generic wording is needed. */}
      <CustodyNotice />

      <div className="status" style={{ marginTop: 0, marginBottom: 18 }}>
        Swapping from <span className="mono">{w.address}</span>
        {" · USDC "}<span className="mono">{w.usdcBalance ?? "…"}</span>
        {" · EURC "}<span className="mono">{eurc ?? "…"}</span>
      </div>

      <div className="row">
        <select value={tokenIn} onChange={(e) => { setTokenIn(e.target.value as Token); reset(); }} disabled={!!signedHash}>
          <option value="USDC">USDC</option>
          <option value="EURC">EURC</option>
        </select>
        <span className="status" style={{ margin: 0 }}>→ {tokenOut}</span>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <input type="number" min="0" step="0.01" style={{ maxWidth: 120 }} value={amount}
          onChange={(e) => { setAmount(e.target.value); reset(); }} disabled={!!signedHash} />
        <span className="status" style={{ margin: 0 }}>{tokenIn}</span>
        {!quote && !signedHash && (
          <button className="emerald" disabled={busy || !amountValid} onClick={getQuote}>
            {busy ? "Pricing…" : "Get quote"}
          </button>
        )}
      </div>

      {quote && decoded && !signedHash && (
        <>
          <div style={{ marginTop: 14 }}>
            <SwapReview decoded={decoded} owner={w.address!} tokenIn={tokenIn} tokenOut={tokenOut}
              amountIn={amountNum} band={quote.band} impliedLoss={quote.impliedLoss} secondsLeft={secondsLeft}
              rateCheckUnreliable={quote.rateCheckUnreliable} />
          </div>
          {/* ⭐ The band gate blocks the button until the user accepts. There is no ack TOKEN: the
              floor and expiry are inside a Circle-signed payload the ADAPTER enforces, so the chain
              already refuses what a token would have refused. */}
          {quote.band !== "none" && !acknowledged && (
            <button className="emerald" style={{ marginTop: 10 }} onClick={() => setAcknowledged(true)}>
              I understand — continue
            </button>
          )}
          {(quote.band === "none" || acknowledged) && (
            <button className="emerald" style={{ marginTop: 10 }} disabled={busy || expired} onClick={signAndSwap}>
              {busy ? "Signing…" : expired ? "Quote expired — get a new one" : `Sign and swap ${amountNum} ${tokenIn}`}
            </button>
          )}
          {expired && (
            <button className="linkbtn" style={{ marginLeft: 10 }} onClick={getQuote}>Get a fresh quote</button>
          )}
        </>
      )}

      {statusMsg && <div className="status">{statusMsg}</div>}

      {signedHash && (
        <div className="status" style={{ color: result ? "var(--emerald)" : undefined, display: "block" }}>
          <div>Swap signed.</div>
          {result && (
            <div>
              {result.received != null
                ? <>Received <b className="mono">{result.received.toFixed(6)} {tokenOut}</b> — against a guaranteed
                    minimum of <span className="mono">{usdc(decoded?.minTokenOut ?? 0n)}</span>, read from the
                    transaction's own logs.</>
                : <>Confirmed on-chain, but the received amount could not be read from the logs. Your balance above
                    is the authority.</>}
            </div>
          )}
          <div className="mono" style={{ wordBreak: "break-all", opacity: 0.75 }}>{signedHash}</div>
        </div>
      )}

      {error && <div className="status" style={{ color: "var(--warn)" }}>{error}</div>}
    </div>
  );
}
