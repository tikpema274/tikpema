#!/usr/bin/env node
// verify-swap-no-route.mjs — test:swapnoroute. Offline: every network edge is injected, no money, no Circle.
//
//   node --experimental-test-module-mocks scripts/verify-swap-no-route.mjs
//
// THE DEFECT (2026-10-03): the first external user's 0.2 USDC → EURC agent swap showed
//     createSwap HTTP 404: {"code":331001,"message":"No route available"}
// verbatim, under a page of careful copy, and they concluded "agent not working". Circle offered no route
// (T confirmed it live on T's own wallet). The fix classifies it AT THE SOURCE (shared/swap-no-route.mjs).
//
// What this pins:
//   A. THE SOURCE. The REAL agentSwap and buildSwapCallData, network edges injected: Circle's 404/331001
//      becomes SwapNoRouteError; an approval that LANDED in this attempt is named with its amount; a
//      standing allowance is not; any OTHER failure is NOT dressed up as no-route.
//   B. THE SENTENCE. Says what happened, that nothing was swapped / no funds left, offers what to do; never
//      promises the route returns, never says "temporary", carries no provider text.
//   A2. ANY OTHER createSwap failure (another 404 code, a 500, non-JSON, an unreadable 200) becomes the SECOND
//      sentence — "could not be prepared" + a details line with Circle's raw status/code/message and the time.
//   B2. The two sentences never read alike; both say nothing was charged; provider text only in the details line.
//   D. THE BOUNDARY (T): "nothing was charged" holds only BEFORE submission. quoteStageError refuses any other
//      stage, and agentSwap's source must flip `stage = "submitted"` on the line before the submit, with every
//      quoteStageError above it. A failure after submission cannot reach the quote-stage wording.
//   C. THE SURFACES, driven through their REAL handlers and the REAL executeAction → agentSwap chain where the
//      handler allows it: no response body any panel reads carries Circle's JSON.
//
// ⛔ Never mock the function under test: agentSwap, executeAction and the handlers are real; only Circle's
// HTTP, Circle's wallet client, the chain read and the session/blob stores are injected.

import { mock } from "node:test";

process.env.KIT_KEY = "KIT_KEY:test-not-a-real-key";
process.env.AGENT_SWAP_CAP_USDC = "25";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret-swap-no-route";
process.env.ANTHROPIC_API_KEY = "test-key-network-is-mocked";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

/** Provider text that must never reach a user. */
const RAW = [/331001/, /createSwap/, /No route available/, /\{"code"/, /HTTP 404/];
const isClean = (s) => typeof s === "string" && s.length > 0 && RAW.every((r) => !r.test(s));

// ── network edges ─────────────────────────────────────────────────────────────────────────────
const NO_ROUTE = { status: 404, body: JSON.stringify({ code: 331001, message: "No route available" }) };
let swapResponse = NO_ROUTE;   // what Circle's createSwap answers
let allowanceNow = 0n;         // the agent wallet's standing allowance to the swap adapter
const approves = [];

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes("/stablecoinKits/swap")) {
    const { status, body } = swapResponse;
    return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) };
  }
  if (typeof brainFetch === "function" && String(url).includes("anthropic")) return brainFetch(url, init);
  throw new Error(`unexpected network call in an offline suite: ${url}`);
};
let brainFetch = null;

const REAL_CIRCLE = await import("../netlify/functions/_circle.mjs");
mock.module("../netlify/functions/_circle.mjs", {
  namedExports: {
    ...REAL_CIRCLE,
    circle: () => ({
      createContractExecutionTransaction: async (args) => { approves.push(args); return { data: { id: `approve-${approves.length}` } }; },
    }),
    waitForTx: async () => ({ state: "COMPLETE" }),
  },
});
const REAL_PREDICT = await import("../netlify/functions/_predict.mjs");
mock.module("../netlify/functions/_predict.mjs", {
  namedExports: { ...REAL_PREDICT, publicClient: () => ({
    readContract: async ({ functionName }) => {
      if (functionName === "allowance") return allowanceNow;
      if (functionName === "balanceOf") return 100_000_000n; // 100 USDC: funding is never the reason here
      throw new Error(`unexpected readContract ${functionName}`);
    },
  }) },
});

// Session, agent wallet and stores — boundaries, not subjects.
const OWNER = "0x00000000000000000000000000000000000000a1";
const mem = new Map(); // `${store}/${key}` → JSON string
const storeOf = (name) => {
  const n = typeof name === "string" ? name : name?.name;
  return {
    setJSON: async (k, v) => { mem.set(`${n}/${k}`, JSON.stringify(v)); },
    set: async (k, v) => { mem.set(`${n}/${k}`, typeof v === "string" ? v : JSON.stringify(v)); },
    get: async (k, o) => { const v = mem.get(`${n}/${k}`); return v == null ? null : (o?.type === "json" ? JSON.parse(v) : v); },
    getWithMetadata: async (k) => { const v = mem.get(`${n}/${k}`); return v == null ? null : { data: JSON.parse(v), etag: "e", metadata: {} }; },
    list: async ({ prefix } = {}) => ({ blobs: [...mem.keys()].filter((x) => x.startsWith(`${n}/`)).map((x) => ({ key: x.slice(n.length + 1) })).filter((b) => !prefix || b.key.startsWith(prefix)) }),
    delete: async (k) => { mem.delete(`${n}/${k}`); },
  };
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: storeOf, getDeployStore: storeOf } });
const REAL_AUTH = await import("../netlify/functions/_auth.mjs");
mock.module("../netlify/functions/_auth.mjs", { namedExports: { ...REAL_AUTH, requireSession: () => ({ address: OWNER }), internalToken: () => "internal" } });
const REAL_WALLETS = await import("../netlify/functions/_agent-wallets.mjs");
mock.module("../netlify/functions/_agent-wallets.mjs", { namedExports: { ...REAL_WALLETS, ensureOwnerWallet: async () => ({ walletAddress: "0xa9e70000000000000000000000000000000000a1" }) } });

const { agentSwap, buildSwapCallData } = await import("../netlify/functions/_swap.mjs");
const { noRouteMessage, quoteFailedMessage, quoteStageError, SwapNoRouteError, SwapQuoteFailedError, isNoRouteResponse } = await import("../shared/swap-no-route.mjs");
const WALLET = "0xa9e70000000000000000000000000000000000a1";
const rejection = async (p) => { try { await p; return null; } catch (e) { return e; } };

section("A. the source classifies Circle's no-route");
{
  approves.length = 0; allowanceNow = 0n; swapResponse = NO_ROUTE;
  const e = await rejection(agentSwap({ walletAddress: WALLET, tokenIn: "USDC", tokenOut: "EURC", amountIn: 0.2 }));
  check("agentSwap: 404/331001 → SwapNoRouteError", e instanceof SwapNoRouteError && e.swapNoRoute === true, e?.message?.slice(0, 80));
  check("…an approval was sent BEFORE the quote (the on-chain effect the sentence must name)", approves.length === 1);
  check("…and the error names it, with the amount that was approved (the 25 USDC cap)", e?.approval?.amountBase === "25000000" && /approved Circle's swap contract to spend up to 25 USDC/.test(e?.message ?? ""));
  check("…the message carries no provider text", isClean(e?.message), e?.message?.slice(0, 120));

  approves.length = 0; allowanceNow = 25_000_000n;
  const e2 = await rejection(agentSwap({ walletAddress: WALLET, tokenIn: "USDC", tokenOut: "EURC", amountIn: 0.2 }));
  check("a standing allowance already covers it → no approval sent", approves.length === 0);
  check("…and the sentence does NOT describe an approval that did not happen", e2 instanceof SwapNoRouteError && e2.approval === null && !/approved/.test(e2.message));

  const u = await rejection(buildSwapCallData({ walletAddress: WALLET, tokenIn: "EURC", tokenOut: "USDC", amountIn: 1 }));
  check("buildSwapCallData (the user's own wallet): → SwapNoRouteError, path 'user'", u instanceof SwapNoRouteError && u.path === "user");
  check("…in the user's words: nothing signed, 'your wallet', no agent", /Nothing was signed/.test(u?.message ?? "") && !/agent/i.test(u?.message ?? ""));

  for (const [label, resp] of [
    ["a 404 with another code", { status: 404, body: JSON.stringify({ code: 156000, message: "Resource not found" }) }],
    ["a 500", { status: 500, body: "upstream exploded" }],
    ["a 404 that is not JSON", { status: 404, body: "<html>not found</html>" }],
  ]) {
    swapResponse = resp; allowanceNow = 25_000_000n;
    const x = await rejection(agentSwap({ walletAddress: WALLET, tokenIn: "USDC", tokenOut: "EURC", amountIn: 0.2 }));
    check(`${label} is NOT dressed up as no-route`, x && !(x instanceof SwapNoRouteError) && !x.swapNoRoute, x?.message?.slice(0, 60));
    check(`${label} → the SECOND sentence (quote-failed), with a details line`, x instanceof SwapQuoteFailedError && /^The swap could not be prepared/.test(x.message) && /Details for support: createSwap HTTP \d{3}/.test(x.message), x?.message?.slice(0, 90));
  }
  swapResponse = { status: 200, body: "not json at all" }; allowanceNow = 25_000_000n;
  const mj = await rejection(agentSwap({ walletAddress: WALLET, tokenIn: "USDC", tokenOut: "EURC", amountIn: 0.2 }));
  check("an unreadable 200 reply → quote-failed, 'could not be read'", mj instanceof SwapQuoteFailedError && /reply to the quote request could not be read/.test(mj.message));
  swapResponse = { status: 200, body: JSON.stringify({ data: { transaction: {} } }) };
  const me = await rejection(agentSwap({ walletAddress: WALLET, tokenIn: "USDC", tokenOut: "EURC", amountIn: 0.2 }));
  check("a 200 with no executionParams → quote-failed, 'could not be read'", me instanceof SwapQuoteFailedError && /could not be read/.test(me.message));
  swapResponse = { status: 500, body: JSON.stringify({ code: 0, message: "Internal server error" }) }; allowanceNow = 0n; approves.length = 0;
  const ma = await rejection(agentSwap({ walletAddress: WALLET, tokenIn: "USDC", tokenOut: "EURC", amountIn: 0.2 }));
  check("quote-failed also names an approval that landed in this attempt", ma instanceof SwapQuoteFailedError && /up to 25 USDC/.test(ma.message) && approves.length === 1);
  swapResponse = { status: 503, body: "upstream down" };
  const uf = await rejection(buildSwapCallData({ walletAddress: WALLET, tokenIn: "USDC", tokenOut: "EURC", amountIn: 1 }));
  check("own wallet: another failure → quote-failed, user path (nothing signed)", uf instanceof SwapQuoteFailedError && uf.path === "user" && /Nothing was signed/.test(uf.message));
  swapResponse = NO_ROUTE;
  check("isNoRouteResponse: exactly 404 + 331001", isNoRouteResponse(404, NO_ROUTE.body) && !isNoRouteResponse(400, NO_ROUTE.body) && !isNoRouteResponse(404, "{}"));
}

section("B. the sentence");
{
  const withApproval = noRouteMessage({ tokenIn: "USDC", tokenOut: "EURC", approval: { amountBase: 25_000_000n, token: "USDC" } });
  const plain = noRouteMessage({ tokenIn: "EURC", tokenOut: "USDC" });
  const user = noRouteMessage({ tokenIn: "USDC", tokenOut: "EURC", path: "user" });
  for (const [name, m] of [["agent+approval", withApproval], ["agent", plain], ["user", user]]) {
    check(`${name}: says what happened (no route offered, by Circle)`, /No swap route right now/.test(m) && /none was offered/.test(m) && /Circle/.test(m));
    check(`${name}: says nothing was swapped and no funds left`, /nothing was swapped|Nothing was swapped/i.test(m) && /no funds left your/.test(m));
    check(`${name}: says what the user can do`, /You can try again later/.test(m));
    check(`${name}: promises nothing about the route returning`, /we can't tell when they will return/.test(m) && !/(temporar|soon|will be back|will work|shortly|should resume)/i.test(m));
    check(`${name}: carries no provider text`, isClean(m));
  }
  check("tokens come from the call, not a fixed pair", /EURC → USDC/.test(plain) && /Your EURC is still there/.test(plain));
  check("an approval amount is rendered exactly (no rounding)", /up to 12.345678 USDC/.test(noRouteMessage({ tokenIn: "USDC", tokenOut: "EURC", approval: { amountBase: 12_345_678n, token: "USDC" } })));
  let threw = false; try { noRouteMessage({ tokenIn: "USDC", tokenOut: "EURC", path: "user", approval: { amountBase: 1n, token: "USDC" } }); } catch { threw = true; }
  check("the user path refuses to describe an approval (it never approves)", threw);
}

section("B2. the two sentences");
{
  const AT = Date.UTC(2026, 9, 3, 10, 21, 0);
  const sentences = {
    "no-route agent": noRouteMessage({ tokenIn: "USDC", tokenOut: "EURC" }),
    "no-route agent+approval": noRouteMessage({ tokenIn: "USDC", tokenOut: "EURC", approval: { amountBase: 25_000_000n, token: "USDC" } }),
    "no-route user": noRouteMessage({ tokenIn: "USDC", tokenOut: "EURC", path: "user" }),
    "failed agent": quoteFailedMessage({ tokenIn: "USDC", status: 500, bodyText: JSON.stringify({ code: 0, message: "Internal server error" }), at: AT }),
    "failed agent+approval": quoteFailedMessage({ tokenIn: "USDC", approval: { amountBase: 25_000_000n, token: "USDC" }, status: 404, bodyText: JSON.stringify({ code: 156000, message: "Resource not found" }), at: AT }),
    "failed user": quoteFailedMessage({ tokenIn: "EURC", path: "user", status: 502, bodyText: "<html>bad gateway</html>", at: AT }),
    "failed malformed": quoteFailedMessage({ tokenIn: "USDC", status: 200, malformed: true, at: AT }),
  };
  const body = (m) => m.replace(/ Details for support: .*$/, "");
  for (const [n, m] of Object.entries(sentences)) {
    check(`${n}: says nothing was charged AND nothing moved`, /nothing was charged/.test(m) && /no funds left your/.test(m));
    check(`${n}: promises nothing about later`, !/(temporar|soon|will be back|will work|shortly|should resume|will succeed)/i.test(m));
    check(`${n}: no provider text outside the details line`, isClean(body(m)), body(m).match(/331001|createSwap|No route available|\{"code"|HTTP \d/)?.[0]);
  }
  for (const n of ["no-route agent", "no-route agent+approval", "no-route user"]) {
    check(`${n}: never borrows the fault wording, and has no details line`, !/could not be prepared|error we don't recognise|Details for support/.test(sentences[n]));
  }
  for (const n of ["failed agent", "failed agent+approval", "failed user", "failed malformed"]) {
    check(`${n}: never borrows the no-route wording`, !/no swap route|no route|none was offered|unavailable before/i.test(sentences[n]));
    check(`${n}: ends with a details line carrying the raw status and a UTC time`, /Details for support: createSwap HTTP \d{3}.* · 2026-10-03 10:21:00 UTC\.$/.test(sentences[n]), sentences[n].slice(-110));
  }
  check("details carry Circle's code and message verbatim (something to quote)", /createSwap HTTP 500 · code 0 · "Internal server error"/.test(sentences["failed agent"]));
  check("details carry a non-JSON body, cut short and on one line", /createSwap HTTP 502 · "<html>bad gateway<\/html>"/.test(sentences["failed user"]));
  check("the two FIRST sentences differ", sentences["no-route agent"].split(". ")[0] !== sentences["failed agent"].split(":")[0]);
}

section("D. the boundary: quote-stage wording cannot appear after submission");
{
  for (const stage of ["submitted", undefined, "confirmed", ""]) {
    let thrown = null; try { quoteStageError({ stage, status: 500, bodyText: "{}", tokenIn: "USDC", tokenOut: "EURC" }); } catch (e) { thrown = e; }
    check(`quoteStageError refuses stage ${JSON.stringify(stage)}`, thrown && !thrown.swapQuoteStage && !/nothing was charged/.test(thrown.message), thrown?.message?.slice(0, 70));
  }
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../netlify/functions/_swap.mjs", import.meta.url), "utf8");
  const code = src.split("\n").map((l) => (l.trim().startsWith("//") ? "" : l)).join("\n"); // comments cannot satisfy or defeat this
  const A0 = code.indexOf("export async function agentSwap"), A1 = code.indexOf("\nexport ", A0 + 10);
  const agent = code.slice(A0, A1 === -1 ? undefined : A1);
  const flips = [...agent.matchAll(/\bstage = "submitted";/g)];
  check("agentSwap flips the stage exactly once", flips.length === 1);
  const iFlip = flips[0]?.index ?? -1;
  const afterFlip = agent.slice(iFlip).split("\n").slice(1).find((l) => l.trim());
  check("…on the line directly before the swap submit", /const sw = await client\.createContractExecutionTransaction\(/.test(afterFlip ?? ""), afterFlip?.trim().slice(0, 80));
  const calls = [...agent.matchAll(/quoteStageError\(\{([^}]*)/g)];
  check("agentSwap builds quote-stage errors (at least the HTTP, unreadable and malformed sites)", calls.length >= 3, String(calls.length));
  check("…every one sits ABOVE the flip", calls.every((m) => m.index < iFlip));
  check("…and every one passes the live `stage` variable, not a literal", calls.every((m) => /^\s*stage[,\s]/.test(m[1])));
  check("nothing in _swap.mjs builds the error classes directly (only through the refusing helper)", !/new Swap(NoRoute|QuoteFailed|QuoteStage)Error/.test(code));
}

section("C. the surfaces (real handlers; the real executeAction → agentSwap chain)");
const POST = (body) => ({ httpMethod: "POST", headers: { authorization: "Bearer x" }, body: JSON.stringify(body) });
const parse = (res) => { try { return JSON.parse(res.body); } catch { return { unparsed: res.body }; } };
const allText = (o) => JSON.stringify(o);
{
  // C1 — the swap tab: swapFromAgent → /api/agent-execute-plan (one-step plan). The client shows step0.blocked first.
  approves.length = 0; allowanceNow = 0n; swapResponse = NO_ROUTE; mem.clear();
  const { handler } = await import("../netlify/functions/agent-execute-plan.mjs");
  const res = await handler(POST({ plan: [{ type: "swap_tokens", tokenIn: "USDC", tokenOut: "EURC", amountIn: 0.2 }] }));
  const b = parse(res);
  const s0 = Array.isArray(b.results) ? b.results[0] : null;
  check("swap tab (agent-execute-plan): the step is refused with OUR sentence in `blocked`", res.statusCode === 200 && s0?.ok === false && s0?.noRoute === true && /No swap route right now/.test(s0?.blocked ?? ""), `${res.statusCode} ${allText(b).slice(0, 160)}`);
  check("…and the approval that landed is named", /approved Circle's swap contract to spend up to 25 USDC/.test(s0?.blocked ?? ""));
  check("…and NO provider text anywhere in the response", isClean(allText(b).replace(/"noRoute":true/, "")), allText(b).match(/331001|createSwap|No route available/)?.[0]);
}
{
  // C2 — the chat: agent-act. The model's decision is fixed; the panel renders `notice` when `noRoute`.
  approves.length = 0; allowanceNow = 25_000_000n; swapResponse = NO_ROUTE; mem.clear();
  brainFetch = async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ action: "swap_tokens", tokenIn: "USDC", tokenOut: "EURC", amountIn: 0.2, reasoning: "swap as asked" }) }] }) });
  const { handler } = await import("../netlify/functions/agent-act.mjs");
  const res = await handler(POST({ task: "swap 0.2 USDC to EURC" }));
  const b = parse(res);
  check("chat (agent-act): 200, not a 500", res.statusCode === 200, `${res.statusCode} ${allText(b).slice(0, 160)}`);
  check("…`noRoute` with OUR sentence in `notice`, not framed as the agent holding off", b.noRoute === true && /No swap route right now/.test(b.notice ?? "") && !b.blocked && b.executed === false);
  check("…no approval this time (the standing allowance covered it), so none is described", !/approved/.test(b.notice ?? ""));
  check("…and NO provider text anywhere in the response", isClean(allText(b).replace(/"noRoute":true/, "")), allText(b).match(/331001|createSwap|No route available/)?.[0]);
  brainFetch = null;
}
{
  // C3 — approving a research proposal: job-swap-approve. The client throws data.error → describeError.
  approves.length = 0; allowanceNow = 0n; swapResponse = NO_ROUTE; mem.clear();
  mem.set("job-runs/run:r1", JSON.stringify({ owner: OWNER, jobId: "j1" }));
  mem.set("job-deliverables/j1", JSON.stringify({ status: "completed", proposal: { action: "swap_tokens", tokenIn: "USDC", tokenOut: "EURC", amountIn: 0.2, reasoning: "r" } }));
  const { handler } = await import("../netlify/functions/job-swap-approve.mjs");
  const res = await handler(POST({ runId: "r1" }));
  const b = parse(res);
  check("proposal approve (job-swap-approve): 409 with OUR sentence in `error`, not a raw 500", res.statusCode === 409 && b.noRoute === true && /No swap route right now/.test(b.error ?? ""), `${res.statusCode} ${allText(b).slice(0, 160)}`);
  check("…the approval lock is released (the proposal can be approved again later)", !JSON.parse(mem.get("job-deliverables/j1") ?? "{}").receipt);
  check("…and NO provider text anywhere in the response", isClean(allText(b).replace(/"noRoute":true/, "")), allText(b).match(/331001|createSwap|No route available/)?.[0]);
}
{
  // C4 — the user's own wallet: user-swap-start → buildSwapCallData (real). Previously wrapped and cut at 180 chars.
  swapResponse = NO_ROUTE; mem.clear();
  const { handler } = await import("../netlify/functions/user-swap-start.mjs");
  const res = await handler(POST({ tokenIn: "USDC", tokenOut: "EURC", amountIn: 0.2 }));
  const b = parse(res);
  check("own-wallet swap (user-swap-start): 409 with the WHOLE user-path sentence", res.statusCode === 409 && b.noRoute === true && /Nothing was signed/.test(b.error ?? "") && /we can't tell when they will return\.$/.test(b.error ?? ""), `${res.statusCode} ${allText(b).slice(0, 160)}`);
  check("…and NO provider text anywhere in the response", isClean(allText(b).replace(/"noRoute":true/, "")), allText(b).match(/331001|createSwap|No route available/)?.[0]);
}
{
  // C6 — a GENUINE fault (500) through every surface: the second sentence, flagged quoteFailed, with details.
  const E500 = { status: 500, body: JSON.stringify({ code: 0, message: "Internal server error" }) };
  const fault = (t) => /^The swap could not be prepared/.test(t ?? "") && /Details for support: createSwap HTTP 500 · code 0/.test(t ?? "") && !/No swap route/.test(t ?? "");
  swapResponse = E500; allowanceNow = 25_000_000n; mem.clear();
  let r = await (await import("../netlify/functions/agent-execute-plan.mjs")).handler(POST({ plan: [{ type: "swap_tokens", tokenIn: "USDC", tokenOut: "EURC", amountIn: 0.2 }] }));
  let b = parse(r); const s0 = b.results?.[0];
  check("a 500 on the swap tab → quoteFailed, the fault sentence with details", s0?.quoteFailed === true && !s0?.noRoute && fault(s0?.blocked), s0?.blocked?.slice(0, 80));
  brainFetch = async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ action: "swap_tokens", tokenIn: "USDC", tokenOut: "EURC", amountIn: 0.2, reasoning: "swap" }) }] }) });
  r = await (await import("../netlify/functions/agent-act.mjs")).handler(POST({ task: "swap 0.2 USDC to EURC" })); b = parse(r); brainFetch = null;
  check("a 500 in chat → 200 quoteFailed with the fault sentence", r.statusCode === 200 && b.quoteFailed === true && !b.noRoute && fault(b.notice));
  mem.clear();
  mem.set("job-runs/run:r1", JSON.stringify({ owner: OWNER, jobId: "j1" }));
  mem.set("job-deliverables/j1", JSON.stringify({ status: "completed", proposal: { action: "swap_tokens", tokenIn: "USDC", tokenOut: "EURC", amountIn: 0.2, reasoning: "r" } }));
  r = await (await import("../netlify/functions/job-swap-approve.mjs")).handler(POST({ runId: "r1" })); b = parse(r);
  check("a 500 on proposal approve → 502 quoteFailed (not the no-route 409)", r.statusCode === 502 && b.quoteFailed === true && fault(b.error));
  r = await (await import("../netlify/functions/user-swap-start.mjs")).handler(POST({ tokenIn: "USDC", tokenOut: "EURC", amountIn: 0.2 })); b = parse(r);
  check("a 500 on the own-wallet swap → 502, the user-path fault sentence, whole", r.statusCode === 502 && b.quoteFailed === true && fault(b.error) && /Nothing was signed/.test(b.error));
  swapResponse = NO_ROUTE;
}
{
  // C5 — the chat panel renders `noRoute` itself, before the "Your agent held off —" branch.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/components/MyAgentPanel.tsx", import.meta.url), "utf8");
  const iNo = src.indexOf("if (data.noRoute || data.quoteFailed)"), iBlocked = src.indexOf("if (data.blocked)"), iExec = src.indexOf("if (data.executed)");
  check("chat panel: a `noRoute || quoteFailed` branch exists and comes before `executed` and `blocked`", iNo > 0 && iNo < iExec && iNo < iBlocked);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
