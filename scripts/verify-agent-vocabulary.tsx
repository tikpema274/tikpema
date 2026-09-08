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
import { gateDeposit } from "../netlify/functions/_vault.mjs";
import { stepsNeedingAck } from "../shared/plan-acks.mjs";

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
const plan = readFileSync(new URL("../netlify/functions/agent-execute-plan.mjs", import.meta.url), "utf8");

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

  // ⭐⭐ EVERY executor type is now nameable — including vault_deposit, which was excluded until
  // the consent round trip existed. ⚠️ THE EXCLUSION WAS NEVER ABOUT THE WORD: the executor gates
  // a deposit on an ackToken bound to the disclosure the USER saw, so offering the action without
  // a way to obtain one shipped a capability that refused 100% of the time. What changed is the
  // flow, not the gate.
  for (const t of STEP_TYPES) {
    check(`⭐⭐ executor type "${t}" is offered to the model`, offered.has(t),
      "built but unnameable is the defect this closes");
  }
  check("🚨 the executor STILL gates deposits on an ackToken — the flow was added, not the gate removed",
    /gateDeposit\(\{[\s\S]{0,120}ackToken:\s*step\.ackToken/.test(actions),
    "if this gate ever goes, the whole propose-then-confirm round trip needs re-deciding");
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
  // ⭐⭐ THE EXCLUSION IS GONE, AND ITS REPLACEMENT IS THE THING THAT EARNED IT. vault_deposit was
  // kept out of plans while per-step consent was not threaded — a step refused mid-run is refused
  // after earlier steps have already moved money. Now every executor type is proposable, and the
  // assertion moves to what makes that safe.
  check("⭐⭐ the plan vocabulary is the FULL executor vocabulary",
    /const KINDS = new Set\(STEP_TYPES\);/.test(act),
    "no hand-maintained subset to drift");
  check("⛔ …and no filtered subset survives", !/STEP_TYPES\.filter/.test(act));
  check("🚨 a vault step in a plan gets its OWN disclosure, in its own map",
    /const vaultDisclosures = \{\};/.test(act) && /vaultDisclosures\[i\] = vdisc;/.test(act),
    "folding it into the bridge-shaped stepDisclosures would drop the gate silently");
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

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — ⭐⭐ A DEPOSIT IS PROPOSED, NEVER EXECUTED BY THE MODEL'S WORD ALONE");
{
  // ⛔ THE ROUTING CLAIM, TESTED AS ROUTING. agent-act must NOT sign a deposit: it inspects,
  // discloses, and hands back a quote. The execute half is /api/agent-vault-deposit, on a user
  // press, carrying the token for the disclosure they actually read.
  const bi = act.indexOf('if (decision.action === "vault_deposit")');
  const wi = act.indexOf('if (decision.action === "vault_withdraw")');
  check("⛔ the deposit branch exists — nothing to test otherwise", bi !== -1);
  const body = bi === -1 ? "" : act.slice(bi, wi === -1 ? act.length : wi);
  check("⭐⭐ the deposit branch NEVER calls executeAction — it proposes",
    bi !== -1 && !/executeAction/.test(body),
    "a model's word is not consent to hand funds to a third-party contract");
  check("⭐ …and returns needsVaultConfirm with the server's disclosure",
    /needsVaultConfirm:\s*true/.test(body) && /vaultDisclosure: d/.test(body));
  check("⭐ …and the disclosure comes from the SHARED producer, not a second inline sequence",
    /depositDisclosure\(\{ vault: v, owner: walletAddress/.test(body) &&
      /import \{ depositDisclosure \} from "\.\/_vault-disclosure\.mjs"/.test(act),
    "inspect → applyReportDisclosure → gate is an ORDERED sequence; re-typing it drops step 2");
  // 🚨 A BLOCK IS TERMINAL. Offering a confirm button for a vault that failed a safety check
  // would present an acknowledgement that cannot work — the gate refuses regardless.
  check("🚨 a BLOCKed vault gets no confirm offered at all",
    /if \(!d\.depositable\)/.test(body) && /no acknowledgement can override it/.test(body));
  // ⛔ An unreadable vault must refuse, never propose. [[absence-must-never-read-as-safe]]
  check("⛔ an unreadable vault REFUSES rather than proposing terms it could not read",
    /could not read this vault's terms right now/.test(body) && /Nothing has been deposited/.test(body));

  // ── The panel side: the SAME component, and the button gated on the SERVER's verdict ──
  const panel = readFileSync(new URL("../src/components/MyAgentPanel.tsx", import.meta.url), "utf8");
  check("⭐⭐ the confirm card MOUNTS VaultDisclosure rather than restating the warnings",
    /<VaultDisclosure/.test(panel),
    "a second copy of this text is the defect the extraction exists to prevent");
  check("⛔ …and the panel writes none of the disclosure copy itself",
    !/vault owner's powers over my deposit/.test(panel) && !/What the vault owner can do/.test(panel),
    "if this copy appears here too, there are two producers again");

  const stub = {
    planRun: null, planBusy: false, planMints: {}, planAcked: {},
    onPlanAckChange: () => {}, bridgeReceipts: [], onConfirm: () => {},
    bridgeRun: null, bridgeBusy: false, bridgeAcked: false, walletReady: true,
    onAckChange: () => {}, mint: null, onConfirmBridge: () => {},
    vaultAcked: false, onVaultAckChange: () => {}, vaultDelta: null,
    vaultRun: null, vaultBusy: false, onConfirmVault: () => {},
  };
  const INSP = {
    verdict: { level: "WARN", warns: [{ code: "owner-can-withdraw", detail: "The owner can withdraw the underlying USDC." }], blocks: [] },
    conformance: { erc4626: true }, asset: { isUsdc: true }, funded: { isShell: false, totalAssetsUsdc: 4171 },
    redemption: { state: "full" }, withdraw: { withdrawFeePct: "0.10%", roundTripRetainedPct: "99.90%" },
    ownerPowers: { ownerIdentityLabel: "an externally-owned account", owner: "0x" + "ab".repeat(20) },
  };
  const proposal = (over: any = {}) => ({
    executed: false, decision: { action: "vault_deposit" }, needsVaultConfirm: true,
    vaultDeposit: { amountUsdc: 5, vault: { key: "xylo-usdc", label: "XyloNet USDC Vault (xyUSDC)", shareSymbol: "xyUSDC" }, cap: 25 },
    vaultDisclosure: { vault: { key: "xylo-usdc", label: "XyloNet USDC Vault (xyUSDC)", shareSymbol: "xyUSDC" },
      inspection: INSP, gate: { level: "WARN", blocks: [], warns: [] }, depositable: true,
      ackRequired: true, ackToken: "a".repeat(64) },
    message: "Deposit 5 USDC into XyloNet USDC Vault (xyUSDC). This vault's owner holds powers over your deposit — read them below and accept before it runs.",
    ...over,
  });
  const rawOf = (props: any) => renderToStaticMarkup(<AgentSummary data={proposal()} {...stub} {...props} />);
  const textOf = (props: any) =>
    rawOf(props).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
      .replace(/\s+/g, " ").trim();

  const unticked = rawOf({});
  const ticked = rawOf({ vaultAcked: true });
  check("⭐ the proposal names the amount and the vault",
    /Deposit 5 USDC/.test(textOf({})) && /XyloNet USDC Vault/.test(textOf({})));
  check("⭐⭐ the owner powers render — from the mounted component, not from this panel",
    /The owner can withdraw the underlying USDC/.test(textOf({})),
    "the disclosure travels; the panel does not restate it");
  // ⛔⛔ THE GATE, BOTH DIRECTIONS. An enabled button before the tick is the whole defect.
  check("⛔⛔ the confirm button is DISABLED until the acknowledgement is ticked",
    /disabled=""/.test(unticked));
  check("⭐⭐ …and ENABLED once it is — otherwise the gate is a dead end, not a gate",
    !/disabled=""/.test(ticked));
  check("⭐ …and the disabled state SAYS WHY",
    /Tick the acknowledgment above/.test(textOf({})),
    "a dead control with no reason is one the user cannot act on");
  // A vault needing no ack must not be gated on a tick that is never offered.
  const okVault = renderToStaticMarkup(
    <AgentSummary
      data={proposal({ vaultDisclosure: { vault: { key: "xylo-usdc", label: "V", shareSymbol: "s" }, inspection: { ...INSP, verdict: { level: "OK", warns: [], blocks: [] } }, gate: { level: "OK", blocks: [], warns: [] }, depositable: true, ackRequired: false, ackToken: null } })}
      {...stub} />);
  check("⭐⭐ a vault needing NO acknowledgement is confirmable immediately",
    !/disabled=""/.test(okVault) && !/Tick the acknowledgment/.test(okVault),
    "gating on a tick that is never offered would make an OK vault undepositable");
  check("⭐ …and the two vaults render DIFFERENTLY — otherwise neither check discriminates",
    okVault !== unticked);

  // ⛔ The completed state reports the SHARES MINTED, not the amount requested — different numbers
  // whenever a deposit fee or a non-1:1 share price applies.
  const doneR = textOf({ vaultRun: { ok: true, sharesReceivedRaw: "4998877", tx: "https://x/tx/0x1" } });
  check("⭐⭐ a completed deposit reports the SHARES the vault minted, not the amount requested",
    /4998877/.test(doneR) && /received/.test(doneR),
    "they differ under a deposit fee; the request is not the result");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("8 — 🚨 THE ORDERED SEQUENCE IS THE SAFETY PROPERTY, SO IT IS ASSERTED");
{
  // 🚨 WRITTEN BECAUSE A MUTATION ESCAPED. Deleting `applyReportDisclosure` from the shared
  // producer — dropping step 2 of the three ordered steps the module exists to name — left this
  // suite GREEN. The module's header claims the order cannot be forgotten; nothing checked it.
  // ⚠️ It is not a money hole: gateDeposit refuses an inspection that never went through step 2,
  // so the omission FAILS CLOSED. But "it fails closed somewhere else" is not the same as "the
  // claim is true", and a guard whose subject is an ordering must test the ordering.
  // [[binding-tested-across-what-it-binds]] · [[guard-green-through-semantic-change]]
  const vd = readFileSync(new URL("../netlify/functions/_vault-disclosure.mjs", import.meta.url), "utf8");
  const code = vd.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const iInspect = code.indexOf("await inspectVault(");
  const iReport = code.indexOf("applyReportDisclosure(");
  const iGate = code.indexOf("gateDeposit({");
  check("⛔ all three steps are present — an absent step cannot be out of order",
    iInspect !== -1 && iReport !== -1 && iGate !== -1,
    `inspect@${iInspect} report@${iReport} gate@${iGate}`);
  check("🚨🚨 …and they run in the ONE order that makes the disclosure complete",
    iInspect !== -1 && iReport > iInspect && iGate > iReport,
    "inspect → applyReportDisclosure → gate; step 2 is what carries the owner powers");

  // ⭐ AND THE FAIL-CLOSED CATCH IS PROVEN BY CALLING IT, not by trusting the comment that
  // describes it. This is what bounds the damage if the order is ever broken again.
  const rawInspection = {
    verdict: { level: "OK", warns: [], blocks: [] },
    disclosure: { source: "inspection" }, // i.e. applyReportDisclosure was NOT applied
    asset: { address: null },
  };
  const g = gateDeposit({ inspection: rawInspection });
  check("⭐⭐ a deposit gated on a RAW inspection is refused — the omission fails closed",
    g.ok === false && /due-diligence report/.test(String(g.blocked)),
    String(g.blocked).slice(0, 80));
  check("⛔ …and the refusal is a BLOCK, so no acknowledgement could override it",
    g.disclosure?.level === "BLOCK");
  // Pairwise: a report-sourced inspection must NOT be refused for this reason, or the check above
  // passes for the wrong cause and would fire on every deposit.
  const ok = gateDeposit({ inspection: { verdict: { level: "OK", warns: [], blocks: [] }, disclosure: { source: "report" }, asset: { address: null } } });
  check("⭐ …and a report-sourced disclosure is NOT refused for that reason",
    ok.ok === true, `${ok.ok} ${ok.blocked ?? ""}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("9 — 🚨 ONE ACTION, ONE BOUND, ON EVERY PATH THAT BOUNDS IT");
{
  // 🚨 THE DEFECT, FOUND BEFORE IT COULD SHIP. Both plan paths mapped every non-bridge step to the
  // SEND cap, while executeAction bounds a deposit by vaultDepositCapUsdc(). Two paths, one action,
  // two numbers.
  // ⭐ MEASURED ON PRODUCTION 2026-09-08: AGENT_SEND_CAP_USDC=10, AGENT_VAULT_DEPOSIT_CAP_USDC
  // unset ⇒ 25. So today the pre-flight was the STRICTER side and the symptom is a wrong refusal
  // naming a limit that does not govern the action. ⚠️ THE DIRECTION IS AN ENV ACCIDENT: raise the
  // send cap above 25 and it inverts into the dangerous one — pass here, refuse MID-RUN, after
  // earlier steps have moved money. The disagreement is the defect; neither direction is safe.
  // [[refusal-reports-compared-quantity]]
  check("⭐⭐ agent-act bounds a vault step by the VAULT cap",
    /s\?\.type === "vault_deposit" \? vcap/.test(act), "not the send cap");
  check("⭐⭐ agent-execute-plan bounds it by the same cap",
    /step\?\.type === "vault_deposit" \? vcap/.test(plan), "both call sites, or they disagree again");
  check("🚨 …and BOTH read it from the one fail-closed helper",
    /vaultDepositCapUsdc\(\)/.test(act) && /vaultDepositCapUsdc\(\)/.test(plan) &&
      /vaultDepositCapUsdc\(\)/.test(actions),
    "three enforcement points, one source — a literal at any of them is the drift");
  // ⛔ AND THE REFUSAL NAMES THE CAP IT APPLIED. A message quoting a bound the check did not use
  // sends the user to change the wrong setting.
  check("⭐ agent-act's refusal names the governing cap, derived",
    /capLabelFor\(steps\[over\]\)/.test(act) && !/isBridge \? "bridge" : "transaction"/.test(act));
  check("⭐⭐ the plan executor's refusal reads the SAME helper the check read",
    /per-\$\{capLabelForA\(step\)\} limit of \$\{capUsdcFor\(step\)\}/.test(plan),
    "it re-derived `isBridge ? bcap : cap` one line from the check — a second selection");
  check("🚨 …and that second inline selection is gone",
    !/limit of \$\{isBridge \? bcap : cap\}/.test(plan));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("10 — ⛔ A VAULT STEP IN A PLAN IS RE-VERIFIED BEFORE STEP 1, ON A FRESH READ");
{
  const vi = plan.indexOf("const vaultIdxA");
  const ei = plan.indexOf("// ── Execute in order");
  check("⛔ the vault pre-flight exists", vi !== -1);
  check("🚨🚨 …and runs BEFORE the execution loop — a mid-run refusal comes after money moved",
    vi !== -1 && ei !== -1 && vi < ei, `preflight@${vi} loop@${ei}`);
  const body = vi === -1 ? "" : plan.slice(vi, ei === -1 ? plan.length : ei);
  check("⭐⭐ it RE-COMPUTES the disclosure rather than trusting the proposal",
    /depositDisclosure\(\{ vault: vv, owner: walletAddress/.test(body),
    "the endpoint accepts a plan array directly; nothing client-supplied may decide the gate");
  check("⭐ …and compares the ack against the FRESHLY computed token",
    /\(ackTokens \|\| \{\}\)\[i\] !== vdisc\.ackToken/.test(body),
    "a token matching a stale disclosure is consent to terms that changed");
  check("⛔ a missing or stale ack refuses the WHOLE plan, executing nothing",
    /executed: false/.test(body) && /Nothing was executed/.test(body));
  check("⭐ …and returns the FRESH disclosure so the recovery can render",
    /vaultDisclosures: \{ \[i\]: vdisc \}/.test(body));
  check("⛔ a BLOCKed vault stops the plan and says no ack can override",
    /no acknowledgement can override it/.test(body));
  check("⛔ an unreadable vault stops the plan — it does not proceed on an unread disclosure",
    /could not read that vault's terms/.test(body));

  // ── The panel: two consent kinds, unioned, never merged ──
  const panel = readFileSync(new URL("../src/components/MyAgentPanel.tsx", import.meta.url), "utf8");
  // ═══ ⚠️ THIS ASSERTION MADE THE SAME MISTAKE IT WAS WRITTEN TO CATCH ════════════════════════
  // It grepped the PANEL for `band === "acknowledge"`, which is an implementation detail of where
  // the union happens — and the union then moved into shared/plan-acks.mjs, so it went red on a
  // change that improved the very property it guards. A check pinned to a location fails on moves
  // and passes on breakage. ⭐ So it CALLS the rule instead, and separately requires the panel to
  // delegate to it — behaviour plus wiring, neither of which a move can break.
  // [[assert-on-rendered-output-not-source-regex]]
  check("⭐⭐ the ack union counts VAULT steps, not only fee-banded bridge steps",
    JSON.stringify(stepsNeedingAck({ planVaults: { 3: { ackRequired: true } } })) === "[3]",
    "a vault entry has no `band`; folding the maps would drop it from the gate silently");
  check("⛔ …and a vault step that needs NO ack is not counted",
    stepsNeedingAck({ planVaults: { 3: { ackRequired: false } } }).length === 0);
  check("⭐ …and the panel delegates to that rule rather than re-implementing the union",
    /stepsNeedingAck\(\{ planDisclosures, planVaults \}\)/.test(panel),
    "an inlined union would pass the two checks above and still drop vault steps");
  check("⭐ …and mounts VaultDisclosure per vault step rather than restating the warnings",
    /ackId=\{`plan-vault-\$\{i\}`\}/.test(panel));
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money, zero network.`);
process.exit(fail === 0 ? 0 : 1);
