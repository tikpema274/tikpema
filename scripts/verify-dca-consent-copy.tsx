// verify-dca-consent-copy.tsx — A CONSENT RECORD, PINNED AGAINST THE CODE IT DESCRIBES.
//
//   npx tsx scripts/verify-dca-consent-copy.tsx        (also: npm run test:dca)
//
// ═══ 🚨 WHY THIS ONE IS DIFFERENT FROM A COPY GUARD ══════════════════════════════════════════
// The block this pins is not marketing. It is what the user AUTHORIZED: a server-controlled key
// moving their funds while they are offline. If the words drift, the authorization drifts with
// them and nobody finds out. ⚠️ This surface has form — it ran 22 days with its own notes reading
// "fully verified" while `/api/dca-*` had no redirects and the panel 404'd.
//
// ═══ ⭐⭐ SO EVERY CLAIM IS CHECKED AGAINST THE SERVER, NOT JUST AGAINST ITSELF ═══════════════
// A guard that only asserts "the sentence is present" pins whatever was true when it was written.
// These assertions read the ACTUAL DCA modules, so a claim that stops matching the code fails —
// which is what caught the two corrections below.
//
// 🚨 WHAT WRITING THIS FOUND, both measured 2026-08-20:
//   1. "pause or cancel anytime" implied a PER-MANDATE pause. `STATUS` in `_dca.mjs` has only
//      active / cancelled / complete / expired / stopped-failed — no paused — and `DcaPanel`
//      offers exactly one control, Cancel. What exists is the AGENT-WIDE kill switch, checked
//      fail-closed at `dca-tick.mjs:372`. Stopping "this" would stop everything the executor does.
//   2. "cancelling stops it immediately" was FALSE for a fill already in flight. `dca-cancel`
//      never looks at `pendingPeriod`, and the swap is already submitted on-chain.
//
// ⚠️ AND A SEPARATE, UNFIXED DEFECT IS RECORDED IN SECTION 4 — the tick's ACTIVE check sits ABOVE
// its reconcile, so a cancelled mandate's in-flight fill is never reconciled at all. That is a
// ledger gap, not a copy problem, and it is deliberately NOT patched here.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

const DcaPanel = (await import("../src/components/DcaPanel")).default;

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

const wallet: any = {
  agentWallet: { address: "0x" + "ab".repeat(20), balance: "12.3456" },
  address: "0x" + "cd".repeat(20), usdcBalance: "12.3456", busy: false, isAuthenticated: true,
  ensureSession: async () => "t", refreshAgentWallet: async () => {}, refreshBalance: async () => {},
};
const rendered = renderToStaticMarkup(<DcaPanel wallet={wallet} />)
  .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
  .replace(/\s+/g, " ").trim();

const dca = readFileSync("netlify/functions/_dca.mjs", "utf8");
const tick = readFileSync("netlify/functions/dca-tick.mjs", "utf8");
const cancel = readFileSync("netlify/functions/dca-cancel.mjs", "utf8");
const panelSrc = readFileSync("src/components/DcaPanel.tsx", "utf8");
const actions = readFileSync("netlify/functions/_actions.mjs", "utf8");
const create = readFileSync("netlify/functions/dca-create.mjs", "utf8");
const list = readFileSync("netlify/functions/dca-list.mjs", "utf8");

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  DCA CONSENT RECORD — pinned against the server it describes         ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("0 — the consent block reaches the screen");
check("⚠️ non-empty render", rendered.length > 400, `${rendered.length} chars`);
check("🚨 …and it is marked as custodial BEFORE the authorization",
  /This is custodial\. Read it before you authorize/.test(rendered));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⭐⭐ THE FOUR THINGS THE USER IS ACTUALLY AGREEING TO");
check("⭐⭐ a SERVER-CONTROLLED KEY signs, not their passkey",
  /signed by a server-controlled key, not your passkey/.test(rendered));
check("⭐⭐ …and it acts WHILE THEY ARE OFFLINE", /while you're offline/.test(rendered));
check("⭐ …bounded by an amount, a cadence and an end date", /every/.test(rendered) && /whichever comes first/.test(rendered));
// ═══ ⭐⭐ THE CAP/CEILING CLAIM — PINNED TO THE PROPERTY, NOT TO THE SENTENCE ══════════════════
// This assertion used to be `/per-swap cap and daily ceiling/.test(rendered)` — a PRESENCE check.
// It passed for a sentence that was quietly half-true, and it would have kept passing forever,
// because the only thing it could detect was the words going missing. 🚨 A guard that pins a
// sentence certifies that nobody edited it; a guard that pins a PROPERTY certifies that it is
// still TRUE. Those come apart exactly when it matters — see the 2026-08-21 correction below.
//
// The claim splits in two, and each half is checked against the module that makes it true:
//   (a) ENFORCED BEFORE SUBMIT — both bounds run, and refuse, before any swap is sent.
//   (b) NOT COUNTED IF IT NEVER CONFIRMS — so the ceiling understates from then on.
// (b) is what the old sentence hid, and (b) is why the copy now names the exception.
check("⭐ the copy PROMISES the check happens before submit",
  /checked against your per-swap cap and daily ceiling before it is submitted/i.test(rendered));
check("⭐⭐ …AND it names the exception, rather than implying the counters are always right",
  /never confirms is never counted/i.test(rendered) && /too low/i.test(rendered));

// (a) THE PROPERTY: in _actions.mjs the per-swap cap and the day ceiling both REFUSE before the
// swap is submitted. Index order is the assertion — the same technique section 4 uses.
const capAt = actions.indexOf("exceeds per-swap limit of");
const dayAt = actions.indexOf("canSpendDay({");
const swapAt = actions.indexOf("await agentSwap({");
check("⭐⭐ PROPERTY (a): per-swap cap AND day ceiling are both enforced BEFORE agentSwap runs",
  capAt > 0 && dayAt > 0 && swapAt > capAt && swapAt > dayAt,
  `cap@${capAt} day@${dayAt} → swap@${swapAt}`);

// (b) THE PROPERTY: the SwapPendingConfirm branch ledgers NOTHING, so an unconfirmed fill is not
// counted anywhere. ⚠️ THIS ASSERTION IS DELIBERATELY NOT "the branch is empty of ledgers, and
// that is fine" — it pins a KNOWN GAP so the copy above cannot silently become over-cautious
// either. FLIP IT when the branch starts ledgering at submit (see
// docs/dca-submit-time-budget-design.md), and correct the sentence in the same commit.
const pendStart = tick.indexOf('threw?.name === "SwapPendingConfirm"');
const pendEnd = tick.indexOf("if (!threw) {");
const pendingBranch = pendStart > 0 && pendEnd > pendStart ? tick.slice(pendStart, pendEnd) : "";
const pendingLedgers = /recordAgentSpend|recordDcaSpend|spentAmount:/.test(pendingBranch);
check("⭐⭐ PROPERTY (b): an UNCONFIRMED fill is ledgered NOWHERE — so the copy must name it",
  pendingBranch.length > 0 && !pendingLedgers,
  pendingLedgers
    ? "🎉 the pending branch now ledgers — UPDATE the sentence in DcaPanel and flip this check"
    : `pending branch ${pendingBranch.length} chars, no ledger call`);
// 🚨 The checkbox text is the record itself — it must restate the custodial fact, not just tick.
check("🚨🚨 the CHECKBOX restates the custodial fact rather than saying only 'I agree'",
  /I understand Tikpema's server will move my USDC\/EURC automatically while I'm offline/.test(rendered) &&
  /signed by a key it controls/.test(rendered));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — 🚨 NO PER-MANDATE PAUSE IS PROMISED, BECAUSE NONE EXISTS");
// ⚠️ SCOPED TO THE `STATUS` OBJECT, not the whole file. My first pattern was !/PAUSED:/ over
// `_dca.mjs` — which matches `SKIPPED_PAUSED`, a per-TICK OUTCOME ("the kill switch was on this
// period"), not a mandate STATUS. Two different vocabularies, one substring: the check failed
// while the claim was correct. ⭐ The property is about the mandate lifecycle, so read the
// lifecycle enum and nothing else.
const STATUS_BLOCK = dca.slice(dca.indexOf("export const STATUS = {"),
  dca.indexOf("}", dca.indexOf("export const STATUS = {")));
check("⭐ the mandate lifecycle really has no paused state",
  !/pause/i.test(STATUS_BLOCK),
  (STATUS_BLOCK.match(/^\s*([A-Z_]+):/gm) || []).map((x) => x.trim().replace(":", "")).join("/"));
check("⭐ …and the panel really offers only one control", (panelSrc.match(/>Cancel</g) || []).length >= 1 &&
  !/>Pause</.test(panelSrc));
check("🚨🚨 …so the copy must NOT offer to pause THIS schedule",
  !/pause or cancel/i.test(rendered), rendered.match(/pause[^.]{0,40}/i)?.[0] ?? "");
check("⭐ …while the AGENT-WIDE kill switch may still be offered, because it is real",
  /stop your agent entirely/.test(rendered) && /assertNotPaused/.test(tick));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — 🚨 CANCELLING CANNOT RECALL AN IN-FLIGHT SWAP, AND SAYS SO");
check("⭐ dca-cancel genuinely never inspects pendingPeriod — so nothing stops a submitted fill",
  !/pendingPeriod/.test(cancel));
check("🚨🚨 the copy no longer claims cancelling stops it 'immediately'",
  !/cancelling stops it immediately/i.test(rendered));
check("⭐⭐ …it distinguishes FUTURE swaps from one already submitted",
  /stops\s*every future swap|stops every <b>future<\/b> swap|every future swap/i.test(rendered) &&
  /already submitted will still land|cannot recall one already submitted/i.test(rendered));
check("⭐ …and the checkbox carries that limit too, not just the prose above it",
  /cannot recall one already submitted/.test(rendered));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⚠️ THE UNFIXED LEDGER GAP, RECORDED SO IT CANNOT BE FORGOTTEN");
// 🚨 NOT A COPY PROBLEM, AND DELIBERATELY NOT PATCHED HERE — it is money-path logic.
// dca-tick.mjs skips non-ACTIVE mandates at the top of the loop, BEFORE the reconcile:
//     if (m.status !== STATUS.ACTIVE) { beat.inactive++; continue; }   ← line ~329
//     if (m.pendingPeriod != null) { await reconcilePending(m, key); } ← line ~340
// So a mandate cancelled while a fill is in flight is never reconciled: the swap lands on-chain
// and is NEVER counted against the daily ceiling. ⭐ The fix is to reconcile BEFORE the status
// check — but that advances ledgers for a cancelled mandate, so it is the user's call.
const activeAt = tick.indexOf("if (m.status !== STATUS.ACTIVE)");
const reconcileAt = tick.indexOf("if (m.pendingPeriod != null)");
const gapPresent = activeAt > 0 && reconcileAt > activeAt;
check("⚠️ the known ordering gap is STILL PRESENT (flip this assertion when it is fixed)",
  gapPresent, gapPresent
    ? `ACTIVE-check@${activeAt} precedes reconcile@${reconcileAt} — an in-flight fill on a cancelled mandate is never ledgered`
    : "🎉 reconcile now runs first — update this suite and the note in DcaPanel");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — 🚧 THE CREATE GATE, AND THE LIMITS OF WHAT IT MAY TOUCH");
// ⭐ A gate is a money-safety control, so its SCOPE is pinned the same way its existence is.
// The risk is not that it fails to block — it is that it quietly grows and blocks a RECLAIM.
check("🚧 create is gated at the server, not merely hidden in the UI",
  /CREATE_GATED/.test(create) && /403/.test(create));
check("⭐ …and it refuses BEFORE the wallet resolve and any store write",
  create.indexOf("if (CREATE_GATED)") > 0 &&
  create.indexOf("if (CREATE_GATED)") < create.indexOf("ensureOwnerWallet(session)"));
check("🚨🚨 CANCEL IS NOT GATED — reclaim-class, and a gate must never trap a user inside an authorization",
  !/CREATE_GATED/.test(cancel));
check("⭐ …nor is LIST — a user must still see what is running in order to cancel it",
  !/if \(CREATE_GATED\)/.test(list) && /createGated: CREATE_GATED/.test(list));
// ⚠️ THIS ASSERTION WAS NARROWED THE MOMENT IT WAS WRITTEN, and the reason is worth keeping.
// It began as `!/CREATE_GATED/.test(panelSrc)` — a substring over the WHOLE FILE — and went red on
// a COMMENT that merely points the reader at the real constant. The property (the panel holds no
// copy of the flag) was intact; only the proxy for it was wrong. 🚨 The tempting fix was to reword
// the comment — degrading the code to satisfy a guard, which is how a pointer to the source of
// truth gets deleted for looking like a duplicate of it. Same shape as the test:dd finding
// (PROGRESS.md 2026-08-20): narrow the guard to the property, never edit the code to fit the proxy.
// So: the panel may NAME the constant in prose; it may not IMPORT or DEFINE one.
check("⭐⭐ the PANEL reads the gate from the server, never from its own copy of the flag",
  /createGated/.test(panelSrc) &&
  !/import[^;]*CREATE_GATED/.test(panelSrc) &&
  !/(const|let|var)\s+CREATE_GATED/.test(panelSrc));
// ⚠️ THE GATE MUST NAME ITS OWN HORIZON. A gate with no unblock condition becomes permanent by
// drift — the debt-ratchet failure. This pins that the condition is written WHERE THE GATE IS.
check("⭐⭐ …and the gate states an UNBLOCK CONDITION at the constant itself",
  /UNBLOCK CONDITION/.test(dca) && /UN-GATE WHEN/.test(dca));
check("⚠️ dca-tick's behaviour under the gate is STATED, not left as a side effect",
  /KEEPS\s*\n?\/\/ FILLING|KEEPS FILLING/.test(tick));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — ⭐⭐ UNBLOCK CONDITION (4): UN-GATING WITHOUT AN ENTRY POINT");
// ═══ WHAT THIS GUARDS ════════════════════════════════════════════════════════════════════════
// #/dca has never had a Dashboard card. Every nav-less sibling has one. Flip CREATE_GATED to
// false without adding one and the result is unlinked-by-omission WITH THE DEFECTS FIXED — the
// gate reads as lifted and reachability has not changed at all. That is the state that hid a
// 22-day outage in this same surface. Condition (4) at the constant says so; this makes it FAIL
// THE BUILD instead of relying on someone remembering.
//
// ⭐⭐ RENDERED + DRIVEN, NOT GREPPED. It does not look for a card in the source. It renders the
// Dashboard, walks the tree for controls, INVOKES each onClick against a stubbed window, and reads
// the navigation targets the component actually produces. So it survives a renamed card, reworded
// copy, a restructured JSX tree, or the card moving between sections — it only fails when the
// route genuinely cannot be reached. ⚠️ This repo has been bitten TWICE THIS WEEK by source-scan
// proxies going red on legitimate changes (the citation guard on improved copy; the CREATE_GATED
// proxy on a comment naming the real constant). A proxy for a property is not the property.
//
// ⭐⭐ AND IT IS INERT BY DESIGN — it asserts nothing while CREATE_GATED is true. A guard whose
// whole life is spent green is UNCALIBRATED, which is the objection this session raised against
// the sweeper's DEGRADED path. So the calibration is carried INSIDE every invocation (blobs-probe's
// pattern), never as a one-off manual mutation that decays the moment it is finished:
//
//   ARM A  a stub that navigates elsewhere      -> the detector MUST report MISSING
//   ARM B  a stub that navigates to /dca        -> the detector MUST report PRESENT
//   ARM C  the detector found controls at all   -> 0 controls would make "no /dca" trivially true
//   ARM D  THE GUARD: if un-gated, the REAL Dashboard must reach /dca
//
// ⚠️ ARM C is the one that keeps an ABSENCE from reading as SAFE in the detector itself. If a
// future refactor made the walk find nothing, every "does not reach /dca" answer would still be
// technically correct and completely meaningless.
{
  const { CREATE_GATED } = await import("../netlify/functions/_dca.mjs");

  type NavProbe = { targets: string[]; controls: number };
  const driveNav = (Component: any, props: any): NavProbe => {
    const targets: string[] = [];
    const prev = (globalThis as any).window;
    (globalThis as any).window = {
      location: { set hash(v: string) { targets.push(String(v)); }, get hash() { return ""; } },
    };
    try {
      const handlers: Function[] = [];
      const walk = (n: any) => {
        if (n == null || typeof n !== "object") return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        const pr = (n as any).props;
        if (!pr) return;
        if (typeof pr.onClick === "function") handlers.push(pr.onClick);
        if (pr.children !== undefined) walk(pr.children);
      };
      walk(Component(props));
      for (const h of handlers) {
        try { h({ preventDefault() {}, stopPropagation() {} }); } catch { /* a control that needs
          more than a click cannot be a plain hash link — it is simply not an entry point */ }
      }
      return { targets, controls: handlers.length };
    } finally { (globalThis as any).window = prev; }
  };
  // Accepts "/dca" and "#/dca": `go()` writes the former, a hand-written href the latter. Anchored
  // and word-bounded so a future "/dca-something" route cannot satisfy condition (4) by accident.
  const reaches = (p: NavProbe, route: string) =>
    p.targets.some((t) => new RegExp(`^#?/${route}(?:[/?#]|$)`).test(t));

  const Dashboard = (await import("../src/components/Dashboard")).default;
  const dash = driveNav(Dashboard as any, { wallet });

  // ── ARM A / ARM B — the detector's negative and positive controls ────────────────────────
  const StubElsewhere = () => React.createElement("button",
    { onClick: () => { (globalThis as any).window.location.hash = "/vault"; } }, "Vault");
  const StubToDca = () => React.createElement("button",
    { onClick: () => { (globalThis as any).window.location.hash = "/dca"; } }, "DCA");

  check("⭐ ARM A — the detector reports MISSING on a surface that links elsewhere",
    !reaches(driveNav(StubElsewhere, {}), "dca"));
  check("⭐ ARM B — …and PRESENT on one that links to /dca — it can return both answers",
    reaches(driveNav(StubToDca, {}), "dca"));

  // ── ARM C — the detector is actually looking at something ────────────────────────────────
  check("⭐⭐ ARM C — the Dashboard yields controls to drive; 0 would make every verdict vacuous",
    dash.controls > 0, `${dash.controls} controls → ${dash.targets.length} nav targets`);
  check("⭐ …and it resolves KNOWN entry points, so the walk reaches the real card grid",
    reaches(dash, "vault") && reaches(dash, "bridge") && reaches(dash, "agents"));

  // ── ARM D — THE GUARD ITSELF ─────────────────────────────────────────────────────────────
  const reachable = reaches(dash, "dca");
  if (CREATE_GATED) {
    check("⭐⭐ INERT while gated — the guard asserts nothing until someone un-gates",
      true, `CREATE_GATED=true · #/dca reachable from Dashboard: ${reachable ? "YES" : "NO — condition (4) NOT yet satisfied"}`);
  } else {
    // 🚨 THE MOMENT THIS MATTERS. CREATE_GATED is false, so new mandates are being accepted — and
    // if the Dashboard cannot reach #/dca, the feature is live and unreachable, which is precisely
    // the unlinked-by-omission state condition (4) exists to prevent.
    check("🚨🚨 UN-GATED — the Dashboard MUST reach #/dca, or the feature is live and unreachable",
      reachable, `targets: ${JSON.stringify(dash.targets)}`);
  }

  // The condition and this guard are two statements of one rule, so they are pinned to each other
  // ([[duplicate-source-of-truth-is-the-recurring-bug]]): the numbering already drifted once, when
  // a fourth condition was added under a heading that still said THREE.
  check("⭐ the constant states condition (4) — the guard and the condition cannot drift apart",
    /UN-GATE WHEN ALL FOUR HOLD/.test(dca) && /AN ENTRY POINT EXISTS/.test(dca));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
