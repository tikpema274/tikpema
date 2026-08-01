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

import { readFileSync } from "node:fs";
import { bridgeFeeBand, bridgeAckToken, FEE_BAND_WARN, FEE_BAND_ACKNOWLEDGE } from "../netlify/functions/_bridge.mjs";

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
  const src = readFileSync(new URL("../netlify/functions/agent-bridge.mjs", import.meta.url), "utf8");
  check("⭐⭐ triggerSettle is AWAITED — an un-awaited fetch can be frozen away at handler return",
    /await triggerSettle\(\{/.test(src));
  check("⭐⭐ and the fetch inside it is awaited too", /const r = await fetch\(`\$\{base\}/.test(src));
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

  const bridgeFn = readFileSync(new URL("../netlify/functions/agent-bridge.mjs", import.meta.url), "utf8");
  check("⭐⭐ the receipt records ackBand and ackAcceptedAt — consent survives the session",
    /ackBand: r\.feeBand/.test(bridgeFn) && /ackAcceptedAt: r\.acknowledged \? burnedAt : null/.test(bridgeFn));
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

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
