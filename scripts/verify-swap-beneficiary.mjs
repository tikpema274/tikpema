// verify-swap-beneficiary.mjs — ZERO MONEY, ZERO NETWORK. Pure-function suite for the
// tokenOut beneficiary assert added to _swap.mjs (docs/swap-adapter-payer-beneficiary-unbound.md).
//
// ═══ ⭐⭐ WHAT THIS SUITE IS CALIBRATED AGAINST — read this before changing a case ══════════════
// A guard is only worth its line count if it is RED against the exact defect it was written for.
// TWO pre-fix implementations are re-created here and asserted GREEN on payloads where the real
// guard is RED. Without them, every ✅ below is free.
//
//   OLD GUARD  — `cd.to === SWAP_ADAPTER`, the assert that already existed. ⭐ THE POINT: a payload
//                paying a stranger STILL TARGETS THE ADAPTER, so this stays GREEN. A red produced by
//                a wrong adapter address would prove nothing — the old assert already covers that.
//   INDEX-0    — "just read tokens[0].beneficiary", the obvious shortcut. ⭐ It is GREEN on a payload
//                whose tokenIn leg is correct and whose tokenOUT leg pays a stranger. That case is
//                the whole reason selection is BY TOKEN. `instructions[0]` being the FEE leg already
//                produced this exact misread once in this investigation.
//
//   node scripts/verify-swap-beneficiary.mjs
import { readFileSync } from "node:fs";
import { assertSwapBeneficiary } from "../netlify/functions/_swap.mjs";

// Read the adapter constant FROM THE SOURCE rather than restating it — a second copy of a money-path
// address is the duplicate-source-of-truth bug this repo keeps finding.
const SRC = readFileSync(new URL("../netlify/functions/_swap.mjs", import.meta.url), "utf8");
const SWAP_ADAPTER = SRC.match(/const SWAP_ADAPTER = "(0x[0-9a-fA-F]{40})"/)[1].toLowerCase();

const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
const WALLET = "0x6fb28d6366e755e0e27307692282490c6682fc58";
const ATTACKER = "0xdeadbeef00000000000000000000000000001234";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
// Run the guard and report what happened, never throwing out of the suite.
const run = (tokens, over = {}) => {
  try {
    const r = assertSwapBeneficiary({ tokens, tokenInAddress: USDC, tokenOutAddress: EURC, walletAddress: WALLET, ...over });
    return { threw: false, r };
  } catch (e) { return { threw: true, msg: e.message }; }
};
// ── the two PRE-FIX implementations, re-created verbatim in spirit
const oldGuard = (cd) => !(!cd || String(cd.to).toLowerCase() !== SWAP_ADAPTER); // true = it passed
const indexZero = (tokens, wallet) => String(tokens?.[0]?.beneficiary ?? "").toLowerCase() === wallet.toLowerCase();

const leg = (token, beneficiary) => ({ token, beneficiary });
const HONEST = [leg(USDC, WALLET), leg(EURC, WALLET)];

console.log(`\n── beneficiary assert · adapter ${SWAP_ADAPTER.slice(0, 10)}… (read from source) ──\n`);

console.log("⭐ THE DEFECT: tokenOut pays a STRANGER, and cd.to is the CORRECT adapter");
{
  // The exact case named in the finding: correct destination CONTRACT, wrong destination for the MONEY.
  const hostile = [leg(USDC, WALLET), leg(EURC, ATTACKER)];
  const cd = { to: SWAP_ADAPTER, data: "0x1234" }; // ← the REAL adapter, deliberately
  check("🚨 pre-fix OLD GUARD is GREEN on it (so it could never have caught this)", oldGuard(cd) === true);
  const r = run(hostile);
  check("⭐ the new assert is RED on the SAME payload", r.threw === true, r.msg?.slice(0, 60));
  check("   …and it names BOTH addresses, asked-for and returned",
    !!r.msg && r.msg.toLowerCase().includes(WALLET) && r.msg.toLowerCase().includes(ATTACKER));
  check("   …and it says we ASKED createSwap for that toAddress (fail-closed reason)",
    /asked createSwap for toAddress/i.test(r.msg || ""));
  check("   …and it states neither side is a state to spend from",
    /neither is a[\s\S]*state to spend from/i.test(r.msg || ""));
}

console.log("\n⭐⭐ SELECTION IS BY TOKEN, NOT BY POSITION — the sharpest pair");
{
  // tokens[0] (the tokenIN leg) is CORRECT while the tokenOUT leg pays a stranger.
  // An index-0 implementation is GREEN here. Ours must be RED.
  const sneaky = [leg(USDC, WALLET), leg(EURC, ATTACKER)];
  check("🚨 pre-fix INDEX-0 is GREEN on a payload whose OUTPUT leg pays a stranger",
    indexZero(sneaky, WALLET) === true);
  check("⭐ by-token selection is RED on it", run(sneaky).threw === true);

  // The mirror: tokens[0] (tokenIN leg) pays a stranger while the tokenOUT leg is correct.
  // Index-0 is RED (a false alarm); ours must PASS — the output is ours, which is what this guards.
  const mirror = [leg(USDC, ATTACKER), leg(EURC, WALLET)];
  check("🚨 pre-fix INDEX-0 raises a FALSE ALARM on it", indexZero(mirror, WALLET) === false);
  check("⭐ by-token selection PASSES (the OUTPUT leg is ours)", run(mirror).threw === false);

  // Order must not matter at all.
  check("order-independent: tokenOut leg FIRST still passes", run([leg(EURC, WALLET), leg(USDC, WALLET)]).threw === false);
  check("order-independent: tokenOut leg first + hostile still refuses", run([leg(EURC, ATTACKER), leg(USDC, WALLET)]).threw === true);
}

console.log("\n⚠️ AMBIGUITY REFUSES — it never falls back to an index");
{
  const noMatch = run([leg(USDC, WALLET)]);
  check("no tokens entry for tokenOut → refuses", noMatch.threw === true && /no `tokens` entry for tokenOut/.test(noMatch.msg));
  const disagree = run([leg(EURC, WALLET), leg(EURC, ATTACKER)]);
  check("two tokenOut entries, DIFFERENT beneficiaries → refuses", disagree.threw === true && /DIFFERENT beneficiaries/.test(disagree.msg));
  check("two tokenOut entries, SAME beneficiary → unambiguous, passes",
    run([leg(EURC, WALLET), leg(EURC, WALLET)]).threw === false);
  const same = run(HONEST, { tokenInAddress: EURC });
  check("tokenIn === tokenOut → refuses (output leg undecidable)", same.threw === true && /same token/.test(same.msg));
  check("tokens absent entirely → refuses", run(null).threw === true);
  check("tokens empty → refuses", run([]).threw === true);
  check("beneficiary malformed → refuses", run([leg(EURC, "0xnothex")]).threw === true);
  check("beneficiary missing → refuses", run([leg(EURC, undefined)]).threw === true);
  check("wallet address absent → refuses", run(HONEST, { walletAddress: "" }).threw === true);
  check("tokenOut address absent → refuses", run(HONEST, { tokenOutAddress: "" }).threw === true);
}

console.log("\n✅ THE HONEST PAYLOAD PASSES (a guard that refuses everything is not a guard)");
{
  const ok = run(HONEST);
  check("matching beneficiary → passes", ok.threw === false, JSON.stringify(ok.r));
  check("checksum/case differences do NOT matter",
    run([leg(USDC.toUpperCase().replace("0X", "0x"), WALLET), leg(EURC.toLowerCase(), WALLET.toUpperCase().replace("0X", "0x"))]).threw === false);
  check("it returns the beneficiary it verified", ok.r?.beneficiary === WALLET.toLowerCase());
}

console.log("\n⭐ THE ASSERT IS ACTUALLY WIRED INTO agentSwap (a guard nothing calls is decoration)");
{
  check("agentSwap calls assertSwapBeneficiary", /assertSwapBeneficiary\(\{\s*tokens: EP\.tokens/.test(SRC));
  const callIdx = SRC.indexOf("assertSwapBeneficiary({ tokens: EP.tokens");
  const submitIdx = SRC.indexOf("createContractExecutionTransaction({\n    walletAddress,\n    blockchain: ARC.blockchain,\n    contractAddress: cd.to");
  check("…BEFORE the swap is submitted", callIdx > 0 && submitIdx > 0 && callIdx < submitIdx);
  check("…and before the calldata is even built", callIdx > 0 && callIdx < SRC.indexOf("prepareAction("));
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money, zero network.`);
process.exit(fail === 0 ? 0 : 1);
