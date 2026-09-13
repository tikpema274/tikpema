// verify-swap-token-resolver.mjs — ONE symbol→address resolver, and it THROWS on unknown.
//
//   node scripts/verify-swap-token-resolver.mjs      (also: npm run test:swaptokens)
//
// ═══ WHAT THIS GUARDS ═════════════════════════════════════════════════════════════════════════
// Three modules each carried `sym === "EURC" ? CONTRACTS.EURC : CONTRACTS.USDC`. With two tokens the
// else-branch was USDC by coincidence; a third symbol would have resolved to USDC's contract and read
// the WRONG token's balance / logs / approval, silently, while upstream validation said the symbol was
// fine. [[two-enforcement-points-one-bound]]
//
// ⭐ THE CALLER SET IS ASSERTED, NOT JUST THE HELPER. A resolver that throws is worthless if a caller
// still has its own ternary. Each of the three former sites is exercised with an unknown symbol and
// must reject with THE RESOLVER'S message — not merely reject, because an RPC failure also rejects
// and would read as a pass. [[guard-belongs-on-the-caller-set]] [[check-whose-failure-mode-is-a-pass]]
//
// ⚠️ RED STATE RECORDED 2026-09-13: with the ternaries in place, `readTokenBalance("USDT", …)` did not
// refuse — it read USDC's balanceOf. This suite's §2 is what turns that red.
import { readFileSync, readdirSync, mkdirSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { swapTokenAddress, SWAP_TOKENS, SWAP_TOKEN_DECIMALS } from "../netlify/functions/_swap-tokens.mjs";
import { SWAP_TOKENS as REEXPORTED, swapTokenAddress as reexportedResolver } from "../netlify/functions/_swap.mjs";
import { CONTRACTS } from "../netlify/functions/_arc.mjs";
import { readTokenBalance } from "../netlify/functions/_dca.mjs";
import { confirmSwapLanded } from "../netlify/functions/_swap-confirm.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const UNKNOWN = /unknown swap token/;
const WALLET = "0x74b7b561FD71C68Eb1Da6b96a7A87033904b24E5";
async function rejection(p) { try { await p; return null; } catch (e) { return String(e?.message ?? e); } }

section("1 — the resolver: known symbols resolve, unknown THROW, non-token keys THROW");
check("USDC resolves to CONTRACTS.USDC", swapTokenAddress("USDC") === CONTRACTS.USDC);
check("EURC resolves to CONTRACTS.EURC", swapTokenAddress("EURC") === CONTRACTS.EURC);
check("⭐ the two resolve to DIFFERENT addresses (a collapse would pass the equalities above)", swapTokenAddress("USDC") !== swapTokenAddress("EURC"));
check("case-insensitive on input", swapTokenAddress("eurc") === CONTRACTS.EURC && swapTokenAddress("Usdc") === CONTRACTS.USDC);
for (const sym of ["USDT", "DAI", "", undefined, null, "USDC ", 0]) {
  let msg = null; try { swapTokenAddress(sym); } catch (e) { msg = e.message; }
  check(`⭐⭐ ${JSON.stringify(sym)} THROWS, naming the symbol`, !!msg && UNKNOWN.test(msg) && msg.includes(JSON.stringify(sym ?? "") ) || (!!msg && UNKNOWN.test(msg) && (sym === undefined || sym === null || sym === 0)), msg?.slice(0, 80) ?? "returned an address");
}
{
  // ⛔ A key that IS in CONTRACTS but is NOT a token must refuse — `CONTRACTS[sym]` would have resolved it.
  const nonToken = Object.keys(CONTRACTS).find((k) => !SWAP_TOKENS.includes(k));
  let msg = null; try { swapTokenAddress(nonToken); } catch (e) { msg = e.message; }
  check(`⭐⭐ a non-token CONTRACTS key (${nonToken}) THROWS — the map is consulted AFTER the list, never instead of it`, !!msg && UNKNOWN.test(msg), msg?.slice(0, 80) ?? "returned an address");
}
check("_swap.mjs re-exports the SAME list and resolver (one producer, nine importers unchanged)", REEXPORTED === SWAP_TOKENS && reexportedResolver === swapTokenAddress);

section("2 — the CALLER SET refuses with the resolver's message, before any RPC");
{
  const m = await rejection(readTokenBalance("USDT", WALLET));
  check("⭐⭐ _dca.readTokenBalance(\"USDT\") rejects with the RESOLVER's message (not an RPC error, not a USDC balance)", !!m && UNKNOWN.test(m), m?.slice(0, 90) ?? "resolved — it read SOME token's balance");
  const ok = await rejection(readTokenBalance("EURC", WALLET).then(() => "ok"));
  check("  …and a known symbol is not refused by the resolver (an RPC outcome is fine here)", !(ok && UNKNOWN.test(ok)), ok ? ok.slice(0, 60) : "read ok");
}
{
  const t0 = Date.now();
  const m = await rejection(confirmSwapLanded({ walletAddress: WALLET, tokenIn: "USDT", tokenOut: "USDC", amountIn: 1 }));
  check("⭐⭐ _swap-confirm.confirmSwapLanded(tokenIn:\"USDT\") rejects with the RESOLVER's message", !!m && UNKNOWN.test(m), m?.slice(0, 90) ?? "did not reject");
  check("  …and before any network call (< 200ms; the witness client is opened AFTER the tokens resolve)", Date.now() - t0 < 200, `${Date.now() - t0}ms`);
  const m2 = await rejection(confirmSwapLanded({ walletAddress: WALLET, tokenIn: "USDC", tokenOut: "PYUSD", amountIn: 1 }));
  check("⭐ tokenOut is resolved too, not only tokenIn", !!m2 && UNKNOWN.test(m2), m2?.slice(0, 90) ?? "did not reject");
}

section("3 — no private ternary or CONTRACTS[symbol] lookup survives anywhere in netlify/functions");
{
  const dir = "netlify/functions";
  const offenders = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".mjs"))) {
    const src = readFileSync(`${dir}/${f}`, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    if (/\?\s*CONTRACTS\.EURC\s*:\s*CONTRACTS\.USDC/.test(src) || /CONTRACTS\[\s*t(In|Out|oken)?\s*\]/.test(src)) offenders.push(f);
  }
  check("⛔ zero files carry the ternary or a CONTRACTS[token] lookup (comments excluded)", offenders.length === 0, offenders.join(", ") || "none");
  // job-swap-approve's resolver is module-private (no export to exercise), so its wiring is asserted by source:
  const jsa = readFileSync(`${dir}/job-swap-approve.mjs`, "utf8");
  // ⭐ FROM THE OWNER MODULE, not via _swap.mjs: verify-swap-approve mocks _swap.mjs with an explicit
  // namedExports list, so a resolver routed through that path would stop the suite LOADING.
  const importsFromOwner = jsa.split("\n").some((l) => /^import\s*\{[^}]*\bswapTokenAddress\b[^}]*\}\s*from\s*"\.\/_swap-tokens\.mjs"/.test(l));
  check("job-swap-approve routes through swapTokenAddress, imported from _swap-tokens.mjs (the owner, not the mocked _swap.mjs)",
    /swapTokenAddress\(sym\)/.test(jsa) && importsFromOwner, importsFromOwner ? "owner import present" : "no import from ./_swap-tokens.mjs");
}

section("4 — DECIMALS GATE, mutation-proven: a non-6-dp token must FAIL before it reaches toMinor");
const DECIMALS_MSG = /decimals but every scaling site on the swap path assumes 6/;
check("every listed token DECLARES decimals, and every declaration is 6 (the hardcode the gate guards)",
  SWAP_TOKENS.every((t) => SWAP_TOKEN_DECIMALS[t] === 6), JSON.stringify(SWAP_TOKEN_DECIMALS));
check("the declaration map is frozen (a runtime write cannot widen it)", Object.isFrozen(SWAP_TOKEN_DECIMALS));
{
  // ⭐ THE MUTATION IS A SOURCE EDIT IN A SANDBOX COPY, executed every run — not a red state recorded
  // once. Two copies of netlify/functions (+shared, for ../../shared imports) under node_modules/.cache:
  //   GATED   — the real resolver, plus a fixture token MUT18 declared with 18 decimals.
  //   UNGATED — the same, with the decimals gate cut out: the CONTROL that proves the assertion below
  //             is earned by the gate and not by some earlier refusal (Missing KIT_KEY, bad symbol…).
  // toMinor in BOTH copies is replaced by one that THROWS a sentinel, so "reached toMinor" is
  // observable: GATED must never raise it; UNGATED must — otherwise the fixture never got that far and
  // section 4 would be passing vacuously. [[never-mock-the-function-under-test]] — the callers are the
  // real modules; only the token list (the input) and the observation point are fixtures.
  const SENTINEL = "MUTATION_REACHED_TOMINOR";
  const ROOT = "node_modules/.cache/tikpema-swap-mutation";
  const build = (variant, { gated }) => {
    const base = `${ROOT}/${variant}`;
    rmSync(base, { recursive: true, force: true });
    mkdirSync(`${base}/netlify`, { recursive: true });
    cpSync("netlify/functions", `${base}/netlify/functions`, { recursive: true });
    cpSync("shared", `${base}/shared`, { recursive: true });
    const tok = `${base}/netlify/functions/_swap-tokens.mjs`;
    let src = readFileSync(tok, "utf8");
    const before = src;
    src = src.replace('export const SWAP_TOKENS = ["USDC", "EURC"];', 'export const SWAP_TOKENS = ["USDC", "EURC", "MUT18"];');
    src = src.replace("Object.freeze({ USDC: 6, EURC: 6 })", "Object.freeze({ USDC: 6, EURC: 6, MUT18: 18 })");
    src = src.replace("const address = CONTRACTS[sym];", 'const address = sym === "MUT18" ? "0x000000000000000000000000000000000000dEaD" : CONTRACTS[sym];');
    if (src === before || !src.includes("MUT18: 18") || !src.includes("MUT18\"] ") && !src.includes('"MUT18"]')) throw new Error("mutation fixture did not apply — the resolver source shape changed; fix the sandbox, not the gate");
    if (!gated) {
      // If there is no gate to cut (the red state: someone removed it), proceed — the GATED checks
      // below are what report that, as ❌ lines, not a crash. A verdict is earned by assertions.
      src = src.replace(/  \/\/ ⛔ DECIMALS GATE[\s\S]*?\n  return address;\n/, "  return address;\n");
    }
    writeFileSync(tok, src);
    const sw = `${base}/netlify/functions/_swap.mjs`;
    const swSrc = readFileSync(sw, "utf8").replace(/^const toMinor = .*$/m, `const toMinor = () => { throw new Error("${SENTINEL}"); };`);
    if (!swSrc.includes(SENTINEL)) throw new Error("could not instrument toMinor in the sandbox copy");
    writeFileSync(sw, swSrc);
    return `${pathToFileURL(base).href}/netlify/functions/`;
  };
  const gatedUrl = build("gated", { gated: true });
  const ungatedUrl = build("ungated", { gated: false });
  const [gSwap, gDca, gConfirm, uSwap] = await Promise.all([
    import(`${gatedUrl}_swap.mjs`), import(`${gatedUrl}_dca.mjs`), import(`${gatedUrl}_swap-confirm.mjs`), import(`${ungatedUrl}_swap.mjs`),
  ]);
  const prevKey = process.env.KIT_KEY;
  process.env.KIT_KEY = "mutation-fixture-never-sent"; // buildSwapCallData checks KIT_KEY BEFORE toMinor; the sentinel throws before any fetch
  try {
    const g = await rejection(gSwap.buildSwapCallData({ walletAddress: WALLET, tokenIn: "MUT18", tokenOut: "USDC", amountIn: 1 }));
    check("⭐⭐ GATED: buildSwapCallData(tokenIn:\"MUT18\") rejects with the DECIMALS message", !!g && DECIMALS_MSG.test(g), g?.slice(0, 100) ?? "did not reject");
    check("⭐⭐ GATED: …and it NEVER reached toMinor (no sentinel)", !!g && !g.includes(SENTINEL), g?.slice(0, 60));
    const g2 = await rejection(gSwap.buildSwapCallData({ walletAddress: WALLET, tokenIn: "USDC", tokenOut: "MUT18", amountIn: 1 }));
    check("⭐ GATED: tokenOut MUT18 is refused too", !!g2 && DECIMALS_MSG.test(g2), g2?.slice(0, 100) ?? "did not reject");
    const u = await rejection(uSwap.buildSwapCallData({ walletAddress: WALLET, tokenIn: "MUT18", tokenOut: "USDC", amountIn: 1 }));
    check("⭐⭐ UNGATED CONTROL: the same call REACHES toMinor (sentinel raised) — the fixture is real and the gate is what stops it", !!u && u.includes(SENTINEL), u?.slice(0, 100) ?? "did not reject at all");
    const gAgent = await rejection(gSwap.agentSwap({ walletAddress: WALLET, tokenIn: "MUT18", tokenOut: "USDC", amountIn: 1 }));
    check("⭐ GATED: agentSwap(tokenIn:\"MUT18\") rejects with the DECIMALS message, before toMinor", !!gAgent && DECIMALS_MSG.test(gAgent) && !gAgent.includes(SENTINEL), gAgent?.slice(0, 100) ?? "did not reject");
  } finally {
    if (prevKey === undefined) delete process.env.KIT_KEY; else process.env.KIT_KEY = prevKey;
  }
  const d = await rejection(gDca.readTokenBalance("MUT18", WALLET));
  check("⭐ GATED: _dca.readTokenBalance(\"MUT18\") rejects with the DECIMALS message (before balanceOf, before formatUnits)", !!d && DECIMALS_MSG.test(d), d?.slice(0, 100) ?? "resolved — it read a balance and scaled it by 6");
  const c = await rejection(gConfirm.confirmSwapLanded({ walletAddress: WALLET, tokenIn: "MUT18", tokenOut: "USDC", amountIn: 1 }));
  check("⭐ GATED: _swap-confirm.confirmSwapLanded(tokenIn:\"MUT18\") rejects with the DECIMALS message (before parseUnits)", !!c && DECIMALS_MSG.test(c), c?.slice(0, 100) ?? "did not reject");
  // A known 6-dp token in the GATED sandbox is NOT refused by the gate — the gate discriminates on decimals, not on "is a fixture present".
  let known = null; try { gSwap.swapTokenAddress("EURC"); } catch (e) { known = e.message; }
  check("GATED: EURC still resolves (the gate refuses 18, not everything)", known === null, known?.slice(0, 80) ?? "resolved");
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
