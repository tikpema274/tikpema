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
export const DESTINATION_CHAINS = {
  ethereum:  { rpc: "https://ethereum-sepolia-rpc.publicnode.com", chainId: 11155111, usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
  base:      { rpc: "https://sepolia.base.org",                    chainId: 84532,    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  arbitrum:  { rpc: "https://sepolia-rollup.arbitrum.io/rpc",      chainId: 421614,   usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" },
  optimism:  { rpc: "https://sepolia.optimism.io",                 chainId: 11155420, usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7" },
  avalanche: { rpc: "https://api.avax-test.network/ext/bc/C/rpc",  chainId: 43113,    usdc: "0x5425890298aed601595a70AB815c96711a31Bc65" },
  // 🚨 WAS `https://rpc-amoy.polygon.technology` — THE HOST HAS NO DNS RECORD AT ALL.
  // Measured 2026-08-15 with two independent resolvers: the local one returns NO RESOLUTION, and
  // Google's public DoH returns NOERROR with an SOA and **no A record**. `polygon.technology`
  // itself resolves fine, so the apex is alive and this subdomain is simply gone.
  // ⭐⭐ THAT IS WHY `0xccc02035…` FAILED VERIFICATION 100% OF THE TIME FOR TWELVE DAYS. It was never
  // flakiness or rate-limiting — those are intermittent. `fetch` could not resolve the name, threw,
  // and `verifyMintOnChain` caught it as `rpc_error` on every single one of ~1,730 attempts. A
  // permanent config fault was wearing the costume of a transient one.
  // ⚠️ publicnode is already this file's choice for ethereum-sepolia, so this is not a new
  // dependency. Verified live: chainId 80002, eth_getTransactionReceipt allowed (null for an
  // unknown hash rather than an error), synced at block 44,954,674, and the PINNED Amoy USDC
  // address below has 1798 bytes of code on it — which cross-checks the endpoint really is Amoy.
  polygon:   { rpc: "https://polygon-amoy-bor-rpc.publicnode.com", chainId: 80002,    usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582" },
  unichain:  { rpc: "https://sepolia.unichain.org",                chainId: 1301,     usdc: "0x31d0220469e10c4E71834a79b1f276d740d3768F" },
  linea:     { rpc: "https://rpc.sepolia.linea.build",             chainId: 59141,    usdc: "0xFEce4462D57bD51A6A552365A011b95f0E16d9B7" },
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
  let chainIdHex, receipt;
  try {
    chainIdHex = await rpc(chain.rpc, "eth_chainId", []);
    if (Number(BigInt(chainIdHex)) !== chain.chainId) {
      return { verified: false, reason: "chain_mismatch", saw: Number(BigInt(chainIdHex)) };
    }
    receipt = await rpc(chain.rpc, "eth_getTransactionReceipt", [mintTxHash]);
  } catch (e) {
    // ⭐⭐ A DEAD ENDPOINT AND A SLOW ONE ARE NOT THE SAME PROBLEM, AND FOR TWELVE DAYS THEY
    // PRODUCED THE SAME WORD. `rpc_error` covered "this host does not exist" — a one-line config
    // fault that will NEVER fix itself — and "the node timed out", which usually will. The first
    // is ours and permanent; the second is theirs and transient. Filing one as the other is what
    // let a decommissioned URL sit in production unnoticed.
    // ⚠️ `reason` stays `rpc_error`: it is part of this function's documented closed set and other
    // code branches on it. The DISCRIMINATOR is added alongside rather than smuggled into it.
    return { verified: false, reason: "rpc_error", ...classifyRpcFailure(e), rpc: chain.rpc };
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
