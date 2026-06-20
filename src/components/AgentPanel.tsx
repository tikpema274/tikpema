import { useState } from "react";
import { agentClient } from "../lib/agentClient";

// Which operation produced the result, so we can summarize it in plain language.
type AgentResult =
  | { kind: "init"; data: any }
  | { kind: "status"; data: any }
  | { kind: "act"; data: any };

const shortAddr = (a: string) =>
  a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

export default function AgentPanel() {
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AgentResult | null>(null);
  const [error, setError] = useState("");

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
        Give the AI Assistant a task and watch it act on its own · dev-controlled SCA ·
        server-side · ERC-8004 identity
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
          <AgentSummary result={result} />
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
function AgentSummary({ result }: { result: AgentResult }) {
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
