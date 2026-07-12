import type { Proposal, Receipt } from "../components/jobTimeline";

// ONE approve path, shared by PlanPanel and ResearchPanel.
//
// Both panels used to inline the same fetch to /api/job-bridge-approve. The moment a SECOND
// proposable action existed, that duplication became a trap: adding swap routing to one panel
// and not the other would silently send a swap proposal to the bridge endpoint, which would
// refuse it with "this brief carries no bridge proposal" — a confusing dead end for the user
// and an easy thing to miss. Routing lives here, once.
//
// ⚠️ WE POST ONLY { runId }. Not the tokens, not the amount, not a hash. The server reads all
// of that from the proposal IT wrote and re-derives every value that gates money — the
// endpoint literally ignores any other field in the body (proven: a hostile body carrying
// tokenIn:"EURC", amountIn:999999 and a fake txHash was discarded wholesale). Sending more
// would be theatre; sending less is the security property.
const ENDPOINT: Record<Proposal["action"], string> = {
  bridge_usdc: "/api/job-bridge-approve",
  swap_tokens: "/api/job-swap-approve",
};

export type ApproveResult = { receipt?: Receipt };

export async function approveProposal({
  runId,
  proposal,
  token,
}: {
  runId: string;
  proposal: Proposal;
  token: string;
}): Promise<ApproveResult> {
  const url = ENDPOINT[proposal.action];
  if (!url) throw new Error(`This action can't be approved yet (${proposal.action}).`);

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ runId }),
  });

  const data = await r.json().catch(() => null);

  // 202 = a slow bridge burn (submitted, hash pending) — a real, recorded outcome, not an error.
  if (!r.ok && r.status !== 202) throw new Error(data?.error || "Approve failed");

  // A guard refused it (over cap, day-ceiling, insufficient funds). NO money moved, and the
  // server released its lock — surface the reason verbatim rather than a generic failure.
  if (data?.executed === false) {
    const verb = proposal.action === "swap_tokens" ? "swap" : "bridge";
    throw new Error(data.blocked || `The ${verb} was refused by a guard.`);
  }

  return { receipt: data?.receipt };
}
