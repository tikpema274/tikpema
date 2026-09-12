// verify-pay-refusal.mjs — a pay_for_service throw is classified, and NO calldata ever leaks.
//
//   node scripts/verify-pay-refusal.mjs
//
// ═══ 🚨 THE DEFECT THIS PINS ═════════════════════════════════════════════════════════════════════
// agentPay ended `} catch (e) { …recordStrand…; throw e; }` and agent-act ended `catch (e) { return
// json(500, { error: e.message }) }`. App Kit's mint leg submits `gatewayMint` FROM the RECIPIENT;
// for a non-Circle-Gateway address Circle holds no wallet and the mint reverts — code 5001
// ONCHAIN_TRANSACTION_REVERTED, "Requested resource not found". MEASURED 2026-09-12: TWO 0.1 attempts
// (10:49, 10:50) each surfaced the RAW error to the user — "reattempt via config.retry" plus ~600
// chars of attestation calldata — in a 500 body. The chain showed on-chain availableBalance never
// moved (1.51 throughout); the burn was only an off-chain reservation. So it is a deterministic
// USER/config condition (a 4xx that WON'T succeed on retry), not an operator-paging fault — and the
// calldata + retry advice must NEVER reach the client. Same class as agent-ub-spend (18c0396).
//
// ⭐ DRIVES THE PURE CLASSIFIER, not a regex over source. classifyPayThrow(e, {recipientAddress,
// amountUsdc}) is exported from _pay.mjs; a status is a value, so assert the value.
// [[assert-on-rendered-output-not-source-regex]] [[check-whose-failure-mode-is-a-pass]]
import { classifyPayThrow } from "../netlify/functions/_pay.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };

console.log("── a recipient that can't receive → 4xx; every branch drops the calldata ──\n");

const RCPT = "0x0c5E826e657F80CD5FBd31d07c59b5adc4872532";
// The measured error, verbatim shape (message + the calldata that lived in cause.trace).
const CALLDATA = "0x" + "a".repeat(600);
const MEASURED = {
  code: 5001,
  name: "ONCHAIN_TRANSACTION_REVERTED",
  message: "Mint failure: Use the attestation and signature in 'error.cause.trace' to reattempt via 'config.retry'. Cause: Unknown blockchain error on Arc Testnet: Requested resource not found.",
  cause: { trace: { attestation: CALLDATA, signature: CALLDATA } },
};

// 1. the measured signature → 400, recipient-unpayable, and it NAMES the condition
{
  const r = classifyPayThrow(MEASURED, { recipientAddress: RCPT, amountUsdc: 0.1 });
  check("⭐ the measured mint-failure → 400 (client, not 500)", r.status === 400, `status ${r.status}`);
  check("  …flagged recipientUnpayable + blocked", r.body.recipientUnpayable === true && r.body.blocked === true);
  check("  …names the recipient, says no payment was made, says retry won't help",
    r.body.error.includes(RCPT) && /no payment was made/i.test(r.body.error) && /retry(ing)? will not/i.test(r.body.error));
  check("  …echoes recipient + amount as fields", r.body.recipientAddress === RCPT && r.body.amountUsdc === 0.1);
}
// 2. ⛔ THE LEAK IS CLOSED — no calldata, no attestation, no "config.retry" in the returned body
{
  const r = classifyPayThrow(MEASURED, { recipientAddress: RCPT, amountUsdc: 0.1 });
  const blob = JSON.stringify(r.body);
  check("⛔ the body carries NONE of the raw calldata", !blob.includes(CALLDATA));
  check("⛔ …and none of the 'config.retry' / 'attestation' advice",
    !/config\.retry/i.test(blob) && !/attestation/i.test(blob) && !/error\.cause\.trace/i.test(blob));
}
// 3. bare "Requested resource not found" (no code/name) → still 400
{
  const r = classifyPayThrow(new Error("Requested resource not found"), { recipientAddress: RCPT });
  check("⭐ bare 'Requested resource not found' → 400", r.status === 400 && r.body.recipientUnpayable === true, `status ${r.status}`);
}
// 4. code 5001 + "Mint failure" (no resource-not-found phrase) → 400 via the second predicate
{
  const r = classifyPayThrow({ code: 5001, message: "Mint failure: something else" }, { recipientAddress: RCPT });
  check("⭐ code 5001 + 'Mint failure' → 400", r.status === 400 && r.body.recipientUnpayable === true, `status ${r.status}`);
}
// 5. ⛔ THE OTHER DIRECTION — an unrelated fault stays 500, SANITISED (no raw message, no calldata)
{
  const raw = `RPC Request failed: 503 upstream ${CALLDATA}`;
  const r = classifyPayThrow(new Error(raw), { recipientAddress: RCPT, amountUsdc: 0.1 });
  check("⛔ an unrelated fault stays 500 (not laundered into a 4xx)", r.status === 500, `status ${r.status}`);
  check("⛔ …and the 500 body is SANITISED — no raw message, no calldata",
    !r.body.error.includes(CALLDATA) && !r.body.error.includes("503") && r.body.recipientUnpayable === undefined);
}
// 6. ⛔ a generic 5001 revert that is NOT the mint case must NOT be read as unpayable → 500
{
  const r = classifyPayThrow({ code: 5001, name: "ONCHAIN_TRANSACTION_REVERTED", message: "execution reverted: ERC20: insufficient allowance" }, { recipientAddress: RCPT });
  check("⛔ a different 5001 revert is NOT 'recipient unpayable' → 500", r.status === 500 && !r.body.recipientUnpayable, `status ${r.status}`);
}
// 7. ⭐ a BigInt in cause must not throw the classifier (safeJson guards the haystack build)
{
  let threw = false, r;
  try { r = classifyPayThrow({ code: 5001, message: "Mint failure", cause: { trace: 5n } }, { recipientAddress: RCPT }); }
  catch { threw = true; }
  check("⭐ a BigInt in cause does not throw the classifier", !threw && r?.status === 400);
}

console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
