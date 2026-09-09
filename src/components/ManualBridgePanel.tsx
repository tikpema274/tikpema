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
import { MINT_TIMING } from "../../shared/bridge-timing.mjs";
import { useEffect, useState } from "react";
import CustodyNotice from "./CustodyNotice";
import WalletGuardNotice from "./WalletGuardNotice";
import type { useWallet } from "../wallet/useWallet";
import { agentClient } from "../lib/agentClient";
import { arcTestnet } from "../config/chain";
import { describeError } from "../lib/describeError";
import { displayAmount } from "../lib/formatAmount";
import { BridgeQuoteSummary } from "./BridgeQuoteSummary";
// ⛔ The sentence about WHERE the fee is charged is not written here. It is read from the producer,
// keyed by the mechanic the quote carries. [[duplicate-source-of-truth-is-the-recurring-bug]]
import { bridgeMechanicCopy } from "../../shared/bridge-mechanic.mjs";

type UnifiedWallet = ReturnType<typeof useWallet>;
const EXPLORER = arcTestnet.blockExplorers.default.url;

type Quote = {
  amountUsdc: number; feeUsdc: number; netPredicted: number;
  feeRatio: number; feeBand: "none" | "warn" | "acknowledge";
  /** ⭐ From the producer. Absent on a stale quote ⇒ `unknown` copy, which claims neither. */
  mechanic?: string;
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
    // 🚨 A NEW BRIDGE MUST NOT INHERIT THE LAST ONE'S TERMINAL STATE. `result` was never cleared
    // here, so a second bridge priced and ran with the PREVIOUS bridge's green "Bridge submitted ✓"
    // and its burn link still on screen — the figures on display belonged to a different transfer.
    // ⛔ `signedHash` and `intentId` go with it, and not clearing them would be worse than the bug
    // being fixed: the recovery block renders on `signedHash && !result`, so clearing `result`
    // alone would surface the OLD bridge's "retry the record" control during the new one.
    setResult(null); setSignedHash(null); setIntentId(null);
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

  // ⭐⭐ ONE PRODUCER FOR THE SUCCESS TRANSITION. Both paths that can succeed — the promote loop in
  // signAndBurn and retryPromote — end here, so the "clear the live form" rule cannot be applied at
  // one site and forgotten at the other. [[duplicate-source-of-truth-is-the-recurring-bug]]
  //
  // 🚨 WHY THE FORM IS CLEARED AT THE TRANSITION, NOT WHEN IT IS NEXT USED. This panel's form is
  // under no `{result}` guard — it stays LIVE beside the success banner. Retaining the submitted
  // amount there is a pre-filled one-click repeat of an irreversible transfer. Clearing at the
  // transition means there is never a moment when a populated form sits behind a success screen.
  //
  // ⭐ SAFE HERE BECAUSE THE TERMINAL STATE READS NONE OF IT — checked, not assumed: the success
  // block renders `result.netPredicted` and `result.burnHash` only, and the fee disclosure renders
  // the SERVER's `d.amountUsdc` / `d.destinationLabel`, not this form state. So no snapshot is
  // needed. On a confirmation that echoed the amount, this same move would blank the disclosure.
  //
  // ⚠️ `destination` is deliberately KEPT. It is a choice from a server-supplied list, not free
  // text — the same distinction ManualSendPanel drew when it cleared a 42-character recipient but
  // not a token choice among four. Re-picking a chain is not the hazard; re-sending an amount is.
  function finishBridge(burnHash: string, netPredicted: number) {
    setResult({ burnHash, netPredicted });
    setAmount("");
    setStatus("");
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
        if (p.ok) { finishBridge(hash, p.body.netPredicted); return; }
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
        if (p.ok) { finishBridge(signedHash, p.body.netPredicted); return; }
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
      <div className="plane">
        <div className="panel-eyebrow">Bridge from your own wallet</div>
        {/* ⭐ SHARED, not restated — see WalletGuardNotice. */}
        <WalletGuardNotice metamaskConnected={!!w.metamaskConnected} active={w.activeKind === "metamask"}
          verb="bridge" twinLabel="AI Agent" twinRoute="/agent"
          onConnect={() => w.connectMetaMask().catch(() => {})} busy={w.busy}
          replacesSession={!!w.address} />
      </div>
    );
  }

  return (
    <div className="plane">
      <div className="panel-eyebrow">Bridge from your own wallet</div>

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
      {/* ⭐⭐ CUSTODY FIRST — MONEY BEFORE RECORD. This sat BELOW the form for one commit, on a
          "standing context" label that had quietly become a POSITION rather than a category. It is
          a constraint on the action about to be taken, so it belongs above the control: custody is
          about whose MONEY moves and under what limits; the hazard below is about the RECORD.
          ⭐ SUBORDINATE ≠ BELOW. The quiet treatment is unchanged — it is smaller, muted and dense
          against the hazard's bordered box. Rank is carried by weight, not by position.
          ⛔ WRAPPED, NOT RESTYLED: CustodyNotice is shared by three panels and this is bridge only,
          so the treatment lives on the wrapper. All 38 words stay, and the rendered TEXT is
          unchanged — which is what every suite asserts on. */}
      <div className="standing-note">
        <CustodyNotice token="USDC" />
      </div>

      {/* ⭐⭐ A HAZARD, NOT A NOTE — and it must not be a note in a different colour. As a `.status`
          with a --warn rail this was the same SHAPE as five other rails on this journey that are
          not hazards, so the colour did all the work and none of it read. `.hazard-callout` is a
          bordered box: it differs in shape, size, weight and density, and stays distinguishable
          with the colour removed. ⛔ ABOVE the form deliberately — this is met BEFORE typing.
          ⚠️ verify-deployed-disclosure.mjs uses "stay on this page until the burn confirms" as a
          build CONTROL via bundle.includes(). That CLAUSE stays verbatim; the rest of the sentence
          changed 2026-09-07 and the control is unaffected by design, not by luck.

          ═══ ⭐⭐ REWORDED ONLY AFTER THE SWEEPER WAS SCHEDULED **AND** OBSERVED RUNNING ═══════
          It used to end "we lose the record of it, so it will not appear in your bridges and we
          cannot show you what arrived" — accurate for as long as nothing swept. bridge-discover-sweep
          now runs every 10 minutes: 6 consecutive clean ticks measured 08:10-09:00 on 2026-09-07,
          793-842 blocks each, lag 25-140 blocks. Softening this before that existed would have
          described a recovery that did not happen.
          ⛔ "STAY" SURVIVES, because leaving still costs something. Turning it into "you can leave"
          would be the opposite overstatement — the exact failure BRIDGE_SIGNER exists to prevent.
          ⭐ "THE RECORD IS DELAYED RATHER THAN LOST" IS THE WHOLE CLAIM, and it is bounded three ways
          on purpose. It does NOT say "we will always recover it": six clean ticks are six ticks, and
          the sweeper has never yet met a window it could not read. It gives the REASON rather than
          asking for trust — "we recorded this bridge when you priced it" is user-facing for
          `user-bridge-start` writing the provisional record BEFORE the burn exists, which is exactly
          what makes the owner enumerable to a store-driven sweep. And it keeps STAY as the preferred
          path on its own merits: faster, and the only place the result is shown.
          ⛔ THE BOUNDARY IS REAL AND IS DELIBERATELY NOT IN THIS SENTENCE. A burn from a wallet that
          never quoted through the app is invisible to discovery — permanently, since enumeration is
          store ∪ operator wallets. But a reader of THIS panel has quoted through the app by
          definition, so the caveat describes a case they cannot be in. Copy that answers questions
          the reader does not have is how the sentence they DO need gets skipped. It is recorded in
          _bridge-discover.mjs's scope block and in shared/spike-source-guard.mjs, where the people
          who can actually be in that case will meet it.
          ⭐ AND IT NAMES THE CONSEQUENCE THAT IS PERMANENT: the recovered burn arrives as a SECOND
          row and the intent you started stays marked unfinished. MEASURED in the live store — one
          bridge, two rows 11 seconds apart (tx-user-mtdhmeh8… burn_submitted, 0x0938de7c… minted).
          ⚠️ That duplicate is NOT a bug awaiting a fix: retiring the parked intent would require
          deciding the discovered burn BELONGS to it, which is the probable-not-certain attribution
          this design refuses — refused even on a pair whose fee matched to six decimals. The
          duplicate is the price of never writing a wrong provenance, and the copy discloses it
          rather than pretending it away. */}
      <div className="hazard-callout">
        After you sign, <b>stay on this page until the burn confirms</b> — it is faster, and it is
        where you see what arrived. If you leave, the bridge still completes on-chain and your funds
        are not at risk. The record is delayed rather than lost: we recorded this bridge when you
        priced it, so a sweep finds the burn on-chain within about ten minutes. It comes back as a
        separate entry, and the one you started here stays marked unfinished.
      </div>

      {/* ⭐ FROM/TO SIDE BY SIDE, matching the agent panel — and FROM is a DISABLED SELECT, not
          static text, for the reason recorded there: a greyed control that cannot be changed says
          "this is fixed", while a text field says "this was never a control", presenting a limit as
          a design choice. `disabled` also drops it from the tab order, so the keyboard path goes
          straight to the only decision actually available.
          ⛔ The destination list is still the SERVER'S, loaded on mount and failing closed — the
          agent panel's static DESTINATIONS is not borrowed with the layout. A hardcoded dropdown
          here is the exact defect that once resolved "base-sepolia" to ETHEREUM on a real bridge. */}
      <div className="field-pair">
        <div className="field">
          <label htmlFor="mb-from">From</label>
          <select id="mb-from" disabled value="arc">
            <option value="arc">Arc Testnet</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="mb-dest">To</label>
          <select id="mb-dest" value={destination} disabled={busy || !destinations.length}
            onChange={(e) => setDestination(e.target.value)}>
            <option value="">{destinations.length ? "Choose a chain…" : "Loading chains…"}</option>
            {destinations.map((d) => (<option key={d.key} value={d.key}>{d.label}</option>))}
          </select>
        </div>

      {/* ⭐ THE AMOUNT WAS THE SMALLEST ELEMENT ON A PAGE ABOUT MOVING MONEY — 0.95rem against a
          1.5rem heading, and within 10% of the prose around it. It is now the largest thing here.
          Label text is unchanged. */}
      <div className="amount-field">
        <span className="amount-label">Amount (USDC)</span>
        <input className="amount-input" inputMode="decimal" value={amount}
          onChange={(e) => setAmount(e.target.value)} disabled={busy} />
      </div>

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
          {/* ═══ ⭐⭐ THE SAME THREE-ROW TABLE THE AGENT PANEL USES — ONE COMPONENT, NOT A FORK ═════
              It was a single comma-separated line: "1.0000 USDC → Base · fee 0.0543 · estimated
              arrival 0.9457". ⭐ The three labels serve BOTH mechanics; only the arithmetic moves,
              so the mechanic is visible in WHICH NUMBER CHANGES — a reader checks that by
              subtraction rather than by trusting prose.
              ⛔ `signer="browser"` is what makes the reuse safe. The component's page instruction
              used to be an unconditional "you can leave this page", which is FALSE here: the burn
              is signed in this tab and a SECOND request writes the receipt. It is now keyed on the
              signer axis, so this panel renders the STAY instruction and cannot render the other.
              ⚠️ `heldFeeNote={false}` — see verify-bridge-mechanic-pairing's tripwire: the "will be
              charged" sentence overstates (maxFee is a CEILING) and must not be propagated to a
              second panel while that wording stands. */}
          <BridgeQuoteSummary
            quote={quote}
            destinationLabel={quote.destinationLabel}
            mechanic={quote.mechanic}
            signer="browser"
            heldFeeNote={false}
          />
        </div>
      )}

      {/* ⭐⭐ ONE FULL-WIDTH BUTTON, AND THE LABEL CARRIES THE STATE — matching the agent panel.
          It was TWO buttons in two blocks: "Get quote" inside the form row and "Sign and bridge"
          inside the quote block, so the action moved down the page as state changed and the user
          had to find it again. One control in one place, whose text says what pressing it will do.
          ⛔ THE SIGNING STEP STAYS NAMED. "Bridge N USDC → Base" would be the agent panel's wording,
          and here it would hide the one fact that distinguishes this path: YOU sign it, in this tab.
          The label says "Sign and bridge" for that reason, not for symmetry with the sibling. */}
      {!result && (
        <button className="emerald btn-wide" disabled={busy || !destination || !amount}
          onClick={quote ? signAndBurn : () => start()}>
          {busy ? (quote ? "Waiting for your signature…" : "Pricing…")
            : quote ? `Sign and bridge ${amount} USDC → ${quote.destinationLabel}`
            : "Get quote"}
        </button>
      )}

      {/* ⭐ MOVED BELOW THE ACTION. The three-row summary now shows the deduction by WHICH NUMBER
          MOVES, so this prose no longer has to establish that a fee exists — it carries only the
          part a table cannot: that the arrival is an ESTIMATE until the destination chain is read.
          ⛔ Text unchanged, and its position is the change. Above the form it competed with the
          hazard note for the reader's one pre-typing glance; the hazard is the thing that must be
          met first, and two callouts in that slot meant neither was.
          ⚠️ NOT merged into the summary: it is about a FUTURE reading, not about this quote. */}
      <div className="status">
        A live cross-chain fee (taken from the amount) applies — the confirmation shows the
        exact fee quoted at execution and an <b>estimated</b> arrival; the exact delivered
        amount appears once we have read the destination chain.
      </div>

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
          arrive — {MINT_TIMING}. The exact delivered amount appears
          in your bridges once we have read the destination chain.{" "}
          <a href={`${EXPLORER}/tx/${result.burnHash}`} target="_blank" rel="noreferrer">burn ↗</a>
        </div>
      )}
    </div>
  );
}
