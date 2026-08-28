// ManualBridgePanel — bridge USDC from the CONNECTED wallet (MetaMask), user-signed.
//
// ═══ ⭐ WHAT IS DIFFERENT FROM BridgePanel, AND WHAT IS DELIBERATELY IDENTICAL ═════════════════
// Identical: the fee/estimate vocabulary, the acknowledge gate, and the receipts list. Those are
// REUSED, not rewritten — the estimate/measured distinction is the thing this codebase is careful
// about everywhere, and a second wording of it would be a second source of truth for a claim about
// money. `delivery` is set by the SERVER and only ever advances to "measured" after it has read
// the destination chain; the UI never infers it.
//
// ⛔ DIFFERENT, AND IT MUST BE SAID OUT LOUD: agent spending caps DO NOT APPLY here. The agent
// panel's copy mentions the per-bridge cap because an agent is spending unattended. Here the user
// signs with their own key and spends their own funds — the same reasoning already settled for
// agent-withdraw and ub-withdraw. ⚠️ Sitting beside a capped panel, SILENCE READS AS CAPPED, so
// the absence is stated rather than left to be inferred from a missing error.
import { useEffect, useState } from "react";
import type { useWallet } from "../wallet/useWallet";
import { agentClient } from "../lib/agentClient";
import { arcTestnet } from "../config/chain";
import { describeError } from "../lib/describeError";

type UnifiedWallet = ReturnType<typeof useWallet>;
const EXPLORER = arcTestnet.blockExplorers.default.url;

type Quote = {
  amountUsdc: number; feeUsdc: number; netPredicted: number;
  feeRatio: number; feeBand: "none" | "warn" | "acknowledge";
  destinationKey: string; destinationLabel: string; recipient: string;
};
type Burn = { bridgeContract: string; usdc: string; amountMinor: string; calldata: string };

export default function ManualBridgePanel({ wallet: w }: { wallet: UnifiedWallet }) {
  const [amount, setAmount] = useState("1");
  const [destination, setDestination] = useState("base-sepolia");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [burn, setBurn] = useState<Burn | null>(null);
  const [intentId, setIntentId] = useState<string | null>(null);
  const [ackToken, setAckToken] = useState<string | null>(null);
  const [ackBand, setAckBand] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ burnHash: string; netPredicted: number } | null>(null);

  const isMetaMask = w.activeKind === "metamask";

  // ── Step 1: server prices, bands and GATES. Nothing is signed here. ──
  async function start(withAck?: string) {
    setError(null); setBusy(true); setStatus("Pricing…");
    try {
      const r = await agentClient.userBridgeStart(
        { amountUsdc: Number(amount), destination, ackToken: withAck ?? undefined },
        await w.ensureSession(),
      );
      if (r.status === 409 && r.body?.feeDisclosure) {
        // ⚠️ SATISFIABLE, NOT TERMINAL — the same shape as the agent gate. The user is shown what
        // they are accepting and may acknowledge; the token came from the server's disclosure.
        setAckToken(r.body.feeDisclosure.ackToken);
        setAckBand(r.body.feeDisclosure.band);
        setQuote(null); setBurn(null);
        setStatus("");
        setError(null);
        return;
      }
      if (!r.ok) throw new Error(r.body?.error ?? "could not price this bridge");
      setQuote(r.body.quote); setBurn(r.body.burn); setIntentId(r.body.intentId);
      setAckToken(null); setAckBand(null); setStatus("");
    } catch (e) { setError(describeError(e)); } finally { setBusy(false); }
  }

  // ── Step 2: the user signs. approve (only if short) then the burn. ──
  async function signAndBurn() {
    if (!burn || !intentId) return;
    setError(null); setBusy(true);
    try {
      // ⚠️ NO RECEIPT IS WRITTEN AFTER THE APPROVE. An approve grants an allowance — nothing
      // about the money has moved — and recording its hash as a burnHash would be a fabricated
      // money-movement record. The server refuses to promote it anyway: the approve goes to USDC,
      // not the BridgingKit, and carries a different selector.
      setStatus("Checking allowance…");
      const hash = await w.manualBridgeBurn!({
        bridgeContract: burn.bridgeContract, usdc: burn.usdc,
        amountMinor: BigInt(burn.amountMinor), calldata: burn.calldata as `0x${string}`,
        onStatus: setStatus,
      });

      setStatus("Confirming on Arc…");
      // Retry while the node has not seen it yet — 202 means retryable, never "it failed".
      for (let i = 0; i < 20; i++) {
        const p = await agentClient.userBridgePromote({ intentId, burnHash: hash }, await w.ensureSession());
        if (p.ok) { setResult({ burnHash: hash, netPredicted: p.body.netPredicted }); setStatus(""); return; }
        if (p.status !== 202) throw new Error(p.body?.error ?? "could not confirm the burn");
        await new Promise((r) => setTimeout(r, 3000));
      }
      throw new Error("the burn did not confirm in time — it may still land; check your bridges below");
    } catch (e) { setError(describeError(e)); setStatus(""); } finally { setBusy(false); }
  }

  if (!isMetaMask) {
    return (
      <div className="panel">
        <div className="panel-eyebrow">Bridge from your own wallet</div>
        <div className="status">Connect MetaMask to bridge with your own key. The agent bridge is on the AI Agent page.</div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-eyebrow">Bridge from your own wallet</div>

      {/* ⛔ THE ONE LINE THE AGENT PANEL DOES NOT NEED. */}
      <div className="status" style={{ borderLeft: "3px solid var(--accent)", paddingLeft: ".9rem" }}>
        You sign this yourself, with your own key, spending your own USDC.{" "}
        <b>Agent spending caps do not apply here</b> — they bound what the agent may move
        unattended, and they are not a limit on your own funds.
      </div>

      {/* 🚨 THE WINDOW THE AGENT PATH DOES NOT HAVE, DISCLOSED BEFORE SIGNING.
          The agent burns and writes its receipt in ONE server request — there is no moment where
          money has moved and nothing records it. Here the burn is signed in the BROWSER and the
          receipt is written by a SECOND request. Close the tab in between and the bridge still
          completes on chain, but we never learn the hash, so nothing can settle or display it —
          and the sweeper cannot help, because a record with no burn hash is excluded from
          recovery by design (verify-user-bridge-recovery.mjs §3 asserts exactly this).
          ⭐ THE HONEST FORM SAYS BOTH HALVES: the money is fine, the RECORD is what is lost.
          Saying only "stay on this page" would read as "or lose your funds", which is false and
          would frighten a user about the wrong thing. ⚠️ This is the kind of limit a user would
          otherwise discover instead of being told. */}
      <div className="status" style={{ borderLeft: "3px solid var(--warn)", paddingLeft: ".9rem" }}>
        After you sign, <b>stay on this page until the burn confirms.</b> If you leave, the bridge
        still completes on-chain and your funds are not at risk — but we lose the record of it, so
        it will not appear in your bridges and we cannot show you what arrived.
      </div>

      {/* ⭐ REUSED VERBATIM from BridgePanel — the estimate/measured distinction. */}
      <div className="status">
        A live cross-chain fee (taken from the amount) applies — the confirmation shows the
        exact fee quoted at execution and an <b>estimated</b> arrival; the exact delivered
        amount appears once we have read the destination chain.
      </div>

      <div className="row">
        <span className="status" style={{ margin: 0 }}>Amount (USDC)</span>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
        <span className="status" style={{ margin: 0 }}>To</span>
        <select value={destination} onChange={(e) => setDestination(e.target.value)} disabled={busy}>
          <option value="base-sepolia">Base Sepolia</option>
          <option value="avalanche-fuji">Avalanche Fuji</option>
        </select>
        <button onClick={() => start()} disabled={busy}>Get quote</button>
      </div>

      {ackToken && (
        <div className="status" style={{ borderLeft: "3px solid var(--warn)", paddingLeft: ".9rem" }}>
          <b>Most of this amount would become fee.</b> This is a {ackBand} disclosure — the fee is a
          large share of what you are sending, and what arrives will be much smaller.{" "}
          <button onClick={() => start(ackToken)} disabled={busy}>I understand — quote it anyway</button>
        </div>
      )}

      {quote && !result && (
        <div className="status">
          <b>{quote.amountUsdc.toFixed(4)} USDC</b> → {quote.destinationLabel}
          {" · "}fee <b>{quote.feeUsdc.toFixed(4)}</b>
          {" · "}<b>estimated</b> arrival {quote.netPredicted.toFixed(4)} USDC
          <div style={{ marginTop: 8 }}>
            <button onClick={signAndBurn} disabled={busy}>Sign and bridge</button>
          </div>
        </div>
      )}

      {status && <div className="status" style={{ opacity: 0.8 }}>{status}</div>}
      {error && <div className="status" style={{ color: "var(--warn)" }}>{error}</div>}

      {result && (
        <div className="status" style={{ color: "var(--emerald)" }}>
          Bridge submitted ✓ — <b>estimated</b> {Number(result.netPredicted).toFixed(4)} USDC to
          arrive in a few minutes (up to ~20 for some chains). The exact delivered amount appears
          in your bridges once we have read the destination chain.{" "}
          <a href={`${EXPLORER}/tx/${result.burnHash}`} target="_blank" rel="noreferrer">burn ↗</a>
        </div>
      )}
    </div>
  );
}
