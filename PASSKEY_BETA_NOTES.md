# Passkey (Circle Modular Wallet) — Deployed-Domain Blocker Checklist

**Symptom:** Clicking **Register passkey** on the deployed site
(`tikpema-predict-test.netlify.app`) throws **"Invalid credentials"**.
Works on `localhost`.

**Status:** Investigation only — nothing changed, nothing deployed, nothing
registered. This file is the precise requirements list to fix it later.

---

## TL;DR — what's actually wrong

Two independent blockers, both must be fixed:

1. **`VITE_CLIENT_KEY` and `VITE_CLIENT_URL` are NOT set on Netlify** (verified
   via `netlify env:list` for both `dev` and `production` contexts — only 5
   unrelated vars exist). Vite inlines `VITE_*` at **build time**, so the
   deployed bundle ships `clientKey = undefined` / `clientUrl = undefined`.
   Circle's RP API rejects the undefined/empty client key → **"Invalid
   credentials"**. This is the #1 cause and fully explains the symptom.

2. **The Circle Console almost certainly has the Client Key's *Allowed Domain*
   and the Passkey *Domain Name* set to `localhost`, not the Netlify domain.**
   Passkeys are domain-locked (WebAuthn RP-ID). Even after fixing #1, a
   localhost-only client key will keep failing on the deployed origin. Circle
   docs are explicit: *"passkeys created on localhost or testnet domains will
   not work on the production domain"* and the Client Key **Allowed Domain**
   must match the Passkey **Domain Name** exactly.

Fix order: set the env vars (#1) → then align the Console domains (#2).

---

## "Invalid credentials" — what it maps to (causes ranked by likelihood)

`"Invalid credentials"` is **not** our own string — it does not appear anywhere
in `src/` or `netlify/`. It is surfaced verbatim from the SDK at
`src/wallet/useModularWallet.ts:112` (`setStatus(\`Error: ${e.message}\`)`),
i.e. it is the `.message` thrown by `toWebAuthnCredential` when the **passkey
transport** (`toPasskeyTransport`) calls Circle's Relying-Party (RP) API and
that API rejects the request.

Critically, it is an **API-layer auth rejection of the *client key / app
identity*** — NOT a browser WebAuthn `DOMException`. The WebAuthn
domain-mismatch error is a separate `SecurityError`; the user-cancel error is
`NotAllowedError`. "Invalid credentials" sits *before* the browser passkey
prompt, at the point Circle authenticates our app.

Ranked causes:

1. **Client key missing/empty in the deployed build (HIGHEST).** `VITE_CLIENT_KEY`
   absent on Netlify → `clientKey` is `undefined` in the production bundle →
   Circle RP API: invalid credentials. **Confirmed missing in this repo's
   Netlify project.**
2. **Client key present but its *Allowed Domain* does not include
   `tikpema-predict-test.netlify.app`.** Circle authorizes a client key per
   origin; a request from a non-allow-listed origin is rejected as
   unauthorized → can also surface as "Invalid credentials".
3. **Wrong/typo'd client URL** (`VITE_CLIENT_URL`) pointing the passkey
   transport at the wrong RP endpoint. Less likely; correct value is known
   (see below).
4. **Wrong key type** (e.g. an API key instead of a Client Key, or a
   `LIVE_*` key on testnet). Not the case locally; just verify the value
   copied into Netlify is the same `TEST_CLIENT_KEY:...` used locally.

> Note: a Passkey **Domain Name** mismatch (RP-ID) typically throws the browser
> `SecurityError` *after* app auth, not "Invalid credentials". So the Passkey
> Domain Name is a real blocker but is likely the *next* error you hit once the
> client key is valid — fix it in the same pass.

---

## Required browser env vars (Modular SDK)

Read in `src/wallet/useModularWallet.ts:19-20`:

| Var | Purpose | Correct value |
|-----|---------|---------------|
| `VITE_CLIENT_KEY` | Circle Console **Client Key** — identifies & authorizes our web app to Circle's Modular Wallet + RP APIs. Domain-restricted, browser-safe. | `TEST_CLIENT_KEY:...` (the exact value in local `.env`; see `.env.example:11`) |
| `VITE_CLIENT_URL` | Base Client URL for both transports (passkey RP + modular bundler/RPC). | `https://modular-sdk.circle.com/v1/rpc/w3s/buidl` (`.env.example:12`) |

How they're used (`src/wallet/useModularWallet.ts:23-24`):
```ts
const passkeyTransport = toPasskeyTransport(clientUrl, clientKey);              // RP API: register/login
const modularTransport = toModularTransport(`${clientUrl}/arcTestnet`, clientKey); // bundler/RPC, Arc Testnet
```

### How to verify they're set correctly on Netlify
```bash
netlify env:list                       # dev context
netlify env:list --context production  # production build context
netlify env:get VITE_CLIENT_KEY        # confirm value + scope
netlify env:get VITE_CLIENT_URL
```
**Current result: both vars are ABSENT in dev and production.** Netlify
currently only has: `AGENT_WALLET_ADDRESS`, `ANTHROPIC_API_KEY`,
`CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `PREDICT_MODEL`.

Gotchas when adding them later:
- Must be `VITE_`-prefixed (already are) so Vite inlines them.
- Must exist at **build time** in the **production** context (not just dev) —
  Netlify builds the deploy with the production context.
- After adding, a **redeploy/rebuild is required** — env changes don't affect
  an already-built bundle.

---

## Does the production domain need to be registered/allow-listed in Circle Console?

**Yes — in two places, and they must match exactly.** Passkeys are domain-bound
via the WebAuthn RP-ID, and Circle additionally scopes the client key by origin.

Console → **API & Client Keys**:
1. **Client Key → Web "Allowed Domain"** must include the deployed origin.
2. **Passkey → "Domain Name"** must be set to the same deployed origin.

Circle docs (console-setup): *"the Client Key's **Allowed Domain** input value
must match exactly the Passkey's **Domain Name** configuration."*

**Exact value to use:** the **bare domain, no scheme, no path, no trailing
slash** →
```
tikpema-predict-test.netlify.app
```
(For local dev the value is `localhost`.) If both localhost and the Netlify
domain are needed, Circle recommends a **separate Client Key per domain** over
multi-domain on one key.

> Caveat to verify in-Console: confirm whether a single Client Key entry accepts
> multiple Allowed Domains or whether `localhost` + the Netlify domain need two
> keys. If two keys, the deployed build's `VITE_CLIENT_KEY` must be the
> Netlify-domain key, while local `.env` keeps the `localhost` key.

---

## localhost vs deployed — concrete differences

| Aspect | localhost (works) | Deployed (fails today) |
|--------|-------------------|------------------------|
| `VITE_CLIENT_KEY` source | local `.env` (real value present) | **missing on Netlify → `undefined` in bundle** |
| `VITE_CLIENT_URL` source | local `.env` | **missing on Netlify → `undefined`** |
| WebAuthn **RP-ID / origin** | `localhost` | `tikpema-predict-test.netlify.app` |
| Client Key **Allowed Domain** | `localhost` (assumed) | must be `tikpema-predict-test.netlify.app` |
| Passkey **Domain Name** | `localhost` (assumed) | must be `tikpema-predict-test.netlify.app` |
| Passkeys portable? | No — a credential created on `localhost` cannot be used on the Netlify origin (different RP-ID); users re-register on the deployed domain. |

---

## Where the Modular client is initialized (for the eventual fix)

**`src/wallet/useModularWallet.ts`** — single source of truth.

- `:19` `const clientKey = import.meta.env.VITE_CLIENT_KEY as string;`
- `:20` `const clientUrl = import.meta.env.VITE_CLIENT_URL as string;`
- `:23` `toPasskeyTransport(clientUrl, clientKey)` — RP API (register/login)
- `:24` `toModularTransport(\`${clientUrl}/arcTestnet\`, clientKey)` — bundler/RPC
- `:25-28` `createPublicClient({ chain: arcTestnet, transport: modularTransport })`
- `:95` `connect(mode, username = "tikpema-user-2")` — passkey entry point
- `:99-103` `toWebAuthnCredential({ transport: passkeyTransport, mode, username })`
  ← **this is the call that throws "Invalid credentials"**
- `:104-107` `toCircleSmartAccount({ client, owner: toWebAuthnAccount({ credential }) })`
- `:111-112` `catch (e) { setStatus(\`Error: ${e.message}\`) }` ← where the message is shown

UI trigger: `src/components/ConnectPasskey.tsx` → `w.connectRegister()` /
`w.connectLogin()` (exposed at `useModularWallet.ts:198-199`).

Config files: `.env.example:11-12` documents both vars;
`.env` holds the real local values; `netlify.toml` has no env section (so the
vars must be set in the Netlify UI/CLI, not the toml).

---

## Fix checklist (do NOT execute yet — recorded for later)

- [ ] **Confirm Console domains.** In Circle Console → API & Client Keys, check
      the existing Client Key's **Allowed Domain** and the **Passkey Domain
      Name**. Decide: add `tikpema-predict-test.netlify.app` to the existing key,
      or create a new Client Key scoped to the Netlify domain.
- [ ] Ensure **Allowed Domain == Passkey Domain Name ==
      `tikpema-predict-test.netlify.app`** (bare domain, no `https://`, no path).
- [ ] Set on Netlify (production context, build-time):
      `netlify env:set VITE_CLIENT_KEY "<the deployed-domain client key>"`
      and `netlify env:set VITE_CLIENT_URL "https://modular-sdk.circle.com/v1/rpc/w3s/buidl"`.
- [ ] **Redeploy** so Vite re-inlines the vars into the bundle.
- [ ] Verify with `netlify env:list --context production` then test Register on
      the live site. Expect the browser passkey prompt to appear (no "Invalid
      credentials").
- [ ] If it then throws `SecurityError` → Passkey Domain Name still doesn't
      match the origin (revisit step 2). If `InvalidStateError` → credential
      already exists, use Login. (Per Circle error table.)
- [ ] Note: passkeys registered on `localhost` won't carry over — re-register on
      the deployed domain.
