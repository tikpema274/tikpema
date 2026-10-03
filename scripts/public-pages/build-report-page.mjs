#!/usr/bin/env node
// build-report-page.mjs — a signed report file → site/evidence/<slug>/{index.html, report.json}.
//
//   node scripts/public-pages/build-report-page.mjs <signed-report.json>
//
// ⛔ REFUSES TO WRITE ANYTHING unless the report's signature checks VALID on chain right now. A public page
// that says "signed" is a claim; the build makes it, so the build checks it. It also refuses a page that
// contains a banned word (see _shell.mjs), and re-reads the report it wrote to confirm the published JSON
// verifies too (what is downloaded is what was checked).
//
// Today this builds ONE page: the XyloVault-family vault on Arc testnet, the only vault family the deployed
// service recognises. Its report comes from the production signer (the operator mandate's hourly check
// signs one); this script does not sign anything.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyAttestation, attestationDigest } from "../../shared/onchain-analyze/attest.mjs";
import { renderReportPage } from "./render-report.mjs";
import { bannedWordsIn, quorumReader } from "./_shell.mjs";
import { keccak256, toHex } from "viem";
import { POWER_SIGS } from "../../shared/onchain-facts/index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const IDENTITY_RPC = "https://rpc.testnet.arc.io"; // where agent 851891 is registered (Arc testnet)

const XYLO = "0x240eb85458cd41361bd8c3773253a1d78054f747";
const PAGES = {
  [XYLO]: {
    slug: "xylo-testnet",
    title: "XyloVault report",
    vaultLabel: "A XyloVault-family vault on Arc testnet",
    notices: [
      `<p><b>Arc testnet. This vault holds test money.</b> It is shown because it is the only kind of vault the deployed Tikpema due-diligence service recognises today.</p>`,
      `<p class="not-this"><b>Tikpema's own vault feature uses this vault on testnet.</b> This page is not a recommendation of it, and neither is anything on it.</p>`,
    ],
    siblings: [{ href: "/evidence/galaxy-usdc-route-removal/", text: "A different kind of page: a dated on-chain record from Arc mainnet, not a signed report →" }],
  },
};

const file = process.argv[2];
if (!file) { console.error("usage: node scripts/public-pages/build-report-page.mjs <signed-report.json>"); process.exit(2); }
const raw = readFileSync(file, "utf8");
const report = JSON.parse(raw);
const cfg = PAGES[String(report?.subject?.address).toLowerCase()];
if (!cfg) { console.error(`no page is configured for subject ${report?.subject?.address}; refusing`); process.exit(1); }

const client = {
  async call({ method, params }) {
    const res = await fetch(IDENTITY_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  },
};

const verification = await verifyAttestation(report, { client });
if (verification.valid !== true) {
  console.error(`⛔ the signature does not check valid (${verification.reason}: ${verification.detail ?? ""}); nothing written`);
  process.exit(1);
}
const verifiedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

// The block's timestamp: NOT in a 0.3.0 report, so read it from the report's own endpoints (both must agree)
// and label it on the page as read by the build, not signed.
const endpoints = report.sources?.endpoints ?? [...new Set(report.reads.map((x) => x.endpoint))];
const q = quorumReader(endpoints);
const hdr = await q.read("eth_getBlockByNumber", ["0x" + BigInt(report.subject.blockNumber).toString(16), false]);
const blockTimestamp = Number(BigInt(hdr.answer.result.timestamp));

const outDir = join(ROOT, "site/evidence", cfg.slug);
const reportPath = `/evidence/${cfg.slug}/report.json`;
const html = renderReportPage(report, {
  ...cfg,
  blockTimestamp,
  verification, verifiedAt,
  digest: attestationDigest(report, { domain: report.attestation.domain }),
  reportPath,
  specUrl: "https://github.com/tikpema274/tikpema/blob/main/docs/dd-attestation-canon1.md",
  verifierCommand: "node scripts/public-pages/verify-report-file.mjs report.json",
  identityRpc: IDENTITY_RPC,
});
// ⭐ THE PRINTED ANSWERS ARE CHECKED AGAINST THE CHAIN (T, 2026-10-03: every command states its answer). Each read the page
// prints is re-run here, on ITS OWN endpoint at ITS pinned block, and compared with what the page says it returns —
// computed from the signed report's fields, independently of the renderer. A mismatch writes nothing.
{
  const sel = (sig) => keccak256(toHex(sig)).slice(2, 10);
  const present = report.powers.filter((p) => p.present).flatMap((p) => p.matched.map((m) => m.signature));
  const absent = report.powers.filter((p) => !p.present).flatMap((p) => POWER_SIGS[p.power] ?? []);
  const subj = report.subject.address.toLowerCase();
  const problems = [];
  for (const x of report.reads) {
    const res = await fetch(x.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: x.method, params: x.params }) }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
    if (res.error || typeof res.result !== "string") { problems.push(`${x.readId} ${x.method}: no usable answer (${JSON.stringify(res.error)})`); continue; }
    const v = res.result.toLowerCase(), a0 = String(x.method === "eth_call" ? x.params[0].to : x.params[0]).toLowerCase();
    if (x.method === "eth_getCode" && a0 === subj) {
      if ((v.length - 2) / 2 !== report.shape.evidence.ownCodeBytes) problems.push(`${x.readId}: code is ${(v.length - 2) / 2} bytes, the page says ${report.shape.evidence.ownCodeBytes}`);
      for (const sg of present) if (!v.includes(sel(sg))) problems.push(`${x.readId}: ${sg} (${sel(sg)}) is not in the code, the page says it is`);
      for (const sg of absent) if (v.includes(sel(sg))) problems.push(`${x.readId}: ${sg} (${sel(sg)}) IS in the code, the page says none appears`);
    } else if (x.method === "eth_getStorageAt") {
      if (v !== report.shape.evidence.implSlot.toLowerCase()) problems.push(`${x.readId}: slot is ${v}, the page says ${report.shape.evidence.implSlot}`);
    } else if (x.method === "eth_call") {
      if (v.slice(-40) !== report.owner.address.toLowerCase().slice(2)) problems.push(`${x.readId}: owner() is ${v}, the page says ${report.owner.address}`);
    } else if (x.method === "eth_getCode") {
      if (v !== "0x") problems.push(`${x.readId}: the owner has code, the page says 0x`);
    } else problems.push(`${x.readId}: ${x.method} has no stated answer to check`);
  }
  if (problems.length) { console.error(`⛔ the page's printed answers do not match the chain:\n  ${problems.join("\n  ")}\nnothing written`); process.exit(1); }
  console.log(`  ✓ all ${report.reads.length} printed reads re-run on their own endpoints: every answer is the one the page states`);
}
const banned = bannedWordsIn(html);
if (banned.length) { console.error(`⛔ the page contains banned words: ${banned.join(", ")}; nothing written`); process.exit(1); }

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 1) + "\n");
const reread = JSON.parse(readFileSync(join(outDir, "report.json"), "utf8"));
const v2 = await verifyAttestation(reread, { client });
if (v2.valid !== true || v2.digest !== verification.digest) {
  console.error(`⛔ the WRITTEN report does not verify identically (${v2.reason}); the page was not written`);
  process.exit(1);
}
writeFileSync(join(outDir, "index.html"), html);
console.log(`✅ ${outDir}/index.html + report.json — signature valid (digest ${verification.digest}), block ${report.subject.blockNumber} at ${new Date(blockTimestamp * 1000).toISOString()}`);
