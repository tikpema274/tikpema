# TikpemaPrediction — Agent Build Notes

What was built to let the Tikpema agent **analyze** and **bet on** parimutuel
prediction markets on Arc Testnet, how to exercise the read-only path safely,
and exactly where the seam is to make betting autonomous later.

_Network: Arc Testnet · chain ID `5042002` · RPC `https://rpc.testnet.arc.network` · explorer `https://testnet.arcscan.app`_
_Contract: `TikpemaPrediction` @ `0xf38492403ce3f1c94ef6322b78c9024d26ed87e1` (USDC `0x3600…0000`, 6 decimals). Full contract analysis in [`PREDICT_FINDINGS.md`](./PREDICT_FINDINGS.md)._

## Files

| File | Plane | Touches keys? | Role |
|---|---|---|---|
| `netlify/functions/_arc.mjs` | shared | no | Arc constants + `CONTRACTS.TIKPEMA_PREDICTION`, `json()` / `parseBody()` helpers |
| `netlify/functions/_predict.mjs` | **read** | no | viem public client, read-only ABI, `readMarket()` (normalized snapshot), `isBettable()` |
| `netlify/functions/predict-analyze.mjs` | **read** | no | `POST /api/predict-analyze` — reads a market, asks Claude (web search on) for a YES/NO recommendation |
| `netlify/functions/predict-bet.mjs` | **write** | yes | `POST /api/predict-bet` — guards, then `approve` + `placeBet` from the agent's own wallet |
| `netlify/functions/_circle.mjs` | **write** | yes | SECRET plane: `circle()` SDK client + `waitForTx()` (pre-existing, reused) |

The two planes are kept physically separate. `_predict.mjs` only reads over the
public RPC and never imports `_circle.mjs`; the secret plane is touched **only**
by `predict-bet.mjs`. `predict-analyze.mjs` cannot move funds — it has no path to
a signer.

### `predict-analyze.mjs` — READ ONLY

- Input: `{ marketId }`.
- Reads the market (question, category, resolution source, deadline, status,
  pools) and current implied probabilities via a viem public client on Arc RPC.
- Calls Claude (`PREDICT_MODEL`, default `claude-opus-4-8`) with the web search
  server tool `{ type: "web_search_20260209", name: "web_search" }` — GA, no beta
  header, dynamic filtering built in. Reuses the Anthropic fetch pattern from
  `agent-act.mjs`, plus the `tools` array.
- **`pause_turn` handling:** web search runs a server-side loop; if it hits the
  built-in 10-iteration cap it returns `stop_reason: "pause_turn"` with partial
  work. `analyze()` resumes by appending the assistant turn verbatim and
  re-sending (no injected "continue" message), capped at `MAX_CONTINUATIONS = 3`.
  If it's still paused after the cap and no decision parsed, the response carries
  a specific `warning` instead of the generic unparseable-output message.
- Returns the market snapshot plus a structured decision:
  `{ side: "yes"|"no", confidence: 0..1, reasoning, suggestedAmountUsdc }`.
  `decision` is `null` (with `raw` + `warning`) if the model output won't parse.

### `predict-bet.mjs` — EXECUTES

- Input: `{ marketId, isYes, amountUsdc }`.
- **Guards, enforced in code (not by any model):**
  - market must exist, be `OPEN`, and be **before its betting deadline**
    (checked against on-chain `block.timestamp`, not wall-clock);
  - `amountUsdc > 0` and `amountUsdc ≤ AGENT_MAX_SPEND_USDC` (default `1`).
- On pass: `approve(TIKPEMA_PREDICTION, units)` on USDC, then
  `placeBet(marketId, isYes, units)` — both via Circle
  `createContractExecutionTransaction` from `AGENT_WALLET_ADDRESS`, gas sponsored.
  Each step is awaited through `waitForTx`. A still-pending tx returns `202`
  with the tx id (submitted-but-slow ≠ failed).

## Environment

Server-side only (never `VITE_`-prefixed). See `.env.example` for the rest.

| Var | Used by | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | analyze | required |
| `PREDICT_MODEL` | analyze | optional, defaults to `claude-opus-4-8` (not yet in `.env.example`) |
| `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` | bet | required to sign/submit |
| `AGENT_WALLET_ADDRESS` | bet | the agent's own dev-controlled wallet (from `agent-init`) |
| `AGENT_MAX_SPEND_USDC` | bet | spend cap per bet, default `1` |

## Test the read-only path first (safe — no transactions)

`predict-analyze` cannot spend funds, so it's the safe place to start. It does
make a billable Anthropic call (web search), but nothing on-chain.

1. Set `ANTHROPIC_API_KEY` (and optionally `PREDICT_MODEL`) in `.env`.
2. Start the dev server: `npm run dev` (runs `netlify dev`, which serves the
   `/api/*` redirects from `netlify.toml`).
3. Hit a real market. `nextMarketId` was `7` at last check, so ids `0..6` exist:

   ```sh
   curl -s localhost:8888/api/predict-analyze \
     -H 'content-type: application/json' \
     -d '{"marketId": 0}' | jq
   ```

4. Expect a `200` with `market` (the snapshot), `model`, and `decision`
   (`{ side, confidence, reasoning, suggestedAmountUsdc }`). If `decision` is
   `null`, check `raw` and `warning`.

**Sanity checks before trusting it:**
- `market.status` and `market.probabilities` match what the explorer shows for
  that market — confirms the read path and ABI decoding.
- A bad id returns `404` ("not found"); a non-integer returns `400`.
- Re-run on a market with thin/total pools and confirm `suggestedAmountUsdc`
  is `0` when the model judges the market efficient or evidence thin.

Only after the read path looks right should you exercise `predict-bet` — and
even then, start with `amountUsdc` well under `AGENT_MAX_SPEND_USDC` against a
market you're willing to lose stake on. `predict-bet` moves real testnet USDC.

## The seam for autonomous betting

Today the loop is **deliberately broken in the middle**: `predict-analyze`
*advises*, a human reads the decision, and a separate explicit call to
`predict-bet` *commits* funds. The shapes line up one-to-one:

```
predict-analyze → { side, confidence, suggestedAmountUsdc }
                          │
                          │  ← the seam: nothing crosses this automatically today
                          ▼
predict-bet     ← { marketId, isYes, amountUsdc }
```

To close the loop later, add a thin **orchestrator** (e.g. a new
`predict-auto.mjs` or a scheduled job) that:

1. calls `analyze(marketId)`;
2. applies a **policy** the model does not control — e.g. only bet when
   `confidence ≥ THRESHOLD` and `suggestedAmountUsdc > 0`;
3. maps `side === "yes"` → `isYes`, and `min(suggestedAmountUsdc, cap)` →
   `amountUsdc`;
4. calls the same `predict-bet` execution path.

**Keep the enforcement in `predict-bet`, not the orchestrator.** The market /
deadline / status / `AGENT_MAX_SPEND_USDC` guards already live in the execution
function and run regardless of who calls it — that's the security boundary, and
it must stay the last word even when the caller is a model instead of a human.
The orchestrator's confidence threshold is an *additional* gate on top, never a
replacement.

Things to decide before turning it on (intentionally out of scope here):
- a daily/total spend budget across bets (the current cap is per-bet only);
- idempotency / "already bet this market" tracking (the contract lets you bet
  the same market repeatedly — an autonomous loop could stack stakes);
- which markets are eligible (category allow-list, minimum liquidity);
- how `pause_turn`-capped or `null` decisions are treated (must be a no-bet).

Until that orchestrator exists and is reviewed, autonomy stays off by
construction: there is no code path from `analyze` output to `predict-bet`
input.
