// _research.mjs — shared, reusable research engine.
//
// The web-search + pause-turn-resume loop, factored out so multiple endpoints
// can reuse it. The system prompt is a parameter rather than a module constant:
// callers pass the prompt that frames the task. Provides the resume loop, JSON
// extraction, and the { question, model, decision } return shape.
//
// SPENDING. The web-search path is read-only (Claude + web search, no funds
// move). The Exa path, however, can autonomously PURCHASE data mid-research
// (maybeBuyData → payX402): an on-chain x402 USDC spend, gated by the per-job
// budget in _budget.mjs. So this module can move money — under budget control —
// not just read.

import { exaSearch } from "./_exa.mjs";
import { canSpend, recordSpend, recordBlocked } from "./_budget.mjs";
import { AGENT } from "./_agents.mjs";
import { assertNotPaused } from "./_pause.mjs";
import { payX402, fetchX402Requirements } from "./_x402.mjs";
import { buildRpcBody, decodeRpc, fetchMarketData } from "./_cryptodata.mjs";
import { searchArxiv, arxivToFacts } from "./_arxiv.mjs";

// Current Anthropic web search server tool (GA — no beta header).
const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search", max_uses: 3 };

// Token budget for BRIEF-producing (synthesis) calls only. The old blanket
// max_tokens:1024 truncated rich briefs mid-JSON → extractJson → null → "missing
// decision or sources" refund (reproduced on the diffusion query, arXiv-independent).
// Comfortable headroom above the longest legitimate brief; only generated tokens are
// billed, so the cost of headroom is ~nil. The tiny classifier/filter calls keep the
// 1024 default (they emit small JSON).
const BRIEF_MAX_TOKENS = 8192;

// Anthropic runs its own server-side search loop; on hitting the built-in cap it
// returns stop_reason "pause_turn" with the work so far. We resume by re-sending
// the conversation. Cap the re-sends so a runaway search can't bill unbounded.
const MAX_CONTINUATIONS = 3;

// Pull the JSON decision out of the model's final text, tolerating stray prose
// or ```json fences by falling back to the first {...last } span.
export function extractJson(text) {
  const c = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(c); } catch {}
  const s = c.indexOf("{"), e = c.lastIndexOf("}");
  if (s !== -1 && e > s) { try { return JSON.parse(c.slice(s, e + 1)); } catch {} }
  return null;
}

export async function callAnthropic(apiKey, model, messages, systemPrompt, tools = [WEB_SEARCH_TOOL], maxTokens = 1024) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: systemPrompt, tools, messages }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Anthropic call failed");
  return data;
}

// ── Autonomous mid-research purchase loop (Phase 2a, Step 2a-3) ───────────────
// After the initial Exa retrieval, the agent decides whether ONE paid dataset
// would materially improve the brief. If so, the budget spine gates it; if
// allowed, we buy it from our own testnet stand-in seller via x402 and fold the
// facts into the grounding. Testnet only, our own seller. Graceful degradation:
// a decline, a budget block, or ANY purchase failure degrades to Exa-only
// grounding — a purchase problem must never fail the research job.

// Where the recorded spend is attributed in the audit trail.
const DATA_SELLER_SOURCE = "x402-quote (testnet stand-in)";

// Absolute per-buy hard ceiling (USDC). A seller's advertised price is refused if it
// exceeds this, IN ADDITION TO the percentage caps in _budget.mjs — so an external
// seller can't advertise a surprising price that still fits under the per-purchase
// allowance. Fail-safe: unset / garbled / <=0 → the hardcoded default (never disables
// the bound). Overridable via DATA_PURCHASE_USDC for a known pricier seller.
function dataBuyCeilingUsdc() {
  const n = Number(process.env.DATA_PURCHASE_USDC);
  return Number.isFinite(n) && n > 0 ? n : 0.01;
}

// Optional request body forwarded to the data seller. RPC-proxy / request-bound sellers
// (e.g. QuickNode) require the paid request to carry the call it's paying for; our stand-in
// seller (x402-quote) serves a fixed dataset and needs none. DATA_SELLER_BODY is sent verbatim
// as the JSON request body; unset/blank → undefined → no body (current behavior unchanged).
function dataSellerBody() {
  const raw = process.env.DATA_SELLER_BODY;
  return raw && raw.trim() ? raw : undefined;
}

// Map a seller's paid response into research facts (array of { claim, source }). Sellers
// differ: our stand-in returns { dataset: { facts: [{claim,source}] } }; an RPC/data seller
// returns e.g. { jsonrpc, result }. DATA_SELLER_FACTS_PATH (dot-path) selects the useful
// value; default "dataset.facts" keeps the stand-in working unchanged.
//  - path → array of {claim,source} objects: used as-is (our stand-in).
//  - path → array of other shapes: each stringified into a claim (source = seller url).
//  - path → a scalar/object: ONE fact, claim="<path> = <value>", source = seller url.
// Returns [] if the path misses or yields nothing usable. Exported for unit tests.
export function extractFacts(sellerBody, sellerUrl) {
  if (sellerBody == null || typeof sellerBody !== "object") return [];
  const path = (process.env.DATA_SELLER_FACTS_PATH || "dataset.facts").trim();
  const val = path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), sellerBody);
  if (val == null) return [];
  const src = sellerUrl || DATA_SELLER_SOURCE;
  if (Array.isArray(val)) {
    return val
      .map((f) =>
        f && typeof f === "object" && (f.claim != null || f.source != null)
          ? { claim: String(f.claim ?? JSON.stringify(f)), source: String(f.source ?? src) }
          : { claim: typeof f === "string" ? f : JSON.stringify(f), source: src }
      )
      .filter((f) => f.claim);
  }
  const claim = `${path} = ${typeof val === "object" ? JSON.stringify(val) : String(val)}`;
  return [{ claim, source: src }];
}

// The data-decision / ROUTING system prompt. The model sees the question +
// already-retrieved web sources and routes to ONE source, or none. PRIORITY RULE is
// in the prompt: prefer the paid on-chain path (QuickNode RPC) where a listed method
// can serve; free CoinGecko ONLY for market figures RPC can't give; free arXiv ONLY
// for genuinely scientific/technical questions; else "none". On-chain is LIMITED to
// the three cleanly-decodable methods (NO eth_call this cut).
const DATA_DECISION_SYSTEM = `You decide whether ONE data fetch would materially improve a client research brief, and which source to use. You are given the research question and the web-search sources already retrieved.

Three data sources are available:
- ON-CHAIN (Arc Testnet JSON-RPC, paid per call): live blockchain facts. LIMITED to exactly these methods:
  * eth_getBalance — native USDC balance of an address. params: ["<0x address>", "latest"]
  * eth_gasPrice — current gas price. params: []
  * eth_blockNumber — current block height. params: []
- MARKET (CoinGecko, free): crypto PRICE, MARKET CAP, and 24h VOLUME for well-known coins. params: {"ids": "<coingecko id(s), comma-separated>"} using canonical ids like bitcoin, ethereum, usd-coin, solana.
- PAPERS (arXiv, free): peer-reviewed / preprint ACADEMIC PAPERS (titles, authors, abstracts) for genuinely SCIENTIFIC, TECHNICAL, or ACADEMIC questions where primary research literature would materially improve the answer (e.g. machine-learning methods, physics, mathematics, biology, algorithms, cryptography research). params: {"query": "<focused academic search terms — NOT the raw question>"}.

PRIORITY RULE: if the question needs an on-chain fact one of the on-chain methods above can serve, choose "onchain" (prefer it). Choose "market" ONLY for price / market-cap / volume the on-chain methods cannot provide. Choose "papers" ONLY for genuinely scientific / technical / academic questions as described above — NEVER for prices, market data, current events, news, product / company / person lookups, who / when / where factual lookups, or anything a general web source answers. If the already-retrieved sources already answer the question, or none of the three sources fits, choose "none".

For "onchain": set method to one of the three and params as specified (a valid 0x-address for eth_getBalance). For "market": set params to {"ids": "..."}. For "papers": set params to {"query": "..."} with focused academic search terms.

Respond with ONLY JSON, no markdown, no fences: {"kind": "onchain" | "market" | "papers" | "none", "method": "<rpc method or empty string>", "params": <array or object, or []>, "justification": "<one sentence>"}`;

// Exported so the genuine-autonomy proof harness (_autonomy-test.mjs) can drive the
// REAL decision path. Returns { kind, method, params, justification } plus a back-compat
// `buy` (= kind !== "none") so existing consumers that read `.buy` keep working.
export async function decidePurchase(apiKey, model, question, groundingBlock) {
  const user =
    `Research question:\n${question}\n\n` +
    `Sources already retrieved:\n${groundingBlock || "(none)"}\n\n` +
    `Decide the data fetch. Respond with ONLY the JSON.`;
  const data = await callAnthropic(apiKey, model, [{ role: "user", content: user }], DATA_DECISION_SYSTEM, []);
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const parsed = extractJson(text) || {};
  const kind = ["onchain", "market", "papers", "none"].includes(parsed.kind) ? parsed.kind : "none";
  return {
    kind,
    method: typeof parsed.method === "string" ? parsed.method : "",
    params: parsed.params ?? [],
    justification: parsed.justification || "(no justification)",
    buy: kind !== "none", // back-compat (_autonomy-test.mjs reads .buy; legacy forceDecision)
  };
}

// STRICT relevance filter for arXiv papers — the reliability lever. arXiv full-text
// search returns loosely-related papers and no score, so we bias hard toward DROP:
// keep ONLY papers that DIRECTLY address the question. A brief padded with tangential
// citations is worse than no papers. On ANY failure (LLM error, unparseable verdict)
// → drop ALL (return []) → Exa-only. Never keeps a paper it isn't sure about.
const PAPER_FILTER_SYSTEM = `You are a STRICT relevance filter for academic papers. Given a research question and a numbered list of arXiv papers (title + abstract), return the indices of ONLY the papers that DIRECTLY address the question. Bias strongly toward DROPPING: keep a paper ONLY if it clearly and directly bears on the question. Drop anything loosely, tangentially, or topically-adjacent but not directly relevant. It is better to keep NONE than to keep a tangential paper. Respond with ONLY JSON, no markdown, no fences: {"keep": [<0-based integer indices>]} — an empty array if none qualify.`;

async function filterRelevantPapers(apiKey, model, question, papers) {
  try {
    const list = papers
      .map((p, i) => `[${i}] "${p.title}" (${p.year})\n${p.summary.slice(0, 500)}`)
      .join("\n\n");
    const user = `Question:\n${question}\n\nPapers:\n${list}\n\nReturn ONLY the JSON with the indices to keep.`;
    const data = await callAnthropic(apiKey, model, [{ role: "user", content: user }], PAPER_FILTER_SYSTEM, []);
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    const parsed = extractJson(text) || {};
    const keep = Array.isArray(parsed.keep) ? parsed.keep : null;
    if (!keep) return []; // unparseable verdict → drop all (safe)
    return keep
      .filter((i) => Number.isInteger(i) && i >= 0 && i < papers.length)
      .map((i) => papers[i]);
  } catch {
    return []; // LLM error → drop all → Exa-only
  }
}

// ═══ ⭐⭐ THE DATA-PURCHASE OUTCOME — A CLOSED SET, WITH `unclassified` AS THE DEFAULT ═══════════
//
// 🚨 THE DEFECT THIS EXISTS FOR. maybeBuyData had FOURTEEN exits and ten of them were `return []`.
// Every one degraded the brief to Exa-only, and every one did it SILENTLY: the buyer received a
// thinner answer that read exactly like a well-funded one. Measured 2026-08-19 — the configured
// seller advertises 1.0 USDC per call against an absolute per-buy ceiling of 0.01, so the purchase
// path has NEVER succeeded in production at any price in the job band. Nobody noticed, because
// nothing said anything.
//
// ⭐ SO THE DEFAULT IS `unclassified`, NOT `ok`. The caller creates the object pre-set to
// unclassified; a code appears only where an exit explicitly marks one. An exit nobody enumerated —
// which is exactly what the ceiling case was — therefore renders LOUDLY as unclassified rather than
// falling through to silence. Absence must never read as normality; that is the whole lesson of
// this week, and it applies to our own agent's answers as much as to a contract report.
//
// ⚠️ A MUTABLE OBJECT PASSED IN, NOT A CHANGED RETURN SHAPE. This is live money-path code that
// signs EIP-3009 authorizations. Adding assignments cannot alter control flow; changing fourteen
// return shapes could. The object is created per call by the caller, so nothing leaks between
// invocations of a warm lambda.
export const PURCHASE_OUTCOME = Object.freeze({
  PURCHASED: "purchased",                      // paid data acquired and used
  FREE_SOURCE: "free-source",                  // CoinGecko/arXiv answered; no purchase was needed
  FREE_SOURCE_EMPTY: "free-source-empty",      // a free source was tried and returned nothing usable
  NOT_ATTEMPTED: "not-attempted",              // the model judged no extra source necessary
  METHOD_UNAVAILABLE: "method-unavailable",    // requested on-chain method invalid/unsupported
  SELLER_UNREACHABLE: "seller-unreachable",    // no usable x402 challenge from the seller
  PRICE_INVALID: "price-invalid",              // advertised price unparseable
  CEILING: "ceiling",                          // price above the absolute per-buy ceiling
  BUDGET: "budget",                            // per-job / per-day budget refused
  PAUSED: "paused",                            // the Researcher is paused
  SETTLE_UNCONFIRMED: "settle-unconfirmed",    // payment did not confirm; no money moved
  NO_USABLE_FACTS: "no-usable-facts",          // settled but the response yielded nothing
  ERROR: "error",                              // the purchase path threw
  UNCLASSIFIED: "unclassified",                // 🚨 an exit nobody enumerated — see above
});

/** Every outcome in which the brief rests on Exa alone. ⚠️ Derived by EXCLUSION, so a code added to
 *  the set above is degraded-by-default until someone deliberately says otherwise — the safe
 *  direction, and the same rule as SELF_CLEARING_HEALTH in _dd-rungs.mjs. */
const AUGMENTED = new Set([PURCHASE_OUTCOME.PURCHASED, PURCHASE_OUTCOME.FREE_SOURCE]);
export const isDegraded = (code) => !AUGMENTED.has(code);

/** A fresh outcome object. Pre-set to unclassified so silence is impossible. */
export const newPurchaseOutcome = () => ({ code: PURCHASE_OUTCOME.UNCLASSIFIED, detail: null, at: null });

function mark(outcome, key, detail) {
  if (!outcome) return;                       // never let reporting break the money path
  outcome.code = PURCHASE_OUTCOME[key] ?? PURCHASE_OUTCOME.UNCLASSIFIED;
  outcome.detail = detail;
  outcome.at = new Date().toISOString();
}

/** ⭐ THE SENTENCE THE BUYER READS. Written for someone who paid, not for a log reader — it names
 *  what was NOT done and why, in the same breath as the answer. */
export function disclosureLine(outcome) {
  const c = outcome?.code ?? PURCHASE_OUTCOME.UNCLASSIFIED;
  const why = outcome?.detail ? ` (${outcome.detail})` : "";
  if (c === PURCHASE_OUTCOME.PURCHASED) return `Paid data was purchased and used in this brief${why}.`;
  if (c === PURCHASE_OUTCOME.FREE_SOURCE) return `A free data source was used alongside web sources${why}.`;
  if (c === PURCHASE_OUTCOME.UNCLASSIFIED) {
    return "⚠️ NO PAID DATA WAS PURCHASED FOR THIS BRIEF, AND THE REASON WAS NOT RECORDED. " +
      "It rests on web sources alone. This is a defect in our reporting, not a statement about the " +
      "research — treat the gap as unexplained rather than benign.";
  }
  return `⚠️ No paid data was purchased for this brief, so it rests on web sources alone — ${why.slice(2, -1) || c}.`;
}

// Run the decision → gate → buy sequence and return the purchased facts (an
// array of { claim, source }), or [] if we didn't buy for any reason. Never
// throws: every failure path logs and returns [] so research proceeds Exa-only.
// `store` is the optional injectable budget store (undefined → Netlify Blobs).
async function maybeBuyData({ apiKey, model, question, groundingBlock, jobId, jobPrice, store, forceDecision, owner, outcome }) {
  try {
    // 1. Decision + ROUTING. `forceDecision` is a TEST-ONLY seam; production runs the
    // genuine classifier. It returns { kind: "onchain"|"market"|"none", method, params,
    // justification } (+ back-compat `buy`). A legacy { buy:true } verdict with no `kind`
    // maps to the static-env-body path so the existing proof/forceDecision still works.
    const decision = forceDecision ?? (await decidePurchase(apiKey, model, question, groundingBlock));
    const justification = decision?.justification || "(no justification)";
    const kind = decision?.kind ?? (decision?.buy ? "onchain-legacy" : "none");
    if (kind === "none") {
      console.log(`[research] data decision: NONE (skip) — ${justification}`);
      mark(outcome, "NOT_ATTEMPTED", "the model judged no extra source was needed");
      return [];
    }

    // MARKET branch — FREE public data (CoinGecko). NOT the x402 pay path: no challenge,
    // no budget gate, no on-chain spend. Returns { claim, source }[] directly; [] on any
    // failure → Exa-only. (Price/market-cap/volume the RPC can't provide.)
    if (kind === "market") {
      const facts = await fetchMarketData(decision.params);
      console.log(`[research] market data (CoinGecko, free): ${facts.length} fact(s) — ${justification}`);
      mark(outcome, "FREE_SOURCE", `CoinGecko market data (free) — ${facts.length} fact(s)`);
      return facts;
    }

    // PAPERS branch — FREE academic papers (arXiv). NOT the x402 pay path. Fetch +
    // defensive parse (searchArxiv drops any malformed paper), then a STRICT LLM
    // relevance filter (bias to DROP; keep only papers that directly bear on the
    // question). Any failure / no clean papers / filter drops all → [] → Exa-only.
    if (kind === "papers") {
      const papers = await searchArxiv({ query: decision.params?.query });
      if (!papers.length) {
        console.log(`[research] arXiv: no clean papers — Exa-only. ${justification}`);
        mark(outcome, "FREE_SOURCE_EMPTY", "arXiv returned no clean papers");
        return [];
      }
      const kept = await filterRelevantPapers(apiKey, model, question, papers);
      const facts = arxivToFacts(kept);
      console.log(`[research] arXiv papers (free): ${papers.length} fetched → ${facts.length} kept (strict) — ${justification}`);
      mark(outcome, "FREE_SOURCE", `arXiv (free) — ${facts.length} fact(s) kept`);
      return facts;
    }

    // ON-CHAIN branch — build the RPC body for the chosen method, then run the EXISTING,
    // UNCHANGED x402 pay path below (challenge → ceiling → gate → payX402 → recordSpend).
    // buildRpcBody validates the method/params (and refuses eth_getBalance until its
    // decimals are verified — so we never PAY for a balance we'd have to drop). null → drop
    // before any spend. Legacy verdict keeps the static env body.
    let requestBody;
    if (kind === "onchain-legacy") {
      requestBody = dataSellerBody();
    } else {
      requestBody = buildRpcBody(decision.method, decision.params);
      if (!requestBody) {
        console.warn(`[research] on-chain method unavailable/invalid (NO buy, no spend): ${decision.method}`);
        mark(outcome, "METHOD_UNAVAILABLE", "the on-chain method requested is not available or invalid");
        return [];
      }
    }
    const asOf = new Date().toISOString();
    // 2. Fetch the seller's x402 challenge FIRST so the gate sees the SELLER'S
    //    advertised price (maxAmountRequired) — the amount actually charged — as
    //    the canonical input, not a separate env figure. The SAME challenge is
    //    threaded into payX402 below (one fetch → gated price == signed price).
    // RPC-proxy / request-bound sellers (e.g. QuickNode) need the paid request to carry the
    // call being paid for; buildRpcBody/DATA_SELLER_BODY supplies it. Threaded into BOTH the
    // challenge fetch and payX402's settle so they match.
    const chal = await fetchX402Requirements({ sellerUrl: process.env.DATA_SELLER_URL, requestBody });
    if (!chal.ok) {
      console.warn(`[research] x402 challenge fetch failed (NO buy): ${chal.body?.error ?? "unknown"}`);
      mark(outcome, "SELLER_UNREACHABLE", "the data seller did not return a usable x402 challenge");
      return [];
    }
    // v1 sellers publish the price as maxAmountRequired; v2 (e.g. QuickNode) as
    // amount — the SAME fallback precedence the buyer's signed atomic uses
    // (_x402.mjs), so with the SAME challenge threaded into payX402 the gate-price
    // equals the signed-price. Missing both → "" → NaN/0 → degrade to Exa-only.
    const advAtomic = String(chal.requirements?.maxAmountRequired ?? chal.requirements?.amount ?? "");
    const amountUsdc = Number(advAtomic) / 1e6;
    if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
      console.warn(`[research] x402 advertised price invalid (NO buy): "${advAtomic}"`);
      mark(outcome, "PRICE_INVALID", `the seller advertised an unusable price: "${advAtomic}"`);
      return [];
    }
    console.log(`[research] purchase decision: BUY (advertised $${amountUsdc}) — ${justification}`);

    // 3. Absolute per-buy hard ceiling — refuse a surprising advertised price BEFORE
    //    the percentage gate (the buy must pass BOTH). Fires before any signing, so no
    //    money moves on a refusal; returns [] → clean Exa-only.
    const ceiling = dataBuyCeilingUsdc();
    if (amountUsdc > ceiling) {
      console.warn(`[research] advertised ${amountUsdc} exceeds absolute per-buy ceiling ${ceiling} USDC (NO buy)`);
      await recordBlocked({ agent: AGENT.RESEARCHER, owner, jobId, amountUsdc, source: DATA_SELLER_SOURCE, reason: `absolute ceiling: ${amountUsdc} > ${ceiling} USDC`, store });
      mark(outcome, "CEILING", `advertised ${amountUsdc} USDC exceeds the absolute per-buy ceiling of ${ceiling} USDC`);
      return [];
    }

    // 4. Budget gate on the SELLER'S advertised price. Day-ceiling sub-check is
    //    keyed to `owner` (the job client's own wallet), so buys draw down THIS
    //    user's daily budget, not a shared global one.
    // ── THE KILL SWITCH, mid-research. A job already in flight must stop BUYING when the
    // Researcher is paused. maybeBuyData never throws — it returns [] and the brief is
    // synthesised from Exa alone, which is a graceful, honest degradation. Fail-closed. ──
    const paused = await assertNotPaused({ owner, agent: AGENT.RESEARCHER });
    if (paused) {
      console.log(`[research] PAUSED: ${paused}`);
      await recordBlocked({ agent: AGENT.RESEARCHER, owner, jobId, amountUsdc, source: DATA_SELLER_SOURCE, reason: paused, store });
      mark(outcome, "PAUSED", `the Researcher is paused: ${paused}`);
      return [];
    }

    const gate = await canSpend({ jobId, jobPriceUsdc: jobPrice, amountUsdc, store, owner });
    if (!gate.allowed) {
      console.log(`[research] budget BLOCKED: ${gate.reason}`);
      await recordBlocked({ agent: AGENT.RESEARCHER, owner, jobId, amountUsdc, source: DATA_SELLER_SOURCE, reason: gate.reason, store });
      mark(outcome, "BUDGET", `the per-job budget refused it: ${gate.reason}`);
      return [];
    }
    console.log(`[research] budget ALLOWED — purchasing…`);

    // 5. Purchase — thread the SAME challenge (no re-fetch); bind the signed
    //    amount to the gated advertised price.
    const res = await payX402({ sellerUrl: process.env.DATA_SELLER_URL, challenge: chal, requestBody, approvedUsdc: amountUsdc, requireApproved: true, jobContext: { jobId, jobPrice } });

    // 6. If the settle did NOT confirm, no money moved → return [] without recording.
    if (!res?.body?.executed) {
      console.warn(`[research] purchase did NOT settle (no spend): status=${res?.status} executed=${res?.body?.executed}`);
      mark(outcome, "SETTLE_UNCONFIRMED", "the purchase did not confirm — no money moved");
      return [];
    }

    // 7. Record spend on ANY confirmed settle — BEFORE extracting facts — so the
    //    day-ceiling reflects real on-chain spend. A misconfigured DATA_SELLER_FACTS_PATH
    //    (settle succeeds but no usable facts) must NOT hide a real debit. Record the
    //    actual price paid.
    const paidUsdc = res.body.priceUsdc ?? amountUsdc;
    await recordSpend({
      agent: AGENT.RESEARCHER,
      jobId,
      jobPriceUsdc: jobPrice,
      amountUsdc: paidUsdc,
      source: DATA_SELLER_SOURCE,
      justification,
      store,
      owner,
    });

    // 8. Map the seller's response into { claim, source } facts (seller-shape-aware; see
    //    extractFacts / DATA_SELLER_FACTS_PATH). res.body.seller is the resolved seller URL.
    const facts =
      kind === "onchain-legacy"
        ? extractFacts(res?.body?.sellerBody, res?.body?.seller ?? process.env.DATA_SELLER_URL)
        : decodeRpc(decision.method, res?.body?.sellerBody, requestBody.params, asOf);
    if (facts.length === 0) {
      console.warn(`[research] settled $${paidUsdc} (spend recorded) but no usable facts — check DATA_SELLER_FACTS_PATH`);
      mark(outcome, "NO_USABLE_FACTS", `settled ${paidUsdc} USDC but the response yielded no usable facts`);
      return [];
    }
    console.log(`[research] purchased ${facts.length} facts for $${paidUsdc} — spend recorded`);
    mark(outcome, "PURCHASED", `purchased ${facts.length} fact(s) for ${paidUsdc} USDC`);
    return facts;
  } catch (e) {
    // ANY error degrades to Exa-only. No spend is recorded on the throw path.
    console.warn(`[research] purchase loop error (degrading to Exa-only): ${e.message}`);
    mark(outcome, "ERROR", `the purchase path threw: ${e?.message ?? e}`);
    return [];
  }
}

export async function research(
  question,
  systemPrompt,
  userInstruction = "Research this question with web search and respond in the exact JSON format specified.",
  opts = {}
) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY (server env)");
  const model = process.env.PREDICT_MODEL || "claude-sonnet-4-6";

  // Phase 2a plumbing (Step 2a-2): the caller may thread job context so a LATER
  // step can compute the per-job data allowance and gate autonomous purchases.
  // We only SURFACE it here — no budget calls, no spending, no decision logic yet.
  // Log so we can confirm the values arrive with the right jobId/jobPrice.
  const { jobId, jobPrice, owner } = opts;
  if (jobId != null || jobPrice != null) {
    console.log(`[research] job context: jobId=${jobId} jobPrice=${jobPrice} USDC owner=${owner ?? "(none)"}`);
  }

  // Opt-in Exa path: ground the brief on real retrieved sources instead of the
  // model's own web search. One Exa call, then a SINGLE Anthropic call with NO
  // web-search tool (so there's no pause_turn loop). On any Exa failure we do
  // NOT fall through to the web-search path below: that path trusts model-written
  // URLs and is structurally fabrication-prone, so the useExa path stays Exa-only
  // — real retrieved sources, or an honest null-decision result that refunds.
  if (opts.useExa === true && process.env.EXA_API_KEY) {
    try {
      const exaResults = await exaSearch(question);

      // Numbered grounding entries the model must rely on exclusively.
      const exaEntries = exaResults.map(
        (r, i) => `[${i + 1}] ${r.title} (${r.url}, ${r.publishedDate})\n${r.text}`
      );

      // ── Autonomous mid-research purchase (Phase 2a) ────────────────────────
      // Only when job context is present (jobId + jobPrice), so the budget gate
      // can compute the per-job allowance. maybeBuyData never throws: on decline,
      // block, or failure it returns [] and we synthesize from Exa alone.
      // ⭐ Created here, per call — never module-level, or a warm lambda would leak one job's
      // outcome into the next. Pre-set to `unclassified`, so an exit that marks nothing is loud.
      const purchaseOutcome = newPurchaseOutcome();
      let purchasedFacts = [];
      if (jobId != null && jobPrice != null) {
        purchasedFacts = await maybeBuyData({
          outcome: purchaseOutcome,
          apiKey,
          model,
          question,
          groundingBlock: exaEntries.join("\n\n"),
          jobId,
          jobPrice,
          owner, // per-user day-ceiling key (the job client's own wallet)
          store: opts.budgetStore,
          forceDecision: opts.forceDecision, // test-only; undefined in production
        });
      } else {
        // ⚠️ NOT a silent skip: without job context there is no budget to gate against, so no
        // purchase was ever possible. The buyer is told that, rather than shown a thinner brief.
        mark(purchaseOutcome, "NOT_ATTEMPTED", "no job context, so no budget could be gated against");
      }

      // Merge: fold purchased {claim, source} facts into the grounding block,
      // continuing the numbering after the Exa entries (claim→text, source→url).
      const purchasedEntries = purchasedFacts.map(
        (f, i) => `[${exaResults.length + i + 1}] Purchased data (${f.source})\n${f.claim}`
      );
      const groundingBlock = [...exaEntries, ...purchasedEntries].join("\n\n");

      const exaUser =
        question +
        "\n\nBase your brief ONLY on these sources; do not use any other knowledge or invent URLs:\n" +
        groundingBlock +
        "\n\n" +
        userInstruction;

      const data = await callAnthropic(
        apiKey,
        model,
        [{ role: "user", content: exaUser }],
        systemPrompt,
        [], // no web search — single call, no pause_turn resume needed
        BRIEF_MAX_TOKENS // headroom so a long, rich brief isn't truncated → unparseable → refund
      );

      const text = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      const decision = extractJson(text);

      if (decision) {
        // ── RETRIEVED IS NOT SUPPORTING ────────────────────────────────────────────
        // This block used to be a straight override: decision.sources = every Exa result.
        // That made the list RETRIEVAL OUTPUT rendered under a heading ("Sources:") that
        // asserts SUPPORT. Job #160108 is the proof: the answer referenced [1] and [2],
        // six sources were listed, and the Bybit / Bitget "Unified Trading Account" FAQs
        // — matched on the word "Unified" — appeared as if they backed a claim about
        // Arc's Gateway. The answer was correct; the citation layer lied about it.
        //
        // ⚠️ THE OVERRIDE EXISTED FOR A REASON — do not simply trust the model's list.
        // It is the NO-FABRICATION guard: model-emitted URLs can be invented, so "the
        // model's word is never the record" (see job-submit-background.mjs). Reverting to
        // decision.sources would reopen fabrication, which is strictly worse.
        //
        // ⭐ SO: INTERSECT, don't choose. Keep only retrieved entries the answer actually
        // cites. Every surviving URL still comes from retrieval (fabrication stays shut),
        // and every listed source now carries a claim (retrieved≠supporting closes too).
        // The list is DERIVED FROM THE WORK rather than passed through, so it cannot rot
        // into a static list that outlives what produced it.
        const retrieved = [
          ...exaResults.map((r) => ({ title: r.title, url: r.url })),
          ...purchasedFacts.map((f) => ({ title: f.claim, url: f.source })),
        ];
        // TWO DERIVATIONS IN STRICT PRECEDENCE — NOT a union. Order matters:
        //   (a) the model's own `sources` claim, matched by URL — PREFERRED;
        //   (b) inline [n] markers in the prose, resolved against the grounding block's
        //       numbering (exaEntries then purchasedEntries — same order as `retrieved`)
        //       — FALLBACK, used only when (a) is absent.
        //
        // 🚨 WHY NOT A UNION — job #160637. A UNION was the first fix and it was WRONG, for
        // a reason worth stating exactly: **[n] marks a REFERENCE, not SUPPORT, and
        // DISMISSAL IS A FORM OF REFERENCE.** That answer said sources [3], [4], [5] were
        // Kraken and Wirex and that "none of these are relevant" — and the union promoted
        // all three into "Sources:" precisely BECAUSE the answer named them. The derivation
        // identified REFERENCED sources while the heading claimed SUPPORTING ones.
        // ⚠️ The perverse incentive is the tell: the more honestly an answer explained why a
        // retrieval was irrelevant, the more certainly it got cited for it.
        //
        // ⭐ AND DO NOT "FIX" THIS BY SNIFFING NEGATIVE CONTEXT IN THE PROSE. Detecting
        // "not relevant" / "none of these" near a marker is the fragile version: it is
        // unbounded natural language, it fails on negation-of-negation, and it would put a
        // regex in the path of what gets billed. The model already answers this question
        // directly in `sources` — prefer the direct answer over inferring intent from text.
        // #160108 still works because it carried ONLY the marker form, so (b) still applies.
        const normUrl = (u) =>
          String(u || "").trim().replace(/[/#?]+$/, "").toLowerCase();
        const modelSources = Array.isArray(decision.sources) ? decision.sources : [];
        const claimedUrls = new Set(
          modelSources.map((s) => normUrl(typeof s === "string" ? s : s?.url)).filter(Boolean)
        );
        const prose = `${decision.answer || ""}\n${decision.reasoning || ""}`;
        const markedIdx = new Set(
          [...prose.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1]) - 1)
        );

        // ⚠️ The gate is "did the model ANSWER the question", i.e. is its array non-empty —
        // NOT "did its answer intersect retrieval". If it named sources and none of them
        // match what we retrieved, that is a FABRICATION signal and `cited` must come out
        // EMPTY (→ the uncited guard), never silently fall through to markers. Falling back
        // there would let the weaker signal overrule an explicit answer, reopening #160637.
        const modelAnswered = modelSources.length > 0;
        const citedSignal = modelAnswered ? "model-sources" : "inline-markers";
        const isCited = modelAnswered
          ? (r) => claimedUrls.has(normUrl(r.url))
          : (_r, i) => markedIdx.has(i);

        const cited = retrieved.filter((r, i) => isCited(r, i));
        const notCited = retrieved.filter((r, i) => !isCited(r, i));

        // ⭐ WHY the list came out empty — two DIFFERENT events that must not be averaged.
        //   "unmatched-model-sources": the model NAMED sources and NONE matched retrieval.
        //       That is either FABRICATED URLs (the layer-below failure this whole filter
        //       assumes is shut) or a URL-NORMALISATION BUG on our side (trailing slash,
        //       encoding, redirect target ≠ advertised URL). Both are actionable and neither
        //       is "the model didn't cite" — an unmatched claim is a claim.
        //   "no-signal": the model named nothing and no marker resolved. Ordinary silence.
        // Aggregated as plain "uncited" these cancel out: a normalisation bug would look
        // exactly like models declining to cite, and the fix for one is not the fix for the
        // other. `citedCount > 0` ⇒ null.
        const emptyReason =
          cited.length > 0 ? null : modelAnswered ? "unmatched-model-sources" : "no-signal";

        // 🚨 REVIVES A GUARD THAT WAS DEAD ON THIS PATH. job-submit-background refuses to
        // submit a brief whose `sources` is empty — but the old override always produced a
        // non-empty retrieval set, so that check could never fire here. An answer citing
        // NOTHING used to ship with a full source list; it now reaches the guard, which is
        // the point ("never submit a brief we can't stand behind"). ⚠️ That is a MONEY-PATH
        // behaviour change: such a brief now refunds instead of shipping.
        decision.sources = cited;
        // Kept BESIDE the brief, never merged into `sources` — see job-submit-background,
        // where `report` is canonicalized into the on-chain deliverable hash. Breadth is
        // shown to the reader under its own heading, never as citation.
        decision.retrievedNotCited = notCited;

        // ⭐ THE DERIVATION'S INPUTS, RETURNED FOR MEASUREMENT — not for logic.
        // The empty-cited case now refunds, and nobody can say how often that SHOULD
        // happen. Estimating it would be a guess; this makes it a number. Everything the
        // derivation consumed is carried out so a firing can be reconstructed exactly:
        // what the model claimed, what markers appeared in the prose, what was retrieved,
        // and which signal matched each survivor. Kept OFF `decision` deliberately — the
        // brief is the deliverable, and diagnostics are not part of the product.
        const citation = {
          retrievedCount: retrieved.length,
          citedCount: cited.length,
          notCitedCount: notCited.length,
          // WHICH signal decided this brief. Needed to read the measurement window: a
          // marker-derived list is the weaker path and its false-empty rate should be
          // tracked separately from the model-sources path.
          citedSignal,
          emptyReason,
          // Raw count of what the model NAMED, before intersecting with retrieval. With
          // emptyReason="unmatched-model-sources" this separates "named 5, matched 0"
          // (fabrication or normalisation) from "named 0" — the counts differ, the
          // conclusions differ, and only the pair distinguishes them.
          modelSourceCountRaw: modelSources.length,
          modelSourceUrls: [...claimedUrls],
          inlineMarkers: [...markedIdx].map((i) => i + 1).sort((a, b) => a - b),
          retrievedUrls: retrieved.map((r) => r.url),
          matchedBy: retrieved.map((r, i) => ({
            url: r.url,
            byModelSources: claimedUrls.has(normUrl(r.url)),
            byInlineMarker: markedIdx.has(i),
          })).filter((m) => m.byModelSources || m.byInlineMarker),
        };
        return {
          question, model, decision, exaUsed: true,
          purchasedFacts: purchasedFacts.length,
          // ⭐ BOTH HALVES, DELIBERATELY. `dataPurchase` is the RECORD — structured, queryable, and
          // it survives the brief being read once and thrown away. `disclosure` is what the BUYER
          // reads. A disclosure only in the record is not a disclosure to the person who paid; one
          // only in the prose does not outlive the page. Same finding as errata_note, one path over:
          // a disclosure only a source-reader would see is not a disclosure.
          dataPurchase: { ...purchaseOutcome, degraded: isDegraded(purchaseOutcome.code) },
          disclosure: disclosureLine(purchaseOutcome),
          citation,
        };
      }
      return { question, model, decision: null, raw: text, warning: "unparseable (exa path)", exaUsed: true,
               dataPurchase: { ...purchaseOutcome, degraded: isDegraded(purchaseOutcome.code) },
               disclosure: disclosureLine(purchaseOutcome) };
    } catch (e) {
      console.warn(`[research] Exa retrieval failed (useExa path), refusing web-search fallback: ${e.message}`);
      return { question, model, decision: null, warning: "no verifiable sources found via retrieval", exaUsed: true };
    }
  }

  const user =
    `${question}\n` +
    userInstruction;

  const messages = [{ role: "user", content: user }];
  let data = await callAnthropic(apiKey, model, messages, systemPrompt, [WEB_SEARCH_TOOL], BRIEF_MAX_TOKENS);

  // Resume across pause_turn boundaries: append the assistant turn verbatim and
  // re-send. Do NOT inject a "continue" message — the API detects the trailing
  // server_tool_use block and resumes on its own. Bail after MAX_CONTINUATIONS.
  let n = 0;
  while (data.stop_reason === "pause_turn" && n < MAX_CONTINUATIONS) {
    messages.push({ role: "assistant", content: data.content });
    data = await callAnthropic(apiKey, model, messages, systemPrompt, [WEB_SEARCH_TOOL], BRIEF_MAX_TOKENS);
    n++;
  }

  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  const decision = extractJson(text);
  return decision
    ? { question, model, decision }
    : { question, model, decision: null, raw: text, warning: "unparseable or search incomplete" };
}
