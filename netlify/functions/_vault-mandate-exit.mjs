// _vault-mandate-exit.mjs — piece 5's server-side exit module. Today it holds ONE thing: the exit's OWN pause check.
// The executor itself (intent, submit, recovery) is not built; it will live here.
//
// ═══ ⛔ THE EXIT'S PAUSE CHECK IS ITS OWN CALL (finding C, T 2026-09-27) ═══════════════════════════════════
// executeAction's `vault_withdraw` branch is a RECLAIM: `isReclaim` skips the kill switch by design, so a paused Vault
// agent can never trap the user's funds. An autonomous EXIT is the agent acting, and T decided the kill switch stops it.
// So the exit must never route through executeAction (it would inherit the skip): it checks the pause here, explicitly,
// for the VAULT agent — which covers that agent's own pause, ALL_AGENTS and AGENT_HALT, and fails CLOSED on an
// unreadable store (_pause.mjs). The user's manual reclaim (agent-vault-withdraw) stays pause-exempt: pausing never
// traps funds; it only stops the agent acting alone.

import { pauseReason } from "./_pause.mjs";
import { AGENT } from "./_agents.mjs";

/**
 * The pause input decideExit (shared/vault-mandate/exit-decision.mjs) requires: {checked:true, reason:string|null}.
 * `reason` non-null = stopped (paused, halted, or the switch could not be read).
 */
export async function exitPauseCheck({ walletAddress }) {
  const reason = await pauseReason({ owner: walletAddress, agent: AGENT.VAULT });
  return { checked: true, reason: reason ?? null };
}
