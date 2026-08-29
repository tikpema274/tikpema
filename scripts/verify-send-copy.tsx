// verify-send-copy.tsx — WHAT THE TWO SEND PANELS ACTUALLY SAY, rendered.
//
//   npx tsx scripts/verify-send-copy.tsx      (also: npm run test:sendcopy)
//
// ═══ 🚨 WHY TWO PANELS NEED ONE SUITE ══════════════════════════════════════════════════════════
// The claim that matters is a CONTRAST, and a contrast cannot be asserted one panel at a time:
//
//   SendPanel        — sends from the AGENT wallet. Capped (per-tx + day ceiling) and MUST say so.
//   ManualSendPanel  — sends from the USER'S OWN key. Uncapped and MUST say so.
//
// ⭐⭐ STATING THE ABSENCE AGAINST SILENCE IS WORSE THAN SILENCE. SendPanel was capped and said
// nothing for its whole life; "caps do not apply here" on the other panel would then contrast
// against nothing and teach the reader nothing. So both halves are asserted TOGETHER, in one file,
// and neither can be edited away without this suite going red.
//
// ═══ ⭐ THE ABSENCES ARE ASSERTED, BECAUSE THEY ARE DECISIONS ══════════════════════════════════
// The manual send deliberately has NO receipt, NO "stay on this page" warning and NO ack gate —
// each refused on its mechanism in docs/manual-send-design-note.md, not skipped by oversight. A
// later reader diffing this panel against ManualBridgePanel will see three missing features and
// may "restore" them by symmetry. These checks make that a RED test rather than a plausible tidy-up.
//
// ⚠️ RENDERED, NOT GREPPED. "The string is in the file" is not "the user sees it".
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import SendPanel from "../src/components/SendPanel";
import ManualSendPanel, { SendReviewBox } from "../src/components/ManualSendPanel";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? `  — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);
const strip = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// ⭐ Presence and activity are SEPARATE fields — the distinction the panels' copy turns on.
const wallet = (kind: string | null, opts: { metamaskConnected?: boolean; agentWallet?: any } = {}) => ({
  activeKind: kind,
  metamaskConnected: opts.metamaskConnected ?? false,
  agentWallet: opts.agentWallet ?? { address: "0x1111111111111111111111111111111111111111", balance: "12.5" },
  sendFromAgent: async () => {},
  sendUsdcManual: async () => ({ txHash: "0x" }),
  ensureSession: async () => "t",
}) as any;

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  SEND PANELS — the capped one and the uncapped one, RENDERED        ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("1 — ⭐⭐ THE AGENT SEND STATES THE CAPS IT ENFORCES");
{
  const text = strip(renderToStaticMarkup(<SendPanel wallet={wallet("modular")} />));
  check("⭐⭐ says agent spending limits DO apply", /Agent spending limits apply here/i.test(text), text.slice(0, 90));
  check("⭐ …and names BOTH — a per-transaction cap and a daily ceiling",
    /per-transaction cap/i.test(text) && /daily ceiling/i.test(text));
  check("⭐ …and says the server names the exact limit on refusal",
    /the error names the exact limit/i.test(text),
    "the panel must not be the source of truth for the number");
  // ⚠️ THE NUMBER MUST NOT BE HERE. sendCapUsdc() reads AGENT_SEND_CAP_USDC (default 5) and is not
  // exposed to the client; a literal in the UI would be a second source of truth for a money claim,
  // and a code default is not the deployed value. [[caps-from-deployed-env-not-code-defaults]]
  check("🚨 …and does NOT print a cap NUMBER it cannot know",
    !/(cap|ceiling|limit)[^.]{0,40}\b\d+(\.\d+)?\s*USDC/i.test(text) &&
    !/\b\d+(\.\d+)?\s*USDC[^.]{0,20}(cap|ceiling|limit)/i.test(text),
    "the deployed value lives in the environment, not in this file");
}

section("2 — ⭐ THE TITLES CARRY THE DISTINCTION, not only the body copy");
{
  const agent = strip(renderToStaticMarkup(<SendPanel wallet={wallet("modular")} />));
  const own = strip(renderToStaticMarkup(<ManualSendPanel wallet={wallet("metamask")} />));
  check("⭐ the agent panel is titled 'Send from your agent wallet'", /Send from your agent wallet/i.test(agent));
  check("⭐ the manual panel is titled 'Send from your own wallet'", /Send from your own wallet/i.test(own));
  check("🚨 neither is titled the ambiguous 'Send USDC' any more",
    !/<h2>\s*Send USDC/i.test(renderToStaticMarkup(<SendPanel wallet={wallet("modular")} />)));
  // A live route nothing links to is reachable only by typing the hash — #/dca sat that way 22 days.
  const agentSrc = readFileSync(new URL("../src/components/SendPanel.tsx", import.meta.url), "utf8");
  // ⚠️ RELABELLED AFTER MUTATION. This first check was called "the agent panel LINKS to the manual
  // one" and it did NOT test that: breaking the button's label left it green, because the prose
  // invitation above the button ("Want to send from your own wallet instead…") matches the same
  // regex. It tests that the OTHER PATH IS MENTIONED — worth asserting, but not a link check — so
  // it now says so, and the two checks below carry the link claim.
  check("⭐ the agent panel MENTIONS the other path in prose",
    /Want to send from your own wallet instead/i.test(agent));
  check("⭐ …and offers it as a CONTROL with that label",
    /Send from your own wallet\s*<\/button>/.test(agentSrc),
    "prose alone is not a door");
  check("⭐⭐ …and the link actually points at #/send-manual",
    /window\.location\.hash = "\/send-manual"/.test(agentSrc),
    "a live route nothing links to is reachable only by typing the hash");
  // ⭐ Also true in the pre-wallet state, which is the first thing a new user sees.
  const gated = strip(renderToStaticMarkup(<SendPanel wallet={wallet("modular", { agentWallet: null })} />));
  check("⭐ …and the pre-wallet state is titled the same way", /Send from your agent wallet/i.test(gated));
}

section("3 — ⛔ THE MANUAL SEND STATES THAT CAPS DO NOT APPLY");
{
  const text = strip(renderToStaticMarkup(<ManualSendPanel wallet={wallet("metamask")} />));
  check("⛔ says agent spending caps DO NOT apply", /Agent spending caps do not apply here/i.test(text));
  check("⭐ …and says WHY — they bound the agent, not the user's own funds",
    /bound what the agent may move/i.test(text) && /not a limit on your own funds/i.test(text));
  check("⭐ …and states the user signs with their own key",
    /you sign this yourself, with your own key/i.test(text));
}

section("4 — 🚨 THE ONE NEW RISK: an irreversible transfer with no allowlist");
{
  const text = strip(renderToStaticMarkup(<ManualSendPanel wallet={wallet("metamask")} />));
  check("🚨 tells the user to check the address", /Check the address carefully/i.test(text));
  check("⭐ …and says it cannot be reversed", /cannot be reversed/i.test(text));
  check("⭐ …and says there is no allowlist behind it", /no allowlist behind it/i.test(text));
  check("⭐ …and promises to show the address as WE read it",
    /address exactly as\s+we read it/i.test(text), "that is what the review step is for");
}

section("5 — ⭐⭐ THE ABSENCES, WHICH ARE DECISIONS AND NOT OVERSIGHTS");
{
  const text = strip(renderToStaticMarkup(<ManualSendPanel wallet={wallet("metamask")} />));
  // Each of these three is present on ManualBridgePanel for a reason that does NOT hold here.
  // Restoring one "for consistency" must be a red test, not a plausible tidy-up.
  check("⭐⭐ NO 'stay on this page' warning — nothing is written after the signature",
    !/stay on this page/i.test(text),
    "the bridge needs it because a SECOND request writes its record; leaving loses nothing here");
  check("⭐⭐ NO estimate/arrival vocabulary — the amount received IS the amount sent",
    !/estimated/i.test(text) && !/will arrive/i.test(text),
    "there is no fee taken from the amount, so nothing to predict");
  check("⭐⭐ NO acknowledge gate — no fee is deducted, so there is no band to disclose",
    !/I understand/i.test(text) && !/acknowledge/i.test(text));
  check("⭐ …and it does NOT promise a receipt or a send history it never writes",
    !/receipt/i.test(text) && !/your sends|send history|appear in your/i.test(text),
    "a promise of a record that is deliberately not written would be the worst of both");
}

section("6 — 🚨 CONNECT vs SWITCH: the collapse this panel was built after");
{
  const off = strip(renderToStaticMarkup(<ManualSendPanel wallet={wallet("modular", { metamaskConnected: false })} />));
  check("not connected → the instruction is CONNECT", /Connect MetaMask/i.test(off) && !/Switch to MetaMask/i.test(off));

  const inactive = strip(renderToStaticMarkup(<ManualSendPanel wallet={wallet("modular", { metamaskConnected: true })} />));
  check("⭐⭐ connected but not active → the instruction is SWITCH", /Switch to MetaMask/i.test(inactive), inactive.slice(0, 90));
  check("🚨 …and NOT connect what they have already connected", !/Connect MetaMask/i.test(inactive));

  // 🚨 Same rule the bridge suite enforces: a claim about money must not stand beside a control
  // that is not offered. "Caps do not apply" next to no send form is a claim about a path the user
  // cannot take.
  for (const [label, text] of [["not connected", off], ["connected but not active", inactive]] as const) {
    check(`⭐ …no caps claim in the "${label}" state, where nothing can be sent`,
      !/Agent spending caps do not apply/i.test(text));
    check(`⭐ …and no send control offered in the "${label}" state`, !/Sign and send/i.test(text));
  }
}

// ═══ ⚠️ THE STATE A STATIC RENDER CANNOT REACH — named as the weaker instrument it is ══════════
// `reviewing` starts false, so renderToStaticMarkup NEVER produces the review step. Everything
// above is therefore blind to it — found by mutation, not by reading: injecting an ack-shaped
// "I understand" into the review button left §5 GREEN, because the button is not in the output.
// ⭐ A negative assertion that cannot see the region it forbids is a check whose failure mode is a
// pass. Asserted on SOURCE here instead, and labelled as source so nobody reads it as a render
// claim — the same split ManualBridgePanel's suite makes for its post-signature state.
// ⭐ UPGRADED. This section used to be source-regex ONLY, because `reviewing` starts false and a
// static render never emits the review step. That is the same blind spot that let the manual
// bridge ship an acknowledge disclosure containing no numbers — a state behind a transition is
// untested by default. The box is now an exported pure component, so the CONTENT is asserted by
// RENDER and only the WIRING (which value the panel passes in) stays on source, where it belongs.
section("7a — ⭐ THE REVIEW STEP, RENDERED");
{
  const text = strip(renderToStaticMarkup(
    <SendReviewBox to="0x00000000000000000000000000000000000000ab" amountUsdc={0.25}
      busy={false} onSign={() => {}} onBack={() => {}} />
  ));
  check("⭐⭐ shows the destination address IN FULL, untruncated",
    /0x00000000000000000000000000000000000000ab/.test(text),
    "an ellipsis would hide exactly the characters a truncated paste corrupts");
  check("🚨 …and does NOT abbreviate it with an ellipsis", !/0x0000…|…ab\b/.test(text));
  check("⭐ shows the amount", /0\.25 USDC/.test(text));
  check("⭐ offers the sign control", /Sign and send/.test(text));
  check("⭐ …and a way back", /Back/.test(text));
  check("⭐⭐ NO acknowledge language — there is no band to acknowledge",
    !/I understand/i.test(text) && !/acknowledge/i.test(text));
}

section("7b — ⚠️ THE REVIEW WIRING, asserted on SOURCE (a render cannot show which value was passed)");
{
  const src = readFileSync(new URL("../src/components/ManualSendPanel.tsx", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  check("⭐⭐ the panel passes the PARSED address to the box, not the raw input",
    /to=\{parsedTo\}/.test(code) && /const parsedTo = to\.trim\(\)/.test(code),
    "the box renders what it is given — WHICH value it is given is the property, and only source shows that");
  check("⭐ …and the signing call uses the parsed value too",
    /sendUsdcManual!\(parsedTo, amountNum\)/.test(code),
    "reviewing one value and sending another would be worse than no review at all");
  check("⭐ the send is signed exactly ONCE per handler — no loop wraps it",
    (code.match(/sendUsdcManual!\(/g) || []).length === 1);
  check("⭐ …and an edit to either field drops the review, so it cannot go stale",
    /setTo\(e\.target\.value\); setReviewing\(false\)/.test(code) &&
    /setAmount\(e\.target\.value\); setReviewing\(false\)/.test(code),
    "a review of an address the user has since changed is worse than none");
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0`);
console.log(`⭐ The capped panel states its caps; the uncapped one states their absence — and the`);
console.log(`  three features the bridge has and this does not are asserted ABSENT, as decisions.\n`);
