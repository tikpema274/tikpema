// verify-rpc-absence-corroboration.mjs — ⛔ ONE ENDPOINT'S `null` MAY NOT CONCLUDE "NOT FOUND".
//
//   node scripts/verify-rpc-absence-corroboration.mjs   (also: npm run test:rpcabsence)
//
// ═══ 🚨 THE DEFECT THIS PINS ══════════════════════════════════════════════
// `rpcFallback` returned the FIRST endpoint that answered — and `null` counted as an answer. So a
// mirror that had PRUNED a transaction concluded "receipt_not_found" while its sibling still held
// the receipt, walking past the very fallback that exists because a single endpoint once
// disappeared. The loop only ever advanced on a THROWN error; an absence is not a throw.
//
// ⛔ MEASURED, both mirrors, one real Base Sepolia mint (2026-09-02):
//     base-sepolia-rpc.publicnode.com   → result: null
//     base-sepolia.gateway.tenderly.co  → status: 0x1
//   publicnode answers for 2026-09-01/02 and returns null for 2026-07-31 — a RETENTION WINDOW.
//   In production this reports a COMPLETED bridge as `mint_unconfirmed`, indefinitely.
//
// ⭐⭐ WHAT IS ASSERTED IS THE INVARIANT, NOT THE MECHANISM: an absence may not conclude while an
// endpoint has not been asked. Nothing here checks loop order, or which endpoint is first, or how
// many calls were made — those are how it happens to be implemented today.
//
// ⭐ AND THE FIXTURES DISAGREE ON PURPOSE. Two servers that both say null would pass a broken
// implementation and a correct one identically. The disagreement IS the test.

import { createServer } from "node:http";
import { rpcFallback } from "../netlify/functions/_receipt.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } return !!c; };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`);

const CHAIN_ID = 84532;                       // base sepolia, what the guard pins against
const RECEIPT = { status: "0x1", blockNumber: "0x1234", transactionHash: "0xfeed" };

/** A fixture endpoint. `behaviour` decides what it answers for the RECEIPT call. */
function fixture(behaviour) {
  const hits = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method } = JSON.parse(body);
      hits.push(method);
      if (behaviour === "dead") { res.destroy(); return; }
      const result = method === "eth_chainId" ? "0x" + CHAIN_ID.toString(16)
        : behaviour === "has" ? RECEIPT
        : null;                                   // "absent"
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () =>
    resolve({ url: `http://127.0.0.1:${srv.address().port}`, hits, close: () => srv.close() })));
}
const chainOf = (...eps) => ({ rpcs: eps.map((e) => e.url), chainId: CHAIN_ID });
const get = (chain) => rpcFallback(chain, "eth_getTransactionReceipt", ["0xabc"], { absenceNeedsCorroboration: true });

section("1 — 🚨 THE DISAGREEMENT: first says absent, second HAS it");
{
  const a = await fixture("absent"), b = await fixture("has");
  const r = await get(chainOf(a, b));
  check("⛔ the receipt is FOUND — one null did not conclude", r.result?.status === "0x1",
    r.result ? `status ${r.result.status}` : "NOT FOUND — a pruned mirror overrode a live one");
  check("  …and it records which endpoint answered absent", Array.isArray(r.absentFrom) && r.absentFrom.length === 1);
  check("  …and the second endpoint was actually asked", b.hits.includes("eth_getTransactionReceipt"));
  a.close(); b.close();
}

section("2 — ⭐ ORDER MUST NOT MATTER — the invariant is not 'try the second one'");
{
  const a = await fixture("has"), b = await fixture("absent");
  const r = await get(chainOf(a, b));
  check("✅ found when the FIRST has it", r.result?.status === "0x1");
  check("  …and it does not waste a call on the second", !b.hits.includes("eth_getTransactionReceipt"));
  a.close(); b.close();
}

section("3 — ⛔ NOT-FOUND SURVIVES: every endpoint that answered said absent");
{
  const a = await fixture("absent"), b = await fixture("absent");
  // ⛔ THE THROW IS CAUGHT, BECAUSE A CRASH IS NOT A VERDICT. An earlier draft let it escape: the
  // process died mid-section and the mutation that collapsed not-found into rpc_error produced a
  // stack trace instead of a named failure. A guard must SAY what broke, not merely stop.
  let r = null, threw = null;
  try { r = await get(chainOf(a, b)); } catch (e) { threw = e; }
  check("  …and it did NOT throw — not-found is not an rpc_error", threw === null,
    threw ? `THREW instead: ${threw.message.slice(0, 60)}` : "returned a value");
  check("⛔ result is null — a real absence still concludes", r?.result === null,
    threw ? "no result — it threw" : String(r?.result));
  check("🚨 …and it is marked CORROBORATED — both were asked, both agreed", r?.corroborated === true,
    threw ? "no result — it threw" : `absentFrom ${r?.absentFrom?.length}`);
  a.close(); b.close();
}

section("4 — 🚨 THE THIRD OUTCOME STAYS DISTINCT: nothing answered at all");
{
  const a = await fixture("dead"), b = await fixture("dead");
  let threw = false, msg = "";
  try { await get(chainOf(a, b)); } catch (e) { threw = true; msg = e.message.slice(0, 50); }
  check("⛔ all-dead THROWS — it must not masquerade as not-found", threw, msg);
  a.close(); b.close();
}

section("5 — ⚠️ A MIX IS NOT UNANIMITY, AND MUST NOT CLAIM TO BE");
{
  const a = await fixture("absent"), b = await fixture("dead");
  const r = await get(chainOf(a, b));
  check("⛔ still concludes absent — one endpoint DID answer", r.result === null);
  check("🚨 …but NOT corroborated — we never heard from the other", r.corroborated === false,
    `unheardFrom ${JSON.stringify(r.unheardFrom)}`);
  check("  …and it names which endpoint was silent", r.unheardFrom?.length === 1);
  a.close(); b.close();
}

section("6 — ⭐ THE FLAG IS OPT-IN: other callers are unchanged");
{
  const a = await fixture("absent"), b = await fixture("has");
  const r = await rpcFallback(chainOf(a, b), "eth_getTransactionReceipt", ["0xabc"]);
  check("without the option, first-answer-wins is preserved", r.result === null,
    "callers that WANT a raw first answer still get one");
  a.close(); b.close();
}

console.log(`\n╔${"═".repeat(37)}`);
console.log(`║  ${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}`);
console.log(`╚${"═".repeat(37)}`);
if (!fail) console.log("⭐ An absence cannot conclude while an endpoint has not been asked.");
process.exit(fail ? 1 : 0);
