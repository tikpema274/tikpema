import { parseAbiItem, parseUnits, formatUnits, getAddress, pad } from "viem";
import { CONTRACTS, USDC_DECIMALS, ARC } from "./_arc.mjs";
import { publicClient } from "./_predict.mjs";
import { withRetry } from "./_retry.mjs";

// Arc's public RPC answers a throttle with "request limit reached", which viem does NOT retry (it
// arrives as a JSON-RPC error body, not an HTTP 429 — see _retry.mjs). An UN-retried witness read
// therefore fast-fails to rpc-error on every throttled tick, so a LANDED swap is never confirmed
// (observed: DCA fill 495663 sat pending while its swap was on-chain). So the two chain reads below
// are wrapped in the SAME withRetry the deposit path uses. retries:3 (not the default 4) keeps the
// worst-case backoff (~1.75s + read time ≈ ~2.85s) comfortably inside dca-tick's 6s confirm timeout;
// the every-minute reconcile provides additional cross-tick retries beyond these.
const RETRY = { retries: 3 };

// _swap-confirm.mjs — THE SINGLE on-chain WITNESS for "did this swap actually land?".
//
// Shared by job-swap-receipt-background (the research→swap brick) and dca-tick (the autonomous
// scheduler). ONE copy of the confirmation logic on purpose: a money-gating decision copied into
// two files always drifts (the recurring duplicate-source-of-truth bug), and both callers must
// answer this question identically.
//
// TWO WITNESSES, HASH FIRST:
//   PATH 1 — HASH: if the SDK handed us a tx hash, ask the chain what happened to it.
//            status success → confirmed; reverted → failed. Unambiguous: it names OUR tx.
//   PATH 2 — TWO-LEGGED LOG-SCAN: when no usable hash exists (the Circle SCA submits its userOp
//            ASYNC and App Kit returns txHash:null by design — the 1098 quirk), identify OUR swap
//            by its ATOMIC SHAPE, never by an aggregate balance delta. A same-chain stable swap
//            emits, in ONE transaction:
//               • Transfer(tokenIn,  from = wallet, value == amountIn)   — the input leg
//               • Transfer(tokenOut, to   = wallet, value  >  0)         — the output leg
//            Only OUR swap has BOTH legs, atomically, in the same tx. An inbound transfer has no
//            input leg; the user selling tokenOut is the wrong direction; a different-sized swap
//            fails the exact-amountIn match. So concurrent balance movement in the window — the
//            user's own swap, another mandate's fill on the same wallet/pair, an inbound transfer
//            — can neither MASK a real fill nor FAKE one. This is exactly why we do NOT use
//            `balanceAfter > balanceBefore`: that aggregate is corruptible by anything touching
//            the wallet; the two-legged tx shape is not.
//
// AMBIGUITY FAILS CLOSED. If the window holds TWO txs of our exact shape (e.g. the user ran the
// identical swap by hand in the same seconds), we do NOT guess which is ours → confirmed:false,
// reason "ambiguous". The caller records unconfirmed + needsAttention. A false CONFIRM is the one
// outcome this whole design exists to prevent; a false unconfirmed merely asks a human to look.
//
// SINGLE-SHOT. This does not poll — it answers for the current chain head and returns. The caller
// owns the retry cadence: job-swap-receipt-background loops it to a 90s deadline; dca-tick calls it
// once per tick and lets the mandate's grace window span ticks. Reads only — moves no money.

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
// keccak256("Transfer(address,address,uint256)") — for parsing RAW receipt logs on the hash path.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const tokenAddr = (sym) => (String(sym).toUpperCase() === "EURC" ? CONTRACTS.EURC : CONTRACTS.USDC);
const explorerTx = (hash) => (hash ? `${ARC.explorer}/tx/${hash}` : null);

// The tokenOut delivered to the wallet inside a tx's RAW logs (hash path). Best-effort readout.
function amountOutFromLogs(logs, tokenOutAddr, wallet) {
  try {
    const want = pad(getAddress(wallet)).toLowerCase(); // 32-byte, left-padded indexed `to`
    const out = tokenOutAddr.toLowerCase();
    let sum = 0n;
    for (const l of logs || []) {
      if ((l.address || "").toLowerCase() !== out) continue;
      if ((l.topics?.[0] || "").toLowerCase() !== TRANSFER_TOPIC) continue;
      if ((l.topics?.[2] || "").toLowerCase() !== want) continue;
      sum += BigInt(l.data);
    }
    return sum > 0n ? Number(formatUnits(sum, USDC_DECIMALS)) : null;
  } catch {
    return null;
  }
}

// confirmSwapLanded — witness THIS fill on-chain, single-shot.
//   { walletAddress, tokenIn, tokenOut, amountIn, fromBlock, eventTxHash, scanWindowBlocks }
//     fromBlock  — BigInt lower bound of the log-scan window (the block BEFORE submit for a tight,
//                  unambiguous window; a generous lookback where no exact snapshot exists).
//     eventTxHash— the SDK's event hash if one arrived, else null (then PATH 2 is the only witness).
//     scanWindowBlocks — OPTIONAL upper bound: scan fromBlock..min(fromBlock+N, head) instead of
//                  ..latest. On Arc this is REQUIRED for a tight snapshot that can age past the
//                  10,000-block getLogs limit (a swap lands within seconds, so a small N loses
//                  nothing). OMIT it to keep the exact prior behaviour (toBlock:"latest") — the
//                  research->swap job-verifier omits it and is therefore unchanged.
// Returns:
//   { confirmed:true,  verifiedBy:"hash"|"logscan", txHash, tx, blockNumber, amountOut }
//   { confirmed:false, reason }  where reason ∈ reverted | not-found | ambiguous:… | rpc-error:…
export async function confirmSwapLanded({ walletAddress, tokenIn, tokenOut, amountIn, fromBlock, eventTxHash, scanWindowBlocks }) {
  const pc = publicClient();
  const wallet = getAddress(walletAddress);
  const inAddr = tokenAddr(tokenIn);
  const outAddr = tokenAddr(tokenOut);
  const amountInRaw = parseUnits(String(amountIn), USDC_DECIMALS);

  // ── PATH 1: HASH — the SDK gave us a hash; ask the chain what became of it. ──
  if (eventTxHash) {
    try {
      // A THROTTLE retries with backoff; a not-mined-yet receipt (TransactionReceiptNotFoundError,
      // not the transient class) is NOT retried — it throws straight through to the fall-through
      // below and PATH 2 witnesses by log-scan. A reverted/success receipt is a SUCCESSFUL read,
      // returned on the first attempt (never retried), so revert still surfaces immediately.
      const r = await withRetry(() => pc.getTransactionReceipt({ hash: eventTxHash }), { ...RETRY, label: "get swap receipt" });
      if (r?.status === "reverted") {
        return { confirmed: false, reason: "reverted", txHash: eventTxHash };
      }
      if (r?.status === "success") {
        return {
          confirmed: true,
          verifiedBy: "hash",
          txHash: eventTxHash,
          tx: explorerTx(eventTxHash),
          blockNumber: Number(r.blockNumber),
          amountOut: amountOutFromLogs(r.logs, outAddr, wallet),
        };
      }
    } catch {
      // Not mined yet, or a transient RPC hiccup — fall through to the log-scan witness.
    }
  }

  // ── PATH 2: TWO-LEGGED LOG-SCAN — identify our swap by its shape, not by a balance total. ──
  let inLegs, outLegs;
  try {
    // Bound the scan when a window is given (dca-tick): toBlock = min(fromBlock + N, head). REQUIRED
    // on Arc — eth_getLogs is capped at a 10,000-block range (-32614), so an unbounded
    // snapshot->latest scan HARD-FAILS once a fill ages past ~10k blocks, and a wide scan throttles
    // more. head is read FIRST because Arc REJECTS toBlock > head (the clamp is not optional).
    // Omitted (the job-verifier) -> toBlock:"latest", exactly as before.
    let toBlock = "latest";
    if (scanWindowBlocks != null) {
      const head = await withRetry(() => pc.getBlockNumber(), { ...RETRY, label: "read head" });
      const upper = fromBlock + BigInt(scanWindowBlocks);
      toBlock = upper < head ? upper : head;
    }
    // Wrap the parallel read as ONE retry unit: a throttle on either leg retries both (idempotent
    // reads). A SUCCESSFUL scan — empty, one match, or ambiguous — is returned unchanged and never
    // retried, so not-found/ambiguous/confirmed semantics are exactly as before; only a transient
    // read FAILURE now backs off instead of fast-failing to rpc-error.
    [inLegs, outLegs] = await withRetry(() => Promise.all([
      pc.getLogs({ address: inAddr, event: TRANSFER, args: { from: wallet }, fromBlock, toBlock }),
      pc.getLogs({ address: outAddr, event: TRANSFER, args: { to: wallet }, fromBlock, toBlock }),
    ]), { ...RETRY, label: "scan swap legs" });
  } catch (e) {
    // Cannot read the chain → cannot witness. Fail closed, and let the caller distinguish this
    // "couldn't look" from a real "did not land" (it must NOT consume the grace window).
    return { confirmed: false, reason: `rpc-error: ${e.message}` };
  }

  // Input legs of EXACTLY amountIn leaving the wallet. The swap fee comes out of the OUTPUT, so
  // the input leg is the full amountIn (verified on-chain: a 1.000000 USDC input leg for a 1-USDC
  // fill). Any other value is not this fill.
  const inTxs = new Set(inLegs.filter((l) => l.args.value === amountInRaw).map((l) => l.transactionHash));

  // A tx that ALSO delivered tokenOut to the wallet — the second leg. Dedupe by txHash and sum any
  // multiple out-legs to the wallet within the same tx (normally one).
  const matches = new Map();
  for (const l of outLegs) {
    if (!inTxs.has(l.transactionHash)) continue;
    const prev = matches.get(l.transactionHash);
    matches.set(l.transactionHash, {
      txHash: l.transactionHash,
      blockNumber: Number(l.blockNumber),
      amountOutRaw: (prev?.amountOutRaw ?? 0n) + l.args.value,
    });
  }

  const hits = [...matches.values()];
  if (hits.length === 1) {
    const h = hits[0];
    return {
      confirmed: true,
      verifiedBy: "logscan",
      txHash: h.txHash,
      tx: explorerTx(h.txHash),
      blockNumber: h.blockNumber,
      amountOut: Number(formatUnits(h.amountOutRaw, USDC_DECIMALS)),
    };
  }
  if (hits.length > 1) {
    // Two txs of our exact shape in the window — cannot attribute one to this fill. Fail closed.
    return { confirmed: false, reason: `ambiguous: ${hits.length} matching swaps in the confirm window` };
  }
  return { confirmed: false, reason: "not-found" };
}
