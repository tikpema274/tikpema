import { useState } from "react";
import { agentClient } from "../lib/agentClient";
import { useGatewayBalance } from "../lib/useGatewayBalance";
import SignInPrompt from "./SignInPrompt";
import AddressDisplay from "./AddressDisplay";
import { arcTestnet } from "../config/chain";
import type { useWallet } from "../wallet/useWallet";

const EXPLORER = arcTestnet.blockExplorers.default.url;

// MyAgentPanel — Brick C "My Agent" surface. Re-mounts the agent-action UI (from
// the archived AgentPanel), restyled to the current design and pointed at the
// user's OWN per-user agent wallet. Every action is:
//   - auth-gated (a session token is attached; the endpoint 401s without it),
//   - session-wallet-resolved server-side (never client-supplied),
//   - per-transaction capped (AGENT_MAX_SPEND_USDC) + budget-spine day-ceiling,
//   - pay_for_service is blocked on the per-user wallet (Gateway not wired yet).
// These guardrails live in the ENDPOINTS (agent-act / agent-execute-plan /
// _actions / _budget); this surface just wires the token + renders results.
//
// NOTE: this moves real (testnet) USDC when a task executes.

type UnifiedWallet = ReturnType<typeof useWallet>;

const shortAddr = (a: string) =>
  a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

const describeStep = (s: any): string => {
  if (s?.type === "swap_tokens")
    return `Swap ${s.amountIn} ${String(s.tokenIn).toUpperCase()} → ${String(s.tokenOut).toUpperCase()}`;
  if (s?.type === "pay_for_service")
    return `Pay ${s.payAmountUsdc} USDC to ${shortAddr(String(s.payTo))}`;
  if (s?.type === "transfer_usdc")
    return `Send ${s.amountUsdc} USDC to ${shortAddr(String(s.to))}`;
  if (s?.type === "bridge_usdc")
    return `Bridge ${s.amountUsdc} USDC to ${s.destination}`;
  return JSON.stringify(s);
};

export default function MyAgentPanel({ wallet: w }: { wallet: UnifiedWallet }) {
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [planRun, setPlanRun] = useState<any>(null);
  const [planBusy, setPlanBusy] = useState(false);
  // Bridge (propose→confirm→execute, then async destination-mint polling).
  const [bridgeRun, setBridgeRun] = useState<any>(null);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [mint, setMint] = useState<any>(null); // { state: 'pending'|'minted'|'failed', mintTx? }
  // Per-plan-step destination-mint status, keyed by step index (for bridge steps
  // inside a multi-step plan — Option A: the plan doesn't wait, these poll inline).
  const [planMints, setPlanMints] = useState<Record<number, any>>({});

  // ── HOP A — fund the agent wallet from the login wallet. THE PRIMARY FUNDING PATH. ──
  // The custody model: the LOGIN wallet (passkey MSCA / MetaMask EOA) is the USER'S — they
  // hold the key, and that is where their funds live. The agent wallet is the AGENT'S
  // working float — a dev-controlled SCA the user tops up, so their exposure is bounded and
  // self-chosen. Hop A is the doorway between the two, and it is the doorway users are
  // meant to use.
  const [fundAmt, setFundAmt] = useState("");
  const [fundBusy, setFundBusy] = useState(false);
  const [fundErr, setFundErr] = useState("");
  const [fundTx, setFundTx] = useState<string | null>(null);
  const [showDirect, setShowDirect] = useState(false); // agent's own address = the disclosure

  // ── WITHDRAW — hop A in reverse. The float must have an EXIT. ────────────────────────
  // Without this the agent float is custodial with no way out, which is the whole problem
  // the user-funded-MSCA model exists to solve. The endpoint is NOT bound by the agent's
  // pause / day-ceiling / send-cap (those bound the agent, not the user reclaiming money),
  // and it takes no recipient — the server sends to the session's own login wallet.
  const [wdAmt, setWdAmt] = useState("");
  const [wdBusy, setWdBusy] = useState(false);
  const [wdErr, setWdErr] = useState("");
  const [wdTx, setWdTx] = useState<string | null>(null);

  const agentSca = w.agentWallet?.address ?? null;
  const agentBal = Number(w.agentWallet?.balance ?? 0);
  // The LOGIN wallet's balance — hop A's source, and now the wallet users are told to fund.
  const loginBal = Number(w.usdcBalance ?? 0);

  // The agent's Gateway unified balance. Shown next to Withdraw ON PURPOSE: withdraw moves
  // the agent's PLAIN USDC only, and anything sitting in the unified balance is NOT part of
  // it (that needs initiateWithdrawal + withdraw on the GatewayWallet, after a delay). A
  // "Withdraw" that silently left money behind would be a lie.
  const gw = useGatewayBalance(w, wdTx ? 1 : 0);
  const gwParked = gw.status === "ready" ? Number(gw.total ?? 0) : 0;

  async function fundAgent() {
    setFundErr("");
    setFundTx(null);
    if (!agentSca) {
      setFundErr("Your agent wallet isn't ready yet — try again in a moment.");
      return;
    }
    setFundBusy(true);
    try {
      // The destination is the SERVER-RESOLVED agent wallet (/api/my-wallet →
      // ensureOwnerWallet(session)) — never a constant. Both connectors additionally
      // refuse the shared agent wallet. Amount validation (>0, <= balance) lives in the
      // connector, checked against a LIVE chain read, so nothing signs on a bad input.
      const r = await w.fundAgentWallet(agentSca, Number(fundAmt));
      setFundTx(r.txHash);
      setFundAmt("");
      await w.refreshAgentWallet().catch(() => {});
    } catch (e: any) {
      setFundErr(e?.message || "Funding failed");
    } finally {
      setFundBusy(false);
    }
  }

  // Reclaim the float. No recipient is sent — the server withdraws to the session's own
  // login wallet, so this can only ever pay the wallet the caller controls.
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

  // Poll IRIS for a forwarded bridge's destination mint until it settles (or the
  // window elapses), applying each update via `onUpdate`. Shared by the standalone
  // bridge and each bridge step inside a plan.
  async function pollMint(
    burnHash: string,
    destinationKey: string,
    token: string,
    onUpdate: (s: any) => void
  ) {
    for (let i = 0; i < 48; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const s = await agentClient.bridgeStatus(burnHash, destinationKey, token);
        onUpdate(s);
        if (s.state === "minted" || s.state === "failed") break;
      } catch {
        /* transient IRIS hiccup — keep polling */
      }
    }
  }

  async function runTask() {
    setBusy(true);
    setError("");
    setResult(null);
    setPlanRun(null);
    setBridgeRun(null);
    setMint(null);
    setPlanMints({});
    try {
      const token = await w.ensureSession(); // auth: token required by the endpoint
      const data = await agentClient.act(task, token);
      setResult(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmPlan(plan: unknown[]) {
    setPlanBusy(true);
    setPlanMints({});
    try {
      const token = await w.ensureSession();
      const res = await agentClient.executePlan(plan, token);
      setPlanRun(res);
      // Option A: any bridge step already fired its Arc burn and the plan moved
      // on. Poll each bridge step's destination mint INLINE (concurrently, in the
      // background) so its status fills in without blocking the finished plan.
      const bridges = (res?.results || []).filter(
        (r: any) => r?.ok && r?.kind === "bridge_usdc" && r?.burnHash
      );
      if (bridges.length) {
        setPlanMints(Object.fromEntries(bridges.map((r: any) => [r.index, { state: "pending" }])));
        bridges.forEach((r: any) =>
          pollMint(r.burnHash, r.destination.key, token, (s) =>
            setPlanMints((prev) => ({ ...prev, [r.index]: s }))
          )
        );
      }
    } catch (e: any) {
      setPlanRun({ error: e.message });
    } finally {
      setPlanBusy(false);
    }
  }

  // Confirm a bridge: fire the Arc burn, then poll IRIS for the destination mint.
  async function confirmBridge(amountUsdc: number, destinationKey: string) {
    setBridgeBusy(true);
    setMint(null);
    try {
      const token = await w.ensureSession();
      const res = await agentClient.bridge(amountUsdc, destinationKey, token);
      setBridgeRun(res);
      // Stage 2: the Arc burn is done; poll until Circle's relayer mints (or fails).
      if (res?.executed && res?.burnHash) {
        setMint({ state: "pending" });
        await pollMint(res.burnHash, res.destination.key, token, setMint);
      }
    } catch (e: any) {
      setBridgeRun({ error: e.message });
    } finally {
      setBridgeBusy(false);
    }
  }

  return (
    <div className="plane">
      <div className="panel-eyebrow">Your agent</div>
      <h2>Give your agent a task</h2>
      <div className="sub">
        Your agent acts on-chain from its own wallet, in plain language — always
        spending only what's in that wallet and within your per-action, per-bridge,
        and cumulative daily safety caps.
      </div>

      {w.agentWallet && (
        <div className="status" style={{ marginTop: 0, marginBottom: 4 }}>
          Wallet <span className="mono">{shortAddr(w.agentWallet.address)}</span> ·{" "}
          {w.agentWallet.balance ?? "…"} USDC
        </div>
      )}

      {/* Signed out ⇒ the agent wallet hasn't resolved, so the fund control below can't
          render at all. Without this, the panel silently offers NO way back in — the same
          dead-end that stopped the first deposit attempt on #/unified. A signed-out state
          must be a door, not a wall. */}
      {!w.isAuthenticated && (
        <div style={{ marginTop: 12 }}>
          <div className="panel-eyebrow">Your agent wallet</div>
          <SignInPrompt
            wallet={w}
            message="Sign in to see your agent's wallet and fund it."
            onSignedIn={() => w.refreshAgentWallet().catch(() => {})}
          />
        </div>
      )}

      {/* FUNDING THE AGENT — two paths, deliberately ranked. This ranking is the custody
          model made visible.

          YOUR wallet is the login wallet: you hold the key, and that is where your funds
          live. The AGENT's wallet is a working float you top up — so your exposure is
          bounded, and you chose the bound. Hop A is the door between them, and it is the
          door users are meant to use. Hence:

          PRIMARY: fund YOUR wallet (address shown), then hop A into the agent.
          SECONDARY: send straight to the agent's address — still valid (faucet, exchange,
          another wallet), but it puts funds where you do NOT hold the key, so it is the
          disclosure, not the default.

          (This re-ranks b522d81, which made the agent's address primary. That was right for
          the model at the time — the passkey MSCA was minted empty, so hop A dead-ended. In
          this model the MSCA is the funded wallet, so that premise is gone.) */}
      {agentSca && (
        <div style={{ marginTop: 12 }}>
          <div className="panel-eyebrow">
            {agentBal > 0 ? "Top up your agent" : "Fund your agent to get started"}
          </div>

          {/* Step 1 — YOUR wallet. This is the address to send USDC to. */}
          <div className="sub" style={{ margin: "2px 0 6px" }}>
            <b>1. Your wallet</b> — you hold the key. Send USDC here from any wallet,
            exchange, or faucet:
          </div>
          {w.address && <AddressDisplay address={w.address} />}
          <div className="sub" style={{ margin: "6px 0 0" }}>
            Balance: <span className="mono">{w.usdcBalance ?? "—"}</span> USDC
          </div>

          {/* Step 2 — HOP A. The primary funding control. Always shown (never hidden when
              the login wallet is empty — hiding it is what created the old dead end); it
              just tells you to fund step 1 first. */}
          <div style={{ marginTop: 14 }}>
            <div className="sub" style={{ margin: "0 0 8px" }}>
              <b>2. Move USDC to your agent</b> — this is the agent's float. It can spend
              this, within your safety caps. You can take it back at any time.
            </div>
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                placeholder="Amount (USDC)"
                value={fundAmt}
                disabled={fundBusy || loginBal <= 0}
                onChange={(e) => setFundAmt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && fundAmt && !fundBusy) fundAgent();
                }}
                style={{ maxWidth: 180 }}
              />
              <button
                className="emerald"
                disabled={fundBusy || loginBal <= 0 || !fundAmt || Number(fundAmt) <= 0}
                onClick={fundAgent}
              >
                {fundBusy ? "Moving…" : "Move to agent"}
              </button>
            </div>
            {loginBal <= 0 && (
              <div className="sub" style={{ margin: "8px 0 0" }}>
                Your wallet is empty — fund it at step 1 first.
              </div>
            )}
            {fundErr && (
              <div className="sub" style={{ margin: "8px 0 0", color: "var(--danger, #e5484d)" }}>
                {fundErr}
              </div>
            )}
            {fundTx && (
              <div className="sub" style={{ margin: "8px 0 0" }}>
                Moved into your agent wallet.{" "}
                <a href={`${EXPLORER}/tx/${fundTx}`} target="_blank" rel="noreferrer">
                  View transaction ↗
                </a>
              </div>
            )}
          </div>

          {/* WITHDRAW — the exit. The float is only "bounded exposure" if it can come back. */}
          {agentBal > 0 && (
            <div style={{ marginTop: 18 }}>
              <div className="sub" style={{ margin: "0 0 8px" }}>
                <b>Take it back</b> — return your agent's float to your own wallet.
              </div>
              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  placeholder="Amount (USDC)"
                  value={wdAmt}
                  disabled={wdBusy}
                  onChange={(e) => setWdAmt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && wdAmt && !wdBusy) withdraw();
                  }}
                  style={{ maxWidth: 180 }}
                />
                <button
                  disabled={wdBusy || !wdAmt || Number(wdAmt) <= 0}
                  onClick={withdraw}
                >
                  {wdBusy ? "Withdrawing…" : "Withdraw to my wallet"}
                </button>
                <button
                  className="linkbtn"
                  disabled={wdBusy || agentBal <= 0}
                  onClick={() => setWdAmt(String(agentBal))}
                >
                  Max ({agentBal})
                </button>
              </div>

              {/* HONESTY — withdraw moves the agent's PLAIN USDC only. Anything the agent
                  parked in the Gateway unified balance is NOT included and needs a separate,
                  delayed exit. Say it before the user finds money missing, not after. */}
              <div className="sub" style={{ margin: "8px 0 0" }}>
                Withdrawable now: <span className="mono">{agentBal}</span> USDC (your agent's
                plain balance).
              </div>
              {gwParked > 0 && (
                <div
                  className="sub"
                  style={{ margin: "6px 0 0", color: "var(--warn, #f0b866)" }}
                >
                  Not included: <span className="mono">{gw.status === "ready" ? gw.total : "—"}</span>{" "}
                  USDC is in your agent's Gateway unified balance. Withdraw does not move
                  that — it has to be released from Gateway first, and that release is
                  time-delayed. It is not lost, but it will not arrive with this button.
                </div>
              )}
              {wdErr && (
                <div className="sub" style={{ margin: "8px 0 0", color: "var(--danger, #e5484d)" }}>
                  {wdErr}
                </div>
              )}
              {wdTx && (
                <div className="sub" style={{ margin: "8px 0 0" }}>
                  Returned to your wallet.{" "}
                  <a href={`${EXPLORER}/tx/${wdTx}`} target="_blank" rel="noreferrer">
                    View transaction ↗
                  </a>
                </div>
              )}
            </div>
          )}

          {/* SECONDARY — the agent's own address. Still valid, but it puts funds where the
              user does NOT hold the key, so it is a disclosure rather than the default. */}
          <div style={{ marginTop: 16 }}>
            {!showDirect ? (
              <button className="linkbtn" onClick={() => setShowDirect(true)}>
                Or send USDC straight to the agent's address →
              </button>
            ) : (
              <>
                <div className="sub" style={{ margin: "0 0 8px" }}>
                  The agent's own address. Anything sent here skips your wallet and lands
                  directly in the agent's float — useful for a faucet, but you do not hold
                  the key to this one.
                </div>
                <AddressDisplay address={agentSca} />
              </>
            )}
          </div>
        </div>
      )}

      {/* Guided shortcuts — reuse the Dashboard card style. Send/Swap/Bridge each
          switch to their existing view via the hash router; the same panels, not
          duplicates. */}
      <div className="panel-eyebrow" style={{ marginTop: 18 }}>Quick actions</div>
      <div className="quick" style={{ marginTop: 4 }}>
        <button
          className="quick-card"
          onClick={() => (window.location.hash = "/send")}
        >
          <div className="qt">Send →</div>
          <div className="qd">Send USDC to any address, gasless.</div>
        </button>
        <button
          className="quick-card"
          onClick={() => (window.location.hash = "/swap")}
        >
          <div className="qt">Swap →</div>
          <div className="qd">Swap between USDC and EURC on Arc.</div>
        </button>
        <button
          className="quick-card"
          onClick={() => (window.location.hash = "/bridge")}
        >
          <div className="qt">Bridge →</div>
          <div className="qd">Bridge USDC cross-chain to Ethereum, Base and more.</div>
        </button>
      </div>

      {/* The free-text box, unchanged — repositioned below the shortcuts as the
          general multi-step entry point. */}
      <div className="panel-eyebrow" style={{ marginTop: 22 }}>Multi-task</div>
      <div className="sub" style={{ marginBottom: 8 }}>
        Or describe any task in plain language, including multi-step plans — you'll
        confirm anything that moves funds before it runs.
      </div>

      <div className="row" style={{ marginTop: 0 }}>
        <input
          placeholder="e.g. swap 1 USDC to EURC then bridge 3 to Base · send 0.1 to 0x… then 0.1 to 0x…"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && task && !busy && w.address) runTask();
          }}
        />
        <button className="emerald" disabled={busy || !task || !w.address} onClick={runTask}>
          {busy ? "Working…" : "Run"}
        </button>
      </div>
      {!w.address && (
        <div className="sub" style={{ marginTop: 8, marginBottom: 0 }}>
          Continue with your passkey above first to set up your agent's wallet.
        </div>
      )}

      {busy && (
        <div className="status" style={{ marginTop: 14 }}>
          <span className="spinner" /> Your agent is deciding…
        </div>
      )}
      {error && (
        <div className="status" style={{ marginTop: 14, color: "var(--warn)" }}>
          {error}
        </div>
      )}

      {result && !busy && (
        <div style={{ marginTop: 14 }}>
          <AgentSummary
            data={result}
            planRun={planRun}
            planBusy={planBusy}
            planMints={planMints}
            onConfirm={confirmPlan}
            bridgeRun={bridgeRun}
            bridgeBusy={bridgeBusy}
            mint={mint}
            onConfirmBridge={confirmBridge}
          />
        </div>
      )}
    </div>
  );
}

function TxLink({ url }: { url: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer">
      View transaction ↗
    </a>
  );
}

// Presentation of an agent-act result. Handles: needs_confirmation, plan (with
// confirm→execute), executed transfer/swap/pay, blocked, and no-op.
function AgentSummary({
  data,
  planRun,
  planBusy,
  planMints,
  onConfirm,
  bridgeRun,
  bridgeBusy,
  mint,
  onConfirmBridge,
}: {
  data: any;
  planRun: any;
  planBusy: boolean;
  planMints: Record<number, any>;
  onConfirm: (plan: unknown[]) => void;
  bridgeRun: any;
  bridgeBusy: boolean;
  mint: any;
  onConfirmBridge: (amountUsdc: number, destinationKey: string) => void;
}) {
  const d = data.decision || {};

  if (data.needsConfirmation) {
    return <div className="status" style={{ margin: 0 }}>{data.message}</div>;
  }

  // Bridge proposal → confirm → Arc burn → (async) destination mint.
  if (data.needsBridgeConfirm && data.bridge) {
    const b = data.bridge;
    const done = bridgeRun?.executed;
    return (
      <div className="status" style={{ margin: 0 }}>
        <div style={{ marginBottom: 6 }}>
          <b>Bridge {b.amountUsdc} USDC → {b.destination.label}</b>
        </div>
        <div style={{ opacity: 0.85, marginBottom: 8 }}>
          Cross-chain fee ~{Number(b.feeUsdc).toFixed(2)} USDC (taken from the amount) ·
          {" "}~{Number(b.netUsdc).toFixed(2)} USDC arrives on {b.destination.label}.
          <br />
          Funds leave Arc — the burn is instant, the destination mint follows in ~1–2 min.
        </div>

        {!bridgeRun && (
          <button className="emerald" disabled={bridgeBusy} onClick={() => onConfirmBridge(b.amountUsdc, b.destination.key)}>
            {bridgeBusy ? "Bridging…" : "Confirm & bridge"}
          </button>
        )}

        {bridgeRun?.blocked && <div style={{ marginTop: 6 }}>Your agent held off — {bridgeRun.blocked}.</div>}
        {bridgeRun?.error && <div style={{ marginTop: 6, color: "var(--warn)" }}>Error — {bridgeRun.error}.</div>}

        {done && (
          <div style={{ marginTop: 8 }}>
            <div>
              ✓ Burned on Arc {bridgeRun.tx && <span style={{ marginLeft: 6 }}><TxLink url={bridgeRun.tx} /></span>}
            </div>
            <div style={{ marginTop: 6 }}>
              {mint?.state === "minted" ? (
                <span>
                  ✓ Minted ~{Number(bridgeRun.netUsdc).toFixed(2)} USDC on {bridgeRun.destination.label}
                  {mint.mintTx && <span style={{ marginLeft: 6 }}><a href={mint.mintTx} target="_blank" rel="noreferrer">View mint ↗</a></span>}
                </span>
              ) : mint?.state === "failed" ? (
                <span style={{ color: "var(--warn)" }}>
                  Destination mint didn't confirm — the burn landed, so the funds are recoverable from the attestation. Check back shortly.
                </span>
              ) : (
                <span>
                  <span className="spinner" /> Bridging… burn done, waiting for the {bridgeRun.destination.label} mint (~1–2 min).
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (data.needsConfirm && Array.isArray(data.plan)) {
    const runResults = planRun?.results;
    return (
      <div className="status" style={{ margin: 0 }}>
        <div style={{ marginBottom: 6 }}>
          <b>Proposed {data.plan.length}-step plan</b> — total ~{Number(data.totalUsdc).toFixed(2)} USDC:
        </div>
        <ol style={{ margin: "0 0 8px 18px", padding: 0 }}>
          {data.plan.map((s: any, i: number) => {
            const r = runResults?.[i];
            const isBridge = r?.kind === "bridge_usdc" || s?.type === "bridge_usdc";
            const m = planMints?.[i];
            const mark = !r ? "" : r.ok ? " ✓" : " ✗";
            // Non-bridge note; a successful bridge shows its own two-stage line below.
            const note = !r
              ? ""
              : r.ok
                ? isBridge
                  ? ""
                  : r.state === "submitted"
                    ? " (submitted)"
                    : " (done)"
                : ` (${r.blocked || r.error || "failed"})`;
            return (
              <li key={i} style={{ marginBottom: 2 }}>
                {describeStep(s)}
                <b>{mark}</b>
                <span style={{ opacity: 0.7 }}>{note}</span>
                {r?.ok && isBridge ? (
                  // Fire-and-continue bridge: Arc burn done, destination mint polls inline.
                  <div style={{ marginTop: 2, opacity: 0.85, fontSize: "0.92em" }}>
                    burned on Arc{" "}
                    {r.tx && <a href={r.tx} target="_blank" rel="noreferrer">↗</a>} ·{" "}
                    {m?.state === "minted" ? (
                      <span>
                        minted on {r.destination?.label ?? "destination"} ✓{" "}
                        {m.mintTx && <a href={m.mintTx} target="_blank" rel="noreferrer">↗</a>}
                      </span>
                    ) : m?.state === "failed" ? (
                      <span style={{ color: "var(--warn)" }}>mint didn't confirm yet — recoverable</span>
                    ) : (
                      <span><span className="spinner" /> minting on {r.destination?.label ?? "destination"}…</span>
                    )}
                  </div>
                ) : (
                  r?.ok && r?.tx && (
                    <span style={{ marginLeft: 8 }}>
                      <TxLink url={r.tx} />
                    </span>
                  )
                )}
              </li>
            );
          })}
        </ol>
        {!planRun && (
          <button className="emerald" disabled={planBusy} onClick={() => onConfirm(data.plan)}>
            {planBusy ? "Executing…" : "Confirm & execute"}
          </button>
        )}
        {planRun?.blocked && <div style={{ marginTop: 6 }}>Plan blocked — {planRun.blocked}.</div>}
        {planRun?.error && <div style={{ marginTop: 6, color: "var(--warn)" }}>Error — {planRun.error}.</div>}
        {planRun?.executed && (
          <div style={{ marginTop: 6 }}>
            {planRun.completed
              ? "All steps executed."
              : `Stopped at step ${(planRun.stoppedAt ?? 0) + 1} — remaining steps not run.`}
          </div>
        )}
      </div>
    );
  }

  if (data.executed && d.action === "swap_tokens") {
    return (
      <div className="status" style={{ margin: 0 }}>
        <div>
          ✓ Swapped <b>{d.amountIn} {String(d.tokenIn).toUpperCase()}</b> → <b>{String(d.tokenOut).toUpperCase()}</b>
          {data.swap?.state === "submitted" ? " — submitted, balance updates shortly." : "."}
        </div>
        {data.tx && <div style={{ marginTop: 4 }}><TxLink url={data.tx} /></div>}
      </div>
    );
  }

  if (data.executed) {
    return (
      <div className="status" style={{ margin: 0 }}>
        <div>
          ✓ Sent <b>{d.amountUsdc} USDC</b> to <span className="mono">{shortAddr(String(d.to))}</span>.
        </div>
        {data.tx && <div style={{ marginTop: 4 }}><TxLink url={data.tx} /></div>}
      </div>
    );
  }

  if (data.blocked) {
    return (
      <div className="status" style={{ margin: 0 }}>
        Your agent held off — {data.blocked}.
      </div>
    );
  }

  return (
    <div className="status" style={{ margin: 0 }}>
      Your agent decided no on-chain action was needed.
      {d.reasoning && <div style={{ marginTop: 4 }}>{d.reasoning}</div>}
    </div>
  );
}
