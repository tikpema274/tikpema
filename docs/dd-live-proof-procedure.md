# DD service — LIVE PROOF PROCEDURE

**You run this. I do not.** Steps 6 and 9 move real USDC, and money-moving proof is the
operator's to execute — not something an agent should do on your behalf. Everything before step 6
is read-only and costs nothing.

**What is proven when this is done:** that the DD service takes a real x402 payment for a real
report, withholds the artifact until the chain agrees, serves a signed attestation on confirmation,
and does **not** charge when it cannot sign. All of that is currently proven only offline
(`test:dd`, 11 suites, 0 failures). No real facilitator has ever been called and no USDC has moved.

**Cost:** $0.06 USDC for the happy path, $0.00 for the no-charge path (step 9 costing anything *is*
the defect it looks for).

---

## 0. The state this starts from

Verified 2026-07-28, re-verify rather than trusting this table:

| Thing | State | How it was checked |
|---|---|---|
| `DD_PUBLIC_ENABLED` in **production** | **UNSET → service INERT** | `netlify env:get … --context production` returned the *"No value set"* sentinel |
| Revenue wallet `0xb407967319d5…` Gateway balance | **0.000000 USDC** | `availableBalance(USDC, payTo)` read live |
| Code | committed `961ff80`, **not deployed anywhere** | `git log` |
| Facilitator | wired, **never called against Circle** | — |

⭐ The revenue wallet's zero balance is the whole basis of confirmation. Its entire history must be
DD revenue or the aggregate read means nothing. **A $0.06 DD payment is exactly what it is for** —
this is not a violation of "must not be funded", it is the wallet doing its job for the first time.

---

## 1. Confirm production stays inert (read-only)

```bash
npx netlify env:get DD_PUBLIC_ENABLED --context production
npx netlify env:get DD_PAYTO_ADDRESS  --context production
```

Both must print **`No value set in the production context…`**.

🚨 `env:get` **exits 0 whether set or unset** — the exit code proves nothing. The discriminator is
the **payload**: a 74-char sentence vs an actual value. Read the text, do not test `$?`.

**Do not run `netlify deploy --prod` at any point in this procedure.** Everything below is a draft.

---

## 2. ⭐ Determine which env context a CLI draft actually reads — EMPIRICALLY

**Do not skip this and do not assume.** Netlify has `production`, `deploy-preview` and
`branch-deploy` contexts, and which one a CLI draft (`netlify deploy` without `--prod`) resolves is
exactly the kind of thing that is obvious right up until it is wrong. Getting it wrong in the
*other* direction — setting the flag in the production context "just to make the draft work" — arms
production for the next deploy. That is the trap `210ffeb` exists to prevent; do not re-open it.

Set the two variables on the **deploy-preview** context only:

```bash
npx netlify env:set DD_PUBLIC_ENABLED true --context deploy-preview
npx netlify env:set DD_PAYTO_ADDRESS 0xb407967319d56218c7e1c369125490e665a16ac4 --context deploy-preview
```

Re-assert production is still clean:

```bash
npx netlify env:get DD_PUBLIC_ENABLED --context production   # MUST still say "No value set"
```

Then deploy (step 3) and probe (step 5). The endpoint's own refusal tells you which context won,
for free and with no money at risk:

| Probe says | Meaning |
|---|---|
| `service-not-enabled` | the draft does **not** read `deploy-preview` — try `--context branch-deploy`, or use `--context all` **only if** you then immediately re-verify production and unset it after |
| `payment-misconfigured` | flag reached it, `DD_PAYTO_ADDRESS` did not |
| `service-unverified` | both reached it — you are past this step, go to step 4 |
| a real **402** | both reached it and the canary has already run — go to step 5 |

⚠️ If you end up needing `--context all`, that **includes production**. Then production is armed and
the only thing keeping it inert is, once again, nobody typing the deploy command. If it comes to
that: finish the proof, then **unset it immediately** and re-verify with step 1.

---

## 3. Build and deploy a DRAFT

```bash
npm run build
npx netlify deploy --dir=dist          # NO --prod
```

Run it backgrounded; it takes a while.

⚠️ **Grab the URL from the deploy output.** The CLI prints two forms and **both work**:

- `https://<deploy-id>--<site>.netlify.app`
- `https://<deploy-id>.app.tikpema.xyz.tikpema.xyz` — the doubled custom domain is **not** a typo

⭐ **Append `/.netlify/functions/dd-analyze`, NOT `/api/dd-analyze`.** Both work on a healthy deploy —
the handler builds the x402 `resource` from `event.path` either way, so the payment binds to the URL
you actually hit and the retrieve URL derives from the same string (verified). But `/api/*` depends on
the `netlify.toml` redirect resolving on that specific deploy, and a draft has been observed serving
SPA HTML there while the functions path answered normally. The functions path bypasses redirect
resolution, so it tests the **service** rather than the **routing**.

An automated grep for `\.netlify\.app` has previously reported "NO URL FOUND" on a deploy that
succeeded. Match on the deploy id, or read it yourself.

🚨 **Never verify a deployment by status code alone.** Unmatched paths on this site are answered by
the SPA catch-all, and the status observed has varied — **200** with SPA HTML in one case, **404**
with SPA HTML in another. Either way the body is HTML, so a routing miss and a missing function look
identical from outside. **Verify by the shape of the JSON body**, and if you get HTML, ask
`/.netlify/functions/<name>` before concluding anything about the service.

---

## 4. Wait for the canary (~10 min), or the service refuses

RUNG 0 requires a **fresh, version-matched** health artifact. A brand-new build has none, so
`dd-analyze` returns `503 service-unverified` until a canary run produces one for **that build**.
This is correct behaviour, not a fault.

🚨 **DO NOT WAIT FOR THE `*/10` CRON — IT DOES NOT FIRE ON A DRAFT.** Netlify runs scheduled
functions on the published deploy, not on drafts. On a draft the canary produces an artifact **only
when you invoke it by hand**, and `DEFAULT_TTL_MS` expires it 30 minutes later with nothing to
refresh it. Measured symptom: a record 60 minutes old under a `*/10` schedule — six missed ticks —
refusing as `stale`. That is what a cron that never ran looks like from the endpoint's side.

**So: trigger it yourself, immediately before each run.**

```bash
curl -s "<draft>/.netlify/functions/dd-canary" | python3 -m json.tool | head -20
```

(Functions path here too, for the same reason as step 3 — `/api/*` tests routing, not the service.)

Check `identity.buildResolved: true` and a real `identity.build`, then **proceed within 30 minutes**.
Re-trigger whenever you are about to start a run. A repeat call inside 5 minutes returns
`deduped:true` and does NOT refresh `producedAt` — harmless, since the dedupe window is far inside
the TTL, but do not read a dedupe as a refresh.

⭐ **A stale artifact CANNOT strand a payment.** Retrieve sits ahead of the health gate deliberately
(`dd-analyze.mjs` — retrieve at rung -0.5, health at rung 0), so a handle stays redeemable even if
the canary goes stale mid-settlement. That matters here in practice: settlement can take ~15.4 min
against a 30-minute TTL, so an artifact expiring during a poll is likely and is a non-event.

⚠️ Diagnosing a refusal at this step — the reason discriminates, so read it rather than retrying:

| `refusal.diagnostic.healthReason` | Meaning |
|---|---|
| `stale` | ⭐ the binding WORKS — the record was found and matched. Just re-trigger the canary |
| `no-record` | no artifact under this build's key — canary has not run on this deploy yet |
| `version-mismatch` | found, but for a different build; `mismatchedFields` names which |
| `build-unresolved` | this deploy resolved no build id — set `DD_BUILD_ID` (step 2) |

---

## 5. Read-only probe — the last checkpoint before money

```bash
node --env-file=.env scripts/dd/probe-dd-purchase.mjs --url "<draft>/.netlify/functions/dd-analyze"
```

This fetches the 402 and **stops**. It must print:

```
✅ revenue wallet Gateway balance is READABLE — 0.000000 USDC
✅ ⭐⭐ payTo is the DEDICATED REVENUE WALLET
✅ ⭐ price is 60000 atomic ($0.06)
✅ asset is USDC on Arc
✅ resource binds to this endpoint
```

🚨 **If the payTo check fails, STOP and do not pay.** Paying a wrong `payTo` puts unattributable
USDC into a wallet whose zero history is the only thing making reconciliation possible — and that is
not undoable. The probe refuses to continue on its own, but know why.

Note the baseline it prints. That is the number the chain must beat.

---

## 6. 🚨 THE PAYMENT — $0.06 USDC

```bash
node --env-file=.env scripts/dd/probe-dd-purchase.mjs --url "<draft>/.netlify/functions/dd-analyze" --confirm
```

Expected sequence:

1. **402** with the quote (already verified in step 5)
2. buyer signs a Gateway-batched authorization and retries
3. seller **verifies → runs the analysis → decides → snapshots → persists → settles**
4. **202 + handle** — no report in the body. *This is the point of the whole design.*
5. buyer polls `retrieve` — a long run of **202 / accepted-not-yet-confirmed**
6. `availableBalance(USDC, payTo)` clears baseline + 60000
7. **200 + the signed report**

**Timing:** settlement is a batch **flush** measured at ~15.4 min on Arc, so a randomly-timed
payment confirms anywhere in **(0, ~15.4 min)**. The probe polls 20 min by default. Expect anything
from seconds to a quarter of an hour, and do not read a slow one as a fault.

⭐ **Running out of poll budget is NOT a failure and NOT a loss.** The entitlement is permanent. The
probe prints the handle; redeem it any time, even hours later:

```bash
node --env-file=.env scripts/dd/probe-dd-purchase.mjs --url "<draft>/.netlify/functions/dd-analyze" --handle <handle>
```

**If the buyer's Gateway balance is short**, `settle()` returns `success:false` → the seller returns
**402**, serves nothing, and nothing is charged. Safe failure; top up and retry.

---

## 7. Confirm the money independently of anything the seller said

The probe does this in Phase 3, but do it yourself too — the seller is the party with an interest.

```bash
curl -s https://rpc.testnet.arc.network -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"eth_call","params":[{
    "to":"0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    "data":"0x3ccb64ae0000000000000000000000003600000000000000000000000000000000000000000000000000000000000000b407967319d56218c7e1c369125490e665a16ac4"
  },"latest"]}'
```

`0x` + hex. Expect **`0xea60` = 60000** = 0.060000 USDC, up from zero.

⚠️ **Do not look for an ERC-20 `Transfer` log.** Settlement is an **internal Gateway ledger credit**;
`payTo`'s *token* balance never moves and **zero** Transfer events are emitted. A `eth_getLogs`
confirmation would find nothing forever while failing to look exactly like "payments pending".

⚠️ **This read is AGGREGATE-ONLY.** It proves the balance rose by at least the amount — not that
*this specific* payment landed. With one payment in flight against a zero-history wallet that is
unambiguous, which is precisely why the first proof should be a single sequential payment. Do not
run two concurrent equal-amount payments and expect to tell them apart; they cross-confirm.

---

## 8. Verify the served attestation on chain

The 200 body carries `report.attestation`. Check it against the chain rather than believing it.

⚠️ `scripts/dd/verify-attestation.mjs` is an **acceptance suite over fixtures**, not a file verifier —
it takes no `--file`. To verify *your* report, call the real API. Save the `report` object from the
200 body to `report.json`, then:

```bash
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { verifyAttestation } from "./shared/onchain-analyze/attest.mjs";
import { chainClient } from "./scripts/dd/client.mjs";
const report = JSON.parse(readFileSync(process.argv[1], "utf8"));
const v = await verifyAttestation(report, { client: chainClient("arc-testnet"), expect: { agentId: "851891" } });
console.log(JSON.stringify(v, null, 2));
' report.json
```

Expect `"valid": true, "reason": "ok"`. (Verified working against the live chain — an unsigned report
correctly returns `valid:false, reason:"unsigned"`.)

⭐ `valid` is **tri-state**: `true | false | null`. `null` is INDETERMINATE (RPC unreachable,
unsupported canon, malformed) — **not** a failure. It is falsy, so a naive `if (v.valid)` still fails
closed, but read `reason` before concluding anything.

The verifier's chain is: `tokenURI(851891)` → which service · `ownerOf(851891)` → who attests ·
recompute the payload hash · `isValidSignature(hash, sig)` → expect **`0x1626ba7e`**.

🪤 The digest is the **EIP-191 `personal_sign` hash, NOT raw `keccak256`**. Hashing the canonical
report bytes directly returns `0xffffffff` — a *confident wrong answer* on a perfectly valid
signature. If you verify by hand, hash with `hashMessage`, not `keccak256`.

---

## 9. The no-charge path: prove a signer outage costs the caller nothing

**This step must cost $0.00. If it charges, that is the defect it exists to find.**

Induce a real signer failure on the draft only:

```bash
npx netlify env:set CIRCLE_API_KEY "TEST_API_KEY:deliberately-invalid:for-unsigned-proof" --context deploy-preview
npm run build && npx netlify deploy --dir=dist
```

⚠️ This credential is shared, so **other functions on that draft will also fail to reach Circle**.
That is acceptable on a draft and nowhere else. Note the real value first — you are restoring it in
step 10.

Then buy again:

```bash
node --env-file=.env scripts/dd/probe-dd-purchase.mjs --url "<new-draft>/.netlify/functions/dd-analyze" --confirm
```

Expected — **HTTP 200, not 402, not 502**:

```json
{
  "settled": false,
  "charged": false,
  "retryable": true,
  "reason": "unsigned-attestation",
  "detail": "…A signer outage is OUR failure, in the same category as an unreachable chain —
             charging for it would be charging for our own outage…No charge; retry.",
  "payment": "your payment authorization was NOT used and remains valid…it is unspent…
              No settlement was attempted and none will be attempted later."
}
```

…**with the complete report attached, free**, carrying `attestation.status: "unsigned"`.

**The assertions that matter:**

- the report is **complete** — `refusal: null`, full coverage. This is not an engine failure; only
  the signature is missing.
- `charged: false`
- ⭐ **the revenue wallet balance is UNCHANGED** — still exactly `0xea60` from step 6. Re-run the
  step 7 curl. *This is the real proof.* The JSON saying `charged:false` is a claim; the unmoved
  balance is the fact.

---

## 10. Teardown

```bash
# restore the real Circle credential on the draft context
npx netlify env:set CIRCLE_API_KEY "<the real value>" --context deploy-preview

# if you had to use --context all in step 2, UNSET production now
npx netlify env:unset DD_PUBLIC_ENABLED --context production
npx netlify env:get   DD_PUBLIC_ENABLED --context production   # MUST say "No value set"
```

**Leave in place:** `DD_PUBLIC_ENABLED` / `DD_PAYTO_ADDRESS` on the draft context. **Never set on
production** until publishing is a decision you are making on purpose.

**The revenue wallet now holds 0.06 USDC and must keep receiving nothing else.** Its history is the
audit trail.

---

## What would make you STOP

| Signal | Why it stops the run |
|---|---|
| `payTo` in the 402 is not `0xb407967319d5…` | unattributable USDC into the reconciliation wallet — not undoable |
| price is not `60000` | the deployed build is not the one reviewed |
| revenue wallet balance UNREADABLE | a payment could never be confirmed; the seller refuses too (503, nothing broadcast) |
| production `DD_PUBLIC_ENABLED` shows a value | production is armed — fix before anything else |
| **502 `settlement-indeterminate`** | the broadcast **may** have happened. `charged: null`, *not* false. Do **not** retry blindly — poll the handle and read the balance first |
| step 9 charges anything | the no-charge path is broken; that is a live defect, stop and report it |

---

## Afterwards

The frozen service document (`agent-metadata/dd-service.json`, CID `bafkreigton…`) still says
*"payment / x402 metering — NOT built"*. Its bytes **cannot change** — editing it changes its CID and
breaks the `tokenURI == CID` discriminator that is the sole proof of which identity is which. The
correction goes in the **mirror README**, which is exactly what its `mutable_companion` field
reserves.
