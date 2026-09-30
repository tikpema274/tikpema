// exit-recovery.mjs — piece 5 step 6: what does each open exit-intent state resolve to, from its OWN instrument? Pure.
// The server side (reads, writes, settle, halt) is recoverMandateExit in _vault-mandate-exit.mjs.
//
// ═══ ⛔ RECOVERY NEVER RE-SENDS (the repeated-idempotency-key measurement, T 2026-09-30) ══════════════════
// Same key → same transaction, even with a different body and after COMPLETE — but key RETENTION was measured only to
// 32 s. Recovery runs on a later tick, so a re-send could CREATE a second redeem of the intent's fixed shares, from a
// wallet that may also hold hand-deposited shares (and BEYOND_MANDATE_SHARES would not fire: burned == submitted).
// So a `submitting` intent is LOCATED — by refId (= the intent key, set at submit) on the wallet's listed transactions.
// ⛔ NOT FOUND IS NOT "NEVER SUBMITTED": that a refId we set comes back on the listed transaction is UNMEASURED. It
// stays `stuck`, loudly, until that is measured or a human looks. Nothing is concluded from an absence.
//
//   submitting → located by refId → submitted (Circle id) | stuck (not found / ambiguous) | wait (list unreadable)
//   submitted  → Circle's state  → redeemed (a hash: it reached the chain) | failed (FAILED, no hash: never broadcast) | wait
//   redeemed   → the CHAIN (exit-outcome.mjs) → asserted (exited / exit-partial) | failed (the chain says so) | wait

const isHash = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

/** Which listed Circle transaction carries refId = this intent's key. Exactly one → found; two → ambiguous. */
export function matchByRefId({ intent, txs }) {
  const hits = (Array.isArray(txs) ? txs : []).filter((t) => t && t.refId === intent?.key && typeof t.id === "string");
  if (hits.length > 1) return { found: false, ambiguous: true, ids: hits.map((t) => t.id) };
  if (hits.length === 1) return { found: true, circleId: hits[0].id };
  return { found: false };
}

/** @param {{intent, lookup:{readable:boolean, match?:object}}} a */
export function resolveSubmitting({ intent, lookup }) {
  if (!lookup || lookup.readable !== true) return { action: "wait", why: "the wallet's Circle transactions could not be listed; read again next tick" };
  const m = lookup.match ?? {};
  if (m.ambiguous) return { action: "stuck", code: "submitting-ambiguous", why: `more than one Circle transaction carries this attempt's refId (${(m.ids ?? []).join(", ")}): a human must look` };
  if (m.found) return { to: "submitted", circleId: m.circleId };
  return { action: "stuck", code: "submitting-unlocated",
    why: `no Circle transaction carries refId ${intent?.key}. That is NOT evidence it was never submitted (the refId round trip is unmeasured), and recovery never re-sends: a human must look` };
}

/** @param {{intent, circle:{state, txHash?}|null}} a */
export function resolveSubmitted({ circle }) {
  if (!circle || typeof circle.state !== "string") return { action: "wait", why: "Circle's transaction state could not be read" };
  if (circle.state === "COMPLETE") return isHash(circle.txHash) ? { to: "redeemed", txHash: circle.txHash } : { action: "wait", why: "Circle reports COMPLETE but gave no hash yet" };
  if (circle.state === "FAILED") {
    return isHash(circle.txHash) ? { to: "redeemed", txHash: circle.txHash } // it reached the chain; the chain decides
      : { to: "failed", reason: "Circle rejected the redeem before broadcast (FAILED, no hash): nothing reached the chain" };
  }
  return { action: "wait", why: `Circle reports ${circle.state}` };
}

/** @param {{classified:object}} a — classifyExitOutcome's answer */
export function resolveRedeemed({ classified }) {
  const o = classified?.outcome;
  if (o === "exited" || o === "exit-partial") return { to: "asserted", outcome: classified };
  if (o === "failed") return { to: "failed", outcome: classified };
  return { action: "wait", why: classified?.why ?? "the exit's outcome could not be established from the chain yet" };
}
