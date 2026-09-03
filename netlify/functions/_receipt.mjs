import { pad, getAddress } from "viem";
import { BRIDGE_DESTINATIONS } from "./_bridge.mjs";

// RECEIPT VERIFICATION PLANE — pure reads. Moves no money, writes nothing, holds no
// secret. Its single job: decide whether a claimed destination mint ACTUALLY landed
// on the destination chain, by reading that chain ourselves.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────
// bridgeMintStatus() asks Circle's IRIS whether the relayer minted. That is an
// ATTESTATION BY AN API, not an on-chain read. For a research brief that is fine. For
// a TRUST ARTIFACT — a durable record asserting "this research caused this on-chain
// action" — it is not: a bug or a compromise in the attestation layer would let us
// publish a mint that never happened. So `minted` requires TWO independent
// confirmations:
//     1. IRIS says forwardState CONFIRMED/COMPLETE with a non-empty forwardTxHash
//     2. THIS module reads the destination chain and finds that exact tx, succeeded,
//        on the expected chainId, moving tokens TO the expected recipient
// If (1) and (2) disagree we write `mint_unverified` and STOP. That state is a loud
// "a human must look at this" — it is NEVER auto-retried into `minted`. Either our
// reading is wrong or the attestation is, and both deserve a person.
//
// A client NEVER supplies a hash to this module. The only mintTxHash it will ever see
// comes from IRIS, keyed by a burnHash the server itself captured.

// ERC-20 Transfer(address indexed from, address indexed to, uint256 value)
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Destination RPC + expected chainId + PINNED USDC address.
//
// The chainId pin matters: without it, a hash from a DIFFERENT chain that happens to
// exist would "verify". The usdc pin matters more: without it we could only assert
// "a token transfer to the recipient", and any worthless token would satisfy it.
//
// PROVENANCE — each address is DOUBLY sourced, never from a single observation:
//   1. Circle's canonical testnet contract list
//      (developers.circle.com/stablecoins/usdc-contract-addresses)
//   2. Cross-checked ON-CHAIN 2026-07-10 against each chain itself: eth_chainId matches,
//      eth_getCode is non-empty, symbol() == "USDC", decimals() == 6. All 8/8 confirmed.
// A doc page is a claim; the chain is the fact. Both had to agree before pinning.
// (Base independently corroborated by the real UB-spend mint, which emitted from
//  0x036CbD…dcF7e — see scripts/verify-receipt-adversarial.mjs CONTROL.)
/**
 * ⭐⭐ TWO ENDPOINTS PER CHAIN — A FALLBACK, DELIBERATELY NOT A QUORUM.
 *
 * 🚨 WHY (2026-08-15): every entry here carried ONE `rpc`, so each chain was a single point of
 * failure for VERIFICATION. When `rpc-amoy.polygon.technology` was decommissioned, mint verification
 * on Polygon failed 100% of the time for twelve days and the receipt simply accumulated as an
 * "unconfirmed bridge". ⭐ Swapping that one URL fixed the instance and left the architecture
 * unchanged: the next dead endpoint reproduces the same silence on whichever chain it lands on, and
 * the only reason this one surfaced at all is that someone went looking at an unrelated record.
 *
 * ⚠️ FALLBACK, NOT QUORUM, AND THE DISTINCTION IS LOAD-BEARING. `shared/onchain-analyze/quorum.mjs`
 * requires ≥2 endpoints to AGREE and refuses otherwise — correct there, because its threat model is
 * PROVIDER INTEGRITY. Here the question is availability of a read whose integrity is ALREADY pinned
 * three ways: the chainId must match, the USDC contract address is pinned, and the Transfer log must
 * pay the recorded recipient. Requiring agreement would convert a second endpoint being down into a
 * REFUSAL — turning an availability improvement into a new way to fail, which is exactly the
 * BLOCK-rate objection quorum.mjs itself raises against putting quorum on the deposit path.
 *
 * ⚠️ INDEPENDENCE IS ASSERTED, NOT PROVEN. Each pair uses two different providers (publicnode /
 * official / dRPC / 1rpc), and dRPC is an aggregator that may route anywhere. Two mirrors of one
 * node agree perfectly and are worth nothing. `gate:rpc` verifies each endpoint answers for the
 * right chain; it cannot verify they are independent operators.
 */
export const DESTINATION_CHAINS = {
  ethereum:  { rpcs: ["https://ethereum-sepolia-rpc.publicnode.com", "https://1rpc.io/sepolia"],                          chainId: 11155111, usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
  // 🚨 SECOND ONE TO BITE, AND THE FAILING ENDPOINT WAS THE *PRIMARY*. `sepolia.base.org` — the
  // official Base endpoint — degraded on three consecutive deploys (2026-08-19), each time HTTP 503
  // with `-32011 no backend is available`, measured 0/5 while the publicnode secondary was 5/5. So
  // "base 1/2 usable" was the FALLBACK carrying the chain alone, which is exactly the
  // single-surviving-endpoint state that produced the twelve-day Polygon rpc_error above.
  // ⭐ base is the most-used bridge destination in the receipts, so it is the worst chain to verify
  // mints against without redundancy.
  // ⚠️ REPLACEMENT VERIFIED AGAINST THE KNOWN-GOOD ENDPOINT, not merely pinged: same chainId
  // (0x14a34), byte-identical USDC bytecode (sha 2842683d1ea26f4d, 3598 chars), block heights in
  // sync (Δ0), and 12/12 stability. "A working RPC for the WRONG chain is worse than a dead one" —
  // answering is not agreeing, so agreement is what was checked.
  // ⚠️ Rejected candidates, measured the same way: drpc 3/5 (flaky), blockpi returned HTML,
  // blastapi returned no chainId. sepolia.base.org is dropped rather than demoted — a persistently
  // dead endpoint in the list re-creates the permanent-warning noise that makes real warnings ignorable.
  base:      { rpcs: ["https://base-sepolia-rpc.publicnode.com", "https://base-sepolia.gateway.tenderly.co"], chainId: 84532,    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  arbitrum:  { rpcs: ["https://sepolia-rollup.arbitrum.io/rpc", "https://arbitrum-sepolia-rpc.publicnode.com"],           chainId: 421614,   usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" },
  optimism:  { rpcs: ["https://sepolia.optimism.io", "https://optimism-sepolia-rpc.publicnode.com"],                      chainId: 11155420, usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7" },
  avalanche: { rpcs: ["https://api.avax-test.network/ext/bc/C/rpc", "https://avalanche-fuji-c-chain-rpc.publicnode.com"], chainId: 43113,    usdc: "0x5425890298aed601595a70AB815c96711a31Bc65" },
  // 🚨 THE ONE THAT BIT. Primary was `rpc-amoy.polygon.technology`, which has NO DNS RECORD.
  polygon:   { rpcs: ["https://polygon-amoy-bor-rpc.publicnode.com", "https://polygon-amoy.drpc.org"],                    chainId: 80002,    usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582" },
  unichain:  { rpcs: ["https://sepolia.unichain.org", "https://unichain-sepolia-rpc.publicnode.com"],                     chainId: 1301,     usdc: "0x31d0220469e10c4E71834a79b1f276d740d3768F" },
  linea:     { rpcs: ["https://rpc.sepolia.linea.build", "https://linea-sepolia-rpc.publicnode.com"],                     chainId: 59141,    usdc: "0xFEce4462D57bD51A6A552365A011b95f0E16d9B7" },
};


/**
 * ⭐ IS THIS ENDPOINT BROKEN, OR MERELY UNHAPPY? — the discriminator that was missing.
 *
 * `fetch` reports a dead DNS name and a timed-out node as the same opaque "fetch failed"; the real
 * cause hides in `e.cause.code`. Splitting them decides WHO ACTS: `unreachable` is a config fault we
 * own and can fix in one line, `transient` is someone else's node having a bad minute.
 *
 * ⚠️ UNKNOWN CLASSIFIES AS `transient`, deliberately. Calling something permanent is a claim that a
 * human must go change configuration; the conservative default is the one that does not send people
 * chasing a fault that may not exist. Permanence has to be EARNED by a recognised signal.
 */
export function classifyRpcFailure(e) {
  const code = e?.cause?.code || e?.code || "";
  const msg = String(e?.message || "");
  const permanent = ["ENOTFOUND", "EAI_AGAIN", "ERR_TLS_CERT_ALTNAME_INVALID", "ECONNREFUSED", "ERR_INVALID_URL"];
  const isUnreachable = permanent.includes(code) || /could not resolve|getaddrinfo|ENOTFOUND/i.test(msg);
  return {
    failureKind: isUnreachable ? "unreachable" : "transient",
    detail: code ? `${msg} (${code})` : msg,
  };
}

/**
 * ⭐⭐ READ A CHAIN, TRYING EACH ENDPOINT IN TURN — the fix for the single point of failure.
 *
 * Returns `{ result, rpc, attempts }` from the FIRST endpoint that answers, so callers can record
 * WHICH endpoint served them. Throws only when every endpoint has failed, carrying the per-endpoint
 * reasons — because "all of them failed" is a materially different claim from "it failed", and the
 * twelve-day incident is what a system that could not tell them apart looks like.
 *
 * ⚠️ A CHAIN-ID MISMATCH IS NOT RETRIED ONTO THE NEXT ENDPOINT. An endpoint answering for the wrong
 * chain is a CONFIGURATION fault, not an availability one; silently falling through to a sibling
 * would hide exactly the misconfiguration the chainId pin exists to catch, and `gate:rpc` would be
 * the only thing left that could see it.
 */
export async function rpcFallback(chain, method, params, { absenceNeedsCorroboration = false } = {}) {
  const endpoints = chain.rpcs;
  const failures = [];
  const absent = [];   // endpoints that ANSWERED, and answered "there is nothing here"
  for (const url of endpoints) {
    try {
      // The chain guard runs against the endpoint that is about to answer, never once for the set:
      // two endpoints are two chances to be pointed at the wrong chain.
      const idHex = await rpc(url, "eth_chainId", []);
      if (Number(BigInt(idHex)) !== chain.chainId) {
        const e = new Error(`endpoint reports chain ${Number(BigInt(idHex))}, expected ${chain.chainId}`);
        e.chainMismatch = true;
        e.saw = Number(BigInt(idHex));
        throw e;
      }
      const result = await rpc(url, method, params);
      // ═══ 🚨 AN ABSENCE IS NOT AN ANSWER, IT IS THE LACK OF ONE ══════════════════
      // This used to return whatever the first endpoint said, and `null` counted as saying
      // something. So ONE endpoint that had pruned a transaction could conclude "not found" while a
      // sibling still held the receipt — walking straight past the fallback added after the Polygon
      // decommission, because that fallback only ever advanced on a THROWN error.
      //
      // ⛔ MEASURED 2026-09-02, both mirrors, one hash:
      //     base-sepolia-rpc.publicnode.com   → result: null
      //     base-sepolia.gateway.tenderly.co  → status: 0x1   (the receipt exists)
      //   publicnode serves 2026-09-01/02 and returns null for 2026-07-31: a RETENTION WINDOW, not
      //   an outage. Nothing here distinguished "pruned" from "never happened".
      //
      // ⭐ THE INVARIANT — an absence may not conclude while an endpoint has not been asked.
      if (absenceNeedsCorroboration && (result === null || result === undefined)) {
        absent.push(url);
        continue;
      }
      return { result, rpc: url, attempts: failures.length + absent.length + 1, absentFrom: absent };
    } catch (e) {
      if (e?.chainMismatch) throw e; // configuration fault — see above
      failures.push({ rpc: url, ...classifyRpcFailure(e) });
    }
  }
  // ⭐⭐ THREE OUTCOMES, NEVER COLLAPSED INTO TWO:
  //   found      — an endpoint returned data (returned above)
  //   not-found  — at least one endpoint ANSWERED, and every answer was absent (here)
  //   rpc_error  — nothing answered at all (the throw below)
  // Collapsing the middle into `found` would fabricate a receipt; collapsing it into `rpc_error`
  // would throw away the one outcome a caller can actually act on. Both directions are wrong.
  if (absent.length > 0) {
    return {
      result: null,
      rpc: absent[absent.length - 1],
      attempts: failures.length + absent.length,
      absentFrom: absent,
      // ⚠️ NOT the same claim as "every endpoint agrees". If one FAILED we never heard from it —
      // the caller is told which, rather than left to read silence as unanimity.
      //
      // 🚨 AND IT REQUIRES TWO ANSWERS, NOT MERELY ZERO FAILURES. This was `failures.length === 0`,
      // which is trivially true on a SINGLE-ENDPOINT chain: the one endpoint answers "absent",
      // nothing fails, and the result declares itself CORROBORATED BY NOBODY. Every chain in
      // DESTINATION_CHAINS has two endpoints so no caller here was ever misled — but `ARC.rpc` is
      // one endpoint, and the first caller to point this helper at Arc would have been handed a
      // corroboration that cannot exist. Corroboration means someone else was asked and agreed;
      // with one endpoint there is nobody else to ask, so the honest answer is `false`.
      // ⚠️ Unchanged for every two-endpoint case: both absent → true, one absent one failed → false.
      corroborated: failures.length === 0 && absent.length >= 2,
      unheardFrom: failures.map((f) => f.rpc),
    };
  }
  const err = new Error(
    `all ${endpoints.length} endpoint(s) failed: ` + failures.map((f) => `${f.rpc} [${f.failureKind}] ${f.detail}`).join(" | ")
  );
  err.allFailed = failures;
  // ⭐ The AGGREGATE kind: only `unreachable` if EVERY endpoint was unreachable. One transient
  // failure alongside a dead host must not be reported as a permanent, ours-to-fix fault.
  err.aggregateKind = failures.every((f) => f.failureKind === "unreachable") ? "unreachable" : "transient";
  throw err;
}

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`RPC ${method} HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message || "error"}`);
  return j.result;
}

// Read the destination chain and decide whether `mintTxHash` really is a successful
// token transfer to `recipient` on that chain.
//
// Returns { verified: true, chainId, blockNumber, observedUsdc } — or
//         { verified: false, reason } where reason is one of:
//   unsupported_destination | bad_hash | rpc_error | chain_mismatch |
//   receipt_not_found | tx_reverted | no_transfer_to_recipient
//
// FAIL CLOSED: any error, any ambiguity → verified:false. We never guess a receipt
// into existence. A false `verified:true` is the single worst outcome this whole
// design exists to prevent; a false `verified:false` merely asks a human to look.
export async function verifyMintOnChain({ destinationKey, mintTxHash, recipient }) {
  const chain = DESTINATION_CHAINS[destinationKey];
  if (!chain || !BRIDGE_DESTINATIONS[destinationKey]) {
    return { verified: false, reason: "unsupported_destination" };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(mintTxHash || "")) return { verified: false, reason: "bad_hash" };
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient || "")) return { verified: false, reason: "bad_recipient" };

  // 1. The RPC must be the chain we think it is. Without this pin, a tx hash that
  //    exists on some OTHER chain would sail through.
  let receipt, servedBy = null;
  try {
    // ⛔ A RECEIPT LOOKUP IS EXACTLY THE CASE WHERE `null` MUST NOT CONCLUDE. One mirror having
      // pruned the block is indistinguishable from the transaction never existing — and the second
      // reading is the one that strands a user's completed bridge at "mint_unconfirmed".
      const got = await rpcFallback(chain, "eth_getTransactionReceipt", [mintTxHash],
        { absenceNeedsCorroboration: true });
    receipt = got.result;
    servedBy = got.rpc;
  } catch (e) {
    if (e?.chainMismatch) return { verified: false, reason: "chain_mismatch", saw: e.saw };
    // ⭐⭐ A DEAD ENDPOINT AND A SLOW ONE ARE NOT THE SAME PROBLEM, AND FOR TWELVE DAYS THEY
    // PRODUCED THE SAME WORD. `rpc_error` covered "this host does not exist" — a one-line config
    // fault that will NEVER fix itself — and "the node timed out", which usually will. The first
    // is ours and permanent; the second is theirs and transient. Filing one as the other is what
    // let a decommissioned URL sit in production unnoticed.
    // ⚠️ `reason` stays `rpc_error`: it is part of this function's documented closed set and other
    // code branches on it. The DISCRIMINATOR is added alongside rather than smuggled into it.
    // ⚠️ EVERY endpoint failed. The aggregate kind is what decides who owns it: `unreachable`
    // across the whole set is a configuration fault on our side, and one that `gate:rpc` should
    // have caught before the deploy.
    return {
      verified: false, reason: "rpc_error",
      failureKind: e?.aggregateKind ?? classifyRpcFailure(e).failureKind,
      detail: e?.message ?? String(e),
      rpc: (chain.rpcs || []).join(", "),
      endpointsTried: (e?.allFailed || []).length || (chain.rpcs || []).length,
    };
  }

  // 2. The tx must exist and have SUCCEEDED. A reverted mint is not a mint.
  if (!receipt) return { verified: false, reason: "receipt_not_found" };
  if (receipt.status !== "0x1") return { verified: false, reason: "tx_reverted", status: receipt.status };

  // 3. It must move USDC — the PINNED USDC contract for this chain, not merely "a
  //    token" — TO our recipient. Existence + success would accept any successful tx;
  //    an unpinned Transfer would accept any worthless token. Both are asserted here,
  //    so `verified:true` means: a USDC transfer to the recipient occurred in this tx,
  //    on the expected chain, in a transaction that succeeded.
  const want = pad(getAddress(recipient)).toLowerCase();
  const usdc = chain.usdc.toLowerCase();
  const hit = (receipt.logs || []).find(
    (l) =>
      (l.address || "").toLowerCase() === usdc &&
      (l.topics?.[0] || "").toLowerCase() === TRANSFER_TOPIC &&
      (l.topics?.[2] || "").toLowerCase() === want
  );
  if (!hit) {
    // Distinguish "wrong token" from "no transfer at all" — a Transfer to us from a
    // NON-USDC contract is a much louder signal than silence, and a human should see it.
    const anyToUs = (receipt.logs || []).some(
      (l) => (l.topics?.[0] || "").toLowerCase() === TRANSFER_TOPIC && (l.topics?.[2] || "").toLowerCase() === want
    );
    return { verified: false, reason: anyToUs ? "transfer_was_not_usdc" : "no_usdc_transfer_to_recipient" };
  }

  return {
    verified: true,
    chainId: chain.chainId,
    blockNumber: Number(BigInt(receipt.blockNumber)),
    usdcAddress: hit.address, // == the pinned address, by construction
    usdcAmount: Number(BigInt(hit.data)) / 1e6, // USDC is 6-dp (decimals() confirmed on-chain)
  };
}
