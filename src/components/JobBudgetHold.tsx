// JobBudgetHold — what happens to a research job's budget, said as it happens: a HOLD, not a charge.
//
// ═══ WHY THIS REPLACED "Price to research this" ═══════════════════════════════════════════════
// The budget moves from the user's agent wallet into an ERC-8183 escrow for the job, and the job's
// client, provider and evaluator are ALL the user's own agent wallet (job-run-background.mjs). On pass
// complete() pays the provider; on fail reject() refunds the client — the same wallet either way.
// MEASURED 2026-09-25, job #186705: fund → … → complete, then an INBOUND 0.2 USDC from the escrow back to
// that wallet. "Price" read as a charge; the user pays nothing for the research — Tikpema pays for the
// model, the sources and any data it buys (the operator data pool).
//
// ⚠️ "WHEN THE JOB SETTLES" — NOT "ALWAYS". The escrow expires after 24h. claimRefund exists (permissionless,
// full budget to the job's client) and escrow-reclaim-sweep can call it — but it ships DISARMED, so today a
// stalled job's budget is returned only by T's manual run (scripts/escrow-reclaim.mjs). The INTERIM sentence
// says exactly that. ⛔ Swap it for "comes back automatically once the job expires" ONLY once the sweeper is
// armed, live and PROVEN on a real stalled job — not when it is merely built (verify-research-panel-copy).
//
// One component for both panels (#/research and #/plan) — the same escrow, so the same words.
// Pinned by verify-research-panel-copy.
export function JobBudgetHold({ budgetUsdc, subject }: { budgetUsdc: number; subject: "research" | "action" }) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ color: "var(--muted)", fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Held, not charged
        </span>
        <span style={{ fontSize: "1.2rem", fontWeight: 600, color: "var(--paper)" }}>{budgetUsdc} USDC</span>
      </div>
      <div style={{ marginTop: 6, color: "var(--paper-dim)" }}>
        This moves from your agent wallet into an on-chain escrow for this job, for the{" "}
        {subject === "action" ? "research for this action" : "research"}, and comes back to your agent wallet
        when the job settles, whether it passes or is rejected. Tikpema pays for the research itself,
        including any data it buys. If a job stalls, the budget stays in escrow until the job expires 24 hours
        after it starts; returning it from there isn't automatic yet.
      </div>
    </>
  );
}
