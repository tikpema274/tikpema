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
import CustodyNotice from "./CustodyNotice";
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

// ⭐ THE SERVER'S 409 BODY, WHOLE. Every field here is computed server-side by `priceAndGate` and
// arrives WITH the refusal. The panel used to keep `ackToken` and `band` and drop the rest.
type Disclosure = {
  feeUsdc: number; netUsdc: number; feeRatio: number; amountUsdc: number;
  band: string; destinationLabel: string; ackToken: string;
};

// ═══ 🚨 THE DEFECT THIS COMPONENT EXISTS TO FIX, FOUND ON THE FIRST LIVE FIRING ════════════════
// The gate fired correctly at 36.14% and then disclosed NOTHING: no fee, no ratio, no arrival
// amount, no amount sent. The user was asked to accept "the fee is a large share of what you are
// sending" and would have learned the figures only AFTER consenting.
//
// ⛔ THE SERVER WAS NEVER AT FAULT. `priceAndGate` returns feeUsdc, netUsdc, feeRatio and
// amountUsdc in the 409 body — its own comment says the disclosure rides on the refusal "so a
// cooperating UI can show the user what they are accepting". The panel simply discarded them. So
// the numbers were ALREADY IN HAND at the moment of consent; the inverted feeling of consenting
// first was this discard, not a protocol ordering problem, and one fix closes both.
//
// ⚠️ THE SENTENCE IS WRITTEN, NOT ASSEMBLED FROM THE BAND NAME. It used to interpolate `{ackBand}`
// into "This is a {band} disclosure", which produced "This is a acknowledge disclosure" — broken
// grammar AND an internal enum leaked to a user who has no idea what a band is. A machine token is
// not prose. If a new band is added, this sentence is written for it, not generated.
//
// ⭐ EXPORTED AND PURE so a suite can RENDER it with real numbers. It used to be reachable only
// after a live 409, which is why no test ever saw it — see verify-manual-bridge-copy §6.
export function FeeDisclosureBox({
  disclosure: d, busy, onAccept,
}: { disclosure: Disclosure; busy: boolean; onAccept: () => void }) {
  return (
    <div className="status" style={{ borderLeft: "3px solid var(--warn)", paddingLeft: ".9rem" }}>
      <b>Most of this amount would become fee.</b> You are sending{" "}
      <b>{d.amountUsdc.toFixed(6)} USDC</b> to {d.destinationLabel}. The fee is{" "}
      <b>{d.feeUsdc.toFixed(6)} USDC</b> — <b>{(d.feeRatio * 100).toFixed(1)}%</b> of what you are
      sending — so only <b>{d.netUsdc.toFixed(6)} USDC</b> would arrive. A fee this large needs your
      explicit acceptance, not just a warning.{" "}
      <button onClick={onAccept} disabled={busy}>I understand — quote it anyway</button>
    </div>
  );
}

export default function ManualBridgePanel({ wallet: w }: { wallet: UnifiedWallet }) {
  const [amount, setAmount] = useState("1");
  // ⭐ NO DEFAULT AND NO HARDCODED LIST. The previous version shipped `base-sepolia`, which is not
  // a destination key — the server's loose matcher resolved it to ETHEREUM and a real bridge went
  // to the wrong chain. The options are now SERVED, and nothing can be selected until they load.
  const [destination, setDestination] = useState("");
  const [destinations, setDestinations] = useState<{ key: string; label: string }[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [burn, setBurn] = useState<Burn | null>(null);
  const [intentId, setIntentId] = useState<string | null>(null);
  // ⭐ THE WHOLE DISCLOSURE, not two fields plucked out of it. Keeping the object is what makes
  // every number available to the box below; the previous two-field state was the defect.
  const [disclosure, setDisclosure] = useState<Disclosure | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ burnHash: string; netPredicted: number } | null>(null);
  // ⭐ Set the instant the burn is signed and NEVER cleared on failure — it is the proof that money
  // moved, and it is what makes re-signing unofferable.
  const [signedHash, setSignedHash] = useState<string | null>(null);

  const isMetaMask = w.activeKind === "metamask";

  // Load the destination list from the server on mount. ⚠️ FAILS CLOSED: if it cannot load, the
  // select stays empty and there is nothing to pick — better than offering a guess.
  useEffect(() => {
    if (!isMetaMask) return;
    (async () => {
      try {
        const r = await agentClient.userBridgeDestinations(await w.ensureSession());
        setDestinations(r.destinations ?? []);
      } catch {
        setDestinations([]);
      }
    })();
  }, [isMetaMask]);

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
        setDisclosure(r.body.feeDisclosure as Disclosure);
        setQuote(null); setBurn(null);
        setStatus("");
        setError(null);
        return;
      }
      if (!r.ok) throw new Error(r.body?.error ?? "could not price this bridge");
      setQuote(r.body.quote); setBurn(r.body.burn); setIntentId(r.body.intentId);
      setDisclosure(null); setStatus("");
    } catch (e) { setError(describeError(e)); } finally { setBusy(false); }
  }

  // ── Step 2: the user signs. approve (only if short) then the burn. ──
  //
  // ═══ 🚨 THE RE-ARM DEFECT THIS STRUCTURE EXISTS TO PREVENT ═══════════════════════════════════
  // The first version caught every failure identically and left `burn`/`intentId` intact, so the
  // "Sign and bridge" button came back — with the SAME calldata — after a promote failure. One
  // more click would have burned a SECOND time. ⛔ AND THE MOTIVE WOULD HAVE BEEN THE WORST KIND:
  // the user re-signs to fix a RECORD problem, spending more money to repair bookkeeping for money
  // that already moved correctly.
  //
  // ⭐ SO THE HANDLER SPLITS ON ONE FACT: HAS THE BURN BEEN SUBMITTED YET?
  //   before the hash exists → nothing moved; re-signing is safe and the button may return.
  //   after the hash exists  → the money is GONE from this wallet. Re-signing can never be right,
  //                            so the sign control is REMOVED and only a retry-the-RECORD control
  //                            is offered. Retrying `promote` is idempotent; it re-reads a chain
  //                            fact and cannot spend anything.
  async function signAndBurn() {
    if (!burn || !intentId) return;
    setError(null); setBusy(true);
    let submitted: string | null = null;   // ⭐ the discriminator: null until the burn is signed
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
      // 🚨 PAST THIS LINE THE MONEY HAS MOVED. Everything after is about the RECORD.
      submitted = hash;
      setSignedHash(hash);

      setStatus("Confirming on Arc…");
      // Retry while the node has not seen it yet — 202 means retryable, never "it failed".
      for (let i = 0; i < 20; i++) {
        const p = await agentClient.userBridgePromote({ intentId, burnHash: hash }, await w.ensureSession());
        if (p.ok) { setResult({ burnHash: hash, netPredicted: p.body.netPredicted }); setStatus(""); return; }
        if (p.status !== 202) throw new Error(p.body?.error ?? "could not confirm the burn");
        await new Promise((r) => setTimeout(r, 3000));
      }
      throw new Error("the burn did not confirm in time — it may still land; check your bridges below");
    } catch (e) {
      setError(describeError(e));
      setStatus("");
      // ⛔ THE BURN IS ON CHAIN. Remove the sign control so it cannot be clicked again — a second
      // signature would burn a second time. `signedHash` stays set, and the recovery block below
      // offers a retry of the RECORD only.
      if (submitted) { setBurn(null); setQuote(null); }
    } finally { setBusy(false); }
  }

  // ⭐ RETRY THE RECORD, NEVER THE BURN. Idempotent: promote re-reads a chain fact the server
  // verifies itself. It cannot spend, and it cannot double-anything.
  async function retryPromote() {
    if (!signedHash || !intentId) return;
    setError(null); setBusy(true); setStatus("Confirming on Arc…");
    try {
      for (let i = 0; i < 20; i++) {
        const p = await agentClient.userBridgePromote({ intentId, burnHash: signedHash }, await w.ensureSession());
        if (p.ok) { setResult({ burnHash: signedHash, netPredicted: p.body.netPredicted }); setStatus(""); return; }
        if (p.status !== 202) throw new Error(p.body?.error ?? "could not confirm the burn");
        await new Promise((r) => setTimeout(r, 3000));
      }
      throw new Error("still not visible on Arc — it may take longer; you can retry again");
    } catch (e) { setError(describeError(e)); setStatus(""); } finally { setBusy(false); }
  }

  // ═══ 🚨 TWO STATES, TWO MESSAGES — they were one, and the one was WRONG for half of them ═════
  // "Connect MetaMask" was shown to everyone who is not currently ON MetaMask, including users who
  // HAVE connected it and are simply active on their passkey wallet. Telling them to connect what
  // they already connected is an instruction that cannot succeed, and it reads as a broken app.
  // ⭐ The discriminator is `metamaskConnected` (presence) vs `isMetaMask` (presence AND active) —
  // see useWallet, which had to export the first before this branch was possible at all.
  if (!isMetaMask) {
    return (
      <div className="panel">
        <div className="panel-eyebrow">Bridge from your own wallet</div>
        <div className="status">
          {w.metamaskConnected
            ? "Switch to MetaMask to bridge with your own key — it is connected, but another wallet is active right now. The agent bridge is on the AI Agent page."
            : "Connect MetaMask to bridge with your own key. The agent bridge is on the AI Agent page."}
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-eyebrow">Bridge from your own wallet</div>

      {/* ⛔ THE ONE LINE THE AGENT PANEL DOES NOT NEED.
          ⭐ SHARED, not restated — see CustodyNotice. The bridge burns USDC only. */}
      <CustodyNotice token="USDC" />

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
        <select value={destination} onChange={(e) => setDestination(e.target.value)} disabled={busy || !destinations.length}>
          <option value="">{destinations.length ? "Choose a chain…" : "Loading chains…"}</option>
          {destinations.map((d) => (
            <option key={d.key} value={d.key}>{d.label}</option>
          ))}
        </select>
        <button onClick={() => start()} disabled={busy || !destination}>Get quote</button>
      </div>

      {disclosure && (
        <FeeDisclosureBox
          disclosure={disclosure}
          busy={busy}
          onAccept={() => start(disclosure.ackToken)}
        />
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

      {/* ⛔ BURNED BUT NOT RECORDED. The money has moved; only the record is missing. The one
          control offered is a retry of the RECORD — there is deliberately no way to sign again. */}
      {signedHash && !result && (
        <div className="status" style={{ borderLeft: "3px solid var(--warn)", paddingLeft: ".9rem" }}>
          <b>Your burn is on-chain.</b> We have not been able to record it yet — your funds are not
          at risk and the bridge will still complete.{" "}
          <a href={`${EXPLORER}/tx/${signedHash}`} target="_blank" rel="noreferrer">view the burn ↗</a>
          <div style={{ marginTop: 8 }}>
            <button onClick={retryPromote} disabled={busy}>Retry recording it</button>
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
