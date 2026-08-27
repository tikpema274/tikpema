# Tikpema — two-plane DeFi on Arc Testnet

**What's built and what state it is in: [app.tikpema.xyz/built](https://app.tikpema.xyz/built)** —
a plain page, one honest line per thing. Start there if you arrived from a link.
The rest of this file is how to build and run it.

Two wallet planes that share Arc underneath but split on **who acts**:

| Plane | Actor | Wallet | Keys | Auth | Where it runs |
|-------|-------|--------|------|------|---------------|
| **Human** | A person | Modular passkey (MSCA) | On user's device | WebAuthn, user present | Browser (`src/`) |
| **Agent** | Your AI agent | Dev-controlled SCA | Server-side entity secret | None — signs unattended | Serverless (`netlify/functions/`) |

Both are ERC-4337 smart accounts, both get **Gas Station sponsorship on Arc** (gasless),
both run on `viem` + `@circle-fin`. The split exists because a passkey needs a human
present for every signature, and an autonomous agent has no human to provide one.

## The security boundary (read this)

The agent's `CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET` control real funds. They live
**only** in serverless function env (no `VITE_` prefix) and never reach the browser.
The frontend talks to the agent only through `/api/agent-*` endpoints. The only
browser-side Circle credential is the Modular `VITE_CLIENT_KEY`, which is domain-locked
and safe to expose.

## What this build does today (patterns 1 + 2)

1. **Agent as its own economic actor** — its own treasury, its own ERC-8004 identity,
   acts autonomously with its own funds.
2. **User funds a task, then the agent acts** — the user signs once (passkey) to fund
   the agent; the agent then acts within that budget on its own.

It does **not** let the agent silently pull from a user's wallet — that needs ERC-6900
session keys, which aren't generally available in Circle Modular Wallets yet. The code
leaves a clean seam (`agent-act.mjs` guard rails) for that when it ships.

## Setup

### 1. Circle Console
- **Modular (human plane):** create a **Client Key** + grab the **Client URL**. Set the
  key's Web Allowed Domain and the Passkey Domain Name both to `localhost` for dev.
- **Dev-controlled (agent plane):** create a **Standard API key** (Keys → Create a key →
  API key → Standard) and **register your Entity Secret**
  (developers.circle.com/wallets/dev-controlled/register-entity-secret).

### 2. Env
```bash
cp .env.example .env
# fill in the values — mind the client vs server comments
```

### 3. Install + run
```bash
npm install
npm install -g netlify-cli   # if you don't have it
npm run dev                   # netlify dev: serves frontend + /api functions together
```
`netlify dev` is required (not plain `vite`) so the `/api/agent-*` functions run locally.

### 3b. Secret-scanning pre-commit hook (one line, per clone)
```bash
npm run hooks:install        # git config core.hooksPath .githooks
```
`npm install` already runs this via `postinstall`, so most people get it for free. Run it
manually if you cloned without installing.

The hook lives in **`.githooks/`, which is tracked** — `.git/hooks/` is not version-controlled,
so a hook installed there would be missing on every fresh clone, which is exactly where nobody
thinks to look for it. It runs `gitleaks protect --staged` (staged changes only, so it's fast
enough to survive daily use) and **fails closed if `gitleaks` isn't installed** — a scanner that
silently no-ops when absent is missing precisely on a new machine. The error message carries the
install command for macOS, Linux/WSL and Go.

Known false positives live in **`.gitleaksignore`, each with its reason** — an allowlist entry
without a reason is how a real finding gets silenced later.

⚠️ **It raises the floor; it does not close the door.** `git commit --no-verify` skips it, and
there is **no CI backstop** — deploys are CLI-only, so nothing re-scans server-side. Treat it as
a cheap net, not a guarantee.

### 4. Bootstrap the agent (one time)
Click **Init + register agent** in the UI (or `POST /api/agent-init`). It creates the
agent's SCA wallet and registers ERC-8004 identity. **Copy the returned ids into your
env** (`AGENT_WALLET_ID`, `AGENT_WALLET_ADDRESS`, `AGENT_ID`) so the agent is reused —
re-running init creates a *new* agent.

Then fund the agent wallet from faucet.circle.com (Arc Testnet) so it has USDC to act with.

## Deploy (Netlify)
Set every env var from `.env` in **Site settings → Environment variables**, then
`git push` / `netlify deploy --prod`. `netlify.toml` already wires the function routes
and SPA fallback.

## Layout
```
src/                      CLIENT PLANE (human)
  config/chain.ts         Arc Testnet viem chain (hand-rolled, rpcUrls shape)
  config/contracts.ts     Arc addresses incl. ERC-8004 registries
  wallet/useModularWallet Passkey -> Circle Smart Account -> gasless transfer
  lib/agentClient.ts      Calls /api/agent-* (never touches secrets)
  components/             ConnectPasskey, AgentPanel
netlify/functions/        AGENT PLANE (server, holds secrets)
  _circle.mjs             Dev-controlled client (entity secret) + tx polling
  _arc.mjs                Server-side Arc constants
  agent-init.mjs          Create SCA wallet + register ERC-8004 identity
  agent-status.mjs        Read identity + USDC balance
  agent-act.mjs           Claude brain decides -> guarded sponsored execution
```

## Notes baked into the code
- Arc bundler enforces a **1 gwei `maxPriorityFeePerGas` floor**; the human send
  overrides it. This does **not** break Gas Station sponsorship.
- Arc chain id `5042002` = hex `0x4CEF52`.
- USDC is native; `0x3600…0000` is its 6-decimal ERC-20 interface.
- Dev-controlled SCA txns on Arc are auto-sponsored (~0.006 USDC/tx, paid by Gas Station).
