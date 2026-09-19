// resolveAgentWallet.ts — POST /api/my-wallet, as a PURE result: { wallet } or { error }. Never null-as-ok.
//
// ═══ WHY THIS IS NOT INSIDE THE HOOK (2026-09-19) ════════════════════════════════════════════════
// useWallet's refreshAgentWallet ran this loop and its caller did `.catch(() => {})`. A 401 (expired
// session), a 500, an unreachable server, or six 202s all ended the same way: `agentWallet` stayed
// null with NO record of why — and every page gated on `!w.agentWallet` rendered that as "Set up your
// wallet first", permanently, to a user who had just connected. The failure is now a VALUE the hook
// stores (`agentWalletError`) and the pages render with a Retry. [[absence-must-never-read-as-safe]]
//
// 202 = "provisioning" (the mapping exists but has not propagated to reads yet; converges in ~11s).
// Six tries 3s apart as before — but running out is an ERROR that says so, not a silent null.
export type AgentWalletRecord = { address: string; balance: string | null; eurcBalance: string | null };
export type ResolveResult = { wallet: AgentWalletRecord } | { error: string };

export const PROVISIONING_TRIES = 6;
export const PROVISIONING_WAIT_MS = 3000;

export async function resolveAgentWallet({
  token,
  fetchImpl = fetch,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
}: {
  token: string | null | undefined;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ResolveResult> {
  if (!token) return { error: "no session — sign in to prepare your agent wallet" };
  try {
    for (let i = 0; i < PROVISIONING_TRIES; i++) {
      const r = await fetchImpl("/api/my-wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      });
      if (r.status === 202) {
        await sleep(PROVISIONING_WAIT_MS);
        continue;
      }
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return { error: (data as any)?.error || `could not load your wallet (HTTP ${r.status})` };
      const address = (data as any)?.address;
      if (typeof address !== "string" || !address) return { error: "the server answered without a wallet address" };
      return { wallet: { address, balance: (data as any).balance ?? null, eurcBalance: (data as any).eurcBalance ?? null } };
    }
    return { error: `your agent wallet is still provisioning after ${PROVISIONING_TRIES} checks — try again in a moment` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
