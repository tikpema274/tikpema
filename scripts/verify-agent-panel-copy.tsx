// verify-agent-panel-copy.tsx — THE AGENT PANEL'S CLAIMS, RENDERED, BOTH DIRECTIONS.
//
//   npx tsx scripts/verify-agent-panel-copy.tsx        (also: npm run test:copy)
//
// ═══ 🚨 WHY THIS EXISTS ══════════════════════════════════════════════════════════════════════
// `MyAgentPanel` is the largest surface in the app (797 lines) and was second on the guard
// registry's debt list: claim-bearing copy on the money path that no suite rendered. It is the
// page where a user hands an autonomous agent a task that moves their funds, so its two jobs are
// to state the BOUND on that authority and to distinguish reversible from irreversible.
//
// ═══ ⭐⭐ AND IT GETS RIGHT THE THING VaultPanel GOT WRONG, ONE PANEL OVER ═══════════════════
// VaultPanel rendered "you hold no shares" for a user it had never looked at, because an unread
// balance fell through to the empty state. Here the same branch is gated on
// `w.agentWallet.balance != null`, so an UNKNOWN balance renders "… USDC" and no claim at all.
// ⚠️ THAT IS WHY THE VAULT VERSION LOOKED PLAUSIBLE — the correct pattern was already in the
// codebase, one file away. Section 2 pins it so it stays correct here.
//
// ⚠️ PRESENT AND ABSENT BOTH. The irreversibility taxonomy is only meaningful if the categories
// cannot swap: a suite that merely finds "Gone — there is no undo" somewhere on the page would
// pass while that warning sat under the SWAP card.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

const MyAgentPanel = (await import("../src/components/MyAgentPanel")).default;

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

const wallet = (over: any = {}) => ({
  agentWallet: { address: "0x" + "ab".repeat(20), balance: "12.3456" },
  address: "0x" + "cd".repeat(20), usdcBalance: "12.3456", busy: false, isAuthenticated: true,
  ensureSession: async () => "t", refreshAgentWallet: async () => {}, refreshBalance: async () => {},
  ...over,
});
const render = (over: any = {}) =>
  renderToStaticMarkup(<MyAgentPanel wallet={wallet(over) as any} />)
    .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ").trim();
const bal = (b: any) => render({ agentWallet: { address: "0x" + "ab".repeat(20), balance: b } });

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  AGENT PANEL COPY — rendered; present AND absent                     ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("0 — the panel renders at all");
const funded = render();
check("⚠️ non-empty render (every absence check below is vacuous otherwise)",
  funded.length > 400, `${funded.length} chars`);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⭐⭐ THE BOUND ON THE AGENT'S AUTHORITY, AND ITS THREE NAMED LIMITS");
check("⭐⭐ the agent is stated to spend only from its OWN wallet",
  /always spending only what's in that wallet/.test(funded));
for (const [label, re] of [
  ["per-action", /per-action/], ["per-bridge", /per-bridge/], ["cumulative daily", /cumulative daily/],
] as [string, RegExp][]) {
  check(`⭐ …bounded by a ${label} cap`, re.test(funded));
}
// 🚨 BIND THE SENTENCE TO THE CODE THAT MAKES IT TRUE. Naming three limits in prose is a promise;
// if an enforcement point is renamed or deleted the sentence becomes false with no edit and no
// signal — the same shelf-life defect as VaultPanel's pause absolute, which is bound to its
// allowlist for exactly this reason.
const arc = readFileSync("netlify/functions/_arc.mjs", "utf8");
const budget = readFileSync("netlify/functions/_budget.mjs", "utf8");
check("⭐⭐ …and each named limit has a real enforcement point behind it",
  /AGENT_MAX_SPEND_USDC/.test(arc) && /AGENT_BRIDGE_CAP_USDC/.test(arc) &&
  /PERIOD_CEILING_USDC/.test(budget),
  "AGENT_MAX_SPEND_USDC · AGENT_BRIDGE_CAP_USDC · PERIOD_CEILING_USDC");
// ⚠️ A cap that fails OPEN on a bad value would satisfy the grep above and none of the promise.
check("⭐ …and a misconfigured cap REFUSES rather than disabling itself",
  /refusing to spend/.test(arc) && /refusing to bridge/.test(arc));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — 🚨 UNKNOWN BALANCE IS NOT AN EMPTY ONE (the VaultPanel defect, correct here)");
const EMPTY = /Empty — your agent can't spend anything yet/;
check("⭐ a balance of 0 DOES render the empty state — the true answer must survive",
  EMPTY.test(bal("0")));
check("🚨🚨 a NULL balance does NOT — it has not been read, which is a different answer",
  !EMPTY.test(bal(null)), bal(null).includes("… USDC") ? "renders '… USDC'" : "");
check("🚨 …and an UNDEFINED balance does not either",
  !EMPTY.test(bal(undefined)));
check("⭐ …while a funded wallet naturally shows neither", !EMPTY.test(funded));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐⭐ REVERSIBLE AND IRREVERSIBLE MUST NOT SWAP PLACES");
// The page's second job. Both categories are asserted AND the boundary between them, because a
// warning that drifts under the wrong card is worse than a missing one: it reassures about the
// dangerous action while alarming about the safe one.
check("⭐ the leaving category is named", /Move money out/.test(funded) && /This leaves you/.test(funded));
check("⭐ the staying category is named", /Stays with you/.test(funded));
check("⭐⭐ SEND is marked irreversible, in those words",
  /Goes to someone else\. Gone — there is no undo/.test(funded));
check("⭐ BRIDGE says it leaves Arc AND that coming back costs",
  /Leaves Arc for another chain/.test(funded) && /Bridging back costs a fee/.test(funded));
check("⭐ SWAP says it stays, and only the denomination changes",
  /Stays on Arc, stays yours/.test(funded) &&
  /Nothing leaves your agent's wallet — only the denomination changes/.test(funded));
// 🚨 THE BOUNDARY ITSELF: the irreversibility warning must sit ABOVE the staying section, i.e. with
// the actions it describes. Position, not mere presence.
const outAt = funded.indexOf("Move money out");
const stayAt = funded.indexOf("Stays with you");
const undoAt = funded.indexOf("there is no undo");
check("⭐⭐ …and 'there is no undo' sits inside the LEAVING section, not the staying one",
  outAt > 0 && stayAt > outAt && undoAt > outAt && undoAt < stayAt,
  `out@${outAt} undo@${undoAt} stays@${stayAt}`);

// ═══ ⭐⭐ THE CONFIRM CLAIM IS DERIVED FROM agent-act, NOT PINNED ═══════════════════════════════
// 🚨 THE DEFECT. This box said "you'll confirm anything that moves funds before it runs". A BRIDGE
// and a MULTI-STEP PLAN do return a confirm state; a SWAP, a SERVICE PAYMENT and a SEND each return
// `executed: true` on the first call. Three of five money actions ran with none of the confirmation
// the sentence promised, and nothing asserted the sentence at all.
//
// ⭐ SO THE SET IS READ OUT OF THE PRODUCER. Every money action in agent-act is built as
// `const step = { type: "X" ...}`; the branch either answers with a needs*Confirm state or reaches a
// `executed: true` return. This derives which is which and requires the copy to name exactly that
// partition — both halves, so neither can drift alone.
//
// ⭐⭐ AND IT MUST SURVIVE THE GATE WIDENING. When swap and send gain a confirm step, `IMMEDIATE`
// shrinks and this goes RED until the sentence stops calling them immediate. Without that, the same
// defect returns inverted: a sentence understating a gate that exists, which is how a user ends up
// confirming something they were told would just run.
// ⛔ DERIVE IT, DON'T LOOSEN THE CHECK. [[verdict-earned-by-assertions]]
{
  const act = readFileSync(new URL("../netlify/functions/agent-act.mjs", import.meta.url), "utf8");
  const GATED = new Set(), IMMEDIATE = new Set();
  const re = /const step = \{\s*type:\s*"([a-z_]+)"/g;
  let m;
  while ((m = re.exec(act))) {
    const kind = m[1];
    // From this step to the next one, whichever terminal shape appears FIRST is this branch's answer.
    const nextIdx = act.slice(m.index + 1).search(/const step = \{\s*type:/);
    const region = act.slice(m.index, nextIdx === -1 ? act.length : m.index + 1 + nextIdx);
    const gatedAt = region.search(/needs(Bridge|Swap|Send)?Confirm(ation)?:\s*true/);
    const execAt = region.search(/executed:\s*true/);
    if (gatedAt !== -1 && (execAt === -1 || gatedAt < execAt)) GATED.add(kind);
    else if (execAt !== -1) IMMEDIATE.add(kind);
  }
  // ⭐ TWO GATED ACTIONS ARE NOT BUILT VIA `const step =`, so the loop above cannot see them — and
  // an empty GATED set is exactly the vacuous pass the first assertion exists to catch. It did catch
  // it, which is the only reason this is right.
  //   · BRIDGE returns needsBridgeConfirm and the step is built later, in agent-bridge.mjs.
  //   · A MULTI-STEP PLAN returns needsConfirm alongside `plan: steps`.
  // ⚠️ The plan window is 400 chars, not 200: a comment sits between the two keys and a tighter
  // window silently found nothing — the same "absence reads as safe" shape one layer down.
  if (/needsBridgeConfirm:\s*true/.test(act)) GATED.add("bridge_usdc");
  if (/needsConfirm:\s*true[\s\S]{0,400}plan:\s*steps/.test(act)) GATED.add("multi_step_plan");

  check("⭐ the derivation found real actions on both sides — an empty set would pass vacuously",
    GATED.size > 0 && IMMEDIATE.size > 0,
    `gated=[${[...GATED].join(",")}] immediate=[${[...IMMEDIATE].join(",")}]`);

  const NAMES = {
    bridge_usdc: /\bbridge\b/i, multi_step_plan: /multi-step plan/i,
    swap_tokens: /\bswap\b/i, transfer_usdc: /\bsend\b/i, pay_for_service: /service payment/i,
  };
  const say = renderToStaticMarkup(<MyAgentPanel wallet={wallet() as any} />)
    .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

  // ═══ ⭐⭐ A DERIVED-SET MEMBERSHIP TEST NEEDS BOTH INCLUSIONS ═══════════════════════════════════
  // Asserting GATED ⊆ clause is not enough: an item that LEAVES GATED enters neither set, so nothing
  // objects. Mutation 3b passed at 25/0 for exactly this reason — the bridge gate was removed, the
  // copy went on promising confirmation for it, and every assertion stayed green.
  // ⭐ Assert clause ⊆ GATED too, and assert the derivation found members on BOTH SIDES before
  // trusting either — an empty derivation is green and blind.
  // [[collapse-needs-pairwise-inequality]] · [[equality-passes-vacuously-on-empty]]

  // 🚨 THE CLAUSE, NOT THE PAGE. A first draft asked whether the action's word appeared ANYWHERE and
  // whether "confirm first" appeared ANYWHERE — both true regardless of which side the word sat on.
  // Mutating swap from immediate to gated moved it in the DERIVATION and the check stayed green: the
  // sentence still said swap "runs straight away" and the assertion could not see it. A membership
  // test has to test membership OF SOMETHING. [[collapse-needs-pairwise-inequality]]
  // ⚠️ SCOPED TO THE SENTENCE, NOT THE PANEL. `say` is the whole render, so splitting it at
  // "confirm first" made everything after that point the "immediate" half — including every other
  // mention of bridging on the page. The check failed on bridge_usdc for a reason that had nothing
  // to do with the claim under test. The clause pair only means anything inside the one sentence
  // that draws the distinction.
  const S0 = say.search(/Describe any task in plain language/i);
  const S1 = say.search(/within your caps/i);
  check("⭐ the confirm sentence is present and bounded — nothing to test without it",
    S0 !== -1 && S1 !== -1 && S1 > S0, `start=${S0} end=${S1}`);
  const say2 = S0 === -1 || S1 === -1 ? "" : say.slice(S0, S1 + 20);
  const cut = say2.search(/confirm first/i);
  check("⭐ the copy still has two distinct clauses to test membership against",
    cut !== -1 && /runs straight away/i.test(say2.slice(cut)),
    "without the split there is nothing to be a member of");
  const gatedClause = cut === -1 ? "" : say2.slice(0, cut);
  const immediateClause = cut === -1 ? "" : say2.slice(cut);

  for (const k of GATED) {
    if (!NAMES[k]) continue;
    check(`⭐⭐ gated action "${k}" is named in the CONFIRM-FIRST clause`,
      NAMES[k].test(gatedClause) && !NAMES[k].test(immediateClause),
      "derive it, don't loosen the check");
  }
  for (const k of IMMEDIATE) {
    if (!NAMES[k]) continue;
    check(`⭐⭐ immediate action "${k}" is named in the RUNS-STRAIGHT-AWAY clause`,
      NAMES[k].test(immediateClause) && !NAMES[k].test(gatedClause),
      "derive it, don't loosen the check");
  }
  // ═══ 🚨 THE OTHER DIRECTION, WHICH THE FIRST DRAFT LACKED ═════════════════════════════════════
  // The loops above assert GATED ⊆ clause. They do NOT assert clause ⊆ GATED — so removing the
  // bridge gate entirely left bridge in NEITHER set (it is not built via `const step =` here), the
  // copy went on promising confirmation for it, and the suite stayed green at 25/0. An action that
  // stops gating must not keep being advertised as gated: that is the SAME defect inverted, and it
  // is the one that makes a user wait for a prompt that never comes.
  // ⭐ So every action NAMED in the confirm-first clause must be a member of GATED.
  // [[collapse-needs-pairwise-inequality]]
  for (const [kind, re] of Object.entries(NAMES)) {
    if (!re.test(gatedClause)) continue;
    check(`⛔ "${kind}" is promised as confirmed — so it must actually gate`,
      GATED.has(kind),
      "derive it, don't loosen the check — the copy claims a gate the producer does not have");
  }

  // ⛔ THE CLAIM THAT MUST NOT COME BACK while anything executes on the first call.
  check("⛔ the universal-confirmation claim is absent while any action is immediate",
    IMMEDIATE.size === 0 || !/confirm anything that moves funds/i.test(say),
    "derive it, don't loosen the check — three of five actions ran with no confirmation");
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
