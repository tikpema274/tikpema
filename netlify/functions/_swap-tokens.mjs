// _swap-tokens.mjs — THE swap token list and THE ONE symbol→address resolver.
//
// ═══ 🚨 WHY ONE RESOLVER, AND WHY IT THROWS ═══════════════════════════════════════════════════
// Three modules each carried their own `sym === "EURC" ? CONTRACTS.EURC : CONTRACTS.USDC`
// (_dca.mjs readTokenBalance, _swap-confirm.mjs tokenAddr, job-swap-approve.mjs tokenAddress). With
// a two-token list the else-branch IS USDC, so the shape was correct by coincidence. The day the
// list gains a third symbol — the mainnet stable list will — every one of those ternaries resolves
// "USDT" to USDC's contract and reads a USDT mandate's balance, confirms its logs, and checks its
// approval against the WRONG token, silently. Validation upstream (SWAP_TOKENS) would say the symbol
// is fine; the ternary would say USDC. Two enforcement points, one bound.
// [[two-enforcement-points-one-bound]] [[absence-must-never-read-as-safe]]
//
// So: one resolver, and an unknown symbol THROWS. Never a default. A caller that reaches a token
// read with a symbol this module does not know has a bug upstream, and the only safe answer is to
// stop before the RPC, naming the symbol.
//
// ⛔ NOT `CONTRACTS[sym]`. That map also holds IDENTITY_REGISTRY, TIKPEMA_PREDICTION, AGENTIC_COMMERCE…
// — a symbol that happens to match a non-token key would resolve to a contract that is not a token.
// Membership in SWAP_TOKENS is checked FIRST; the address map is consulted second.
//
// ⭐ THIS MODULE IS DELIBERATELY LIGHT. It imports only _arc.mjs (the address map), never the App Kit,
// so _swap-confirm.mjs — a receipt reader with no SDK dependency — can use it without pulling the
// swap SDK into its bundle. `_swap.mjs` re-exports SWAP_TOKENS from here so its nine importers are
// unchanged. ⚠️ _arc.mjs is on the DD surface (ddTree); this file is NOT, which is why the resolver
// lives here and not beside CONTRACTS.
import { CONTRACTS } from "./_arc.mjs";

// The list. Arc Testnet's stablecoin service prices exactly these two (MEASURED 2026-09-13 via
// GET /v1/stablecoinKits/rates?chain=Arc_Testnet). When this derives from that endpoint, the
// resolver below is what keeps a derived symbol from silently becoming USDC.
export const SWAP_TOKENS = ["USDC", "EURC"];

/**
 * Symbol → ERC-20 address on Arc, for the swap token list ONLY. Case-insensitive on input.
 * @throws on anything not in SWAP_TOKENS, or in the list but missing from CONTRACTS — with the
 *         symbol in the message, so the refusal names what it compared.
 */
export function swapTokenAddress(symbol) {
  const sym = String(symbol ?? "").toUpperCase();
  if (!SWAP_TOKENS.includes(sym)) {
    throw new Error(
      `unknown swap token ${JSON.stringify(symbol)} — not in the swap list (${SWAP_TOKENS.join("/")}); ` +
        `refusing to resolve an address for it`
    );
  }
  const address = CONTRACTS[sym];
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`swap token ${sym} is in the list but has no contract address configured — refusing`);
  }
  return address;
}
