// readJson — parse a fetch Response as JSON, or FAIL LOUDLY.
//
// ═══ 🚨 THE AMPLIFIER THIS REMOVES ═══════════════════════════════════════════════════════════
// Seventeen call sites did `await r.json().catch(() => ({}))`. That converts "I got something
// UNPARSEABLE" into "I got NOTHING" — two different facts collapsed onto one value, and the
// resulting `{}` then flows on as a successful result.
//
// ⭐ WHY IT MATTERS HERE SPECIFICALLY (measured 2026-08-12): an unmatched `/api/*` **GET** is
// served by the SPA catch-all as **200 with an HTML page**. So:
//     r.ok            → TRUE   (it is a 200)
//     r.json()        → throws (it is HTML)
//     .catch(=> ({})) → {}     ← the throw is erased
//     if (!r.ok) throw … never fires, and `{}` is returned AS A SUCCESSFUL MONEY RESULT.
// A POST gets 404 instead, because the SPA rule skips POST — so the failure mode DIFFERS BY METHOD
// and the quiet one is the GET.
//
// ⭐⭐ THE ROUTING IS THE SOURCE; THIS IS THE CONTAINMENT. The real fix is a rule that 404s
// unmatched `/api/*` instead of serving the SPA — it removes the 200-HTML response at its origin
// and covers paths nobody has typed yet. It is DEFERRED because it changes routing for EVERY path
// and deserves its own proof. This helper needs no routing change and no per-path proof: it closes
// every call site at once by refusing to turn an unreadable answer into an empty one.
//
// ⚠️ WHAT CHANGES: a non-JSON body now THROWS instead of yielding {} or null. Any caller that
// depended on the old value for a 200-HTML response was depending on a bug. Genuine JSON error
// responses are unaffected — they parse, and the caller's existing `if (!res.ok)` handling runs.
//
// ═══ 🚨 THE HOLE THIS DOES **NOT** COVER — do not read it as blanket containment ══════════════
// This catches an UNPARSEABLE body. It cannot catch a SEMANTICALLY WRONG 2xx from the function
// itself, because that body is valid JSON. A `202 {status:"provisioning"}` passes `res.ok` AND
// passes this helper — so "nothing happened" still reaches the caller as a successful result.
//
// ⚠️ FIVE MONEY PATHS STILL DO THIS: agent-ub-spend, agent-execute-plan, dca-create,
// agent-vault-deposit, agent-vault-withdraw. The fix for them is the STATUS CODE (503, as on the
// eight already converted) — not this helper, which is the wrong layer for it. Recorded as its own
// open gap rather than filed under "contained by readJson".

/** An empty body is a legitimate answer (204, or a 4xx with no payload) — not an unreadable one. */
const EMPTY = Object.freeze({});

export async function readJson<T = any>(res: Response): Promise<T> {
  const text = await res.text();

  if (text.trim() === "") return EMPTY as T;

  try {
    const parsed = JSON.parse(text);
    // ⚠️ `null` and bare scalars parse fine but are not the object shape every caller assumes.
    // Returning them would reintroduce "something unreadable became something falsy".
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(`expected a JSON object, got ${parsed === null ? "null" : typeof parsed}`);
    }
    return parsed as T;
  } catch (e) {
    // ⭐ NAME THE LIKELY CAUSE. An HTML body from an /api path means the request never reached a
    // function — almost always a wrong or missing route, not a server fault. Saying so turns a
    // baffling "Unexpected token <" into an actionable message.
    const html = /^\s*(<!doctype|<html)/i.test(text);
    const serverFault = res.status >= 500;
    const where = `${res.status} ${res.url || ""}`.trim();
    // ⭐⭐ HTML ALONE DOES NOT MEAN "WRONG ADDRESS" — THE STATUS DECIDES WHICH.
    // A 2xx/4xx HTML body is the SPA catch-all: the request never reached a function, so the
    // address is the likely fault. A 5xx HTML body is the opposite — it DID reach the server and
    // the server failed. Blaming the address there sends the reader to check a URL that is fine,
    // which is exactly the mis-attribution this repo keeps paying for.
    // ⚠️ FOUND while wrapping ensureOwnerWallet's throw: an unhandled handler throw is precisely a
    // 5xx, and this helper would have called it a bad address.
    throw new Error(
      serverFault
        ? `The server hit an error and could not complete this (${where}). Nothing was started — ` +
          `this is usually temporary, so it is safe to try again shortly.`
        : html
          ? `The request did not reach the server (${where}). It returned a web page instead of data, ` +
            `which usually means the address is wrong. Nothing was sent or changed.`
          : `The server's reply could not be read (${where}): ${String((e as Error).message).slice(0, 120)}`
    );
  }
}
