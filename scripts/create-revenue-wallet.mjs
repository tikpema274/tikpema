#!/usr/bin/env node
// create-revenue-wallet.mjs — create the ONE dedicated wallet that receives DD-service revenue.
//
// ═══ ⚠️ THIS IS THE ORPHAN-RISK OPERATION. READ BEFORE RUNNING. ═══════════════════════════════
// 103 orphan wallets and 2 orphan identities exist in this project, and they all trace to one
// mechanism: netlify/functions/agent-init.mjs calls createWalletSet() AND createWallets() on EVERY
// invocation, so every run mints a fresh set + wallet and nothing records them. This script is the
// deliberate opposite:
//
//   · ONE-SHOT      — refuses to run if a record already exists (idempotent by refusal, not by luck)
//   · --confirm     — a bare run prints the plan and creates nothing
//   · PERSIST FIRST — the id is written to disk the INSTANT it exists, BEFORE any verification,
//                     logging, or read-back that could throw. A wallet created and not recorded is
//                     orphan 104.
//
// Nothing here moves money. Creating a wallet is free and touches no chain: an SCA address is
// counterfactual until its first outbound transaction, and it can receive USDC before then because
// an ERC-20 balance is just a mapping entry.
//
//   node --env-file=.env scripts/create-revenue-wallet.mjs            # dry run, creates nothing
//   node --env-file=.env scripts/create-revenue-wallet.mjs --confirm  # CREATES
//
// ═══ WHY A NEW WALLET AND NOT AN EXISTING ONE ════════════════════════════════════════════════
// Inventory (read-only, verified): every existing wallet holds a float and is load-bearing.
//   AGENT 0xc54d47…  28.040000 USDC, holds identities 851823 + 851891, SIGNS THE ATTESTATIONS
//   DELEGATE 0x6db396c1…  0.09, used by _delegate/_pay/_ubdeposit
//   VANILLA_SELLER 0x1a63e5…  0.308114 — a NON-ROUND balance, i.e. accumulated prior receipts
//   SELLER_ADDRESS 0xc70112c7…  0.80, the LIVE payTo for x402-quote
//
// ⭐ The decisive reason is not hygiene, it is CORRECTNESS OF RECONCILIATION. Payment confirmation
// reads an inbound USDC Transfer to payTo. That is only attributable if the wallet's ENTIRE history
// is DD revenue. A wallet starting at 0.308114 of unattributed receipts fails that on day one.
// A NEW wallet starts at zero, which makes the reconciliation baseline correct by construction.
//
// Account type SCA: matches the house convention (agent-init.mjs) and the only working Gateway
// payee we have (0xc70112c7… is an SCA, 209 bytes). Receiving works for either type; SCA also keeps
// gas-abstracted sweeps available via Circle if revenue is ever moved.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { circle } from "../netlify/functions/_circle.mjs";
import { ARC } from "../netlify/functions/_arc.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "agent-metadata");
const RECORD = path.join(OUT_DIR, "REVENUE-WALLET.json");

const WALLET_SET_NAME = "Tikpema DD Service Revenue";
const ACCOUNT_TYPE = "SCA";
const CONFIRM = process.argv.includes("--confirm");

function die(msg) {
  console.error(`\n╔══ ABORT ═══════════════════════════════════════════════\n${msg}\n╚════════════════════════════════════════════════════════`);
  process.exit(1);
}

/** Write the record. Called the INSTANT anything is known, before anything that can throw.
 *  Refuses to replace a different walletId — the record may be the only copy of an id that
 *  otherwise exists only inside Circle's account. */
async function persist(patch) {
  await mkdir(OUT_DIR, { recursive: true });
  const prior = await readFile(RECORD, "utf8").then((s) => JSON.parse(s)).catch(() => null);
  if (prior?.walletId && patch.walletId && prior.walletId !== patch.walletId) {
    die(`${RECORD} already records walletId ${prior.walletId}, and this run wants to write ${patch.walletId}.\n` +
        `REFUSING. That file may be the only local record of ${prior.walletId}.`);
  }
  const merged = { ...(prior ?? {}), ...patch, writtenAt: new Date().toISOString() };
  await writeFile(RECORD, JSON.stringify(merged, null, 2) + "\n");
  console.log(`  💾 PERSISTED → ${path.relative(REPO_ROOT, RECORD)}`);
  return merged;
}

console.log("\n╔════════════════════════════════════════════════════════════════════╗");
console.log("║  DD SERVICE — dedicated revenue wallet (payTo)                     ║");
console.log("╚════════════════════════════════════════════════════════════════════╝\n");
console.log(`  mode        : ${CONFIRM ? "⚠️  CONFIRM — WILL CREATE" : "DRY RUN (default) — creates nothing"}`);
console.log(`  wallet set  : "${WALLET_SET_NAME}"  (ONE, named — never a per-run set)`);
console.log(`  accountType : ${ACCOUNT_TYPE}`);
console.log(`  blockchain  : ${ARC.blockchain}`);
console.log(`  record      : ${path.relative(REPO_ROOT, RECORD)}\n`);

// ── ONE-SHOT GUARD ────────────────────────────────────────────────────────────────────────────
{
  const prior = await readFile(RECORD, "utf8").then((s) => JSON.parse(s)).catch(() => null);
  if (prior?.walletId) {
    console.log("╔══ ALREADY CREATED — NOTHING TO DO ═════════════════════════════════");
    console.log(`║  walletId : ${prior.walletId}`);
    console.log(`║  address  : ${prior.address}`);
    console.log("║  A second revenue wallet would be orphan 104. Refusing — correctly.");
    console.log("╚════════════════════════════════════════════════════════════════════");
    process.exit(0);
  }
}

if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET) {
  die("CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET missing. Run with --env-file=.env");
}

if (!CONFIRM) {
  console.log("╔══ DRY RUN — nothing was created ═══════════════════════════════════");
  console.log("║  The operation would be:");
  console.log(`║    1. createWalletSet({ name: "${WALLET_SET_NAME}" })`);
  console.log(`║    2. createWallets({ count: 1, accountType: "${ACCOUNT_TYPE}", blockchains: ["${ARC.blockchain}"] })`);
  console.log("║    3. PERSIST the walletId + address IMMEDIATELY, before any read-back");
  console.log("║    4. verify by GET /wallets/{id} and print");
  console.log("║");
  console.log("║  Re-run with --confirm to create. No money moves either way.");
  console.log("╚════════════════════════════════════════════════════════════════════\n");
  process.exit(0);
}

const client = circle();

// ── 1. the wallet set. Persisted before the wallet call, so a failure there still leaves a trail ──
console.log("── creating the wallet set ─────────────────────────────────────────");
let walletSetId;
{
  const res = await client.createWalletSet({ name: WALLET_SET_NAME });
  walletSetId = res.data?.walletSet?.id;
  if (!walletSetId) die(`Circle returned no walletSet id. Raw: ${JSON.stringify(res?.data)?.slice(0, 300)}`);
  console.log(`  walletSetId: ${walletSetId}`);
  await persist({ walletSetId, walletSetName: WALLET_SET_NAME, purpose: "DD service x402 revenue (payTo)" });
}

// ── 2. the wallet, then PERSIST BEFORE ANYTHING ELSE ─────────────────────────────────────────
console.log("\n── creating the wallet ─────────────────────────────────────────────");
let wallet;
{
  const res = await client.createWallets({
    blockchains: [ARC.blockchain],
    count: 1,
    walletSetId,
    accountType: ACCOUNT_TYPE,
  });
  wallet = res.data?.wallets?.[0];
  if (!wallet?.id) die(`Circle returned no wallet. THE WALLET MAY STILL EXIST — check the wallet set ${walletSetId} in the Circle console before re-running.\nRaw: ${JSON.stringify(res?.data)?.slice(0, 300)}`);

  // ⭐ THE LINE THIS SCRIPT EXISTS FOR. Nothing between createWallets returning and this write.
  await persist({
    walletId: wallet.id,
    address: wallet.address,
    accountType: wallet.accountType ?? ACCOUNT_TYPE,
    blockchain: wallet.blockchain ?? ARC.blockchain,
    state: wallet.state,
    createDate: wallet.createDate,
    note: "CREATED by create-revenue-wallet.mjs. This is payTo for DD-service x402 revenue. It must receive NOTHING else — reconciliation attributes every inbound USDC Transfer to a DD payment.",
  });
}

// ── 3. verify from Circle, after the record is already safe ──────────────────────────────────
console.log("\n── verifying ───────────────────────────────────────────────────────");
{
  const res = await fetch(`https://api.circle.com/v1/w3s/wallets/${wallet.id}`, {
    headers: { Authorization: `Bearer ${process.env.CIRCLE_API_KEY}` },
  });
  const j = await res.json();
  const w = j?.data?.wallet;
  console.log(`  id         : ${w?.id}`);
  console.log(`  address    : ${w?.address}`);
  console.log(`  accountType: ${w?.accountType}`);
  console.log(`  blockchain : ${w?.blockchain}`);
  console.log(`  state      : ${w?.state}`);
}

console.log(`
╔══ ⚠️  NOT DONE YET ════════════════════════════════════════════════
║  1. COMMIT ${path.relative(REPO_ROOT, RECORD)} — a wallet id that exists only
║     on this disk is how the 103 orphans happened.
║  2. This wallet must receive NOTHING but DD revenue. Its zero starting
║     balance is what makes Transfer-to-payTo reconciliation attributable;
║     any other inbound flow destroys that property permanently.
║  3. Do NOT fund it. It is a payee, not a spender.
╚════════════════════════════════════════════════════════════════════
`);
