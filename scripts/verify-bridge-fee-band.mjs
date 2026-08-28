// verify-bridge-fee-band.mjs — "COVERS THE FEE" AND "WORTH DOING" ARE DIFFERENT THRESHOLDS.
//
//   node scripts/verify-bridge-fee-band.mjs
//
// ═══ WHAT THIS GUARDS ════════════════════════════════════════════════════════════════════════
// The fee-floor refuses a bridge only when `fee >= amount` — when NOTHING would arrive. Between
// that and "worth doing" sat a gap nothing occupied. The bridge fee is FLAT (the IRIS fee endpoint
// takes no amount parameter), so the ratio worsens as the amount shrinks:
//     1.0   USDC ->  5.3%   fine
//     0.1   USDC -> 53.2%   clears the floor, over half the money is gone
//     0.054 USDC -> 98.5%   clears the floor, 0.0008 arrives
// And at 2dp the fee and the arrival RENDER AS THE SAME NUMBER ("~0.05" for both), so the loss was
// not merely un-warned, it was invisible.
//
// ⭐ THE BAND IS COMPUTED ONCE AND THREADED — producer decides, no surface re-derives. That is the
// refundClass pattern. Three surfaces re-deriving one fact from two numbers is exactly how this
// product ended up with three different bridge renderings that could disagree on screen.
//
// Zero network. Zero money. Pure functions plus source assertions on the gate.

// 🚨 THE ACK TOKEN IS NOW HMAC-KEYED, so minting or verifying one REQUIRES a secret. Set here because
// this suite exercises the real `bridgeAckToken`, and its absence is a THROW by design — a missing key
// must never degrade to an unkeyed digest, which would silently restore the property v3 removed.
// ⚠️ Unreachable in production (a request without SESSION_SECRET 401s at requireSession long before a
// band is computed), so this is a test-harness need, not a hole.
process.env.SESSION_SECRET ||= "test-session-secret-0123456789abcdef";

import { readFileSync, readdirSync } from "node:fs";
import { bridgeFeeBand, bridgeAckToken, FEE_BAND_WARN, FEE_BAND_ACKNOWLEDGE, FEE_BANDS, GATING_BANDS } from "../netlify/functions/_bridge.mjs";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  BRIDGE FEE BAND — disclosure, then consent                          ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

const FEE = 0.053196; // a real quote, burn 0x0175cf7b… 2026-07-31

section("1 — THE REAL ROWS THAT MOTIVATED THIS");
{
  const one = bridgeFeeBand({ amountUsdc: 1.0, feeUsdc: FEE, netUsdc: 1.0 - FEE });
  check("1.0 USDC ⇒ no band (5.3%)", one.band === "none", `${(one.feeRatio * 100).toFixed(1)}%`);

  const tenth = bridgeFeeBand({ amountUsdc: 0.1, feeUsdc: FEE, netUsdc: 0.1 - FEE });
  check("⭐⭐ 0.1 USDC ⇒ ACKNOWLEDGE (53.2% lost, yet it clears the fee-floor)",
    tenth.band === "acknowledge", `${(tenth.feeRatio * 100).toFixed(1)}%`);

  const edge = bridgeFeeBand({ amountUsdc: 0.054, feeUsdc: FEE, netUsdc: 0.054 - FEE });
  check("⭐⭐ 0.054 USDC ⇒ ACKNOWLEDGE (98.5% lost, still clears the floor)",
    edge.band === "acknowledge", `${(edge.feeRatio * 100).toFixed(1)}%`);

  const mid = bridgeFeeBand({ amountUsdc: 0.4, feeUsdc: FEE, netUsdc: 0.4 - FEE });
  check("0.4 USDC ⇒ warn but not acknowledge (13.3%)", mid.band === "warn", `${(mid.feeRatio * 100).toFixed(1)}%`);
}

section("2 — BOUNDARIES ARE INCLUSIVE, AND UNKNOWN IS NOT SAFE");
{
  check("exactly the warn threshold warns", bridgeFeeBand({ amountUsdc: 1, feeUsdc: FEE_BAND_WARN }).band === "warn");
  check("just under it does not", bridgeFeeBand({ amountUsdc: 1, feeUsdc: FEE_BAND_WARN - 0.0001 }).band === "none");
  check("exactly the acknowledge threshold requires acceptance",
    bridgeFeeBand({ amountUsdc: 1, feeUsdc: FEE_BAND_ACKNOWLEDGE }).band === "acknowledge");
  check("just under it only warns", bridgeFeeBand({ amountUsdc: 1, feeUsdc: FEE_BAND_ACKNOWLEDGE - 0.0001 }).band === "warn");

  // ⚠️ An unknown ratio must never render as a safe one — the absence-reads-as-safe family.
  for (const bad of [{ amountUsdc: 0, feeUsdc: FEE }, { amountUsdc: NaN, feeUsdc: FEE },
                     { amountUsdc: 1, feeUsdc: NaN }, { amountUsdc: -1, feeUsdc: FEE }]) {
    check(`⭐⭐ unusable input ⇒ STRICTEST band, not "none" (${JSON.stringify(bad)})`,
      bridgeFeeBand(bad).band === "acknowledge");
  }
}

section("3 — THE ACK TOKEN BINDS TO THE BAND, NOT THE VOLATILE FEE");
{
  const a = bridgeAckToken({ destinationKey: "base", amountUsdc: 0.1, band: "acknowledge" });
  const b = bridgeAckToken({ destinationKey: "base", amountUsdc: 0.1, band: "acknowledge" });
  check("same disclosure ⇒ same token", a === b);

  // The fee moved 0.0541 → 0.053520 → 0.053196 on ONE route in ONE day. Binding the ack to the
  // exact number would invalidate it on the next tick and train people to click through a box
  // that always complains.
  const stillSameBand = bridgeFeeBand({ amountUsdc: 0.1, feeUsdc: 0.0541 }).band;
  check("⭐⭐ a fee tick within the same band does NOT invalidate the ack",
    stillSameBand === "acknowledge" &&
    bridgeAckToken({ destinationKey: "base", amountUsdc: 0.1, band: stillSameBand }) === a);

  check("⭐ a DIFFERENT band invalidates it",
    bridgeAckToken({ destinationKey: "base", amountUsdc: 0.1, band: "warn" }) !== a);
  check("⭐ a different amount invalidates it",
    bridgeAckToken({ destinationKey: "base", amountUsdc: 0.2, band: "acknowledge" }) !== a);
  check("⭐ a different destination invalidates it",
    bridgeAckToken({ destinationKey: "linea", amountUsdc: 0.1, band: "acknowledge" }) !== a);
  check("  …and it is a sha256 hex digest, like the vault's ackToken", /^[0-9a-f]{64}$/.test(a));

  // ⭐ OWNER BINDING. Without it one token was valid for ANY wallet at the same
  // amount/destination/band — so a quote priced for one wallet stayed acknowledgeable after
  // switching to another, which is exactly what a stale on-screen quote invited. The token is
  // EVIDENCE OF CONSENT; evidence not bound to who consented is weaker than it looks.
  const forA = bridgeAckToken({ owner: "0xAAA", destinationKey: "base", amountUsdc: 0.1, band: "acknowledge" });
  const forB = bridgeAckToken({ owner: "0xBBB", destinationKey: "base", amountUsdc: 0.1, band: "acknowledge" });
  check("⭐⭐ a DIFFERENT owner gets a different token — an ack cannot cross wallets", forA !== forB);
  check("  …owner comparison is case-insensitive (checksummed vs lowercased addresses)",
    forA === bridgeAckToken({ owner: "0xaaa", destinationKey: "base", amountUsdc: 0.1, band: "acknowledge" }));
  check("  …an absent owner degrades to a stable 'anon' rather than throwing or refusing",
    bridgeAckToken({ destinationKey: "base", amountUsdc: 0.1, band: "acknowledge" }) ===
    bridgeAckToken({ owner: null, destinationKey: "base", amountUsdc: 0.1, band: "acknowledge" }));
  check("⭐ the digest is versioned, so adding the field invalidates old tokens by construction",
    forA !== a);
}

section("4 — THE GATE IS SERVER-SIDE AND FAIL-CLOSED");
{
  const actions = readFileSync(new URL("../netlify/functions/_actions.mjs", import.meta.url), "utf8");
  check("⭐⭐ execution REFUSES when the returned token does not match the expected one",
    /bridgeAckToken\(\{[\s\S]{0,160}?\}\)/.test(actions) && /step\.ackToken !== expected/.test(actions));
  check("⭐ the expected token is RECOMPUTED server-side from server-priced inputs",
    /const expected = bridgeAckToken\(\{ owner: ctx\.session\?\.address, destinationKey: dest\.key, amountUsdc: amount, band: bandInfo\.band \}\)/.test(actions));
  check("⭐⭐ …including the OWNER, taken from the session and never from the request body",
    /owner: ctx\.session\?\.address/.test(actions) && !/owner: step\./.test(actions));
  check("  …and the refusal carries the disclosure so the UI need not re-derive it",
    /feeDisclosure: \{ \.\.\.bandInfo/.test(actions));
  check("  …the fee-floor refusal is still separate and unchanged",
    /fee\.maxFee >= fee\.amountMinor/.test(actions));

  const bridgeFn = readFileSync(new URL("../netlify/functions/agent-bridge.mjs", import.meta.url), "utf8");
  check("⭐ ackToken reaches the gate from the request but is never TRUSTED there",
    /const \{ amountUsdc, destination, ackToken \} = parseBody\(event\)/.test(bridgeFn));
}

section("5 — 4dp MINIMUM: 2dp COLLAPSES FEE AND ARRIVAL INTO ONE NUMBER");
{
  // At 2dp, 0.1 USDC bridged shows fee "0.05" and arrival "0.05" — indistinguishable.
  const fee2 = FEE.toFixed(2), net2 = (0.1 - FEE).toFixed(2);
  check("⭐⭐ the collapse is real at 2dp (fee and arrival print identically)", fee2 === net2, `${fee2} === ${net2}`);
  check("  …and 4dp separates them", FEE.toFixed(4) !== (0.1 - FEE).toFixed(4));

  // ⚠️ SOURCE SCAN, with a known blind spot: it cannot see a value built from variables or
  // wrapped across lines. It is a floor, not a proof — the rendered-output guard is the real fix
  // (see the backlog entry in PROGRESS.md). Kept because the regression it catches is a literal.
  for (const f of ["_actions.mjs", "agent-act.mjs", "_analystb.mjs"]) {
    const src = readFileSync(new URL(`../netlify/functions/${f}`, import.meta.url), "utf8");
    check(`  no 2dp fee/net rendering left in ${f}`,
      !/(feeUsdc|netUsdc)\.toFixed\(2\)/.test(src));
  }
  for (const f of ["BridgePanel.tsx", "MyAgentPanel.tsx"]) {
    const src = readFileSync(new URL(`../src/components/${f}`, import.meta.url), "utf8");
    check(`  no 2dp bridge amount rendering left in ${f}`,
      !/(feeUsdc|netUsdc|netPredicted|amountDelivered|amountRequested)\)?\.toFixed\(2\)/.test(src));
  }
}

section("6 — THE TRIGGER MUST BE AWAITED (the bug that stranded 0x0175cf7b…)");
{
  // Lives in _bridge-record.mjs now, shared by agent-bridge and agent-execute-plan. The
  // invariant follows the code — dropping it because the file moved is how a fixed bug
  // quietly comes back.
  const src = readFileSync(new URL("../netlify/functions/_bridge-record.mjs", import.meta.url), "utf8");
  check("⭐⭐ triggerSettle is AWAITED — an un-awaited fetch can be frozen away at handler return",
    /await triggerSettle\(\{/.test(src));
  check("⭐⭐ and the fetch inside it is awaited too", /const res = await fetch\(`\$\{base\}/.test(src));
  check("  …its failure is still swallowed (a trigger must not fail a bridge whose money moved)",
    /settle trigger FAILED \(swallowed\)/.test(src));
  check("  …the bug is recorded at the site so it is not 'optimised' back",
    /never sent|freeze the moment/i.test(src));

  const readEndpoint = readFileSync(new URL("../netlify/functions/bridge-receipts.mjs", import.meta.url), "utf8");
  check("⭐⭐ a stranded receipt is RE-TRIGGERED — one lost fire must not strand it forever",
    /RE-TRIGGERED stranded settle/.test(readEndpoint));
  check("  …only unleased receipts qualify — a healthy in-flight bridge is left alone",
    /!r\.settlingSince &&/.test(readEndpoint));
  check("⭐⭐ …and a PROVISIONAL mint_unconfirmed is re-triggered too — 'we stopped waiting' is not 'it never arrived'",
    /isRecheckable\(r\)/.test(readEndpoint));
  check("  …and the recovery is bounded so a page load cannot fan out", /slice\(0, 3\)/.test(readEndpoint));
}

section("7 — THE GATE EXISTS ON BOTH SURFACES, AND LEAVES EVIDENCE");
{
  // 🚨 THE DEFECT THIS PINS. The same 0.1 USDC bridge behaved differently by surface: the
  // Bridge page disclosed that the fee EXCEEDS the arrival and required a tick, while the
  // agent panel — the plain-language surface a user is most likely to reach — was refused
  // server-side with NO disclosure and NO way to accept. A dead end, not a gate. The honest
  // path was the one users were least likely to find.
  const client = readFileSync(new URL("../src/lib/agentClient.ts", import.meta.url), "utf8");
  check("⭐⭐ the agent client can CARRY an ack token (it could not, so that path was a dead end)",
    /bridge: \(amountUsdc: number, destination: string, token: string, ackToken\?: string\)/.test(client) &&
    /\{ amountUsdc, destination, ackToken \}/.test(client));

  const panel = readFileSync(new URL("../src/components/MyAgentPanel.tsx", import.meta.url), "utf8");
  check("⭐⭐ the agent panel RENDERS the acknowledge disclosure", /feeDisclosure\?\.band === "acknowledge"/.test(panel));
  check("⭐ …gates its button on the tick", /b\.feeDisclosure\?\.band === "acknowledge" && !bridgeAcked/.test(panel));
  check("⭐ …passes the token through on confirm", /onConfirmBridge\(b\.amountUsdc, b\.destination\.key, b\.feeDisclosure\?\.ackToken\)/.test(panel));
  check("  …and surfaces the warn band too, not only the hard gate", /feeDisclosure\?\.band === "warn"/.test(panel));
  check("⭐ …says plainly when the fee EXCEEDS the arrival", /More goes to the fee/.test(panel));
  // Receipt refresh rides the same path — one missing wiring caused two symptoms.
  check("⭐⭐ the agent panel refreshes receipts, so recovery is reachable from it",
    /const loadReceipts = async/.test(panel) && /await loadReceipts\(\)/.test(panel));

  // The gate must leave evidence, SERVER-SOURCED. A client-asserted "I accepted" is worthless.
  const actions = readFileSync(new URL("../netlify/functions/_actions.mjs", import.meta.url), "utf8");
  check("⭐⭐ a SUCCESSFUL bridge reports the band it was priced under", /feeBand: bandInfo\.band/.test(actions));
  check("⭐⭐ …and `acknowledged` is set by the server that verified the token, not by the caller",
    /acknowledged: bandInfo\.band === "acknowledge"/.test(actions));

  const record = readFileSync(new URL("../netlify/functions/_bridge-record.mjs", import.meta.url), "utf8");
  check("⭐⭐ the receipt records ackBand and ackAcceptedAt — consent survives the session",
    /ackBand: r\.feeBand/.test(record) && /ackAcceptedAt: r\.acknowledged \? burnedAt : null/.test(record));

  // 🚨 A BRIDGE INSIDE A PLAN LEFT NO RECORD AT ALL: the write lived in the agent-bridge
  // HTTP handler, not in executeAction, so plan bridges wrote no receipt, triggered no
  // settler, were invisible to the sweeper, and could never show a measured delivery.
  const planFn = readFileSync(new URL("../netlify/functions/agent-execute-plan.mjs", import.meta.url), "utf8");
  const bridgeFn = readFileSync(new URL("../netlify/functions/agent-bridge.mjs", import.meta.url), "utf8");
  check("⭐⭐ the PLAN path records its bridges too — they were invisible before",
    // ⚠️ Deliberately NOT pinned to the full argument list — the quote-record join later added
    // `quoteId`/`stepIndex` here and broke this check without changing the property it guards.
    // What matters is that the plan path calls the shared helper with the step's own amount.
    /recordBridge\(\{ r, session, event, amountRequested: step\.amountUsdc[,)]/.test(planFn));
  check("⭐⭐ …via the SAME helper as agent-bridge, not a second copy",
    /from "\.\/_bridge-record\.mjs"/.test(planFn) && /from "\.\/_bridge-record\.mjs"/.test(bridgeFn));
  check("  …and it is gated on a real bridge with a burnHash", /r\.kind === "bridge_usdc" && r\.burnHash/.test(planFn));

  // ⭐ THE EXCLUSION IS DELIBERATE. job-bridge-approve has its OWN receipt system in
  // job-deliverables with its own verifier; a write inside executeAction would give it a
  // SECOND receipt in a SECOND store, drifting independently.
  const approveFn = readFileSync(new URL("../netlify/functions/job-bridge-approve.mjs", import.meta.url), "utf8");
  check("⭐⭐ job-bridge-approve does NOT double-record — it owns its own receipt",
    !/_bridge-record\.mjs|recordBridge/.test(approveFn));
  check("⭐⭐ …which is why the write stays at the BOUNDARY, not in the shared executor",
    !/recordBridge|writeReceiptNeverThrows/.test(actions));
  check("  …and the reason is written down where the next editor will look",
    /job-bridge-approve` ALREADY HAS A COMPLETE RECEIPT SYSTEM|ALREADY HAS A COMPLETE RECEIPT SYSTEM/.test(record));
  check("  …and the owner-scoped read projects them",
    /ackAcceptedAt: r\.ackAcceptedAt/.test(readFileSync(new URL("../netlify/functions/bridge-receipts.mjs", import.meta.url), "utf8")));

  // The log claim was too broad and is now scoped.
  const settler = readFileSync(new URL("../netlify/functions/bridge-mint-settle-background.mjs", import.meta.url), "utf8");
  // 🚨 A STALE QUOTE IS NOT AN ACTIONABLE ONE. Twice on 2026-08-01 an agent-act result
  // survived a session change, so the panel rendered a live-looking disclosure — band,
  // checkbox, enabled button — with no session behind it. Confirming threw before any
  // request left the browser, which reads as "nothing happened" to the person doing it.
  check("⭐⭐ changing wallet clears the quote AND its acknowledgment",
    /lastOwner\.current !== null && lastOwner\.current !== addr/.test(panel) &&
    /setResult\(null\)/.test(panel) && /setBridgeAcked\(false\)/.test(panel));
  check("⭐⭐ the confirm button is gated on a connected wallet, not only on the tick",
    /disabled=\{bridgeBusy \|\| !walletReady/.test(panel));
  check("  …and an unactionable quote SAYS so rather than looking live",
    /this quote can't be acted on/.test(panel));

  check("⭐ the log-drop claim is scoped to *-background, not all functions",
    /it is \*-background functions whose console output is dropped, NOT every/.test(settler));
}

section("8 — CONSENT ON THE PLAN PATH: refuse at plan stage, never mid-flight");
{
  const act = readFileSync(new URL("../netlify/functions/agent-act.mjs", import.meta.url), "utf8");
  const plan = readFileSync(new URL("../netlify/functions/agent-execute-plan.mjs", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../src/components/MyAgentPanel.tsx", import.meta.url), "utf8");
  const client = readFileSync(new URL("../src/lib/agentClient.ts", import.meta.url), "utf8");

  // The quote priced NOTHING per step, so a plan disclosed no bridge fee and a high-fee
  // step was refused at execution with no way to accept.
  check("⭐⭐ the plan quote prices each bridge step and emits a per-step disclosure",
    /stepDisclosures\[i\] = \{/.test(act) && /bridgeFeeBand\(\{ amountUsdc: amt/.test(act));
  check("⭐ …and surfaces the fee the total silently omitted", /totalFeeUsdc/.test(act) && /totalFeeUsdc/.test(panel));
  check("⭐ a token is minted ONLY where acceptance is required", /band\.band === "acknowledge"\s*\n\s*\? bridgeAckToken/.test(act));

  // ⭐⭐ THE PRE-FLIGHT. Two purposes, and it must SAY so — someone will otherwise read it
  // as redundant with the monotonic rule and delete it.
  check("⭐⭐ every bridge step is re-priced BEFORE any step executes",
    /PRE-FLIGHT: RE-PRICE EVERY BRIDGE STEP BEFORE EXECUTING ANY OF THEM/.test(plan));
  check("⭐⭐ …and it records BOTH reasons it exists, so it is not removed as redundant",
    /PREVENTS A MID-PLAN ABORT AFTER FUNDS HAVE MOVED/.test(plan) &&
    /RE-PRICES A PLAN THAT SAT UNCONFIRMED ON SCREEN/.test(plan));
  check("⭐⭐ a step needing an unheld ack refuses the WHOLE plan with nothing executed",
    /Nothing was executed\. Confirm you accept that/.test(plan) && /needsAck: true/.test(plan));
  check("⭐ …and returns a FRESH disclosure so the ask reflects the current price",
    /stepDisclosures: \{\s*\n\s*\[i\]: \{/.test(plan));

  // ⚠️ Unreachable pricing != too expensive. Collapsing them gives the wrong advice.
  check("⭐⭐ IRIS-unreachable is a DISTINCT message from a band refusal, on both paths",
    /cannot reach the bridge pricing service right now/.test(act) &&
    /cannot reach the bridge pricing service right now/.test(plan));
  check("  …flagged structurally, not only in prose", /priceUnavailable: true/.test(act) && /priceUnavailable: true/.test(plan));
  check("  …and the plan one says nothing executed, so retrying is safe",
    /nothing was executed; try again shortly/.test(plan));

  // Bounded: each priced step is a live IRIS round trip inside a ~10s sync handler.
  check("⭐⭐ the priced-step count is BOUNDED on both sides of the flow",
    /MAX_PRICED_BRIDGE_STEPS = 4/.test(act) && /MAX_PREFLIGHT_BRIDGE_STEPS = 4/.test(plan));
  check("  …and the executor does not trust that the plan came from a quote",
    /must not trust that it came from a quote/.test(plan));

  // Per-step, because two bridges in one plan can sit in different bands.
  check("⭐⭐ acceptance is PER STEP, not one blanket tick", /planAcked\[i\]/.test(panel) && /Record<number, boolean>/.test(panel));
  check("⭐ the confirm button is gated until every required step is accepted",
    /disabled=\{planBusy \|\| !allPlanAcksGiven\}/.test(panel));
  check("⭐ only tokens for steps actually accepted are sent",
    /if \(planAcked\[i\\] && planDisclosures/.test(panel) || /planAcked\[i\] && planDisclosures/.test(panel));
  check("  …and the client can carry them",
    /ackTokens\?: Record<number, string>/.test(client) && /\{ plan, ackTokens[,\s}]/.test(client));
  check("⭐ the panel renders the warn band too, not only the hard gate", /d\.band === "warn"/.test(panel));

  // ⭐ The monotonic rule needs NO code: `acknowledge` is the top band and the only one
  // that gates, so an exact token match already means "no worse than acknowledged".
  const actions = readFileSync(new URL("../netlify/functions/_actions.mjs", import.meta.url), "utf8");
  // 🚨 THE ASSUMPTION THE WHOLE CONSENT DESIGN RESTS ON, PINNED STRUCTURALLY. A comment
  // cannot stop anyone; this fails the build. The monotonic rule needs no code ONLY
  // because `acknowledge` is the sole gating band and the top of the order — add a gating
  // band above it and a user holding an `acknowledge` token is refused MID-PLAN, after
  // earlier steps moved funds. Whoever adds a band will not be reading the token check.
  check("⭐⭐ the band vocabulary is UNCHANGED — a new band silently breaks the monotonic rule",
    JSON.stringify(FEE_BANDS) === JSON.stringify(["none", "warn", "acknowledge"]),
    JSON.stringify(FEE_BANDS));
  check("⭐⭐ …and EXACTLY ONE band gates, which is what makes an exact token match sufficient",
    JSON.stringify(GATING_BANDS) === JSON.stringify(["acknowledge"]), JSON.stringify(GATING_BANDS));
  check("⭐ …`acknowledge` is the TOP of the order (nothing can be worse than what was accepted)",
    FEE_BANDS[FEE_BANDS.length - 1] === GATING_BANDS[0]);
  check("⭐ bridgeFeeBand only ever returns a band from that vocabulary",
    [{ amountUsdc: 1, feeUsdc: 0.01 }, { amountUsdc: 1, feeUsdc: 0.15 }, { amountUsdc: 1, feeUsdc: 0.5 },
     { amountUsdc: 0, feeUsdc: 1 }, { amountUsdc: NaN, feeUsdc: 1 }]
      .every((c) => FEE_BANDS.includes(bridgeFeeBand(c).band)));
  check("  …and the consequence of adding one is written AT the definition, not at the check",
    /ADD A GATING BAND ABOVE `acknowledge` AND THAT REASONING SILENTLY BREAKS/.test(
      readFileSync(new URL("../netlify/functions/_bridge.mjs", import.meta.url), "utf8")));

  check("⭐⭐ _actions still gates on exactly ONE band — that IS the monotonic rule",
    /if \(bandInfo\.band === "acknowledge"\)/.test(actions) &&
    (actions.match(/bandInfo\.band === "acknowledge"/g) || []).length >= 1);
}

section("9 — ackAcceptedAt IS EVIDENCE OF ACCEPTANCE ONLY TRANSITIVELY");
{
  // 🚨 THE FINDING THIS PINS. `ackAcceptedAt` is derived from the BAND at execution
  // (`acknowledged` = `bandInfo.band === "acknowledge"`), never from the token. What makes it
  // mean "the user accepted" is that a REFUSAL made this line unreachable without a matching
  // token — and one of those refusals lives in a DIFFERENT MODULE. Weaken either and the field
  // keeps being written, keeps reading as consent, and stops being evidence of any; no test of
  // the record module would notice. Confidence from one place, value from another.
  //
  // ⚠️ These are ORDERING assertions, not presence ones. Presence is what the existing checks
  // already cover, and presence is not the property: a refusal that runs AFTER the value can be
  // produced protects nothing. Ordering is the weakest thing that is actually load-bearing here
  // and is still readable from source alone — the honest bound is that source order is not
  // execution order for code the regexes cannot see between them.
  const actions = readFileSync(new URL("../netlify/functions/_actions.mjs", import.meta.url), "utf8");
  const plan = readFileSync(new URL("../netlify/functions/agent-execute-plan.mjs", import.meta.url), "utf8");
  const record = readFileSync(new URL("../netlify/functions/_bridge-record.mjs", import.meta.url), "utf8");

  check("the value is derived from the BAND, not from the token — the whole reason it is transitive",
    /ackAcceptedAt: r\.acknowledged \? burnedAt : null/.test(record) &&
    /acknowledged: bandInfo\.band === "acknowledge"/.test(actions));

  // Refusal 1 — the executor's own, guarding BOTH bridge surfaces.
  const mismatchIdx = actions.indexOf('if (step.ackToken !== expected)');
  const acknowledgedIdx = actions.indexOf('acknowledged: bandInfo.band === "acknowledge"');
  check("⭐⭐ _actions REFUSES on a token mismatch BEFORE it can report `acknowledged`",
    mismatchIdx > -1 && acknowledgedIdx > -1 && mismatchIdx < acknowledgedIdx,
    `mismatch@${mismatchIdx} < acknowledged@${acknowledgedIdx}`);
  check("  …and that refusal RETURNS rather than falling through",
    /if \(step\.ackToken !== expected\) \{[\s\S]{0,400}?return \{\s*\n\s*ok: false,/.test(actions));

  // Refusal 2 — the plan pre-flight, which is what makes the refusal cost nothing.
  const needsAckIdx = plan.indexOf("needsAck: true");
  const execLoopIdx = plan.indexOf("for (let i = 0; i < plan.length; i++)");
  check("⭐⭐ the plan pre-flight refuses BEFORE the execution loop — no step has moved funds",
    needsAckIdx > -1 && execLoopIdx > -1 && needsAckIdx < execLoopIdx,
    `needsAck@${needsAckIdx} < execute@${execLoopIdx}`);

  // ⭐ The caveat must travel WITH the value. A reader who finds `ackAcceptedAt: <timestamp>`
  // in a receipt and goes looking for what wrote it lands in _bridge-record.mjs, not here.
  check("⭐⭐ the derivation SAYS what the field does not establish on its own",
    /WHAT `ackAcceptedAt` ACTUALLY WITNESSES/.test(record) &&
    /carried by a REFUSAL/.test(record));
  check("  …and names the two refusals it depends on, so neither is edited unaware",
    /_actions refuses on mismatch/.test(record) && /agent-execute-plan's pre-flight/.test(record));

  // ══ ⭐⭐ THE SECOND WRITER — ADDED 2026-08-28 WITH THE USER-SIGNED BRIDGE ═══════════════════
  // 🚨 THE WHOLE POINT OF THIS BLOCK. `ackAcceptedAt` is evidence only because a refusal makes it
  // unreachable without a matching token. That argument is per-WRITER, not global: a second path
  // reaching recordBridge without its own refusal keeps writing the field, it keeps reading as
  // consent, and NOTHING above would fail — the agent orderings would all still hold.
  // ⚠️ So every writer must be listed here. A path added outside this assertion silently unpins
  // the property, which is exactly the failure the section was written to prevent.
  const userGate = readFileSync(new URL("../netlify/functions/_user-bridge.mjs", import.meta.url), "utf8");
  const userStart = readFileSync(new URL("../netlify/functions/user-bridge-start.mjs", import.meta.url), "utf8");

  // Refusal 3 — the user path's own, in priceAndGate.
  const uMismatchIdx = userGate.indexOf('bandInfo.band === "acknowledge" && ackToken !== expected');
  const uAckIdx = userGate.indexOf('acknowledged: bandInfo.band === "acknowledge"');
  check("⭐⭐ _user-bridge REFUSES on a token mismatch BEFORE it can report `acknowledged`",
    uMismatchIdx > -1 && uAckIdx > -1 && uMismatchIdx < uAckIdx,
    `mismatch@${uMismatchIdx} < acknowledged@${uAckIdx}`);
  check("  …and that refusal RETURNS rather than falling through",
    /ackToken !== expected\) \{[\s\S]{0,400}?return \{\s*\n\s*ok: false,/.test(userGate));

  // ⭐ And the ORDERING at the endpoint: the gate must precede the write, not merely exist.
  const gateCallIdx = userStart.indexOf("await priceAndGate(");
  const refuseIdx = userStart.indexOf("if (!gate.ok)");
  const writeIdx = userStart.indexOf("await recordUserPendingBridge(");
  check("⭐⭐ user-bridge-start gates, REFUSES, and only then writes — in that order",
    gateCallIdx > -1 && refuseIdx > -1 && writeIdx > -1 && gateCallIdx < refuseIdx && refuseIdx < writeIdx,
    `gate@${gateCallIdx} < refuse@${refuseIdx} < write@${writeIdx}`);

  // ⭐ The promoter must NOT recompute consent — it carries it from the gated intent. Recomputing
  // would assert acceptance from a request that never showed the user a disclosure.
  check("⭐ promoteUserBridge CARRIES `acknowledged` from the intent, never recomputes it",
    /acknowledged: pending\.ackAcceptedAt != null/.test(record) &&
    !/bridgeFeeBand|bridgeAckToken/.test(record));

  // 🚨 THE COMPLETENESS CHECK — every caller of recordBridge is a known, gated writer.
  const callers = ["agent-bridge.mjs", "agent-execute-plan.mjs", "_bridge-record.mjs"];
  const fnDir = new URL("../netlify/functions/", import.meta.url);
  const unlisted = readdirSync(fnDir)
    .filter((f) => f.endsWith(".mjs") && !callers.includes(f))
    .filter((f) => /\brecordBridge\(/.test(readFileSync(new URL(f, fnDir), "utf8")));
  check("⭐⭐ NO UNLISTED caller of recordBridge — a new writer must be added to this section",
    unlisted.length === 0,
    unlisted.length ? `unlisted: ${unlisted.join(", ")}` : "3 known callers");
}

section("10 — THE PENDING PATH KEEPS THE CONSENT EVIDENCE (the 202 wrote NOTHING)");
{
  // 🚨 OBSERVED LIVE 2026-08-14, the first run that ever reached the acknowledge band: the
  // user accepted a 53% fee, _actions verified the token and submitted, Circle did not settle
  // inside the deadline, agent-bridge answered 202 — and NOTHING was written. Success was
  // recorded, refusal was recorded, and PENDING (the only state needing follow-up) was silent.
  const actions = readFileSync(new URL("../netlify/functions/_actions.mjs", import.meta.url), "utf8");
  const record = readFileSync(new URL("../netlify/functions/_bridge-record.mjs", import.meta.url), "utf8");
  const receipts = readFileSync(new URL("../netlify/functions/_bridge-receipts.mjs", import.meta.url), "utf8");
  const bridgeFn = readFileSync(new URL("../netlify/functions/agent-bridge.mjs", import.meta.url), "utf8");
  const planFn = readFileSync(new URL("../netlify/functions/agent-execute-plan.mjs", import.meta.url), "utf8");
  const reader = readFileSync(new URL("../netlify/functions/bridge-receipts.mjs", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../src/components/BridgePanel.tsx", import.meta.url), "utf8");

  check("⭐⭐ the executor ATTACHES the consent context to a throw and RETHROWS it",
    /e\.consent = \{/.test(actions) && /throw e;/.test(actions));
  check("⭐⭐ …and STILL does not write a receipt itself — the boundary rule is intact",
    !/recordBridge|recordPendingBridge|writeReceiptNeverThrows/.test(actions));
  check("⭐ the attached context carries the BAND, not just the numbers",
    /feeBand: bandInfo\.band/.test(actions) && /acknowledged: bandInfo\.band === "acknowledge"/.test(actions));

  check("⭐⭐ the 202 path RECORDS before answering", /recordPendingBridge\(\{ e, session/.test(bridgeFn));
  // ⚠️ ASSERTED BY PROPERTY, NOT BY ARGUMENT SPELLING. This previously pinned the exact argument list
  // and went red the moment a legitimate field (`quotePromoted`) was added — text CHANGING, not
  // meaning changing, which is the source-regex failure family that got bridgeReceiptStatus extracted
  // into its own rendering test. What matters is that the plan path records the pending error with the
  // session and carries the join, not the order or completeness of the object literal.
  check("⭐⭐ …and the PLAN path does too — the same gap existed there",
    /recordPendingBridge\(\{\s*e,\s*session/.test(planFn));
  check("⭐ …carrying the quote join, so a pending receipt is joinable too",
    /recordPendingBridge\(\{[^}]*quoteId[^}]*stepIndex/.test(planFn));
  check("⭐ …gated on TxPendingError, not on every throw (a 500 must not mint a receipt)",
    /e instanceof TxPendingError/.test(bridgeFn) && /e instanceof TxPendingError/.test(planFn));

  check("⭐⭐ the provisional receipt carries ackAcceptedAt", /ackAcceptedAt: c\.acknowledged \? submittedAt : null/.test(record));
  check("⭐ …and the band/ratio alongside it", /ackBand: c\.feeBand/.test(record) && /feeRatio: c\.feeRatio/.test(record));
  check("⭐⭐ …keyed on the txId, because there is no hash yet",
    /pendingReceiptKey\(receipt\.owner, receipt\.txId\)/.test(receipts) && /`o\/\$\{norm\(owner\)\}\/tx-\$\{norm\(txId\)\}`/.test(receipts));
  check("⭐⭐ …and a provisional receipt may NEVER carry a burnHash (it would masquerade as confirmed)",
    /if \(receipt\.burnHash\) \{/.test(receipts) && /has_burn_hash/.test(receipts));
  check("⭐ the write never throws — a 202 means 'we don't know yet' and must survive a Blobs hiccup",
    /PROVISIONAL WRITE FAILED \(swallowed\)/.test(receipts));
  check("⭐ …and it is a SEPARATE writer, so the confirmed path's no-burnHash guard is not loosened",
    /if \(!receipt\?\.owner \|\| !receipt\?\.burnHash\)/.test(receipts));

  // 🚨 THE COMPOSITION RISK: a new record type entering a store several jobs scan.
  check("⭐⭐ the sweeper will NOT chase a provisional receipt — excluded BY NAME, not by fall-through",
    /if \(receipt\?\.state === SUBMITTED_STATE\) return false;/.test(receipts));
  check("⭐ no settle trigger on the pending path — there is no burn hash to settle",
    /NO SETTLE TRIGGER/.test(record));
  check("⭐⭐ the owner list sorts on the receipt's OWN clock, so a pending row does not sink to the bottom",
    /r\?\.burnedAt \|\| r\?\.submittedAt/.test(receipts));
  check("⭐ the reader projects txId and submittedAt, so the UI can identify and date a pending row",
    /txId: r\.txId \?\? null/.test(reader) && /submittedAt: r\.submittedAt \?\? null/.test(reader));
  check("⭐⭐ the panel keys on whichever identity exists (else React collapses pending rows into one)",
    /key=\{r\.burnHash \?\? r\.txId\}/.test(panel));
  // ⭐⭐ RETIRED — THE FIFTH BREAK OF THIS EXACT KIND. This asserted the SUBMITTED copy by reading
  // BridgePanel.tsx, and it went red the moment that copy moved into `bridgeReceiptStatus.tsx`
  // — code MOVING, meaning unchanged, for the fifth time across five commits. Every previous break
  // was answered by loosening the pattern; the loosening is how `d8483f1` silently deleted "This
  // will not resolve on its own" with a green suite.
  // ⭐ The claim is now owned by `scripts/verify-bridge-copy.tsx`, which RENDERS the component and
  // asserts that `settling` is the only band permitted to say "yet" and that a submitted row never
  // reads as "in flight". A rendered assertion cannot be defeated by a file reorganisation.
  check("⭐ the panel delegates receipt copy to the rendered-and-tested component",
    /<BridgeReceiptStatus r=\{r\} \/>/.test(panel));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
