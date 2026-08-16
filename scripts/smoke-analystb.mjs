// smoke-analystb.mjs — ZERO-MONEY. Runs Analyst B against the REAL CoinGecko + the REAL swap
// router. Mocks cannot violate a contract they stand in for (two SDK bugs proved that today),
// so B's independence claim is only worth anything if its real sources actually answer.
//
// KIT_KEY is supplied PER-RUN — never read back out of the production Netlify env, and never as
// `KIT_KEY=… node …` (that lands in shell history AND argv):
//   read -rs KIT_KEY && export KIT_KEY     # paste at the prompt — nothing echoes
//   node --env-file=.env scripts/smoke-analystb.mjs
//   unset KIT_KEY
import { analystB } from "../netlify/functions/_analystb.mjs";
import { compareAnalyses } from "../netlify/functions/_synthesis.mjs";
import { requireKitKey } from "./_kit-key.mjs";

// ⭐ CHECKED UP FRONT, which it never was before: this file hits the REAL swap router, so without a
// well-formed key the two swap proposals below fail deep inside analystB — and the run still prints
// verdicts for the bridge case, which reads like a partial success rather than a missing credential.
requireKitKey();
const W = "0xbafec950627579cf786acf875e6e216995e995a3";

for (const p of [
  { action: "swap", tokenIn: "USDC", tokenOut: "EURC", amountIn: 5, reasoning: "EUR is cheap, convert now!" },
  { action: "swap", tokenIn: "EURC", tokenOut: "USDC", amountIn: 5, reasoning: "back to dollars" },
  { action: "bridge", destination: "base", amountUsdc: 5 },
]) {
  const label = p.action === "swap" ? `${p.amountIn} ${p.tokenIn}→${p.tokenOut}` : `bridge ${p.amountUsdc} → ${p.destination}`;
  console.log(`\n═══ ${label} ═══`);
  const b = await analystB({ proposal: p, walletAddress: W });
  const s = compareAnalyses(p, b);
  console.log("  verdict        :", b.verdict);
  if (b.fairRate) console.log("  fair rate      :", b.fairRate.toFixed(6), "(independent market)");
  if (b.executable) console.log("  executable     :", b.executable.toFixed(6), "(live chain)");
  if (b.spreadPct !== undefined) console.log("  spread         :", b.spreadPct + "% off fair");
  if (b.feeUsdc !== undefined) console.log("  fee / net      :", b.feeUsdc, "/", b.netUsdc);
  console.log("  B says         :", b.headline);
  console.log("  → proposal survives?", s.proposalSurvives, "|", s.agreement);
  console.log("  → user sees    :", s.headline);
}
