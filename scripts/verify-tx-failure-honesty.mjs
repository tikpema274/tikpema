// verify-tx-failure-honesty.mjs — "FAILED" MEANS TWO DIFFERENT THINGS AND THE MESSAGE MUST SAY WHICH.
//
//   node scripts/verify-tx-failure-honesty.mjs      (also: npm run test:txhonesty)
//
// ═══ 🚨 THE DEFECT ══════════════════════════════════════════════════════════════════════════════
// `waitForTx` answered every Circle FAILED state with the flat string "Transaction failed on-chain".
// But Circle marks a transaction FAILED in two cases that are not the same fact:
//
//   · it was BROADCAST and reverted            → a transaction really did fail on-chain
//   · it was REJECTED AT ESTIMATION            → nothing ever reached the chain
//
// The second is the common one for a bad signature or an unfunded payer, and it surfaced SIX TIMES
// in one burst against the vanilla seller, each time telling the caller the chain had rejected a
// transaction that never existed. ⭐ Same family as the UI's "Send failed": a message asserting
// something the code did not observe.
//
// ⭐ THE DISCRIMINATOR WAS ALREADY IN THE REPO AND NEVER PROPAGATED. spike-step4b/4c/5b all record
// it verbatim — "NO HASH → never broadcast".
//
// ⚠️ THIS IS A SHARED MONEY-PATH HELPER: 12+ functions call waitForTx. The structured fields are
// ADDITIVE so every existing caller that reads `.message` keeps working; both directions asserted.
import { waitForTx, TxPendingError } from "../netlify/functions/_circle.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => {
  let ok = false, note = x;
  try { ok = typeof c === "function" ? !!c() : !!c; }
  catch (e) { ok = false; note = `threw: ${String(e?.message ?? e).slice(0, 60)}`; }
  if (ok) { pass++; console.log(`  ✅ ${l}${note ? ` — ${note}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${note ? ` — ${note}` : ""}`); }
};
const clientReturning = (transaction) => ({ getTransaction: async () => ({ data: { transaction } }) });
const caught = async (client) => { try { await waitForTx(client, "id-1", 4000); return null; } catch (e) { return e; } };

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  TX FAILURE HONESTY — never assert an on-chain event we never saw   ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

console.log("\n── 1. FAILED *without* a txHash → it never reached the chain ───────");
{
  const e = await caught(clientReturning({ state: "FAILED", errorReason: "ESTIMATION_ERROR" }));
  // 🚨 THE DEFECT, ASSERTED GONE.
  check("🚨 it does NOT say the transaction failed ON-CHAIN", !/on-chain/i.test(e.message), e.message);
  check("⭐ it says it never reached the chain", /never reached the chain/i.test(e.message));
  check("⭐ and names the rejection point", /before broadcast/i.test(e.message));
  check("the reason Circle gave is carried, not dropped", /ESTIMATION_ERROR/.test(e.message));
  check("⭐⭐ the FACT is structured, not only prose", e.broadcast === false && e.txHash === null,
    `broadcast=${e.broadcast} txHash=${e.txHash}`);
}

console.log("\n── 2. FAILED *with* a txHash → it really did revert on-chain ───────");
{
  const hash = "0x" + "ab".repeat(32);
  const e = await caught(clientReturning({ state: "FAILED", txHash: hash, errorReason: "REVERTED" }));
  // ⚠️ BOTH DIRECTIONS: a fix that never says "on-chain" would destroy the true case.
  check("⭐ it DOES report an on-chain revert", /reverted on-chain/i.test(e.message), e.message.slice(0, 60));
  check("…and quotes the tx hash so it can be looked up", e.message.includes(hash));
  check("⭐⭐ structured: broadcast === true", e.broadcast === true && e.txHash === hash);
  check("🚨 it must NOT claim nothing reached the chain", !/never reached/i.test(e.message));
}

console.log("\n── 3. THE HAPPY AND PENDING PATHS ARE UNCHANGED ────────────────────");
{
  const hash = "0x" + "cd".repeat(32);
  check("COMPLETE still returns the hash", await waitForTx(clientReturning({ state: "COMPLETE", txHash: hash }), "id", 4000) === hash);
  const e = await caught(clientReturning({ state: "SENT" }));
  check("a never-settling tx still raises TxPendingError", e instanceof TxPendingError, e?.constructor?.name);
  check("…and carries its circle id", e.txId === "id-1", String(e.txId));
}

console.log("\n── 4. ⚠️ EVERY EXISTING CALLER READS .message — IT MUST STAY USEFUL ");
{
  const e = await caught(clientReturning({ state: "FAILED" }));  // no reason at all
  check("a bare FAILED still produces a non-empty message", typeof e.message === "string" && e.message.length > 20, e.message);
  check("…without inventing a reason it was not given", !/\(\s*\)/.test(e.message) && !/undefined|null/.test(e.message), e.message);
  check("⭐ and still says nothing reached the chain (no hash ⇒ no broadcast)", /never reached the chain/i.test(e.message));
}

console.log("\n════════════════════════════════════════════════════════════════════════");
console.log(`${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log("⭐ A revert is reported as a revert; a rejection is not dressed up as one.\n");
