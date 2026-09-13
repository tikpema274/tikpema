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
import { CONTRACTS, USDC_DECIMALS } from "./_arc.mjs";

// The list. Arc Testnet's stablecoin service prices exactly these two (MEASURED 2026-09-13 via
// GET /v1/stablecoinKits/rates?chain=Arc_Testnet). When this derives from that endpoint, the
// resolver below is what keeps a derived symbol from silently becoming USDC.
export const SWAP_TOKENS = ["USDC", "EURC"];

// ═══ ⚠️ DECLARED DECIMALS — THE HARDCODE MADE HONEST ═══════════════════════════════════════════════
// Every scaling site on the swap path hardcodes USDC_DECIMALS (6): toMinor and capBase in _swap.mjs,
// parseUnits/formatUnits in _swap-confirm.mjs, formatUnits in _dca.readTokenBalance. Caps CONVERT
// correctly (valueInUsdc prices the token) — decimals do not. A token with 18 decimals would have its
// amount, its cap AND its receipt mis-scaled by 10^12 in the SAME direction, and nothing would refuse.
//
// Decision 2026-09-13 — DECLARE and REFUSE, not READ. `kit.getTokenDecimals` exists, but adopting it
// adds a network call and a failure mode to a money path for a token that does not exist yet: every
// Circle stablecoin on this venue (USDC, EURC, USYC, USDT) is 6-dp, and an unexercised conversion on a
// money path is untested code. So the resolver refuses any symbol whose DECLARED decimals differ from
// the hardcode, and a symbol with NO declaration is refused too — an absent entry must never read as
// 6. The day a non-6-dp token joins the list, this gate is what turns that into a loud refusal instead
// of a silent 10^12 mis-scale, and THAT is when getTokenDecimals earns its place.
// ⛔ A value here is a CLAIM about the chain, not a reading. Verify a new entry against `decimals()`
// on Arc before adding it. [[default-is-not-a-reading]] [[absence-must-never-read-as-safe]]
export const SWAP_TOKEN_DECIMALS = Object.freeze({ USDC: 6, EURC: 6 });

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
  // ⛔ DECIMALS GATE — refuse anything the scaling sites' hardcode cannot represent (see above).
  const decimals = SWAP_TOKEN_DECIMALS[sym];
  if (decimals !== USDC_DECIMALS) {
    throw new Error(
      `swap token ${sym} has ${decimals === undefined ? "no declared" : `${decimals}`} decimals but every ` +
        `scaling site on the swap path assumes ${USDC_DECIMALS} — refusing to resolve it rather than mis-scale ` +
        `its amount, cap and receipt`
    );
  }
  return address;
}
