// spike-batched-burn-pr4.mjs — THE FIRST BATCHED BURN. Runs PR-4.
//
//   node --env-file=.env scripts/spikes/spike-batched-burn-pr4.mjs           ← INERT. Prints and exits.
//   node --env-file=.env scripts/spikes/spike-batched-burn-pr4.mjs --send    ← SPENDS ~0.054 USDC
//
// ⛔ LOADING OR IMPORTING THIS FILE DOES NOTHING. Every network call, every read and every write
// sits behind `--send`. The bare run reaches no network at all — not the quote API, not the RPC.
// ⚠️ That is a property of the SCRIPT, not of the reader's care: `node -e "import('./…')"` EXECUTES
// a module, and on an earlier spike only a missing --env-file stopped a real approve. Luck, not a
// safeguard. So the guard is the first executable statement below.
//
// ═══ ⭐⭐ IT RUNS THE PRODUCTION PATH, NOT A REIMPLEMENTATION ═══════════════════════════════════
// PR-1 and PR-2 hand-encoded their calldata, so they proved the CONTRACT worked — not our code.
// This calls `bridgeFee` → `sealBridgeQuote` → `openBridgeQuote` → `agentBridge`, the exact
// functions the app runs, so `bridgeBatchCallData`, the self-targeted submit and the pre-burn
// deadline re-check are all under test.
// ⚠️ The executor's caps/ceiling/ledger are NOT invoked — they need a Netlify Blobs context and
// they are not what PR-4 predicts. Everything B1–B7 asserts lives below that layer.
//
// ═══ WHAT PR-4 PREDICTS ═══════════════════════════════════════════════════════════════════════
//   B1 ONE Arc transaction        B2 Approval(SCA→TMWF, A+F) inside it      B3 fee leg == quote's fee
//   B4 amount leg, distinct       B5 allowance == 0 afterwards              B6 balance delta == A+F
//   B7 destination credits A
// ⛔ AND §3 STANDS WHATEVER HAPPENS: a clean batch does NOT prove atomicity. Atomicity is a claim
// about the FAILURE path, and the success path is all this run exercises.

import { writeFileSync, mkdirSync } from "node:fs";
import { getAddress } from "viem";

const SEND = process.argv.includes("--send");
const OUT = "scripts/spikes/pr4-batched-burn";

if (!SEND) {
  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║  PR-4 — THE FIRST BATCHED BURN                     ⛔ INERT (no --send)      ║
╚══════════════════════════════════════════════════════════════════════════════╝

  Nothing has been read, requested or submitted. No network call was made.

  This run would:
    1. read the agent SCA's USDC balance and its allowance to TMWF   (baseline)
    2. request ONE quote and record it VERBATIM before any decision
    3. seal it, re-open it, and submit ONE userOp: executeBatch([approve, burn])
    4. capture the tx hash BEFORE reading anything back
    5. read the receipt, the post-balance and the post-allowance
    6. judge B1–B7 against docs/batched-burn-preregistration.md

  ⛔ IT SPENDS REAL USDC — roughly 0.054 (a 1-minor-unit burn plus the fee).

  To run it:
      node --env-file=.env scripts/spikes/spike-batched-burn-pr4.mjs --send
`);
  process.exit(0);
}

// ── everything below this line is behind --send ────────────────────────────────────────────────
const { ARC, CONTRACTS } = await import("../../netlify/functions/_arc.mjs");
const { circle } = await import("../../netlify/functions/_circle.mjs");
const B = await import("../../netlify/functions/_bridge.mjs");
const { TMWF } = B;

const WALLET = process.env.AGENT_WALLET_ADDRESS;
const DEST = "base";
const DEST_DOMAIN = 6;
const AMOUNT_USDC = 0.000001;          // 1 minor unit — the same amount runs 1 and 2 used
if (!WALLET) { console.error("⛔ AGENT_WALLET_ADDRESS is not set."); process.exit(64); }
if (!process.env.SESSION_SECRET) { console.error("⛔ SESSION_SECRET is not set — the quote cannot be sealed."); process.exit(64); }

mkdirSync(OUT, { recursive: true });
const log = (m = "") => { console.log(m); writeFileSync(`${OUT}/run.log`, m + "\n", { flag: "a" }); };
const rpc = async (method, params) => {
  const r = await fetch(ARC.rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};
const pad32 = (a) => a.slice(2).toLowerCase().padStart(64, "0");
const readBalance = async (a) => BigInt(await rpc("eth_call",
  [{ to: CONTRACTS.USDC, data: "0x70a08231" + pad32(a) }, "latest"]));
const readAllowance = async (o, s) => BigInt(await rpc("eth_call",
  [{ to: CONTRACTS.USDC, data: "0xdd62ed3e" + pad32(o) + pad32(s) }, "latest"]));
// ⭐ COMPUTED, NEVER TYPED. Every minor→decimal conversion in this file goes through here.
const dec = (minor) => { const d = 1_000_000n, n = BigInt(minor);
  return `${n / d}.${(n % d).toString().padStart(6, "0")}`; };

log(`\n═══ PR-4 · THE FIRST BATCHED BURN · ${new Date().toISOString()} ═══`);
log(`wallet ${WALLET} · ${DEST} (domain ${DEST_DOMAIN}) · amount ${AMOUNT_USDC} USDC`);

// ── 0. BASELINE — READ, both of them, before anything is requested ────────────────────────────
// 🚨 READ, NEVER PREDICTED. Run 1's commit message reported a post-run balance that was ARITHMETIC
// (`before − fee − amount`) written before the balance was read, and it was wrong by the gas it
// omitted. Both endpoints are readings here, and the delta below is computed from the two of them.
const balBefore = await readBalance(WALLET);
const allowBefore = await readAllowance(WALLET, TMWF);
writeFileSync(`${OUT}/balance-before.txt`, balBefore.toString());
writeFileSync(`${OUT}/allowance-before.txt`, allowBefore.toString());
log(`\n0. BASELINE (read, not derived)`);
log(`   balance   ${balBefore} minor (${dec(balBefore)} USDC)  -> balance-before.txt`);
log(`   allowance ${allowBefore} minor to TMWF                 -> allowance-before.txt`);

// ── 1. QUOTE — recorded VERBATIM before any decision is taken on it ───────────────────────────
log(`\n1. QUOTE`);
const fee = await B.bridgeFee({ amountUsdc: AMOUNT_USDC, cctpDomain: DEST_DOMAIN });
writeFileSync(`${OUT}/quote.json`, JSON.stringify(fee.quote, null, 2));
log(`   recorded VERBATIM -> quote.json (before anything below reads a field of it)`);
const q = fee.quote;
log(`   issuedAt ${q.issuedAt} · expiry.mode ${q.expiry.mode} · expiresAt ${q.expiry.expiresAt}`);
log(`   window ${q.expiry.expiresAt - q.issuedAt}s · ${q.expiry.expiresAt - Math.floor(Date.now() / 1000)}s remaining`);
log(`   feeTotalAmount ${fee.feeMinor} minor (${dec(fee.feeMinor)} USDC) · feeToken ${q.feeToken}`);
log(`   mechanic ${fee.mechanic} · debit ${B.bridgeDebitMinor(fee)} minor (${dec(B.bridgeDebitMinor(fee))} USDC)`);

// ── 2. SEAL AND RE-OPEN — the production binding, exercised ───────────────────────────────────
const token = B.sealBridgeQuote({ owner: WALLET, destinationKey: DEST, amountUsdc: AMOUNT_USDC, fee });
const bound = B.openBridgeQuote(token, { owner: WALLET, destinationKey: DEST, amountUsdc: AMOUNT_USDC });
log(`\n2. SEALED AND RE-OPENED — fee ${bound.feeMinor} · mechanic ${bound.mechanic} · ` +
    `${bound.expiry.secondsLeft}s left in the quote's own window`);
if (bound.feeMinor !== fee.feeMinor) { log(`⛔ ABORT — the re-opened fee differs from the sealed one.`); process.exit(3); }

// ── 3. SUBMIT — ONE userOp. Hash captured BEFORE anything is read back. ───────────────────────
log(`\n3. SUBMIT — one userOp: executeBatch([approve(TMWF, A+F), depositForBurnWithFees(A, …)])`);
let burnHash;
try {
  const r = await B.agentBridge({ walletAddress: WALLET, destination: DEST, amountUsdc: AMOUNT_USDC, fee: bound });
  burnHash = r.burnHash;
  // ⭐ WRITTEN FIRST, BEFORE ANY READ. If the process dies during the reads below, the hash — the
  // one thing that cannot be recovered by looking again — is already on disk.
  writeFileSync(`${OUT}/burn-hash.txt`, String(burnHash));
  log(`   burnHash ${burnHash}  -> burn-hash.txt (written BEFORE any read)`);
  log(`   netUsdc ${r.netUsdc} · feeUsdc ${r.feeUsdc} · feeMechanic ${r.feeMechanic}`);
} catch (e) {
  log(`\n⛔ SUBMIT FAILED: ${e?.message}`);
  log(`   stage=${e?.stage ?? "-"} txId=${e?.txId ?? "-"}`);
  log(`   ⚠️ If a TxPendingError, the userOp may STILL LAND. Do not re-run without checking.`);
  process.exit(4);
}

// ── 4. READ THE RECEIPT ───────────────────────────────────────────────────────────────────────
const receipt = await rpc("eth_getTransactionReceipt", [burnHash]);
writeFileSync(`${OUT}/receipt.json`, JSON.stringify(receipt, null, 2));
const balAfter = await readBalance(WALLET);
const allowAfter = await readAllowance(WALLET, TMWF);
writeFileSync(`${OUT}/balance-after.txt`, balAfter.toString());
writeFileSync(`${OUT}/allowance-after.txt`, allowAfter.toString());

const USDC = CONTRACTS.USDC.toLowerCase();
const NATIVE = "0xfffffffffffffffffffffffffffffffffffffffe";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const lc = (s) => String(s || "").toLowerCase();
const at = (t) => "0x" + lc(t).slice(26);
const logs = receipt?.logs ?? [];

// ⛔ THE TWO STREAMS, SEPARATELY, NEVER MERGED. Arc emits every movement twice — native 18-dp from
// 0xffff…fffe and ERC-20 6-dp from the token. Merging double-counts by ~1e12, and their COUNTS
// legitimately differ on a sponsored userOp (run 2: 7 vs 8). Nothing here compares counts.
const stream = (emitter, topic) => logs
  .filter((l) => lc(l.address) === emitter && lc(l.topics?.[0]) === topic && l.topics?.length === 3)
  .map((l) => ({ i: Number(l.logIndex), from: at(l.topics[1]), to: at(l.topics[2]), v: BigInt(l.data) }));
const erc20T = stream(USDC, TRANSFER), nativeT = stream(NATIVE, TRANSFER), erc20A = stream(USDC, APPROVAL);

log(`\n4. RECEIPT · status ${receipt?.status} · block ${receipt?.blockNumber} · ${logs.length} logs`);
log(`   from ${receipt?.from}  to ${receipt?.to}`);
log(`\n   ERC-20 ${CONTRACTS.USDC} — 6 dp — ${erc20T.length} Transfers`);
for (const t of erc20T) log(`     [${String(t.i).padStart(2)}] ${t.from} -> ${t.to}  ${t.v}`);
log(`\n   ERC-20 Approvals — ${erc20A.length}`);
for (const t of erc20A) log(`     [${String(t.i).padStart(2)}] ${t.from} -> ${t.to}  ${t.v}`);
log(`\n   NATIVE 0xffff…fffe — 18 dp — ${nativeT.length} Transfers`);
for (const t of nativeT) log(`     [${String(t.i).padStart(2)}] ${t.from} -> ${t.to}  ${t.v}`);

// ── 5. JUDGE B1–B7, EACH AGAINST ITS OWN ROW ──────────────────────────────────────────────────
const W = lc(WALLET), T = lc(TMWF), A = 1n, F = BigInt(fee.feeMinor), DEBIT = A + F;
const fired = [];
const row = (id, claim, ok, evidence) => {
  log(`   ${ok ? "✅" : "⛔"} ${id} — ${claim}`);
  log(`        ${evidence}`);
  if (!ok) fired.push(id);
};
log(`\n5. B1–B7 — each judged against its own numbered row`);

const txCount = 1; // this script submitted exactly one createContractExecutionTransaction
row("B1", "ONE transaction", txCount === 1 && typeof burnHash === "string",
  `one submit, one hash: ${burnHash}`);

const ap = erc20A.find((x) => x.from === W && x.to === T);
row("B2", `Approval(SCA → TMWF, A+F = ${DEBIT})`, !!ap && ap.v === DEBIT,
  ap ? `log [${ap.i}] value ${ap.v} (expected ${DEBIT})` : "NO Approval SCA -> TMWF found");

const charges = erc20T.filter((x) => x.from === W && x.to === T);
const feeLeg = charges.filter((x) => x.v === F);
row("B3", `fee leg == the submitted quote's feeTotalAmount (${F})`, feeLeg.length === 1,
  feeLeg.length === 1 ? `log [${feeLeg[0].i}] value ${feeLeg[0].v}` : `${feeLeg.length} candidates`);

const amtLeg = charges.filter((x) => x !== feeLeg[0] && x.v === A);
row("B4", `amount leg == ${A}, distinct from the fee leg`, amtLeg.length === 1,
  amtLeg.length === 1 ? `log [${amtLeg[0].i}] value ${amtLeg[0].v}` : `${amtLeg.length} candidates`);

row("B5", "allowance(SCA, TMWF) == 0 afterwards", allowAfter === 0n,
  `before ${allowBefore} · after ${allowAfter}  (both READ)`);

// ⭐ THE DELTA IS COMPUTED FROM TWO READINGS, NOT FROM A MODEL OF WHAT SHOULD HAVE HAPPENED.
const delta = balBefore - balAfter;
row("B6", `balance delta == A + F (${DEBIT}) and no more`, delta === DEBIT,
  `before ${balBefore} · after ${balAfter} · delta ${delta} (expected ${DEBIT}; a gas component would exceed it)`);

log(`\n   B7 — the destination mint. NOT judged here: it is asynchronous.`);
log(`        Read it with the burn hash above; PR-4's F7 carries NO deadline, so if it has not`);
log(`        landed the honest record is NOT-YET-OBSERVED, re-read later. Waiting is not failure.`);

// ── 6. THE VERDICT ────────────────────────────────────────────────────────────────────────────
log(`\n${"═".repeat(78)}`);
if (fired.length) {
  log(`⛔ FALSIFIER(S) FIRED: ${fired.join(", ")}`);
  log(`   THE FINDING IS THE FALSIFIER. Record it in PR-4's RESULT and STOP.`);
  log(`   Do not repair the prediction; if the defect is in a row, say which clause and why.`);
} else {
  log(`✅ B1–B6 HOLD. B7 is unjudged and asynchronous.`);
}
log(`\n⛔ AND WHATEVER THIS RUN SHOWED, ATOMICITY REMAINS UNPROVEN. PR-4 §3: a SUCCESSFUL batch`);
log(`   exercises only the success path. "Either both land or neither does" is a claim about the`);
log(`   FAILURE path, and it needs its own induced run — an expired quote or a deliberate`);
log(`   shortfall — to say anything at all. Still open.`);
log(`\nArtifacts in ${OUT}/ — quote.json, receipt.json, burn-hash.txt, balance-*.txt, allowance-*.txt`);
process.exit(fired.length ? 1 : 0);
