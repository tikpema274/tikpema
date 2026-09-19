// returnTo.ts — leave for #/wallet and COME BACK to where you were, query included.
//
// ═══ THE DEFECT THIS CLOSES (live proof, 2026-09-19) ═════════════════════════════════════════════
// Every "Set up your wallet first — open Wallet" gate navigated with a bare `location.hash =
// "/wallet"`. Nothing carried the route the user was on, so a buyer on #/pay?order=<id> who followed
// the app's own instruction came back through the nav to a bare #/pay — the door — with the order id
// gone. Same for a payment link (#/send?to=…) and the treasury prefills (#/bridge?…, #/unified?…).
//
// ⭐ ONE HELPER FOR THE WHOLE CALLER SET. Four sites had the bare link; a fix on one of them would
// have left three. [[guard-belongs-on-the-caller-set]]
//
// ⛔ sessionStorage, NEVER localStorage. The stash is this tab's, for this connect, and is cleared the
// moment it is used. A localStorage copy would outlive the tab: on a shared device the next person to
// connect would be sent to someone else's order. The order id is not secret (it is in a shared link)
// — the hazard is the SEND, not the id. Storage that throws (private mode, blocked) is treated as
// absent: navigation still happens, the return is simply not remembered.
export const RETURN_TO_KEY = "tikpema.returnTo";
const WALLET_HASH = "#/wallet";

const read = (): string | null => { try { return window.sessionStorage.getItem(RETURN_TO_KEY); } catch { return null; } };
const write = (v: string) => { try { window.sessionStorage.setItem(RETURN_TO_KEY, v); } catch { /* not remembered */ } };
const clear = () => { try { window.sessionStorage.removeItem(RETURN_TO_KEY); } catch { /* nothing to clear */ } };

/** Is this a hash we would want to come back to? Never the wallet page itself (a loop), never empty. */
function worthReturningTo(hash: string): boolean {
  const h = String(hash || "").trim();
  if (!h || h === "#" || h === "#/") return false;
  return h.split("?")[0].replace(/\/+$/, "") !== WALLET_HASH;
}

/** Stash the FULL current hash (route + query) and go to #/wallet. */
export function goToWalletAndReturn(): void {
  const here = typeof window === "undefined" ? "" : window.location.hash;
  if (worthReturningTo(here)) write(here);
  window.location.hash = WALLET_HASH;
}

/**
 * Called by the wallet page once the wallet is READY. If a return-to is stashed, navigate there and
 * clear it; returns the hash it went to, or null when there was nothing to return to.
 */
export function returnAfterConnect(): string | null {
  const to = read();
  clear();
  if (!to || !worthReturningTo(to)) return null;
  window.location.hash = to;
  return to;
}
