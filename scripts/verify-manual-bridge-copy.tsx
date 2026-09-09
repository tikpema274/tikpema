// verify-manual-bridge-copy.tsx — WHAT THE MANUAL BRIDGE PANEL ACTUALLY SAYS, rendered.
//
//   npx tsx scripts/verify-manual-bridge-copy.tsx     (also: npm run test:manualbridgecopy)
//
// ═══ 🚨 THE TWO CLAIMS THIS PANEL CARRIES THAT NO OTHER PANEL DOES ═════════════════════════════
//
// 1. ⛔ "AGENT CAPS DO NOT APPLY." It sits beside a panel where they DO, and SILENCE READS AS
//    CAPPED. The absence of a limit is a claim about money and must be stated, not inferred from
//    a missing error message. If this sentence is ever edited away, a user could reasonably
//    believe a cap is protecting them when none is.
//
// 2. ⭐ "ESTIMATED" ARRIVAL. Reused verbatim from BridgePanel because the estimate/measured
//    distinction is the thing this codebase is most careful about: `netPredicted` is arithmetic
//    (burned minus quoted fee), never an observation. A second wording of it would be a second
//    source of truth for a claim about money.
//
// ⚠️ RENDERED, NOT GREPPED. "The string appears in the file" is not "the user sees it" — a
// conditional that never fires, a refactor that drops the JSX and keeps the type, or a parent that
// stops passing the prop all pass a grep and fail the reader.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bridgeSignerCopy } from "../shared/bridge-mechanic.mjs";
import { readFileSync } from "node:fs";
import ManualBridgePanel, { FeeDisclosureBox } from "../src/components/ManualBridgePanel";
// ⭐⭐ THE CUSTODY SENTENCE IS NOT RESTATED HERE. It is rendered from CustodyNotice and the panel's
// output is asserted to CONTAIN it, so the expected text is COMPOSED from the same source that
// produces the real text. A hardcoded regex would go red when the sentence changed even though this
// panel was still correct — and worse, it drifted: this suite family once carried TWO different
// regexes for one sentence, the weaker of which matched either wording and detected neither.
// The WORDING is asserted once, in verify-custody-notice.tsx, which also demonstrates this property.
import CustodyNotice from "../src/components/CustodyNotice";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? `  — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);
const strip = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// ⭐ THE STUB CARRIES PRESENCE AND ACTIVITY SEPARATELY, because the panel's copy turns on the
// DIFFERENCE between them. The previous stub was `{ activeKind }` only — it could not represent
// "MetaMask is connected but the passkey wallet is active", so §4 rendered identically in the
// defective and the fixed world and passed in both. A guard blind to the defect it covers.
// [[binding-tested-across-what-it-binds]]
const wallet = (kind: string | null, opts: { metamaskConnected?: boolean } = {}) => ({
  activeKind: kind,
  metamaskConnected: opts.metamaskConnected ?? false,
  ensureSession: async () => "t",
  manualBridgeBurn: async () => "0x",
}) as any;

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  MANUAL BRIDGE PANEL — RENDERED, not grepped                        ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("1 — ⛔ the caps sentence, the one the agent panel does not need");
{
  const text = strip(renderToStaticMarkup(<ManualBridgePanel wallet={wallet("metamask")} />));
  // ⭐ COMPOSED, not restated — see the header. The bridge burns USDC only.
  check("renders the shared custody notice (caps do not apply)",
    text.includes(strip(renderToStaticMarkup(<CustodyNotice token="USDC" />))));
  // ⛔ TWO WORDING ASSERTIONS REMOVED HERE, not relaxed — "says WHY the caps exist" and "states the
  // user signs with their own key". Both are properties of the SENTENCE, and both are now asserted
  // once, in verify-custody-notice.tsx §1. Keeping them would rebuild the duplication the composed
  // binding above exists to remove, and validation 1 proved it: with them present, a wording change
  // turned THIS suite red while this panel was still perfectly correct.
}

section("2 — 🚨 THE TAB-CLOSE WINDOW, disclosed BEFORE signing");
{
  const text = strip(renderToStaticMarkup(<ManualBridgePanel wallet={wallet("metamask")} />));
  // 🚨 THE PANEL MUST SAY WHAT THE SUITE KNOWS. verify-user-bridge-recovery.mjs §3 asserts this
  // window is NOT recovered; a gap asserted only in a suite is a gap the user discovers instead.
  check("⭐⭐ tells the user to stay on the page until the burn confirms",
    /stay on this page until the burn confirms/i.test(text), text.slice(0, 80));
  // ⭐ BOTH HALVES, and the second keeps it honest: "stay" alone reads as "or lose your funds".
  check("⭐⭐ …and says the FUNDS are not at risk",
    /funds are not at risk/i.test(text),
    "saying only 'stay on this page' would frighten the user about the wrong thing");
  // ⚠️ UPDATED 2026-09-07. This pinned "we lose the record" and "will not appear in your bridges",
  // which became FALSE the moment bridge-discover-sweep was scheduled AND observed running (6 clean
  // ticks, 08:10-09:00). The PROPERTY is unchanged — the sentence must state the cost of leaving
  // concretely, not merely issue an instruction. Only the true cost moved.
  check("⭐⭐ …and states the record is DELAYED, not lost, with a time",
    /delayed rather than lost/i.test(text) && /ten minutes/i.test(text));
  check("⭐ …and gives the REASON it can be recovered, not just the promise",
    /recorded this bridge when you priced it/i.test(text),
    "the provisional record precedes the burn — that is WHY the owner is enumerable");
  check("⭐ …and keeps STAY as the preferred path on its merits", /it is faster/i.test(text));
  // ⛔ NO OVERCLAIM. Six clean ticks are six ticks.
  check("🚨 …and never promises recovery is guaranteed",
    !/always recover/i.test(text) && !/guaranteed/i.test(text) && !/never lost/i.test(text));
  check("🚨 …and names the consequence that is PERMANENT — a separate entry, the original unfinished",
    /separate entry/i.test(text) && /stays marked unfinished/i.test(text),
    "recovery is not free: the parked intent is never retired, because retiring it would need attribution");
  // ⛔ THE SUPERSEDED CLAIM MUST BE GONE, not merely joined by a new one — a panel carrying both
  // would tell the user the record is lost AND that it is recovered.
  check("⛔ the superseded claim is REMOVED",
    !/we lose the record/i.test(text) && !/will not appear in your bridges/i.test(text));

  // ═══ 🚨 THE TWO PRODUCERS MUST NOT CONTRADICT ════════════════════════════════════════════════
  // MEASURED 2026-09-07: the callout was softened to "delayed rather than lost" while the SIGNER
  // NOTE beside the action still said "we lose the record of it" — two answers to one question, on
  // one screen, shipped for a deploy.
  // ⛔ THE CHECK ABOVE COULD NOT SEE IT, and that is the reusable part: it asserts on a panel
  // rendered with NO quote, so BridgeQuoteSummary never mounts and the signer note is simply absent
  // from `text`. The assertion was TRUE and the claim was LIVE. A state behind a transition is
  // untested by default — so this reads the copy module DIRECTLY rather than hoping a render
  // reaches it. [[state-behind-a-transition-is-untested-by-default]]
  const signer = bridgeSignerCopy("browser").pageInstruction;
  check("🚨 the SIGNER note does not claim the record is lost",
    // ⚠️ BAN THE AFFIRMATIVE CLAIM, NOT THE WORD. A first draft used !/lost\./ and reddened on the
    // CORRECT sentence, which ends "delayed, not lost." — a negative that matches its own fix is a
    // guard that would have been edited away rather than satisfied.
    !/we lose the record/i.test(signer) && !/record is lost/i.test(signer), signer.slice(0, 70));
  check("⭐ …and says the same thing the callout says — delayed, not lost",
    /delayed, not lost/i.test(signer));
  check("⭐ …and still tells the user to stay, in the same words the build CONTROL pins",
    /stay on this page until the burn confirms/i.test(signer));
  check("⭐ …and still says the funds are safe", /funds are not at risk/i.test(signer));

  // ═══ ⭐⭐ ORDER: CUSTODY → HAZARD → CONTROL ═══════════════════════════════════════════════
  // Both notices are constraints on the action, so BOTH precede the control. Between them, money
  // before record: custody says whose funds move and under what limits; the hazard says what is
  // lost if the tab closes. ⛔ "Subordinate" is a WEIGHT (size, colour, density), not a position —
  // treating it as a position is what put custody below the button for one commit.
  //
  // ⭐⭐ THIS ASSERTION CAUGHT THAT INDEPENDENTLY, which is the reason it exists: the panel was
  // reordered and this went red on `hazard@242 < custody@95` before anyone re-read the rule.
  // The invariant below is CHANGED BY DECISION, not relaxed to pass — it is strictly stronger than
  // what it replaces, because it now also pins both notices ahead of the control.
  //
  // 🚨 PRESENCE IS ASSERTED FIRST, AND SEPARATELY, FOR ALL THREE. `indexOf(a) < indexOf(b)` is
  // SATISFIED BY ABSENCE: a missing sentence yields -1, and -1 is less than everything, so a bare
  // ordering chain goes GREEN on a panel that dropped the warning entirely — the failure mode is a
  // PASS, on the sentences a user most needs. Validated red against exactly that case.
  // [[equality-passes-vacuously-on-empty]] · [[check-whose-failure-mode-is-a-pass]]
  const iCustody = text.indexOf("Agent spending caps do not apply here");
  const iHazard = text.indexOf("stay on this page until the burn confirms");
  const iControl = text.indexOf("Get quote");
  const allPresent = iCustody >= 0 && iHazard >= 0 && iControl >= 0;
  check("⭐⭐ all three are present — asserted before any claim about their order",
    allPresent, `custody@${iCustody} hazard@${iHazard} control@${iControl}`);
  check("⭐⭐ …and CUSTODY is read first — whose money, before what is at risk",
    allPresent && iCustody < iHazard,
    allPresent ? `custody@${iCustody} < hazard@${iHazard}` : "⛔ vacuous — one of them is ABSENT");
  // ⚠️ ASSERTS BOTH, BECAUSE IT SAYS BOTH. Written as `iHazard < iControl` alone this printed a
  // green "BOTH constraints precede the control" against a panel whose custody notice sat AFTER
  // the button — true only transitively, via the check above, and a lie as a standalone line. The
  // suite was still red overall, which is exactly how a mislabelled green survives.
  // [[verdict-earned-by-assertions]]
  check("⭐⭐ …and BOTH constraints precede the control that acts on them",
    allPresent && iCustody < iControl && iHazard < iControl,
    allPresent ? `custody@${iCustody} hazard@${iHazard} < control@${iControl}` : "⛔ vacuous — one of them is ABSENT");
}

section("3 — ⭐ the estimate vocabulary, reused verbatim from BridgePanel");
{
  const text = strip(renderToStaticMarkup(<ManualBridgePanel wallet={wallet("metamask")} />));
  check("calls the arrival ESTIMATED", /estimated<\/b>|estimated/i.test(text));
  check("⭐⭐ …and says the exact figure comes from READING THE DESTINATION CHAIN",
    /exact delivered\s+amount appears once we have read the destination chain/i.test(text),
    "this is the sentence that keeps `predicted` from reading as `arrived`");
  check("🚨 does NOT promise an exact arrival anywhere",
    !/exact(ly)?\s+\d|will arrive|guaranteed/i.test(text));
}

section("4a — NOT CONNECTED: the instruction is CONNECT");
{
  const text = strip(renderToStaticMarkup(<ManualBridgePanel wallet={wallet("modular", { metamaskConnected: false })} />));
  check("offers nothing to sign when the connected wallet cannot",
    /Connect MetaMask/i.test(text) && !/Sign and bridge/i.test(text));
  check("⭐ …and does NOT tell them to SWITCH to something they have not connected",
    !/Switch to MetaMask/i.test(text));
  // 🚨 THE CAPS CLAIM MUST NOT LEAK INTO A STATE WHERE NO BRIDGE IS OFFERED — a standing
  // "caps do not apply" beside no control is a claim about a path the user cannot take.
  // ⭐ COMPOSED IN THE NEGATIVE TOO. A hardcoded regex here went RED under validation 1 when the
  // shared sentence changed, even though this panel was still correct — the same false failure the
  // positive assertion was composed to avoid. Non-inclusion of the RENDERED notice is the property.
  check("⭐ …and does NOT assert the caps claim in a state with no bridge control",
    !text.includes(strip(renderToStaticMarkup(<CustodyNotice token="USDC" />))));
  check("⭐ …nor the stay-on-this-page warning, which qualifies a signature it cannot make",
    !/stay on this page until the burn confirms/i.test(text));
}

// ═══ 🚨 THE STATE THE OLD STUB COULD NOT REACH — and the defect it hid ══════════════════════════
// A user who HAS connected MetaMask but has the passkey wallet active was told to "Connect
// MetaMask" — to connect the thing they already connected. Two distinct states, one message, and
// the instruction is WRONG in the second. Recorded open at PROGRESS.md:407 on 2026-08-28.
// ⭐ THIS SECTION WAS VALIDATED RED against the unfixed panel before the hook change landed — a
// check whose failure mode is a pass is worth nothing until it has been seen to fail.
// [[check-whose-failure-mode-is-a-pass]]
section("4b — 🚨 CONNECTED BUT NOT ACTIVE: the instruction is SWITCH, not connect");
{
  const text = strip(renderToStaticMarkup(<ManualBridgePanel wallet={wallet("modular", { metamaskConnected: true })} />));
  check("⭐⭐ tells the user to SWITCH to MetaMask", /Switch to MetaMask/i.test(text), text.slice(0, 100));
  check("🚨 …and does NOT tell them to CONNECT what they have already connected",
    !/Connect MetaMask/i.test(text));
  check("⭐ …and says WHY — it is connected, another wallet is active",
    /another wallet is active/i.test(text));
  check("offers nothing to sign in this state either", !/Sign and bridge/i.test(text));
  // 🚨 Same rule as 4a: a claim about money must not stand beside a control that is not offered.
  check("⭐ …and does NOT assert the caps claim where there is no bridge control",
    !text.includes(strip(renderToStaticMarkup(<CustodyNotice token="USDC" />))));
  check("⭐ …nor the stay-on-this-page warning",
    !/stay on this page until the burn confirms/i.test(text));
}

section("5 — 🚨 ONCE THE BURN EXISTS, SIGNING AGAIN MUST BE UNOFFERABLE");
{
  // 🚨 THE DEFECT THIS PINS. The first version left `burn`/`intentId` intact on every failure, so
  // the "Sign and bridge" button returned after a promote failure — with the SAME calldata. One
  // more click burns a SECOND time, and the motive is the worst kind: re-signing to fix a RECORD
  // problem, spending more money to repair bookkeeping for money that already moved correctly.
  // ⚠️ ASSERTED ON SOURCE, not render: the state is reached only after a real signature, which a
  // static render cannot produce. Named as the weaker instrument it is.
  const src = readFileSync(new URL("../src/components/ManualBridgePanel.tsx", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  check("⭐⭐ a submitted burn is tracked separately from success",
    /const \[signedHash, setSignedHash\]/.test(code) && /setSignedHash\(hash\)/.test(code));
  check("⭐⭐ …and on failure AFTER submission the sign control is REMOVED",
    /if \(submitted\) \{ setBurn\(null\); setQuote\(null\); \}/.test(code),
    "clearing `burn` is what unmounts the Sign button");
  check("🚨 the ONLY control offered afterwards retries the RECORD, never the burn",
    /onClick=\{retryPromote\}/.test(code) && !/signedHash[\s\S]{0,400}onClick=\{signAndBurn\}/.test(code));
  check("⭐ …and retryPromote never calls manualBridgeBurn",
    /async function retryPromote\(\)[\s\S]{0,900}?\n  \}/.test(code) &&
    !/async function retryPromote\(\)[\s\S]{0,900}?manualBridgeBurn/.test(code),
    "it re-reads a chain fact; it cannot spend");
  check("⭐ the burn is signed exactly ONCE per handler — no loop wraps it",
    (code.match(/manualBridgeBurn!\(/g) || []).length === 1);
}

// ═══ 🚨 THE STATE NO TEST EVER SAW, AND WHAT IT COST ═══════════════════════════════════════════
// The acknowledge box renders only after a live 409, so `renderToStaticMarkup(<ManualBridgePanel/>)`
// never produced it and NO suite asserted anything about it. It shipped saying:
//
//     "Most of this amount would become fee. This is a acknowledge disclosure — the fee is a large
//      share of what you are sending, and what arrives will be much smaller."
//
// ⛔ NO FEE. NO RATIO. NO ARRIVAL AMOUNT. NO AMOUNT SENT. Found on the gate's FIRST live firing,
// at 36.14% — the user was asked to accept a qualitative claim and would have learned the figures
// only after consenting. The server had sent all four numbers in the 409 body; the panel dropped
// them. See PROGRESS 2026-08-29.
//
// ⭐ THE FIX THAT MATTERS IS THIS SECTION, NOT THE COPY. The box is now an exported pure component
// so it can be RENDERED with real numbers here. A source regex would have been the weaker
// instrument; rendering the state is the actual test.
section("6 — 🚨 THE ACKNOWLEDGE DISCLOSURE — every number, RENDERED");
{
  const d = {
    amountUsdc: 0.15, feeUsdc: 0.054217, netUsdc: 0.095783, feeRatio: 0.3614333,
    band: "acknowledge", destinationLabel: "Base (Sepolia)", ackToken: "tok",
  };
  const text = strip(renderToStaticMarkup(
    <FeeDisclosureBox disclosure={d} busy={false} onAccept={() => {}} />
  ));

  check("⭐⭐ shows the AMOUNT being sent", /0\.150000/.test(text), text.slice(0, 110));
  check("⭐⭐ shows the FEE in USDC", /0\.054217/.test(text));
  check("⭐⭐ shows what would ARRIVE", /0\.095783/.test(text));
  check("⭐⭐ shows the RATIO as a percentage", /36\.1\s*%/.test(text));
  check("⭐ …and names the destination", /Base \(Sepolia\)/.test(text));
  check("⭐ …and still offers the acceptance control", /I understand/i.test(text));

  // ⚠️ THE ENUM IS A MACHINE TOKEN, NOT PROSE. "This is a acknowledge disclosure" was both
  // ungrammatical and a leak of an internal band name to someone who has no idea what a band is.
  check("🚨 does NOT leak the internal band name into the sentence",
    !/\ba acknowledge\b/i.test(text) && !/acknowledge disclosure/i.test(text),
    "the sentence is written, not assembled from the band");

  // 🚨 A DISCLOSURE THAT DISCLOSES NOTHING IS THE DEFECT. Guard the general property, not just the
  // one wording that was wrong: at least four distinct numbers must appear.
  const numbers = new Set((text.match(/\d+\.\d+/g) || []));
  check("⭐⭐ at least four distinct figures appear — the general property, not one wording",
    numbers.size >= 4, `saw ${[...numbers].join(", ")}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — 🚨 THE SUBMITTED VALUES DO NOT SURVIVE THE BRIDGE, AND THE BANNER DOES NOT OUTLIVE IT");
// ⭐ ASSERTED ON SOURCE, like verify-send-copy §8, and for the same reason: a render cannot see
// what is WAITING BEHIND the state it is in. renderToStaticMarkup gives the initial state only, so
// "does a populated form sit behind the success screen" is structurally invisible to it.
// [[state-behind-a-transition-is-untested-by-default]]
{
  const src = readFileSync(new URL("../src/components/ManualBridgePanel.tsx", import.meta.url), "utf8");

  // ⭐ PRESENCE FIRST. Two bare negatives below cannot distinguish "the rule holds" from
  // "finishBridge does not exist" — an absence check over a missing symbol passes vacuously.
  const hasFinish = /function finishBridge\s*\(/.test(src);
  check("⭐⭐ a single success producer `finishBridge` exists", hasFinish);

  const finish = src.match(/function finishBridge[\s\S]*?\n  \}/)?.[0] ?? "";
  check("🚨 …and it CLEARS the submitted amount at the transition into success",
    /setAmount\(""\)/.test(finish));
  check("⭐ …and it is the ONLY place `setResult` is called with a burn hash",
    (src.match(/setResult\(\{/g) || []).length === 1,
    `${(src.match(/setResult\(\{/g) || []).length} site(s)`);

  // 🚨 THE STALE BANNER. A second bridge must not price against the previous one's success.
  const start = src.match(/async function start\([\s\S]*?\n  \}/)?.[0] ?? "";
  check("⭐⭐ `start()` exists and clears the previous terminal state", /setResult\(null\)/.test(start));
  // ⛔ Clearing `result` alone would SURFACE the old recovery control, since it renders on
  // `signedHash && !result`. Both must go, or the fix is worse than the defect.
  check("🚨 …and clears `signedHash` too, or the OLD retry control appears during the new bridge",
    /setSignedHash\(null\)/.test(start));
  check("⭐ …and `intentId`, so a promote cannot target the previous bridge",
    /setIntentId\(null\)/.test(start));

  // ⚠️ THE PRECONDITION THAT MAKES CLEARING SAFE, PINNED SO A REDESIGN CANNOT SILENTLY BREAK IT:
  // the terminal state must read NONE of the cleared values, or clearing blanks the confirmation.
  const successBlock = src.match(/\{result && \([\s\S]*?\)\}/)?.[0] ?? "";
  // ⚠️ THE `extra` IS DERIVED, NOT A CONSTANT. A fixed "reads result.* only" string would keep
  // printing itself on the very failure that disproves it — a label that names the wrong thing.
  const leaked = ["amount", "destination"].filter((v) => new RegExp(`\\b${v}\\b`).test(successBlock));
  check("⭐⭐ the success block reads NEITHER `amount` NOR `destination` — the precondition",
    successBlock.length > 0 && leaked.length === 0,
    successBlock.length === 0 ? "success block NOT FOUND"
      : leaked.length ? `LEAKS: ${leaked.join(", ")}` : "reads result.* only");

  // ⚠️ A DECISION, PINNED AS ONE: destination is an enumerated server-supplied choice, not free
  // text, so it is deliberately RETAINED. If that ever changes it should change on purpose.
  check("⚠️ `destination` is deliberately NOT cleared — an enumerated choice, not a typed address",
    !/setDestination\(""\)/.test(finish));
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0`);
console.log(`⭐ The caps absence is STATED, and the arrival is an estimate until the chain is read.\n`);
