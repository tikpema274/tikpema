#!/usr/bin/env node
// verify-public-pages.mjs — test:evidence. Offline: zero network, zero money.
//
// What it pins:
//   A. "NOT ESTABLISHED" IS A RESULT. Every coverage.notChecked entry renders as its own row with its reason
//      sentence; every absent power renders as not established (absence is not proof); the counts line comes
//      from coverage.totals. The live xylo report has 0 notChecked, so section A forces each reason in.
//   B. NO VERDICT WORDS. Every page, real and synthetic, passes bannedWordsIn; the check itself catches a
//      planted word and ignores the disclaimer element.
//   C. REFUSE, DON'T OMIT. An unknown schema or a V2 field the renderer cannot draw throws; a refusal report
//      renders as declined, with no inventory.
//   D. THE PUBLISHED PAGE IS THE PUBLISHED REPORT. The committed page names the digest that the committed
//      report.json canonicalises to, and its block.
//   E. THE GALAXY RECORD. assertFacts rejects each fact that no longer holds; the render follows the reads.
//   F. AGE IN THE VIEWER'S BROWSER. ageOf at the edges; the page inlines ageOf's own source; the inline script,
//      RUN against a stub DOM, shows the banner past the threshold and not before; no block time → refuse.
//   H. THE THREE 10-03 FIXES (T). Every printed command states its answer AND how to read it (fresh renders and the
//      committed pages); the curl line appears once, above the first command; ONE date format; the Galaxy age sits inside
//      the sentence it qualifies, the removal in its own; a read the renderer cannot explain refuses.
//   G. ONE MANIFEST. Every file under site/evidence is in siteFiles(); the deployer and the gate both read it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, parseAbi } from "viem";
import { renderReportPage, encodeIsValidSignature, SCHEMA_SCOPE } from "./render-report.mjs";
import { bannedWordsIn, ageOf, STALE_AFTER_DAYS, commands, ageBlock, HOWTO_RUN } from "./_shell.mjs";
import { siteFiles } from "../lib/marketing-site.mjs";
import { readdirSync } from "node:fs";
import vm from "node:vm";
import { assertFacts, renderCase } from "./build-galaxy-case.mjs";
import { attestationDigest } from "../../shared/onchain-analyze/attest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 66 - t.length))}`);
const count = (s, needle) => s.split(needle).length - 1;
const clone = (o) => JSON.parse(JSON.stringify(o));

const REPORT = JSON.parse(readFileSync(join(ROOT, "site/evidence/xylo-testnet/report.json"), "utf8"));
const PAGE = readFileSync(join(ROOT, "site/evidence/xylo-testnet/index.html"), "utf8");
const CTX = {
  title: "t", vaultLabel: "A vault", notices: [], blockTimestamp: 1790000000,
  verification: { valid: true, reason: "ok" }, verifiedAt: "2026-10-02T00:00:00Z",
  digest: "0x" + "ab".repeat(32), reportPath: "/r.json", specUrl: "https://example.invalid/spec",
  verifierCommand: "node verify r.json", identityRpc: "https://rpc.testnet.arc.io",
};
const NOT = 'class="m m-not"';
const EST = 'class="m m-est"';

section("A. not established is a result");
{
  const html = renderReportPage(REPORT, CTX);
  const absent = REPORT.powers.filter((p) => !p.present).length;
  const presentN = REPORT.powers.filter((p) => p.present).length;
  check(`every present power is an established row (${presentN})`, REPORT.powers.filter((p) => p.present).every((p) => html.includes(p.matched[0].signature)));
  check("every absent power renders 'not proof the vault cannot do this'", count(html, "That is not proof the vault cannot do this") === absent, `got ${count(html, "That is not proof the vault cannot do this")} want ${absent}`);
  const Q = { pausable: "Can someone pause the vault?", upgradeable: "Can someone replace the vault&#39;s code?", denylist: "Can someone block a specific depositor?", withdrawalDelay: "Can someone delay withdrawals?" };
  for (const p of REPORT.powers.filter((p) => !p.present)) {
    check(`absent power '${p.power}' is drawn NOT established`, new RegExp(`\\? Not established</span>\\s*<p class="q">${Q[p.power].replace(/[?]/g, "\\?")}`).test(html));
  }
  // ⭐ THE TWO COUNTS (T 2026-10-03): questions counted from the RENDERED rows, reads from coverage.totals.
  const qm = html.match(/Of the (\d+) questions on this page, (\d+) (?:is|are) established and (\d+) (?:is|are) not established/);
  check("the questions line exists", !!qm);
  check("its numbers are the page's own rendered rows", qm && Number(qm[2]) === count(html, EST) && Number(qm[3]) === count(html, NOT) && Number(qm[1]) === count(html, EST) + count(html, NOT),
    qm ? `${qm.slice(1).join("/")} vs est ${count(html, EST)} not ${count(html, NOT)}` : "");
  const ranN = REPORT.coverage.totals.checked + REPORT.coverage.totals.notChecked;
  check("the reads line comes from coverage.totals and says what it does NOT mean", html.includes(`the report ran ${ranN} checks against the chain, and all ${ranN} got an answer`) && html.includes("It does not say the questions are answered."));
  check("the questions line comes BEFORE the reads line", html.indexOf('class="q-count"') > 0 && html.indexOf('class="q-count"') < html.indexOf('class="r-count"'));
  check("the old single counts line is gone", !html.includes("Checks run:") && !html.includes("did not conclude:"));
  for (const k of ["delays", "exit", "holderAttribution"]) check(`schema scope '${k}' is stated`, html.includes(SCHEMA_SCOPE[REPORT.schemaVersion][k].slice(0, 40).replace(/'/g, "&#39;").replace(/"/g, "&quot;")));
  check("the partial sanctions list is NOT drawn as established", /\? Not established<\/span>\s*<p class="q">Is the vault&#39;s address on a sanctions list\?/.test(html));

  // Force three checks to not conclude, one per reason family.
  const r = clone(REPORT);
  const take = (id) => { const i = r.coverage.checked.findIndex((c) => c.id === id); return r.coverage.checked.splice(i, 1)[0]; };
  const p1 = take("power:pausable");
  r.coverage.notChecked.push({ ...p1, outcome: undefined, reason: "rpc-unreadable", detail: "timeout" });
  r.powers = r.powers.filter((p) => p.power !== "pausable");
  const o = take("owner:owner()");
  r.coverage.notChecked.push({ ...o, reason: "rpc-disagreement", responses: [{ endpoint: "a", result: "0x1" }, { endpoint: "b", result: "0x2" }] });
  const p2 = take("power:denylist");
  r.coverage.notChecked.push({ ...p2, reason: "not-applicable", why: "the code is a diamond; facets were not scanned" });
  r.powers = r.powers.filter((p) => p.power !== "denylist");
  r.coverage.totals = { checked: r.coverage.checked.length, notChecked: r.coverage.notChecked.length };
  const h2 = renderReportPage(r, CTX);
  check("rpc-unreadable renders its sentence", h2.includes("This is not a &quot;no&quot;: we do not know."));
  check("rpc-disagreement renders its sentence AND both answers", h2.includes("We do not pick one") && h2.includes("&quot;0x1&quot;") && h2.includes("&quot;0x2&quot;"));
  check("not-applicable renders its stated reason", h2.includes("facets were not scanned"));
  check("a not-concluded power keeps its question", h2.includes("Can someone pause the vault?") && h2.includes("Can someone block a specific depositor?"));
  check("an unread owner is NOT stated as established", !h2.includes("The vault&#39;s owner is"));
  // +3 forced notChecked rows; −2 because pausable and denylist were ABSENT powers (already not-established
  // rows) and are now notChecked instead; the owner row was established, so it moves no not-established count.
  check("not-established rows = base + 3 forced − 2 absent rows they replace", count(h2, NOT) === count(html, NOT) + 3 - 2,
    `base ${count(html, NOT)} → ${count(h2, NOT)}`);
  const q2 = h2.match(/Of the (\d+) questions on this page, (\d+) (?:is|are) established and (\d+) (?:is|are) not established/);
  check("forced: the questions line follows the rows (not a typed number)", q2 && Number(q2[2]) === count(h2, EST) && Number(q2[3]) === count(h2, NOT) && q2[0] !== qm[0]);
  check("forced: the reads line says 3 did not get an answer", h2.includes("got an answer and 3 did not"));
  check("synthetic page carries no verdict words", bannedWordsIn(h2).length === 0, bannedWordsIn(h2).join(","));

  const r3 = clone(REPORT);
  r3.sources.integrity.providerDisagreement = true;
  check("provenance does not claim agreement when the report records a disagreement", !renderReportPage(r3, CTX).includes("they agreed on every read"));
  check("a number-only signature says so", html.includes("It covers the block number, not the block's hash."));
  const r4 = clone(REPORT); r4.shape.evidence.shapesNotTestedFor[0] = '<img src=x onerror="alert(1)">';
  check("report strings are escaped", !renderReportPage(r4, CTX).includes("<img src=x"));
  check("not-established is distinguished by outline only (no hazard red, no grey-out)", !/#e5484d|opacity|color:\s*grey|color:\s*gray/i.test(html));
}

section("B. no verdict words");
check("the committed xylo page", bannedWordsIn(PAGE).length === 0, bannedWordsIn(PAGE).join(","));
check("a planted word is caught", bannedWordsIn("<p>This vault is safe.</p>").includes("safe"));
check("the disclaimer element is exempt", bannedWordsIn('<p class="not-this">no score, no rating</p>').length === 0);
check("an identifier containing a word is not a hit", bannedWordsIn("<code>ErrorsLib.Unauthorized()</code>").length === 0);
check("markup attributes are not text", bannedWordsIn('<a title="safe" href="#">x</a>').length === 0);

section("C. refuse, don't omit");
{
  let threw = false; try { renderReportPage({ ...clone(REPORT), schemaVersion: "onchain-analyze/9.9.9" }, CTX); } catch { threw = true; }
  check("an unknown schema version refuses", threw);
  threw = false; try { renderReportPage({ ...clone(REPORT), powersV2: { powers: [] } }, CTX); } catch { threw = true; }
  check("a report carrying powersV2 refuses (this renderer cannot draw it)", threw);
  const ref = renderReportPage({ ...clone(REPORT), refusal: { reason: "unrecognised-vocabulary", detail: "the governance code is not one the service recognises" } }, CTX);
  check("a refusal renders as declined", ref.includes("declined to describe") && ref.includes("not one the service recognises"));
  check("a refusal shows no inventory", !ref.includes("Who can touch your deposit"));
}

section("D. the published page is the published report");
{
  const digest = attestationDigest(REPORT, { domain: REPORT.attestation.domain });
  check("the page names the digest report.json canonicalises to", PAGE.includes(digest), digest);
  check("the page names the report's block", PAGE.includes(BigInt(REPORT.subject.blockNumber).toLocaleString("en-US")));
  check("the page's isValidSignature call encodes the same digest + signature",
    PAGE.includes(encodeIsValidSignature(digest, REPORT.attestation.signature)));
  const viemEnc = encodeFunctionData({ abi: parseAbi(["function isValidSignature(bytes32,bytes) view returns (bytes4)"]), functionName: "isValidSignature", args: [digest, REPORT.attestation.signature] });
  check("the local encoder matches viem's ABI encoding", viemEnc === encodeIsValidSignature(digest, REPORT.attestation.signature));
}

section("E. the Galaxy record");
{
  const z = "0x0000000000000000000000000000000000000000";
  const TXH = "0x87283833bf59c19101eb6f3f374017fd757059df7ef8ad4323fb5dbc516d8383";
  const pad = (h) => "0x" + h.replace(/^0x/, "").padStart(64, "0");
  const ANS = {
    adapterBefore: pad("ee0080203a76690bca40670dfd0cd1c30fab7c2c"), adapterAfter: pad("0"), adapterNow: pad("0"),
    totalAssetsAt: pad((84807145536819n).toString(16)), totalAssetsNow: pad((89710305440370n).toString(16)), idleNow: pad("0"),
    senderCode: "0x", isAllocator: pad("1"), control: pad("de228c6ff26e984"),
    logs: [{ transactionHash: TXH, topics: ["0x9deb43d71422af41853c3921fb364b7647f9a9b136e46d66d45c1bf707af706c", pad("43e4a89e8f8cea5006e0eaefd12d746a5967a537"), pad("0"), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"] }],
    receipt: { status: "0x1", from: "0x43e4a89e8f8cea5006e0eaefd12d746a5967a537", to: "0x8e357432cc12ff425c36432f312968aeb16112af" },
    withdraw: undefined,
  };
  const reads = Object.fromEntries(Object.keys(ANS).map((k) => [k, { answer: k === "withdraw" ? { error: { code: 3, data: "0xace2a47e" } } : { result: ANS[k] }, commands: [{ endpoint: "https://rpc.mainnet.arc.io", command: "curl …" }] }]));
  const good = {
    reads, chainId: 5042, adapterBefore: "0xeE0080203a76690BcA40670dfd0cD1C30FAB7c2C", adapterAfter: z, newAdapter: z,
    sender: "0x43e4a89e8f8cea5006e0eaefd12d746a5967a537", txStatus: "0x1", txFrom: "0x43e4a89e8f8cea5006e0eaefd12d746a5967a537",
    txTo: "0x8E357432CC12ff425c36432F312968aEb16112AF", senderCode: "0x", senderIsAllocator: true, blockTimestamp: 1790702635,
    totalAssetsAt: 84807145536819n, now: 23930903n, nowTimestamp: 1790950000, adapterNow: z, idleNow: 0n, totalAssetsNow: 89710305440370n,
    withdrawOk: false, withdrawRevert: "0xace2a47e", controlOk: true,
  };
  check("the measured facts hold", assertFacts(good).length === 0, assertFacts(good).join("; "));
  for (const [k, v, why] of [["adapterAfter", "0x1111111111111111111111111111111111111111", "not unset"], ["senderCode", "0x6080", "has code"], ["senderIsAllocator", false, "not an allocator"], ["txStatus", "0x0", "did not succeed"], ["adapterBefore", z, "already unset"]]) {
    check(`assertFacts rejects: ${why}`, assertFacts({ ...good, [k]: v }).length === 1);
  }
  const h = renderCase(good);
  check("the case says it is not a signed report, at the top", h.indexOf("not a due-diligence report") < h.indexOf("What happened"));
  check("the case states the revert and the control", h.includes("TransferReverted()") && h.includes("goes through, so the revert is the empty idle balance"));
  check("the case names the chain id it READ", h.includes("chain 5042<"));
  check("the case says the money is not shown to be gone", h.includes("Is the money gone?"));
  check("the case carries no verdict words", bannedWordsIn(h).length === 0, bannedWordsIn(h).join(","));
  const hc = renderCase({ ...good, controlOk: false });
  check("a failed control is disclosed, not hidden", hc.includes("does not isolate the cause"));
  const hr = renderCase({ ...good, adapterNow: "0x2222222222222222222222222222222222222222" });
  check("a restored route renders as restored", hr.includes("No. The liquidity adapter is"));
  const committed = readFileSync(join(ROOT, "site/evidence/galaxy-usdc-route-removal/index.html"), "utf8");
  check("the committed case page carries no verdict words", bannedWordsIn(committed).length === 0, bannedWordsIn(committed).join(","));
}

section("F. age is computed in the viewer's browser");
{
  const day = 86400, now = Date.UTC(2026, 9, 20) ;
  const ts = now / 1000;
  check("0 days → less than a day, not stale", ageOf(ts - 60, now, 7).text === "less than a day old" && !ageOf(ts - 60, now, 7).stale);
  check("6 days → not stale", ageOf(ts - 6 * day - 60, now, 7).stale === false);
  check("7 days → stale (the threshold is inclusive)", ageOf(ts - 7 * day - 60, now, 7).stale === true);
  check("a block time in the future → cannot tell, not 'fresh'", ageOf(ts + 3600, now, 7).days === null);
  check("an unreadable block time → cannot tell", ageOf("x", now, 7).days === null && ageOf(0, now, 7).days === null);
  for (const [name, html] of [["xylo", PAGE], ["galaxy", readFileSync(join(ROOT, "site/evidence/galaxy-usdc-route-removal/index.html"), "utf8")]]) {
    check(`${name}: the page inlines ageOf's OWN source`, html.includes(ageOf.toString()));
    check(`${name}: the threshold written is STALE_AFTER_DAYS`, html.includes(`data-stale-days="${STALE_AFTER_DAYS}"`));
    const m = html.match(/data-block-ts="(\d+)"/);
    check(`${name}: a block time is written`, !!m && Number(m[1]) > 1.7e9);
    check(`${name}: the 'as of' line sits above the first notice`, html.indexOf('class="asof"') < (html.indexOf('class="notice"') === -1 ? Infinity : html.indexOf('class="notice"')));
    // RUN the page's inline script against a stub DOM at two clocks.
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const tmpl = html.match(/data-template="([^"]*)"/)[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const runAt = (nowMs) => {
      const rel = { textContent: "" }, banner = { hidden: true, innerHTML: "", getAttribute: () => tmpl };
      const asof = { getAttribute: (a) => (a === "data-block-ts" ? m[1] : String(STALE_AFTER_DAYS)), querySelector: () => rel };
      const document = { querySelector: (q) => (q === "[data-block-ts]" ? asof : banner) };
      vm.runInNewContext(script, { document, Date: { now: () => nowMs }, Number, Math, isFinite });
      return { rel: rel.textContent, banner };
    };
    const fresh = runAt(Number(m[1]) * 1000 + 2 * 86400e3);
    check(`${name}: at 2 days the age shows and the banner stays hidden`, fresh.rel.includes("2 days old") && fresh.banner.hidden === true);
    const old = runAt(Number(m[1]) * 1000 + 40 * 86400e3);
    check(`${name}: at 40 days the banner shows, naming the age`, old.banner.hidden === false && old.banner.innerHTML.includes("40 days old") && !old.banner.innerHTML.includes("{age}"));
    check(`${name}: the banner text carries no verdict words`, bannedWordsIn(`<p>${old.banner.innerHTML}</p>`).length === 0, bannedWordsIn(`<p>${old.banner.innerHTML}</p>`).join(","));
  }
  let threw = false; try { renderReportPage(REPORT, { ...CTX, blockTimestamp: null }); } catch { threw = true; }
  check("no block time → the report page refuses to render (it could not show its age)", threw);
}

section("G. one manifest");
{
  const walk = (d) => readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]);
  const onDisk = walk("site/evidence").map((p) => p.replace(/^site\//, ""));
  const man = siteFiles(join(ROOT, "site"));
  check("every file under site/evidence is in the manifest", onDisk.every((f) => man.includes(f)), onDisk.filter((f) => !man.includes(f)).join(","));
  check("the front page is in the manifest", man.includes("index.html"));
  check("netlify.toml and README.md are NOT published", !man.includes("netlify.toml") && !man.includes("README.md"));
  for (const f of ["scripts/deploy-site.mjs", "scripts/verify-site-live.mjs"]) {
    const src = readFileSync(join(ROOT, f), "utf8").replace(/^\s*\/\/.*$/gm, "");
    check(`${f} reads siteFiles()`, /siteFiles\(\)/.test(src));
    check(`${f} names no single published file directly`, !/readFileSync\(\s*"site\/index\.html"/.test(src) && !/copyFileSync\(\s*"site\/index\.html"/.test(src));
  }
}

section("H. the three 10-03 fixes");
{
  const visible = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, " ");
  // Counts NON-EMPTY answers: an element with nothing after "Expected:" / "How to read it:" is not an answer.
  const tally = (h) => ({ cmd: count(h, '<div class="cmd">'),
    exp: (h.match(/<div class="cmd-expect">Expected: <code>([^<]*)<\/code><\/div>/g) ?? []).filter((m) => !/<code><\/code>/.test(m)).length,
    rd: (h.match(/<div class="cmd-read">How to read it: ([^<]*)<\/div>/g) ?? []).filter((m) => m.replace(/<[^>]+>|How to read it:/g, "").trim().length > 0).length });
  const z = "0x0000000000000000000000000000000000000000";
  const gFacts = (() => { // the E fixture, rebuilt here so H stands alone
    const pad = (x) => "0x" + x.replace(/^0x/, "").padStart(64, "0");
    const TXH = "0x87283833bf59c19101eb6f3f374017fd757059df7ef8ad4323fb5dbc516d8383";
    const A = { adapterBefore: pad("ee0080203a76690bca40670dfd0cd1c30fab7c2c"), adapterAfter: pad("0"), adapterNow: pad("0"), totalAssetsAt: pad("4d2f"), totalAssetsNow: pad("4d30"), idleNow: pad("0"), senderCode: "0x", isAllocator: pad("1"), control: pad("1"),
      logs: [{ transactionHash: TXH, topics: ["0x9d", pad("43e4"), pad("0"), "0xc5"] }], receipt: { status: "0x1", from: "0x43e4", to: "0x8e35" } };
    const reads = Object.fromEntries([...Object.keys(A), "withdraw"].map((k) => [k, { answer: k === "withdraw" ? { error: { data: "0xace2a47e" } } : { result: A[k] }, commands: [{ endpoint: "https://rpc.mainnet.arc.io", command: "curl …" }, { endpoint: "https://arc-mainnet.drpc.org", command: "curl …" }] }]));
    return { reads, chainId: 5042, adapterBefore: "0xeE0080203a76690BcA40670dfd0cD1C30FAB7c2C", adapterAfter: z, newAdapter: z, sender: "0x43e4a89e8f8cea5006e0eaefd12d746a5967a537", txStatus: "0x1",
      txFrom: "0x43e4a89e8f8cea5006e0eaefd12d746a5967a537", txTo: "0x8E357432CC12ff425c36432F312968aEb16112AF", senderCode: "0x", senderIsAllocator: true, blockTimestamp: 1790702635,
      totalAssetsAt: 84807145536819n, now: 23930903n, nowTimestamp: 1790950000, adapterNow: z, idleNow: 0n, totalAssetsNow: 89710305440370n, withdrawOk: false, withdrawRevert: "0xace2a47e", controlOk: true };
  })();
  const fresh = { xylo: renderReportPage(REPORT, CTX), galaxy: renderCase(gFacts) };
  const committed = { xylo: PAGE, galaxy: readFileSync(join(ROOT, "site/evidence/galaxy-usdc-route-removal/index.html"), "utf8") };
  for (const [kind, set] of [["fresh", fresh], ["committed", committed]]) for (const [name, h] of Object.entries(set)) {
    const t = tally(h);
    check(`${kind} ${name}: every command states an expected answer AND how to read it (${t.cmd})`, t.cmd > 0 && t.exp === t.cmd && t.rd === t.cmd, JSON.stringify(t));
    check(`${kind} ${name}: the curl line appears exactly once`, count(h, '<p class="howto">') === 1);
    check(`${kind} ${name}: …above the first command`, h.indexOf('<p class="howto">') < h.indexOf('<details class="cmds">'));
    check(`${kind} ${name}: no ISO "T…Z" stamp anywhere a reader sees`, !/\d{4}-\d\d-\d\dT\d\d:\d\d/.test(visible(h)));
    check(`${kind} ${name}: dates read "YYYY-MM-DD HH:MM UTC"`, /\d{4}-\d\d-\d\d \d\d:\d\d UTC/.test(visible(h)));
  }
  check("the curl line says curl, macOS/Linux, and the Windows route", /curl/.test(HOWTO_RUN) && /macOS or Linux/.test(HOWTO_RUN) && /WSL or Git Bash/.test(HOWTO_RUN));
  // The Galaxy age: inside the reads sentence (right after its date, before its full stop); the removal in its OWN paragraph.
  const g = fresh.galaxy;
  const first = g.match(/<p class="asof" data-block-ts="\d+"[^>]*>([\s\S]*?)<\/p>/)[1];
  check("galaxy: the age span sits inside the reads sentence, before its full stop", /UTC\)<span class="age-rel"><\/span>\.$/.test(first.trim()), first.slice(-80));
  check("galaxy: the reads sentence does not mention the removal", !/removal/i.test(first));
  const second = g.slice(g.indexOf(first) + first.length).match(/<p class="asof">([\s\S]*?)<\/p>/);
  check("galaxy: the removal is its own paragraph, with no age span", !!second && /The removal at block 23,403,623/.test(second[1]) && !second[1].includes("age-rel"));
  check("xylo: the age span sits inside the 'Report from block' sentence", /produced \d{4}-\d\d-\d\d \d\d:\d\d UTC<span class="age-rel"><\/span>\./.test(fresh.xylo));
  let threw = false; try { ageBlock({ blockTs: 1, asOfHtml: "no placeholder", staleHtml: "x" }); } catch { threw = true; }
  check("ageBlock refuses a sentence without {age}", threw);
  threw = false; try { commands([{ label: "x", command: "curl", expect: "0x" }]); } catch { threw = true; }
  check("commands() refuses a command without a how-to-read line", threw);
  threw = false; try { commands([{ label: "x", command: "curl", read: "r" }]); } catch { threw = true; }
  check("commands() refuses a command without an expected answer", threw);
  const rx = clone(REPORT);
  rx.reads.push({ readId: "r99", endpoint: "https://rpc.testnet.arc.io", method: "eth_getBalance", params: [rx.subject.address, "0x1"], reproduce: "curl …" });
  rx.coverage.checked.find((c) => c.id === "shape:code@address").readIds.push("r99");
  threw = false; try { renderReportPage(rx, CTX); } catch { threw = true; }
  check("a read the renderer cannot explain refuses the page (no undecoded command reaches a reader)", threw);
  // The answers the xylo page states are the SIGNED report's: owner padded, impl slot, code size.
  check("xylo: owner() states the signed owner, left-padded", fresh.xylo.includes("0x" + REPORT.owner.address.toLowerCase().slice(2).padStart(64, "0")));
  check("xylo: the code read states the signed code size", fresh.xylo.includes(`(${REPORT.shape.evidence.ownCodeBytes.toLocaleString("en-US")} bytes of code)`));
  check("galaxy: each USDC read converts its own raw value", g.includes("0x" + "4d2f".padStart(64, "0") + " = 0.01 USDC"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
