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
import ManualBridgePanel from "../src/components/ManualBridgePanel";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? `  — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);
const strip = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const wallet = (kind: string | null) => ({ activeKind: kind, ensureSession: async () => "t", manualBridgeBurn: async () => "0x" }) as any;

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

section("4 — the direction that catches a hardcode: a non-MetaMask wallet");
{
  const text = strip(renderToStaticMarkup(<ManualBridgePanel wallet={wallet("modular")} />));
  check("offers nothing to sign when the connected wallet cannot",
    /Connect MetaMask/i.test(text) && !/Sign and bridge/i.test(text));
  // 🚨 THE CAPS CLAIM MUST NOT LEAK INTO A STATE WHERE NO BRIDGE IS OFFERED — a standing
  // "caps do not apply" beside no control is a claim about a path the user cannot take.
  check("⭐ …and does NOT assert the caps claim in a state with no bridge control",
    !/Agent spending caps do not apply/i.test(text));
  check("⭐ …nor the stay-on-this-page warning, which qualifies a signature it cannot make",
    !/stay on this page until the burn confirms/i.test(text));
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0`);
console.log(`⭐ The caps absence is STATED, and the arrival is an estimate until the chain is read.\n`);
