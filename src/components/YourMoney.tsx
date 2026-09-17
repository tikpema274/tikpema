import { useEffect, useState } from "react";
import type { useWallet } from "../wallet/useWallet";
import { useGatewayBalance } from "../lib/useGatewayBalance";
import { agentClient } from "../lib/agentClient";
import { arcTestnet } from "../config/chain";
import AddressDisplay from "./AddressDisplay";
import SignInPrompt from "./SignInPrompt";
import { describeError } from "../lib/describeError";
import { describeChainError } from "../lib/describeChainError";
import { formatUsdc, formatUsdcShort } from "../lib/formatUsdc";
import { UB_EXIT_PROOF } from "../lib/ubExitProof";

const EXPLORER = arcTestnet.blockExplorers.default.url;

type UnifiedWallet = ReturnType<typeof useWallet>;

const go = (id: string) => {
  window.location.hash = "/" + id;
};

// The reversibility badge in the Exit column — amber (⚠) when the fact constrains you, neutral (🔒)
// when it doesn't. Same grammar as AgentsPanel's movesFunds badge.
function Badge({ text, warn }: { text: string; warn?: boolean }) {
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: "0.72rem",
        padding: "2px 7px",
        borderRadius: 6,
        border: `1px solid ${warn ? "var(--amber)" : "var(--line)"}`,
        background: warn ? "var(--amber-soft)" : "transparent",
        color: "var(--paper)",
      }}
    >
      {warn ? "⚠ " : "🔒 "}
      {text}
    </span>
  );
}

// Auto-refresh cadence for the wallet balances. Manual Refresh stays.
const BALANCE_POLL_MS = 30_000;

// ── YOUR MONEY — the wallet overview ─────────────────────────────────────────────────
// One table answering "where is every USDC, and which of these can I get back, alone?". Columns:
// Asset | Where held | Balance | Exit. "Where held" distinguishes an on-chain read from Pocket 3's
// off-chain Circle Gateway figure. The Total (top right) is USDC-only — EURC is NEVER summed (no USD
// rate exists) and is its own row. The Total and "available now" sum the EXACT values and floor ONCE;
// if ANY pocket is null/unavailable there is NO total number and the breakdown NAMES the missing
// pocket — a sum must never silently omit a pocket.
//
// It takes the wallet as a PROP. useWallet() is called ONCE in App.tsx; the Fund / Withdraw / Refresh
// / Deposit handlers here are the SAME function identities they always were — the money paths are
// byte-identical, only the layout changed.
//
//   1. Your wallet     (passkey MSCA)  w.usdcBalance            → you hold the key.
//   2. Agent's wallet  (dev SCA)       w.agentWallet.balance    → Withdraw now, instant, even paused.
//      · EURC also held here, shown as its OWN row, never summed (EURC != $1).
//   3. Unified balance (Gateway)       useGatewayBalance        → exit built, about seven days.
//
// ⚠️ Pocket 3 read "NO WAY OUT… by ANY path" until 2026-07-31. That was FALSE — Arc's Gateway exposes
// a trustless withdrawal keyed to an account only the agent can act as. The true statement is narrow:
// WE HAVE NOT BUILT the automatic client trigger here; this panel EXPLAINS the exit and links to
// #/unified, which carries the full flow. Anything absolute here is a claim about a contract this
// file has never read.
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
  // caller). Same caps, same guardrails.
  const [fundAmt, setFundAmt] = useState("");
  const [fundBusy, setFundBusy] = useState(false);
  const [fundErr, setFundErr] = useState("");
  const [fundTx, setFundTx] = useState<string | null>(null);

  const [wdAmt, setWdAmt] = useState("");
  const [wdBusy, setWdBusy] = useState(false);
  const [wdErr, setWdErr] = useState("");
  const [wdTx, setWdTx] = useState<string | null>(null);

  // Which rows are expanded. Expansion holds ONLY the address + Copy, the exact 6dp amount, and the
  // unified row's long custody note — never an action. The actions stay visible in the row.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const isExp = (id: string) => expanded.has(id);
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const agentSca = w.agentWallet?.address ?? null;
  const agentBal = Number(w.agentWallet?.balance ?? 0);
  const loginBal = Number(w.usdcBalance ?? 0);

  // YOUR unified balance across chains (/api/gateway-balance). This is the CALLER'S OWN
  // Gateway balance, auth-gated. Kept out of useWallet (that's the plain per-user wallet
  // balance) so a failure here never touches it. useGatewayBalance owns the signed-out /
  // provisioning / ready states. The `wdTx` nonce re-reads it after a withdrawal.
  const unified = useGatewayBalance(w, wdTx ? 1 : 0);
  const gwParked = unified.status === "ready" ? Number(unified.total ?? 0) : 0;

  // ── B1 (finding 10.3): the exit badge is a CLAIM ABOUT EXITING COMMITTED FUNDS. On an empty or
  // unreadable unified balance there is nothing to exit, so "Exit built · about seven days" must NOT
  // render — a static badge advertises an exit for money that is not there. It appears ONLY when
  // funds are parked; otherwise the badge states the pocket's actual condition, and drops the amber.
  const parked = gwParked > 0;
  const unifiedBadge = parked
    ? "Exit built · about seven days"
    : unified.status === "ready"
      ? "No funds committed"
      : unified.status === "signed-out"
        ? "Sign in to view"
        : unified.status === "error"
          ? "Balance unavailable"
          : "Checking balance…";

  // ── THE TOTAL & "available now" — NULL-PRESERVING, EXACT-THEN-FLOOR. ─────────────────────────
  // Read the null-preserving values, NOT the `?? 0` coerced agentBal/loginBal (those are for the
  // fail-closed disable logic only). USDC-only; EURC excluded. If ANY pocket is null or unavailable,
  // render NO total number and let the breakdown NAME the missing pocket.
  const p1 = w.usdcBalance ?? null;
  const p2 = w.agentWallet?.balance ?? null;
  const p3 = unified.status === "ready" ? (unified.total ?? null) : null;
  const totalStr = p1 == null || p2 == null || p3 == null
    ? null
    : formatUsdcShort(String(Number(p1) + Number(p2) + Number(p3))); // exact sum, floor ONCE
  const availStr = p1 == null || p2 == null
    ? null
    : formatUsdcShort(String(Number(p1) + Number(p2)));

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
      // ⛔ NOT describeError here: the connector throws viem's error, whose message carries the
      // full request dump (args, calldata, sender). The reason is what a person needs; the hex
      // blob beside a money figure is the leak. See describeChainError.
      setFundErr(describeChainError(e));
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
      setWdErr(describeError(e));
    } finally {
      setWdBusy(false);
    }
  }

  // The block renders only once the agent wallet has resolved. The Wallet page gates on
  // this too (it shows "Preparing your wallet…"), so this is belt-and-braces for any
  // future caller — never a second onboarding path.
  if (!w.agentWallet) return null;

  // The balance column: a null read is "unavailable" (never "0"), a true 0 is "0.00", else 2dp floor.
  const balCell = (v: string | null) =>
    v == null ? (
      <span style={{ color: "var(--warn)" }}>unavailable</span>
    ) : (
      formatUsdcShort(v)
    );

  const eurcRaw = w.agentWallet.eurcBalance ?? null;

  return (
    <>
      {/* ── HEADER: label left, USDC-only Total top-right. Null in any pocket → no number. ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: 4 }}>
        <div style={{ color: "var(--muted)", fontSize: "0.72rem", letterSpacing: "0.06em", textTransform: "uppercase" }}>
          Your money
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ color: "var(--muted)", fontSize: "0.68rem", letterSpacing: "0.06em", textTransform: "uppercase" }}>Total</div>
          {totalStr === null ? (
            <div style={{ fontSize: "1.05rem", fontWeight: 600, color: "var(--warn)" }}>partly unavailable</div>
          ) : (
            <div style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--paper)" }}>
              {totalStr} <span style={{ fontSize: "0.8rem", color: "var(--muted)", fontWeight: 400 }}>USDC</span>
            </div>
          )}
        </div>
      </div>

      {/* ── BREAKDOWN LINE: "available now" (P1+P2) · unified. Names any missing pocket. ── */}
      <div style={{ fontSize: "0.82rem", color: "var(--paper-dim)" }}>
        {availStr !== null ? (
          <>
            <b>{availStr} USDC</b> available now
          </>
        ) : (
          <>
            {p1 !== null ? <><b>{formatUsdcShort(p1)} USDC</b> in your wallet</> : <span style={{ color: "var(--warn)" }}>your wallet unavailable</span>}
            {"  ·  "}
            {p2 !== null ? <><b>{formatUsdcShort(p2)}</b> in agent's wallet</> : <span style={{ color: "var(--warn)" }}>agent's wallet unavailable</span>}
          </>
        )}
        {"  ·  "}
        {p3 !== null ? <><b>{formatUsdcShort(p3)}</b> in unified balance (about seven days to exit)</> : <span style={{ color: "var(--warn)" }}>unified balance unavailable</span>}
      </div>
      <div style={{ fontSize: "0.72rem", color: "var(--muted)", marginTop: 4, marginBottom: 12 }}>
        EURC is shown as its own row and is <b>never</b> added to the USDC total — there is no USD rate for it.
      </div>

      {/* ── THE TABLE (a CSS grid, not a <table>, so it restacks at phone width). ── */}
      <div className="ym-grid">
        <div className="ym-head">
          <div>Asset</div>
          <div>Where held</div>
          <div className="ym-bal">Balance</div>
          <div>Exit</div>
        </div>

        {/* 1. YOUR WALLET (passkey MSCA) — fully yours. */}
        <div className="ym-holding">
          <div className="ym-main">
            <div className="ym-asset">USDC</div>
            <div>Your wallet<span className="ym-src">on-chain read</span></div>
            <div className="ym-bal">{balCell(p1)}</div>
            <div className="ym-exit"><Badge text="You hold the key" /></div>
          </div>
          <div className="ym-actions">
            <div>Yours. Send USDC here from any wallet, exchange, or faucet.</div>
            <div className="row" style={{ gap: 8, alignItems: "center", marginTop: 6 }}>
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
            {loginBal <= 0 && <div style={{ marginTop: 4 }}>Empty — send USDC to the address above first.</div>}
            {fundErr && <div style={{ marginTop: 4, color: "var(--danger)" }}>{fundErr}</div>}
            {fundTx && (
              <div style={{ marginTop: 4 }}>
                Moved into your agent's wallet.{" "}
                <a href={`${EXPLORER}/tx/${fundTx}`} target="_blank" rel="noreferrer">View transaction ↗</a>
              </div>
            )}
          </div>
          <button className="linkbtn ym-toggle" onClick={() => toggle("wallet")}>{isExp("wallet") ? "less ▲" : "more ▼"}</button>
          <div className="ym-more" hidden={!isExp("wallet")}>
            <AddressDisplay address={w.address} />
            <div className="ym-mono" style={{ marginTop: 4 }}>Exact: {formatUsdc(w.usdcBalance)} USDC</div>
          </div>
        </div>

        {/* 2a. AGENT'S WALLET — USDC. Withdraw now returns it to your login wallet, instantly. */}
        <div className="ym-holding">
          <div className="ym-main">
            <div className="ym-asset">USDC</div>
            <div>Agent's wallet<span className="ym-src">on-chain read</span></div>
            <div className="ym-bal">{balCell(p2)}</div>
            <div className="ym-exit"><Badge text="Withdraw any time" /></div>
          </div>
          <div className="ym-actions">
            {p2 == null
              ? <div style={{ color: "var(--warn)" }}>Balance unavailable — Withdraw is disabled until it can be read.</div>
              : <div><b>Withdraw</b> returns this to your login wallet <b>instantly</b> — survives an agent pause.</div>}
            <div className="row" style={{ gap: 8, alignItems: "center", marginTop: 6 }}>
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
                {wdBusy ? "Withdrawing…" : "Withdraw now"}
              </button>
              {/* ⭐ No "Max (—)": the value shows only when there IS a balance; disabled otherwise.
                  The CLICK still sets the exact value (String(agentBal)) — byte-identical. */}
              <button
                className="linkbtn"
                disabled={wdBusy || agentBal <= 0}
                onClick={() => setWdAmt(String(agentBal))}
              >
                {p2 == null ? "Max" : `Max (${formatUsdc(p2)})`}
              </button>
            </div>
            {wdErr && <div style={{ marginTop: 4, color: "var(--danger)" }}>{wdErr}</div>}
            {wdTx && (
              <div style={{ marginTop: 4 }}>
                Returned to your wallet.{" "}
                <a href={`${EXPLORER}/tx/${wdTx}`} target="_blank" rel="noreferrer">View transaction ↗</a>
              </div>
            )}
          </div>
          <button className="linkbtn ym-toggle" onClick={() => toggle("agent-usdc")}>{isExp("agent-usdc") ? "less ▲" : "more ▼"}</button>
          <div className="ym-more" hidden={!isExp("agent-usdc")}>
            <AddressDisplay address={w.agentWallet.address} />
            <div className="ym-mono" style={{ marginTop: 4 }}>Exact: {formatUsdc(w.agentWallet.balance)} USDC</div>
          </div>
        </div>

        {/* 2b. AGENT'S WALLET — EURC. Held here; the agent's Withdraw returns USDC only. */}
        <div className="ym-holding">
          <div className="ym-main">
            <div className="ym-asset">EURC</div>
            <div>Agent's wallet<span className="ym-src">on-chain read</span></div>
            <div className="ym-bal">{balCell(eurcRaw)}</div>
            <div className="ym-exit"><Badge text="No exit built" /></div>
          </div>
          <div className="ym-actions">
            The agent's <b>Withdraw</b> returns USDC only — EURC stays in the agent wallet. <b>No exit is built</b> for it yet.
          </div>
          <button className="linkbtn ym-toggle" onClick={() => toggle("agent-eurc")}>{isExp("agent-eurc") ? "less ▲" : "more ▼"}</button>
          <div className="ym-more" hidden={!isExp("agent-eurc")}>
            <div className="ym-mono">Exact: {formatUsdc(w.agentWallet.eurcBalance)} EURC</div>
          </div>
        </div>

        {/* 3. UNIFIED BALANCE (Circle Gateway) — off-chain figure. Conditional exit badge (B1). */}
        <div className="ym-holding">
          <div className="ym-main">
            <div className="ym-asset">USDC</div>
            <div>Unified balance<span className="ym-src">Circle Gateway · off-chain figure</span></div>
            <div className="ym-bal">{unified.status === "ready" ? balCell(p3) : <span style={{ color: "var(--muted)" }}>…</span>}</div>
            <div className="ym-exit"><Badge text={unifiedBadge} warn={parked} /></div>
          </div>
          <div className="ym-actions">
            {unified.status === "signed-out" && (
              <SignInPrompt
                wallet={w}
                message="Sign in to see your balance."
                onSignedIn={() => w.refreshAgentWallet().catch(() => {})}
              />
            )}
            {unified.status === "provisioning" && <div>Setting up your wallet…</div>}
            {unified.status === "loading" && <div>Reading your balance…</div>}
            {unified.status === "error" && <div>Unified balance unavailable.</div>}
            {unified.status === "ready" && (
              <>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {unified.perChain.map((p) => (
                    <span key={p.chain}>
                      {p.chain}:{" "}
                      {p.ok ? <span className="ym-mono">{formatUsdc(p.usdc)}</span> : <span style={{ color: "var(--muted)" }}>unavailable</span>}
                    </span>
                  ))}
                </div>
                {/* A true 0 means "fund me", not "broken". */}
                {Number(unified.total) === 0 && <div style={{ marginTop: 4 }}>Empty — nothing committed yet.</div>}
                {/* ⭐ THE SHORT LINE STAYS NEXT TO THE NUMBER — the long custody note is in the expansion. */}
                {parked && (
                  <div style={{ marginTop: 6, color: "var(--warn)" }}>
                    <b>Not included</b> in available now: <span className="ym-mono">{formatUsdc(unified.total)}</span> USDC committed to your agent's float.
                  </div>
                )}
              </>
            )}
            <div style={{ marginTop: 8, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <button className="linkbtn" onClick={() => go("unified")}>Deposit →</button>
              {/* ⭐ "Start exit →" NAVIGATES to #/unified (the full exit flow). It does NOT trigger the
                  exit — no fund-moving control is added to this panel. */}
              {parked && (
                <button className="linkbtn" onClick={() => go("unified")}>Start exit →</button>
              )}
            </div>
          </div>
          <button className="linkbtn ym-toggle" onClick={() => toggle("unified")}>{isExp("unified") ? "less ▲" : "more ▼"}</button>
          {/* ── THE LONG CUSTODY NOTE — ALWAYS IN THE DOM, visually hidden when collapsed (the
              UnifiedBalancePanel evidence pattern), so the copy guards still find every string. It
              renders only when funds are parked (there is nothing to disclose otherwise). If this is
              ever separated from the unified balance, the "money silently left behind" trap is back.

              ⚠️ This used to say "nothing can return it to you… cannot be withdrawn" — FALSE. The
              Gateway withdrawal exists on-chain and the balance is keyed to an account only your
              agent can act as. What is true is narrower and must stay narrow: only the account your
              agent controls can release it, and Tikpema controls that account. Do not restore an
              absolute. */}
          {parked && (
            <div className="ym-more" hidden={!isExp("unified")}>
              Only your agent's own account can release these funds, and <b>Tikpema controls that
              account</b> — so the exit runs through us. <b>It is built now:</b> you ask, Arc's Gateway
              holds the funds for a delay of about seven days, and we finish it automatically —{" "}
              <b>you do not have to come back</b>. <b>⚠️ This has now been done once, end to end</b>:{" "}
              {UB_EXIT_PROOF.amount} asked for on {UB_EXIT_PROOF.askedDate} and returned automatically on{" "}
              {UB_EXIT_PROOF.returnedDate}, with nobody watching — one real run, not a track record. It
              took {UB_EXIT_PROOF.duration}, longer than the estimate, so treat the wait as the floor,
              not the ceiling.
            </div>
          )}
        </div>
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
