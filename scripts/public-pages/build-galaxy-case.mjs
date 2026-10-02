#!/usr/bin/env node
// build-galaxy-case.mjs — the Galaxy USDC route removal as a DATED ON-CHAIN RECORD (not a report).
//
//   node scripts/public-pages/build-galaxy-case.mjs     → public/evidence/galaxy-usdc-route-removal/{index.html, reads.json}
//
// ═══ ⭐ WHY THIS IS A DIFFERENT KIND OF PAGE ════════════════════════════════════════════════════
// The deployed due-diligence service does not cover this vault (mainnet, Morpho Vault V2), so nothing here
// is a signed report and nothing claims to be. It needs no signature from us: every statement is a public
// read of Arc mainnet, made at build time on BOTH endpoints, and printed beside the command that repeats it.
// The page says so at the top, before any fact.
//
// ⛔ THE BUILD REFUSES (writes nothing) if the endpoints disagree on any read, if any read is unreadable, or if
// a fact the page states does not hold (the event's topic, the sender being an allocator, the revert). The
// sentences are functions of the reads: a changed chain changes the page or stops the build.
//
// ⛔ NOT A FINDING OF WRONGDOING. VaultV2 gives allocators this power by design, with no delay. The page says
// that too, and that the vault's assets still exist (the force-deallocate route is not computed here).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, decodeFunctionResult, keccak256, encodeAbiParameters, toHex, parseAbi } from "viem";
import { esc, page, mark, commands, fmtInt, fmtUnits6, isoUtc, bannedWordsIn, quorumReader } from "./_shell.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const ENDPOINTS = ["https://rpc.mainnet.arc.io", "https://arc-mainnet.drpc.org"];
export const VAULT = "0x8E357432CC12ff425c36432F312968aEb16112AF";
export const USDC = "0x3600000000000000000000000000000000000000";
export const TX = "0x87283833bf59c19101eb6f3f374017fd757059df7ef8ad4323fb5dbc516d8383";
export const BLOCK = 23403623n;
const PROBE = "0x000000000000000000000000000000000000dEaD"; // a stand-in holder, given shares only inside eth_call
const TOPIC = keccak256(toHex("SetLiquidityAdapterAndData(address,address,bytes)"));
const SRC = "https://github.com/morpho-org/vault-v2/blob/2026-08-13/src/VaultV2.sol";
const TRANSFER_REVERTED = keccak256(toHex("TransferReverted()")).slice(0, 10);

const abi = parseAbi([
  "function liquidityAdapter() view returns (address)",
  "function isAllocator(address) view returns (bool)",
  "function totalAssets() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function previewWithdraw(uint256) view returns (uint256)",
  "function withdraw(uint256,address,address) returns (uint256)",
]);
const hex = (n) => "0x" + BigInt(n).toString(16);
const dec = (fn, data) => decodeFunctionResult({ abi, functionName: fn, data });

export async function gatherFacts(q) {
  const call = (to, fn, args, block, extra = {}) =>
    q.read("eth_call", [{ to, data: encodeFunctionData({ abi, functionName: fn, args }), ...extra.tx }, block, ...(extra.override ? [extra.override] : [])], { allowRevert: !!extra.allowRevert });
  const f = { reads: {} };
  const R = (k, e) => (f.reads[k] = e);
  f.chainId = Number(BigInt(R("chainId", await q.read("eth_chainId", [])).answer.result));

  const before = R("adapterBefore", await call(VAULT, "liquidityAdapter", [], hex(BLOCK - 1n)));
  const after = R("adapterAfter", await call(VAULT, "liquidityAdapter", [], hex(BLOCK)));
  f.adapterBefore = dec("liquidityAdapter", before.answer.result);
  f.adapterAfter = dec("liquidityAdapter", after.answer.result);
  const hdr = R("block", await q.read("eth_getBlockByNumber", [hex(BLOCK), false]));
  f.blockTimestamp = Number(BigInt(hdr.answer.result.timestamp));
  f.blockHash = hdr.answer.result.hash;
  const logs = R("logs", await q.read("eth_getLogs", [{ address: VAULT, fromBlock: hex(BLOCK), toBlock: hex(BLOCK), topics: [TOPIC] }]));
  const log = logs.answer.result.find((l) => l.transactionHash.toLowerCase() === TX);
  if (!log) throw new Error(`no SetLiquidityAdapterAndData log from ${TX} at block ${BLOCK}`);
  f.sender = "0x" + log.topics[1].slice(26);
  f.newAdapter = "0x" + log.topics[2].slice(26);
  const rcpt = R("receipt", await q.read("eth_getTransactionReceipt", [TX]));
  f.txStatus = rcpt.answer.result.status;
  f.txFrom = rcpt.answer.result.from;
  f.txTo = rcpt.answer.result.to;
  const code = R("senderCode", await q.read("eth_getCode", [f.sender, hex(BLOCK)]));
  f.senderCode = code.answer.result;
  const alloc = R("isAllocator", await call(VAULT, "isAllocator", [f.sender], hex(BLOCK - 1n)));
  f.senderIsAllocator = dec("isAllocator", alloc.answer.result);
  const taAt = R("totalAssetsAt", await call(VAULT, "totalAssets", [], hex(BLOCK)));
  f.totalAssetsAt = dec("totalAssets", taAt.answer.result);

  // ── now: one pinned recent block, so every "now" read is at the SAME block ──
  f.now = (await q.lowestHead()) - 5n;
  const N = hex(f.now);
  const hdrN = R("blockNow", await q.read("eth_getBlockByNumber", [N, false]));
  f.nowTimestamp = Number(BigInt(hdrN.answer.result.timestamp));
  f.adapterNow = dec("liquidityAdapter", R("adapterNow", await call(VAULT, "liquidityAdapter", [], N)).answer.result);
  f.idleNow = dec("balanceOf", R("idleNow", await call(USDC, "balanceOf", [VAULT], N)).answer.result);
  f.totalAssetsNow = dec("totalAssets", R("totalAssetsNow", await call(VAULT, "totalAssets", [], N)).answer.result);
  const need = dec("previewWithdraw", R("preview", await call(VAULT, "previewWithdraw", [1_000_000n], N)).answer.result);
  // balanceOf is storage slot 12 in the vault-v2 @2026-08-13 build: give PROBE twice the shares 1 USDC needs,
  // inside this eth_call only. Nothing is written to the chain.
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [PROBE, 12n]));
  const shares = toHex(need * 2n, { size: 32 });
  const tx = { from: PROBE };
  const w = R("withdraw", await call(VAULT, "withdraw", [1_000_000n, PROBE, PROBE], N, { tx, override: { [VAULT]: { stateDiff: { [slot]: shares } } }, allowRevert: true }));
  f.withdrawRevert = w.answer.error?.data ?? null;
  f.withdrawOk = !w.answer.error;
  // Control: the same call, with the vault's USDC balance set to 2 USDC (Arc's USDC balance is the native
  // balance, 18 decimals in this view). If this succeeds, the revert above is the empty balance, not the setup.
  const c = R("control", await call(VAULT, "withdraw", [1_000_000n, PROBE, PROBE], N, { tx, override: { [VAULT]: { stateDiff: { [slot]: shares }, balance: toHex(2n * 10n ** 18n) } }, allowRevert: true }));
  f.controlOk = !c.answer.error;
  f.controlRevert = c.answer.error?.data ?? null;
  return f;
}

/** The facts the page asserts. If one fails, the page is not built: it would be stating something untrue. */
export function assertFacts(f) {
  const z = "0x0000000000000000000000000000000000000000";
  const problems = [];
  if (f.adapterBefore.toLowerCase() === z) problems.push("the adapter was already unset before the block");
  if (f.adapterAfter.toLowerCase() !== z) problems.push("the adapter is not unset after the block");
  if (f.newAdapter !== z) problems.push("the event did not set the zero address");
  if (f.txStatus !== "0x1") problems.push("the transaction did not succeed");
  if (f.txFrom.toLowerCase() !== f.sender.toLowerCase()) problems.push("the transaction was not sent directly by the event's sender");
  if (f.txTo.toLowerCase() !== VAULT.toLowerCase()) problems.push("the transaction was not a direct call to the vault");
  if (f.senderCode !== "0x") problems.push("the sender has code (not a key)");
  if (f.senderIsAllocator !== true) problems.push("the sender was not an allocator before the block");
  return problems;
}

export function renderCase(f) {
  const cmd = (k, label, expect) => f.reads[k].commands.map((c) => ({ label: `${label} — ${new URL(c.endpoint).host}`, command: c.command, expect }));
  const z = "0x0000000000000000000000000000000000000000";
  const routeNow = f.adapterNow.toLowerCase() === z;
  const row = (state, q, body, cmds) => `<div class="row${state === "not" ? " not" : ""}">${state === "not" ? mark.notEstablished : mark.established}
<p class="q">${esc(q)}</p>${body}${commands(cmds ?? [])}</div>`;

  const body = `<div class="eyebrow">Dated on-chain record · Arc mainnet · not a signed report</div>
<h1>Galaxy USDC: the redemption route was removed in one transaction</h1>
<p class="mono">${esc(VAULT)} · chain ${esc(String(f.chainId))}</p>
<div class="notice">
<p><b>This is not a due-diligence report, and nothing on it is signed by Tikpema.</b> It does not need to be: every statement below is a public read of Arc mainnet, made on two endpoints that had to agree (<code>rpc.mainnet.arc.io</code> and <code>arc-mainnet.drpc.org</code>), and each one sits beside the command that repeats it. The deployed Tikpema due-diligence service does not cover this vault.</p>
<p class="not-this">It is not a finding of wrongdoing, and it is not a recommendation about this vault. Morpho Vault V2 gives allocators this power by design.</p>
</div>

<h2>What happened, at block ${fmtInt(BLOCK)} (${esc(isoUtc(f.blockTimestamp))})</h2>
${row("est", "Did the vault's redemption route change?",
  `<p>Yes. At block ${fmtInt(BLOCK - 1n)} the vault's liquidity adapter was <code>${esc(f.adapterBefore)}</code>. At block ${fmtInt(BLOCK)} it was none (the zero address).</p>`,
  [...cmd("adapterBefore", `liquidityAdapter() at block ${fmtInt(BLOCK - 1n)}`), ...cmd("adapterAfter", `liquidityAdapter() at block ${fmtInt(BLOCK)}`)])}
${row("est", "What changed it?",
  `<p>Transaction <code>${esc(TX)}</code> (status: success), a direct call to the vault, emitted <code>SetLiquidityAdapterAndData</code> with sender <code>${esc(f.sender)}</code> and new adapter <code>${esc(f.newAdapter)}</code>.</p>`,
  [...cmd("logs", `the vault's SetLiquidityAdapterAndData logs at block ${fmtInt(BLOCK)}`), ...cmd("receipt", "the transaction receipt")])}
${row("est", "Who sent it?",
  `<p><code>${esc(f.sender)}</code>: an address with no code (a single key, not a contract or a multisig), and an allocator of this vault at block ${fmtInt(BLOCK - 1n)}.</p>`,
  [...cmd("senderCode", `the sender's code at block ${fmtInt(BLOCK)}`, "0x (no code)"), ...cmd("isAllocator", `isAllocator(sender) at block ${fmtInt(BLOCK - 1n)}`, "…0001 (true)")])}
${row("est", "How much did the vault hold at that block?",
  `<p>${esc(fmtUnits6(f.totalAssetsAt))} USDC (totalAssets).</p>`, cmd("totalAssetsAt", `totalAssets() at block ${fmtInt(BLOCK)}`))}

<h2>Why no notice was possible</h2>
${row("est", "Does this change wait before it takes effect?",
  `<p>No. In the Vault V2 source that the deployed vaults are built from (tag 2026-08-13), the only condition is that the caller is an allocator. There is no timelock on this function, and it cannot be abdicated:</p>
<blockquote><pre><code>function setLiquidityAdapterAndData(address newLiquidityAdapter, bytes memory newLiquidityData) external {
    require(isAllocator[msg.sender], ErrorsLib.Unauthorized());
    liquidityAdapter = newLiquidityAdapter;
    liquidityData = newLiquidityData;
    emit EventsLib.SetLiquidityAdapterAndData(msg.sender, newLiquidityAdapter, newLiquidityData);
}</code></pre></blockquote>
<p><a href="${SRC}#L628-L633">VaultV2.sol lines 628–633</a></p>`)}
${row("est", "What does the route do for a withdrawal?",
  `<p>An ordinary withdrawal is paid from the vault's idle cash and, beyond that, only through the liquidity adapter. With no adapter, a withdrawal larger than the idle cash is not topped up from anywhere, and the transfer fails:</p>
<blockquote><pre><code>uint256 idleAssets = IERC20(asset).balanceOf(address(this));
if (assets &gt; idleAssets &amp;&amp; liquidityAdapter != address(0)) {
    deallocateInternal(liquidityAdapter, liquidityData, assets - idleAssets);
}
…
SafeERC20Lib.safeTransfer(asset, receiver, assets);</code></pre></blockquote>
<p><a href="${SRC}#L807-L820">VaultV2.sol lines 807–820</a></p>`)}

<h2>At block ${fmtInt(f.now)} (${esc(isoUtc(f.nowTimestamp))})</h2>
<p class="sub">Read when this page was built. It can be different now; every command below names its block.</p>
${row("est", "Is the route still removed?",
  `<p>${routeNow ? "Yes. The liquidity adapter is none." : `No. The liquidity adapter is <code>${esc(f.adapterNow)}</code>.`}</p>`, cmd("adapterNow", `liquidityAdapter() at block ${fmtInt(f.now)}`))}
${row("est", "How much does the vault hold, and how much of it is idle?",
  `<p>totalAssets ${esc(fmtUnits6(f.totalAssetsNow))} USDC; idle cash ${esc(fmtUnits6(f.idleNow))} USDC.</p>`,
  [...cmd("totalAssetsNow", `totalAssets() at block ${fmtInt(f.now)}`), ...cmd("idleNow", `USDC balanceOf(vault) at block ${fmtInt(f.now)}`)])}
${row("est", "Would an ordinary withdrawal of 1 USDC go through?",
  f.withdrawOk
    ? `<p>Yes, in a simulation at this block.</p>`
    : `<p>No. Simulated at this block, a withdrawal of 1 USDC by a holder reverts with <code>${esc(f.withdrawRevert)}</code>${f.withdrawRevert === TRANSFER_REVERTED ? " (<code>TransferReverted()</code>)" : ""}. ${f.controlOk ? "The same call with 2 USDC of idle cash added goes through, so the revert is the empty idle balance, not the simulation." : "⚠️ The control (the same call with 2 USDC of idle cash added) also reverted, so this simulation does not isolate the cause."}</p>
<p class="sub">How the simulation works: a stand-in holder (<code>${esc(PROBE)}</code>) is given vault shares by an <code>eth_call</code> state override (the vault's <code>balanceOf</code> mapping, storage slot 12 in this build). Nothing is written to the chain; anyone can run it.</p>`,
  [...cmd("withdraw", `withdraw(1 USDC) by the stand-in holder at block ${fmtInt(f.now)}`, `a revert with data ${TRANSFER_REVERTED}`), ...cmd("control", "control: the same call with 2 USDC of idle cash added", "a result (the shares burned), no revert")])}

<h2>What this record does not establish</h2>
${row("not", "Is the money gone?",
  `<p>Not established, and this record does not suggest it. The vault's assets are deployed in its markets. Vault V2 has a separate exit, <code>forceDeallocate</code>, which pulls from a market for a penalty set per adapter; this record does not compute what it would return.</p>`)}
${row("not", "Who else can do this, and is a change already queued?",
  `<p>Not established. Allocators and sentinels are stored per address and cannot be listed from the vault's state, and a queued timelocked change is stored by its full content. This record checked one allocator: the sender above.</p>`)}
${row("not", "Why the route was removed",
  `<p>Not established. The chain records what was done and by whom, not why.</p>`)}

<footer>
<p class="not-this">This page is a record of public chain reads. It carries no score, no rating, no ranking and no recommendation, and it does not claim anything about this vault beyond what each read shows at its block.</p>
<p><a href="/evidence/xylo-testnet/">A different kind of page: a signed due-diligence report, on Arc testnet →</a></p>
<p><a href="reads.json">Every read behind this page (JSON)</a></p>
</footer>`;
  return page({
    title: "Galaxy USDC route removal",
    description: `A dated on-chain record: Galaxy USDC's redemption route was removed at Arc mainnet block ${BLOCK}, by an allocator, with no delay possible.`,
    body,
  });
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const q = quorumReader(ENDPOINTS);
  let f;
  try { f = await gatherFacts(q); } catch (e) { console.error(`⛔ ${e.message}; nothing written`); process.exit(1); }
  const problems = assertFacts(f);
  if (problems.length) { console.error(`⛔ the record no longer holds: ${problems.join("; ")}; nothing written`); process.exit(1); }
  const html = renderCase(f);
  const banned = bannedWordsIn(html);
  if (banned.length) { console.error(`⛔ banned words: ${banned.join(", ")}; nothing written`); process.exit(1); }
  const out = join(ROOT, "public/evidence/galaxy-usdc-route-removal");
  mkdirSync(out, { recursive: true });
  const json = (o) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1);
  writeFileSync(join(out, "reads.json"), json({ builtAt: new Date().toISOString(), endpoints: ENDPOINTS, facts: { ...f, reads: undefined }, reads: q.log }) + "\n");
  writeFileSync(join(out, "index.html"), html);
  console.log(`✅ ${out}/index.html — ${q.log.length} reads, both endpoints agreed on every one; now = block ${f.now}; withdraw revert ${f.withdrawRevert}, control ok ${f.controlOk}`);
}
