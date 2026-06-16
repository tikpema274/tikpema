import { json } from "./_arc.mjs";
import { GATEWAY } from "./_gateway.mjs";

// POST /api/gateway-balance — read-only. Asks the Gateway API for the agent
// wallet's unified USDC balance sourced from its Arc Testnet deposits.
//
// No secrets needed: the Gateway balance endpoint is a public read keyed by the
// depositor address. We default the depositor to AGENT_WALLET_ADDRESS so the
// caller normally needs no body at all.
export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const depositor = process.env.AGENT_WALLET_ADDRESS;
  if (!depositor) {
    return json(400, {
      error: "AGENT_WALLET_ADDRESS not set — run /api/agent-init first.",
    });
  }

  try {
    const res = await fetch(`${GATEWAY.API_BASE}/v1/balances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "USDC",
        sources: [{ domain: GATEWAY.ARC_DOMAIN, depositor }],
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      return json(502, {
        error: `Gateway API ${res.status}`,
        detail: detail.slice(0, 500),
      });
    }

    const data = await res.json();
    // The API returns decimal USDC strings in `balances`. Sum them for a single
    // unified figure while passing the raw per-source breakdown through.
    const balances = Array.isArray(data?.balances) ? data.balances : [];
    const total = balances
      .reduce((sum, b) => sum + Number(b?.balance || 0), 0)
      .toString();

    return json(200, {
      depositor,
      domain: GATEWAY.ARC_DOMAIN,
      unifiedBalanceUsdc: total,
      balances,
    });
  } catch (e) {
    return json(500, { error: e.message });
  }
}
