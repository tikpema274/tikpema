// verify-session-refusal.tsx — a REFUSED sign-in reaches the screen, in the server's own words.
//
//   npx tsx scripts/verify-session-refusal.tsx      (npm run test:sessionrefusal)
//
// ═══ THE DEFECT (2026-09-30) ═════════════════════════════════════════════════════════════════════
// After "Create wallet", useWallet's login-time effect runs ensureSession() and SWALLOWED its error
// (`.catch(() => {})`). A 401 from auth-verify — e.g. the proper auth fix (41f1af7) refusing
// "that address does not belong to this passkey — nothing was registered" — never reached the user:
// ConnectPasskey kept showing "Preparing your wallet…" with a "Tap to finish setup" link that
// swallowed the same error. A fix that refuses SILENTLY is not much better than one that accepts
// silently. [[absence-must-never-read-as-safe]]
//
// ═══ THE PROPERTIES ══════════════════════════════════════════════════════════════════════════════
//   1. SOURCE: ensureSession RECORDS its failure (sessionError = the thrown message, which is the
//      server's `error` verbatim) for EVERY caller, clears it on success and on clearSession, and
//      useWallet exports it.
//   2. RENDERED: connected + no session + sessionError → the server's message verbatim, a Try again
//      wired to ensureSession, and NO "Preparing your wallet…" spinner (that would be false).
//   3. RENDERED: without a sessionError the waiting state is unchanged.
//   4. ⭐ A CANCELLED PROMPT IS NOT A REFUSAL (T, 2026-09-30). webauthn-p256's sign() wraps EVERY
//      credentials.get failure as Error("credential request failed.", { cause }) — so Escape rendered
//      "Sign-in was refused. credential request failed.": a failure, when the user changed their mind.
//      classifySessionError() → "refused" (the SERVER said no: its words), "cancelled" (the prompt ended
//      with no signature: NotAllowedError / AbortError — the browser cannot tell a dismissal from a
//      timeout, so neither is called a failure), "failed" (anything else: its message, not "refused").
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

const g = globalThis as any;
const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); } }; };
g.window = g; g.sessionStorage = mem(); g.localStorage = mem(); g.location = { hash: "#/wallet" };

const { default: ConnectPasskey } = await import("../src/components/ConnectPasskey");

const REFUSAL = "that address does not belong to this passkey — nothing was registered";
const REFUSED = { kind: "refused", message: REFUSAL };
const wallet = (over: Record<string, unknown> = {}) => ({
  address: "0x1111111111111111111111111111111111111111", activeKind: "modular", agentWallet: null, usdcBalance: null,
  busy: false, status: "", loginError: null, isAuthenticated: false, sessionError: null,
  hasStoredCredential: () => true, connectors: [], connectLogin: async () => {}, connectRegister: async () => {},
  connectMetaMask: async () => {}, ensureSession: async () => "", startOver: () => {}, logout: () => {},
  ...over,
});
const render = (over: Record<string, unknown>) => strip(renderToStaticMarkup(<ConnectPasskey wallet={wallet(over) as any} />));

section("1 — SOURCE: ensureSession records its failure for every caller");
{
  const s = src("wallet/useWallet.ts");
  check("⭐ useWallet holds a sessionError state (classified)", /\[sessionError, setSessionError\]\s*=\s*useState<SessionError \| null>\(null\)/.test(s));
  const body = s.slice(s.indexOf("const ensureSession = useCallback"), s.indexOf("}, [authContext, session, persistSession"));
  check("⭐⭐ ensureSession sets sessionError from the CLASSIFIED thrown error", /setSessionError\(\s*classifySessionError\(\s*e\s*\)\s*\)/.test(body), body.length ? "" : "ensureSession not found");
  check("⭐ a 4xx from auth-challenge AND auth-verify is thrown MARKED as the server's refusal", /serverRefusal: chRes\.status < 500/.test(body) && /serverRefusal: vRes\.status < 500/.test(body));
  check("…a 5xx is NOT a refusal (a server fault → 'didn't complete')", !/serverRefusal: true/.test(body));
  check("⭐ …and clears it once a session is issued", /persistSession\(\{[^}]*\}[^;]*\);\s*[\s\S]{0,120}setSessionError\(null\)/.test(body) || /setSessionError\(null\);\s*[\s\S]{0,80}persistSession\(\{/.test(body));
  const clear = s.slice(s.indexOf("const clearSession = useCallback"), s.indexOf("const clearSession = useCallback") + 900);
  check("a cleared session (a new connect) clears the refusal", /setSessionError\(null\)/.test(clear));
  check("⭐ useWallet EXPORTS sessionError", /\n\s+sessionError,\n/.test(s));
}

section("2 — RENDERED: a refused sign-in shows the server's own message");
{
  const t = render({ sessionError: REFUSED });
  check("⭐⭐ the server's message appears VERBATIM", t.includes(REFUSAL), t.slice(0, 200));
  check("⭐⭐ NO 'Preparing your wallet…' (the wallet is not being prepared — it was refused)", !/Preparing your wallet/.test(t), t.slice(0, 200));
  check("⭐ says the sign-in was refused, in plain words", /sign-in was refused|couldn.t sign you in|could not sign you in/i.test(t), t.slice(0, 200));
  check("⭐ offers Try again", /Try again/.test(t));
  const html = renderToStaticMarkup(<ConnectPasskey wallet={wallet({ sessionError: REFUSED }) as any} />);
  check("the message is not hidden in an attribute / title only", html.includes(REFUSAL.replace(/—/g, "—")) && !/title="[^"]*nothing was registered/.test(html));
}

section("3 — RENDERED: nothing refused → the waiting state is unchanged");
{
  const t = render({});
  check("no sessionError → 'Preparing your wallet…' as before", /Preparing your wallet/.test(t));
  check("…with 'Tap to finish setup' while unauthenticated", /Tap to finish setup/.test(t));
  const t2 = render({ sessionError: REFUSED, isAuthenticated: true });
  check("a stale sessionError with a LIVE session → not shown (the session is what counts)", !t2.includes(REFUSAL) && /Preparing your wallet/.test(t2));
  const t3 = render({ sessionError: REFUSED, loginError: "Couldn't log in with your saved passkey" });
  check("a loginError keeps its own branch (unchanged)", /Couldn't log in with your saved passkey/.test(t3));
}

section("4 — ⭐ a CANCELLED prompt is not a refusal");
{
  const { classifySessionError } = await import("../src/wallet/sessionError");
  // exactly what webauthn-p256's sign() throws on Escape (Chrome's DOMException text)
  const escape = new Error("credential request failed.", { cause: new DOMException("The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.", "NotAllowedError") });
  const c = classifySessionError(escape);
  check("⭐⭐ Escape (NotAllowedError under 'credential request failed.') → cancelled", c.kind === "cancelled", JSON.stringify(c));
  check("an AbortError → cancelled", classifySessionError(new Error("credential request failed.", { cause: new DOMException("aborted", "AbortError") })).kind === "cancelled");
  check("a bare NotAllowedError (no wrapper) → cancelled", classifySessionError(new DOMException("x", "NotAllowedError")).kind === "cancelled");
  const srv = classifySessionError(Object.assign(new Error(REFUSAL), { serverRefusal: true, status: 401 }));
  check("⭐⭐ a server refusal → refused, its message VERBATIM", srv.kind === "refused" && srv.message === REFUSAL, JSON.stringify(srv));
  check("a 5xx (serverRefusal:false) → failed, its message kept", classifySessionError(Object.assign(new Error("SESSION_SECRET not configured"), { serverRefusal: false, status: 500 })).kind === "failed");
  const net = classifySessionError(new TypeError("Failed to fetch"));
  check("⭐ a network failure → failed (not refused, not cancelled), its message kept", net.kind === "failed" && net.message === "Failed to fetch", JSON.stringify(net));
  const other = classifySessionError(new Error("credential request failed.", { cause: new DOMException("bad rp", "SecurityError") }));
  check("⭐ another credential error (SecurityError) → failed, naming the browser's reason — not 'credential request failed.' alone", other.kind === "failed" && /bad rp/.test(other.message), JSON.stringify(other));
  check("a non-Error throw → failed, stringified", classifySessionError("boom").kind === "failed");

  const t = render({ sessionError: c });
  check("⭐⭐ RENDERED cancelled: says CANCELLED, never 'refused'", /cancel/i.test(t) && !/refused/i.test(t), t.slice(0, 220));
  check("⭐ …says nothing was signed or changed", /nothing was (signed|changed)/i.test(t), t.slice(0, 220));
  check("⭐ …does NOT show 'credential request failed.' or the browser's exception text", !/credential request failed|timed out or was not allowed/i.test(t), t.slice(0, 220));
  check("⭐ …offers to sign in again", /Sign in again|Try again/.test(t));
  const html = renderToStaticMarkup(<ConnectPasskey wallet={wallet({ sessionError: c }) as any} />);
  check("⭐ …not in the warning colour (a choice, not an error)", !/var\(--warn\)/.test(html));
  const tf = render({ sessionError: net });
  check("RENDERED failed: says it did not complete, with the reason — not 'refused'", /didn.t complete|did not complete/i.test(tf) && tf.includes("Failed to fetch") && !/refused/i.test(tf), tf.slice(0, 220));
  const tr = render({ sessionError: REFUSED });
  check("RENDERED refused: unchanged — 'Sign-in was refused.' + the server's words", /Sign-in was refused/.test(tr) && tr.includes(REFUSAL));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-session-refusal — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
