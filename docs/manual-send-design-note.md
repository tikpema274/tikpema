# DESIGN NOTE — a manual (user-signed) SEND alongside the agent send

**2026-08-29.** Read-only investigation, written before any code. Scope: **send only.** Swap is
deliberately unscoped — see the last section for why, which is the whole record of that decision.

Established going in: `fundAgentWallet` (`src/wallet/connectors/metamask.ts:289`) is a user-signed
ERC-20 transfer. A manual send is that with a caller-supplied destination.

---

## ⚠️ THE TWO OPEN GAPS ON THE MANUAL BRIDGE — checked against CODE, not just the record

### Gap 1 — the ack gate has never fired for a user-signed bridge: **STILL OPEN**

`PROGRESS.md:392` (2026-08-28) stands. ⚠️ The earlier *"the acknowledge band DID fire"* entry
(`PROGRESS.md:10379`, 2026-08-14) is the **AGENT** path — a different surface, and it does not
transfer. Nothing in code can close this; it needs a live run whose fee crosses 25%, roughly
≤0.22 USDC on that route.

### Gap 2 — the two-state copy collapse: **STILL OPEN, and larger than recorded**

`ManualBridgePanel.tsx` returns one message for every non-MetaMask state. The recorded fix —
*"branch on whether a MetaMask wallet exists"* — **cannot be done in the panel at all.**
`useWallet`'s return exposes `activeKind` and `connectors` (whose `isAvailable` means *the extension
is installed*, not *connected*), and never surfaces `mmWallet` presence. **The fact needed to tell
the two states apart is held inside the hook and not exported.** This is a hook change, not a copy
change, and that is why it is step 1 rather than a detail of step 3.

⚠️ **`verify-manual-bridge-copy.tsx` §4 gives ZERO coverage of this.** Its stub is
`{ activeKind }` only, so it cannot represent *connected but not active* — §4 renders identically
in the defective and the fixed world and passes in both. Not a guard pinning the defect; a guard
blind to it. [[binding-tested-across-what-it-binds]]

### ⭐ WHICH GAP PROPAGATES — the answer that orders the work

**Gap 1 does not propagate.** A send has no ack gate (§4 below), so there is no untested gate to
inherit.

**Gap 2 propagates exactly.** A manual send panel needs the same `if (!isMetaMask)` guard and would
ship the same collapsed message a second time. ⛔ **So it is fixed FIRST, in the hook, where both
panels get it** — not worked around twice.

---

## 1. WHAT CHANGES vs `fundAgentWallet`

Today: validate `0x`+40 hex → refuse the SHARED agent wallet → refuse self → `amount > 0` →
`ensureBalance` (amount + gas headroom; an EOA pays its own gas) → `transfer` →
`waitForTransactionReceipt` → refresh.

**One thing changes, and it changes what the guards around it MEAN.** The SEAM comment states the
current property outright: *"the destination is not arbitrary — it is the caller's own
server-resolved agent wallet, and we refuse anything else."* A manual send **inverts exactly that.**

| guard | today | under a caller-supplied destination |
|---|---|---|
| refuse the shared agent wallet | safety | **safety — keep unchanged** |
| refuse self | safety ("funds would go nowhere") | ⚠️ **a MISTAKE-CATCH, not a safety property.** Keep it, and describe it honestly: sending to yourself is a no-op, not a danger. Calling it safety would inflate what it protects |
| the allowlist | the destination is server-resolved | **gone entirely** |

🚨 **The one genuinely new risk: a mistyped address on a same-chain transfer is irreversible, with
no server-side check standing behind it.** That is what the confirmation UI is for, and the only
thing it is for.

**Confirmation UI.** MetaMask already shows destination and amount before signing, so ours is not a
second safety net. It earns its place on one job: showing the address **as WE parsed it**, catching
a truncated or whitespace-damaged paste *before* it reaches MetaMask. One inline confirm step. Not a
modal chain.

## 2. ⭐ DOES IT NEED A RECEIPT? NO — and adding one is net negative

Argued from what a receipt BUYS, not from symmetry with bridge.

**The bridge receipt exists for three reasons and NONE survives the move to same-chain:**

| bridge | same-chain send |
|---|---|
| delivery is on ANOTHER chain, establishable only by a server-side destination read | delivery **is** the transaction |
| the delivered amount differs from the sent amount (fee taken from it) — hence the six-source reconciliation at `PROGRESS.md:365` | amount received **==** amount sent. Nothing to reconcile |
| the estimate→measured split needs a record to advance through | there is no estimate to advance from |

What a receipt WOULD buy is **a send history** — "did I send to X on the 12th". That is a product
feature to decide on its own merits and must not borrow the bridge's justification.

⛔ **AND IT COSTS SOMETHING REAL.** A receipt means a write-after-sign, which re-creates the
bridge's *"stay on this page until the burn confirms"* window — a gap between money moving and the
record existing. The bridge accepts that window because its record is load-bearing. A send would be
accepting it **to gain a convenience, with nothing recoverable inside it.**
`waitForTransactionReceipt` already returns a confirmed on-chain receipt synchronously.

⚠️ Note the agent path's records exist to serve the **day-ceiling counter**, not delivery. A manual
send has no ceiling, so even that reason is absent.

## 3. AGENT CAPS — they do not apply, and the contrast is currently INVISIBLE

They do not apply: the user signs with their own key and spends their own funds. Same reasoning
already settled for manual bridge, agent-withdraw and ub-withdraw. And it must be **said** — silence
beside a capped panel reads as capped.

Two things are sharper here than for bridge:

- The copy suite's own lesson applies directly: *"a standing 'caps do not apply' beside no control
  is a claim about a path the user cannot take."* State it **only** in the state where the control
  is actually offered.
- ⭐⭐ **`SendPanel.tsx` — the agent send, which IS capped (per-tx cap, day ceiling, pause in
  `agent-send.mjs`) — NEVER MENTIONS THE CAP.** Its subtitle is only *"From your wallet to any
  address — gasless on Arc."* So *"caps do not apply here"* would be contrasting against
  **SILENCE**, which is worse than saying nothing at all: the reader has no stated presence to
  contrast the stated absence against. ⛔ **The cap gets stated on the agent panel BEFORE the manual
  one exists.**
- **The distinction goes in the TITLES** — "Send from your agent wallet" vs "Send from your own
  wallet" — not only in body text. Two send forms, one capped and one not, is a materially higher
  confusion risk than bridge ever had.

⚠️ **No cap NUMBER in the UI.** `sendCapUsdc()` (`_arc.mjs:103`) is env-driven
(`AGENT_SEND_CAP_USDC`, default 5) and is not exposed to the client. Hardcoding it would be a second
source of truth for a claim about money, and
[[caps-from-deployed-env-not-code-defaults]] is explicit that a code default is not the deployed
value. The panel states that a cap EXISTS and that the server names the exact limit when it refuses.

## 4. THE ACK GATE — there is nothing to acknowledge. Do not build one.

The bridge's gate exists because a fee is **taken from the amount** and can be a large share of it;
the bands are ratios of exactly that. **A same-chain transfer has no fee deducted** — the recipient
receives exactly the amount sent, and gas is paid separately. No fee band, no disclosure, no ack.

Nothing else qualifies. Irreversibility is handled by the confirmation in §1. ⭐ And note an ack
**token** exists specifically to bind a **server-computed** number the client must not be able to
choose — here there is no server-computed number at all, so a token would be ceremony around
nothing. Insufficient gas for a full-balance send is a validation error, not a disclosure.

⛔ **A gate built for symmetry would be theatre**, and this file records that it was considered and
refused on the mechanism rather than skipped by omission.

## ⚠️ A STALE COMMENT, CORRECTED — and it was stale BEFORE this work

`metamask.ts:316-318` reads: *"the client-side `sendUsdc` was removed — all user sends go through
the single secure server endpoint /api/agent-send… **No client-side USDC-move path remains.**"*

🚨 **That last sentence was already false when `manualBridgeBurn` shipped — 14 lines below it, in
the same file.** The manual bridge approves and burns USDC from the user's own wallet from the
browser. **This change does not make the comment stale; it finds it stale**, and the distinction
matters: a reader who met that sentence before today would already have been misled about the
codebase's actual shape. Corrected in place rather than deleted, so the invariant that DOES hold
(the agent-custodied path is server-only) survives the correction.
[[duplicate-source-of-truth-is-the-recurring-bug]]

## ⛔ SWAP — UNSCOPED, and this paragraph is the record of why

Swap is a different order of problem and must not ride along. It has a **price** rather than a fee,
so it needs quote→execute with a slippage bound and an expiry — which reintroduces exactly the
server-computed-number-the-client-must-not-choose problem the ack token was built for, meaning swap
probably **does** need a disclosure gate and possibly a receipt, on the opposite side of both
answers above. It needs a kit key and runs server-side per the Swap Kit constraint. It has a
two-transaction approve-then-swap shape with the same partial-completion hazard the bridge's
approve/burn split already forced a decision about. And `SwapPanel.tsx` plus the agent swap path
already exist with their own confirm-gating — so the real first question is not "how do we build a
manual swap" but **"is a manual swap a new panel at all, or a signer choice inside the existing
one"**. That question is unanswered and is not answered here.
