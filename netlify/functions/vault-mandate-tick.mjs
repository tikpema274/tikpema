// vault-mandate-tick.mjs — SCHEDULED (netlify.toml). Runs every stored vault mandate once per tick: piece 4's
// pre-deposit path (_vault-mandate-deposit.mjs).
//
// ═══ 🔭 SHIPS DISARMED (T, 2026-09-26) ════════════════════════════════════════════════════════════
// MANDATE_DEPOSIT_ARMED = false. Disarmed, each due mandate is CHECKED — anchor, a report signed per check
// and verified, both endpoints' readings, the decision — and the receipt records "WOULD DEPOSIT X" with the
// signing latency. No intent is written and the executor is never reached. The gate is inside the deposit
// function, not here: this handler passes no arming config, so the shipped constants always apply.
// Harmless today: no mandate exists and there is no create endpoint (piece 6).
//
// 🚨 NOT HTTP-invokable (Netlify 403s scheduled functions) and deliberately no /api route.
import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { runMandateTick, productionTickDeps } from "./_vault-mandate-deposit.mjs";
import { VAULT_MANDATE_RECEIPT_STORE } from "./_vault-mandate-store.mjs";

export async function handler(event) {
  if (event?.blobs) connectBlobs(event);
  const deps = await productionTickDeps({ getStore, event });
  const beat = await runMandateTick({ deps });
  const summary = { at: new Date().toISOString(), ok: beat.ok, armed: beat.armed, error: beat.error ?? null,
    results: beat.results.map(({ owner, id, outcome, code, amountUsdc, reason }) => ({ owner, id, outcome, code, amountUsdc, reason })) };
  await getStore(VAULT_MANDATE_RECEIPT_STORE).setJSON("last", summary).catch(() => {});
  console.log(`[vault-mandate-tick] ${JSON.stringify(summary)}`);
  return { statusCode: 200, body: JSON.stringify(summary) };
}
