// spike-vanilla-rate-ceiling-live.mjs — DOES THE PER-MINUTE CEILING FIRE AGAINST *REAL* NETLIFY BLOBS?
//
//   node scripts/spikes/spike-vanilla-rate-ceiling-live.mjs
//
// ═══ 🚨 THE EXACT GAP, AND WHY THE GREEN SUITE DOES NOT CLOSE IT ════════════════════════════════
// test:vanillalimits proves the guard's LOGIC — 19/0, four mutations. But it mocks `@netlify/blobs`
// wholesale, so `onlyIfMatch` / `onlyIfNew` are MY OWN stubs answering MY OWN assumptions. Both
// sides of that boundary are the same process. [[binding-tested-across-what-it-binds]] — the same
// shape that let a Blobs-context bug take budget-sweep down for five ticks with twelve green suites.
// THE CEILING HAS NEVER FIRED AGAINST THE REAL STORE.
//
// ═══ ⭐⭐ HOW THIS COSTS NOTHING ═════════════════════════════════════════════════════════════════
// Guard A checks only the payer's BALANCE; the signature is not validated until after Guard B has
// already claimed its slot. So a FUNDED `from` plus a WELL-FORMED BUT BOGUS signature walks straight
// through A, consumes a real Blobs slot, and is then rejected by Circle at estimation — no
// broadcast, no gas, no USDC. The ceiling is exercised for free.
//
// ⭐ THE DECISIVE CHECK IS NOT THE 429. A 429 could come from an in-memory counter in a warm
// container. The proof is READING THE COUNTER BACK OUT OF THE LIVE STORE with the Netlify CLI.
//
// ⚠️ THE MINUTE BOUNDARY IS PART OF THE HYPOTHESIS. The bucket is Math.floor(Date.now()/60000); if
// the burst straddles a rollover the counter resets and the ceiling legitimately does not fire.
// That is INCONCLUSIVE, not a failure, and this script says so rather than reporting a false red.
import { execSync } from "node:child_process";

const SELLER_URL = "https://app.tikpema.xyz/.netlify/functions/x402-vanilla-seller";
const RPC = "https://rpc.testnet.arc.network";
const USDC = "0x3600000000000000000000000000000000000000";
const DELEGATE = "0x6db396c1a37024fd3bee1f3dbf3020aa3b2bb380";
const EXPECTED_CAP = 6;          // VANILLA_SELLER_SETTLES_PER_MIN is unset in prod ⇒ the default
const BURST = EXPECTED_CAP + 1;

const rpc = async (m, p) => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) });
  const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result;
};
const balOf = async (a) => BigInt(await rpc("eth_call", [{ to: USDC, data: "0x70a08231000000000000000000000000" + a.slice(2) }, "latest"]));
const nonceOf = async (a) => parseInt(await rpc("eth_getTransactionCount", [a, "latest"]), 16);

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  Guard B — does the ceiling fire against REAL Netlify Blobs?        ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝\n");

const ch = await (await fetch(SELLER_URL, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
const req = ch.accepts?.[0];
if (!req) { console.error("🚨 no challenge — seller not armed"); process.exit(1); }
const SELLER = req.payTo;

const payerBal = await balOf(DELEGATE);
const before = { bal: await balOf(SELLER), nonce: await nonceOf(SELLER) };

// ⚠️ Start early in a minute so a 7-request burst cannot straddle the rollover.
const msIntoMinute = Date.now() % 60000;
if (msIntoMinute > 25000) {
  const wait = 60000 - msIntoMinute + 500;
  console.log(`  waiting ${(wait / 1000).toFixed(1)}s for a fresh minute bucket (burst must not straddle)\n`);
  await new Promise((r) => setTimeout(r, wait));
}
const bucketAtStart = Math.floor(Date.now() / 60000);

console.log("════ PRE-REGISTERED ════");
console.log(`  payer ${DELEGATE} holds ${payerBal} atomic — MUST be >= ${req.amount} to clear Guard A`);
console.log(`  P1  requests 1..${EXPECTED_CAP}   -> 402 (Guard B allows; Circle rejects the bogus signature)`);
console.log(`  P2  request ${BURST}          -> 429, reason "${EXPECTED_CAP}/${EXPECTED_CAP} settles already this minute"`);
console.log(`  P3  seller nonce ${before.nonce} and balance ${before.bal} UNCHANGED — nothing broadcast, no gas`);
console.log(`  P4  ⭐ the counter reads {"n":${EXPECTED_CAP}} out of the LIVE x402-seller-rate store`);
console.log(`      (P2 alone could come from an in-memory counter in a warm container — P4 cannot)\n`);
if (payerBal < BigInt(req.amount)) { console.error("🚨 payer cannot clear Guard A — aborting"); process.exit(1); }

const bogus = "0x" + "11".repeat(65);   // well-formed 65 bytes, cryptographically meaningless
const codes = [], reasons = [];
for (let i = 1; i <= BURST; i++) {
  const auth = { from: DELEGATE, to: SELLER, value: req.amount, validAfter: "0",
    validBefore: String(Math.floor(Date.now() / 1000) + 300),
    nonce: "0x" + i.toString(16).padStart(64, "0") };
  const hdr = Buffer.from(JSON.stringify({ x402Version: 2, scheme: req.scheme, network: req.network,
    payload: { authorization: auth, signature: bogus } }), "utf8").toString("base64");
  const res = await fetch(SELLER_URL, { method: "POST",
    headers: { "content-type": "application/json", "X-PAYMENT": hdr }, body: "{}" });
  const body = await res.text();
  codes.push(res.status);
  reasons.push((body.match(/"reason":"([^"]{0,70})/) ?? [])[1] ?? "");
  console.log(`  [${i}/${BURST}] HTTP ${res.status}  ${reasons[i - 1]}`);
}
const bucketAtEnd = Math.floor(Date.now() / 60000);

const after = { bal: await balOf(SELLER), nonce: await nonceOf(SELLER) };
let live = null;
try {
  const out = execSync(`netlify blobs:get x402-seller-rate rate:${bucketAtStart}`, { encoding: "utf8", timeout: 90000 });
  live = out.trim();
} catch (e) { live = `READ FAILED: ${String(e?.message ?? e).slice(0, 80)}`; }

console.log("\n════ RESULT ════");
if (bucketAtEnd !== bucketAtStart) {
  console.log(`  ⚠️ INCONCLUSIVE — the burst straddled a minute rollover (${bucketAtStart} -> ${bucketAtEnd}).`);
  console.log("     The counter reset mid-burst, so the ceiling legitimately may not have fired.");
  console.log("     This is NOT a failure and must not be recorded as one. Re-run.");
  process.exit(2);
}
const ok = (l, c, got) => console.log(`  ${c ? "✅" : "❌"} ${l.padEnd(46)} ${got}`);
ok(`P1 first ${EXPECTED_CAP} allowed through Guard B`, codes.slice(0, EXPECTED_CAP).every((c) => c === 402), codes.slice(0, EXPECTED_CAP).join(","));
ok(`P2 request ${BURST} refused with 429`, codes[BURST - 1] === 429, `${codes[BURST - 1]} ${reasons[BURST - 1]}`);
ok("P3 seller nonce unchanged", after.nonce === before.nonce, `${before.nonce} -> ${after.nonce}`);
ok("P3 seller balance unchanged", after.bal === before.bal, `${before.bal} -> ${after.bal}`);
ok(`P4 ⭐ REAL Blobs counter reads n=${EXPECTED_CAP}`, /"n"\s*:\s*6/.test(live), live);
