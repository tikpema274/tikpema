# erc8183-quickstart

Runs the full **ERC-8183 job lifecycle** on **Arc Testnet** as a learning proof:
create wallets → fund escrow with USDC → submit a deliverable hash → complete
settlement. Follows the Arc docs quickstart "Create your first ERC-8183 job".

## What it does

`index.ts` drives the whole lifecycle against the deployed ERC-8183 reference
implementation at `0x0747EEf0706327138c69792bF28Cd525089e4583` on Arc Testnet:

1. Creates 2 dev-controlled SCA wallets (client + provider; client also acts as evaluator)
2. **Pauses** for you to fund the *client* wallet with Arc Testnet USDC (faucet)
3. Transfers 1 USDC starter balance to the provider automatically
4. `createJob` → `setBudget` (5 USDC) → `approve` → `fund` → `submit` → `complete`
5. Reads the job back; expects final status `Completed`

Job states: `Open → Funded → Submitted → Completed` (also `Rejected`, `Expired`).

## Credentials

This project **reuses the parent Tikpema project's Circle credentials**. The
`start` script loads `../.env`, which already provides:

- `CIRCLE_API_KEY`
- `CIRCLE_ENTITY_SECRET`

These are the same dev-controlled-wallets credentials the Tikpema agent uses
(`@circle-fin/developer-controlled-wallets`), so no new Console key or entity
secret is needed. No `.env` is stored in this subdirectory.

## Run

```bash
npm install
npm start
```

When the script prints the client wallet address, fund it from a faucet
(https://faucet.circle.com or https://console.circle.com/faucet), then press
Enter to continue.

## Notes

- Each run creates **brand-new wallets** and needs a fresh faucet drip. To reuse
  pre-funded wallets instead, adapt Steps 1–2.
- The public faucet is rate-limited — that's why only the client is faucet-funded
  and the provider gets its starter USDC via transfer.
- `arcTestnet` is imported from `viem/chains` (verified present in viem 2.52.2;
  chain id `5042002`).
- USDC on Arc Testnet: `0x3600000000000000000000000000000000000000`.
