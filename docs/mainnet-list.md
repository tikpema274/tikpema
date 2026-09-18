# Before mainnet — the index

**This is an INDEX, not a record. Each entry is one or two lines plus a pointer; the detail lives at the
pointer and is not repeated here** (two copies drift). Pointers into PROGRESS.md give the section heading —
grep for it; the line number is where it was on the date added and will drift. Started 2026-09-18; add
entries, mark them resolved, never silently delete.

## Open

- **A terminal-FAILED send stays charged against the day ceiling until UTC midnight, no manual release.**
  `REVERSALS_ARMED = false` (`netlify/functions/budget-sweep.mjs:120`). Scheduled review **2026-11-19**
  (arm if the `observed:*` count is non-zero, retire if still zero) — **mainnet may arrive first.**
  → PROGRESS.md `## 2026-09-18 — A 202 SEND NEVER RESOLVES TO A HASH` (~:25914), "ADJACENT" paragraph.
- **A 202 send never resolves to a transaction hash** — the sweep discards the `txHash` Circle's
  `getTransaction` returns. Four-step scope written, not built.
  → PROGRESS.md `## 2026-09-18 — A 202 SEND NEVER RESOLVES TO A HASH` (~:25914), "FOUR-STEP SCOPE".
- **Compliance / AML is not built and deliberately deferred to mainnet** — manual payout screening only;
  none of Arc's vendors integrated. The note also holds the Arc compliance-vendor directory.
  → memory `compliance-not-built-deferred-mainnet.md`.
- **Arc has no Gateway domain on mainnet** (measured 2026-08-24; Circle published it 2026-09-16 — re-check).
  Three launch shapes: Circle ships Gateway / Arc ships without it (vanilla EIP-3009 carries payments,
  unified balance out) / Base instead. Two curls re-check it.
  → PROGRESS.md `# 🚨 ARC HAS NO GATEWAY DOMAIN ON MAINNET — MEASURED 2026-08-24` (~:12391); see also
  `## Same-environment startup assert — 2026-09-16` (~:25461) for the published-Gateway follow-up.
- **The mainnet crossing is BIG and gated on a go/no-go**, not a one-session build: real USDC, a mainnet
  hot-wallet key, mainnet Gateway/UB config, funding source cannot be Arc, possible compliance screening.
  → PROGRESS.md BlockRun recon, `### 4. Scope / risk` + `### The one decision before any scoping` (~:23982).
- **env-assert reads ONE copy per lever but the RPC literal is in 6 files and the testnet Gateway wallet in
  4** — a migration that misses a duplicate passes the assert and verifies x402/DD against the wrong
  network's Gateway wallet. Fix scoped (one source per lever + grep-guard); held until the mainnet decision.
  → PROGRESS.md `### env-assert duplication gap — OUTRANKS the copy half` (~:25603).

## Resolved (kept so the list is not re-derived from scratch)

- **Unified balance had no exit path** — named "the top mainnet item" on 2026-08-12; the exit was built the
  same day and has since completed one real withdrawal end to end, unattended.
  → PROGRESS.md `### 🚨 PIVOT — DD IS DONE; THE MAINNET RISK HAS HAD NO WORK` (~:20459) and
  `### OPEN WORK — preconditions attached` item 3 (~:21813); memory `ub-exit-shipped-and-live.md`.
