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

// ⭐ Presence and activity are SEPARATE fields — the distinction the panels' copy turns on.
const wallet = (kind: string | null, opts: { metamaskConnected?: boolean; agentWallet?: any } = {}) => ({
  activeKind: kind,
  metamaskConnected: opts.metamaskConnected ?? false,
  // 🚨 `??` CANNOT EXPRESS "NO AGENT WALLET": `null ?? {default}` yields the default, so
  // `wallet("modular", { agentWallet: null })` rendered the CONNECTED panel and the variable named
  // `gated` was not gated. The assertion below it — "the pre-wallet state is titled the same way" —
  // had been green against the wrong render. `in` is what makes the absent state expressible.
  // [[state-behind-a-transition-is-untested-by-default]]
  agentWallet: "agentWallet" in opts ? opts.agentWallet : { address: "0x1111111111111111111111111111111111111111", balance: "12.5" },
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
  // ⭐⭐ THE GUARD NAMES WHAT UNBLOCKS THE PAGE — AND FUNDING IS NOT IT.
  // The sentence said "open Wallet to connect and fund it, then come back here". The gate is
  // `!w.agentWallet`: the wallet EXISTING, which appears once there is a session. Funding is not
  // checked here and does not unblock anything, so "fund it, then come back" stated a precondition
  // that is not one — a user with a connected empty wallet was told to go find a funding step
  // before they could even see this page. ⚠️ Three voices, three sentences: this one is the AGENT
  // voice (needs a wallet, points at Wallet) and must not be merged with the self-signed voice
  // (needs MetaMask ACTIVE, points at the landing page). [[verify-facts-before-sharing-words]]
  check("⛔ the guard does NOT make FUNDING a precondition for returning", !/fund it/i.test(gated));
  check("⭐ …it names the wallet page, and the return", /open\s*Wallet/i.test(gated) && /come back here to send/i.test(gated));
  check("⭐ …and the pre-wallet state is titled the same way", /Send from your agent wallet/i.test(gated));
}

section("3 — ⛔ THE MANUAL SEND STATES THAT CAPS DO NOT APPLY");
{
  const text = strip(renderToStaticMarkup(<ManualSendPanel wallet={wallet("metamask")} />));
  // ⭐ COMPOSED, not restated — see the header. ManualSendPanel spends USDC only.
  check("⛔ renders the shared custody notice (caps do not apply)",
    text.includes(strip(renderToStaticMarkup(<CustodyNotice token="USDC" />))));
  // ⛔ TWO WORDING ASSERTIONS REMOVED HERE, not relaxed — "says WHY the caps exist" and "states the
  // user signs with their own key". Both are properties of the SENTENCE, and both are now asserted
  // once, in verify-custody-notice.tsx §1. Keeping them would rebuild the duplication the composed
  // binding above exists to remove, and validation 1 proved it: with them present, a wording change
  // turned THIS suite red while this panel was still perfectly correct.
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
  // ⭐ COMPOSED IN THE NEGATIVE TOO. A hardcoded regex here went RED under validation 1 when the
  // shared sentence changed, even though this panel was still correct — the same false failure the
  // positive assertion was composed to avoid. Non-inclusion of the RENDERED notice is the property.
    check(`⭐ …no caps claim in the "${label}" state, where nothing can be sent`,
      !text.includes(strip(renderToStaticMarkup(<CustodyNotice token="USDC" />))));
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

  // ═══ 🚨 THE ASSET, AND THE CONTRADICTION THE USER WOULD OTHERWISE MEET ALONE ═══════════════════
  // MEASURED on the first live run: MetaMask showed "1 Unknown", not "1 USDC". The token's own
  // symbol() returns "USDC" and our calldata is the canonical transfer, so the cause is not ours —
  // which means this box is the ONLY place a user can learn WHAT they are sending.
  // ⭐ Naming it is necessary and NOT sufficient: "USDC" here against "Unknown" there is a
  // contradiction with no way to resolve it. The token ADDRESS is the resolvable fact, so it must
  // be present, and the discrepancy must be stated BEFORE the user meets it.
  check("⭐⭐ names the ASSET — the only surface that does", /Token:\s*USDC/.test(text));
  check("⭐⭐ …and gives the token ADDRESS, the one thing checkable against MetaMask",
    /0x3600000000000000000000000000000000000000/.test(text));
  check("⭐ …and names the chain", /Arc Testnet/.test(text));
  check("🚨 …and warns that MetaMask will NOT name it, before the user meets the contradiction",
    /MetaMask does not recognise this token/i.test(text) && /Unknown/.test(text));
  check("⭐ …and says it is not a fault in the transfer, so the warning does not read as an error",
    /not a problem with this transfer/i.test(text));
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

section("8 — 🚨 THE SUBMITTED VALUES DO NOT SURVIVE THE SEND");
{
  // 🚨 THE DEFECT THIS PINS. The success state used to hide the form via `{!sentHash && …}` while
  // leaving `to` and `amount` untouched in state — the recipient address and the amount, sitting
  // behind a screen, with NO path that cleared them and no path that brought the form back. The
  // panel was a dead end (reload was the only exit), and worse, the dangerous values were one
  // deleted guard away from a pre-filled one-click repeat of an IRREVERSIBLE transfer.
  //
  // ⭐⭐ ASSERTED ON THE TRANSITION, NOT THE RENDER. A render check can only see the state the
  // component is in; it cannot see what is waiting behind it. The property that matters is that
  // the clear happens when success is ENTERED, so no future edit can reveal a populated form.
  // That lives in the handler, so it is asserted on source — deliberately, like §7b.
  // [[absence-must-never-read-as-safe]] · [[state-behind-a-transition-is-untested-by-default]]
  const code = readFileSync("src/components/ManualSendPanel.tsx", "utf8");
  const handler = code.slice(code.indexOf("async function signAndSend"), code.indexOf("// ═══ 🚨 TWO STATES"));

  check("⭐⭐ the RECIPIENT is cleared on success — an address pasted once is not consent to reuse it",
    /setSentHash\(r\.txHash\)[\s\S]*setTo\(""\)/.test(handler),
    "cleared in the handler, not on render");
  check("⭐⭐ …and the AMOUNT too, in the same transition",
    /setSentHash\(r\.txHash\)[\s\S]*setAmount\("0\.1"\)/.test(handler));
  // ═══ 🚨 WHAT WAS SENT, AND TO WHOM — BOTH DIRECTIONS ═══════════════════════════════════════
  // The confirmation used to read "Sent ✓ — confirmed on Arc." and name NEITHER value, while the
  // AGENT panel named both. The irreversible path — the one whose own copy says "check the address
  // carefully" — gave the weaker confirmation, and the only way to answer "what did I just send"
  // was to leave for a block explorer.
  //
  // ⭐⭐ IN FULL, NOT TRUNCATED. #/send abbreviates via shortAddr(); this panel must not, because it
  // promises "We show you the address exactly as we read it before you sign" and its REVIEW step is
  // asserted untruncated at §7a for a stated reason. Truncating here would contradict, inside one
  // flow, a promise the same panel makes one paragraph earlier.
  check("⭐⭐ the success state names the AMOUNT",
    /Sent <b>\{sent\?\.amount\} USDC<\/b>/.test(code), "rendered from the snapshot, not live form state");
  check("⭐⭐ …and the RECIPIENT, in full — no shortAddr, no ellipsis",
    /\{sent\?\.to\}/.test(code) && !/shortAddr\(/.test(code),
    "an ellipsis hides exactly the characters a corrupted paste would change");
  check("⭐ …from a SNAPSHOT captured before the clear, so it survives the transition",
    /setSent\(\{ to: parsedTo, amount: amountNum \}\)/.test(code)
    && code.indexOf("setSent({ to: parsedTo") < code.indexOf('setTo("")'),
    "captured, then cleared — the order is the mechanism");
  // ⛔ THE OTHER DIRECTION. Naming the values is only safe because the snapshot is INERT — if the
  // PRE-SEND state also carried them the panel would be back to a pre-filled repeat. Asserted as
  // an absence with presence established first, so it cannot pass vacuously.
  check("⛔ …and the snapshot is cleared by `Send another`, so the pre-send state names nothing",
    /setSent\(null\)/.test(code) && /Send another/.test(code),
    "the returning form must not carry the last recipient");
  check("⭐ the form is reachable again — an explicit control, not a reload",
    /Send another/.test(code) && /setSentHash\(null\)/.test(code));
  // ⚠️ PRESENCE FIRST. Written as two bare negatives this passed GREEN against the pre-fix panel,
  // which has no "Send another" at all — the patterns cannot match what does not exist, so the
  // check asserted nothing. Same failure family as the ordering guard in verify-manual-bridge-copy:
  // an absence check whose failure mode is a PASS. Validated red against the real pre-fix source.
  // [[check-whose-failure-mode-is-a-pass]] · [[equality-passes-vacuously-on-empty]]
  const hasControl = /Send another/.test(code) && /setSentHash\(null\)/.test(code);
  check("🚨 …and that control does NOT re-populate the fields",
    hasControl
      && !/Send another[\s\S]{0,400}setTo\(parsedTo\)/.test(code)
      && !/setSentHash\(null\)[\s\S]{0,200}setAmount\(amount\)/.test(code),
    hasControl ? "it reveals an empty form rather than emptying a revealed one"
               : "⛔ vacuous — there is no such control to test");
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0`);
console.log(`⭐ The capped panel states its caps; the uncapped one states their absence — and the`);
console.log(`  three features the bridge has and this does not are asserted ABSENT, as decisions.\n`);
