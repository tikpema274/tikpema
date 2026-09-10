# The DD service, in plain language

What a buyer actually gets, and what the service refuses to do. Derived from
`netlify/functions/_dd-rungs.mjs` (the `LADDER` array and its argued ordering) and the coverage
manifest in `shared/onchain-facts/index.mjs`. **Written 2026-09-10.**

⚠️ **This file is a RENDERING, not a source.** `_dd-rungs.mjs` is the source of truth for the order
and the set; if the two disagree, the code is right and this file is stale. It exists because the
ordering was argued once, in code comments aimed at a maintainer, and there was nowhere a buyer
could read what the service does in their own words.

⛔ **No selector names, no internal ids, no rung numbers.** Those appear in
`docs/dd-live-proof-procedure.md`, which is an operator procedure and needs them.

---

## The shape

**Nine gates, then a payment branch.** Every gate either refuses or falls through to the next. The
payment step is deliberately *not* one of them: it is a fork (challenge if unpaid, settle if paid),
not something that can refuse-or-continue, and only one entry point has it. The ladder ends where
the paths legitimately diverge.

---

## "Is this service actually open for business?"

- **Is the endpoint published at all**, rather than merely deployed? Deploying is not publishing,
  and this is the cheapest possible check, so it goes first.
- **If you already paid, you can collect your report.** This sits *ahead* of the detector's own
  health check on purpose: a report you bought was produced when the detector was known good, and a
  later wobble must not strand it. The health gate guards production of new answers, not delivery of
  answers already owed.
- **If you are asking how to use the service, you get the documentation page** — even during the
  window right after a deploy when new answers are not being produced. That window lands exactly
  when a human is most likely to look, and handing them a message about a detector instead of the
  one page explaining how to call the thing was a real defect, measured on production 2026-08-16.

## "Is the detector itself trustworthy right now?"

- **The detector must have passed its own known-shape fixtures for this exact build.** If it has
  not, the service refuses to answer about anyone's contract rather than answer badly.

  Two refusal reasons clear by themselves: a fresh build has not been checked yet, and a check that
  aged past its shelf life. Both resolve on a schedule with nobody doing anything. **Every other
  reason means something actually broke** — a fixture regressed, the identity does not line up, the
  record is corrupt, or it could not be read — and waiting will not help. The difference is stated
  to the caller, because "try again in a few minutes" is actively misleading in the second case.

## "Did you ask a question I can answer?"

- The answer-producing path is a **POST**; other verbs get a report about your request, not a report
  about a contract.
- The request must be **small and well-formed**.
- It must name a **real contract address**.
- It must name a **chain this service actually reads**.

None of these is skippable. Skipping them would not save work — it would only move the failure
somewhere worse, where an unvalidated address reaches the analyser and becomes a server error with a
stack trace instead of a clean refusal.

## "Can I pay, and for what?"

- **A price is never quoted if it would be payable to nowhere.** If the revenue address is not
  configured, the service refuses rather than take money into a void.

---

## What lands in `notChecked`, and how often

⚠️ **Rungs never land in `notChecked`.** They pass or they refuse. `notChecked` belongs to the
*coverage manifest* — the nine owner-power groups the report answers about: emergency withdraw,
settable fees, set strategy, set fee recipient, transfer ownership, pausable, upgradeable, denylist,
withdrawal delay.

**On Arc, the answer is zero.** MEASURED 2026-08-26 across 30 Arc testnet contracts (blocks
58,910,046–58,910,070), selected as every transaction `to` in a fixed range ranked by call count,
filtered to addresses with code:

| | Base mainnet | Arc testnet |
|---|---:|---:|
| contracts analysed | 30 | 30 |
| power groups returned | 270 | 270 |
| **power groups in `notChecked`** | **0** | **0** |
| `notChecked` share of *sub-checks* | 9.5% | 9.6% |

⭐ **The 9.6% figure is sub-checks, not power groups** — quoting it as "9.6% of powers are unchecked"
would be wrong.

🚨 **And the metric cannot answer the question it looks like it answers.** An unrecognised contract
falls through to a generic shape, the power scan runs against whatever bytecode sits at the address,
and all nine groups resolve to a clean present/absent. A catalogue gap is *structurally incapable* of
raising `notChecked`. **The risk was never a manifest that grows — it is a manifest that stays
confident and is wrong.**

The reasons a group can legitimately land in `notChecked` are a closed set, and two of them —
an unreadable RPC and an unmet read quorum — are about **our instrument**, not the contract. A
refusal built entirely from those says so, because charging for a failure of our own equipment
would be charging for nothing.

---

## What the service does NOT do

**It reports what a contract's owners are able to do, with provenance for every reading — it does
not predict what they will do, it does not score or rate the contract, and a clean manifest is not
a statement that the contract is safe.**

Two corollaries worth stating to anyone relying on it:

- **"Could not ask" is never reported as "no".** An owner read that failed is not a renounced owner;
  a contract with no `owner()` is not an ownerless contract, because a role-based admin exposes none
  and holds every power.
- **There is no model in the verdict path.** The answer is derived from on-chain reads by fixed
  rules; nothing is inferred, summarised, or generated.
