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
import { readFileSync } from "node:fs";
import ManualBridgePanel, { FeeDisclosureBox } from "../src/components/ManualBridgePanel";

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
  check("says agent spending caps DO NOT apply", /Agent spending caps do not apply here/i.test(text), text.slice(0, 90));
  check("⭐ …and says WHY — they bound the agent, not the user's own funds",
    /bound what the agent may move/i.test(text) && /not a limit on your own funds/i.test(text));
  check("⭐ …and states the user signs with their own key",
    /you sign this yourself, with your own key/i.test(text));
}

section("2 — 🚨 THE TAB-CLOSE WINDOW, disclosed BEFORE signing");
{
  const text = strip(renderToStaticMarkup(<ManualBridgePanel wallet={wallet("metamask")} />));
  // 🚨 THE PANEL MUST SAY WHAT THE SUITE KNOWS. verify-user-bridge-recovery.mjs §3 asserts this
  // window is NOT recovered; a gap asserted only in a suite is a gap the user discovers instead.
  check("⭐⭐ tells the user to stay on the page until the burn confirms",
    /stay on this page until the burn confirms/i.test(text), text.slice(0, 80));
  // ⭐ BOTH HALVES, and the second is what keeps it honest. "Stay or lose the record" is true;
  // "stay" alone reads as "or lose your funds", which is false.
  check("⭐⭐ …and says the FUNDS are not at risk — only the RECORD is lost",
    /funds are not at risk/i.test(text) && /we lose the record/i.test(text),
    "saying only 'stay on this page' would frighten the user about the wrong thing");
  check("⭐ …and says the consequence concretely — it will not appear in your bridges",
    /will not appear in your bridges/i.test(text));
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
  check("⭐ …and does NOT assert the caps claim in a state with no bridge control",
    !/Agent spending caps do not apply/i.test(text));
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
    !/Agent spending caps do not apply/i.test(text));
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

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0`);
console.log(`⭐ The caps absence is STATED, and the arrival is an estimate until the chain is read.\n`);
