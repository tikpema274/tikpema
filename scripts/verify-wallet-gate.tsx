// verify-wallet-gate.tsx — the FOUR states behind "no agent wallet", the return-to round trip, and the
// failure that used to be swallowed.
//
//   npx tsx scripts/verify-wallet-gate.tsx      (npm run test:walletgate)
//
// ═══ THE DEFECT (live proof, 2026-09-19) ═════════════════════════════════════════════════════════
// #/pay?order=… signed out said "Set up your wallet first — open Wallet". Following that instruction
// lost the order id (bare #/wallet, nav back = #/pay with no query → the door). And after connecting,
// the page STILL said "Set up your wallet first": PayPanel gated on `!w.agentWallet` alone, which is
// null in FOUR different situations — no login wallet; wallet but no session; session with the
// /api/my-wallet resolve in flight; resolve FAILED — and useWallet swallowed the failure
// (`.catch(() => {})`), so the fourth read as the first, forever, with no reason and no retry.
// [[absence-must-never-read-as-safe]]
//
// ═══ THE PROPERTIES ══════════════════════════════════════════════════════════════════════════════
//   1. return-to: goToWalletAndReturn() stashes the FULL current hash in sessionStorage (never
//      localStorage), navigates to #/wallet; returnAfterConnect() sends the user back and CLEARS it.
//      A bare #/wallet or an empty stash returns nothing. Storage throwing never throws out.
//   2. resolveAgentWallet(): 200 → { wallet }; 401/500 → { error } naming the server's reason;
//      six 202s → { error } saying still provisioning; a thrown fetch → { error }. Never null-as-ok.
//   3. RENDERED: each of the four states has its OWN copy on Pay and on Send; the failed state shows
//      the reason, says nothing was paid/sent, and offers a Retry wired to refreshAgentWallet.
//   4. NO state renders the seal while agentWallet is null.
//   5. SOURCE: ALL TEN bare `location.hash = "/wallet"` sites are gone (src/ walked, zero remain); ConnectPasskey calls
//      returnAfterConnect in its ready branch; useWallet records the resolve failure.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? `  — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);
const strip = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

// ── a fake browser: sessionStorage + localStorage + location.hash ────────────────────────────────
const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); }, _m: m }; };
const g = globalThis as any;
g.window = g;
g.sessionStorage = store();
g.localStorage = store();
g.location = { hash: "" };

const { goToWalletAndReturn, returnAfterConnect, RETURN_TO_KEY } = await import("../src/lib/returnTo");
const { resolveAgentWallet } = await import("../src/wallet/resolveAgentWallet");
const { PayOrderView } = await import("../src/components/PayPanel");
const { default: SendPanel } = await import("../src/components/SendPanel");

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  WALLET GATE — four states, return-to, the un-swallowed failure      ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("1 — return-to round trip: sessionStorage only, cleared on use");
{
  const ORDER_HASH = "#/pay?order=o_mu8aqqbu_c87576aaf1375c4c";
  g.location.hash = ORDER_HASH;
  goToWalletAndReturn();
  check("⭐ navigates to #/wallet", g.location.hash === "#/wallet", g.location.hash);
  check("⭐ the FULL hash (route + query) is stashed under the named key", g.sessionStorage.getItem(RETURN_TO_KEY) === ORDER_HASH, String(g.sessionStorage.getItem(RETURN_TO_KEY)));
  check("🚨 NEVER localStorage (a stale return-to on a shared device must not send the next person to someone else's order)", g.localStorage._m.size === 0);
  const went = returnAfterConnect();
  check("⭐ returnAfterConnect sends the user back to the order", went === ORDER_HASH && g.location.hash === ORDER_HASH, `${went} / ${g.location.hash}`);
  check("⭐ …and CLEARS the key (a second connect does not bounce back again)", g.sessionStorage.getItem(RETURN_TO_KEY) === null);
  check("with nothing stashed, returnAfterConnect returns null and leaves the hash alone", returnAfterConnect() === null && g.location.hash === ORDER_HASH);
  g.location.hash = "#/wallet";
  goToWalletAndReturn();
  check("leaving FROM #/wallet stashes nothing (a return-to that points at the wallet page is a loop)", g.sessionStorage.getItem(RETURN_TO_KEY) === null);
  g.location.hash = "";
  goToWalletAndReturn();
  check("an empty hash stashes nothing", g.sessionStorage.getItem(RETURN_TO_KEY) === null);
  // storage that throws (private mode / blocked) must not throw out of navigation
  const real = g.sessionStorage;
  g.sessionStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  g.location.hash = "#/send?to=0xabc";
  let threw = false;
  try { goToWalletAndReturn(); returnAfterConnect(); } catch { threw = true; }
  check("storage that throws never throws out; navigation still happens", !threw && g.location.hash === "#/wallet");
  g.sessionStorage = real;
}

section("2 — resolveAgentWallet: the failure is a VALUE, never swallowed");
{
  const reply = (status: number, body: any) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const noSleep = async () => {};
  const ok = await resolveAgentWallet({ token: "t", fetchImpl: reply(200, { address: "0xabc", balance: "1.5", eurcBalance: null }) as any, sleep: noSleep });
  check("⭐ 200 → { wallet } with address/balance/eurcBalance", "wallet" in ok && ok.wallet.address === "0xabc" && ok.wallet.balance === "1.5" && ok.wallet.eurcBalance === null, JSON.stringify(ok));
  const unauth = await resolveAgentWallet({ token: "t", fetchImpl: reply(401, { error: "session expired" }) as any, sleep: noSleep });
  check("🚨 401 → { error } naming the server's reason (this used to vanish into .catch(() => {}))", "error" in unauth && /session expired/.test(unauth.error), JSON.stringify(unauth));
  const five = await resolveAgentWallet({ token: "t", fetchImpl: reply(500, {}) as any, sleep: noSleep });
  check("500 without a body reason → still an error, never ok", "error" in five && five.error.length > 0, JSON.stringify(five));
  let calls = 0;
  const prov = await resolveAgentWallet({ token: "t", fetchImpl: (async () => { calls++; return { status: 202, ok: true, json: async () => ({ status: "provisioning" }) }; }) as any, sleep: noSleep });
  check("🚨 six 202s → { error } that says still provisioning (was: return null, read as 'no wallet')", "error" in prov && /provisioning/i.test(prov.error) && calls === 6, `${calls} calls: ${JSON.stringify(prov)}`);
  const thrown = await resolveAgentWallet({ token: "t", fetchImpl: (async () => { throw new Error("network down"); }) as any, sleep: noSleep });
  check("a thrown fetch → { error } with the message", "error" in thrown && /network down/.test(thrown.error));
  const noTok = await resolveAgentWallet({ token: "", fetchImpl: (async () => { throw new Error("must not be called"); }) as any, sleep: noSleep });
  check("no token → { error } without calling the network", "error" in noTok && /session/i.test(noTok.error));
}

// ── rendered states ───────────────────────────────────────────────────────────────────────────────
const MERCHANT = "0x" + "ab".repeat(20);
const LOGIN = "0x" + "77".repeat(20);
const order = { id: "o_mu8aqqbu_c87576aaf1375c4c", merchant: MERCHANT, amountUsdc: "0.110000", description: "Two coffees", settlement: "direct", status: "open", createdAt: "2026-09-19T09:00:00.000Z", expiresAt: "2026-10-03T09:00:00.000Z", paidTx: null, paidAt: null, circleId: null, createdAtBlock: 62816900 };
type S = "noAddress" | "noSession" | "resolving" | "failed";
const wallet = (s: S) => ({
  address: s === "noAddress" ? null : LOGIN,
  isAuthenticated: s === "resolving" || s === "failed",
  agentWallet: null,
  agentWalletResolving: s === "resolving",
  agentWalletError: s === "failed" ? "session expired" : null,
  refreshAgentWallet: async () => null,
  ensureSession: async () => "t", sendFromAgent: async () => ({}), sendUsdcManual: async () => ({ txHash: "0x" }),
  activeKind: s === "noAddress" ? null : "modular", metamaskConnected: false,
}) as any;
const SEAL = /class="emerald[^"]*"[^>]*>Pay /;
const pay = (s: S) => renderToStaticMarkup(<PayOrderView order={order as any} wallet={wallet(s)} paying={false} result={null} payError="" mark={null} onPay={() => {}} />);
const send = (s: S) => renderToStaticMarkup(<SendPanel wallet={wallet(s)} />);

section("3 — PAY: four states, four copies; the order stays on screen in all of them");
{
  const a = pay("noAddress"), at = strip(a);
  check("no address → connect copy, points at Wallet", /Set up your wallet/i.test(at) && /Wallet/.test(at));
  check("…the order (what / how much) is still on screen", at.includes("Two coffees") && /0\.110000/.test(at));
  const b = pay("noSession"), bt = strip(b);
  check("⭐ address, no session → SIGN IN INLINE (a Sign in button, the buyer stays on the order)", /Sign in/.test(bt) && /<button[^>]*>Sign in/.test(b), bt.slice(0, 160));
  check("🚨 …and NOT the 'Set up your wallet first' send-away", !/Set up your wallet/i.test(bt));
  const c = pay("resolving"), ct = strip(c);
  check("⭐ address + session, resolving → 'Preparing your agent wallet' with a spinner", /Preparing your agent wallet/i.test(ct) && /class="spinner"/.test(c));
  check("⭐ …says plainly it needs NO funds to be created", /no funds|needs no funds|without funds|does not need funds/i.test(ct), ct.slice(0, 200));
  check("🚨 …and NOT 'Set up your wallet first'", !/Set up your wallet/i.test(ct));
  const d = pay("failed"), dt = strip(d);
  check("🚨 resolve FAILED → the REASON is shown", dt.includes("session expired"), dt.slice(0, 200));
  check("🚨 …says nothing was paid", /Nothing was paid/i.test(dt));
  check("🚨 …offers Retry", /<button[^>]*>Retry/.test(d) || /<button[^>]*>[^<]*Retry/.test(d));
  check("🚨 …and NOT 'Set up your wallet first' — the permanent dead end", !/Set up your wallet/i.test(dt));
  const copies = [at, bt, ct, dt].map((t) => t.replace(/Two coffees|0\.110000|Pay a checkout link|Someone made this link[^.]*\./g, ""));
  check("⭐ the four copies are pairwise DIFFERENT", new Set(copies).size === 4);
  check("🚨 NO state renders the seal while agentWallet is null", ![a, b, c, d].some((m) => SEAL.test(m)));
}

section("4 — SEND: the same four states (a payment link has the same buyer)");
{
  const a = strip(send("noAddress")), b = send("noSession"), c = strip(send("resolving")), d = send("failed");
  check("no address → connect copy, names the wallet page and the return", /Set up your wallet/i.test(a) && /come back here to send/i.test(a));
  check("⭐ address, no session → Sign in inline", /<button[^>]*>Sign in/.test(b) && !/Set up your wallet/i.test(strip(b)));
  check("⭐ resolving → Preparing your agent wallet, needs no funds", /Preparing your agent wallet/i.test(c) && /no funds|needs no funds|without funds/i.test(c));
  check("🚨 failed → reason + 'Nothing was sent' + Retry", strip(d).includes("session expired") && /Nothing was sent/i.test(strip(d)) && /<button[^>]*>[^<]*Retry/.test(d), strip(d).slice(0, 200));
  check("🚨 no Send seal in any of the four", ![send("noAddress"), b, send("resolving"), d].some((m) => /<button[^>]*class="emerald[^"]*"[^>]*>Send/.test(m)));
}

section("5 — SOURCE: the bare wallet links are gone; the hook records the failure; ConnectPasskey returns");
{
  const bare = /window\.location\.hash = "\/wallet"/;
  for (const f of ["components/PayPanel.tsx", "components/SendPanel.tsx", "components/BridgePanel.tsx", "components/SignInPrompt.tsx", "components/AgentWalletGate.tsx"]) {
    let s = ""; try { s = src(f); } catch { /* absent = fail below */ }
    check(`⛔ ${f}: no bare location.hash = "/wallet" (uses goToWalletAndReturn)`, s.length > 0 && !bare.test(s) && (f === "components/BridgePanel.tsx" || f === "components/SignInPrompt.tsx" || /goToWalletAndReturn|AgentWalletGate/.test(s)));
  }
  // ⭐ THE WHOLE CALLER SET, not the four the defect was found on: a guard that covers four of ten
  // sites teaches the next reader it is optional. Walk every file under src/. [[guard-belongs-on-the-caller-set]]
  {
    const { readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = new URL("../src", import.meta.url).pathname;
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|jsx?)$/.test(n) ? [p] : []; });
    const offenders = walk(root).filter((p) => !p.endsWith("/lib/returnTo.ts") && /location\.hash\s*=\s*["'`]\/?wallet["'`]/.test(readFileSync(p, "utf8"))).map((p) => p.slice(root.length + 1));
    check("🚨 ZERO bare `location.hash = \"/wallet\"` anywhere in src/ (only returnTo.ts may set it)", offenders.length === 0, offenders.join(", ") || "none");
  }
  const hook = src("wallet/useWallet.ts");
  check("🚨 useWallet exposes agentWalletError and agentWalletResolving", /agentWalletError,/.test(hook) && /agentWalletResolving,/.test(hook));
  check("🚨 …and the resolve goes through resolveAgentWallet (no swallowed .catch on the result)", /resolveAgentWallet\(/.test(hook));
  const cp = src("components/ConnectPasskey.tsx");
  check("⭐ ConnectPasskey calls returnAfterConnect (in an effect keyed on the ready state)", /returnAfterConnect\(/.test(cp) && /useEffect/.test(cp));
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0\n`);
