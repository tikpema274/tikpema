// _escrow-reclaim.mjs — RECLAIM AN EXPIRED RESEARCH-JOB ESCROW. claimRefund(uint256) and nothing else.
//
// ═══ WHY THIS EXISTS (measured 2026-09-25) ═══════════════════════════════════════════════════
// A research job's budget sits in the ERC-8183 escrow (AgenticCommerce, CONTRACTS.AGENTIC_COMMERCE). A job
// that stalls after funding never settles; the escrow expires 24h later (job-run-background: expiredAt =
// now + 86400) and NOTHING reclaimed it. 25 of our 360 on-chain jobs were still Funded/Submitted, all past
// expiry, 59.25 USDC — all from June–early July; 19 of them `eval-error: no submitted deliverable`.
//
// ═══ WHAT THE CONTRACT ALLOWS (verified source, implementation 0xa316…351a) ═══════════════════
//   claimRefund(jobId) — ANYONE may call it, once block.timestamp ≥ expiredAt, on a Funded or Submitted job.
//   It pays the FULL budget to job.client and emits Refunded(jobId, client, amount). It CANNOT be redirected.
//   That is what makes an automated caller safe: the worst it can do is return money to its owner early —
//   and "early" is impossible, the contract refuses before expiry.
//
// ═══ ⛔ WHAT THIS MODULE MUST NEVER DO ════════════════════════════════════════════════════════
//   · call reject() — the evaluator may reject a funded job at ANY time; doing that on a "looks stalled"
//     guess is exactly how a job that is merely SLOW gets killed. The 24h expiry is the only stall signal.
//   · act before expiry — the contract refuses anyway; we check first rather than lean on reverts.
//   · trust a stored run status — a record saying eval-error may have settled on-chain since. getJob, always.
//   · record a reclaim that the chain did not show — `refunded: true` ONLY from the Refunded event.
//   · look at jobs that are not ours — permissionless is not "our business"; callers pass OUR job ids.
//
// ═══ THE ESCROW'S FEES — watched, because our copy depends on them ════════════════════════════
// complete() deducts platformFeeBP + evaluatorFeeBP (admin-set, up to 100% combined, NOT ours; 0/0 today).
// claimRefund and reject pay the full budget regardless. But "comes back to your agent wallet" on a
// COMPLETED job is true only while both are 0 — so a change must surface, not be discovered later.
import { parseAbiItem, decodeEventLog, formatUnits } from "viem";
import { CONTRACTS, USDC_DECIMALS } from "./_arc.mjs";

export const ESCROW_ADDRESS = CONTRACTS.AGENTIC_COMMERCE;
/** AgenticCommerce.JobStatus, in declaration order. */
export const JOB_STATUS = Object.freeze(["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"]);
export const CLAIM_REFUND_SIG = "claimRefund(uint256)";

export const GET_JOB_ABI = [{
  name: "getJob", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }],
  outputs: [{ type: "tuple", components: [
    { name: "id", type: "uint256" }, { name: "client", type: "address" }, { name: "provider", type: "address" },
    { name: "evaluator", type: "address" }, { name: "description", type: "string" }, { name: "budget", type: "uint256" },
    { name: "expiredAt", type: "uint256" }, { name: "status", type: "uint8" }, { name: "hook", type: "address" },
  ] }],
}];
export const FEE_NAMES = Object.freeze(["platformFeeBP", "evaluatorFeeBP"]);
const REFUNDED = parseAbiItem("event Refunded(uint256 indexed jobId, address indexed client, uint256 amount)");

/**
 * What one on-chain job means for a reclaim. Only `reclaimable` may ever be acted on.
 * @returns {{ class: "reclaimable"|"not-expired"|"settled"|"open"|"unreadable", status?: string }}
 */
export function classifyJob(job, nowSec) {
  if (!job || job.id === undefined || BigInt(job.id) === 0n) return { class: "unreadable", reason: "no such job" };
  const status = JOB_STATUS[Number(job.status)];
  if (!status) return { class: "unreadable", reason: `unknown status ${job.status}` };
  if (status === "Completed" || status === "Rejected" || status === "Expired") return { class: "settled", status };
  if (status === "Open") return { class: "open", status };
  // Funded or Submitted: funds are held. Reclaimable only once the contract itself would allow it.
  return BigInt(nowSec) >= BigInt(job.expiredAt) ? { class: "reclaimable", status } : { class: "not-expired", status };
}

/**
 * Plan a reclaim over the job ids we were GIVEN (never discovered). `expiredAfterSec` excludes jobs that
 * expired before it — the scheduled sweeper passes its arming time, so the historical backlog stays T's
 * explicit run and never becomes the schedule's first tick.
 */
export async function planReclaim({ jobIds, readJob, nowSec, expiredAfterSec = null }) {
  const out = { reclaimable: [], notExpired: [], settled: [], open: [], unreadable: [], excludedBeforeCutoff: [] };
  for (const jobId of [...new Set(jobIds.map(String))]) {
    let job;
    try { job = await readJob(jobId); } catch (e) { out.unreadable.push({ jobId, reason: String(e?.message ?? e) }); continue; }
    const c = classifyJob(job, nowSec);
    const row = { jobId, status: c.status ?? null, client: job?.client ?? null,
      budgetUsdc: job?.budget !== undefined ? formatUnits(BigInt(job.budget), USDC_DECIMALS) : null,
      expiredAt: job?.expiredAt !== undefined ? String(job.expiredAt) : null };
    if (c.class === "reclaimable") {
      if (expiredAfterSec !== null && BigInt(job.expiredAt) < BigInt(expiredAfterSec)) out.excludedBeforeCutoff.push(row);
      else out.reclaimable.push(row);
    } else if (c.class === "not-expired") out.notExpired.push(row);
    else if (c.class === "settled") out.settled.push(row);
    else if (c.class === "open") out.open.push(row);
    else out.unreadable.push({ ...row, reason: c.reason });
  }
  return out;
}

/**
 * Submit claimRefund for ONE planned entry and record ONLY what the chain shows.
 * `submitClaim(jobId)` → txHash (the ONE write; see liveDeps). `readReceiptLogs(txHash)` → logs.
 *   refunded:true  — the receipt carries Refunded(jobId, …): amount and recipient are READ, not derived
 *   refunded:null  — a tx landed but no matching Refunded event was seen: UNVERIFIED, look before acting
 *   refunded:false — the submission itself failed; nothing is claimed
 */
export async function executeReclaim({ entry, submitClaim, readReceiptLogs }) {
  const jobId = String(entry.jobId);
  let txHash;
  try { txHash = await submitClaim(jobId); }
  catch (e) { return { jobId, refunded: false, error: String(e?.message ?? e), txHash: e?.txHash ?? null }; }
  let logs = [];
  try { logs = await readReceiptLogs(txHash); }
  catch (e) { return { jobId, txHash, refunded: null, reason: `receipt unreadable: ${e?.message ?? e} — Refunded not observed` }; }
  for (const l of logs ?? []) {
    if (String(l.address ?? "").toLowerCase() !== ESCROW_ADDRESS.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: [REFUNDED], data: l.data, topics: l.topics });
      if (d.eventName === "Refunded" && String(d.args.jobId) === jobId) {
        return { jobId, txHash, refunded: true, to: d.args.client, amountUsdc: formatUnits(d.args.amount, USDC_DECIMALS) };
      }
    } catch { /* not a Refunded log */ }
  }
  return { jobId, txHash, refunded: null, reason: "the transaction landed but no Refunded event for this job was observed" };
}

/** The escrow's fees, tri-state: an unreadable read is readable:false with nulls — never a zero. */
export async function readEscrowFees({ readFee }) {
  try {
    const [p, e] = await Promise.all(FEE_NAMES.map((n) => readFee(n)));
    return { readable: true, platformFeeBP: Number(p), evaluatorFeeBP: Number(e) };
  } catch (err) {
    return { readable: false, platformFeeBP: null, evaluatorFeeBP: null, reason: String(err?.message ?? err) };
  }
}

/** Did the fees change since the last READABLE observation? An unreadable read is never a change. */
export function feeChange(prev, now) {
  if (!now?.readable) return { changed: false, unreadable: true };
  const nonZero = now.platformFeeBP > 0 || now.evaluatorFeeBP > 0;
  if (!prev?.readable) return { changed: false, first: true, nonZero };
  const changed = prev.platformFeeBP !== now.platformFeeBP || prev.evaluatorFeeBP !== now.evaluatorFeeBP;
  return { changed, nonZero, from: { platformFeeBP: prev.platformFeeBP, evaluatorFeeBP: prev.evaluatorFeeBP },
    to: { platformFeeBP: now.platformFeeBP, evaluatorFeeBP: now.evaluatorFeeBP } };
}

/**
 * The real chain + Circle dependencies. The ONLY write is claimRefund(uint256) from `walletAddress` — a
 * Circle dev-controlled wallet (gas sponsored by Gas Station). ⚠️ NOT retried: a retried contract execution
 * is a second transaction (same rule as _ubwithdraw.mjs).
 */
export async function liveDeps({ walletAddress = null } = {}) {
  const { publicClient } = await import("./_predict.mjs");
  const pc = publicClient();
  const deps = {
    readJob: (jobId) => pc.readContract({ address: ESCROW_ADDRESS, abi: GET_JOB_ABI, functionName: "getJob", args: [BigInt(jobId)] }),
    readFee: (name) => pc.readContract({ address: ESCROW_ADDRESS, functionName: name,
      abi: [{ name, type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] }),
    readReceiptLogs: async (txHash) => (await pc.getTransactionReceipt({ hash: txHash })).logs,
    nowSec: BigInt(Math.floor(Date.now() / 1000)),
  };
  if (walletAddress) {
    const { circle, waitForTx } = await import("./_circle.mjs");
    const { ARC } = await import("./_arc.mjs");
    const client = circle();
    deps.submitClaim = async (jobId) => {
      const tx = await client.createContractExecutionTransaction({
        walletAddress, blockchain: ARC.blockchain, contractAddress: ESCROW_ADDRESS,
        abiFunctionSignature: "claimRefund(uint256)", abiParameters: [String(jobId)],
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      });
      return waitForTx(client, tx.data?.id);
    };
  }
  return deps;
}

/** Every job id in our own records (job-runs + job-deliverables). Never a scan of the contract. */
export async function ourJobIds({ getStore }) {
  const ids = new Set();
  for (const name of ["job-runs", "job-deliverables"]) {
    const s = getStore(name);
    for await (const page of s.list({ paginate: true })) {
      for (const b of page.blobs) {
        if (name === "job-deliverables" && /^\d+$/.test(b.key)) { ids.add(b.key); continue; }
        const v = await s.get(b.key, { type: "json" }).catch(() => null);
        if (v?.jobId && /^\d+$/.test(String(v.jobId))) ids.add(String(v.jobId));
      }
    }
  }
  return [...ids];
}
