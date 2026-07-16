// payto-vs-token — what does an x402 seller actually ask you to SIGN?
//
// THE MAHSHAR TELL. Two 402 challenges can look identical: same `scheme: "exact"`, same EIP-712 struct
// `TransferWithAuthorization(from,to,value,validAfter,validBefore,nonce)`, same header dance. The only
// field that distinguishes "funds leave your wallet atomically for this one purchase" from "you must
// pre-fund a shared pool and sign against a custodian's contract" is `extra.verifyingContract`:
//   vanilla x402  → the domain IS the USDC token (EIP-3009). extra carries name/version, and the
//                   verifyingContract is IMPLICIT — absent means the asset itself.
//   gateway/other → extra.verifyingContract names a DIFFERENT contract (Mahshar: GatewayWalletBatched
//                   0x0077777d…, not the token 0x3600…).
// Same struct, different domain separator ⇒ signatures are NOT interchangeable, and a buyer that
// assumes vanilla gets a silent verification failure rather than a loud error.
//
// ⚠️ IT ALSO CHECKS THE DOMAIN NAME AGAINST THE TOKEN ITSELF. `extra.name` is the seller's claim about
// the token's EIP-712 domain. We read `name()` off the asset and compare. Arc USDC is "USDC"; Base
// mainnet USDC is "USD Coin" — a seller advertising the wrong one produces signatures that fail
// verification silently. That mismatch is invisible in the challenge and obvious against the chain.
//
// ⚠️ A CHALLENGE IS AN ADVERTISEMENT, NOT A SETTLEMENT. Everything here is what the seller SAYS it
// will do. Proving what it actually does requires paying it, which this engine will never do. That
// limit is in `coverage.notCheckedFor` and it is the most important line in the file.

import { observed, failed, normalizeAddress } from "../fact.mjs";
import { CHAINS } from "../chains.mjs";
import { chainClient } from "../client.mjs";
import { curlFor } from "../rpc.mjs";

export const id = "payto-vs-token";
export const describe = "decode a live 402 challenge: is the EIP-712 domain the token (vanilla EIP-3009) or some other contract?";
export const usage = "--url <endpoint> [--method POST] [--body '{}']";

const COVERAGE = {
  checkedVia: [
    "live unpaid 402 challenge (no payment made, no signature produced)",
    "extra.verifyingContract vs accepts[].asset (the domain tell)",
    "extra.name vs the asset's on-chain name() (EIP-712 domain-name match)",
    "eth_getCode on payTo (contract vs EOA)",
  ],
  notCheckedFor: [
    {
      id: "advertised-vs-actual-settlement",
      why: "THE BIG ONE. This reads what the seller ADVERTISES in its 402. A seller can advertise a token domain and settle something else entirely; proving actual behaviour requires signing and paying, which this engine never does. A clean result here means 'the advertisement is coherent', NOT 'the seller is honest'.",
    },
    {
      id: "operator-hop",
      why: "payTo being an EOA does NOT prove an operator hop (Mahshar's real disqualifier: buyer pays an operator who then pays the seller). Proving the hop needs settlement history, not the challenge. A clean payTo here is not evidence of non-custody.",
    },
    {
      id: "unadvertised-accepts-entries",
      why: "Auth-gated sellers (SIWX, invite codes) return accepts:[] until you authenticate — AgentCash does exactly this. No terms advertised is reported as NO_TERMS_ADVERTISED, which is INDETERMINATE, not clean.",
    },
    {
      id: "multi-entry-risk",
      why: "accepts[] may offer several chains at once (Mahshar co-offers Base MAINNET beside Arc testnet, same amount). Each entry is classified separately; a buyer picking the wrong entry can spend real money. A single clean entry says nothing about the others.",
    },
    {
      id: "unknown-chains",
      why: "Entries on chains absent from chains.mjs (e.g. Solana, Polygon/JPYC) cannot be cross-checked on-chain: the domain-name and payTo reads are skipped and the entry is marked chainKnown:false.",
    },
  ],
};

const byChainId = new Map(Object.entries(CHAINS).map(([name, c]) => [c.id, { name, ...c }]));
const b64ToJson = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
const decodeString = (hex) => {
  // ABI-decoded string return: offset(32) | len(32) | bytes
  const b = Buffer.from(hex.slice(2), "hex");
  if (b.length < 64) return null;
  const len = Number(BigInt("0x" + b.subarray(32, 64).toString("hex")));
  return b.subarray(64, 64 + len).toString("utf8");
};

export async function run({ url, method = "POST", body = "{}" }) {
  const input = { url, method, body };
  if (!url || typeof url !== "string") return failed({ check: id, input, error: "--url is required" });

  let res, text, challenge, source;
  try {
    res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "User-Agent": "tikpema-dd/0.1" },
      ...(method === "POST" ? { body } : {}),
      signal: AbortSignal.timeout(25000),
    });
    text = await res.text();
  } catch (e) {
    return failed({ check: id, input, error: `fetch failed: ${e.message}` });
  }

  // The challenge may arrive as a base64 PAYMENT-REQUIRED header or as a JSON body. Try both.
  const hdr = res.headers.get("payment-required") || res.headers.get("x-payment-required");
  try {
    if (hdr) {
      challenge = b64ToJson(hdr);
      source = "payment-required header (base64)";
    } else {
      challenge = JSON.parse(text);
      source = "response body (json)";
    }
  } catch (e) {
    return failed({ check: id, input, error: `could not decode a 402 challenge: ${e.message}`, evidence: { httpStatus: res.status, raw: text.slice(0, 400) } });
  }

  const accepts = Array.isArray(challenge.accepts) ? challenge.accepts : [];
  const curl = `curl -s -D- -X ${method} ${url} -H 'Content-Type: application/json' -d '${body}'`;

  if (res.status !== 402) {
    return failed({ check: id, input, error: `expected HTTP 402, got ${res.status}`, evidence: { httpStatus: res.status, raw: text.slice(0, 300) }, query: { reproduce: curl } });
  }

  if (accepts.length === 0) {
    // Auth-gated (AgentCash's SIWX). NOT clean — we were never shown the terms.
    return observed({
      check: id,
      input,
      result: {
        httpStatus: 402,
        x402Version: challenge.x402Version ?? null,
        entries: [],
        classification: "NO_TERMS_ADVERTISED",
        note: "402 returned accepts:[] — payment terms are gated (auth/SIWX/invite) and were NOT observed. This is INDETERMINATE about the settlement model, not clean.",
        coverage: COVERAGE,
      },
      evidence: { httpStatus: 402, source, challenge },
      query: { reproduce: curl },
    });
  }

  const entries = [];
  for (const a of accepts) {
    const network = a.network ?? null;
    const chainId = typeof network === "string" && network.startsWith("eip155:") ? Number(network.split(":")[1]) : null;
    const chain = chainId != null ? byChainId.get(chainId) : null;
    const asset = normalizeAddress(a.asset) ?? (a.asset ?? null);
    const extraVC = normalizeAddress(a.extra?.verifyingContract);

    // ── THE TELL. Absent verifyingContract means the domain IS the asset (vanilla x402). ──
    const effectiveVerifyingContract = extraVC ?? (typeof asset === "string" && asset.startsWith("0x") ? asset : null);
    const domainIsToken =
      effectiveVerifyingContract && typeof asset === "string" && asset.startsWith("0x")
        ? effectiveVerifyingContract.toLowerCase() === asset.toLowerCase()
        : null;

    const entry = {
      network,
      chainId,
      chainKnown: Boolean(chain),
      scheme: a.scheme ?? null,
      amount: a.amount ?? a.maxAmountRequired ?? null,
      asset,
      payTo: a.payTo ?? null,
      extraName: a.extra?.name ?? null,
      extraVersion: a.extra?.version ?? null,
      declaredVerifyingContract: extraVC,
      effectiveVerifyingContract,
      verifyingContractIsImplicit: extraVC === null,
      classification:
        domainIsToken === null
          ? "INDETERMINATE_UNPARSEABLE_TERMS"
          : domainIsToken
            ? "SIGNS_AGAINST_TOKEN_DOMAIN"
            : "SIGNS_AGAINST_NON_TOKEN_CONTRACT",
      onChain: null,
    };

    // Cross-check against the chain itself, where we know the chain.
    if (chain && asset?.startsWith?.("0x")) {
      try {
        const c = chainClient(chain.name);
        await c.assert();
        const blk = await c.pin();
        const nameCall = await c.call({ method: "eth_call", params: [{ to: asset, data: "0x06fdde03" }, blk.tag] });
        const tokenName = nameCall.result && nameCall.result !== "0x" ? decodeString(nameCall.result) : null;
        const payToCode = entry.payTo?.startsWith?.("0x")
          ? await c.call({ method: "eth_getCode", params: [entry.payTo.toLowerCase(), blk.tag] })
          : null;
        entry.onChain = {
          blockNumber: blk.number,
          tokenName,
          // The AgentCash trap, deterministically: Arc USDC is "USDC", Base USDC is "USD Coin".
          // A seller advertising the wrong domain name yields signatures that fail SILENTLY.
          domainNameMatchesToken: entry.extraName == null ? null : tokenName === entry.extraName,
          payToHasCode: payToCode ? payToCode.result !== "0x" : null,
          payToType: payToCode ? (payToCode.result === "0x" ? "eoa" : "contract") : null,
          reproduce: {
            tokenName: curlFor(chain.rpc, { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: asset, data: "0x06fdde03" }, blk.tag] }),
            payToCode: entry.payTo ? curlFor(chain.rpc, { jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [entry.payTo.toLowerCase(), blk.tag] }) : null,
          },
        };
      } catch (e) {
        // Chain cross-check failed — say so; do not silently present the entry as fully checked.
        entry.onChain = { error: String(e.message), note: "on-chain cross-check unavailable; the decode above still stands" };
      }
    }
    entries.push(entry);
  }

  return observed({
    check: id,
    input,
    result: {
      httpStatus: 402,
      x402Version: challenge.x402Version ?? null,
      entryCount: entries.length,
      classifications: entries.reduce((m, e) => ((m[e.classification] = (m[e.classification] ?? 0) + 1), m), {}),
      entries,
      coverage: COVERAGE,
    },
    evidence: { httpStatus: 402, source, challenge },
    query: { reproduce: curl },
  });
}
