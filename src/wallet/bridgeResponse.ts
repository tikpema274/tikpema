// bridgeResponse.ts — HOW THE CLIENT READS AN /api/agent-bridge RESPONSE.
//
// ═══ 🚨 THE DEFECT THIS EXISTS TO REMOVE ══════════════════════════════════════════════════════
// This logic lived inline in useWallet as two `if`s:
//
//     if (data?.executed === false && data?.feeDisclosure?.ackToken) return data;
//     if (data?.executed === false) throw new Error(data?.blocked || "Bridge did not execute");
//
// `executed: false` carries FOUR meanings — the quote failed, the quote SUCCEEDED, an
// acknowledgment is required, a guard refused — and those two lines knew about two. A successful
// quote fell through to the throw, so pressing "Get quote" produced "Bridge did not execute": the
// EXECUTE path's error, on a button that is not supposed to execute, for a request that worked.
//
// ⭐⭐ SO THE FIX IS NOT A THIRD `if`. A third `if` restores the same trap one meaning later: the
// FIFTH shape would again fall through to a throw that asserts something specific and false. The
// server now sends an explicit `outcome`, and this switches on it with a default that says it does
// not recognise the response — an unknown shape fails LOUDLY and namelessly-honestly rather than
// claiming a burn did not happen. [[absence-must-never-read-as-safe]]
//
// ⚠️ AND THE MESSAGES NAME THE FAILURE THAT OCCURRED. A failed quote says the quote failed; a
// refused burn says it was refused. "Bridge did not execute" is gone: it reported the absence of an
// action the caller may never have requested, which is information about nothing.

export type BridgeOutcome =
  | { kind: "quoted"; data: any }
  | { kind: "needs_ack"; data: any }
  | { kind: "executed"; data: any };

/** Interpret the response, or throw an Error whose message names what actually failed.
 *  ⛔ Never returns a bare `data` for an outcome it does not know. */
export function interpretBridgeResponse(data: any): BridgeOutcome {
  switch (data?.outcome) {
    case "quoted":
      return { kind: "quoted", data };
    case "needs_ack":
      return { kind: "needs_ack", data };
    case "executed":
    case "pending":
      return { kind: "executed", data };
    case "quote_failed":
      // ⭐ The quote failed, and says so. This is the state that used to read "Bridge did not
      // execute" — true, irrelevant, and not what the caller asked about.
      throw new Error(data?.blocked || "Could not price this bridge — no quote was produced.");
    case "blocked":
      throw new Error(data?.blocked || "The bridge was refused by a guard, which gave no reason.");
    default:
      // 🚨 THE DEFAULT IS THE POINT. A shape this client has never seen must not be described as a
      // burn that did not happen — it must be described as unrecognised, with the value that made
      // it so, because that is the only true statement available.
      throw new Error(
        `Unrecognised response from the bridge (outcome=${JSON.stringify(data?.outcome)}). ` +
        `The server returned something this app does not know how to read; nothing was assumed about it.`
      );
  }
}
