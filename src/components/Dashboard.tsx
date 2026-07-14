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

// Dashboard — a landing/overview composed ONLY from reads the wallet hook
// already exposes (agentWallet address + balance, busy, isAuthenticated). No new
// endpoint, no agent-status call: agent-status reads the SHARED env demo wallet,
// not the per-user wallet, so surfacing it here would misrepresent the balance.
//
// ── WHY THIS PAGE IS SHAPED THE WAY IT IS ────────────────────────────────────────────
// The page used to show one balance card titled "Your wallet" — which read
// w.agentWallet, i.e. the AGENT'S dev-controlled SCA, NOT the user's passkey MSCA.
// Post-40ed27b that label is simply false, and it hid the thing that matters: there are
// THREE pockets, and they differ in the only dimension a user cares about under stress —
// can I get this back, alone?
//
//   1. Your wallet     (passkey MSCA)  w.address / w.usdcBalance   → they hold the key.
//   2. Agent's wallet  (dev SCA)       w.agentWallet.balance       → Withdraw, any time,
//                                                                    even if paused.
//   3. Unified balance (Gateway)       useGatewayBalance           → NO WAY OUT. Cannot be
//                                                                    withdrawn to the user by
//                                                                    ANY path. Spendable
//                                                                    cross-chain only.
//
// Below, those three render left-to-right in the order money actually flows, each wearing
// its reversibility ON ITS FACE. The badge idiom is lifted verbatim from AgentsPanel
// (amber = this one constrains you; 🔒 = you're free) because that page already works:
// it answers "who can touch my money?" at a glance. This one has to answer "where is my
// money, and which way does it move?"
//
// The action grid is grouped BY CONSEQUENCE, not by feature. A flat six-card grid gave
// Bridge and Deposit identical visual weight, and the author of this app clicked the
// wrong one — moving money OUT when they meant to move it between their own pockets.
// The consequence therefore lives IN THE LABEL, read BEFORE the click. Deliberately NO
// confirmation dialogs: those train people to click through.
export default function Dashboard({ wallet: w }: { wallet: UnifiedWallet }) {
  // Auto-update balances on a timer while a wallet is connected — reuses the
  // existing refreshAgentWallet (no new endpoint). Cleared on unmount. The
  // manual Refresh button below is unchanged.
  const hasWallet = !!w.agentWallet;
  useEffect(() => {
    if (!hasWallet) return;
    const id = setInterval(() => {
      w.refreshAgentWallet().catch(() => {});
      // The LOGIN wallet (MSCA) is now ON this page, so it has to be kept live too —
      // previously nothing here read it, which is precisely how it stayed invisible.
      // Read-only; a failure here must never disturb the agent balance above.
      w.refreshBalance?.().catch(() => {});
    }, BALANCE_POLL_MS);
    return () => clearInterval(id);
  }, [hasWallet, w.refreshAgentWallet, w.refreshBalance]);

  // ── HOP A (fund) and its REVERSE (withdraw) — relocated here from MyAgentPanel. ──────
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

  // YOUR unified balance across chains (/api/gateway-balance). This is now the CALLER'S OWN
  // Gateway balance, auth-gated — it used to be a public read of the SHARED agent wallet.
  // Kept out of useWallet (that's the plain per-user wallet balance) so a failure here never
  // touches it. useGatewayBalance owns the signed-out / provisioning / ready states.
  // The `wdTx` nonce re-reads it after a withdrawal, exactly as MyAgentPanel did.
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

  return (
    <>
      <div className="plane">
        <div className="panel-eyebrow">Overview</div>
        <h2>Your autonomous agent, on Arc.</h2>
        <div className="sub">
          One agent with its own on-chain wallet. Ask in plain language and it
          researches with cited sources, sends and swaps USDC, and bridges
          cross-chain to Ethereum, Base and more — gasless, no seed phrase, and
          kept within your per-transaction and daily spending caps.
        </div>

        {w.agentWallet ? (
          <>
            {/* ── YOUR MONEY — the three pockets, left to right in the order money flows.
                One glance must answer: where is every USDC, and which of these can I
                exit ALONE? The old single card could not answer either question: it
                showed the agent's float under the title "Your wallet" and never showed
                the user's actual wallet at all. */}
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
                     Never previously surfaced here. Fully theirs; no caveat to make. */}
              <Pocket
                label="Your wallet"
                amount={w.usdcBalance ?? "…"}
                badge="You hold the key"
              >
                <AddressDisplay address={w.address} />
                <div className="qd">
                  Yours. Send USDC here from any wallet, exchange, or faucet.
                </div>

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
                  <span className="mono">{w.agentWallet.eurcBalance ?? "…"}</span> EURC also
                  held here.
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
                    that is sitting in the Gateway unified balance. This comment used to
                    reassure that the money was merely slow to retrieve, via a server-side
                    contract call — DESCRIBING A MECHANISM THIS APP NEVER IMPLEMENTED. No
                    endpoint returns Gateway funds to the user. There is no way to get it
                    back. It can only be spent cross-chain. Say it here, next to the button,
                    BEFORE the user clicks and finds money missing. A Withdraw that silently
                    leaves funds behind is a lie, and this line is what stops it being one.
                    If this disclosure is ever separated from the button, the trap is back. */}
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
                     exit AT ALL (no endpoint returns it), so it wears the amber badge. Keeps all four states
                     (signed-out / provisioning / loading / error) rather than rendering a
                     broken card or a bare "—" that reads as a fault. */}
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
                {unified.status === "provisioning" && (
                  <div className="qd">Setting up your wallet…</div>
                )}
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
              <button className="linkbtn" onClick={() => go("wallet")}>
                Manage wallet
              </button>
            </div>
          </>
        ) : (
          // Three explicit entry points. Passkey/MetaMask start the connect flow
          // in THIS click (preserving the user gesture WebAuthn needs) and route
          // to the Wallet page, where status + the duplicate-wallet guard already
          // render. "Set up a new wallet" deep-links into that page's existing
          // create sub-flow (which carries the guard) via ?new.
          <div style={{ display: "grid", gap: 12, marginTop: 4 }}>
            <div>
              <button
                className="emerald"
                style={{ width: "100%" }}
                disabled={w.busy}
                onClick={() => {
                  go("wallet");
                  w.connectLogin().catch(() => {});
                }}
              >
                Connect a passkey
              </button>
              <div className="sub" style={{ margin: "6px 0 0" }}>
                Sign in with Face ID or fingerprint — no seed phrase.
              </div>
            </div>

            {(w.connectors.find((c) => c.kind === "metamask")?.isAvailable() ?? false) && (
              <div>
                <button
                  style={{ width: "100%" }}
                  disabled={w.busy}
                  onClick={() => {
                    go("wallet");
                    w.connectMetaMask().catch(() => {});
                  }}
                >
                  Connect MetaMask
                </button>
                <div className="sub" style={{ margin: "6px 0 0" }}>
                  Use your existing MetaMask wallet.
                </div>
              </div>
            )}

            <div>
              <button
                style={{ width: "100%" }}
                disabled={w.busy}
                onClick={() => go("wallet?new")}
              >
                Set up a new wallet
              </button>
              <div className="sub" style={{ margin: "6px 0 0" }}>
                New here? Create a fresh agent wallet.
              </div>
            </div>
          </div>
        )}

      </div>

      {/* ── DO SOMETHING — GROUPED BY CONSEQUENCE, NOT BY FEATURE ────────────────────────
          The old flat six-card grid gave Bridge and Deposit identical weight, which is how
          the author of this app clicked "Bridge" (money LEAVES Arc, costs a fee to undo)
          when they meant "Deposit to unified balance" (money moves between their own
          pockets). Feature-shaped grids do that: they sort by what the code does, not by
          what it costs you to be wrong.

          So: three groups, ordered by escalating consequence, and the consequence is IN THE
          LABEL where it is read BEFORE the decision — not behind a confirmation dialog,
          which only teaches people to click through. */}
      {/* NOTE — there is no longer a "Fund your agent" or "Withdraw" CARD here. Both used
          to be cards that linked to #/agent, where the forms lived. The forms now live in
          the pockets above, on this same screen, beside the balances they act on. A card
          that scrolls you 200px up to a control already in view is not navigation, it is
          the same duplication we just deleted from MyAgentPanel — one control, one home.

          Deposit KEEPS its card, because #/unified is a genuinely different page with its
          own explanation, its own cap, and its own commitment warning. */}
      <div className="plane">
        <div className="panel-eyebrow">Move money between your accounts</div>
        <div className="sub">
          Nothing leaves you. Fund and withdraw are in <b>Your money</b> above, beside the
          balances they move.
        </div>
        <div className="quick">
          {/* The ONE reversible-looking move that ISN'T fully reversible. It sits in this
              group because the money is still yours — but the amber warning is what stops
              it from reading like a free transfer between pockets. */}
          <button className="quick-card" onClick={() => go("unified")}>
            <div className="qt">Deposit to unified balance →</div>
            <div className="qd">
              <span style={{ color: "var(--warn)" }}>⚠ Committed</span> — releasing it is
              delayed and goes through us. The one pocket you can't pull back alone.
            </div>
          </button>
        </div>
      </div>

      <div className="plane">
        <div className="panel-eyebrow">Move money out</div>
        <div className="sub">
          <b>This leaves you.</b> Both of these send USDC somewhere you don't control.
        </div>
        <div className="quick">
          <button className="quick-card" onClick={() => go("send")}>
            <div className="qt">Send →</div>
            <div className="qd">
              <span style={{ color: "var(--warn)" }}>❗ Goes to someone else.</span> Gone —
              there is no undo.
            </div>
          </button>
          <button className="quick-card" onClick={() => go("bridge")}>
            <div className="qt">Bridge →</div>
            <div className="qd">
              <span style={{ color: "var(--warn)" }}>❗ Leaves Arc</span> for another chain.
              Bridging back costs a fee.
            </div>
          </button>
        </div>
      </div>

      <div className="plane">
        <div className="panel-eyebrow">Ask your agent</div>
        <div className="quick">
          <button className="quick-card" onClick={() => go("agent")}>
            <div className="qt">AI Agent →</div>
            <div className="qd">
              Give your agent a task in plain language — research, send, swap,
              bridge, or a multi-step plan.
            </div>
          </button>
          <button className="quick-card" onClick={() => go("research")}>
            <div className="qt">Research →</div>
            <div className="qd">
              Commission a cited research brief, settled on-chain in USDC.
            </div>
          </button>
          {/* The proposal loop's entry. Nav-less #/plan — distinct from Research, whose
              guardrail correctly declines "should I…" questions. Framing leads with the
              user deciding, because the agent proposes and only the user approves. */}
          <button className="quick-card" onClick={() => go("plan")}>
            <div className="qt">Plan an action →</div>
            <div className="qd">
              Describe an on-chain action; your agent researches it and proposes a plan
              you approve.
            </div>
          </button>

          {/* The AGENTS ROSTER (#/agents, nav-less). Leads with the trust distinction —
              only one agent can move money — because that is the thing worth knowing. */}
          <button className="quick-card" onClick={() => go("agents")}>
            <div className="qt">Your agents →</div>
            <div className="qd">
              See who acts for you, what each one spent, and stop any of them instantly.
              Only one can move your money.
            </div>
          </button>
          <button className="quick-card" onClick={() => go("nanopay")}>
            <div className="qt">Nanopayments →</div>
            <div className="qd">
              See how your agent pays a fraction of a cent for fresh data
              mid-research.
            </div>
          </button>
        </div>
      </div>
    </>
  );
}
