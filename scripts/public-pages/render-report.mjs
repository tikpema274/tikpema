// render-report.mjs — a signed due-diligence report → the public page. PURE: (report, context) → HTML.
//
// ═══ ⭐⭐ THE HARD PART: "WE COULD NOT ESTABLISH THIS" IS A RESULT ════════════════════════════════
// Every answer on the page is in one of two states, drawn with the same weight:
//   ESTABLISHED      — the report read it, at its block, and both endpoints agreed.
//   NOT ESTABLISHED  — the report did not settle it. Never shown as an error, never greyed out, never
//                      omitted. Each says WHY, in a sentence, and what the unanswered question can reach.
// "Not established" comes from three places, and ALL THREE render:
//   1. coverage.notChecked — a check that ran and did not conclude (unreadable, endpoints disagreed,
//      input unreadable, stopped unexpectedly) or was deliberately not run (with its stated reason);
//   2. the report's own stated limits — `evidence.note` (a selector's absence is not proof), the shapes NOT
//      tested for, `sources.independenceVerified`, `sanctions.listComplete`;
//   3. SCHEMA_SCOPE below — what this schema version does not measure at all (e.g. 0.3.0 reads no delays
//      and no exit liquidity). A question the report never asked is "not established", never "none".
//
// ⛔ AN UNKNOWN SCHEMA VERSION OR PROFILE REFUSES TO RENDER. A renderer that silently skipped a field it
// does not know (0.4.0's powersV2, exitPath) would turn an absence into a clean page.

import { esc, page, mark, commands, curlFor, fmtInt } from "./_shell.mjs";

/** What each schema version does NOT measure. Keyed by version; a version not listed refuses. */
export const SCHEMA_SCOPE = Object.freeze({
  "onchain-analyze/0.3.0": {
    delays: "This version of the report does not read whether any power waits before it takes effect. It records which powers exist and who they are attributed to, not how long they take. If one takes effect immediately, this report would not show it.",
    exit: "This version of the report does not compute what a withdrawal would return right now.",
    holderAttribution: "The report attributes every power to the address returned by owner(). It does not read each function's access check, so it does not establish that the owner is the only address that can call it.",
  },
});

const REASON_SENTENCE = {
  "rpc-unreadable": "Both endpoints were asked and neither returned a usable answer. This is not a \"no\": we do not know.",
  "rpc-disagreement": "The endpoints gave different answers for the same block. We do not pick one; both answers are shown below.",
  "input-unreadable": "A value this check depends on could not be read, so the check could not conclude.",
  "check-error": "The check stopped unexpectedly before it could conclude.",
  "not-applicable": "This check was deliberately not run.",
};

const POWER_QUESTION = {
  emergencyWithdraw: "Can someone pull assets out of the vault directly?",
  feesSettable: "Can someone change the fees?",
  setStrategy: "Can someone redirect where deposits are deployed?",
  setFeeRecipient: "Can someone redirect where fees go?",
  transferOwnership: "Can these powers be handed to someone else?",
  pausable: "Can someone pause the vault?",
  upgradeable: "Can someone replace the vault's code?",
  denylist: "Can someone block a specific depositor?",
  withdrawalDelay: "Can someone delay withdrawals?",
};

const HOLDER_KIND = {
  eoa: "an address with no code: a single key, not a contract or a multisig",
  contract: "a contract",
  multisig: "a multisig contract",
};

const chainLabel = (r) => (r.subject.chainName === "arc-testnet" ? "Arc testnet" : r.subject.chainName === "arc-mainnet" ? "Arc mainnet" : r.subject.chainName);

/**
 * @param report   the signed report, exactly as published beside the page
 * @param ctx      { title, vaultLabel, notices:[html], blockTimestamp (unix s, read by the build), verification
 *                   (verifyAttestation's verdict at build time), verifiedAt (ISO), digest, reportPath,
 *                   specUrl, verifierCommand, identityRpc, siblings:[{href,text}] }
 */
export function renderReportPage(report, ctx) {
  const scope = SCHEMA_SCOPE[report?.schemaVersion];
  if (!scope) throw new Error(`render-report: schema ${JSON.stringify(report?.schemaVersion)} is not one this page knows how to render; refusing rather than omitting fields it does not understand`);
  for (const f of ["recognition", "exitPath", "powersV2"]) {
    if (report[f] !== undefined && report[f] !== null) throw new Error(`render-report: report carries ${f}, which this renderer does not render; refusing`);
  }
  if (report.refusal) return renderRefusal(report, ctx);

  const r = report;
  const readsById = new Map(r.reads.map((x) => [x.readId, x]));
  const cmdsForRead = (ids) => ids.map((id) => readsById.get(id)).filter(Boolean)
    .map((x) => ({ label: `${x.method} via ${x.endpoint} at block ${fmtInt(r.subject.blockNumber)}`, command: x.reproduce }));
  const checkById = new Map(r.coverage.checked.map((c) => [c.id, c]));
  const idsOf = (c) => (c?.readIds ?? (c?.readId ? [c.readId] : []));

  // ── 1. WHO CAN TOUCH YOUR DEPOSIT ─────────────────────────────────────────────────────────────
  const sec1 = [];
  const ownerCheck = checkById.get("owner:owner()");
  const ownerCodeCheck = checkById.get("owner:code@owner");
  if (r.owner?.address && ownerCheck) {
    sec1.push(rowHtml("est", "Who is the owner?",
      `<p>The vault's owner is <code>${esc(r.owner.address)}</code>, ${esc(HOLDER_KIND[r.owner.kind] ?? r.owner.kind)}.</p>`,
      cmdsForRead([...idsOf(ownerCheck), ...idsOf(ownerCodeCheck)])));
  }
  const present = r.powers.filter((p) => p.present);
  for (const p of present) {
    const sigs = p.matched.map((m) => `<code>${esc(m.signature)}</code>`).join(", ");
    sec1.push(rowHtml("est", POWER_QUESTION[p.power] ?? p.power,
      `<p>Yes. The vault's code contains ${sigs}. <span class="reach">What it can reach: ${esc(p.severityReach)}.</span></p>
<p>Attributed to the owner, <code>${esc(p.holder)}</code> (see "What we could not establish").</p>`,
      cmdsForRead(idsOf(checkById.get("shape:code@address")))));
  }
  sec1.push(rowHtml("not", "Is the owner the only address that can use these powers?", `<p>${esc(scope.holderAttribution)}</p>`));

  // ── 2. WHAT CAN CHANGE WITHOUT NOTICE ─────────────────────────────────────────────────────────
  const sec2 = [rowHtml("not", "Does any of these powers wait before it takes effect?", `<p>${esc(scope.delays)}</p>`)];

  // ── 3. CAN YOU GET OUT RIGHT NOW ──────────────────────────────────────────────────────────────
  const sec3 = [rowHtml("not", "What would a withdrawal return at this block?", `<p>${esc(scope.exit)}</p>`)];
  const absentAccess = r.powers.filter((p) => !p.present && ["pausable", "denylist", "withdrawalDelay"].includes(p.power));
  for (const p of absentAccess) sec3.push(absentRow(p));

  // ── 4. WHAT WE COULD NOT ESTABLISH ────────────────────────────────────────────────────────────
  const sec4 = [];
  for (const n of r.coverage.notChecked) {
    const why = REASON_SENTENCE[n.reason] ?? "The check did not conclude.";
    const extra = n.why ? `<p>Stated reason: ${esc(n.why)}</p>` : "";
    const resp = n.responses ? `<p>What each endpoint said:</p><pre><code>${esc(JSON.stringify(n.responses, null, 2))}</code></pre>` : "";
    const ids = n.readIds ?? (n.readId ? [n.readId] : []);
    sec4.push(rowHtml("not", checkQuestion(n), `<p>${esc(why)}</p>${extra}${resp}`, cmdsForRead(ids)));
  }
  for (const p of r.powers.filter((p) => !p.present && !absentAccess.includes(p))) sec4.push(absentRow(p));
  const ev = r.shape?.evidence;
  if (ev?.shapesNotTestedFor?.length) {
    sec4.push(rowHtml("not", "Could the code be replaced by a mechanism the report does not test for?",
      `<p>The report tested for ${esc(ev.shapesTestedFor.join(", "))}; none matched (implementation slot <code>${esc(ev.implSlot ?? "not read")}</code>). It did not test for: ${esc(ev.shapesNotTestedFor.join("; "))}.</p>`,
      cmdsForRead(idsOf(checkById.get("shape:eip1967-impl-slot")))));
  }
  if (r.sources) {
    const s = r.sources;
    const agreed = s.integrity?.providerDisagreement === false && (s.integrity?.splits ?? []).length === 0;
    sec4.push(rowHtml("not", "Are the two endpoints independent of each other?",
      `<p>${agreed ? "They agreed on every read." : "They did not agree on every read (see above)."} Whether they are independent of each other is ${s.independenceVerified ? "recorded as verified" : "not verified"}. Agreement also does not cover the chain itself: every Arc endpoint follows the same validator set.</p>`));
  }
  if (r.sanctions) {
    const sx = r.sanctions;
    sec4.push(rowHtml(sx.listComplete ? "est" : "not", "Is the vault's address on a sanctions list?",
      `<p>${sx.status === "not-listed" ? "Not on the list checked" : `Status: ${esc(sx.status)}`}: ${esc(sx.list)}, snapshot ${esc(sx.snapshot)}${sx.listComplete ? "." : `. That list is a partial subset, so this is not a clearance.`}</p>`));
  }

  // ── provenance (generated from the report's own reads and sources, never static copy) ───────────
  const endpoints = [...new Set(r.reads.map((x) => x.endpoint))];
  const perEndpoint = endpoints.map((e) => r.reads.filter((x) => x.endpoint === e).length);
  const agreedAll = r.sources?.integrity?.providerDisagreement === false;
  const tot = r.coverage.totals;
  const v = ctx.verification;
  const prov = `<div class="prov">
<p><b>Read from ${esc(chainLabel(r))} at block ${fmtInt(r.subject.blockNumber)}</b>${ctx.blockTimestamp ? ` (produced ${esc(new Date(ctx.blockTimestamp * 1000).toISOString().replace(".000Z", " UTC"))}; this time was read from the chain by the page's build and is not part of the signed report)` : ""}.</p>
<p>Every read went to ${endpoints.length} endpoints (${endpoints.map((e) => `<code>${esc(new URL(e).host)}</code>`).join(" and ")}), ${fmtInt(r.reads.length)} reads in all (${perEndpoint.join(" + ")}). The report requires ${esc(String(r.sources?.required ?? endpoints.length))} of them to agree before it states a value. ${agreedAll ? "On this report they agreed on every read." : "On this report they did not agree on every read; each disagreement is listed below."}</p>
<p><b>Signed</b> by Tikpema's due-diligence agent, ERC-8004 agent <code>${esc(r.attestation.agentId)}</code> on Arc testnet, through the account that owns it (<code>${esc(r.attestation.verifyingContract)}</code>, ERC-1271). The signature is checked against the chain, not against a database of ours. ${r.subject.blockHash ? "It covers the block's hash and timestamp." : "It covers the block number, not the block's hash."}</p>
<p>${v?.valid === true ? `When this page was built (${esc(ctx.verifiedAt)}), the signature checked <b>valid</b> on chain.` : `When this page was built, the signature did not check valid (${esc(v?.reason ?? "unknown")}).`}</p>
<p class="counts">Checks run: ${tot.checked + tot.notChecked} · concluded: ${tot.checked} · did not conclude: ${tot.notChecked}</p>
</div>`;

  const att = r.attestation;
  const isValidCall = { to: att.verifyingContract, data: encodeIsValidSignature(ctx.digest, att.signature) };
  const verify = `<h2>Check it yourself</h2>
<p><b>1. One fact.</b> Each answer above has its commands: the exact read, at the report's block, on each endpoint. Paste one into a terminal and compare.</p>
<p><b>2. The signature.</b> The report's canonical digest is <code>${esc(ctx.digest)}</code>. Ask the signing account whether it signed that digest, and ask the registry who owns agent ${esc(att.agentId)}:</p>
${commands([
  { label: "isValidSignature(digest, signature) on the signing account", command: curlFor(ctx.identityRpc, "eth_call", [isValidCall, "latest"]), expect: "a result starting 0x1626ba7e (valid); anything else is not valid" },
  { label: `ownerOf(${att.agentId}) on the ERC-8004 registry`, command: curlFor(ctx.identityRpc, "eth_call", [{ to: att.registry, data: "0x6352211e" + BigInt(att.agentId).toString(16).padStart(64, "0") }, "latest"]), expect: `the signing account, ${att.verifyingContract.toLowerCase()} (left-padded)` },
])}
<p><b>3. That the digest is this report.</b> The digest is computed from the report's bytes by a published rule, <a href="${esc(ctx.specUrl)}">canon/1</a>. To recompute it and run both checks in one step: <a href="${esc(ctx.reportPath)}">download the signed report</a>, then from a clone of the source:</p>
<pre><code>${esc(ctx.verifierCommand)}</code></pre>
<p class="sub">${esc(att.validityMeaning ?? "")}</p>`;

  const notices = (ctx.notices ?? []).map((n) => `<div class="notice">${n}</div>`).join("\n");
  const body = `<div class="eyebrow">Signed due-diligence report · ${esc(chainLabel(r))}</div>
<h1>${esc(ctx.vaultLabel)}</h1>
<p class="mono">${esc(r.subject.address)} · chain ${esc(String(r.subject.chainId))}</p>
${notices}
${prov}
<h2>Who can touch your deposit</h2>
${sec1.join("\n")}
<h2>What can change without notice</h2>
${sec2.join("\n")}
<h2>Can you get out right now</h2>
${sec3.join("\n")}
<h2>What we could not establish</h2>
<p class="sub">These are results, not failures: each is a question the report did not settle, with the reason.</p>
${sec4.join("\n")}
${verify}
<footer>
<p class="not-this">This page is an inventory. It carries no score, no rating, no ranking and no recommendation, and it does not claim the vault is safe. A report is true at its block; it can stop being true at the next one.</p>
${(ctx.siblings ?? []).map((s) => `<p><a href="${esc(s.href)}">${esc(s.text)}</a></p>`).join("\n")}
<p>Report schema <code>${esc(r.schemaVersion)}</code> · <a href="${esc(ctx.reportPath)}">signed report (JSON)</a></p>
</footer>`;

  return page({ title: ctx.title, description: `What a signed report establishes about ${ctx.vaultLabel}, at block ${r.subject.blockNumber}, and what it could not establish.`, body });

  function absentRow(p) {
    return rowHtml("not", POWER_QUESTION[p.power] ?? p.power,
      `<p>The report found no function matching the signatures it searches for. That is not proof the vault cannot do this: a power can be reached without a named function. <span class="reach">What it would reach: ${esc(p.severityReach)}.</span></p>`,
      cmdsForRead(idsOf(checkById.get("shape:code@address"))));
  }
}

function rowHtml(state, q, bodyHtml, cmds = []) {
  return `<div class="row${state === "not" ? " not" : ""}">${state === "not" ? mark.notEstablished : mark.established}
<p class="q">${esc(q)}</p>${bodyHtml}${commands(cmds)}</div>`;
}

function checkQuestion(n) {
  if (n.kind === "power" && POWER_QUESTION[n.group]) return POWER_QUESTION[n.group];
  if (n.id === "owner:owner()") return "Who is the owner?";
  if (n.id === "owner:code@owner") return "Is the owner a key or a contract?";
  if (n.kind === "shape") return "What kind of contract is this (proxy, clone, plain)?";
  return `Check ${n.id}`;
}

/** A report that REFUSED is also a result: the page says what was declined and why, and nothing else. */
function renderRefusal(r, ctx) {
  const body = `<div class="eyebrow">Signed due-diligence report · declined</div>
<h1>${esc(ctx.vaultLabel)}</h1>
<p class="mono">${esc(r.subject.address)} · chain ${esc(String(r.subject.chainId))}</p>
${mark.notEstablished}
<p>The service declined to describe this contract at block ${fmtInt(r.subject.blockNumber ?? 0)}. Reason: ${esc(r.refusal.detail ?? r.refusal.reason)}</p>
<p>This is not a finding about the contract. It means a description would have been incomplete in a way that could read as reassuring, so none is given.</p>
<footer><p class="not-this">This page carries no score, no rating, no ranking and no recommendation.</p></footer>`;
  return page({ title: ctx.title, description: "A declined report.", body });
}

/** ABI-encode isValidSignature(bytes32,bytes) — kept local so the page's command is self-evidently built. */
export function encodeIsValidSignature(digest, sig) {
  const s = sig.replace(/^0x/, "");
  const len = s.length / 2;
  const padded = s + "0".repeat(((32 - (len % 32)) % 32) * 2);
  return "0x1626ba7e" + digest.replace(/^0x/, "") + (64).toString(16).padStart(64, "0") + len.toString(16).padStart(64, "0") + padded;
}
