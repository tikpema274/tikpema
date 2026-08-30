import { AppKit } from "@circle-fin/app-kit";
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";
import { createViemAdapterFromProvider, resolveChainIdentifier } from "@circle-fin/adapter-viem-v2";
import { circle, waitForTx, TxPendingError } from "./_circle.mjs";
import { CONTRACTS, ARC, USDC_DECIMALS, swapCapUsdc } from "./_arc.mjs";
import { publicClient } from "./_predict.mjs";
import { withRetry } from "./_retry.mjs";

// SWAP PLANE. Pricing/estimates still go through App Kit + the Circle Wallets adapter
// (kitAndAdapter, below), but the EXECUTING swap now runs the proven B1 path
// (createSwap HTTP quote → viem-adapter getCallData → createContractExecutionTransaction),
// NOT kit.swap() — that path submits async and cannot be confirm-gated. Arc Testnet: USDC/EURC only.

export const SWAP_TOKENS = ["USDC", "EURC"];

// ── B1 swap-execution constants (proven in scripts/spikes/spike-B1-direct-calldata.mjs) ──────────
const SWAP_ADAPTER = "0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b"; // ground-truth AdapterContract (Arc testnet)
const SWAP_URL = "https://api.circle.com/v1/stablecoinKits/swap";
// The quote carries a deadline; submit ONLY with this much margin left, so the tx can't expire in the
// mempool between build and mine. On-chain revert-on-expiry is the ultimate backstop (see agentSwap).
const DEADLINE_SAFETY_MS = 20_000;
const ALLOWANCE_ABI = [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] }];
const toMinor = (human) => BigInt(Math.round(Number(human) * 10 ** USDC_DECIMALS));

function kitAndAdapter() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const kitKey = process.env.KIT_KEY;
  if (!apiKey || !entitySecret) {
    throw new Error("Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET (server env)");
  }
  if (!kitKey) {
    throw new Error("Missing KIT_KEY (server env) — required for App Kit Swap");
  }
  const adapter = createCircleWalletsAdapter({ apiKey, entitySecret });
  return { kit: new AppKit(), adapter, kitKey };
}

// Value a token amount in USD via App Kit's cached token rates. USDC is treated
// as ~$1 (no lookup). For other tokens we read the single returned rate entry
// (avoids address-case bugs).
//
// ⚠️ THIS FUNCTION IS A CAP INPUT, SO IT MUST NEVER RETURN NaN. Its result is compared with `>`
// against a limit at FIVE sites — _proposal.mjs:165 (propose), job-swap-approve.mjs:124
// (execute), _actions.mjs:123 (day ceiling), agent-execute-plan.mjs:66 (plan ceiling), and
// agent-act.mjs — and every comparison against NaN is FALSE. One NaN therefore disables five
// caps at once, and the propose/approve pair compounds: an unbounded swap gets proposed, then
// approved, with the day ceiling that should backstop it ALSO NaN-poisoned.
//
// It used to return NaN two ways:
//   1. `if (t === "USDC") return amt` with amt unvalidated — a garbled amount returned NaN.
//   2. `if (!entry?.priceUSD) throw` only rejects FALSY. A truthy non-numeric rate — "N/A",
//      "unavailable", "1,08" (decimal comma), an object — sailed through, and
//      `amt * Number("N/A")` is NaN.
//
// So it now THROWS on anything it cannot turn into a finite positive number. That is the right
// failure direction and it needs no caller changes: every caller already treats a throw as
// "cannot price it → refuse". job-swap-approve returns 409 "cannot price {token} right now —
// not approving blind"; _proposal returns null (no proposal). An upstream rate glitch must
// REFUSE the swap, never silently un-cap it.
export async function valueInUsdc({ token, amount }) {
  const t = String(token).toUpperCase();
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error(`cannot value ${t}: amount ${JSON.stringify(amount)} is not a positive finite number`);
  }
  if (t === "USDC") return amt;

  const { kit, kitKey } = kitAndAdapter();
  const r = await kit.getTokenRates({ chain: "Arc_Testnet", tokens: [t], kitKey });
  const entry = Object.values(r?.rates?.Arc_Testnet || {})[0];
  if (!entry?.priceUSD) throw new Error(`no USD rate for ${t} on Arc Testnet`);

  // The rate must PARSE, not merely exist. `Number(x)` on a truthy non-numeric yields NaN, and
  // a NaN price is indistinguishable downstream from "no cap applies".
  const price = Number(entry.priceUSD);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(
      `unusable USD rate for ${t} on Arc Testnet: ${JSON.stringify(entry.priceUSD)} — refusing to value it ` +
        `(a NaN price would silently defeat every cap comparing against it)`
    );
  }

  const value = amt * price;
  // Belt and braces: the product of two finite numbers is finite, but this function's ONLY
  // contract is "a finite positive USD value, or throw". Assert it rather than assume it.
  if (!Number.isFinite(value)) {
    throw new Error(`computed a non-finite USD value for ${amt} ${t} at rate ${price}`);
  }
  return value;
}

// Estimate then execute a same-chain swap on Arc Testnet from the agent wallet.
// tokenIn/tokenOut are symbols from SWAP_TOKENS; amountIn is a human decimal
// string ("1.00"). Returns { estimate, txHash, explorerUrl }.
// The swap request, built ONCE so the estimate and the execution can never drift apart.
// A proposal priced with different params than the swap that later executes would be a lie
// at approve time — the same class of bug the bridge avoids by re-pricing from IRIS.
function buildSwapParams({ walletAddress, tokenIn, tokenOut, amountIn }) {
  const { kit, adapter, kitKey } = kitAndAdapter();
  return {
    kit,
    swapParams: {
      from: { adapter, chain: "Arc_Testnet", address: walletAddress },
      tokenIn,
      tokenOut,
      // ⚠️ App Kit REQUIRES a human-decimal STRING here. Passing a number throws
      // "Invalid swap parameters: amountIn: Expected string, received number" — which
      // _proposal.mjs would then swallow as "cannot price it → no proposal", silently making
      // every swap unproposable. Callers used to coerce this themselves (_actions.mjs did,
      // validateSwapProposal didn't); coercing HERE means neither can get it wrong again.
      amountIn: String(amountIn),
      // The agent wallet is a dev-controlled SCA. App Kit defaults to a USDC permit
      // (EIP-2612) signature, but permits use ecrecover, which rejects an SCA's
      // ERC-1271 signature — so the swap fails with "Transaction hash is required".
      // Forcing an onchain approve makes the SCA path work.
      allowanceStrategy: "approve",
      // ⛔ THIS SLIPPAGE BOUND APPLIES TO THE ESTIMATE ONLY — IT NEVER REACHES A REAL SWAP.
      // `buildSwapParams` has exactly ONE caller: `estimateSwapOnly` below. The EXECUTING path is
      // the B1 extraction in `agentSwap`, which POSTs to `createSwap` and sends NO slippage field,
      // so the `minTokenOut` that actually binds a swap comes back from Circle and is not this.
      //
      // 🚨 THE ROOT OF A CLAIM THAT SPREAD. This comment used to end "— the swap reverts rather than
      // filling at a bad rate", and two other comments inherited it (jobTimeline's SwapProposalBody,
      // _proposal's indicativeAmountOut), where it became a statement about what protects the user.
      // It was false in all three: the tolerance here is intentional for the QUOTE, and nothing more.
      // ⚠️ The B1 refactor moved the executing path off `kit.swap()` and no comment followed.
      // ⛔ No percentage is asserted in its place — see docs/swap-slippage-copy-overclaim.md.
      config: { kitKey, slippageBps: 100 },
    },
  };
}

// READ-ONLY live re-price. The swap analogue of _bridge.mjs's bridgeFee(): _proposal.mjs
// calls this to price a swap proposal from the CHAIN rather than trusting the model's
// numbers, exactly as the bridge re-prices its fee from IRIS. estimateSwap is free and
// moves nothing — no approve, no swap, no signature.
//
// Priced against the USER'S OWN wallet (walletAddress), so the quote is the one that wallet
// would actually get. Throws on any failure — the caller must treat "cannot price it" as
// "cannot honestly propose it" and return null.
export async function estimateSwapOnly({ walletAddress, tokenIn, tokenOut, amountIn }) {
  const { kit, swapParams } = buildSwapParams({ walletAddress, tokenIn, tokenOut, amountIn });
  return kit.estimateSwap(swapParams);
}

// ══ ⭐⭐ THE BENEFICIARY ASSERT — "we asked Circle for X; prove X came back" ═══════════════════════
//
// 🚨 WHY A SECOND ASSERT IS NEEDED WHEN `cd.to` IS ALREADY CHECKED, AND WHY THE FIRST CANNOT COVER IT.
// MEASURED on Arc testnet (docs/swap-adapter-payer-beneficiary-unbound.md): the AdapterContract does
// NOT bind the payer to the beneficiary. A payload issued for address X executes successfully when
// submitted by a DIFFERENT address Y — pulling tokenIn from Y and delivering tokenOut to X. Two roles,
// decided by two different things:
//     who PAYS     = msg.sender                       (whoever signs and submits)
//     who RECEIVES = tokens[].beneficiary              (inside the Circle-signed payload)
// ⭐ Circle's own SDK states the first half outright: "The contract derives the token owner from
// msg.sender, so no `from` field is needed."
//
// ⛔ A PAYLOAD WITH A FOREIGN BENEFICIARY STILL TARGETS THE ADAPTER, so `cd.to === SWAP_ADAPTER` is
// still TRUE and the existing guard passes it. The two failures are independent; only one was guarded.
// This is a TRUST-BOUNDARY assert, not a fix for a live vulnerability — see the doc for why no caller
// of ours can reach it today, and why it becomes load-bearing the moment a swap is USER-SIGNED.
//
// ⭐ SELECTED BY TOKEN, NEVER BY POSITION. `EP.tokens` carries one entry per leg and their order is
// not ours to assume. The sibling array `EP.instructions` has ALREADY caused exactly this misread in
// this investigation: `instructions[0]` is the FEE leg with `minTokenOut: 0`, and reading index 0
// alone reported "this swap has no floor at all". An index is a filter.
//
// ⚠️ AMBIGUITY REFUSES — it never falls back to an index. No matching entry, disagreeing beneficiaries
// among the matches, or a token that is simultaneously in and out: all throw. "Cannot tell" is not
// permission to guess at a destination for money.
export function assertSwapBeneficiary({ tokens, tokenInAddress, tokenOutAddress, walletAddress }) {
  const norm = (a) => String(a ?? "").toLowerCase();
  const out = norm(tokenOutAddress);
  const want = norm(walletAddress);
  if (!out || !want) throw new Error("beneficiary check: missing tokenOut or wallet address — refusing to submit");

  // A same-token swap makes "the tokenOut entry" undecidable; it is also not a swap. Refuse first,
  // so the ambiguity can never be resolved by picking one.
  if (out === norm(tokenInAddress)) {
    throw new Error(`beneficiary check: tokenIn and tokenOut are the same token (${out}) — the payload's output leg is ambiguous, refusing to submit`);
  }

  const list = Array.isArray(tokens) ? tokens : null;
  if (!list || list.length === 0) throw new Error("beneficiary check: createSwap returned no `tokens` entries — refusing to submit");

  const matches = list.filter((t) => norm(t?.token) === out);
  if (matches.length === 0) {
    throw new Error(
      `beneficiary check: no \`tokens\` entry for tokenOut ${out} in the createSwap response ` +
        `(saw ${list.map((t) => norm(t?.token)).join(", ") || "nothing"}) — refusing to submit`
    );
  }
  const distinct = [...new Set(matches.map((t) => norm(t?.beneficiary)))];
  if (distinct.length > 1) {
    throw new Error(
      `beneficiary check: ${matches.length} tokens entries for tokenOut ${out} name DIFFERENT beneficiaries ` +
        `(${distinct.join(", ")}) — cannot tell which receives the output, refusing to submit`
    );
  }

  const got = distinct[0];
  if (!got || !/^0x[0-9a-f]{40}$/.test(got)) {
    throw new Error(`beneficiary check: tokenOut beneficiary is missing or malformed (${JSON.stringify(got)}) — refusing to submit`);
  }
  if (got !== want) {
    // ⭐ FAIL CLOSED, AND SAY WHY IN THESE WORDS: we ASKED for toAddress = walletAddress. If the echo
    // disagrees, then either the request or the response is wrong, and neither is a state to spend
    // from. We do not "prefer" one; we refuse both.
    throw new Error(
      `beneficiary check FAILED: we asked createSwap for toAddress ${want} but the returned payload ` +
        `delivers tokenOut to ${got}. Either the request or the response is wrong, and neither is a ` +
        `state to spend from — refusing to submit. (The adapter does not bind the payer to the ` +
        `beneficiary, so this payload WOULD have spent our funds into that address.)`
    );
  }
  return { beneficiary: got, matched: matches.length };
}

// ⚠️ NOT CHECKED HERE, AND THAT IS A DELIBERATE NON-DECISION RATHER THAN AN OVERSIGHT: the tokenIN
// entry's beneficiary (where leftover/refunded input would go) is also a money destination. It is out
// of scope for this assert, which was scoped to the output leg. Recorded so the gap is visible.

// ══ ⭐ THE B1 EXTRACTION, LIFTED SO A USER-SIGNED PATH CAN REUSE IT ══════════════════════════════
// `agentSwap` used to hold this inline. It is lifted VERBATIM — same quote call, same SDK-verbatim
// transform, same deadline guard, same beneficiary assert, same hard adapter assert — so the
// user-signed swap and the agent swap are byte-identical in how they build a swap. The alternative
// (reimplementing the tuple for the browser path) is exactly the drift `bridgeCallData` was exported
// to prevent: "a MetaMask burn must be byte-identical to the agent's, and the only way to guarantee
// that is to build it here — once".
//
// ⛔ IT SIGNS NOTHING AND SUBMITS NOTHING. The viem adapter is constructed with a provider stub that
// THROWS if called, and `getCallData` is pure encodeFunctionData. This returns bytes; who signs them
// is the caller's business.
//
// ⚠️ `walletAddress` is the address the payload is built FOR. On the agent path that is the agent's
// SCA; on the user path it is the caller's own EOA, resolved from the session — never from a body.
export async function buildSwapCallData({ walletAddress, tokenIn, tokenOut, amountIn }) {
  const tIn = String(tokenIn).toUpperCase();
  const tOut = String(tokenOut).toUpperCase();
  const tokenInAddress = CONTRACTS[tIn];
  const tokenOutAddress = CONTRACTS[tOut];
  if (!tokenInAddress || !tokenOutAddress) throw new Error(`unsupported swap ${tIn}->${tOut} (USDC/EURC only)`);
  const kitKey = process.env.KIT_KEY;
  if (!kitKey) throw new Error("Missing KIT_KEY (server env) — required for the swap quote");
  const amountBase = toMinor(amountIn);

  const res = await fetch(SWAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${kitKey}` },
    body: JSON.stringify({ tokenInAddress, tokenOutAddress, tokenInChain: "Arc_Testnet", fromAddress: walletAddress, toAddress: walletAddress, amount: amountBase.toString() }),
  });
  if (!res.ok) throw new Error(`createSwap HTTP ${res.status}: ${(await res.text()).slice(0, 180)}`);
  const body = await res.json();
  const q = body?.data ?? body;
  const T = q?.transaction;
  const EP = T?.executionParams;
  if (!EP || typeof T.signature !== "string") throw new Error("createSwap response missing executionParams/signature");

  const deadlineMs = Number(EP.deadline) * 1000;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now() + DEADLINE_SAFETY_MS) {
    throw new Error(`swap quote deadline too close (${EP.deadline}) — refusing to issue calldata`);
  }
  assertSwapBeneficiary({ tokens: EP.tokens, tokenInAddress, tokenOutAddress, walletAddress });

  const executeParams = {
    instructions: EP.instructions.map((i) => ({ target: i.target, data: i.data, value: BigInt(i.value), tokenIn: i.tokenIn, amountToApprove: BigInt(i.amountToApprove), tokenOut: i.tokenOut, minTokenOut: BigInt(i.minTokenOut) })),
    tokens: EP.tokens.map((t) => ({ token: t.token, beneficiary: t.beneficiary })),
    execId: BigInt(EP.execId),
    deadline: BigInt(EP.deadline),
    metadata: EP.metadata,
  };
  const tokenInputs = [{ permitType: 0, token: tokenInAddress, amount: amountBase, permitCalldata: "0x" }];

  const swapAdapter = await createViemAdapterFromProvider({
    provider: { request: async () => { throw new Error("read-only swap adapter: provider must never be called"); } },
    getPublicClient: () => publicClient(),
    capabilities: { addressContext: "developer-controlled" },
  });
  const prepared = await swapAdapter.prepareAction(
    "swap.execute",
    { executeParams, tokenInputs, signature: T.signature, inputAmount: amountBase, tokenInAddress },
    { chain: resolveChainIdentifier("Arc_Testnet"), address: walletAddress }
  );
  const cd = typeof prepared?.getCallData === "function" ? prepared.getCallData() : null;
  if (!cd || String(cd.to).toLowerCase() !== SWAP_ADAPTER) {
    throw new Error(`B1 adapter assert failed — calldata.to=${cd?.to ?? "none"} != ${SWAP_ADAPTER}; refusing to issue calldata`);
  }

  // The OUTPUT LEG's floor, selected BY TOKEN. ⛔ Never instructions[0] — that is the FEE leg, whose
  // minTokenOut is 0. The client re-derives this from the bytes independently; this copy is for the
  // disclosure, and the two are compared by scripts/verify-swap-calldata-decode.ts.
  const outLegs = EP.instructions.filter((i) => String(i.tokenOut).toLowerCase() === tokenOutAddress.toLowerCase());
  const floors = [...new Set(outLegs.map((i) => String(i.minTokenOut)))];
  if (floors.length !== 1) throw new Error(`cannot determine the guaranteed output (${floors.length} candidate floors) — refusing to issue calldata`);

  return {
    adapter: cd.to,
    calldata: cd.data,
    tokenInAddress,
    tokenOutAddress,
    amountMinor: amountBase.toString(),
    minTokenOut: floors[0],
    estimatedAmount: q?.estimatedAmount ?? null,
    fees: q?.fees ?? null,
    deadline: Number(EP.deadline),
  };
}

// Inline-confirm timed out but the SWAP IS SUBMITTED — a distinct signal (NOT a failure) that carries
// the authoritative circleId so a caller with an async net (dca-tick's id-reconcile) can poll
// getTransaction({id}) to COMPLETE next tick. Thrown ONLY from the swap-confirm wait (confirm:true), never
// from the approve wait — an approve timeout means the swap never submitted, so it stays a plain transient.
export class SwapPendingConfirm extends Error {
  constructor(circleId, approveId) {
    super("swap submitted — inline confirm timed out; awaiting id-reconcile");
    this.name = "SwapPendingConfirm";
    this.circleId = circleId;
    this.approveId = approveId ?? null;
  }
}

// This replaces the old kit.swap() body (async submit, un-confirmable).
//
// THREE STEPS, all inside agentSwap so the whole swap sits under executeAction's SINGLE cap/pause
// check (never a separate approve that dodges the cap):
//   (A) allowance → approve to the adapter if under (createContractExecutionTransaction → waitForTx COMPLETE).
//       HOW MUCH depends on the path (DESIGN-2): DCA approves EXACTLY amountIn; MANUAL approves a bounded
//       STANDING allowance == the per-swap cap. Never max-uint. See the block at step (A) for why.
//   (B) B1 extraction: createSwap HTTP quote → viem-adapter getCallData → { to, data }, HARD-asserted to == adapter
//   (C) submit { to, data } via createContractExecutionTransaction → authoritative Circle id
//
// CONFIRM MODE (the sync-timeout fork — see dca-agentswap-refactor-state):
//   confirm=false (DEFAULT — MANUAL paths: agent-act / execute-plan / job-swap-approve, all SYNC ~10s
//     handlers): submit-and-return { circleId, state:"submitted" }. They keep their existing async
//     verification (job-swap-approve → job-swap-receipt-background). Inline-confirm would blow the 10s budget.
//   confirm=true (DCA ONLY — dca-tick is scheduled, generous budget): INLINE-CONFIRM (Drill #1)
//     waitForTx(circleId) → COMPLETE before returning, like _bridge. On timeout it throws SwapPendingConfirm
//     (carrying circleId → dca-tick's id-reconcile net); on FAILED/revert it throws a plain Error. Either
//     throw reaches the caller BEFORE any ledger runs → no spentAmount / recordDcaSpend / recordAgentSpend
//     advances on an unconfirmed swap.
export async function agentSwap({ walletAddress, tokenIn, tokenOut, amountIn, confirm = false }) {
  const tIn = String(tokenIn).toUpperCase();
  const tOut = String(tokenOut).toUpperCase();
  const tokenInAddress = CONTRACTS[tIn];
  const tokenOutAddress = CONTRACTS[tOut];
  if (!tokenInAddress || !tokenOutAddress) throw new Error(`unsupported swap ${tIn}->${tOut} (USDC/EURC only)`);
  const kitKey = process.env.KIT_KEY;
  if (!kitKey) throw new Error("Missing KIT_KEY (server env) — required for the swap quote");
  const amountBase = toMinor(amountIn); // 6-dp minor units (USDC & EURC are both 6-dp on Arc)
  const client = circle();

  // ── (A) ALLOWANCE — approve the adapter, ONLY when the current allowance can't cover this swap.
  //
  //        DESIGN-2 — HOW MUCH is approved differs by path:
  //          • DCA (confirm:true) — EXACTLY amountBase, unchanged. Its approve runs inside the SCHEDULED
  //            tick, off any sync budget, so paying an approve-wait per fill costs nothing and keeps the
  //            allowance back at ~0 between fills.
  //          • MANUAL (confirm:false) — a BOUNDED STANDING allowance == the per-swap cap. Exact-amount
  //            depletes to ~0 on every swap, so an approve fired on EVERY manual swap; measured in step 1,
  //            that inline approve-wait under an RPC throttle put the worst case at ~63s against Netlify's
  //            10s sync ceiling. A standing allowance means the approve fires roughly once per
  //            (cap ÷ amount) swaps instead of every one.
  //
  //        ⚠️ NEVER max-uint. The bound IS the cap, so a standing allowance can never authorise more than
  //        the ONE capped swap executeAction already approved. The approve also stays INSIDE agentSwap, so
  //        it sits under executeAction's SINGLE cap/pause check — no separate approve path dodges the cap
  //        (the swap-cap trap). The posture is unchanged; only "exact" became "standing".
  //        Trade: the exact-amount "zero allowance between swaps" property is gone. Worst-case blast radius
  //        for a malicious adapter goes from one in-flight swap to one cap — deliberate, and still bounded.
  //
  //        ACCEPTED, NOT ENGINEERED AROUND: the FIRST swap of each depletion cycle still pays the inline
  //        approve-wait (~60s worst case under throttle). It is safe and retryable. The 202-background-arm
  //        remains an UNBUILT escape hatch — build it only if real UX proves this unacceptable.
  //
  // ⚠️ RETRY-WRAPPED: this is the ONLY Arc-public-RPC read in agentSwap (audited: every other call is
  // Circle API — createContractExecutionTransaction / getTransaction — or the Circle stablecoin HTTP quote;
  // and the viem adapter's getPublicClient is NEVER invoked on the getCallData path, which is pure
  // encodeFunctionData). Arc answers a throttle with a JSON-RPC error ("RPC Request failed.") that viem does
  // NOT retry, so a bare read here fast-fails and kills the swap at the starting line (observed in step 2).
  // withRetry retries the transient class (isTransient matches "request limit"), same fix _swap-confirm.mjs
  // uses. retries:3 keeps worst-case backoff (~2.85s) inside the sync-handler / tick budgets. A genuine
  // revert is NOT transient and still surfaces immediately.
  let approveId = null;
  const allowance = await withRetry(
    () => publicClient().readContract({ address: tokenInAddress, abi: ALLOWANCE_ABI, functionName: "allowance", args: [walletAddress, SWAP_ADAPTER] }),
    { retries: 3, label: "swap allowance read" }
  );
  // The TRIGGER is unchanged: approve only when the standing allowance can't cover THIS swap. That is the
  // point of Design-2 — a standing allowance that already covers the amount skips the approve entirely.
  if (allowance < amountBase) {
    let approveBase = amountBase; // DCA (confirm:true) keeps exact-amount

    if (!confirm) {
      // MANUAL: bound the standing allowance to the per-swap cap. The value comes from swapCapUsdc() —
      // the SAME fail-closed helper the cap gate, agent-act, job-swap-approve and dca-tick all read — and
      // NEVER an inline number, so the allowance bound and the enforced cap cannot drift apart. A garbled
      // AGENT_SWAP_CAP_USDC throws in that helper, so a misconfigured cap REFUSES to approve (fail-closed).
      //
      // Price the cap into tokenIn units: USDC is 1:1 and needs no pricing (valueInUsdc returns the amount
      // unchanged, with no network call); EURC is priced so the allowance is genuinely ≤ the USD cap rather
      // than 1 EURC ≙ 1 USD. An unpriceable EURC THROWS here — the same fail-closed answer executeAction's
      // cap gate already gives upstream (it prices the swap via valueInUsdc BEFORE agentSwap is reached),
      // so this adds no new failure surface, only consistency.
      const unitUsd = await valueInUsdc({ token: tIn, amount: 1 });
      // ceil, so capBase is never a rounding unit BELOW the true cap — otherwise an at-limit swap could be
      // left with an allowance one base unit short of its own amount.
      const capBase = BigInt(Math.ceil((swapCapUsdc() / unitUsd) * 10 ** USDC_DECIMALS));
      if (capBase < amountBase) {
        // Unreachable via executeAction — its cap gate refuses an over-cap swap before agentSwap, and the
        // swap-cap trap proves agentSwap has exactly one caller. Defence in depth: refuse, never widen.
        throw new Error(
          `swap amount (${amountIn} ${tIn}) exceeds the per-swap cap (${swapCapUsdc()} USDC) — refusing to approve`
        );
      }
      approveBase = capBase;
    }

    const ap = await client.createContractExecutionTransaction({
      walletAddress,
      blockchain: ARC.blockchain,
      contractAddress: tokenInAddress,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [SWAP_ADAPTER, approveBase.toString()],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    approveId = ap.data?.id;
    await waitForTx(client, approveId); // must LAND before the quote/submit — else tokenInputs would need a permit
  }

  // ── (B) B1 EXTRACTION — createSwap HTTP quote (key VERBATIM: it already carries the "KIT_KEY:" prefix;
  //        re-prepending it was the 401), then viem-adapter getCallData (pure encodeFunctionData, no signing).
  const res = await fetch(SWAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${kitKey}` },
    body: JSON.stringify({ tokenInAddress, tokenOutAddress, tokenInChain: "Arc_Testnet", fromAddress: walletAddress, toAddress: walletAddress, amount: amountBase.toString() }),
  });
  if (!res.ok) throw new Error(`createSwap HTTP ${res.status}: ${(await res.text()).slice(0, 180)}`);
  const body = await res.json();
  const q = body?.data ?? body;
  const T = q?.transaction;
  const EP = T?.executionParams;
  if (!EP || typeof T.signature !== "string") throw new Error("createSwap response missing executionParams/signature");

  // DEADLINE pre-submit guard (the residual): submit only with a safety margin left. The AdapterContract
  // ALSO reverts on-chain if the deadline has passed (revert = no funds moved = no ledger) — the ultimate
  // backstop. ⚠️ RE-PROVE ASSUMPTION: verify AdapterContract reverts on deadline expiry (the one on-chain
  // assumption this path leans on).
  const deadlineMs = Number(EP.deadline) * 1000;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now() + DEADLINE_SAFETY_MS) {
    throw new Error(`swap quote deadline too close (${EP.deadline}) — refusing to submit`);
  }

  // ⭐ BENEFICIARY GUARD — validate the response against what we ASKED for, before any calldata is
  // built and long before anything is submitted. See assertSwapBeneficiary above for why the
  // `cd.to` assert below cannot cover this case.
  assertSwapBeneficiary({ tokens: EP.tokens, tokenInAddress, tokenOutAddress, walletAddress });

  // SDK-VERBATIM transform of the response (swap-kit prepareEvmSwapAction:14128-14165). BigInt = its safeBigInt.
  const executeParams = {
    instructions: EP.instructions.map((i) => ({ target: i.target, data: i.data, value: BigInt(i.value), tokenIn: i.tokenIn, amountToApprove: BigInt(i.amountToApprove), tokenOut: i.tokenOut, minTokenOut: BigInt(i.minTokenOut) })),
    tokens: EP.tokens.map((t) => ({ token: t.token, beneficiary: t.beneficiary })),
    execId: BigInt(EP.execId),
    deadline: BigInt(EP.deadline),
    metadata: EP.metadata,
  };
  const tokenInputs = [{ permitType: 0, token: tokenInAddress, amount: amountBase, permitCalldata: "0x" }]; // createFallbackTokenInput (PermitType.NONE — allowance-backed, from step A)

  // Read-only viem adapter: getCallData is pure encodeFunctionData; the provider stub is NEVER called
  // (getCallData does not sign), so this can neither submit nor spend.
  const swapAdapter = await createViemAdapterFromProvider({
    provider: { request: async () => { throw new Error("read-only swap adapter: provider must never be called"); } },
    getPublicClient: () => publicClient(),
    capabilities: { addressContext: "developer-controlled" },
  });
  const prepared = await swapAdapter.prepareAction(
    "swap.execute",
    { executeParams, tokenInputs, signature: T.signature, inputAmount: amountBase, tokenInAddress },
    { chain: resolveChainIdentifier("Arc_Testnet"), address: walletAddress }
  );
  const cd = typeof prepared?.getCallData === "function" ? prepared.getCallData() : null;

  // HARD ADAPTER ASSERT — this guard caught a real false positive (an inner DEX-leg target) during B1.
  // Abort on ANY mismatch; nothing has been submitted at this point.
  // ⚠️ THIS CHECKS THE DESTINATION CONTRACT, NOT THE DESTINATION OF THE MONEY. A payload paying a
  // stranger still targets the adapter and still passes here — that is assertSwapBeneficiary's job,
  // run above. Neither assert is sufficient alone.
  if (!cd || String(cd.to).toLowerCase() !== SWAP_ADAPTER) {
    throw new Error(`B1 adapter assert failed — calldata.to=${cd?.to ?? "none"} != ${SWAP_ADAPTER}; refusing to submit`);
  }

  // ── (C) SUBMIT the extracted { to, data } → authoritative Circle id (dev-controlled createContractExecution).
  const sw = await client.createContractExecutionTransaction({
    walletAddress,
    blockchain: ARC.blockchain,
    contractAddress: cd.to,
    callData: cd.data,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const circleId = sw.data?.id;

  // estimate derived from the SAME authoritative quote (no second, drifting estimate call).
  const estimate = { tokenOut: tOut, amountOut: q?.estimatedAmount ?? null, fees: q?.fees ?? null, route: q?.route ?? null };

  // ── MANUAL (confirm:false) — submit-and-return. The caller's async verifier (job-swap-receipt-
  //    background) confirms later via getTransaction({id:circleId}). Fast return keeps the sync 10s handler safe.
  if (!confirm) {
    return { circleId, approveId, estimate, txHash: null, state: "submitted" };
  }

  // ── DCA (confirm:true) — INLINE CONFIRM (Drill #1): wait to COMPLETE before returning, like _bridge.
  //    Distinguish the two throw kinds so the caller can route them:
  //      • TxPendingError (timeout) → SwapPendingConfirm(circleId): the swap IS submitted, hand it to the
  //        id-reconcile net (a slow-but-real fill must never be abandoned un-ledgered). NOT a failure.
  //      • any other throw (FAILED / on-chain revert incl. deadline expiry) → propagate as a genuine failure.
  //    In BOTH cases the caller's ledger never runs (the throw short-circuits it) → nothing advances unconfirmed.
  let txHash;
  try {
    txHash = await waitForTx(client, circleId);
  } catch (e) {
    if (e instanceof TxPendingError) throw new SwapPendingConfirm(circleId, approveId);
    throw e;
  }
  return { circleId, approveId, estimate, txHash, explorerUrl: `${ARC.explorer}/tx/${txHash}`, state: "confirmed" };
}
