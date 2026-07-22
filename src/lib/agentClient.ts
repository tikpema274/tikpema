// Thin client for the AGENT plane. The browser NEVER touches Circle's API key
// or entity secret — it only calls these /api/* endpoints, which run
// server-side in netlify/functions and hold the secrets.

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Money-moving agent endpoints are auth-gated (401 without a session).
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
  return data;
}

async function get(path: string, token?: string) {
  const res = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
  return data;
}

export const agentClient = {
  // Autonomous action on the caller's OWN agent wallet (session-resolved
  // server-side). The token is required — the endpoint 401s without it.
  act: (task: string, token: string) => post("/api/agent-act", { task }, token),

  // Execute a confirmed multi-step plan (turn 2 of plan->confirm->execute).
  executePlan: (plan: unknown[], token: string) =>
    post("/api/agent-execute-plan", { plan }, token),

  // Execute a confirmed cross-chain bridge (turn 2 of bridge propose->confirm).
  // Returns after the Arc burn; the destination mint is async (poll bridgeStatus).
  bridge: (amountUsdc: number, destination: string, token: string) =>
    post("/api/agent-bridge", { amountUsdc, destination }, token),

  // Stage-2 poll: has Circle's relayer minted on the destination yet?
  bridgeStatus: (burnHash: string, destinationKey: string, token: string) =>
    post("/api/agent-bridge-status", { burnHash, destinationKey }, token),

  // Reclaim the agent wallet's float back to the caller's OWN login wallet. There is no
  // recipient argument on purpose: the server resolves the destination from the session,
  // so a withdrawal can only ever pay the wallet the caller proved they control.
  // Moves PLAIN USDC only — the Gateway unified balance needs a separate, delayed exit.
  withdraw: (amountUsdc: number, token: string) =>
    post("/api/agent-withdraw", { amountUsdc }, token),

  // ── DCA MANDATES (custodial autonomous swaps). ────────────────────────────────────
  // Create is the authorization moment (session required); the server fills mandates later
  // with NO session. Cancel is always-available (reclaim-class, never blocked). List is read.
  dcaCreate: (mandate: unknown, token: string) => post("/api/dca-create", mandate, token),
  dcaCancel: (id: string, token: string) => post("/api/dca-cancel", { id }, token),
  dcaList: (token: string) => get("/api/dca-list", token),
};
