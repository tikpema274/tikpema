import { useState } from "react";
import { agentClient } from "../lib/agentClient";
import type { ModularWallet } from "../wallet/useModularWallet";

// Which operation produced the result, so we can summarize it in plain language.
type AgentResult =
  | { kind: "init"; data: any }
  | { kind: "status"; data: any }
  | { kind: "act"; data: any };

const shortAddr = (a: string) =>
  a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

const describeStep = (s: any): string => {
  if (s?.type === "swap_tokens")
    return `Swap ${s.amountIn} ${String(s.tokenIn).toUpperCase()} → ${String(s.tokenOut).toUpperCase()}`;
  if (s?.type === "pay_for_service")
    return `Pay ${s.payAmountUsdc} USDC (Gateway) to ${shortAddr(String(s.payTo))}`;
  if (s?.type === "transfer_usdc")
    return `Send ${s.amountUsdc} USDC to ${shortAddr(String(s.to))}`;
  return JSON.stringify(s);
};

export default function AgentPanel({ wallet: _wallet }: { wallet: ModularWallet }) {
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AgentResult | null>(null);
  const [error, setError] = useState("");
  const [planRun, setPlanRun] = useState<any>(null);
  const [planBusy, setPlanBusy] = useState(false);

  async function run(kind: AgentResult["kind"], fn: () => Promise<any>) {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const data = await fn();
      setResult({ kind, data } as AgentResult);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="plane">
      <h2>AI Assistant</h2>
      <div className="sub">
        An AI that can research and act on its own, with its own wallet.
      </div>

      <div className="row">
        <button disabled={busy} onClick={() => run("init", () => agentClient.init())}>
          Set up the AI Assistant
        </button>
        <button disabled={busy} onClick={() => run("status", () => agentClient.status())}>
          AI Assistant status
        </button>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <input
          placeholder="Type a task for the AI Assistant, e.g. 'pay 0.05 USDC to 0x…'"
          value={task}
          onChange={(e) => setTask(e.target.value)}
        />
        <button
          className="emerald"
          disabled={busy || !task}
          onClick={() => run("act", () => agentClient.act(task))}
        >
          Give the AI Assistant a task
        </button>
      </div>

      {busy && (
        <div className="status" style={{ marginTop: 14 }}>
          <span className="spinner" /> Working…
        </div>
      )}

      {error && (
        <div className="status" style={{ marginTop: 14, color: "#f5a623" }}>
          Error: {error}
        </div>
      )}

      {result && !busy && (
        <div style={{ marginTop: 14 }}>
          <AgentSummary
            result={result}
            planRun={planRun}
            planBusy={planBusy}
            setPlanRun={setPlanRun}
            setPlanBusy={setPlanBusy}
          />
        </div>
      )}
    </div>
  );
}

function TxLink({ url, label }: { url: string; label?: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer">
      {label ?? "View transaction ↗"}
    </a>
  );
}

// Turn each endpoint's payload into a short, human-readable summary. The
// underlying JSON shapes are unchanged — this is presentation only.
function AgentSummary({
  result,
  planRun,
  planBusy,
  setPlanRun,
  setPlanBusy,
}: {
  result: AgentResult;
  planRun: any;
  planBusy: boolean;
  setPlanRun: (v: any) => void;
  setPlanBusy: (v: boolean) => void;
}) {
  const { kind, data } = result;

  if (kind === "init") {
    return (
      <div className="status" style={{ margin: 0 }}>
        <div>✓ AI Assistant wallet created and identity registered on-chain.</div>
        {data.AGENT_WALLET_ADDRESS && (
          <div>
            Wallet:{" "}
            <span className="mono">{shortAddr(data.AGENT_WALLET_ADDRESS)}</span>
          </div>
        )}
        {data.registrationTx && (
          <div style={{ marginTop: 4 }}>
            <TxLink url={data.registrationTx} label="View registration ↗" />
          </div>
        )}
      </div>
    );
  }

  if (kind === "status") {
    return (
      <div className="status" style={{ margin: 0 }}>
        <div>
          AI Assistant wallet{" "}
          <span className="mono">{shortAddr(data.agentWalletAddress)}</span> holds{" "}
          <b>{data.usdcBalance} USDC</b>.
        </div>
        {data.agentId && (
          <div style={{ marginTop: 4 }}>On-chain identity #{data.agentId}.</div>
        )}
      </div>
    );
  }

  // kind === "act"
  const d = data.decision || {};

  if (data.executed && data.pending) {
    return (
      <div className="status" style={{ margin: 0 }}>
        AI Assistant submitted a transfer — still confirming.
        {data.txId ? ` (tx id ${data.txId})` : ""}
      </div>
    );
  }

  if (data.executed && d.action === "swap_tokens") {
    const submitted = data.swap?.state === "submitted" || data.swap?.pending;
    return (
      <div className="status" style={{ margin: 0 }}>
        <div>
          ✓ AI Assistant swapped <b>{d.amountIn} {String(d.tokenIn).toUpperCase()}</b>{" "}
          → <b>{String(d.tokenOut).toUpperCase()}</b>
          {submitted ? " — submitted, balance updates shortly." : "."}
        </div>
        {d.reasoning && <div style={{ marginTop: 4 }}>{d.reasoning}</div>}
        {data.tx && (
          <div style={{ marginTop: 4 }}>
            <TxLink url={data.tx} />
          </div>
        )}
      </div>
    );
  }

  if (data.executed && d.action === "pay_for_service") {
    const submitted = data.pay?.state === "submitted" || data.pay?.pending;
    return (
      <div className="status" style={{ margin: 0 }}>
        <div>
          ✓ AI Assistant paid <b>{d.payAmountUsdc} USDC</b> to{" "}
          <span className="mono">{shortAddr(String(d.payTo))}</span>
          {submitted ? " — submitted, balance updates shortly." : "."}
        </div>
        {d.reasoning && <div style={{ marginTop: 4 }}>{d.reasoning}</div>}
      </div>
    );
  }

  if (data.executed) {
    return (
      <div className="status" style={{ margin: 0 }}>
        <div>
          ✓ AI Assistant sent <b>{d.amountUsdc} USDC</b> to{" "}
          <span className="mono">{shortAddr(String(d.to))}</span>.
        </div>
        {d.reasoning && <div style={{ marginTop: 4 }}>{d.reasoning}</div>}
        {data.tx && (
          <div style={{ marginTop: 4 }}>
            <TxLink url={data.tx} />
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
          <b>Proposed {data.plan.length}-step plan</b> — total ~${Number(data.totalUsdc).toFixed(2)}:
        </div>
        <ol style={{ margin: "0 0 8px 18px", padding: 0 }}>
          {data.plan.map((s: any, i: number) => {
            const r = runResults?.[i];
            const mark = !r ? "" : r.ok ? " ✓" : " ✗";
            const note = !r ? "" : r.ok
              ? (r.state === "submitted" ? " (submitted)" : " (done)")
              : ` (${r.blocked || r.error || "failed"})`;
            return (
              <li key={i} style={{ marginBottom: 2 }}>
                {describeStep(s)}<b>{mark}</b><span style={{ opacity: 0.7 }}>{note}</span>
              </li>
            );
          })}
        </ol>
        {!planRun && (
          <button
            className="emerald"
            disabled={planBusy}
            onClick={async () => {
              setPlanBusy(true);
              try {
                const res = await agentClient.executePlan(data.plan);
                setPlanRun(res);
              } catch (e: any) {
                setPlanRun({ error: e.message });
              } finally {
                setPlanBusy(false);
              }
            }}
          >
            {planBusy ? "Executing…" : "Confirm & execute"}
          </button>
        )}
        {planRun?.blocked && (
          <div style={{ marginTop: 6 }}>Plan blocked — {planRun.blocked}.</div>
        )}
        {planRun?.error && (
          <div style={{ marginTop: 6 }}>Error — {planRun.error}.</div>
        )}
        {planRun && planRun.executed && (
          <div style={{ marginTop: 6 }}>
            {planRun.completed
              ? "All steps executed."
              : `Stopped at step ${(planRun.stoppedAt ?? 0) + 1} — remaining steps not run.`}
          </div>
        )}
        {d.reasoning && <div style={{ marginTop: 4, opacity: 0.7 }}>{d.reasoning}</div>}
      </div>
    );
  }

  if (data.blocked) {
    return (
      <div className="status" style={{ margin: 0 }}>
        <div>AI Assistant did not act — {data.blocked}.</div>
        {d.reasoning && <div style={{ marginTop: 4 }}>{d.reasoning}</div>}
      </div>
    );
  }

  return (
    <div className="status" style={{ margin: 0 }}>
      <div>AI Assistant decided no on-chain action was needed.</div>
      {d.reasoning && <div style={{ marginTop: 4 }}>{d.reasoning}</div>}
    </div>
  );
}
