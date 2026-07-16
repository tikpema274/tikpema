// rpc.mjs — raw JSON-RPC, on purpose.
//
// ⚠️ WHY NOT viem, WHICH THIS REPO ALREADY DEPENDS ON. The whole product here is `query`: the exact
// request a human can paste into a terminal to reproduce the fact. If viem sends the request, the
// `query` field becomes my RECONSTRUCTION of what viem probably sent — provenance by assertion,
// which is precisely what this tool exists to refuse. So the transport is `fetch` and the request
// object we build IS the request we send IS the request we print. No gap to be wrong in.
// (viem still earns its place later: checks 3/4 want its ABI decoders, where the evidence is the
// raw verified ABI and viem is doing maths on it rather than standing between us and the wire.)
//
// ⚠️ THE BLOCK IS PINNED. "latest" is not reproducible — re-run tomorrow and you query a different
// chain state, so the evidence rots. Every read resolves a concrete block number first and queries
// AT that block, which is why a fact from this engine stays checkable months later. That property
// is the difference between a report and a claim.

/** Node's fetch, with a hard timeout — a hung RPC must become an error, never a silent "absent". */
async function post(endpoint, body, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "tikpema-dd/0.1" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`non-JSON response (HTTP ${res.status}): ${text.slice(0, 120)}`);
    }
    return { httpStatus: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

/** A copy-pasteable curl for the exact request — the provenance a reader actually uses. */
export function curlFor(endpoint, body) {
  return `curl -s -X POST ${endpoint} -H 'Content-Type: application/json' -d '${JSON.stringify(body)}'`;
}

/**
 * ⚠️ RATE LIMITS ARE NOISE, NOT DATA — and this engine must not confuse them with findings.
 * Arc's public RPC answers "request limit reached" at a handful of calls per second; the first real
 * run of check 2 had 4 of 6 addresses come back INDETERMINATE for that reason alone. The three-state
 * rule meant it degraded honestly instead of reporting a false "empty" — but an audit that cannot
 * read the chain produces no findings either. So: retry the transient class, with backoff.
 * A retried success is still a first-class observation. Exhausted retries stay an ERROR, never a fact.
 */
const TRANSIENT = /request limit|rate limit|too many requests|429|timeout|ETIMEDOUT|ECONNRESET|fetch failed|502|503|504/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One JSON-RPC call. Returns { result, query, evidence }.
 * THROWS on transport failure or a JSON-RPC `error` — callers turn that into a `failed()` fact.
 * It must never return a value that could be mistaken for an observation.
 */
export async function rpcCall({ endpoint, method, params, retries = 4 }) {
  const body = { jsonrpc: "2.0", id: 1, method, params };
  const query = { endpoint, method, params, reproduce: curlFor(endpoint, body) };
  let last;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { httpStatus, json } = await post(endpoint, body);
      if (json.error) throw new Error(`${method}: ${json.error.message}`);
      if (json.result === undefined) throw new Error(`${method}: no result (HTTP ${httpStatus})`);
      return {
        result: json.result,
        query,
        evidence: { httpStatus, response: json, ...(attempt ? { retriedAttempts: attempt } : {}) },
      };
    } catch (e) {
      last = e;
      // Only the transient class is retried. A genuine JSON-RPC error ("execution reverted") is a
      // real answer about the chain and must surface immediately, not be papered over by a retry.
      if (!TRANSIENT.test(String(e.message)) || attempt === retries) break;
      await sleep(250 * 2 ** attempt + Math.floor(Math.random() * 100)); // 250/500/1000/2000ms + jitter
    }
  }
  throw Object.assign(new Error(String(last.message)), { query });
}

/**
 * ⚠️ Guard: prove the endpoint is the chain we think it is BEFORE reading state from it.
 * Without this, a stale or swapped RPC URL yields confident facts about the wrong chain — the exact
 * error class this engine is built to catch in other people's code.
 */
export async function assertChain(chain) {
  const { result } = await rpcCall({ endpoint: chain.rpc, method: "eth_chainId", params: [] });
  const observed = parseInt(result, 16);
  if (observed !== chain.id) {
    throw new Error(
      `chain mismatch: ${chain.rpc} reports chainId ${observed}, registry declares ${chain.id} for "${chain.name}"`
    );
  }
  return observed;
}

/** Pin a concrete block so the fact stays reproducible. */
export async function resolveBlock(chain, blockNumber) {
  if (blockNumber !== undefined && blockNumber !== null) {
    const n = typeof blockNumber === "string" ? parseInt(blockNumber, 10) : blockNumber;
    return { number: n, tag: "0x" + n.toString(16), pinnedBy: "caller" };
  }
  const { result } = await rpcCall({ endpoint: chain.rpc, method: "eth_blockNumber", params: [] });
  const n = parseInt(result, 16);
  return { number: n, tag: "0x" + n.toString(16), pinnedBy: "resolved-at-runtime" };
}
