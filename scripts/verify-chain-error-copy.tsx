// verify-chain-error-copy.tsx — WHAT THE USER SEES WHEN THE CHAIN REFUSES A FUND.
//
// ═══ THE DEFECT ═══════════════════════════════════════════════════════════════════════════════
// 2026-09-14: a passkey "Fund agent" reverted ("ERC20: transfer amount exceeds balance") and the
// panel rendered viem's whole error — reason, then the Contract Call block with args
// `(0x…, 1000000000000000000)`, sender, docs link, version. The reason was right; the args line
// was the defect (1e18 into a 6-dp transfer), and no reader can see 10^12 in a hex blob.
// describeError passes any non-empty message through byte-identical BY DESIGN; describeChainError
// is the classifier in front of it for values viem throws.
//
// ⭐ ASSERTED ON OUTPUT, WITH A REAL VIEM ERROR — not a regex over the classifier's source. The
// error is built with viem's own classes so its `message`, `shortMessage` and cause chain are the
// real shapes, including the request dump we must drop. [[assert-on-rendered-output-not-regex]]
//
// ⛔ AND THE RED STATE IS PART OF THE RECORD: §1 asserts the property describeError does NOT have
// (it is not meant to), so a future "simplify: just use describeError" turns this red.

import { readFileSync } from "node:fs";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, BaseError } from "viem";
import { describeChainError } from "../src/lib/describeChainError";
import { describeError } from "../src/lib/describeError";

let pass = 0, fail = 0;
const section = (t: string) => console.log(`\n── ${t}`);
const check = (label: string, ok: boolean, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
};

const ABI = [{ type: "function", name: "transfer", stateMutability: "nonpayable",
  inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
const TO = "0x06b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8" as const;
const USDC = "0x3600000000000000000000000000000000000000" as const;
const ONE_E18 = 1_000_000_000_000_000_000n; // the calldata the defect produced for "1 USDC"

// The real thing: viem wraps the revert (with reason) in an execution error that renders the
// request dump. This is what the bundler/publicClient path throws.
const revert = new ContractFunctionRevertedError({ abi: ABI, functionName: "transfer",
  message: "ERC20: transfer amount exceeds balance" });
const viemErr = new ContractFunctionExecutionError(revert, {
  abi: ABI, functionName: "transfer", args: [TO, ONE_E18], contractAddress: USDC, sender: TO,
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("0 — THE FIXTURE IS THE REAL SHAPE (or every assertion below is vacuous)");
check("viem's message carries the request dump", /Contract Call:/.test(viemErr.message) && viemErr.message.includes(String(ONE_E18)),
  `${viemErr.message.length} chars`);
check("viem's shortMessage does not", !/Contract Call:/.test(viemErr.shortMessage));
check("the revert reason is reachable by walking the cause chain",
  (viemErr.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null)?.reason === "ERC20: transfer amount exceeds balance");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — 🚨 THE RED STATE: describeError DOES leak it (by design — this is why the classifier exists)");
const raw = describeError(viemErr);
check("⛔ describeError renders the args line with the 1e18", raw.includes(String(ONE_E18)),
  "if this goes green-by-absence, describeError changed contract and the header of describeError.ts is wrong");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⭐⭐ describeChainError: the reason, the refusal, and NOTHING from the request");
const out = describeChainError(viemErr);
console.log(`     → "${out}"`);
check("⭐⭐ the reason is in the sentence", out.includes("ERC20: transfer amount exceeds balance"));
check("⭐ it says the CHAIN refused (not the server, not 'failed')", /chain refused/i.test(out));
check("⭐ it says nothing was sent — the revert is atomic", /Nothing was sent/.test(out));
check("🚨 the 1e18 amount is NOT in it", !out.includes(String(ONE_E18)));
check("🚨 no calldata / hex blob longer than an address prefix", !/0x[0-9a-fA-F]{20,}/.test(out));
check("🚨 no request-dump headers", !/Contract Call|Request Arguments|Version:|Docs:/.test(out));
check("⭐ shorter than a tweet", out.length < 200, `${out.length} chars`);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐ THE OTHER SHAPES STILL GET THE HONEST PATH");
{
  // A viem error with a shortMessage but no revert reason (e.g. a bundler estimation failure).
  const noReason = new BaseError("Execution reverted for an unknown reason.", { metaMessages: ["Request Arguments:", "  from: 0xabc"] });
  const o = describeChainError(noReason);
  check("⭐ shortMessage is used when there is no reason", o === "Execution reverted for an unknown reason.", `"${o}"`);
  check("⭐ …and the metaMessages (request dump) are not", !/Request Arguments/.test(o));
}
{
  // A plain Error, a string, a message-less throw: describeError's contract, byte-identical.
  check("⭐ a plain Error passes through unchanged", describeChainError(new Error("network down")) === "network down");
  check("⭐ a thrown string is described, not swallowed", describeChainError("boom") === describeError("boom"));
  check("⭐ a message-less throw keeps describeError's honest 'unknown error' sentence",
    /unknown error/.test(describeChainError({})) && describeChainError({}) === describeError({}));
}
{
  // A viem-LOOKING message with no shortMessage property at all (some wrappers re-throw as Error).
  const rethrown = new Error(viemErr.message);
  const o = describeChainError(rethrown);
  check("⭐ a re-thrown plain Error carrying viem's message is cut at the first detail block",
    !o.includes(String(ONE_E18)) && /exceeds balance/.test(o), `"${o.slice(0, 80)}…"`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⭐ THE TWO FUND CATCH SITES USE IT (the classifier is only worth what calls it)");
const ym = readFileSync("src/components/YourMoney.tsx", "utf8");
const mw = readFileSync("src/wallet/useModularWallet.ts", "utf8");
{
  const fundCatch = ym.slice(ym.indexOf("await w.fundAgentWallet("), ym.indexOf("setFundBusy(false)"));
  check("⭐ YourMoney's fund catch renders describeChainError, not describeError",
    /setFundErr\(describeChainError\(e\)\)/.test(fundCatch) && !/setFundErr\(describeError\(e\)\)/.test(fundCatch));
  const hookCatch = mw.slice(mw.indexOf("const fundAgentWallet = useCallback("), mw.indexOf("\n  );", mw.indexOf("const fundAgentWallet = useCallback(")));
  check("⭐ the hook's status line does too", /setStatus\(`Error: \$\{describeChainError\(e\)\}`\)/.test(hookCatch));
  check("⛔ and no `Error: ${e.message}` remains in fundAgentWallet", !/\$\{e\.message\}/.test(hookCatch));
}

console.log(`\n${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail ? 1 : 0);
