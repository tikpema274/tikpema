// verify-swap-calldata-decode.ts — the CLIENT-SIDE decode, validated RED against a hostile payload
// and GREEN against REAL captured calldata. Zero money, zero network (fixtures are on disk).
//
// ═══ ⭐⭐ WHAT MAKES THE ✅s MEAN ANYTHING ══════════════════════════════════════════════════════
// The hostile payload is built by RE-ENCODING a real one with ONLY the beneficiary changed —
// everything else byte-identical, `to` still the correct adapter. That is exactly the case the
// server-side assert catches (assertSwapBeneficiary, _swap.mjs) and the client must catch
// INDEPENDENTLY, because the threat model is that the server's own response is wrong.
// ⭐ And the MIRROR is asserted throughout: a correct payload must PASS, in BOTH directions. A
// decoder that refuses everything would score full marks on the red cases alone.
//
//   npx tsx scripts/verify-swap-calldata-decode.ts
import { readFileSync } from "node:fs";
import { encodeFunctionData, decodeFunctionData, getAddress } from "viem";
import { decodeSwapCalldata, decodeAndVerifySwap, SwapDecodeError } from "../src/lib/decodeSwapCalldata";
// ⭐ Token ADDRESSES are resolved from the app's own constant, never restated in the fixture.
// One source of truth for a contract address, and the fixture carries only what is genuinely
// captured data (the calldata, the floor, the deadline, the beneficiary).
import { CONTRACTS } from "../src/config/contracts";

const FIX = JSON.parse(readFileSync(new URL("./fixtures/swap-calldata.json", import.meta.url), "utf8"));
const ATTACKER = getAddress("0xdeadbeef00000000000000000000000000001234");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const refused = (fn: () => unknown) => {
  try { fn(); return { threw: false, msg: "" }; }
  catch (e: any) { return { threw: true, msg: String(e.message), isOurs: e instanceof SwapDecodeError }; }
};

// The same ABI the decoder uses, so a hostile payload is a REAL re-encode rather than a hand-edit.
const ABI = [{ type: "function", name: "execute", stateMutability: "payable", outputs: [], inputs: [
  { name: "params", type: "tuple", components: [
    { name: "instructions", type: "tuple[]", components: [
      { name: "target", type: "address" }, { name: "data", type: "bytes" }, { name: "value", type: "uint256" },
      { name: "tokenIn", type: "address" }, { name: "amountToApprove", type: "uint256" },
      { name: "tokenOut", type: "address" }, { name: "minTokenOut", type: "uint256" }] },
    { name: "tokens", type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "beneficiary", type: "address" }] },
    { name: "execId", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "metadata", type: "bytes" }] },
  { name: "tokenInputs", type: "tuple[]", components: [
    { name: "permitType", type: "uint8" }, { name: "token", type: "address" },
    { name: "amount", type: "uint256" }, { name: "permitCalldata", type: "bytes" }] },
  { name: "signature", type: "bytes" }] }] as const;

/** Re-encode a real payload with one field mutated. Everything else stays byte-identical. */
function mutate(data: string, fn: (p: any, ti: any) => [any, any]): string {
  const { args } = decodeFunctionData({ abi: ABI, data: data as `0x${string}` });
  const [params, tokenInputs, signature] = args as any;
  const [p2, t2] = fn(
    { ...params, instructions: params.instructions.map((i: any) => ({ ...i })), tokens: params.tokens.map((t: any) => ({ ...t })) },
    tokenInputs.map((t: any) => ({ ...t }))
  );
  return encodeFunctionData({ abi: ABI, functionName: "execute", args: [p2, t2, signature] as any });
}

for (const dir of ["USDC_EURC", "EURC_USDC"] as const) {
  const f = FIX[dir];
  const tokenIn = CONTRACTS[f.expect.tokenInSym as "USDC" | "EURC"];
  const tokenOut = CONTRACTS[f.expect.tokenOutSym as "USDC" | "EURC"];
  const { beneficiary } = f.expect;
  const base = { calldata: f.data, tokenInAddress: tokenIn, tokenOutAddress: tokenOut };
  console.log(`\n════ ${dir.replace("_", " → ")} · REAL captured calldata, ${(f.data.length - 2) / 2} bytes ════`);

  // ── ⭐ THE MIRROR FIRST: a correct payload must pass, or every red below is free.
  console.log("  ⭐ MIRROR — the honest payload PASSES (a decoder that refuses everything is useless)");
  {
    const d = decodeSwapCalldata(base);
    check("decodes without throwing", true);
    check("beneficiary matches the real one", getAddress(d.beneficiary) === getAddress(beneficiary), d.beneficiary);
    check("minTokenOut comes from the OUTPUT leg, not instructions[0]",
      d.minTokenOut === BigInt(f.expect.minTokenOut) && d.minTokenOut > 0n, `${d.minTokenOut}`);
    check("deadline matches the quote", d.deadline === BigInt(f.expect.deadline), `${d.deadline}`);
    check("amountIn matches what was requested", d.amountIn === BigInt(f.expect.amountIn), `${d.amountIn}`);
    check("decodeAndVerifySwap PASSES for the real owner",
      refused(() => decodeAndVerifySwap({ ...base, expectedBeneficiary: beneficiary })).threw === false);
  }

  // ── 🚨 THE DEFECT: beneficiary swapped for a stranger, EVERYTHING ELSE IDENTICAL.
  console.log("  🚨 RED — beneficiary is a FOREIGN address, everything else correct");
  {
    const hostile = mutate(f.data, (p, ti) => [
      { ...p, tokens: p.tokens.map((t: any) => (t.token.toLowerCase() === tokenOut.toLowerCase() ? { ...t, beneficiary: ATTACKER } : t)) },
      ti,
    ]);
    check("the hostile payload still DECODES (it is well-formed — that is the point)",
      refused(() => decodeSwapCalldata({ ...base, calldata: hostile })).threw === false);
    const d = decodeSwapCalldata({ ...base, calldata: hostile });
    check("⭐ the decode SURFACES the foreign address", getAddress(d.beneficiary) === getAddress(ATTACKER), d.beneficiary);
    const r = refused(() => decodeAndVerifySwap({ ...base, calldata: hostile, expectedBeneficiary: beneficiary }));
    check("⭐⭐ decodeAndVerifySwap REFUSES it", r.threw === true && !!r.isOurs);
    check("   …and names BOTH addresses so a human can compare",
      r.msg.toLowerCase().includes(ATTACKER.toLowerCase()) && r.msg.toLowerCase().includes(beneficiary.toLowerCase()));
    check("   …and says it will not be offered for signature", /refusing to offer it for signature/i.test(r.msg));
    // ⭐ the mutation really was minimal — prove only the beneficiary moved.
    const a = decodeSwapCalldata(base), b = decodeSwapCalldata({ ...base, calldata: hostile });
    check("   …and ONLY the beneficiary differs (floor, deadline, amount all unchanged)",
      a.minTokenOut === b.minTokenOut && a.deadline === b.deadline && a.amountIn === b.amountIn);
  }

  // ── ⭐⭐ BY TOKEN, NOT BY INDEX — the pre-fix shortcut, re-created and shown wrong.
  console.log("  ⭐⭐ SELECTION IS BY TOKEN — index-0 shortcuts re-created and shown WRONG");
  {
    const idx0Floor = (data: string) => {
      const { args } = decodeFunctionData({ abi: ABI, data: data as `0x${string}` });
      return BigInt((args as any)[0].instructions[0].minTokenOut);
    };
    check("🚨 pre-fix INDEX-0 floor reads 0 on the REAL payload (the fee leg)", idx0Floor(f.data) === 0n);
    check("⭐ by-token floor is the real, non-zero one", decodeSwapCalldata(base).minTokenOut > 0n);

    // A payload where tokens[0] (the INPUT leg) is hostile but the OUTPUT leg is ours: an index-0
    // beneficiary reader raises a false alarm; ours must PASS, because the output is what we protect.
    const inputLegHostile = mutate(f.data, (p, ti) => [
      { ...p, tokens: p.tokens.map((t: any) => (t.token.toLowerCase() === tokenIn.toLowerCase() ? { ...t, beneficiary: ATTACKER } : t)) },
      ti,
    ]);
    check("⭐ a hostile INPUT-leg beneficiary does NOT trip the output check (no false alarm)",
      refused(() => decodeAndVerifySwap({ ...base, calldata: inputLegHostile, expectedBeneficiary: beneficiary })).threw === false);
  }

  // ── ⛔ AMBIGUITY BLOCKS — never degrades to "sign anyway".
  console.log("  ⛔ AMBIGUITY BLOCKS THE BUTTON");
  {
    const noRecipient = mutate(f.data, (p, ti) => [{ ...p, tokens: p.tokens.filter((t: any) => t.token.toLowerCase() !== tokenOut.toLowerCase()) }, ti]);
    check("no destination for the bought token → refuses",
      refused(() => decodeSwapCalldata({ ...base, calldata: noRecipient })).threw === true);
    const twoDests = mutate(f.data, (p, ti) => [{ ...p, tokens: [...p.tokens, { token: tokenOut, beneficiary: ATTACKER }] }, ti]);
    const td = refused(() => decodeSwapCalldata({ ...base, calldata: twoDests }));
    check("two DIFFERENT destinations → refuses", td.threw === true && /more than one destination/i.test(td.msg));
    const twoFloors = mutate(f.data, (p, ti) => [
      { ...p, instructions: [...p.instructions, { ...p.instructions[1], minTokenOut: 1n }] }, ti]);
    check("conflicting minimums → refuses", refused(() => decodeSwapCalldata({ ...base, calldata: twoFloors })).threw === true);
    const noInput = mutate(f.data, (p, ti) => [p, ti.filter((t: any) => t.token.toLowerCase() !== tokenIn.toLowerCase())]);
    check("no amount-to-spend entry → refuses", refused(() => decodeSwapCalldata({ ...base, calldata: noInput })).threw === true);
    check("same token in and out → refuses",
      refused(() => decodeSwapCalldata({ ...base, tokenOutAddress: tokenIn })).threw === true);
    check("garbage calldata → refuses", refused(() => decodeSwapCalldata({ ...base, calldata: "0xdeadbeef" })).threw === true);
    check("empty calldata → refuses", refused(() => decodeSwapCalldata({ ...base, calldata: "0x" })).threw === true);
    check("a DIFFERENT contract's calldata → refuses",
      refused(() => decodeSwapCalldata({ ...base, calldata: "0x095ea7b3" + "0".repeat(128) })).threw === true);
  }
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money, zero network.`);
process.exit(fail === 0 ? 0 : 1);
