import { useState } from "react";
import { agentClient } from "../lib/agentClient";

export default function AgentPanel() {
  const [out, setOut] = useState<string>("");
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setOut("Working…");
    try {
      const data = await fn();
      setOut(JSON.stringify(data, null, 2));
    } catch (e: any) {
      setOut(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="plane">
      <h2>Agent plane</h2>
      <div className="sub">
        Dev-controlled SCA wallet · server-side · ERC-8004 identity · acts unattended
      </div>

      <div className="row">
        <button disabled={busy} onClick={() => run(() => agentClient.init())}>
          Init + register agent
        </button>
        <button disabled={busy} onClick={() => run(() => agentClient.status())}>
          Agent status
        </button>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <input
          placeholder="task for the agent, e.g. 'pay 0.05 USDC to 0x…'"
          value={task}
          onChange={(e) => setTask(e.target.value)}
        />
        <button
          className="emerald"
          disabled={busy || !task}
          onClick={() => run(() => agentClient.act(task))}
        >
          Run agent
        </button>
      </div>

      {out && (
        <pre
          className="mono status"
          style={{ whiteSpace: "pre-wrap", marginTop: 14 }}
        >
          {out}
        </pre>
      )}
    </div>
  );
}
