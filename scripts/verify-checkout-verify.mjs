// verify-checkout-verify.mjs — "did THIS transaction pay THIS order?" decided from crafted receipts.
//
//   node scripts/verify-checkout-verify.mjs      (npm run test:checkoutverify)
//
// ═══ THE PROPERTIES ══════════════════════════════════════════════════════════════════════════════
//   1. A receipt with a USDC-emitted Transfer from the buyer's agent wallet to the merchant, ≥ amount → PAID.
//   2. 🚨 Arc's NATIVE 18-dp mirror log (emitter 0xffff…fffe, same topic) is NOT accepted — filtered by
//      EMITTER, so the amount cannot be misjudged by 10^12.
//   3. Wrong `to`, wrong `from`, short amount, reverted status, no receipt → NOT paid, reason named.
//   4. Overpayment counts as paid (the buyer's choice); the larger of two matching logs is used.
//   5. fetchReceipt: RPC error / non-200 / timeout / malformed hash → `unreadable` (never a receipt);
//      `result: null` → `receipt: null` (readable, absent). The two are different facts.
//   6. 🚨 BLOCK BINDING (2026-09-19): the receipt's block must be AFTER `createdAtBlock`. Mined before or IN
//      the creation block → not paid, both blocks named. No `createdAtBlock` on the order → UNBOUND, refused
//      and SAID; a receipt with no blockNumber → refused. Absence never passes.
//   7. fetchBlockNumber: a hex head → a number; error / non-hex / missing → `unreadable`.
import { verifyDirectPayment, fetchReceipt, fetchBlockNumber, TRANSFER_TOPIC } from "../netlify/functions/_checkout-verify.mjs";
import { CONTRACTS } from "../netlify/functions/_arc.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);

const USDC = CONTRACTS.USDC;
const NATIVE_EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe";
const MERCHANT = "0x" + "ab".repeat(20);
const BUYER = "0x" + "cd".repeat(20);
const OTHER = "0x" + "ee".repeat(20);
const pad = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const hex = (n) => "0x" + n.toString(16);
const log = (emitter, from, to, units) => ({ address: emitter, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: hex(units) });
// Every crafted receipt is mined AFTER the order by default (block 0x100 = 256 > BOUND); section 6 varies it.
const BOUND = 100;
const receipt = (logs, status = "0x1", blockNumber = "0x100") => ({ status, logs, blockNumber });
const ONE_FIVE = 1_500_000n;                       // 1.5 USDC in 6dp units
const ONE_FIVE_NATIVE = 1_500_000n * 10n ** 12n;   // the same movement as the 18dp mirror

console.log("\nverify-checkout-verify — the receipt decides, by emitter, from, to, amount\n");

section("1 — the real Arc shape: TWO logs, only the USDC-emitted one counts");
{
  const r = receipt([log(NATIVE_EMITTER, BUYER, MERCHANT, ONE_FIVE_NATIVE), log(USDC, BUYER, MERCHANT, ONE_FIVE)]);
  const v = verifyDirectPayment({ receipt: r, merchant: MERCHANT, amountUsdc: "1.5", from: BUYER, createdAtBlock: BOUND });
  check("⭐⭐ paid, and the value read is the 6dp one (1500000), not the 18dp mirror", v.paid && v.value === ONE_FIVE, JSON.stringify(v.value?.toString()));
  check("…the matched log is the USDC-emitted one", v.log?.address === USDC);
}

section("2 — 🚨 the native mirror ALONE is not a payment");
{
  const r = receipt([log(NATIVE_EMITTER, BUYER, MERCHANT, ONE_FIVE_NATIVE)]);
  const v = verifyDirectPayment({ receipt: r, merchant: MERCHANT, amountUsdc: "1.5", from: BUYER, createdAtBlock: BOUND });
  check("🚨 NOT paid — no log emitted by the USDC contract", !v.paid && /USDC contract/.test(v.reason), v.reason);
  const wrongEmitter = receipt([log(OTHER, BUYER, MERCHANT, ONE_FIVE)]);
  const w = verifyDirectPayment({ receipt: wrongEmitter, merchant: MERCHANT, amountUsdc: "1.5", from: BUYER, createdAtBlock: BOUND });
  check("🚨 a Transfer with the right topic from ANOTHER contract is NOT a payment", !w.paid, w.reason);
}

section("3 — wrong party, short amount, reverted, absent");
{
  const to = verifyDirectPayment({ receipt: receipt([log(USDC, BUYER, OTHER, ONE_FIVE)]), merchant: MERCHANT, amountUsdc: "1.5", from: BUYER, createdAtBlock: BOUND });
  check("wrong `to` (not the merchant) → not paid", !to.paid && /to the merchant/.test(to.reason), to.reason);
  const from = verifyDirectPayment({ receipt: receipt([log(USDC, OTHER, MERCHANT, ONE_FIVE)]), merchant: MERCHANT, amountUsdc: "1.5", from: BUYER, createdAtBlock: BOUND });
  check("🚨 wrong `from` (someone else's transfer to the merchant) → not paid", !from.paid, from.reason);
  const short = verifyDirectPayment({ receipt: receipt([log(USDC, BUYER, MERCHANT, ONE_FIVE - 1n)]), merchant: MERCHANT, amountUsdc: "1.5", from: BUYER, createdAtBlock: BOUND });
  check("⭐ one unit short → not paid, both figures named", !short.paid && /1499999/.test(short.reason) && /1500000/.test(short.reason), short.reason);
  const rev = verifyDirectPayment({ receipt: receipt([log(USDC, BUYER, MERCHANT, ONE_FIVE)], "0x0"), merchant: MERCHANT, amountUsdc: "1.5", from: BUYER, createdAtBlock: BOUND });
  check("reverted transaction (status 0x0) → not paid even with a matching log", !rev.paid && /status/.test(rev.reason), rev.reason);
  const none = verifyDirectPayment({ receipt: null, merchant: MERCHANT, amountUsdc: "1.5", from: BUYER, createdAtBlock: BOUND });
  check("no receipt → not paid, 'no receipt'", !none.paid && /no receipt/.test(none.reason));
  const empty = verifyDirectPayment({ receipt: receipt([]), merchant: MERCHANT, amountUsdc: "1.5", from: BUYER, createdAtBlock: BOUND });
  check("no logs → not paid", !empty.paid);
  const badAmt = verifyDirectPayment({ receipt: receipt([log(USDC, BUYER, MERCHANT, ONE_FIVE)]), merchant: MERCHANT, amountUsdc: "abc", from: BUYER, createdAtBlock: BOUND });
  check("unreadable order amount → not paid (never treated as 0 owed)", !badAmt.paid && /amount unreadable/.test(badAmt.reason));
}

section("4 — overpayment, case-insensitive addresses, the larger of two matches");
{
  const over = verifyDirectPayment({ receipt: receipt([log(USDC, BUYER, MERCHANT, ONE_FIVE + 7n)]), merchant: MERCHANT, amountUsdc: "1.5", from: BUYER, createdAtBlock: BOUND });
  check("paying more than asked still pays the order", over.paid && over.value === ONE_FIVE + 7n);
  const cased = verifyDirectPayment({ receipt: receipt([log(USDC.toUpperCase().replace("0X", "0x"), BUYER.toUpperCase().replace("0X", "0x"), MERCHANT, ONE_FIVE)]), merchant: MERCHANT.toUpperCase().replace("0X", "0x"), amountUsdc: "1.5", from: BUYER, createdAtBlock: BOUND });
  check("addresses compare case-insensitively", cased.paid);
  const two = verifyDirectPayment({ receipt: receipt([log(USDC, BUYER, MERCHANT, 1n), log(USDC, BUYER, MERCHANT, ONE_FIVE)]), merchant: MERCHANT, amountUsdc: "1.5", from: BUYER, createdAtBlock: BOUND });
  check("two matching logs → the larger is judged", two.paid && two.value === ONE_FIVE);
}

section("5 — fetchReceipt: unreadable ≠ absent");
{
  const mk = (impl) => fetchReceipt("0x" + "ab".repeat(32), { fetchImpl: impl, timeoutMs: 200 });
  const ok = await mk(async () => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: { status: "0x1", logs: [] } }) }));
  check("a result → { receipt }", !!ok.receipt && !ok.unreadable);
  const absent = await mk(async () => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: null }) }));
  check("⭐ result:null → receipt:null (READABLE, absent), not unreadable", absent.receipt === null && !("unreadable" in absent));
  const err = await mk(async () => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } }) }));
  check("rpc error → unreadable", /rpc error/.test(err.unreadable || ""));
  const http = await mk(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  check("http 503 → unreadable", /http 503/.test(http.unreadable || ""));
  const noField = await mk(async () => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1 }) }));
  check("answer without a result field → unreadable (never absent)", /without a result/.test(noField.unreadable || ""));
  const slow = await mk((_, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; rej(e); })));
  check("timeout → unreadable, names the timeout", /timeout/.test(slow.unreadable || ""), slow.unreadable);
  const bad = await fetchReceipt("0x123", { fetchImpl: async () => { throw new Error("should not be called"); } });
  check("malformed hash → unreadable without calling the RPC", /malformed/.test(bad.unreadable || ""));
}

section("6 — 🚨 block binding: the transfer must post-date the order");
{
  const good = log(USDC, BUYER, MERCHANT, ONE_FIVE);
  const before = verifyDirectPayment({ receipt: receipt([good], "0x1", "0x63"), merchant: MERCHANT, amountUsdc: "1.5", from: BUYER, createdAtBlock: BOUND });
  check("🚨 mined at block 99, order created at 100 → NOT paid, both blocks named", !before.paid && /99/.test(before.reason) && /100/.test(before.reason) && /before/i.test(before.reason), before.reason);
  check("…code predates", before.code === "predates");
  const same = verifyDirectPayment({ receipt: receipt([good], "0x1", "0x64"), merchant: MERCHANT, amountUsdc: "1.5", from: BUYER, createdAtBlock: BOUND });
  check("🚨 mined IN the creation block (100) → NOT paid: it was already mined when the head was read", !same.paid && same.code === "predates", same.reason);
  const after = verifyDirectPayment({ receipt: receipt([good], "0x1", "0x65"), merchant: MERCHANT, amountUsdc: "1.5", from: BUYER, createdAtBlock: BOUND });
  check("⭐ mined at 101 → paid", after.paid, after.reason);
  const numeric = verifyDirectPayment({ receipt: { status: "0x1", logs: [good], blockNumber: 101 }, merchant: MERCHANT, amountUsdc: "1.5", from: BUYER, createdAtBlock: BOUND });
  check("a numeric blockNumber on the receipt is read too", numeric.paid, numeric.reason);
  for (const missing of [undefined, null, NaN, -1, "abc", 1.5]) {
    const u = verifyDirectPayment({ receipt: receipt([good]), merchant: MERCHANT, amountUsdc: "1.5", from: BUYER, createdAtBlock: missing });
    check(`🚨 createdAtBlock ${String(missing)} → UNBOUND: refused and SAID (never passed)`, !u.paid && /unbound/i.test(u.reason) && /createdAtBlock/.test(u.reason) && u.code === "unbound", u.reason);
  }
  const noBlock = verifyDirectPayment({ receipt: { status: "0x1", logs: [good] }, merchant: MERCHANT, amountUsdc: "1.5", from: BUYER, createdAtBlock: BOUND });
  check("🚨 a receipt with NO blockNumber → not paid (cannot be shown to post-date anything)", !noBlock.paid && /block/i.test(noBlock.reason), noBlock.reason);
  const bigBefore = verifyDirectPayment({ receipt: receipt([good], "0x1", "0x3be81d1"), merchant: MERCHANT, amountUsdc: "1.5", from: BUYER, createdAtBlock: 62816722 });
  check("the prod shape: block 62816721 vs an order at 62816722 → refused", !bigBefore.paid && /62816721/.test(bigBefore.reason) && /62816722/.test(bigBefore.reason), bigBefore.reason);
  const stillShort = verifyDirectPayment({ receipt: receipt([log(USDC, BUYER, MERCHANT, ONE_FIVE - 1n)], "0x1", "0x65"), merchant: MERCHANT, amountUsdc: "1.5", from: BUYER, createdAtBlock: BOUND });
  check("post-dating does not relax the amount: still short → still not paid", !stillShort.paid && /1499999/.test(stillShort.reason));
}

section("7 — fetchBlockNumber: a head, or unreadable");
{
  const mk = (impl) => fetchBlockNumber({ fetchImpl: impl, timeoutMs: 200 });
  const ok = await mk(async () => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x3be7f71" }) }));
  check("⭐ hex head → the number (0x3be7f71 = 62816113)", ok.blockNumber === 62816113 && !ok.unreadable, JSON.stringify(ok));
  const err = await mk(async () => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } }) }));
  check("rpc error → unreadable", /rpc error/.test(err.unreadable || ""));
  const junk = await mk(async () => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: "latest" }) }));
  check("non-hex result → unreadable (never 0)", /unreadable|not a block/i.test(junk.unreadable || "") && junk.blockNumber === undefined, junk.unreadable);
  const nul = await mk(async () => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: null }) }));
  check("null result → unreadable (a head is never absent)", !!nul.unreadable && nul.blockNumber === undefined, nul.unreadable);
  const http = await mk(async () => ({ ok: false, status: 502, json: async () => ({}) }));
  check("http 502 → unreadable", /http 502/.test(http.unreadable || ""));
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0\n`);
