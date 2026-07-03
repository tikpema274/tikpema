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
  return JSON.stringify(s);
};

export default function MyAgentPanel({ wallet: w }: { wallet: UnifiedWallet }) {
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [planRun, setPlanRun] = useState<any>(null);
  const [planBusy, setPlanBusy] = useState(false);

  async function runTask() {
    setBusy(true);
    setError("");
    setResult(null);
    setPlanRun(null);
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
    try {
      const token = await w.ensureSession();
      setPlanRun(await agentClient.executePlan(plan, token));
    } catch (e: any) {
      setPlanRun({ error: e.message });
    } finally {
      setPlanBusy(false);
    }
  }

  return (
    <div className="plane">
      <div className="panel-eyebrow">Your agent</div>
      <h2>Give your agent a task</h2>
      <div className="sub">
        Your agent acts on-chain from its own wallet — send or swap USDC in plain
        language. It spends only what's in your agent wallet, within safety caps.
      </div>

      {w.agentWallet && (
        <div className="status" style={{ marginTop: 0, marginBottom: 4 }}>
          Wallet <span className="mono">{shortAddr(w.agentWallet.address)}</span> ·{" "}
          {w.agentWallet.balance ?? "…"} USDC
        </div>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        <input
          placeholder="e.g. swap 1 USDC to EURC · or send 0.5 USDC to 0x…"
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
          Create your wallet above first.
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
            onConfirm={confirmPlan}
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
  onConfirm,
}: {
  data: any;
  planRun: any;
  planBusy: boolean;
  onConfirm: (plan: unknown[]) => void;
}) {
  const d = data.decision || {};

  if (data.needsConfirmation) {
    return <div className="status" style={{ margin: 0 }}>{data.message}</div>;
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
            const mark = !r ? "" : r.ok ? " ✓" : " ✗";
            const note = !r ? "" : r.ok ? (r.state === "submitted" ? " (submitted)" : " (done)") : ` (${r.blocked || r.error || "failed"})`;
            return (
              <li key={i} style={{ marginBottom: 2 }}>
                {describeStep(s)}
                <b>{mark}</b>
                <span style={{ opacity: 0.7 }}>{note}</span>
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
