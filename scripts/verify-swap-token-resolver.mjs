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
import { readFileSync, readdirSync } from "node:fs";
import { swapTokenAddress, SWAP_TOKENS } from "../netlify/functions/_swap-tokens.mjs";
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

console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
