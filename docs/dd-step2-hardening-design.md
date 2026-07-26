# DD Step 2 hardening — passes 2 and 3 (DESIGN ONLY, NOT BUILT)

**Status at time of writing (`634f3b4`): neither pass has any code.** Verified, not assumed —
`shared/onchain-analyze/` contains no cache key, no `blockHash`, no codehash pin, and no signing
or attestation code (grep over comment-stripped source). Pass 1 (multi-RPC quorum) **is** built and
shipped in `3e27042`; this document covers only what comes after it.

**Provenance and its limit.** Both designs were produced in a design session and are transcribed
here from that conversation. They were reviewed against the code as it stood at `3e27042`, but
**nothing here has been validated by implementation** — where a claim depends on behaviour, treat it
as a hypothesis to test, not a settled fact. That is the difference between this file and the
acceptance-tested claims in `agent-metadata/dd-service.json`.

**What this file is for.** These designs previously existed only in conversation. Recreating a
design session from notes alone has already proven impossible once in this project
(`dd-engine-standalone-design`), so they live on disk and in git, readable by any future session
without depending on a memory store.

---

# Pass 2 — block-pinned caching + bytecode-hash pinning

Two coupled features. Caching makes repeat questions cheap; bytecode-hash pinning makes "has this
contract changed since?" cheap. They compose into the validity split at the end, which is the part
that stops a caller over-reusing a cached report.

## 2.1 Block-pinned caching

### ⭐ The cache key is SIX parts, not three

```
key = (schemaVersion, chainId, blockHash, address, quorumFingerprint, catalogueFingerprint)
```

The obvious key — `(chainId, address, blockHash)` — is **wrong in a way that fails open.** A report
is a function of the block *and of how it was produced*. Key on state alone and a cache hit can
silently downgrade the guarantee: a **single-RPC** report served to a **quorum** request, or a report
built from an older power catalogue. The answer looks identical, the provenance is weaker, and
nothing in the output says so. That is the project's recurring failure family wearing a performance
hat.

- `quorumFingerprint` — sorted endpoint set + `minAgree`. A 2-of-2 report and a single-RPC report are
  **different claims** about the same block. `sources.mode` already records which, so the key must too.
- `catalogueFingerprint` — hash of `POWER_SIGS` keys + signatures. Grow the catalogue and every entry
  invalidates, rather than serving a report that scanned fewer powers than the caller now expects.
- `schemaVersion` — already exists as `onchain-analyze/0.1.0`.

A miss on any component is **correct behaviour**, not waste.

### 🚨 NO TTL. Ever.

Staleness must remain *structurally* a different key, never a timer that might not have fired. Adding
a TTL reintroduces exactly the race this design eliminates. Wall-clock time must not enter the key
and must not gate an entry. `observedAt` may be *recorded* for human context; it must never be
*compared*.

### The pin: `min(heads)`, not one endpoint's head

Pin once, then send that same block tag to every endpoint — this is what makes every other quorum
comparison apples-to-apples. Without a shared pin, a disagreement is indistinguishable from head
skew.

Take the **minimum** head across endpoints. Pinning above another endpoint's head guarantees it
cannot serve the block, which the quorum matrix correctly turns into `rpc-quorum-unmet` — a
self-inflicted refusal on a perfectly healthy chain. On Arc (~0.48s blocks, 1-block deterministic
finality) taking the laggiest view costs nothing.

### ⭐ Quorum the pinned block's HASH — but never its number

The block **number** is deliberately not quorumed: two endpoints legitimately differ by a block, so
requiring agreement on the head would refuse constantly on *correct* behaviour.

Once a number is chosen, ask every endpoint for **that block's hash** and require agreement. One
cheap read per endpoint, doing two jobs: it yields the `blockHash` for the cache key, and it proves
all endpoints share the same chain history *before* any state is read. On Arc's deterministic BFT a
mismatch should be impossible — which is precisely why it is worth asserting. A mismatch is not a
per-slot failure; it invalidates the whole snapshot → **full refusal**, `reason:
"rpc-blockhash-disagreement"`.

### Which reads need quorum

| read | quorum? | why |
|---|---|---|
| `eth_chainId` (guard) | ✅ per endpoint | every fact is conditional on talking to Arc; an endpoint that fails is *excluded*, not tolerated |
| `eth_blockNumber` (pin) | ❌ **never** | endpoints legitimately differ; quorum here refuses on correct behaviour |
| block hash at the pinned number | ✅ | validates the snapshot + yields the cache key |
| `eth_getCode(subject)` | ✅ | decides eoa / clone / diamond, and for `plain-contract` *is* the scanned code |
| `eth_getStorageAt(impl slot)` | ✅ | decides proxy-or-not → **which contract gets scanned** |
| `eth_getStorageAt(admin slot)` | ✅ | decides variant only — weakest case, narrow disagreement scope |
| `eth_getCode(impl / clone target)` | ✅ | the bytecode every power finding is derived from |
| `eth_call owner()` | ✅ | the holder. ⚠️ a *computed* result, more room for honest divergence than raw storage |
| `eth_getCode(owner)` | ✅ | decides `holderKind` |

Per-endpoint load stays ~1× (each endpoint sees one call per quorum read) while total calls roughly
double. Given Arc's public RPC already throttles us, spreading across endpoints may *improve*
reliability rather than degrade it.

### Store: in-memory LRU for this pass

Bounded, per-process. The cache is a latency optimisation, **never a source of truth**.

**Persistence is a separate decision with its own threat model** — a persisted report is an assertion
someone else wrote, so it needs an integrity story (who may write; can a poisoned entry be told from
a real one). The honest framing: a cached report is re-verifiable *by construction*, because every
entry carries `reads[]` with per-endpoint curls. So a persisted cache is a **hint that must be
re-checkable**, not evidence. That belongs with the x402/hireable-service thread, not here.

State the limit plainly: in a Netlify function, in-memory means per-container, so hit rates are
modest and unpredictable. This pass buys correctness of the caching *model*, not big wins.

## 2.2 Bytecode-hash pinning

### ⭐ The tripwire is a TUPLE — one hash is not sufficient

For a proxy the hash must cover the **implementation's** runtime code; the stub is static and would
show a clean bill through any upgrade. Same for a clone: the effective code is the target's. But
three distinct things can change, and one hash catches only one of them:

```
(ownCodeKeccak256, implAddress, effectiveCodeKeccak256)
```

| what changed | detected by |
|---|---|
| implementation upgraded in place | `effectiveCodeKeccak256` differs |
| proxy re-pointed to a different impl | `implAddress` differs (the code hash may not, if the new impl is byte-identical) |
| the address itself redeployed (CREATE2 / metamorphic) | `ownCodeKeccak256` differs |

`effectiveCodeKeccak256` — the code the powers were actually derived from — is the headline field,
since every finding depends on it.

**The cheap re-check is 2 RPC calls, not one comparison**: re-read the impl slot, re-hash the
effective code. Versus 6–8 for a full analysis. Say it that way rather than "one comparison" — the
impl slot read is not optional, because a re-point with identical code would otherwise pass.

### keccak256, not sha256 — and the empty-account edge

Use **keccak256**, because `keccak256(runtime code)` is exactly what `EXTCODEHASH` returns. The pin
is then verifiable **on-chain by a contract**, not merely off-chain by us — a meaningful property for
an agent-safety product.

Two consequences:

1. **It diverges from `scripts/dd/checks/owner-powers.mjs`, which uses sha256** for
   `scannedCodeHash` / `ownCodeHash` / `implCodeFact.codeHash`. Two different hashes both called "the
   code hash" is the duplicate-source-of-truth trap in a new outfit. **Name them distinctly**
   (`codeKeccak256` vs `codeSha256`) with a stated reason: dd/'s sha256 answers "is this the same
   deployment as over there?", where any hash works; keccak is needed for `EXTCODEHASH` parity.
2. **⚠️ An empty account must report `null`, not `keccak256("")`.** `EXTCODEHASH` of an empty account
   is `0x0`, while `keccak256("")` is `0xc5d246…`. Emitting the latter gives a caller comparing
   against `EXTCODEHASH` a **false mismatch on every EOA**.

### Quorum: inherited free, with one rule

The bytecode is *already* read through the quorum client; the hash is computed **locally over the
agreed bytes**. Zero extra reads, and strictly better than trusting a node's own hash twice.

**The rule: if endpoints disagreed on the code, there is no agreed value, so there is no hash.** The
field must be absent with the disagreement in `notChecked` — never computed from one endpoint's
answer. This already falls out of the existing machinery (`effectiveCode` becomes `UNREADABLE`, all
nine groups land in `notChecked`), but it must be **asserted in the harness** or a future refactor
will quietly hash the survivor.

## 2.3 ⭐ Where the two features couple — the validity split

This is what makes the code hash more than a curiosity, and it must be explicit in the schema or
callers will over-reuse cached reports.

- **Code-pinned findings** — the power inventory, and shape *insofar as it derives from bytecode*
  (clone pattern, diamond loupe, UUPS entry point). Valid for as long as the effective code hash
  holds, **at any block**.
- **Block-pinned findings** — owner identity and kind, the impl-slot pointer, the admin slot. These
  are *state*: they change without any code change. Valid **only** at the pinned block.

So a caller holding a report from block N who confirms the code hash still matches at block M may
reuse the **powers**, and must **not** reuse the **owner**. A contract can be transferred to a
hostile owner with byte-identical code — the powers are unchanged and the answer to "who can do this
to me" is completely different.

The report should carry `validity: { codePinned: [...], blockPinned: [...] }` naming which fields
fall in which class, so the licence a hash match grants is **stated rather than inferred**.

## 2.4 Schema additions, scope, acceptance

**Report gains:** `subject.blockHash`, a top-level `observedAt` (recorded, never compared), the
keccak tuple, and the `validity` block. Today `subject` carries `blockNumber` only, and
`resolveBlock` (`scripts/dd/rpc.mjs`) returns `{number, tag, pinnedBy}` with no hash — so the pin
does **not** currently fall out of the response and this is an additive change.

**In:** the above + in-memory LRU on the six-part key.
**Out:** persistence, TTLs of any kind, cross-request/shared cache, x402, on-chain attestation.

**Acceptance (two halves, as always):**
- *Healthy* — same address twice at the same block is a hit and byte-identical; the block advances →
  miss, not a stale serve.
- *Fault-injected* — a changed quorum set misses; a changed catalogue misses; endpoints disagreeing
  on block hash → full refusal; endpoints disagreeing on code → **no hash emitted**; an EOA reports
  `null`, not `keccak256("")`.

**Open decisions:** whether the key *refuses* cross-mode reuse or the cache is *partitioned* per mode
(same effect, different ergonomics); and whether `min(heads)` pinning is acceptable given reports are
then pinned to the laggiest endpoint's view.

---

# Pass 3 — signed responses (mechanism, dev key only)

## 3.1 Call the field `attestation`, not `signature`

`powers[].matched[].signature` already means **function signature** (`"pause()"`). A top-level
`signature` meaning *cryptographic signature* in the same document is a real ambiguity for anyone
writing a verifier. It also gives a cleaner exclusion rule (§3.4).

`viem` — already a dependency — provides `keccak256`, `hashMessage`, `recoverAddress`,
`verifyMessage`, `signatureToHex`. No new dependency.

## 3.2 Sign a canonical CLAIM SUBSET, not the whole report

`reads[]` is telemetry — `httpStatus`, `retriedAttempts`, endpoint ordering. Signing it means signing
noise that varies between honest runs, and enlarging the canonicaliser's attack surface for no gain.
Sign the assertions:

```
subject{chainId, address, blockNumber, blockHash}
observedAt
shape{class, family, variant, scannedAddress, effectiveCodeKeccak256, ownCodeKeccak256, implAddress}
owner{address, kind}
powers[]{power, present, matched[]{signature, selector}, holder, holderKind, severity}
coverage{checked[]{id,kind,group}, notChecked[]{id,kind,group,reason}, totals}
refusal
provenance{schemaVersion, catalogueFingerprint, quorum{endpoints[], required, independenceVerified}}
```

### ⭐ `coverage` MUST be inside the signed payload

This is the load-bearing inclusion. Sign the powers without the manifest and an attacker **strips the
`notChecked` entries and presents a signed report that reads as a complete clean bill** — this
project's central failure mode, cryptographically laundered.

Same argument for two more fields:

- **`refusal`** — a signed refusal is a valuable artifact ("the service attests it *could not*
  determine this") and must not be strippable into a signed non-refusal.
- **`provenance`** — otherwise a signed single-RPC report is indistinguishable from a signed 2-of-2
  quorum report, and the signature attests a weaker claim than the reader assumes.
  `independenceVerified: false` must be **inside** the signature, not decoration around it.

## 3.3 `canon/1` — the canonicalization, and what determinism means

**Determinism means: a given report always canonicalizes to the same bytes.** It does *not* mean two
runs at the same block produce the same signature — `observedAt` is wall-clock and will differ,
correctly. Conflating the two leads to stripping `observedAt` to chase a reproducibility it never
needed.

Rules, all mandatory, versioned as `canon/1` **inside the payload** so a future change cannot
silently invalidate old signatures:

- **RFC 8785 (JCS)** for JSON canonicalization — a published standard, so a verifier in Python or Go
  can reproduce it. **Do not invent one.**
- **Every number is a decimal string.** `blockNumber: "53647839"`, `chainId: "5042002"`. JCS defers to
  ECMAScript number serialization, a precision trap the moment anything exceeds 2^53. Strings sidestep
  it — the same discipline JSON-RPC already uses.
- **All hex lowercase, `0x`-prefixed, NEVER checksummed.** Mixed-case EIP-55 checksums are a
  canonicalization landmine: two byte-different strings for one address.
- **Fixed array order, independent of runtime.** `powers` sorted by `power` **name — not catalogue
  insertion order**, which changes when `POWER_SIGS` grows. `matched[]` by selector.
  `coverage.checked`/`notChecked` by `id`.
- **Explicit `null` for every absent field; no omission.** JCS sorts keys, so omitting one changes the
  byte stream. Fixing the field set per `schemaVersion` means a verifier knows what to expect.
- **Domain-separated prefix** on the signed bytes (§3.5).

This needs to be a written spec, not a comment — a caller re-deriving the bytes must reproduce it
exactly, and "read the source" is not a specification.

## 3.4 Block binding, and the one thing a signature cannot do

The payload binds `blockNumber` **and `blockHash`**. The number alone is an index; the hash is state
identity. Without it, an old signed report replays as current.

It also binds the **pass-2 keccak tuple**, which is where the two passes compose into something
genuinely useful: a holder of a signed report can re-read the impl slot, re-hash the effective code
(2 RPC calls), and get a **cryptographically anchored** answer to "does this attestation still
describe this contract?" — without re-running analysis or trusting the re-checker.

**⚠️ A signature proves "true at block N", never "true now".** No signature can make it mean now.
Freshness is the verifier's policy decision, which is why `verify()` must hand back the block identity
rather than swallowing it.

**Exclusion by object, not by field.** Canonicalize with the entire `attestation` object **absent** —
not set to `null`, absent. Excluding one named object is far less error-prone than excluding a field
nested inside a signed structure, and removes any chance of signing over part of your own signature.

```
attestation: { status, canon, alg, keyClass, keyId, publicKey, signature }
```

## 3.5 ⭐ Domain separation — mark the dev key CRYPTOGRAPHICALLY, not by label

A label is a comment; an attacker edits comments. Prefix the signed bytes with a domain tag that
includes the key class:

```
"tikpema-dd-attestation/canon1/dev"    ← dev/throwaway key signs under this
"tikpema-dd-attestation/canon1/prod"   ← the registered identity signs under this
```

A dev signature is then **mathematically invalid** under the production domain. Relabelling
`keyClass` does not help an attacker — the bytes do not verify. That is the difference between a
marking and a guarantee.

Supporting rules:

- **`attestation` is present on EVERY report, always.** Unsigned reports carry `{ status: "unsigned" }`,
  never a missing field — a missing field reads as safe; a present `status: "unsigned"` cannot.
- The dev key lives in an env var or is generated per-run; **never in the repo**, never committed. Its
  public key goes in the report so a verifier knows exactly what signed it.
- The report states plainly what a dev signature means: *it attests the engine produced this report;
  it does not attest the identity of the service.*
- `keyId` is an opaque string, so swapping in the real identity later is a **value** change, not a
  schema change.

## 3.6 ⭐ `verify()` returns a structured verdict, NOT a bool

A bare `false` is this project's own failure mode in signature form: it collapses *unsigned*,
*dev-signed*, *unknown key*, *unsupported canon version*, and *bad signature* into one
indistinguishable value — and a caller writing `if (verify(r))` would treat a **dev-signed report as
valid**. Absence reading as safe, again.

```js
{ valid: true | false,
  keyClass: "dev-throwaway" | "registered",
  reason: "ok" | "unsigned" | "bad-signature" | "unknown-key" | "unsupported-canon" | "domain-mismatch",
  boundTo: { chainId, blockNumber, blockHash, effectiveCodeKeccak256 } }
```

An unsupported `canon` version must be an explicit `unsupported-canon` (or a throw), **never a silent
`false`** — a verifier that does not understand the canonicalization has learned nothing, which is not
the same as having disproved the signature.

## 3.7 Scope and acceptance

**In:** the `canon/1` spec + canonicaliser, the claim-subset selection, domain-separated sign/verify
against a **dev key**, the `attestation` object, structured `verify()`.

**Out:** the real ERC-8004 identity, any wallet creation, on-chain registration, key
rotation/revocation, public-key distribution.

**⚠️ On deferring the identity** — the DD service's Phase A document is frozen
(`agent-metadata/dd-service.json`) but **not pinned, not mirrored, not registered**, and Phase C is
blocked on the pin. Registration must be **register-only** from an existing wallet id;
`agent-init.mjs` mints a new wallet every run and is how 103 orphan wallets came to exist. Doing
identity work inside a plumbing pass is how orphan 104 gets created. See
`scripts/register-identity.mjs` (`--target dd-service`).

**Acceptance (two halves):**
- *Healthy* — canonicalize twice → byte-identical; sign → `verify` returns `valid: true`; round-trip
  through `JSON.parse(JSON.stringify())` still verifies.
- *Fault-injected* — flip one power's `present` → invalid; **strip one `notChecked` entry → invalid**;
  swap `blockHash` → invalid; change `independenceVerified` → invalid; re-order `powers[]` → **still
  valid** (canonicalization sorts); a dev signature checked under the prod domain →
  `domain-mismatch`, not `bad-signature`; an unsigned report → `reason: "unsigned"`, never a bare
  false.

**Open decisions:** whether `observedAt` belongs in the signed payload at all (it binds *when we
looked*, at the cost of run-to-run signature variance — recommendation: include it); and whether
`reads[]` should be bound by a **hash of the canonicalized reads** rather than excluded outright,
which would let a verifier detect tampered evidence without signing the telemetry.

---

## Cross-cutting: the naming collision to watch

After both passes the repo holds **four** integrity artifacts with four meanings:

| artifact | where | means |
|---|---|---|
| `disclosureDigest()` / `ackTokenFor()` | `netlify/functions/_vault.mjs` | the vault deposit ack — **money path, frozen** |
| `scannedCodeHash` (**sha256**) | `scripts/dd/checks/owner-powers.mjs` | "same deployment as over there?" |
| `effectiveCodeKeccak256` | pass 2 | `EXTCODEHASH`-parity upgrade tripwire |
| `attestation.signature` | pass 3 | who produced this report |

Each needs a one-line "this is not that" in its header, or a future session will conflate them.

## What must NOT change

Neither pass touches `shared/onchain-facts/` or `netlify/functions/_vault.mjs`. The primitive contains
**zero reads and zero awaits** — every function is pure over already-fetched values, and its header
forbids adding a read; that is what made the quorum layer's placement structural rather than a matter
of discipline. `_vault.mjs` keeps its single-RPC viem-multicall path: more failable reads there means
a higher `proxy-status-unreadable` BLOCK rate on Arc's throttled public RPC, a moved
`disclosureDigest()`, and every outstanding user ack invalidated.
