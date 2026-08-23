// describeError.ts — WHAT DO WE ACTUALLY KNOW WENT WRONG?
//
// ═══ 🚨 THE DEFECT THIS REPLACES, AND WHAT IT COST ═══════════════════════════════════════════
// Every error slot in the app read `e?.message || "Send failed"` (or "Swap failed", "Bridge
// failed", …). On 2026-08-23 a Send produced a thrown value with NO message, and the UI rendered
//
//     Send failed
//
// which reads as a plain statement that THE SERVER REJECTED THE SEND. It had not. There was no
// server response at all — `agent-send` was never invoked, and neither was any other function on
// the site. An hour went into proving that, against a sentence asserting the opposite.
//
// ⭐ THE RULE, and it is the same one as the `?? "action"` fix in the activity trail:
//
//     RAW LOOKS LIKE A GAP. A PLAUSIBLE LABEL LOOKS LIKE A FACT. THE SECOND IS WORSE.
//
// A failure message must never narrate a server response that was never received. When the thrown
// value carries no message we do not know whether the request reached the server, so the honest
// rendering says so and names the raw thing instead of inventing a verdict.
//
// ⚠️ THIS IS ON THE MONEY PATH. "Send failed" and "we could not tell whether your send left the
// browser" are different facts, and a user deciding whether to press Send again needs the second.
//
// ═══ ⭐ BEHAVIOURALLY INVISIBLE WHEN A MESSAGE EXISTS ════════════════════════════════════════
// A real message is the best thing available and is passed through byte-identical. This function
// changes what the user sees ONLY in the case that was previously a fabrication — which is why it
// could be applied to twenty call sites at once without re-litigating twenty pieces of copy.

// ═══ ⭐ THE OTHER HALF LIVES IN httpError.ts, AND THEY ARE NOT THE SAME PROBLEM ══════════════
// `errorWithPayload(data, fallback)` handles a RESPONSE that arrived and was not ok — there, the
// server demonstrably answered, so a fallback sentence is a weaker claim. `describeError` handles
// a THROWN VALUE, where the request may never have left the browser. Kept apart on purpose: the
// two differ precisely in whether a server was reached, which is the fact at issue.

/** The name of a thrown value, for a reader who now has nothing else to go on. */
function rawName(e: unknown): string {
  if (e === null) return "null";
  if (e === undefined) return "undefined";
  const n = (e as { name?: unknown })?.name;
  if (typeof n === "string" && n.trim()) return n.trim();
  // Not an Error at all — `throw "boom"`, `throw {}`, a rejected promise with a plain value.
  return typeof e;
}

/**
 * Turn any thrown value into something a human can act on WITHOUT asserting anything we cannot
 * observe from the browser.
 *
 * ⚠️ Deliberately does NOT take a "friendly fallback" parameter. Accepting one would reintroduce
 * exactly the defect: every caller would pass its old sentence and the plausible label would be
 * back. The surrounding panel already says which action this is; what it cannot say is what we
 * failed to learn.
 */
export function describeError(e: unknown): string {
  const m = (e as { message?: unknown })?.message;
  if (typeof m === "string" && m.trim()) return m.trim();
  return `⚠️ unknown error (${rawName(e)}) — no reason was reported, so we cannot tell whether this reached the server`;
}
