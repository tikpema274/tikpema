import { useState } from "react";
import qrcode from "qrcode-generator";
import AddressDisplay from "./AddressDisplay";
import type { useWallet } from "../wallet/useWallet";

type UnifiedWallet = ReturnType<typeof useWallet>;

// ReceivePanel — where someone sends you USDC. ONE address, and the caveats that make it safe.
//
// ═══ ⭐⭐ ONE POCKET, NOT A PICKER — AND THE CHOICE WAS ALREADY MADE ═══════════════════════════
// This app has three pockets and only TWO of them are addresses at all:
//   · "Your wallet" (w.address)      — ✅ the one shown here
//   · "Agent's wallet" (the SCA)     — a real address, but it is the agent's SPENDING FLOAT
//   · "Unified balance"              — ⛔ NOT AN ADDRESS. USDC enters it through a `depositFor`
//                                       contract call; a transfer cannot reach it.
//
// ⭐ YourMoney.tsx already settled which one receives, and already wrote the sentence: "Your wallet
// … Fully theirs; no caveat to make", with the blurb "Send USDC here from any wallet, exchange, or
// faucet." This panel is that decision given its own surface — it does not re-decide it.
//
// ⛔ A PICKER WOULD BE THE DEFECT. Offering three pockets whose rules differ is the choice that
// produces the wrong answer, and two of the three should never be offered: money sent to the agent
// float lands somewhere the sender did not mean, and money sent "to" the unified balance silently
// becomes agent float. That trap is real enough that the unified-balance address carries its own
// "not a deposit address" caution. [[a-category-label-became-a-position]]
//
// ═══ ⚠️ THE CHAIN CAVEAT IS LOAD-BEARING, NOT BOILERPLATE ═════════════════════════════════════
// An Arc address is 20 bytes and looks exactly like an Ethereum one. A sender can paste it into a
// mainnet or Base withdrawal and the funds go to an address nobody controls on that chain — no
// error, no bounce, unrecoverable. Naming the chain and the token is the whole safety content of a
// receive screen; the QR is convenience. [[absence-must-never-read-as-safe]]

/** Render the QR as an inline SVG path. ⭐ SYNCHRONOUS on purpose: an async/canvas QR is invisible
 *  to renderToStaticMarkup, so the guard could not assert the payload it encodes — and the payload
 *  is the part that must be right. `qrcode-generator` is zero-dependency and sync; `qrcode` pulls
 *  29 packages (a yargs CLI) for the same output. [[lockfile-is-the-authoritative-install]] */
function QrSvg({ text, size = 176 }: { text: string; size?: number }) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const cells: string[] = [];
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) cells.push(`M${c} ${r}h1v1h-1z`);
    }
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${count} ${count}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code for your receiving address"
      style={{ background: "#fff", borderRadius: 10, padding: 8, boxSizing: "content-box" }}
    >
      <path d={cells.join("")} fill="#000" />
    </svg>
  );
}

/**
 * ⭐⭐ THE LINK IS THE SHIPPED PARSER'S INPUT, NOT A NEW FORMAT. `#/send?to=…&amount=…` is already
 * read, validated and guarded by `paymentLinkParams` in SendPanel — a malformed address is dropped,
 * a non-positive amount falls back, and the payer's screen says the values came from a link. Minting
 * a second URL shape here would be a duplicate source of truth for the thing strangers click.
 * [[duplicate-source-of-truth-is-the-recurring-bug]]
 * ⚠️ The amount is OPTIONAL and omitted when unset — an `amount=` with nothing after it is a
 * malformed param the parser would (correctly) drop, so we do not emit one.
 */
export function paymentLink(origin: string, address: string, amount?: string): string {
  const amt = Number(amount);
  const q = Number.isFinite(amt) && amt > 0 ? `&amount=${amt}` : "";
  return `${origin}/#/send?to=${address}${q}`;
}

export default function ReceivePanel({ wallet: w }: { wallet: UnifiedWallet }) {
  const address = w.address;
  const [requestAmount, setRequestAmount] = useState("");
  const [shareNote, setShareNote] = useState("");
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const link = address ? paymentLink(origin, address, requestAmount) : "";

  // ⛔ FEATURE-DETECTED, NEVER ASSUMED. `navigator.share` is absent on most DESKTOP browsers, and a
  // Share button that silently does nothing is worse than no button — it is a control the user
  // cannot act on, the same rule WalletGuardNotice follows. Copy is the fallback, and BOTH branches
  // are asserted, because a fallback that only exists on the happy path is the failure this repo
  // keeps finding. [[absence-must-never-read-as-safe]]
  async function shareLink() {
    const canShare = typeof navigator !== "undefined" && typeof (navigator as any).share === "function";
    if (canShare) {
      try {
        await (navigator as any).share({
          title: "Pay me in USDC",
          text: requestAmount ? `Please send me ${requestAmount} USDC on Arc.` : "Here is my USDC address on Arc.",
          url: link,
        });
        return;
      } catch {
        /* the user dismissed the sheet, or the platform refused — fall through to copy */
      }
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
      <div className="panel-eyebrow">Receive</div>
      <h2>Get paid in USDC</h2>
      <div className="sub">
        This is your wallet's address. Anyone can send USDC to it — from another wallet, an
        exchange, or a faucet. You do not need to be online to receive.
      </div>

      {/* ⛔ NO ADDRESS, NO QR, AND SAY WHY. Rendering a placeholder or an empty QR would be a
          control the user cannot act on — the same rule WalletGuardNotice follows. */}
      {!address ? (
        <div className="status" style={{ borderLeft: "3px solid var(--warn)", paddingLeft: ".9rem" }}>
          You are not signed in, so there is no address to show yet. Open your{" "}
          <button className="linkbtn" onClick={() => (window.location.hash = "/wallet")}>
            Wallet
          </button>{" "}
          to get one.
        </div>
      ) : (
        <>
          <div className="row" style={{ justifyContent: "center", marginTop: 16 }}>
            <QrSvg text={address} />
          </div>

          <div
            className="status"
            style={{ marginTop: 16, padding: "12px 16px", background: "var(--field)",
                     border: "1px solid var(--line)", borderRadius: 12 }}
          >
            <div style={{ color: "var(--muted)", fontSize: "0.72rem", letterSpacing: "0.06em",
                          textTransform: "uppercase", marginBottom: 6 }}>
              Your wallet · receiving address
            </div>
            {/* ⭐ FULL, NOT MASKED. This screen exists to hand someone an address: it has to be readable
                aloud, comparable against what a sender typed, and checkable against the QR above it.
                Verification is the defence against address substitution, and a mask removes the
                thing being verified. */}
            <AddressDisplay address={address} defaultExpanded />
          </div>

          {/* ⚠️ THE ONE CLAIM THAT PREVENTS A LOSS. Placed under the address, where a reader who
              has just copied it still meets it — the same placement rule as the unified-balance
              caution, and for the same reason. */}
          <div className="status" style={{ marginTop: 12, borderLeft: "3px solid var(--warn)", paddingLeft: ".9rem" }}>
            <b>USDC on Arc only.</b> This address looks like an Ethereum address and is not one.
            USDC sent from another chain — Ethereum, Base, Polygon — will not arrive here and
            cannot be recovered. Check the sender is on Arc before they send.
          </div>

          {/* ═══ ⭐⭐ REQUEST AN AMOUNT, AND SHARE IT ═══════════════════════════════════════════
              The address above works on its own; this is the same address with an amount attached,
              as a link the payer's own send form reads. ⛔ It is OPTIONAL — leaving it blank shares
              a plain "here is my address", which is the common case and must not require a decision.
              ⚠️ SHARING HANDS OFF, IT DOES NOT SEND. The message goes from the user's own number or
              address through their own app; we never see the recipient, store a contact, or become
              a sending party — which is a privacy property AND the reason this needs no backend. */}
          <div className="status" style={{ marginTop: 16, padding: "12px 16px", background: "var(--field)",
                                          border: "1px solid var(--line)", borderRadius: 12 }}>
            <div style={{ color: "var(--muted)", fontSize: "0.72rem", letterSpacing: "0.06em",
                          textTransform: "uppercase", marginBottom: 8 }}>
              Ask for a specific amount (optional)
            </div>
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <input
                type="number"
                min="0"
                step="0.000001"
                placeholder="amount in USDC"
                value={requestAmount}
                onChange={(e) => setRequestAmount(e.target.value)}
                style={{ maxWidth: 180 }}
              />
              <button className="emerald" onClick={shareLink}>
                Share payment link
              </button>
            </div>
            {/* ⭐ THE LINK IS SHOWN, NOT HIDDEN BEHIND THE BUTTON. On a desktop browser with no
                share sheet, the copy fallback is the whole feature — and a user who can SEE the
                link can also check it points at their own address before sending it to anyone. */}
            <div className="qd mono" style={{ marginTop: 8, wordBreak: "break-all", opacity: 0.85 }}>
              {link}
            </div>
            {shareNote && (
              <div className="qd" style={{ marginTop: 6, color: "var(--warn)" }}>{shareNote}</div>
            )}
          </div>

          {/* ⭐ THE OTHER DIRECTION. Receive and send are the two halves of the same errand, and a
              reader who has just shown someone their address is often the next person to pay one.
              ⚠️ SECONDARY, AND BOTTOM-RIGHT, ON PURPOSE: this page's job is the address above it,
              so the outbound control must not compete with it. `linkbtn`-weight rather than
              `emerald` — a primary button here would read as "the thing to do on this screen",
              which is the opposite of true.
              ⛔ IT NAVIGATES, IT DOES NOT SEND. Nothing on a receive screen may move money. */}
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 18 }}>
            <button
              className="btn"
              onClick={() => (window.location.hash = "/send")}
              title="Go to the Send page"
            >
              Send instead →
            </button>
          </div>

          {/* ⭐ NAMES THE OTHER POCKETS RATHER THAN PRETENDING THERE IS ONE. A user who has read the
              Wallet page knows there are three; silence here would read as "this is the only one". */}
          <div className="sub" style={{ marginTop: 12 }}>
            Money received here lands in your own wallet — not your agent's float, and not your
            unified balance. Move it on from the{" "}
            <button className="linkbtn" onClick={() => (window.location.hash = "/wallet")}>
              Wallet page
            </button>{" "}
            when you want to.
          </div>
        </>
      )}
    </div>
  );
}
