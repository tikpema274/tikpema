// verify-register-identity-writes.mjs — proves the two write-safety fixes in register-identity.mjs.
//
// THE BUG THIS EXISTS FOR: running a DRY RUN (no --confirm) after registration took STEP 2's
// ALREADY-REGISTERED branch, which calls persistId() with txHash:null/circleTxId:null BEFORE the
// dry-run early-exit. writeFile does not merge, so a read-only-looking run overwrote a COMMITTED
// record and destroyed its on-chain provenance:
//
//     "txHash": "0xd33cb296…" → null      "circleTxId": "1d4ba798…" → null
//
// The agentId survived, so every existing guard passed. Two fixes, both tested here:
//   1. a dry run writes NOTHING to disk (the gate is at the write, not at each call site)
//   2. persistId never replaces a richer record with a poorer one (generalised from "protect agentId")
//
//   node scripts/verify-register-identity-writes.mjs          # offline: parts A + B
//   node --env-file=.env scripts/verify-register-identity-writes.mjs --live   # + part C, the real bug
//
// Part C spawns the REAL script in dry-run mode against the REAL wallet and chain, and asserts the
// committed record is byte-identical afterwards. That is the only test that would have caught the
// original defect, so a skipped part C is reported as NOT RUN — never as a pass.

import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergePreservingProvenance, PROVENANCE_FIELDS } from "./_identity-record.mjs";

const run = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO_ROOT, "scripts/register-identity.mjs");
const ID_FILE = path.join(REPO_ROOT, "agent-metadata/REGISTERED-IDENTITY-dd-service.json");

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 64 - t.length))}`);
const sha = (b) => createHash("sha256").update(b).digest("hex");

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  register-identity.mjs — WRITE SAFETY                                ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═══════════ PART A — never replace a richer record with a poorer one ═══════════
section("PART A — the never-downgrade invariant (pure, offline)");

const RICH = {
  agentId: "851891",
  owner: "0xc54D47211997aCA90Ef4fCfBc742a3b511B4e621",
  tokenURI: "ipfs://bafkreigton…",
  cid: "bafkreigton…",
  sha256: "d3734acc…",
  txHash: "0xd33cb296ba2dcc68c29e29cef055f9b959973b11eea3d0a97dadfa9437db20f1",
  circleTxId: "1d4ba798-adcb-50d1-85d4-9f0e1c961d5f",
  note: "REGISTERED by this run.",
};
// Exactly what the ALREADY-REGISTERED branch passes — the shape that caused the loss.
const POOR = {
  agentId: "851891",
  owner: "0xc54d47211997aca90ef4fcfbc742a3b511b4e621",
  tokenURI: "ipfs://bafkreigton…",
  cid: "bafkreigton…",
  sha256: "d3734acc…",
  txHash: null,
  circleTxId: null,
  note: "ALREADY REGISTERED — discovered by the existence check, not minted by this run.",
};

{
  const { merged, preserved } = mergePreservingProvenance(RICH, POOR);
  check("⭐ THE BUG: txHash is NOT nulled by the already-registered write", merged.txHash === RICH.txHash, merged.txHash?.slice(0, 18) + "…");
  check("⭐ THE BUG: circleTxId is NOT nulled", merged.circleTxId === RICH.circleTxId);
  check("both rescues are REPORTED, not silent", preserved.includes("txHash") && preserved.includes("circleTxId"), `preserved=[${preserved}]`);
  check("the new note IS applied (non-provenance fields still update)", merged.note === POOR.note);
  check("agentId is untouched by the merge (the guards own that field)", merged.agentId === "851891");
}

{
  // A genuinely richer write must win — merging must not freeze an old value in place.
  const { merged, preserved } = mergePreservingProvenance(POOR, RICH);
  check("a NEWER non-null value overwrites an older null", merged.txHash === RICH.txHash && preserved.length === 0);
}
{
  const { merged, preserved } = mergePreservingProvenance(null, POOR);
  check("no prior record → nothing preserved, record written as-is", merged.txHash === null && preserved.length === 0);
}
{
  const { merged, preserved } = mergePreservingProvenance(RICH, { ...POOR, txHash: "0xNEWER" });
  check("a DIFFERENT non-null value is NOT overridden by the prior one", merged.txHash === "0xNEWER" && !preserved.includes("txHash"));
}
{
  const { merged } = mergePreservingProvenance({ txHash: "0xold" }, { agentId: "1" });
  check("an ABSENT field counts as losing, same as an explicit null", merged.txHash === "0xold");
}
{
  const { merged, preserved } = mergePreservingProvenance(RICH, RICH);
  check("re-persisting an identical record is a no-op", preserved.length === 0 && merged.txHash === RICH.txHash);
}
check("every provenance field is covered", PROVENANCE_FIELDS.length >= 6 && PROVENANCE_FIELDS.includes("txHash") && PROVENANCE_FIELDS.includes("circleTxId"), PROVENANCE_FIELDS.join(","));
check("agentId is deliberately NOT merge-governed (one mechanism per field)", !PROVENANCE_FIELDS.includes("agentId"));

// ═══════════ PART B — the agentId guards must STILL hold ═══════════
section("PART B — the original agentId protection is UNCHANGED");

const src = await readFile(SCRIPT, "utf8");
check("guard: refuses a DIFFERENT agentId", /already records agentId \$\{prior\.agentId\}, and this run wants to write/.test(src));
check("guard: refuses to blank a KNOWN agentId with null", /null agentId \(pre-settlement handle\)\. That would erase a known id/.test(src));
check("both guards still call die() (refuse, not warn)", (src.match(/die\(`\$\{ID_FILE\} already records agentId/g) ?? []).length === 2);
check("the never-downgrade guard PRESERVES rather than dying (guards refuse, merge rescues)", /mergePreservingProvenance\(prior, record\)/.test(src));
check("⭐ every disk write now routes through the gate", (src.match(/await writeFile\(/g) ?? []).length === 2, "writeArtifact + persistId only");
check("the gate is a single flag, not a per-call-site check", /const WRITES_ENABLED = CONFIRM \|\| Boolean\(RESUME_TX\)/.test(src));
check("persistId returns early when writes are disabled", /if \(!WRITES_ENABLED\) \{[\s\S]{0,400}?left byte-identical/.test(src));

// ═══════════ PART C — the real thing ═══════════
section("PART C — a DRY RUN leaves the committed record byte-identical");

if (!process.argv.includes("--live")) {
  console.log("  ⚠️  NOT RUN — this is the only part that would have caught the original defect.");
  console.log("      Re-run with:  node --env-file=.env scripts/verify-register-identity-writes.mjs --live");
  console.log("      (a skip is NOT a pass — parts A and B cannot observe a real disk write)");
} else {
  const before = await readFile(ID_FILE);
  const beforeSha = sha(before);
  const beforeMtime = (await stat(ID_FILE)).mtimeMs;
  console.log(`  record before: sha ${beforeSha.slice(0, 16)}…`);

  let out = "";
  try {
    const r = await run(process.execPath, ["--env-file=.env", SCRIPT, "--target", "dd-service"], { cwd: REPO_ROOT, timeout: 240000 });
    out = r.stdout;
  } catch (e) {
    out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
  }

  const after = await readFile(ID_FILE);
  const afterSha = sha(after);
  check("⭐ THE EXACT BUG: the record is BYTE-IDENTICAL after a dry run", beforeSha === afterSha, `${beforeSha.slice(0, 12)}… → ${afterSha.slice(0, 12)}…`);
  check("  …and it was not even rewritten with the same bytes (mtime unchanged)", (await stat(ID_FILE)).mtimeMs === beforeMtime);
  check("  …txHash provenance survived", JSON.parse(after).txHash === JSON.parse(before).txHash, JSON.parse(after).txHash?.slice(0, 14) + "…");
  check("  …circleTxId provenance survived", JSON.parse(after).circleTxId === JSON.parse(before).circleTxId);
  check("the run still reached the ALREADY-REGISTERED branch (the fix did not skip the check)", /ALREADY REGISTERED/.test(out));
  check("it SAYS it suppressed the write rather than staying silent", /NOT writing/.test(out), (out.match(/⃠[^\n]*/g) ?? [])[0]?.slice(0, 60) ?? "");
  check("the NFT dump was also suppressed (every write, not just the record)", /raw dump not written|NOT writing the raw NFT enumeration/.test(out));
}

console.log(`\n╔══════════════════════════════════════════════════════════════════════`);
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES PRESENT"}   pass ${pass} / fail ${fail}`);
console.log(`╚══════════════════════════════════════════════════════════════════════`);
process.exit(fail === 0 ? 0 : 1);
