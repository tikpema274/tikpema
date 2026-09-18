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
import { ARC, CONTRACTS } from "./_arc.mjs";
import { parseUnits6, ADDRESS_RE, TX_HASH_RE } from "./_checkout.mjs";

/** keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer event signature. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const low = (s) => String(s || "").toLowerCase();
const topicToAddress = (t) => (typeof t === "string" && t.length === 66 ? "0x" + t.slice(26) : "");

/**
 * Pure. Given a receipt (as eth_getTransactionReceipt returns it), decide whether it pays the order.
 * Returns { paid: true, value, log } or { paid: false, reason }.
 *
 * Exactly these conditions, all required:
 *   receipt.status === "0x1"                          — the transaction succeeded
 *   a log with address == USDC contract                — the ERC-20 emitter, not the native mirror
 *     and topics[0] == Transfer, topics[1] == from     — sent by the buyer's agent wallet
 *     and topics[2] == merchant                        — received by the payee the order names
 *     and value >= order amount (6dp units)            — at least what was asked (more is the buyer's
 *                                                        choice; less is not a payment of this order)
 */
export function verifyDirectPayment({ receipt, merchant, amountUsdc, from, usdc = CONTRACTS.USDC }) {
  if (!receipt || typeof receipt !== "object") return { paid: false, reason: "no receipt" };
  if (receipt.status !== "0x1") return { paid: false, reason: `transaction status ${receipt.status ?? "unknown"} (not success)` };
  if (!ADDRESS_RE.test(merchant || "") || !ADDRESS_RE.test(from || "")) return { paid: false, reason: "merchant or sender address malformed" };
  const need = parseUnits6(amountUsdc);
  if (need === null || need <= 0n) return { paid: false, reason: "order amount unreadable" };
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const usdcLogs = logs.filter((l) => low(l?.address) === low(usdc));
  if (usdcLogs.length === 0) return { paid: false, reason: "no log emitted by the USDC contract in this receipt" };
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
  if (!best) return { paid: false, reason: "no USDC Transfer from the buyer's agent wallet to the merchant in this receipt" };
  if (best.value < need) return { paid: false, reason: `USDC transfer of ${best.value} units is less than the order's ${need} units` };
  return { paid: true, value: best.value, log: best.log };
}

/**
 * Read a receipt from the Arc RPC. Returns { receipt } (may be null = not found / not yet mined),
 * or { unreadable: reason } when the RPC could not be consulted. The two are different facts.
 */
export async function fetchReceipt(txHash, { rpc = ARC.rpc, timeoutMs = 8000, fetchImpl = fetch } = {}) {
  if (!TX_HASH_RE.test(txHash || "")) return { unreadable: "malformed transaction hash" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
      signal: ctl.signal,
    });
    if (!r.ok) return { unreadable: `rpc http ${r.status}` };
    const j = await r.json();
    if (j?.error) return { unreadable: `rpc error ${j.error?.code ?? ""} ${j.error?.message ?? ""}`.trim() };
    if (!("result" in j)) return { unreadable: "rpc answered without a result field" };
    return { receipt: j.result ?? null };
  } catch (e) {
    return { unreadable: e?.name === "AbortError" ? `rpc timeout after ${timeoutMs}ms` : `rpc unreachable: ${e?.message ?? e}` };
  } finally {
    clearTimeout(timer);
  }
}
