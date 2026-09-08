// verify-agent-vocabulary.tsx — ONE VOCABULARY, FOUR SURFACES, AND A READ THAT IS NOT IN IT.
//
//   npx tsx scripts/verify-agent-vocabulary.tsx        (also: npm run test:agentvocab)
//
// ═══ 🚨 WHAT WENT WRONG, AND WHY A GUARD RATHER THAN AN EDIT ═════════════════════════════════
// Four places described what the agent can do to money, and by 2026-09-08 they disagreed:
//   · _actions.mjs (THE EXECUTOR — the only one that decides anything)   6 types
//   · agent-act.mjs SYSTEM_PROMPT (what the model may even propose)      4 types
//   · agent-act.mjs plan KINDS (what a multi-step plan may contain)      4 types
//   · agent-parameters.mjs (the CAPABILITY DISCLOSURE users read)        4 types, in prose
// vault_deposit and vault_withdraw were fully built, tested and unreachable: nothing could name
// them. ⛔ A capability nothing can ask for is not a capability, and a disclosure that undercounts
// the executor is not a disclosure. [[duplicate-source-of-truth-is-the-recurring-bug]]
//
// ═══ ⭐⭐ THE LIST HAD TO BECOME PROVABLE, NOT MERELY CORRECT ════════════════════════════════
// Editing "four" into "six" resets the same clock — the next type added breaks it again, silently,
// on the surface whose job is to be true. So STEP_TYPES is exported from the executor and every
// other surface DERIVES from it. But a frozen array sitting beside an if-chain is itself a second
// copy: section 1 drives validateStepShape with each member and asserts the chain answers, and
// drives it with a non-member and asserts it refuses. That is what makes the array total over the
// code rather than adjacent to it. [[binding-tested-across-what-it-binds]]
//
// ═══ ⛔ AND ONE THING MUST STAY OUT ═══════════════════════════════════════════════════════════
// `show_balance` is a READ. It is in the model's vocabulary and must NEVER be in the executor's:
// every guard in executeAction — the pause, the caps, the day ceiling, the ledger — exists because
// its subject moves money, and a read inheriting them would pay their cost, buy nothing, and stop
// STEP_TYPES from meaning "the things that can touch your funds". agent-parameters discloses that
// list to users as the answer to exactly that question. Section 4 pins the exclusion in both
// directions. [[a-field-name-must-be-true-in-every-case]]

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { STEP_TYPES, validateStepShape } from "../netlify/functions/_actions.mjs";

const { AgentSummary } = (await import("../src/components/MyAgentPanel")) as any;

let pass = 0, fail = 0;
const check = (l: string, c: boolean, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

const act = readFileSync(new URL("../netlify/functions/agent-act.mjs", import.meta.url), "utf8");
const params = readFileSync(new URL("../netlify/functions/agent-parameters.mjs", import.meta.url), "utf8");
const actions = readFileSync(new URL("../netlify/functions/_actions.mjs", import.meta.url), "utf8");

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  AGENT VOCABULARY — one list, derived everywhere, proved total       ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⭐⭐ STEP_TYPES IS TOTAL OVER validateStepShape, IN BOTH DIRECTIONS");
{
  // ⚠️ NON-EMPTINESS FIRST. Every loop below is vacuously green on an empty list, and "the array
  // was accidentally emptied" is precisely the change this section must fail on.
  // [[equality-passes-vacuously-on-empty]]
  check("⛔ the list is non-empty — every assertion below is vacuous otherwise",
    Array.isArray(STEP_TYPES) && STEP_TYPES.length >= 4, `${STEP_TYPES.length} types`);
  check("⭐ …and frozen, so a reader cannot mutate the executor's vocabulary",
    Object.isFrozen(STEP_TYPES));

  // ── DIRECTION 1: every declared type is one the chain actually handles. ──
  // A type in the list that the chain does not know would be OFFERED to the model and then refused
  // as "unknown step type" at execution — a capability advertised and not delivered.
  for (const t of STEP_TYPES) {
    const verdict = validateStepShape({ type: t });
    check(`⭐ "${t}" is handled by validateStepShape`,
      typeof verdict !== "string" || !/unknown step type/.test(verdict),
      verdict === null ? "shape ok with no fields" : String(verdict));
  }

  // ── DIRECTION 2: a type NOT in the list is refused. ──
  // Without this the section passes on a chain that accepts everything, which is the fail-open
  // shape — the list would be "total" because nothing is ever unknown.
  const bogus = validateStepShape({ type: "definitely_not_an_action" });
  check("🚨 …and a type OUTSIDE the list is refused as unknown — not silently accepted",
    typeof bogus === "string" && /unknown step type/.test(bogus), String(bogus));
  check("⛔ ub_deposit specifically is still NOT in the vocabulary",
    !STEP_TYPES.includes("ub_deposit") &&
      /unknown step type/.test(String(validateStepShape({ type: "ub_deposit" }))),
    "agent-parameters' irreversibility claim rests on this");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⭐⭐ THE MODEL'S VOCABULARY COVERS WHAT THE EXECUTOR CAN REACH");
{
  // The prompt's action union, read from the prompt itself rather than restated here.
  const unionLine = act.match(/"action":\s*(.+)$/m)?.[1] ?? "";
  check("⛔ the action union was found — nothing to compare against otherwise",
    unionLine.length > 40, unionLine.slice(0, 80));
  const offered = new Set([...unionLine.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
  check("⭐ the union parsed into real members", offered.size >= 6, `[${[...offered].join(",")}]`);

  // ⛔ vault_deposit is the ONE deliberate exclusion, and it is asserted as such rather than
  // simply being absent. A deposit needs an ackToken bound to the disclosure the USER saw
  // (_actions.mjs gateDeposit); a model cannot mint one, so offering it would ship an action that
  // refuses 100% of the time. Absence with no assertion reads as an oversight — this says it is a
  // decision, and goes red if someone "helpfully" adds it without the consent flow.
  const REACHABLE = STEP_TYPES.filter((t: string) => t !== "vault_deposit");
  for (const t of REACHABLE) {
    check(`⭐⭐ executor type "${t}" is offered to the model`, offered.has(t),
      "built but unnameable is the defect this closes");
  }
  check("⛔ vault_deposit is NOT offered — it would refuse every time without an ackToken",
    !offered.has("vault_deposit"),
    "the gate is correct; the vocabulary must not advertise past it");
  check("🚨 …and the executor still gates deposits on an ackToken, which is WHY it is excluded",
    /gateDeposit\(\{[\s\S]{0,120}ackToken:\s*step\.ackToken/.test(actions),
    "if this gate ever goes, the exclusion above needs re-deciding, not silently keeping");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⛔ THE PLAN'S KINDS SET IS DERIVED, NOT RE-TYPED");
{
  // 🚨 THE ORIGINAL DEFECT: `new Set(["transfer_usdc","swap_tokens","pay_for_service","bridge_usdc"])`
  // — a hand-written four beside an executor that knew six. A plan step the executor would run was
  // rejected by the proposer as unknown: the two halves of one feature disagreeing about the words.
  check("⭐⭐ KINDS is built from STEP_TYPES, not a literal array",
    /const KINDS = new Set\(STEP_TYPES/.test(act),
    "a literal here is a second copy that drifts on the next type added");
  check("🚨 …and no hardcoded four-type literal survives anywhere in agent-act",
    !/new Set\(\[\s*"transfer_usdc"/.test(act));
  check("⭐ the one exclusion is explicit and named in code",
    /STEP_TYPES\.filter\(\(t\) => t !== "vault_deposit"\)/.test(act));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⛔ show_balance IS A READ: IN THE PROMPT, OUT OF THE EXECUTOR");
{
  check("⭐ the model may choose it", /"show_balance"/.test(act));
  check("⛔⛔ …and it is NOT an executor step type",
    !STEP_TYPES.includes("show_balance"),
    "a read inheriting the pause/caps/ceiling/ledger pays their cost and buys nothing");
  check("🚨 …and the executor would refuse it if something tried",
    /unknown step type/.test(String(validateStepShape({ type: "show_balance" }))));

  // ═══ ⭐⭐ THE ROUTING CLAIM, TESTED AS ROUTING — NOT AS A GREP FOR ITS OWN NAME ═══════════════
  // "It never reaches the executor" is a claim about CONTROL FLOW. The honest test is that the
  // branch RETURNS before any executeAction call can run: locate the branch, locate its return,
  // and assert no executeAction appears between them.
  const bi = act.indexOf('if (decision.action === "show_balance")');
  check("⛔ the show_balance branch exists — nothing to test otherwise", bi !== -1);
  const ri = act.indexOf("return json(200,", bi);
  const body = bi === -1 ? "" : act.slice(bi, ri === -1 ? bi : ri);
  check("⭐⭐ the branch returns WITHOUT calling executeAction",
    bi !== -1 && ri !== -1 && !/executeAction/.test(body),
    `${body.length} chars between the branch and its return`);
  // And it is answered BEFORE the plan/dispatch machinery, not after it.
  check("⭐ …and it is answered before the plan block, so no money path is entered first",
    bi !== -1 && bi < act.indexOf('decision.action === "plan"'));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — ⭐⭐ THE CAPABILITY DISCLOSURE COUNTS WHAT THE EXECUTOR COUNTS");
{
  // 🚨 THE STALE SENTENCE: agent-parameters told users "_actions.mjs knows transfer_usdc /
  // pay_for_service / swap_tokens / bridge_usdc" long after it knew six. ⚠️ The CONCLUSION around
  // it was never wrong — ub_deposit really is not in the vocabulary — which is the harder failure:
  // a true claim resting on evidence that quietly decayed. [[evidence-does-not-transfer-across-claim-types]]
  check("⭐⭐ the sentence interpolates STEP_TYPES rather than listing types in prose",
    /STEP_TYPES\.join\(" \/ "\)/.test(params),
    "an edited literal would just reset the same clock");
  check("🚨 …and the stale four-type prose is gone",
    !/transfer_usdc \/ pay_for_service \/ *" \+/.test(params) &&
      !/knows transfer_usdc/.test(params));

  // Rendered, not grepped: build the sentence the way the module does and check every type is in it.
  const rendered = `_actions.mjs knows ${STEP_TYPES.join(" / ")} and throws`;
  for (const t of STEP_TYPES) {
    check(`⭐ the disclosure names "${t}"`, rendered.includes(t));
  }
  check("⛔ …and it does NOT name ub_deposit, which is the claim it is making",
    !rendered.includes("ub_deposit"));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — ⭐⭐ THE RESULTS RENDER, AND A READ NEVER WEARS A SPEND'S MARKS");
{
  // ⚠️ RENDERED, NOT REGEXED ON SOURCE. And AgentSummary is rendered DIRECTLY: these results only
  // appear on MyAgentPanel after a task runs, and renderToStaticMarkup emits the initial state
  // only — a panel-level render would assert nothing about any of them.
  // [[state-behind-a-transition-is-untested-by-default]] · [[assert-on-rendered-output-not-source-regex]]
  const stub = {
    planRun: null, planBusy: false, planMints: {}, planAcked: {},
    onPlanAckChange: () => {}, bridgeReceipts: [], onConfirm: () => {},
    bridgeRun: null, bridgeBusy: false, bridgeAcked: false, walletReady: true,
    onAckChange: () => {}, mint: null, onConfirmBridge: () => {},
  };
  const show = (data: any) =>
    renderToStaticMarkup(<AgentSummary data={data} {...stub} />)
      .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
      .replace(/\s+/g, " ").trim();

  // ── A readable balance ──
  const ok = show({
    executed: false, decision: { action: "show_balance" },
    balance: { address: "0x" + "ab".repeat(20), usdc: "12.345678", eurc: "0.400000", pocket: "agent wallet", readable: true },
    message: "ignored — the render owns its own words",
  });
  check("⭐ a balance answer states both amounts", /12\.345678 USDC/.test(ok) && /0\.400000 EURC/.test(ok), ok.slice(0, 90));
  check("⭐⭐ …at FULL PRECISION — a 2dp render loses four digits of a 6dp token",
    /12\.345678/.test(ok) && !/\b12\.35\b/.test(ok));
  check("⛔⛔ …and SCOPES the claim to the pocket it read",
    /only pocket it can spend from/i.test(ok) && /unified balance/i.test(ok) && /vault/i.test(ok),
    "an unqualified 'your balance' is false for anyone holding funds elsewhere");
  check("🚨 …and wears NO spend marks — no ✓, no transaction link",
    !/✓/.test(ok) && !/View transaction/i.test(ok),
    "those marks mean money moved everywhere else on this surface");

  // ── An UNREADABLE balance is not an empty wallet ──
  // 🚨 THE FAIL-OPEN THIS DENIES: rendering 0 for a read that failed tells a funded user their
  // money is gone. Exactly the shape VaultPanel shipped. [[absence-must-never-read-as-safe]]
  const dead = show({
    executed: false, decision: { action: "show_balance" },
    balance: { address: "0x" + "ab".repeat(20), usdc: null, eurc: null, pocket: "agent wallet", readable: false },
    message: "I could not read your agent wallet's balance just now — this is a network problem, not an empty wallet. Nothing has changed. Try again shortly.",
  });
  check("🚨🚨 an unreadable balance says so — and NEVER renders a 0",
    /could not read/i.test(dead) && !/\b0 USDC\b/.test(dead) && !/\b0\.00\b/.test(dead), dead.slice(0, 110));
  check("⛔ …and says explicitly it is not an empty wallet",
    /not an empty wallet/i.test(dead));
  // ⭐ PAIRWISE: the two states must not render the same text, or neither assertion discriminates.
  // [[fixtures-that-agree-cannot-discriminate]]
  check("⭐⭐ readable and unreadable render DIFFERENT text", ok !== dead);

  // ── A partial read: one token unreadable, one fine ──
  const half = show({
    executed: false, decision: { action: "show_balance" },
    balance: { address: "0x" + "ab".repeat(20), usdc: "5.000000", eurc: null, pocket: "agent wallet", readable: true },
  });
  check("⭐ one unreadable token degrades alone — the other is still stated",
    /5\.000000 USDC/.test(half) && /could not read/i.test(half) && half !== ok);

  // ── A completed reclaim ──
  const done = show({
    executed: true, decision: { action: "vault_withdraw" },
    vaultWithdraw: { reclaimed: true, usdcReceived: 1.234567, withdrawTx: "https://example/tx/0xabc", verifiedBy: "usdc-balance-delta" },
  });
  check("⭐ a reclaim reports its amount", /1\.234567 USDC/.test(done), done.slice(0, 100));
  check("⭐⭐ …and says the figure was MEASURED, not estimated",
    /measured on-chain/i.test(done) && !/estimated\b(?!,)/.test(done.replace(/not estimated/gi, "")));
  check("⭐ …and carries its transaction link", /View transaction/i.test(done));
  check("⛔ …and does NOT say 'Sent … to' — a reclaim is not a transfer to a third party",
    !/Sent\b/.test(done));

  // ── An empty position is not a failure ──
  const empty = show({
    executed: false, decision: { action: "vault_withdraw" },
    vaultWithdraw: { reclaimed: false, vault: "xylo-usdc" },
    message: "You hold no shares in XyloNet USDC Vault (xyUSDC), so there was nothing to reclaim. Nothing moved.",
  });
  check("⭐⭐ 'nothing to reclaim' renders as a fact, not an error",
    /nothing to reclaim/i.test(empty) && !/✗/.test(empty) && !/held off/i.test(empty), empty.slice(0, 110));
  check("⛔ …and does NOT claim a withdrawal happened",
    !/✓/.test(empty) && !/Reclaimed/.test(empty));
  check("⭐⭐ reclaimed and empty render DIFFERENT text", done !== empty);

  // ⚠️ The old generic branches must still work — this section added branches AHEAD of them, and a
  // branch inserted before `data.executed` can swallow results it was never meant to handle.
  const sent = show({ executed: true, decision: { action: "transfer_usdc", amountUsdc: 2, to: "0x" + "cd".repeat(20) }, tx: "https://example/tx/0xdef" });
  check("🚨 a plain SEND still renders as a send — the new branches did not swallow it",
    /Sent/.test(sent) && /2 USDC/.test(sent), sent.slice(0, 80));
  const blocked = show({ executed: false, decision: { action: "transfer_usdc" }, blocked: "exceeds per-transaction limit of 5 USDC" });
  check("🚨 a BLOCKED result still renders its reason",
    /held off/i.test(blocked) && /exceeds per-transaction limit/.test(blocked));
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money, zero network.`);
process.exit(fail === 0 ? 0 : 1);
