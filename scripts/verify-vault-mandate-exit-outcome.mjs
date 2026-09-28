#!/usr/bin/env node
// verify-vault-mandate-exit-outcome.mjs — piece 5's FIRST (non-money) piece: the exit OUTCOME classifier.
//
//   node scripts/verify-vault-mandate-exit-outcome.mjs
//
// ═══ WHAT IT MUST GET RIGHT (PROGRESS: piece 5 design + the 2026-09-27 decisions) ═══════════════════
//   · The outcome is decided from THE EXIT TRANSACTION'S OWN logs and state, located by its Circle id.
//     ⛔ NEVER from "a Withdraw event for this wallet": the user's own manual reclaim produces one too
//     ("Circle COMPLETE ⇒ happened" was STRUCK, C1), and Circle COMPLETE covers the OUTER userOp while the
//     inner redeem can revert (the ERC-4337 trap).
//   · Outcomes: exited · exit-partial (BOTH amounts) · unconfirmed · failed. A partial is never "done".
//     UNREADABLE IS NEVER "DID NOT HAPPEN": any fact that could not be read yields unconfirmed.
//   · The ERC-20 Transfer only — never Arc's native mirror log (a different emitter).
//   · Finding B: the mandate redeems only its OWN tracked shares, min(tracked, live). Shares remaining in the
//     WALLET afterwards is EXPECTED (hand-deposited shares) and is NOT a partial.
//   · xylo's Withdraw.assets is NET of the exit fee (verified source, redeem(): `assets = previewRedeem(shares)`,
//     the fee is a SEPARATE transfer to feeRecipient) → event.assets === the ERC-20 Transfer to the wallet, exactly.

import { encodeEventTopics, encodeAbiParameters, parseAbiItem } from "viem";
// A log exactly as a receipt carries it: topics from the indexed args, data from the rest.
const encodeEventLog = ({ abi, eventName, args }) => {
  const ev = abi.find((x) => x.name === eventName);
  const topics = encodeEventTopics({ abi, eventName, args });
  const rest = ev.inputs.filter((i) => !i.indexed);
  return { topics, data: encodeAbiParameters(rest, rest.map((i) => args[i.name])) };
};

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const attempt = (fn) => { try { return fn(); } catch (e) { return { threw: String(e?.message ?? e) }; } };
const big = (k, v) => (typeof v === "bigint" ? v.toString() : v);
const show = (o) => JSON.stringify(o ?? null, big)?.slice(0, 240);
const load = async (p) => { try { return await import(p); } catch (e) { return { __missing: String(e?.message ?? e) }; } };

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  VAULT MANDATE — piece 5: the exit OUTCOME classifier                ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

const M = await load("../shared/vault-mandate/exit-outcome.mjs");
const classify = (a) => (typeof M.classifyExitOutcome === "function" ? attempt(() => M.classifyExitOutcome(a)) : null);

// ── fixtures ──
const VAULT = "0x240eb85458cd41361bd8c3773253a1d78054f747";
const USDC = "0x3600000000000000000000000000000000000000";      // the ERC-20 (6 dp)
const NATIVE_MIRROR = "0xfffffffffffffffffffffffffffffffffffffffe"; // Arc's native mirror emitter (18 dp)
const WALLET = "0x3cb76ac688f3fc02dfe4033d388989a44f132de9";
const FEE_RECIPIENT = "0x94e0dc7ad29b94ec9819f6cec3364dd34f41b3c6";
const STRANGER = "0xaaaa000000000000000000000000000000000001";
const HASH = "0x" + "ab".repeat(32);
const WITHDRAW = parseAbiItem("event Withdraw(address indexed caller, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)");
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const wLog = ({ emitter = VAULT, caller = WALLET, receiver = WALLET, owner = WALLET, assets, shares }) => {
  const e = encodeEventLog({ abi: [WITHDRAW], eventName: "Withdraw", args: { caller, receiver, owner, assets, shares } });
  return { address: emitter, topics: e.topics, data: e.data };
};
const tLog = ({ emitter = USDC, from = VAULT, to = WALLET, value }) => {
  const e = encodeEventLog({ abi: [TRANSFER], eventName: "Transfer", args: { from, to, value } });
  return { address: emitter, topics: e.topics, data: e.data };
};
// 10 USDC redeemed: 9 990 000 net + 10 000 fee (10 bps), 10 000 000 shares.
const S = 10_000_000n, NET = 9_990_000n, FEE = 10_000n;
const goodLogs = () => [
  wLog({ assets: NET, shares: S }),
  tLog({ value: NET }),                                     // the net transfer to the wallet
  tLog({ to: FEE_RECIPIENT, value: FEE }),                  // the fee: a SEPARATE transfer, not ours
  tLog({ emitter: NATIVE_MIRROR, value: NET * 10n ** 12n }), // Arc's native mirror (18 dp): never read
];
const base = (o = {}) => ({
  config: { vault: VAULT, usdc: USDC, wallet: WALLET },
  intent: { sharesToRedeem: S.toString(), sharesTracked: S.toString(), sharesTrackedGaps: 0, circleIds: { redeem: "c-red" } },
  facts: {
    circle: { state: "COMPLETE", txHash: HASH },
    receipt: { found: true, status: "success", blockNumber: 1001, logs: goodLogs() },
    shares: { atParent: 15_000_000n, atTxBlock: 5_000_000n }, // 5 000 000 hand-deposited shares stay
  },
  ...o,
});
const withFacts = (patch) => { const b = base(); return { ...b, facts: { ...b.facts, ...patch } }; };
const withIntent = (patch) => { const b = base(); return { ...b, intent: { ...b.intent, ...patch } }; };

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — exited: the MANDATE's shares are gone (the wallet need not be empty)");
{
  ok("the module exists and exports classifyExitOutcome + EXIT_OUTCOME", !M.__missing && typeof M.classifyExitOutcome === "function" && M.EXIT_OUTCOME, M.__missing ?? "");
  ok("the outcome set is exactly exited / exit-partial / unconfirmed / failed",
    JSON.stringify(Object.values(M.EXIT_OUTCOME ?? {}).sort()) === JSON.stringify(["exit-partial", "exited", "failed", "unconfirmed"]), show(M.EXIT_OUTCOME));
  const r = classify(base());
  ok("⭐ event, ERC-20 Transfer and share delta agree, and all of the mandate's shares burned → EXITED", r?.outcome === "exited", show(r));
  ok("  …usdcReceived = the event's NET assets = the ERC-20 Transfer to the wallet (9.99)", r?.usdcReceivedMinor === "9990000", show(r));
  ok("  …mandate shares redeemed 10 000 000, remaining 0", r?.mandateSharesRedeemed === "10000000" && r?.mandateSharesRemaining === "0", show(r));
  ok("⭐⭐ Finding B: 5 000 000 shares remain in the WALLET — reported as NOT the mandate's, and it is still EXITED",
    r?.walletSharesAfter === "5000000" && r?.otherSharesInWallet === "5000000" && r?.outcome === "exited", show(r));
  ok("  …bound to THE transaction: its hash and block are in the result", r?.txHash === HASH && r?.blockNumber === 1001);
  const empty = classify(withFacts({ shares: { atParent: 10_000_000n, atTxBlock: 0n } }));
  ok("a wallet with no other shares → exited, other shares 0", empty?.outcome === "exited" && empty?.otherSharesInWallet === "0", show(empty));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — exit-partial: BOTH amounts, never 'done'");
{
  const half = 4_000_000n, halfNet = 3_996_000n;
  const logs = [wLog({ assets: halfNet, shares: half }), tLog({ value: halfNet }), tLog({ to: FEE_RECIPIENT, value: 4_000n })];
  const r = classify(withFacts({ receipt: { found: true, status: "success", blockNumber: 1001, logs }, shares: { atParent: 15_000_000n, atTxBlock: 11_000_000n } }));
  ok("⭐ the redeem burned fewer than the mandate's shares → EXIT-PARTIAL", r?.outcome === "exit-partial", show(r));
  ok("  …what was redeemed: 4 000 000 shares for 3.996 USDC", r?.mandateSharesRedeemed === "4000000" && r?.usdcReceivedMinor === "3996000", show(r));
  ok("  …what remains of the MANDATE's: 6 000 000 shares", r?.mandateSharesRemaining === "6000000", show(r));
  ok("  …and the hand-deposited 5 000 000 are reported apart from them", r?.otherSharesInWallet === "5000000", show(r));
  ok("⭐ a partial is never labelled done", r?.outcome !== "exited" && r?.done !== true);
  const valued = classify({ ...withFacts({ receipt: { found: true, status: "success", blockNumber: 1001, logs }, shares: { atParent: 15_000_000n, atTxBlock: 11_000_000n }, remainingValueMinor: 5_994_000n }) });
  ok("  …the remaining shares' value is carried when it was read, else null (never guessed)", valued?.mandateRemainingValueMinor === "5994000" && r?.mandateRemainingValueMinor === null, show({ v: valued?.mandateRemainingValueMinor, n: r?.mandateRemainingValueMinor }));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — failed: only when the transaction itself says so");
{
  const inner = classify(withFacts({ receipt: { found: true, status: "success", blockNumber: 1001, logs: [] }, shares: { atParent: 15_000_000n, atTxBlock: 15_000_000n } }));
  ok("⭐⭐ ERC-4337 trap: Circle COMPLETE, receipt SUCCESS, but NO Withdraw in the tx and shares unchanged → FAILED (not exited)", inner?.outcome === "failed", show(inner));
  const rev = classify(withFacts({ receipt: { found: true, status: "reverted", blockNumber: 1001, logs: [] } }));
  ok("the transaction REVERTED → failed", rev?.outcome === "failed", show(rev));
  const nb = classify(withFacts({ circle: { state: "FAILED", txHash: null }, receipt: null, shares: { atParent: null, atTxBlock: null } }));
  ok("Circle FAILED with NO hash (rejected before broadcast — nothing reached the chain) → failed", nb?.outcome === "failed", show(nb));
  const fr = classify(withFacts({ circle: { state: "FAILED", txHash: HASH }, receipt: { found: true, status: "reverted", blockNumber: 1001, logs: [] } }));
  ok("Circle FAILED with a hash + the receipt reverted → failed", fr?.outcome === "failed", show(fr));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⭐⭐ never 'any Withdraw for this wallet': only THIS tx's own, from THIS vault, owner = receiver = wallet");
{
  const fakeEmitter = [wLog({ emitter: STRANGER, assets: NET, shares: S }), tLog({ value: NET })];
  const a = classify(withFacts({ receipt: { found: true, status: "success", blockNumber: 1001, logs: fakeEmitter }, shares: { atParent: 15_000_000n, atTxBlock: 15_000_000n } }));
  ok("a Withdraw from ANOTHER contract naming the wallet → ignored (not an exit)", a?.outcome !== "exited" && a?.outcome !== "exit-partial", show(a));
  const otherRecv = [wLog({ receiver: STRANGER, assets: NET, shares: S }), tLog({ to: STRANGER, value: NET })];
  const b = classify(withFacts({ receipt: { found: true, status: "success", blockNumber: 1001, logs: otherRecv }, shares: { atParent: 15_000_000n, atTxBlock: 5_000_000n } }));
  ok("⭐ a Withdraw whose receiver is NOT the wallet → not our exit, and the drop in shares does not make it one", b?.outcome !== "exited" && b?.outcome !== "exit-partial", show(b));
  const manual = classify(withFacts({ receipt: { found: true, status: "success", blockNumber: 1001, logs: [] }, shares: { atParent: 15_000_000n, atTxBlock: 5_000_000n } }));
  // Isolated cases: everything ELSE agrees (a matching ERC-20 transfer to the wallet, the shares fell by exactly S), so the
  // ONLY thing between these inputs and a false "exited" is the emitter / receiver filter on the Withdraw event.
  const isolated = (w) => classify(withFacts({ receipt: { found: true, status: "success", blockNumber: 1001, logs: [w, tLog({ value: NET })] }, shares: { atParent: 15_000_000n, atTxBlock: 5_000_000n } }));
  const ie = isolated(wLog({ emitter: STRANGER, assets: NET, shares: S }));
  ok("⭐⭐ ISOLATED: a Withdraw from another CONTRACT, everything else agreeing → unconfirmed, 'no Withdraw for this wallet'",
    ie?.outcome === "unconfirmed" && /no Withdraw for this wallet/.test(ie?.why ?? ""), show(ie));
  const ir = isolated(wLog({ receiver: STRANGER, assets: NET, shares: S }));
  ok("⭐⭐ ISOLATED: a Withdraw to another RECEIVER, everything else agreeing → unconfirmed, 'no Withdraw for this wallet'",
    ir?.outcome === "unconfirmed" && /no Withdraw for this wallet/.test(ir?.why ?? ""), show(ir));
  const io = isolated(wLog({ owner: STRANGER, assets: NET, shares: S }));
  ok("⭐ ISOLATED: a Withdraw of another OWNER's shares → unconfirmed", io?.outcome === "unconfirmed" && /no Withdraw for this wallet/.test(io?.why ?? ""), show(io));
  ok("⭐⭐ our tx has NO Withdraw but the wallet's shares DROPPED in that block (a manual reclaim) → UNCONFIRMED, never exited, never failed",
    manual?.outcome === "unconfirmed", show(manual));
  const two = classify(withFacts({ receipt: { found: true, status: "success", blockNumber: 1001, logs: [...goodLogs(), wLog({ assets: 1n, shares: 1n })] } }));
  ok("two of our Withdraw events in one tx → unconfirmed (never picked from)", two?.outcome === "unconfirmed", show(two));
  const noise = classify(withFacts({ receipt: { found: true, status: "success", blockNumber: 1001, logs: [tLog({ emitter: STRANGER, from: STRANGER, to: WALLET, value: 5n }), ...goodLogs()] } }));
  ok("unrelated logs from other contracts are ignored", noise?.outcome === "exited", show(noise));
  ok("⭐ the classifier takes no event scan: its input names only the tx's receipt (no 'withdrawEvents' / 'scan' input)",
    !/withdrawEvents|findWithdraw|eventScan|getLogs/.test(String(M.classifyExitOutcome ?? "")));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — the ERC-20 Transfer only; the fee transfer and the native mirror are never ours");
{
  const mirrorOnly = [wLog({ assets: NET, shares: S }), tLog({ emitter: NATIVE_MIRROR, value: NET })];
  const a = classify(withFacts({ receipt: { found: true, status: "success", blockNumber: 1001, logs: mirrorOnly } }));
  ok("⭐ only Arc's NATIVE mirror Transfer (same value!) → it does not count → unconfirmed", a?.outcome === "unconfirmed", show(a));
  const wrongVal = [wLog({ assets: NET, shares: S }), tLog({ value: NET - 1n })];
  const b = classify(withFacts({ receipt: { found: true, status: "success", blockNumber: 1001, logs: wrongVal } }));
  ok("the ERC-20 Transfer ≠ the event's assets → unconfirmed (instruments disagree)", b?.outcome === "unconfirmed", show(b));
  const gross = [wLog({ assets: NET, shares: S }), tLog({ value: NET + FEE })];
  const c = classify(withFacts({ receipt: { found: true, status: "success", blockNumber: 1001, logs: gross } }));
  ok("⭐ xylo's event is NET: a Transfer of the GROSS amount does not agree → unconfirmed (no fee tolerance)", c?.outcome === "unconfirmed", show(c));
  const feeOnly = [wLog({ assets: NET, shares: S }), tLog({ to: FEE_RECIPIENT, value: NET })];
  const d = classify(withFacts({ receipt: { found: true, status: "success", blockNumber: 1001, logs: feeOnly } }));
  ok("a matching-value Transfer to the FEE RECIPIENT is not ours → unconfirmed", d?.outcome === "unconfirmed", show(d));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — ⭐⭐ UNREADABLE is never 'did not happen'");
{
  const cases = [
    ["Circle unreadable (null), no hash known", { circle: null }],
    ["Circle PENDING", { circle: { state: "PENDING", txHash: null } }],
    ["no Circle id recorded (NONE): the tx cannot be located", { circle: { state: "NONE" } }],
    ["Circle COMPLETE but no tx hash", { circle: { state: "COMPLETE", txHash: null } }],
    ["the receipt unreadable (null)", { receipt: null }],
    ["the receipt not found yet", { receipt: { found: false } }],
    ["the share balance at the parent block unreadable", { shares: { atParent: null, atTxBlock: 5_000_000n } }],
    ["the share balance at the tx block unreadable", { shares: { atParent: 15_000_000n, atTxBlock: null } }],
    ["Circle FAILED with a hash but the receipt says SUCCESS (inconsistent)", { circle: { state: "FAILED", txHash: HASH } }],
  ];
  for (const [label, patch] of cases) {
    const r = classify(withFacts(patch));
    ok(`${label} → unconfirmed`, r?.outcome === "unconfirmed" && typeof r?.why === "string" && r.why.length > 0, show(r));
  }
  const noEvUnread = classify(withFacts({ receipt: { found: true, status: "success", blockNumber: 1001, logs: [] }, shares: { atParent: null, atTxBlock: 5_000_000n } }));
  ok("⭐ NO Withdraw in the tx AND the share balance unreadable → unconfirmed (it could be the ERC-4337 trap OR a manual reclaim: unreadable is not 'did not happen')",
    noEvUnread?.outcome === "unconfirmed", show(noEvUnread));
  const reverted = classify(withFacts({ receipt: { found: true, status: "reverted", blockNumber: 1001, logs: [] }, shares: { atParent: null, atTxBlock: null } }));
  ok("  (a REVERTED receipt is failed even with shares unreadable: the chain itself said so)", reverted?.outcome === "failed", show(reverted));
  const delta = classify(withFacts({ shares: { atParent: 15_000_000n, atTxBlock: 6_000_000n } }));
  ok("the share delta across the block ≠ the event's shares (other activity in that block) → unconfirmed", delta?.outcome === "unconfirmed", show(delta));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — Finding B edge cases");
{
  const beyond = classify(withIntent({ sharesToRedeem: "8000000" }));
  ok("⭐ the tx burned MORE than the mandate's shares (hand-deposited ones taken) → exited, flagged beyondMandate", beyond?.outcome === "exited" && beyond?.beyondMandateShares === "2000000" && beyond?.flags?.includes("BEYOND_MANDATE_SHARES"), show(beyond));
  const short = classify(withIntent({ sharesTracked: "12000000" }));
  ok("min(tracked, live) < tracked (shares already gone before the exit, e.g. a manual reclaim) → exited, and the gap is stated",
    short?.outcome === "exited" && short?.trackedNotRedeemable === "2000000", show(short));
  const gaps = classify(withIntent({ sharesTrackedGaps: 2 }));
  ok("tracked shares with gaps → still classified, and marked as a LOWER bound (never presented as exact)", gaps?.outcome === "exited" && gaps?.trackedIsLowerBound === true && gaps?.flags?.includes("TRACKED_LOWER_BOUND"), show(gaps));
  const bad = classify(withIntent({ sharesToRedeem: "0" }));
  ok("an intent with nothing to redeem (0) → refused as malformed, not classified", bad?.outcome === "unconfirmed" && /intent/i.test(bad?.why ?? ""), show(bad));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
