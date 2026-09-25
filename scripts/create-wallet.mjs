#!/usr/bin/env node
// create-wallet.mjs — create ONE named Circle developer-controlled wallet, and never an orphan.
//
//   npm run create-wallet -- --name "Tikpema escrow reclaim"             # dry run: prints the plan, creates nothing
//   npm run create-wallet -- --name "Tikpema escrow reclaim" --confirm   # CREATES it
//
// ═══ ⚠️ WHY THIS IS CAREFUL (the create-revenue-wallet.mjs pattern, generalised) ═══════════════
// 103 orphan wallets exist in this project because code minted wallets without recording them. So:
//   · ONE PER NAME   — refuses if agent-metadata/wallets/<slug>.json already exists
//   · --confirm      — a bare run prints the plan and creates nothing
//   · PERSIST FIRST  — each id is written to disk the INSTANT it exists (the wallet set, then the wallet),
//                      before any read-back or logging that could throw. A wallet created and not
//                      recorded is orphan 104.
//
// Nothing here moves money. Creating a wallet is a free Circle API call and touches no chain: an SCA's
// address is counterfactual until its first transaction (Gas Station sponsors that on testnet).
// The name goes on BOTH the wallet set and the wallet's own `name`, so it reads the same in Circle's console.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { circle } from "../netlify/functions/_circle.mjs";
import { ARC } from "../netlify/functions/_arc.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(REPO_ROOT, "agent-metadata", "wallets");
const argv = process.argv.slice(2);
const CONFIRM = argv.includes("--confirm");
const ni = argv.indexOf("--name");
const NAME = ni >= 0 ? String(argv[ni + 1] ?? "").trim() : "";
const TYPE = (argv.includes("--eoa") ? "EOA" : "SCA");

function die(msg) { console.error(`\n⛔ ABORT — ${msg}\n`); process.exit(1); }
if (!NAME) die('a name is required: npm run create-wallet -- --name "Tikpema escrow reclaim" [--confirm]');
if (NAME.length > 60) die("keep the name to 60 characters or fewer");
const slug = NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const RECORD = path.join(OUT_DIR, `${slug}.json`);

async function persist(patch) {
  await mkdir(OUT_DIR, { recursive: true });
  const prior = await readFile(RECORD, "utf8").then((s) => JSON.parse(s)).catch(() => null);
  for (const k of ["walletSetId", "walletId"]) {
    if (prior?.[k] && patch[k] && prior[k] !== patch[k]) die(`${RECORD} already records ${k} ${prior[k]}; refusing to overwrite it with ${patch[k]}`);
  }
  const merged = { ...(prior ?? {}), ...patch, writtenAt: new Date().toISOString() };
  await writeFile(RECORD, JSON.stringify(merged, null, 2) + "\n");
  console.log(`  💾 recorded → ${path.relative(REPO_ROOT, RECORD)}`);
  return merged;
}

const existing = await readFile(RECORD, "utf8").then((s) => JSON.parse(s)).catch(() => null);
console.log(`\nwallet name:   ${NAME}`);
console.log(`record file:   ${path.relative(REPO_ROOT, RECORD)}`);
console.log(`blockchain:    ${ARC.blockchain}   account type: ${TYPE}`);
if (existing?.walletId) {
  console.log(`\n✅ ALREADY EXISTS — nothing to do:\n   walletId ${existing.walletId}\n   address  ${existing.walletAddress ?? "(not yet read back)"}`);
  process.exit(0);
}
if (existing?.walletSetId) console.log(`⚠️ a previous run created wallet set ${existing.walletSetId} but no wallet — this run reuses it.`);
if (!CONFIRM) {
  console.log(`\nDRY RUN — nothing was created. Re-run with --confirm to create "${NAME}".`);
  process.exit(0);
}

const client = circle();
let walletSetId = existing?.walletSetId;
if (!walletSetId) {
  const ws = await client.createWalletSet({ name: NAME });
  walletSetId = ws.data?.walletSet?.id;
  if (!walletSetId) die("createWalletSet returned no id — nothing recorded, nothing to clean up");
  await persist({ name: NAME, walletSetId, blockchain: ARC.blockchain, accountType: TYPE });
}
const w = await client.createWallets({ blockchains: [ARC.blockchain], count: 1, walletSetId, accountType: TYPE, metadata: [{ name: NAME }] });
const wallet = w.data?.wallets?.[0];
if (!wallet?.id) die(`createWallets returned no wallet for set ${walletSetId} (recorded) — re-run to retry into the same set`);
await persist({ walletId: wallet.id, walletAddress: wallet.address, state: wallet.state ?? null, createDate: wallet.createDate ?? null });

console.log(`\n✅ CREATED "${NAME}"\n   walletId ${wallet.id}\n   address  ${wallet.address}\n   set      ${walletSetId}`);
console.log(`\nIt holds nothing and is not deployed yet; its first transaction deploys it (sponsored by Gas Station).`);
