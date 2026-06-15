// Thin client for the AGENT plane. The browser NEVER touches Circle's API key
// or entity secret — it only calls these /api/* endpoints, which run
// server-side in netlify/functions and hold the secrets.

async function post(path: string, body: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
  return data;
}

export const agentClient = {
  // One-time bootstrap: create the agent's dev-controlled SCA wallet and
  // register its ERC-8004 identity. Returns ids to persist in env.
  init: (metadataUri?: string) => post("/api/agent-init", { metadataUri }),

  // Read the agent's on-chain identity + USDC balance.
  status: () => post("/api/agent-status", {}),

  // Autonomous action: the agent's Claude brain decides, then (if the action
  // is allowed and within the spend guard) executes on-chain, gas sponsored.
  act: (task: string) => post("/api/agent-act", { task }),
};
