import { useEffect, useState } from "react";
import type { useWallet } from "../wallet/useWallet";
import { useGatewayBalance } from "../lib/useGatewayBalance";
import { agentClient } from "../lib/agentClient";
import { arcTestnet } from "../config/chain";
import AddressDisplay from "./AddressDisplay";
import SignInPrompt from "./SignInPrompt";

const EXPLORER = arcTestnet.blockExplorers.default.url;

type UnifiedWallet = ReturnType<typeof useWallet>;

const go = (id: string) => {
  window.location.hash = "/" + id;
};

// ── THE REVERSIBILITY BADGE ──────────────────────────────────────────────────────────
// Lifted from AgentsPanel's `movesFunds` badge, same visual grammar: bordered, its own
// line, AMBER when the fact constrains you and neutral when it doesn't. There it marks
// "can this agent move my money?"; here it marks "can I get this money back alone?".
// Same question from the other side, so it earns the same styling.
function Reversibility({ warn, children }: { warn?: boolean; children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "5px 8px",
        borderRadius: 7,
        fontSize: "0.73rem",
        lineHeight: 1.3,
        border: `1px solid ${warn ? "var(--amber)" : "var(--line)"}`,
        background: warn ? "var(--amber-soft)" : "transparent",
        color: "var(--paper)",
      }}
    >
      {warn ? "⚠ " : "🔒 "}
      {children}
    </div>
  );
}

// One pocket. Balance and reversibility on the SAME face — a number the user cannot act
// on is just decoration, and a warning they meet after committing is just an alibi.
function Pocket({
  label,
  amount,
  unit = "USDC",
  badge,
  warn,
  children,
}: {
  label: string;
  amount: React.ReactNode;
  unit?: string;
  badge: React.ReactNode;
  warn?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="status"
      style={{
        margin: 0,
        padding: "14px 16px",
        background: "var(--field)",
        border: "1px solid var(--line)",
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        style={{
          color: "var(--muted)",
          fontSize: "0.72rem",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: "1.3rem", fontWeight: 600, color: "var(--paper)" }}>
        {amount}{" "}
        <span style={{ fontSize: "0.82rem", color: "var(--muted)", fontWeight: 400 }}>
          {unit}
        </span>
      </div>
      <Reversibility warn={warn}>{badge}</Reversibility>
      {children}
    </div>
  );
}

// Auto-refresh cadence for the wallet balances. Manual Refresh stays.
const BALANCE_POLL_MS = 30_000;

// ── YOUR MONEY — the three pockets ───────────────────────────────────────────────────
// Extracted VERBATIM from the Dashboard, where it used to render inline, and moved onto
// the Wallet page (#/wallet) — the page whose whole subject is "where is my money". It
// renders ONLY in the connected state; the Wallet page owns the not-connected onboarding
// path (create / restore passkey) and never delegates it here.
//
// It takes the wallet as a PROP, exactly as it did on the Dashboard. There is no wallet
// context/provider in this app: useWallet() is called ONCE in App.tsx and the object is
// handed to every page. So the Fund / Withdraw / Refresh / Deposit handlers here are the
// same function identities the Dashboard called — nothing about the move touches them.
//
// ── WHY THIS BLOCK IS SHAPED THE WAY IT IS ───────────────────────────────────────────
// There are THREE pockets, and they differ in the only dimension a user cares about
// under stress — can I get this back, alone?
//
//   1. Your wallet     (passkey MSCA)  w.address / w.usdcBalance   → they hold the key.
//   2. Agent's wallet  (dev SCA)       w.agentWallet.balance       → Withdraw, any time,
//                                                                    even if paused.
//   3. Unified balance (Gateway)       useGatewayBalance           → NO WAY OUT. Cannot be
//                                                                    withdrawn to the user by
//                                                                    ANY path. Spendable
//                                                                    cross-chain only.
//
// They render left-to-right in the order money actually flows, each wearing its
// reversibility ON ITS FACE. The badge idiom is lifted from AgentsPanel (amber = this one
// constrains you; 🔒 = you're free) because that page already works: it answers "who can
// touch my money?" at a glance. This one answers "where is my money, and which way does
// it move?"
export default function YourMoney({ wallet: w }: { wallet: UnifiedWallet }) {
  // Auto-update balances on a timer while a wallet is connected — reuses the
  // existing refreshAgentWallet (no new endpoint). Cleared on unmount. The
  // manual Refresh button below is unchanged. This effect travelled here WITH the
  // block: it exists to keep the numbers on THIS block live, so it belongs wherever
  // the block renders, and the Dashboard no longer polls for balances it no longer shows.
  const hasWallet = !!w.agentWallet;
  useEffect(() => {
    if (!hasWallet) return;
    const id = setInterval(() => {
      w.refreshAgentWallet().catch(() => {});
      // Read-only; a failure here must never disturb the agent balance above.
      w.refreshBalance?.().catch(() => {});
    }, BALANCE_POLL_MS);
    return () => clearInterval(id);
  }, [hasWallet, w.refreshAgentWallet, w.refreshBalance]);

  // ── HOP A (fund) and its REVERSE (withdraw). ─────────────────────────────────────────
  // Unchanged money paths: the same connector for hop A (destination = the SERVER-RESOLVED
  // agent wallet, never a constant) and the same agent-withdraw endpoint (which takes NO
  // recipient — the server pays the session's own login wallet, so it can only ever pay the
  // caller). Same caps, same guardrails. What changed is only WHERE the controls live:
  // beside the balance they act on, because a card that promises "Withdraw any time" and
  // then sends you to another page to do it is a broken promise.
  const [fundAmt, setFundAmt] = useState("");
  const [fundBusy, setFundBusy] = useState(false);
  const [fundErr, setFundErr] = useState("");
  const [fundTx, setFundTx] = useState<string | null>(null);

  const [wdAmt, setWdAmt] = useState("");
  const [wdBusy, setWdBusy] = useState(false);
  const [wdErr, setWdErr] = useState("");
  const [wdTx, setWdTx] = useState<string | null>(null);

  const agentSca = w.agentWallet?.address ?? null;
  const agentBal = Number(w.agentWallet?.balance ?? 0);
  const loginBal = Number(w.usdcBalance ?? 0);

  // YOUR unified balance across chains (/api/gateway-balance). This is the CALLER'S OWN
  // Gateway balance, auth-gated. Kept out of useWallet (that's the plain per-user wallet
  // balance) so a failure here never touches it. useGatewayBalance owns the signed-out /
  // provisioning / ready states. The `wdTx` nonce re-reads it after a withdrawal.
  const unified = useGatewayBalance(w, wdTx ? 1 : 0);
  const gwParked = unified.status === "ready" ? Number(unified.total ?? 0) : 0;

  async function fundAgent() {
    setFundErr("");
    setFundTx(null);
    if (!agentSca) {
      setFundErr("Your agent wallet isn't ready yet — try again in a moment.");
      return;
    }
    setFundBusy(true);
    try {
      // Destination is the server-resolved agent wallet (/api/my-wallet →
      // ensureOwnerWallet(session)), never a constant. Amount validation (>0, <= balance)
      // lives in the connector against a LIVE chain read, so nothing signs on a bad input.
      const r = await w.fundAgentWallet(agentSca, Number(fundAmt));
      setFundTx(r.txHash);
      setFundAmt("");
      await w.refreshAgentWallet().catch(() => {});
      await w.refreshBalance?.().catch(() => {});
    } catch (e: any) {
      setFundErr(e?.message || "Funding failed");
    } finally {
      setFundBusy(false);
    }
  }

  // Reclaim the float. No recipient is sent — the server withdraws to the session's own
  // login wallet. NOT bound by the agent's pause / day-ceiling / send-cap: those bound the
  // AGENT, not the user reclaiming their own money. Withdraw must survive a pause.
  async function withdraw() {
    setWdErr("");
    setWdTx(null);
    setWdBusy(true);
    try {
      const token = await w.ensureSession();
      const r = await agentClient.withdraw(Number(wdAmt), token);
      setWdTx(r.txHash);
      setWdAmt("");
      await Promise.all([
        w.refreshAgentWallet().catch(() => {}),
        w.refreshBalance().catch(() => {}),
      ]);
    } catch (e: any) {
      setWdErr(e?.message || "Withdrawal failed");
    } finally {
      setWdBusy(false);
    }
  }

  // The block renders only once the agent wallet has resolved. The Wallet page gates on
  // this too (it shows "Preparing your wallet…"), so this is belt-and-braces for any
  // future caller — never a second onboarding path.
  if (!w.agentWallet) return null;

  return (
    <>
      {/* ── YOUR MONEY — the three pockets, left to right in the order money flows.
          One glance must answer: where is every USDC, and which of these can I
          exit ALONE? */}
      <div
        style={{
          color: "var(--muted)",
          fontSize: "0.72rem",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          margin: "0 0 10px",
        }}
      >
        Your money
      </div>
      <div className="quick" style={{ marginBottom: 4 }}>
        {/* 1. THE USER'S OWN WALLET (passkey MSCA) — w.address / w.usdcBalance.
               Fully theirs; no caveat to make. */}
        <Pocket label="Your wallet" amount={w.usdcBalance ?? "…"} badge="You hold the key">
          <AddressDisplay address={w.address} />
          <div className="qd">Yours. Send USDC here from any wallet, exchange, or faucet.</div>

          {/* HOP A — the doorway from the user's wallet into the agent's float. Lives
              on the pocket the money LEAVES, not on a separate page. Never hidden when
              the wallet is empty (hiding it is what built the old dead end) — it just
              says so. */}
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              placeholder="Amount"
              value={fundAmt}
              disabled={fundBusy || loginBal <= 0}
              onChange={(e) => setFundAmt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && fundAmt && !fundBusy) fundAgent();
              }}
              style={{ maxWidth: 110 }}
            />
            <button
              className="emerald"
              disabled={fundBusy || loginBal <= 0 || !fundAmt || Number(fundAmt) <= 0}
              onClick={fundAgent}
            >
              {fundBusy ? "Moving…" : "Fund agent →"}
            </button>
          </div>
          {loginBal <= 0 && (
            <div className="qd">Empty — send USDC to the address above first.</div>
          )}
          {fundErr && (
            <div className="qd" style={{ color: "var(--danger, #e5484d)" }}>{fundErr}</div>
          )}
          {fundTx && (
            <div className="qd">
              Moved into your agent's wallet.{" "}
              <a href={`${EXPLORER}/tx/${fundTx}`} target="_blank" rel="noreferrer">
                View transaction ↗
              </a>
            </div>
          )}
        </Pocket>

        {/* 2. THE AGENT'S FLOAT (dev-controlled SCA) — what the agent actually
               spends from. Reversible in one button: agent-withdraw returns
               balanceOf(SCA), and it survives a pause. EURC lives here too, and is
               shown as a SEPARATE amount — never summed (EURC != $1). */}
        <Pocket
          label="Agent's wallet"
          amount={w.agentWallet.balance ?? "…"}
          badge="Withdraw any time"
        >
          <AddressDisplay address={w.agentWallet.address} />
          <div className="qd">
            The working float.{" "}
            <span className="mono">{w.agentWallet.eurcBalance ?? "…"}</span> EURC also held
            here.
          </div>

          {/* THE EXIT. The badge above promises "Withdraw any time" — so the button
              that honours it lives HERE, on the balance it returns. It is not bound by
              the agent's pause or caps: those bound the agent, not the user reclaiming
              their own money. */}
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              placeholder="Amount"
              value={wdAmt}
              disabled={wdBusy || agentBal <= 0}
              onChange={(e) => setWdAmt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && wdAmt && !wdBusy) withdraw();
              }}
              style={{ maxWidth: 110 }}
            />
            <button
              disabled={wdBusy || agentBal <= 0 || !wdAmt || Number(wdAmt) <= 0}
              onClick={withdraw}
            >
              {wdBusy ? "Withdrawing…" : "Withdraw ↩"}
            </button>
            <button
              className="linkbtn"
              disabled={wdBusy || agentBal <= 0}
              onClick={() => setWdAmt(String(agentBal))}
            >
              Max ({agentBal})
            </button>
          </div>

          {/* ── THE AMBER LINE. IT TRAVELS WITH THE WITHDRAW FORM, ALWAYS. ──────────
              Withdraw returns the agent's PLAIN USDC — balanceOf(SCA) — and NOTHING
              that is sitting in the Gateway unified balance. No endpoint returns Gateway
              funds to the user. There is no way to get it back. It can only be spent
              cross-chain. Say it here, next to the button, BEFORE the user clicks and
              finds money missing. A Withdraw that silently leaves funds behind is a lie,
              and this line is what stops it being one. If this disclosure is ever
              separated from the button, the trap is back — that includes moving the
              block between pages, which is exactly what just happened to it. */}
          {gwParked > 0 && (
            <div className="qd" style={{ color: "var(--warn)" }}>
              <b>Not included:</b>{" "}
              <span className="mono">{unified.status === "ready" ? unified.total : "—"}</span>{" "}
              USDC is in your unified balance. Withdraw does not move it — and{" "}
              <b>nothing can return it to you.</b> Unified-balance funds cannot be
              withdrawn; they can only be spent cross-chain.
            </div>
          )}
          {wdErr && (
            <div className="qd" style={{ color: "var(--danger, #e5484d)" }}>{wdErr}</div>
          )}
          {wdTx && (
            <div className="qd">
              Returned to your wallet.{" "}
              <a href={`${EXPLORER}/tx/${wdTx}`} target="_blank" rel="noreferrer">
                View transaction ↗
              </a>
            </div>
          )}
        </Pocket>

        {/* 3. THE UNIFIED BALANCE (Circle Gateway) — the ONLY pocket the user cannot
               exit AT ALL (no endpoint returns it), so it wears the amber badge. Keeps all
               four states (signed-out / provisioning / loading / error) rather than
               rendering a broken card or a bare "—" that reads as a fault. */}
        <Pocket
          label="Unified balance"
          amount={unified.status === "ready" ? unified.total : "…"}
          badge="Server-released, delayed"
          warn
        >
          {unified.status === "signed-out" && (
            <SignInPrompt
              wallet={w}
              message="Sign in to see your balance."
              onSignedIn={() => w.refreshAgentWallet().catch(() => {})}
            />
          )}
          {unified.status === "provisioning" && <div className="qd">Setting up your wallet…</div>}
          {unified.status === "loading" && <div className="qd">Reading your balance…</div>}
          {unified.status === "error" && <div className="qd">Unified balance unavailable.</div>}
          {unified.status === "ready" && (
            <>
              <div className="qd" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {unified.perChain.map((p) => (
                  <span key={p.chain}>
                    {p.chain}:{" "}
                    {p.ok ? (
                      <span className="mono">{p.usdc}</span>
                    ) : (
                      <span style={{ color: "var(--muted)" }}>unavailable</span>
                    )}
                  </span>
                ))}
              </div>
              {/* A true 0 means "fund me", not "broken". */}
              {Number(unified.total) === 0 && (
                <div className="qd">Empty — nothing committed yet.</div>
              )}
            </>
          )}
          <button className="linkbtn" onClick={() => go("unified")}>
            Deposit →
          </button>
        </Pocket>
      </div>

      <div className="row" style={{ marginTop: 12, alignItems: "baseline" }}>
        <button
          disabled={w.busy}
          onClick={() => {
            w.refreshAgentWallet().catch(() => {});
            w.refreshBalance?.().catch(() => {});
          }}
          style={{ padding: "6px 12px", fontSize: "0.8rem" }}
        >
          Refresh
        </button>
      </div>
    </>
  );
}
