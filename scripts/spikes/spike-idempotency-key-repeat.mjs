// spike-idempotency-key-repeat.mjs — PIECE 5 step 2's measurement: what does Circle do with a REPEATED idempotency key?
// Recovery (the mandate exit, step 6) is built on the answer: may it RE-SEND with the intent's derived key, or must it
// only LOOK the transaction up? (PROGRESS: "THE REPEATED-IDEMPOTENCY-KEY MEASUREMENT", T 2026-09-28.)
//
// ═══ WHAT IT SENDS ══════════════════════════════════════════════════════════════════════════════════
// Only USDC `approve(<the wallet's own address>, 0 | 1)` on Arc testnet, from a DEDICATED throwaway SCA:
// an allowance from the wallet to ITSELF. No USDC moves; gas is sponsored (Gas Station). ⛔ Never the operator
// mandate's wallet 0x3cb7…2de9 (its receipts stay clean) — refused by the script.
//
// ═══ THE FIVE STEPS (one --confirm run) ═════════════════════════════════════════════════════════════
//   1. key K1 + approve(self, 0), sent TWICE back to back → same tx id? a 409? a NEW transaction?
//   2. key K1 + approve(self, 1) — the SAME key, a DIFFERENT payload → refused? or the first transaction returned?
//   3. key K3, shaped like a UUIDv5 (version nibble 5) + approve(self, 0) → accepted, or rejected as invalid?
//      (informational: our derivation is v4-shaped, shared/circle-idempotency.mjs)
//   4. after ~30 s: fetch every returned id, and count the approves that LANDED on chain from the SCA in the window
//      (USDC Approval events, owner = spender = the SCA). PASS: exactly ONE per key.
//   5. once K1's first transaction is COMPLETE: key K1 + approve(self, 0) again → same id? new tx? — then recount.
//      (Recovery reuses the key AFTER completion, not only in flight.)
// Every call is recorded — request, the exact response or error (status + Circle's code/message), timing — into
// scripts/spikes/idempotency-key-repeat-<ISO>.json. Nothing secret is printed or written: never the API key, never the
// entity secret (the SDK handles the ciphertext itself); wallet ids, addresses, idempotency keys and tx ids are not
// secrets.
//
// ═══ MODES ══════════════════════════════════════════════════════════════════════════════════════════
//   node --env-file=.env scripts/spikes/spike-idempotency-key-repeat.mjs --provision
//       create a NEW wallet set + ONE Arc-testnet SCA for this measurement. Prints its address and wallet id only.
//   WALLET_ADDRESS=0x… node --env-file=.env scripts/spikes/spike-idempotency-key-repeat.mjs
//       DRY RUN (read-only): preflight — the wallet is ours, not the operator mandate's, deployed or not; the exact calls.
//   WALLET_ADDRESS=0x… node --env-file=.env scripts/spikes/spike-idempotency-key-repeat.mjs --warmup
//       ONE un-keyed approve(self, 0) to DEPLOY a fresh SCA, so deployment cannot contaminate step 1. Refused if deployed.
//   WALLET_ADDRESS=0x… node --env-file=.env scripts/spikes/spike-idempotency-key-repeat.mjs --confirm
//       THE MEASUREMENT (steps 1–5). Refused unless the SCA is deployed. Sends at most 5 approves.
// Credentials: CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET from .env (the spikes' rule; never from Netlify production).

import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createPublicClient, http, encodeFunctionData, parseAbi, parseAbiItem, getAddress } from "viem";
import { circle } from "../../netlify/functions/_circle.mjs";
import { ARC, CONTRACTS } from "../../netlify/functions/_arc.mjs";
import { isV4Uuid } from "../../shared/circle-idempotency.mjs";

const OPERATOR_MANDATE_WALLET = "0x3cb76ac688f3fc02dfe4033d388989a44f132de9"; // ⛔ never measured on
const USDC = getAddress(CONTRACTS.USDC);
const WAIT_MS = 30_000;
const COMPLETE_DEADLINE_MS = 120_000;
const MODE = process.argv.includes("--provision") ? "provision" : process.argv.includes("--warmup") ? "warmup" : process.argv.includes("--confirm") ? "confirm" : "dry";
const log = (s = "") => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const k of ["CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET"]) if (!process.env[k]) { console.error(`Missing ${k} (.env) — run with node --env-file=.env`); process.exit(2); }
const client = circle();
const pc = createPublicClient({ transport: http(ARC.rpc) });

// ── provision ───────────────────────────────────────────────────────────────────────────────────────
if (MODE === "provision") {
  const ws = await client.createWalletSet({ name: `idempotency-measure ${new Date().toISOString()}` });
  const r = await client.createWallets({ blockchains: [ARC.blockchain], count: 1, walletSetId: ws.data?.walletSet?.id ?? "", accountType: "SCA" });
  const w = r.data?.wallets?.[0];
  log(`\nProvisioned a DEDICATED measurement SCA (Arc testnet):\n  address   ${w?.address}\n  walletId  ${w?.id}\n`);
  log(`Next (read-only preflight):\n  WALLET_ADDRESS=${w?.address} node --env-file=.env scripts/spikes/spike-idempotency-key-repeat.mjs\n`);
  process.exit(0);
}

// ── the wallet: ours, not the operator mandate's ────────────────────────────────────────────────────
const WALLET = process.env.WALLET_ADDRESS;
if (!WALLET || !/^0x[0-9a-fA-F]{40}$/.test(WALLET)) { console.error("Set WALLET_ADDRESS=0x… (run --provision to make a dedicated SCA)."); process.exit(2); }
const SCA = getAddress(WALLET);
if (SCA.toLowerCase() === OPERATOR_MANDATE_WALLET) { console.error("⛔ Refused: that is the operator mandate's wallet (0x3cb7…2de9). Its receipts stay clean — use a dedicated SCA (--provision)."); process.exit(2); }
const listed = await client.listWallets({ address: SCA, blockchain: ARC.blockchain });
const wallet = (listed.data?.wallets ?? []).find((w) => w.address.toLowerCase() === SCA.toLowerCase());
if (!wallet) { console.error(`⛔ ${SCA} is not a wallet of this Circle entity on ${ARC.blockchain}.`); process.exit(2); }
if (wallet.accountType !== "SCA") { console.error(`⛔ ${SCA} is ${wallet.accountType}, not an SCA (the measurement is of the agent-SCA path).`); process.exit(2); }
const code = await pc.getCode({ address: SCA });
const deployed = !!code && code !== "0x";

const APPROVE = parseAbi(["function approve(address spender, uint256 value) returns (bool)"]);
const call = (value) => ({
  walletAddress: SCA, blockchain: ARC.blockchain, contractAddress: USDC,
  abiFunctionSignature: "approve(address,uint256)", abiParameters: [SCA, String(value)],
  fee: { type: "level", config: { feeLevel: "MEDIUM" } },
});
const calldata = (value) => encodeFunctionData({ abi: APPROVE, functionName: "approve", args: [SCA, BigInt(value)] });

// a UUIDv5 (RFC 4122 name-based, SHA-1): version nibble 5 — the shape a textbook name-derived key would have
function uuidV5(name) {
  const NS = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"); // RFC 4122 URL namespace
  const b = createHash("sha1").update(Buffer.concat([NS, Buffer.from(name)])).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

log(`\n════ REPEATED IDEMPOTENCY KEY — ${MODE.toUpperCase()} ════`);
log(`  wallet     ${SCA}  (walletId ${wallet.id}, ${wallet.accountType}, ${wallet.state})`);
log(`  deployed   ${deployed ? "yes" : "NO — run --warmup first"}`);
log(`  payload    USDC ${USDC} approve(${SCA}, 0|1)  — to ITSELF; no USDC moves; gas sponsored`);
log(`  calldata   approve(self,0) = ${calldata(0)}`);

if (MODE === "dry") {
  log(`\nDRY RUN — nothing sent. The --confirm run sends, in order:`);
  log(`  1a/1b  K1 (v4) approve(self,0) ×2   2  K1 approve(self,1)   3  K3 (v5-shaped) approve(self,0)`);
  log(`  4      wait ${WAIT_MS / 1000}s, fetch every id, count on-chain approves (pass: one per key)`);
  log(`  5      wait for K1's first tx COMPLETE, K1 approve(self,0) again, wait, recount`);
  log(deployed ? `\nReady: WALLET_ADDRESS=${SCA} node --env-file=.env scripts/spikes/spike-idempotency-key-repeat.mjs --confirm\n`
    : `\nNot deployed yet: WALLET_ADDRESS=${SCA} node --env-file=.env scripts/spikes/spike-idempotency-key-repeat.mjs --warmup\n`);
  process.exit(0);
}

// ── one send, fully recorded, never throws ──────────────────────────────────────────────────────────
const records = [];
async function send(label, key, value) {
  const t0 = Date.now();
  const rec = { label, key, keyIsV4: key === undefined ? null : isV4Uuid(key), payload: `approve(self,${value})`, at: new Date(t0).toISOString() };
  try {
    const r = await client.createContractExecutionTransaction({ ...call(value), ...(key !== undefined ? { idempotencyKey: key } : {}) });
    Object.assign(rec, { ok: true, id: r.data?.id ?? null, state: r.data?.state ?? null, ms: Date.now() - t0 });
  } catch (e) {
    const resp = e?.response;
    Object.assign(rec, { ok: false, status: resp?.status ?? e?.status ?? null, code: resp?.data?.code ?? null, message: String(resp?.data?.message ?? e?.message ?? e).slice(0, 300), ms: Date.now() - t0 });
  }
  records.push(rec);
  log(`  ${label.padEnd(26)} key ${key ? key.slice(0, 8) + "…" : "(none)"}  → ${rec.ok ? `id ${rec.id} state ${rec.state}` : `ERROR status ${rec.status} code ${rec.code}: ${rec.message}`}`);
  return rec;
}
async function txOf(id) {
  try { const { data } = await client.getTransaction({ id }); const t = data?.transaction; return { id, state: t?.state ?? null, txHash: t?.txHash ?? null, errorReason: t?.errorReason ?? null }; }
  catch (e) { return { id, state: "UNREADABLE", error: String(e?.message ?? e).slice(0, 200) }; }
}
const APPROVAL = parseAbiItem("event Approval(address indexed owner, address indexed spender, uint256 value)");
async function landedApproves(fromBlock) {
  const logs = await pc.getLogs({ address: USDC, event: APPROVAL, args: { owner: SCA, spender: SCA }, fromBlock, toBlock: "latest" });
  return logs.map((l) => ({ txHash: l.transactionHash, block: Number(l.blockNumber), value: l.args.value.toString() }));
}

if (MODE === "warmup") {
  if (deployed) { console.error("⛔ Already deployed — no warm-up needed. Run --confirm."); process.exit(2); }
  log(`\nWARM-UP — one UN-KEYED approve(self,0) to deploy the SCA:`);
  const r = await send("warmup", undefined, 0);
  if (!r.ok) { log(`\nThe warm-up was refused (above). If it says the account is unfunded or "paymaster stake too low", that is the DEPLOYMENT surface — fund ~0.5 USDC from https://faucet.circle.com (Arc testnet) and retry.`); process.exit(1); }
  const t0 = Date.now(); let t;
  while (Date.now() - t0 < COMPLETE_DEADLINE_MS) { t = await txOf(r.id); if (["COMPLETE", "FAILED", "CANCELLED", "DENIED"].includes(t.state)) break; await sleep(2000); }
  const now = await pc.getCode({ address: SCA });
  log(`  warm-up tx ${t?.state} ${t?.txHash ?? ""}  → deployed now: ${now && now !== "0x" ? "yes" : "NO"}`);
  process.exit(now && now !== "0x" ? 0 : 1);
}

// ── CONFIRM: the measurement ────────────────────────────────────────────────────────────────────────
if (!deployed) { console.error("⛔ The SCA is not deployed: run --warmup first, so deployment cannot contaminate step 1."); process.exit(2); }
const startBlock = await pc.getBlockNumber();
const K1 = randomUUID();                      // v4, as our derivation is shaped
const K3 = uuidV5(`tikpema/idempotency-measure/${new Date().toISOString()}`);
log(`\n  keys: K1 ${K1} (v4: ${isV4Uuid(K1)})   K3 ${K3} (v5-shaped; v4 check: ${isV4Uuid(K3)})`);
log(`  window starts at Arc block ${startBlock}\n`);

log("STEP 1 — same key, same payload, twice:");
const s1a = await send("1a K1 approve(self,0)", K1, 0);
const s1b = await send("1b K1 approve(self,0)", K1, 0);
log("STEP 2 — same key, DIFFERENT payload:");
const s2 = await send("2  K1 approve(self,1)", K1, 1);
log("STEP 3 — a UUIDv5-shaped key:");
const s3 = await send("3  K3 approve(self,0)", K3, 0);

log(`\nSTEP 4 — waiting ${WAIT_MS / 1000}s, then reading every id and the chain…`);
await sleep(WAIT_MS);
const ids4 = [...new Set(records.filter((r) => r.ok && r.id).map((r) => r.id))];
const txs4 = await Promise.all(ids4.map(txOf));
const landed4 = await landedApproves(startBlock);
for (const t of txs4) log(`  id ${t.id}  ${t.state}  ${t.txHash ?? ""}${t.errorReason ? `  (${t.errorReason})` : ""}`);
log(`  on-chain approves (owner = spender = SCA) since block ${startBlock}: ${landed4.length}`);
for (const l of landed4) log(`    ${l.txHash} block ${l.block} value ${l.value}`);

log(`\nSTEP 5 — K1 again, AFTER its first transaction is COMPLETE:`);
let first = txs4.find((t) => t.id === s1a.id) ?? null;
const t5 = Date.now();
while (s1a.ok && first && first.state !== "COMPLETE" && Date.now() - t5 < COMPLETE_DEADLINE_MS) { await sleep(3000); first = await txOf(s1a.id); }
log(`  K1's first transaction: ${first?.state ?? "no id (step 1a failed)"}`);
const s5 = first?.state === "COMPLETE" ? await send("5  K1 approve(self,0)", K1, 0) : (log("  ⚠️ not COMPLETE within the deadline — step 5 not sent (recorded as skipped)"), null);
await sleep(WAIT_MS);
const ids5 = [...new Set(records.filter((r) => r.ok && r.id).map((r) => r.id))];
const txs5 = await Promise.all(ids5.map(txOf));
const landed5 = await landedApproves(startBlock);
log(`  on-chain approves since block ${startBlock}, after step 5: ${landed5.length}`);

// ── the verdict: exactly one landed approve per key ─────────────────────────────────────────────────
const hashesFor = (key) => new Set(records.filter((r) => r.key === key && r.ok && r.id).map((r) => txs5.find((t) => t.id === r.id)?.txHash).filter(Boolean));
const landedFor = (key) => landed5.filter((l) => hashesFor(key).has(l.txHash)).length;
const unattributed = landed5.filter((l) => ![K1, K3].some((k) => hashesFor(k).has(l.txHash)));
const verdict = {
  K1: { landed: landedFor(K1), pass: landedFor(K1) === 1 },
  K3: { accepted: s3.ok, landed: landedFor(K3), pass: s3.ok ? landedFor(K3) === 1 : landedFor(K3) === 0 },
  unattributedApproves: unattributed,
};
log(`\nVERDICT — exactly one landed approve per key:`);
log(`  K1 (steps 1a,1b,2,5): ${verdict.K1.landed} landed → ${verdict.K1.pass ? "PASS" : "FAIL"}`);
log(`  K3 (step 3, v5-shaped, ${s3.ok ? "accepted" : "rejected"}): ${verdict.K3.landed} landed → ${verdict.K3.pass ? "PASS" : "FAIL"}`);
if (unattributed.length) log(`  ⚠️ ${unattributed.length} approve(s) landed that no returned id accounts for — see the JSON`);
log(`\nANSWERS:`);
log(`  1  second send, same key+payload: ${s1b.ok ? (s1b.id === s1a.id ? "SAME tx id returned" : `a DIFFERENT id (${s1b.id})`) : `refused — status ${s1b.status}, ${s1b.code}`}`);
log(`  2  same key, different payload:   ${s2.ok ? (s2.id === s1a.id ? "the FIRST transaction returned" : `a DIFFERENT id (${s2.id})`) : `refused — status ${s2.status}, ${s2.code}`}`);
log(`  3  UUIDv5-shaped key:             ${s3.ok ? "ACCEPTED" : `REJECTED — status ${s3.status}, ${s3.code}`}`);
log(`  5  same key after COMPLETE:       ${s5 ? (s5.ok ? (s5.id === s1a.id ? "SAME tx id returned" : `a DIFFERENT id (${s5.id})`) : `refused — status ${s5.status}, ${s5.code}`) : "not sent"}`);

const out = `scripts/spikes/idempotency-key-repeat-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(out, JSON.stringify({ wallet: { address: SCA, walletId: wallet.id }, startBlock: String(startBlock), keys: { K1, K3 }, records, step4: { txs: txs4, landed: landed4 }, step5: { firstState: first?.state ?? null, txs: txs5, landed: landed5 }, verdict }, null, 2));
log(`\nRecorded → ${out}  (no secrets: ids, keys, hashes and addresses only)\n`);
