// ManualSendPanel — send USDC from the CONNECTED wallet (MetaMask), user-signed.
//
// ═══ ⭐ WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ═══════════════════════════════════════════
// It is `fundAgentWallet` with the destination opened up — one user-signed ERC-20 transfer. It is
// NOT a second copy of the manual BRIDGE with the word changed, and three of the bridge's most
// visible features are absent ON PURPOSE. Each absence is a decision recorded in
// docs/manual-send-design-note.md, and each is asserted in verify-send-copy.tsx so it cannot drift
// back in by symmetry:
//
//   · NO RECEIPT. The bridge writes one because delivery is on another chain, the delivered amount
//     differs from the sent amount, and an estimate must advance to measured. None survives here:
//     delivery IS this transaction, amount received == amount sent, there is no estimate.
//   · NO "STAY ON THIS PAGE" WARNING. That warning exists because the bridge's record is written by
//     a SECOND request after signing, so leaving loses it. Nothing is written here after the
//     signature, so leaving loses nothing — and warning anyway would frighten a user about a risk
//     that does not exist on this path.
//   · NO ACK GATE. The bridge's bands are ratios of a fee TAKEN FROM THE AMOUNT. No fee is deducted
//     from a same-chain transfer, so there is no band to disclose. An ack TOKEN binds a
//     server-computed number the client must not choose; there is no server-computed number here.
//
// ⛔ AGENT SPENDING CAPS DO NOT APPLY, AND IT IS SAID OUT LOUD — same reasoning as the manual
// bridge, agent-withdraw and ub-withdraw. ⚠️ It is said here only because SendPanel now states the
// caps it DOES enforce: an absence stated against silence tells the reader nothing.
//
// 🚨 THE ONE NEW RISK vs the agent send: a mistyped address. A same-chain transfer is irreversible
// and no server-side allowlist stands behind this call. The review step exists for exactly that —
// it shows the address AS WE PARSED IT, catching a truncated or whitespace-damaged paste before it
// reaches MetaMask. It is not a second safety net over MetaMask's own confirmation.
import { useState } from "react";
import type { useWallet } from "../wallet/useWallet";
import { arcTestnet } from "../config/chain";
import { CONTRACTS } from "../config/contracts";
import { describeError } from "../lib/describeError";
import CustodyNotice from "./CustodyNotice";
import WalletGuardNotice from "./WalletGuardNotice";

type UnifiedWallet = ReturnType<typeof useWallet>;
const EXPLORER = arcTestnet.blockExplorers.default.url;

// ⭐ EXPORTED AND PURE so a suite can RENDER it. It is reachable in the app only after the user
// clicks Review, which `renderToStaticMarkup` never does — exactly the blind spot that let the
// manual bridge ship a disclosure with no numbers in it. Rendering the state directly is strictly
// stronger than regexing the source for it. [[a-state-behind-a-transition-is-untested-by-default]]
//
// ⚠️ IT SHOWS THE ADDRESS IN FULL AND UNTRUNCATED, deliberately. A shortened `0x1234…abcd` would
// defeat the entire point of the step: the paste errors this catches (a truncated copy, a
// whitespace-damaged tail) live precisely in the characters an ellipsis hides.
//
// ═══ 🚨 IT ALSO NAMES THE ASSET, AND IT IS THE ONLY PLACE THAT DOES ══════════════════════════════
// MEASURED on the first live run (tx 0x637b3556…, 2026-08-30): MetaMask displayed **"1 Unknown"**,
// not "1 USDC". Established, not assumed — the token returns `symbol() = "USDC"`, `decimals() = 6`
// from 1798 bytes of real code, and our calldata is the canonical `0xa9059cbb` transfer, so there
// is nothing in what we send that could change the name MetaMask prints.
//
// ⭐⭐ SO A USER CHECKING ONLY METAMASK CAN SEE HOW MUCH, BUT NOT WHAT. The design note argued this
// step "is not a second safety net" over MetaMask's confirmation. For the ADDRESS that is right.
// For the ASSET it is wrong: this is not a second net, it is the only one.
//
// 🚨 AND NAMING IT IS NOT ENOUGH ON ITS OWN. Saying "USDC" here while MetaMask says "Unknown" hands
// the user a CONTRADICTION and no way to resolve it — and this repo's own rule is that a claim
// contradicting what the user sees elsewhere is a defect, not a nicety. So the box states the
// discrepancy BEFORE they meet it, and gives the token address, which is the one thing they can
// actually check against MetaMask and the explorer.
//
// ⚠️ WORDED AS AN OBSERVATION, NOT A DIAGNOSIS. What was verified is that MetaMask does not name
// this token and that the cause is not ours. WHY it does not — token lists rather than an on-chain
// `symbol()` read — was NOT verified against MetaMask's source, so the copy does not assert it.
export function SendReviewBox({
  to, amountUsdc, busy, onSign, onBack,
}: { to: string; amountUsdc: number; busy: boolean; onSign: () => void; onBack: () => void }) {
  return (
    <div className="status" style={{ borderLeft: "3px solid var(--warn)", paddingLeft: ".9rem" }}>
      Sending <b>{amountUsdc} USDC</b> to <span className="mono">{to}</span>
      <div style={{ marginTop: 6 }}>
        Token: <b>USDC</b> on {arcTestnet.name} — <span className="mono">{CONTRACTS.USDC}</span>
      </div>
      <div style={{ marginTop: 6 }}>
        ⚠️ <b>MetaMask does not recognise this token</b> and will show the amount without a name,
        like <span className="mono">1 Unknown</span>. That is MetaMask, not a problem with this
        transfer — the token address above is what you are sending, and you can check it there.
      </div>
      <div style={{ marginTop: 8 }}>
        <button className="emerald" onClick={onSign} disabled={busy}>
          {busy ? "Confirm in MetaMask…" : "Sign and send"}
        </button>{" "}
        <button onClick={onBack} disabled={busy}>Back</button>
      </div>
    </div>
  );
}

export default function ManualSendPanel({ wallet: w }: { wallet: UnifiedWallet }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("0.1");
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentHash, setSentHash] = useState<string | null>(null);
  // ⭐⭐ A SNAPSHOT, NOT A READ OF LIVE FORM STATE. The confirmation must survive the clearing that
  // happens in the same transition, so it renders from here rather than from `to`/`amount`. ⛔ And
  // it is INERT: nothing submits from it, so restoring the disclosure does not reintroduce the
  // pre-filled-repeat hazard that clearing exists to prevent.
  // [[clear-on-transition-needs-a-terminal-state-that-reads-nothing]]
  const [sent, setSent] = useState<{ to: string; amount: number } | null>(null);

  const isMetaMask = w.activeKind === "metamask";
  // ⭐ Parsed HERE, and the review step renders THIS value rather than the raw input — that is the
  // whole point of the step. A trailing space or a truncated paste shows up as a rejected or
  // visibly-wrong address before anything is signed.
  const parsedTo = to.trim();
  const toValid = /^0x[0-9a-fA-F]{40}$/.test(parsedTo);
  const amountNum = Number(amount);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;

  async function signAndSend() {
    if (!toValid || !amountValid) return;
    setError(null);
    setBusy(true);
    try {
      const r = await w.sendUsdcManual!(parsedTo, amountNum);
      setSentHash(r.txHash);
      setReviewing(false);
      // ⭐ CAPTURED BEFORE THE CLEAR, in the same transition — the order is the mechanism.
      // `parsedTo`/`amountNum` are the values actually SUBMITTED, not the raw field contents.
      setSent({ to: parsedTo, amount: amountNum });
      // ⭐⭐ CLEARED AT THE TRANSITION INTO SUCCESS, NOT WHEN THE FORM COMES BACK. The dangerous
      // state is not what "Send another" resets — it is what survives BEHIND the success screen.
      // `to` and `amount` used to sit here untouched, so any later change that revealed the form
      // without clearing them — deleting the `{!sentHash && …}` guard, an unmount/remount, a
      // refactor of the success block — would have produced a pre-filled one-click repeat of an
      // IRREVERSIBLE transfer with no allowlist behind it. Clearing here means the values are gone
      // the moment they stop being needed, and no future edit can un-hide something harmful.
      // ⭐ THE RECIPIENT GOES TOO, not just the amount: an address someone pasted once is not
      // evidence they mean to send there again, and this panel's own copy says the transfer cannot
      // be reversed. [[absence-must-never-read-as-safe]]
      setTo("");
      setAmount("0.1");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  // ═══ 🚨 TWO STATES, TWO MESSAGES — the collapse the manual bridge shipped with ═════════════════
  // `metamaskConnected` is PRESENCE, `isMetaMask` is presence AND active. Telling someone to
  // connect a wallet they have already connected is an instruction that cannot succeed. This panel
  // is built on the fixed hook rather than repeating the defect.
  if (!isMetaMask) {
    return (
      <div className="plane">
        <div className="panel-eyebrow">Send</div>
        <h2>Send from your own wallet</h2>
        {/* ⭐ SHARED, not restated. `metamaskConnected` is a REQUIRED prop, so a panel cannot
            render this guard without the fact that tells the two states apart. */}
        <WalletGuardNotice metamaskConnected={!!w.metamaskConnected} active={w.activeKind === "metamask"}
          verb="send" twinLabel="Send" twinRoute="/send"
          onConnect={() => w.connectMetaMask().catch(() => {})} busy={w.busy}
          replacesSession={!!w.address} />
      </div>
    );
  }

  return (
    <div className="plane plane--form">
      <div className="panel-eyebrow">Send</div>
      <h2>Send from your own wallet</h2>
      <div className="sub">You sign this in MetaMask — it moves your own USDC, not the agent's.</div>

      {/* ⛔ THE LINE THE AGENT SEND PANEL DOES NOT NEED, and the counterpart to the one it now
          carries. Stated only in this state, where the control is actually offered — a standing
          "caps do not apply" beside no control is a claim about a path the user cannot take.
          ⭐ SHARED, not restated: one statement of the custody position for all three self-signed
          panels. This send spends USDC only, so it names USDC. */}
      <div className="standing-note">
        <CustodyNotice token="USDC" />
      </div>

      {/* 🚨 IRREVERSIBLE, AND NO ALLOWLIST BEHIND IT. The agent send resolves its wallet
          server-side; this destination is whatever was typed. Said before the address is entered,
          not after. */}
      <div className="hazard-callout">
        <b>Check the address carefully.</b> This is a normal transfer on Arc — once it confirms it
        cannot be reversed, and there is no allowlist behind it. We show you the address exactly as
        we read it before you sign.
      </div>

      {!sentHash && (
        <>
          <div className="row">
            <input
              placeholder="recipient 0x…"
              value={to}
              onChange={(e) => { setTo(e.target.value); setReviewing(false); setError(null); }}
              disabled={busy}
            />
          </div>
          <div className="amount-field">
            <span className="amount-label">USDC</span>
            <input
              className="amount-input"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setReviewing(false); setError(null); }}
              disabled={busy}
            />
          </div>
          <div className="row">
            {!reviewing && (
              <button onClick={() => setReviewing(true)} disabled={busy || !toValid || !amountValid}>
                Review
              </button>
            )}
          </div>

          {to.trim() && !toValid && (
            <div className="status" style={{ color: "var(--warn)" }}>
              That is not a valid address — it should start with 0x and be 42 characters.
            </div>
          )}

          {/* ⭐ THE REVIEW STEP, extracted so it can be RENDERED by a suite — see the component. */}
          {reviewing && (
            <SendReviewBox to={parsedTo} amountUsdc={amountNum} busy={busy}
              onSign={signAndSend} onBack={() => setReviewing(false)} />
          )}
        </>
      )}

      {error && <div className="status" style={{ color: "var(--warn)" }}>{error}</div>}

      {sentHash && (
        <div className="status" style={{ color: "var(--emerald)" }}>
          {/* 🚨 WHAT WAS SENT, AND TO WHOM — the question this panel could not answer. The AGENT
              panel names both; this one, the IRREVERSIBLE path with no allowlist behind it, said only
              "Sent ✓" and sent the user to a block explorer to learn what the app already knew.
              ⭐⭐ THE ADDRESS IS SHOWN IN FULL, and deliberately NOT truncated the way #/send truncates.
              This panel promises one paragraph earlier that "We show you the address exactly as we read
              it before you sign", and its review step is asserted untruncated for a stated reason — an
              ellipsis hides exactly the characters a corrupted paste would change. A confirmation
              reading 0x0c5E…2532 would contradict, inside one flow, the promise the panel just made. */}
          Sent <b>{sent?.amount} USDC</b> to{" "}
          <span className="mono" style={{ wordBreak: "break-all" }}>{sent?.to}</span>{" "}
          ✓ — confirmed on Arc.{" "}
          <a href={`${EXPLORER}/tx/${sentHash}`} target="_blank" rel="noreferrer">view the transfer ↗</a>
          {/* ⭐ AN EXPLICIT CONTROL, not an auto-returning form. A completed send should not be
              repeatable by a stray click on a pre-filled form; requiring one deliberate press to
              get the form back is the whole point. It only clears `sentHash` — the FIELDS were
              already cleared at the transition above, so this button reveals an empty form rather
              than emptying a revealed one. */}
          <div style={{ marginTop: 10 }}>
            <button onClick={() => { setSentHash(null); setSent(null); setError(null); }}>Send another</button>
          </div>
        </div>
      )}
    </div>
  );
}
