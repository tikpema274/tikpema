import { useState } from "react";
import { agentClient } from "../lib/agentClient";
import type { useWallet } from "../wallet/useWallet";

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
        Your agent acts on-chain from its own wallet — send or swap USDC on Arc, or
        bridge it cross-chain to Ethereum, Base, Arbitrum and more, all in plain
        language. Multi-step tasks and bridges are proposed for you to confirm
        before they run (a bridge shows the live cross-chain fee and what actually
        arrives). It spends only what's in your agent wallet, and every action stays
        within safety caps — per-action and per-bridge limits plus a cumulative
        daily ceiling.
      </div>

      {w.agentWallet && (
        <div className="status" style={{ marginTop: 0, marginBottom: 4 }}>
          Wallet <span className="mono">{shortAddr(w.agentWallet.address)}</span> ·{" "}
          {w.agentWallet.balance ?? "…"} USDC
        </div>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        <input
          placeholder="e.g. bridge 20 USDC to Ethereum · swap 1 USDC to EURC · send 0.1 to 0x… then 0.1 to 0x…"
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
