# `scripts/dd` — a deterministic due-diligence check engine

A private instrument, not a product. It answers one kind of question — **"this project says X; is X true on-chain?"** — and it answers it in facts you can re-run yourself.

```bash
node scripts/dd/run.mjs --list
node scripts/dd/run.mjs code-exists       --address 0x036CbD53… --chain arc-testnet
node scripts/dd/run.mjs repo-address-audit --repo /path/to/repo --chain arc-testnet
node scripts/dd/run.mjs owner-powers      --address 0x0077777d… --chain arc-testnet
node scripts/dd/run.mjs payto-vs-token    --url https://seller.example/api/thing
node scripts/dd/run.mjs <check> … --json   # full fact, untruncated evidence
```

Not wired to prod: `scripts/dd/` imports nothing from `netlify/` or `src/`, prod imports nothing from here, it holds no key, signs nothing, and pays nothing. It reads public chain state and unpaid 402 challenges.

---

## The three rules

**1. Checks produce facts, never verdicts.** There is no `pass`, no `score`, no summary line. A check reports *"this address has no bytecode at block 52170555"*; a human decides that means *"so the project cannot settle there"*. The moment a check concludes, the tool acquires an opinion — and an opinion is the one thing it must never ship, because its entire value is being checkable rather than believable.

**2. Three states, not two.** `observed` (we asked, the chain answered) / `error` (we could not ask). An `eth_getCode` that times out must **never** become `hasCode: false`. `error` facts carry `result: null`, so nothing downstream can misread an absent answer as an answer of "absent". This is the same fail-open shape as `amount > cap` being false for `NaN` — one silent `NaN` and the cap disappears.

**3. Every fact carries the query that produced it.** `query.reproduce` is a copy-pasteable curl. Blocks are **pinned** — `latest` isn't reproducible, so evidence would rot. If a reader can't re-run the query and get the same evidence, the fact is worthless.

---

## ⚠️ False clean bills — read this before trusting a pass

A false flag gets argued with. **A false clean bill gets believed.** It is the only output nobody double-checks, so every way each check can wrongly say "fine" is listed here — and also rides on the fact itself, in `result.coverage`.

### `code-exists` — is there bytecode at this address?
`eth_getCode` at a pinned block, plus `codeHash` (sha256 of the bytecode).

It makes no clean claim — it reports one bit about one address — so it carries no `coverage`. But note:
- **`hasCode: true` does not mean "the right contract".** It means *something* is deployed. Check 3 tells you what it can do.
- **A fact is true for that block and that RPC.** Contracts can `selfdestruct`; CREATE2 can deploy later at an address that is empty today. The pin is what makes the fact honest, not eternal.

### `repo-address-audit` — do this repo's hardcoded addresses exist on the chain it claims?
Extract every `0x…40hex` with file/line, check each on the claimed chain, probe only the empties on other chains. Flags `EMPTY_ON_CLAIMED_CHAIN__LIVE_ON_OTHER_CHAIN`.

**`flags: 0` is a clean bill. Here is what it does not cover:**
- **Runtime-computed addresses.** Built from env vars, string concat, config fetched at boot, or an address list downloaded at runtime. Never extracted, never audited. A repo can hold zero hardcoded addresses and still point at the wrong chain.
- **Chains outside `chains.mjs`.** `EMPTY_EVERYWHERE_CHECKED` means *checked here* — currently arc-testnet, base, base-sepolia. An address live on Polygon reads as empty-everywhere and never flags.
- **Non-EVM addresses.** Solana base58 keys don't match the regex at all. A repo mixing Solana and EVM is only half audited.
- **Docs are excluded by default**, and `node_modules`, `dist`, lockfiles, minified and >2MB files always are. `--include-docs` opts prose back in.
- **The suppression rule can silence a real bug.** An address is suppressed when *every* source site declares a foreign chainId **and** it is confirmed live there. chainId is matched with word boundaries within a **±3-line window, nearest wins** — the one place in the engine that infers association from *proximity* rather than reading a fact. An unrelated chainId sitting near an address in a large config could suppress a genuine bug. Every suppression prints the exact line it read, so you can catch it. Read them.

### `owner-powers` — what can the owner do to you, and who is the owner?
Selector-in-bytecode scan (the Solidity dispatcher embeds every external selector), EIP-1967 proxy resolution, `owner()` classified from the owner's own bytecode.

**`powers: []` is a clean bill. Here is what it does not cover:**
- **EIP-2535 diamonds.** Powers live in facet contracts reached via the diamond's selector table, not in its own bytecode. This scan finds none of them and reports a clean bill on a fully-powered contract.
- **AccessControl roles.** `owner()` is a convention. A contract using `DEFAULT_ADMIN_ROLE`/`grantRole` has no `owner()` — it reports `no-owner-fn` and **looks ownerless while a role-holder retains every power**.
- **Non-1967 proxies.** Beacon proxies, custom slots, UUPS variants storing the impl elsewhere, metamorphic CREATE2 redeploys. The stub gets scanned; the logic behind it does not.
- **Presence ≠ reachability; absence ≠ safety.** A selector may be unreachable, and a power may be exercised via `delegatecall`/fallback with no selector at all.
- **Off-chain control.** Custodied upgrade keys, a lying frontend/RPC, a dependency pausable elsewhere. This reads one contract's code, not the system around it.

*Why bytecode and not an explorer ABI:* an ABI is somebody's **claim** about a contract; the bytecode **is** the contract. Bytecode works on unverified contracts and can't be fooled by a wrong ABI.

*The proxy trap, proven:* Circle's GatewayWallet proxy is **163 bytes and contains 0 of 5 power selectors**; the implementation behind it is **21,779 bytes and contains 5 of 5**. Scanning the address itself would declare it free of owner powers. It is not: a single **EOA** can `pause`, `denylist` and `upgradeToAndCall` it.

### `payto-vs-token` — what does an x402 seller ask you to sign?
Decodes a live unpaid 402. The tell is `extra.verifyingContract`: vanilla x402 signs against the **USDC token** (EIP-3009, `verifyingContract` absent ⇒ implicitly the asset); Gateway-style signs against a **different contract**. Also cross-checks `extra.name` against the asset's on-chain `name()`.

**`SIGNS_AGAINST_TOKEN_DOMAIN` is a clean bill. Here is what it does not cover:**
- **Advertised ≠ actual. THE BIG ONE.** This reads what the seller *says* in its 402. A seller can advertise a token domain and settle something else. Proving behaviour requires signing and paying, which this engine never does. A clean result means *"the advertisement is coherent"*, **not** *"the seller is honest"*.
- **The operator hop.** `payTo` being an EOA does **not** prove a hop (Mahshar's real disqualifier: you pay an operator who then pays the seller). That needs settlement history, not the challenge. A clean `payTo` is not evidence of non-custody.
- **Auth-gated terms.** SIWX/invite sellers return `accepts: []` (AgentCash does). Reported as `NO_TERMS_ADVERTISED` — indeterminate, not clean.
- **Multi-entry risk.** `accepts[]` may offer several chains at once (Mahshar co-offers Base **mainnet** beside Arc testnet, same amount). Each entry is classified separately; one clean entry says nothing about the others, and picking the wrong one spends real money.
- **Unknown chains.** Solana and Polygon/JPYC entries can't be cross-checked on-chain; they're marked `chainKnown: false`.

---

## Known-good cases (regression corpus)

Re-run these after any change. Both directions must hold.

| Check | Case | Expected |
|---|---|---|
| `repo-address-audit` | `cutepawss/arcent` @ arc-testnet | **1 flag** — `0x036CbD53…` empty on Arc (5042002), live on Base Sepolia (84532, 1798 bytes, codeHash `2842683d…`). Sites declare `5042002`. |
| `repo-address-audit` | `circlefin/arc-nanopayments` @ arc-testnet | **0 flags** — 2 addresses, both `LIVE_ON_CLAIMED_CHAIN`. |
| `repo-address-audit` | this repo @ arc-testnet | **0 flags, 1 suppressed** — `_receipt.mjs:44` declares `84532`, confirmed live there. |
| `owner-powers` | `0x0077777d…` @ arc-testnet | proxy → `0x44eeddc9…`; owner `0x5b967871…` **eoa**; `transferOwnership, pausable, upgradeable, denylist, withdrawalDelay`; **no** `emergencyWithdraw`. |
| `payto-vs-token` | `mahshar.xyz/api/proxy/{id}` | **`SIGNS_AGAINST_NON_TOKEN_CONTRACT`** ×2 — domain `0x0077777d…` ≠ asset `0x3600…`; `extra.name "GatewayWalletBatched"` ≠ token `"USDC"`. |
| `payto-vs-token` | `api.anchor-x402.com/v1/roll` | **`SIGNS_AGAINST_TOKEN_DOMAIN`** — `verifyingContract` absent ⇒ the asset; `extra.name "USD Coin"` == token `name()`. |
| `payto-vs-token` | our own `x402-quote` | **`SIGNS_AGAINST_NON_TOKEN_CONTRACT`** — we ship the Gateway scheme too. The engine does not play favourites, and this row exists to keep it that way. |

## Design notes

- **Raw `fetch`, not viem, for chain reads.** The product *is* `query.reproduce`, so the request we build must **be** the request we send must **be** the request we print. viem would make provenance a reconstruction. (viem is used for `toFunctionSelector` — maths on a signature, not standing between us and the wire.)
- **`chains.mjs` duplicates the Arc RPC** from `src/config/chain.ts`, and `owner-powers` duplicates `_vault.mjs`'s power tables. Deliberate: **the auditor must not depend on the audited**, or a prod refactor silently changes what a past audit meant. Mitigation: `assertChain()` compares `eth_chainId` to the declared id before any state is read, so the table is never trusted — only checked.
- **Transient-only backoff.** Arc's public RPC rate-limits at a few calls/sec; the first real run of check 2 came back 4/6 `INDETERMINATE`. Retries cover rate limits and timeouts; a genuine `execution reverted` surfaces immediately rather than being papered over.
- **Batch is fail-closed per entry.** One bad address yields one error fact; the run continues. Every entry in produces exactly one fact out — the array length is a promise, so nobody draws conclusions from a silently truncated set.
