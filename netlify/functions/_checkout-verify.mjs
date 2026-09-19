// _checkout-verify.mjs — did THIS transaction pay THIS order? Decided from the chain, not from the client.
//
// ═══ WHY THE SERVER READS THE RECEIPT ═════════════════════════════════════════════════════════════
// The buyer's client moves the money through the existing /api/agent-send and then tells us the hash.
// A client-reported hash is a CLAIM. Marking an order paid on a claim would let anyone mark any order
// paid with any hash they found on the explorer. So the order is marked paid only when the receipt,
// read by us from the Arc RPC, shows a USDC transfer of at least the order amount, from the buyer's
// agent wallet, to the merchant. Anything less is "unverified", and unverified is NOT paid.
//
// ⚠️ ARC EMITS TWO Transfer LOGS PER USDC SEND (measured; memory `arc-emits-two-transfer-logs`): a
// native 18-decimal one from the system address 0xffff…fffe and the ERC-20 6-decimal one from the
// USDC contract. They carry DIFFERENT amounts for the same movement. Only the log EMITTED BY THE
// USDC CONTRACT is read here; matching on topic alone would accept the 18-dp log and misjudge the
// amount by 10^12.
//
// ⚠️ UNREADABLE ≠ FAILED. An RPC that cannot be reached tells us nothing; the order stays as it was
// and the caller answers 503 "unverified". Only a receipt we READ can say "not paid".
// [[absence-must-never-read-as-safe]]
//
// 🚨 THE RECEIPT MUST POST-DATE THE ORDER (2026-09-19). emitter/from/to/amount bind a transfer to a
// MERCHANT, not to an ORDER: a plain #/send made before the order existed satisfied all four. So the
// order records the chain head at creation (`createdAtBlock`) and the receipt's block must be AFTER
// it — strictly: a transfer IN the creation block was already mined when that head was read, so it
// pre-dates the order too. An order with no `createdAtBlock` is UNBOUND: refused, and the reason says
// so — it is never treated as "no bound to check". The hash-claim (one hash, one order) is the other
// half and lives in `_checkout.mjs` (`claimTxForOrder`); the handler runs both.
import { ARC, CONTRACTS } from "./_arc.mjs";
import { parseUnits6, ADDRESS_RE, TX_HASH_RE, isBlockHeight } from "./_checkout.mjs";

/** keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer event signature. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const low = (s) => String(s || "").toLowerCase();
const topicToAddress = (t) => (typeof t === "string" && t.length === 66 ? "0x" + t.slice(26) : "");
/** A block height as the RPC gives it (hex quantity) or as JSON stores it (number) → number, or null. */
function readBlockHeight(v) {
  if (typeof v === "number") return isBlockHeight(v) ? v : null;
  if (typeof v === "string" && /^0x[0-9a-fA-F]{1,14}$/.test(v)) { const n = Number(BigInt(v)); return Number.isSafeInteger(n) ? n : null; }
  return null;
}

/**
 * Pure. Given a receipt (as eth_getTransactionReceipt returns it), decide whether it pays the order.
 * Returns { paid: true, value, log } or { paid: false, reason }.
 *
 * Exactly these conditions, all required:
 *   receipt.status === "0x1"                          — the transaction succeeded
 *   createdAtBlock is a block height                   — the order is BOUND (else: refused as unbound)
 *   receipt.blockNumber > createdAtBlock               — mined AFTER the order was created
 *   a log with address == USDC contract                — the ERC-20 emitter, not the native mirror
 *     and topics[0] == Transfer, topics[1] == from     — sent by the buyer's agent wallet
 *     and topics[2] == merchant                        — received by the payee the order names
 *     and value >= order amount (6dp units)            — at least what was asked (more is the buyer's
 *                                                        choice; less is not a payment of this order)
 * A refusal carries `code` ("unbound" | "predates" | "receipt") so a caller can act on the KIND of
 * refusal without parsing English; `reason` is the sentence a person reads.
 */
export function verifyDirectPayment({ receipt, merchant, amountUsdc, from, createdAtBlock, usdc = CONTRACTS.USDC }) {
  if (!receipt || typeof receipt !== "object") return { paid: false, code: "receipt", reason: "no receipt" };
  if (receipt.status !== "0x1") return { paid: false, code: "receipt", reason: `transaction status ${receipt.status ?? "unknown"} (not success)` };
  if (!ADDRESS_RE.test(merchant || "") || !ADDRESS_RE.test(from || "")) return { paid: false, code: "receipt", reason: "merchant or sender address malformed" };
  const need = parseUnits6(amountUsdc);
  if (need === null || need <= 0n) return { paid: false, code: "receipt", reason: "order amount unreadable" };
  // ── binding: the order must be bound, and the transfer must post-date it ──────────────────────
  if (!isBlockHeight(createdAtBlock)) {
    return { paid: false, code: "unbound", reason: "the order is unbound — it has no createdAtBlock, so no transfer can be shown to post-date it; refused, not passed (orders created before 2026-09-19 binding cannot be settled through this link — ask the seller for a new one)" };
  }
  const minedAt = readBlockHeight(receipt.blockNumber);
  if (minedAt === null) return { paid: false, code: "receipt", reason: "receipt carries no readable block number, so it cannot be shown to post-date the order" };
  if (minedAt <= createdAtBlock) {
    return { paid: false, code: "predates", reason: `the transfer was mined in block ${minedAt}, before this order was created at block ${createdAtBlock}${minedAt === createdAtBlock ? " (same block: already mined when the order was minted)" : ""}` };
  }
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const usdcLogs = logs.filter((l) => low(l?.address) === low(usdc));
  if (usdcLogs.length === 0) return { paid: false, code: "receipt", reason: "no log emitted by the USDC contract in this receipt" };
  let best = null;
  for (const l of usdcLogs) {
    const t = Array.isArray(l.topics) ? l.topics : [];
    if (low(t[0]) !== TRANSFER_TOPIC) continue;
    if (low(topicToAddress(t[1])) !== low(from)) continue;
    if (low(topicToAddress(t[2])) !== low(merchant)) continue;
    let value;
    try { value = BigInt(l.data); } catch { continue; }
    if (best === null || value > best.value) best = { value, log: l };
  }
  if (!best) return { paid: false, code: "receipt", reason: "no USDC Transfer from the buyer's agent wallet to the merchant in this receipt" };
  if (best.value < need) return { paid: false, code: "receipt", reason: `USDC transfer of ${best.value} units is less than the order's ${need} units` };
  return { paid: true, value: best.value, log: best.log, minedAt };
}

/** One JSON-RPC call. { result } (may be null) or { unreadable }. The two are different facts. */
async function rpcCall(method, params, { rpc = ARC.rpc, timeoutMs = 8000, fetchImpl = fetch } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctl.signal,
    });
    if (!r.ok) return { unreadable: `rpc http ${r.status}` };
    const j = await r.json();
    if (j?.error) return { unreadable: `rpc error ${j.error?.code ?? ""} ${j.error?.message ?? ""}`.trim() };
    if (!("result" in j)) return { unreadable: "rpc answered without a result field" };
    return { result: j.result ?? null };
  } catch (e) {
    return { unreadable: e?.name === "AbortError" ? `rpc timeout after ${timeoutMs}ms` : `rpc unreachable: ${e?.message ?? e}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a receipt from the Arc RPC. Returns { receipt } (may be null = not found / not yet mined),
 * or { unreadable: reason } when the RPC could not be consulted. The two are different facts.
 */
export async function fetchReceipt(txHash, opts = {}) {
  if (!TX_HASH_RE.test(txHash || "")) return { unreadable: "malformed transaction hash" };
  const got = await rpcCall("eth_getTransactionReceipt", [txHash], opts);
  return got.unreadable ? got : { receipt: got.result };
}

/**
 * The chain head, for `createdAtBlock` at order creation. Returns { blockNumber } (a number) or
 * { unreadable: reason }. A head is NEVER absent: a null / non-hex result is unreadable, not 0 —
 * an order bound at block 0 would accept every transfer ever mined.
 */
export async function fetchBlockNumber(opts = {}) {
  const got = await rpcCall("eth_blockNumber", [], opts);
  if (got.unreadable) return got;
  const n = readBlockHeight(got.result);
  if (n === null) return { unreadable: `rpc answered eth_blockNumber with something that is not a block height: ${JSON.stringify(got.result)}` };
  return { blockNumber: n };
}
