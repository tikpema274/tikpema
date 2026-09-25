# DD report attestation — `canon/1` verifier specification

> **⚠️ Notice (2026-09-26).** Before 2026-09-26, this document's example and our reference
> `verifyAttestation()` took the registry and verifying contract from the report itself and did not
> check the chain. A report checked that way was shown to be accepted by *some* contract, not by
> agentId 851891's owner. Re-verify any report you checked before that date using the corrected
> steps (§4, starting with step 0). Every paid report we have issued (three, all bought by our own
> operator wallet) passes the corrected check. In-app reports are not stored by us; if you kept one,
> you can re-verify it the same way.

How to verify a signed report from the Tikpema DD Service without trusting any server we run, and
without reading our source. A caller re-deriving the signed bytes must be able to reproduce them
exactly; "read the implementation" is not a specification.

- **Identity:** ERC-8004 `agentId 851891` on Arc Testnet (chainId `5042002`)
- **IdentityRegistry:** `0x8004a818bfb912233c491871b3d84c89a494bd9e`
- **Method:** ERC-1271 (`attestation.method == "erc1271"`)
- **Implementation:** `shared/onchain-analyze/attest.mjs`

---

## 🪤 The footgun — read this before writing a verifier

**The digest is the EIP-191 `personal_sign` hash of the message. It is NOT `keccak256` of the
message.**

A verifier that canonicalizes correctly, then hashes those bytes with plain `keccak256` and calls
`isValidSignature`, gets `0xffffffff` back — and will report a **perfectly valid signature as
invalid**. This is a wrong answer, not an error: nothing throws, nothing warns, and the wrong
conclusion looks exactly like a real tampering finding.

This is measured, not theorised. In the feasibility spike, the same signature over the same message:

| digest passed to `isValidSignature` | returned |
| --- | --- |
| EIP-191 `personal_sign` hash | `0x1626ba7e` ✅ |
| raw `keccak256(message)` | `0xffffffff` ❌ |

Correct:

```js
import { hashMessage } from "viem";
const digest = hashMessage(`${domain}\n${canonicalJson}`);   // ✅ EIP-191
```

Wrong, and silently so:

```js
const digest = keccak256(toBytes(`${domain}\n${canonicalJson}`)); // ❌ always 0xffffffff
```

The EIP-191 hash is `keccak256("\x19Ethereum Signed Message:\n" + len(message) + message)`.

---

## 1. What gets signed

The signed bytes are:

```
<domain> "\n" <canonical JSON of the report>
```

The production domain is:

```
tikpema-dd-attestation/canon1/prod
```

A signature made under any other domain is mathematically invalid under this one. Under this
binding the separation is also **structural**: a dev or throwaway wallet is a *different smart
account*, so its signature fails `isValidSignature` against the production account regardless of
what the domain string says. The domain is checked from the declared `attestation.domain` **before**
any call, because ERC-1271 returns only valid/invalid and could not otherwise distinguish a domain
mismatch from a bad signature.

### 1.1 Which fields are signed — exclusion, not inclusion

**Everything in the report is signed except two objects, excluded by object:**

| excluded | why |
| --- | --- |
| `reads` | telemetry — `httpStatus`, retry counts, endpoint ordering. Varies between honest runs. |
| `attestation` | excluded *by object*, absent rather than `null`, so nothing signs over part of its own signature. |

This is deliberately an exclusion list. An inclusion list **fails open** when the schema grows: a
field added later would be unsigned by default and nothing would say so. An exclusion list fails
closed — a new field is signed automatically, and mistakenly signing telemetry costs signature
stability, which is noisy and visible rather than silent and dangerous.

Consequences worth stating, because they are the point:

- **`coverage` is inside the signature.** Strip the `notChecked` entries from a signed report and it
  would read as a complete clean bill — this engine's central failure mode, cryptographically
  laundered. Tampering with coverage breaks the signature.
- **`refusal` is inside the signature.** A signed refusal ("the service attests it could *not*
  determine this") is a real artifact and must not be strippable into a signed non-refusal.
- **`sources` is inside the signature**, including `independenceVerified: false`. Otherwise a signed
  single-RPC report is indistinguishable from a signed quorum report, and the signature would attest
  a weaker claim than the reader assumes.

## 2. `canon/1` canonicalization

All rules are mandatory. The version is carried *inside* the attestation (`attestation.canon`) so a
future change cannot silently invalidate old signatures.

1. **RFC 8785 (JCS)** JSON canonicalization — object keys sorted by UTF-16 code unit, no whitespace.
2. **Every number is a decimal string.** `blockNumber: "53647839"`, not `53647839`. JCS defers to
   ECMAScript number serialization, a precision trap above 2^53. Strings sidestep it — the same
   discipline JSON-RPC already uses. `canon/1` has **no float encoding**; a non-integer number is an
   error, not a rounding.
3. **All-hex strings are lowercased**, `0x`-prefixed, **never checksummed**. Mixed-case EIP-55 is a
   canonicalization landmine: two byte-different strings for one address. Only strings matching
   `^0x[0-9a-fA-F]*$` are lowercased, so prose is never mangled.
4. **Fixed array order, independent of runtime:**
   - `powers` by `power` **name** — not catalogue insertion order, which changes when the catalogue grows
   - `matched[]` by `selector`
   - `coverage.checked` / `coverage.notChecked` by `id`
   - `sources.endpoints` and `powersPresent` lexicographically
5. **`undefined` is an error, never an omission.** JCS sorts keys, so a vanished field changes the
   byte stream. Absent values must be explicit `null`.

Reordering `powers[]` in a signed report leaves it **valid** — canonicalization sorts. That is the
intended behaviour, not a weakness.

### What determinism means here

A **given report** always canonicalizes to the same bytes. It does **not** mean two runs against the
same block produce the same signature — any wall-clock field differs between runs, correctly.
Conflating the two leads to stripping fields to chase a reproducibility that was never needed.

## 3. The attestation object

Present on **every** report, always. An unsigned report carries `{ status: "unsigned", … }` — never
a missing field, because a missing field reads as safe and a present `status: "unsigned"` cannot.

```jsonc
{
  "status": "signed",
  "canon": "canon/1",
  "domain": "tikpema-dd-attestation/canon1/prod",
  "alg": "eip191-ecdsa-secp256k1",
  "method": "erc1271",
  "keyClass": "registered",
  "keyId": "circle-wallet:2c93ca5d-…",   // opaque — swapping signers is a VALUE change, not schema
  "agentId": "851891",
  "verifyingContract": "0xc54d47211997aca90ef4fcfbc742a3b511b4e621",
  "registry": "0x8004a818bfb912233c491871b3d84c89a494bd9e",
  "chainId": "5042002",
  "signature": "0x…",                     // 65-byte ECDSA, no wrapper
  "blockHashBound": false,
  "validityMeaning": "ERC-1271 answers 'is this signature valid NOW' …"
}
```

## 4. How to verify — step 0, then the two on-chain halves

### Step 0 — the identity is compared, never used

The `attestation` object is not signed. Its `agentId`, `registry`, `chainId` and `domain` are claims.
Compare them with the constants at the top of this document and refuse any report that differs. Never
use them as inputs. Check that your RPC's `eth_chainId` is 5042002 before either read.

A report can name any registry it likes. If you ask *that* registry who owns `851891`, a forger's
registry answers with a forger's contract, and a contract that accepts every signature returns
`0x1626ba7e` for a report with every finding erased. That was demonstrated against the live chain on
2026-09-25. The two reads below are only meaningful against the **pinned** registry.

The verifying contract is **not** a constant to compare: it is whatever `ownerOf(851891)` returns on
the pinned registry at the time you verify. If the identity's owner account is ever rotated, new
reports verify against the new account (and old ones stop — see the durability caveat, §6).

### The two on-chain halves

```
0.  eth_chainId                                         → expect 5042002, else wrong-chain (indeterminate)
1.  ownerOf(851891) on 0x8004a818…bd9e (PINNED)         → the verifying contract; must equal attestation.verifyingContract
2.  isValidSignature(digest, signature) on THAT account → expect 0x1626ba7e
```

Step 1 is what makes step 2 mean anything. A signature that validates against *some* contract proves
nothing until that contract is shown to be the identity's owner of record — on the identity's own
registry, not on one the report names.

```js
import { hashMessage } from "viem";

// the constants at the top of this document — NOT read from the report
const AGENT_ID = "851891";
const REGISTRY = "0x8004a818bfb912233c491871b3d84c89a494bd9e";
const CHAIN_ID = 5042002n;
const DOMAIN   = "tikpema-dd-attestation/canon1/prod";

// step 0 — claims are compared, never used
if (att.agentId !== AGENT_ID || att.registry.toLowerCase() !== REGISTRY ||
    att.chainId !== String(CHAIN_ID))                        → identity-mismatch
if (att.domain !== DOMAIN)                                   → domain-mismatch
if (BigInt(await rpc("eth_chainId")) !== CHAIN_ID)          → wrong-chain (indeterminate)

const message = `${att.domain}\n${canonicalize(report)}`;
const digest  = hashMessage(message);            // ⚠️ EIP-191 — see the footgun

// step 1 — ownerOf(AGENT_ID) on the PINNED registry: the verifying contract is derived here
const owner = "0x" + (await call(REGISTRY, "0x6352211e" + pad32(BigInt(AGENT_ID)))).slice(-40);
if (owner.toLowerCase() !== att.verifyingContract.toLowerCase()) → owner-key-mismatch

// step 2 — isValidSignature(bytes32,bytes) on the account ownerOf returned
const ret = await call(owner, encodeIsValidSignature(digest, att.signature));
ret.slice(0, 10) === "0x1626ba7e"  → valid
```

### Why not `ecrecover`?

**It cannot work, and the attempt fails in a dangerous direction.** The owner of `851891` is a Circle
developer-controlled **smart contract account** (`circle_6900_singleowner_v3`) — 209 bytes of code,
no private key of its own. No signature `ecrecover`s to `0xc54d47…`.

The signature *is* plain 65-byte ECDSA and *can* be recovered offline — but it recovers to the smart
account's **owner key**, an address with no on-chain link to `851891` except through that account's
own storage. A verifier who recovers a key and compares it to something they were told out of band
has replaced an on-chain fact with a declaration. The `eth_call` is load-bearing.

## 5. The verdict is structured, never a bool

`verifyAttestation()` returns a verdict object. A bare `false` would collapse *unsigned*, *unknown
key*, *unsupported canon*, *owner mismatch*, *RPC unreachable* and *bad signature* into one
indistinguishable value — and `if (verify(r))` would treat a report **nobody could check** as one
that was checked and failed. **"Unverified" must never collapse into "invalid."**

`valid` is **tri-state**:

| `valid` | meaning |
| --- | --- |
| `true` | the owning account validated the signature |
| `false` | a definite negative — we checked, it does not hold |
| `null` | **indeterminate** — we could not check. Falsy on purpose, so a naive `if (v.valid)` still fails closed while `v.reason` carries the real answer. |

| `reason` | `valid` | means |
| --- | --- | --- |
| `ok` | `true` | verified end to end |
| `unsigned` | `false` | no attestation — the report was never signed |
| `bad-signature` | `false` | the owning account rejected it: altered after signing, or signed by a different key |
| `owner-key-mismatch` | `false` | `verifyingContract` is not `ownerOf(agentId)` — not attested by the identity it claims |
| `identity-mismatch` | `false` | the attestation's `registry`, `agentId` or `chainId` is not this identity's — a claim that differs is refused before any read (the attestation object is not signed) |
| `unknown-key` | `false` | attests a different `agentId` than the caller expected |
| `domain-mismatch` | `false` | signed under a different domain (e.g. a dev key) |
| `unsupported-canon` | `null` | this verifier does not implement that canonicalization — it has **learned nothing**, which is not the same as having disproved the signature |
| `unsupported-method` | `null` | `method` is not `erc1271` |
| `malformed-attestation` | `null` | required fields missing or `status` unrecognised |
| `wrong-chain` | `null` | the verifying RPC's `eth_chainId` is not the identity's chain — nothing was read, so nothing was learned; **not** a negative result |
| `indeterminate-rpc` | `null` | a chain read did not complete — **not** a negative result |

## 6. ⚠️ What a valid signature does and does not mean

**It means:** these exact report bytes were produced by the holder of ERC-8004 identity `851891` at
the time of signing.

**It does not mean:**

- **That the report is true now.** A signature proves "true at block N", never "true now". Freshness
  is the verifier's policy decision, which is why the verdict hands back `boundTo` rather than
  swallowing it.
- **That the subject contract is unchanged since.** `blockHashBound: false` — block-hash and
  bytecode-hash pinning are pass 2 and are not built. The payload binds the block *number*, which is
  an index, not state identity. An attestation does not by itself prove the contract has not changed
  since it was written.
- **That the service is independent.** `sources.independenceVerified` is inside the signature and is
  `false`. The signature attests authorship, not impartiality.
- **That any verdict was reached.** The engine emits no verdicts. A signed inventory is still an
  inventory.

### The durability caveat

**ERC-1271 answers "is this signature valid *now*", not "was it valid when issued."** Validity is a
live contract call against the owning smart account. **If that account's owner key is ever rotated,
previously issued attestations stop verifying** — the reports are unchanged and were never invalid,
but the on-chain check that proves it will return `0xffffffff`.

This is the accepted cost of binding to the identity's owner of record rather than to a separately
declared key. It is carried machine-readably on every attestation as `validityMeaning`, and returned
on every verdict as `meaning`, so it travels with the artifact instead of living only in this file.
