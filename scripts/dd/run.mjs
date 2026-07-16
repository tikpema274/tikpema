// run.mjs — the runner. Prints facts and the evidence they were read from. Nothing else.
//
// ⚠️ NO SUMMARY, NO ROLL-UP, NO SCORE. The temptation at the end of a run is a tidy verdict line —
// "3 checks, 1 problem". That line is the product turning into an opinion, and it is where a DD tool
// starts being believed instead of checked. The runner's job is to make facts legible and their
// provenance one copy-paste away. Reading them is the analyst's job, and the analyst is the user.
//
//   node scripts/dd/run.mjs code-exists --address 0x036CbD53842c5426634e7929541eC2318f3dCF7e --chain arc-testnet
//   node scripts/dd/run.mjs --list
//   … --json     full machine-readable fact (evidence untruncated) for piping/archiving
//
// NOT WIRED TO PROD. scripts/dd/ imports nothing from netlify/ or src/, and prod imports nothing
// from here. It reads public chain state; it holds no key and signs nothing.

import * as codeExists from "./checks/code-exists.mjs";
import * as repoAddressAudit from "./checks/repo-address-audit.mjs";
import * as ownerPowers from "./checks/owner-powers.mjs";
import * as payToVsToken from "./checks/payto-vs-token.mjs";

// Adding a check is one line here + one file in checks/.
const CHECKS = [codeExists, repoAddressAudit, ownerPowers, payToVsToken];
const byId = new Map(CHECKS.map((c) => [c.id, c]));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[k] = true;
      else (out[k] = next), i++;
    } else out._.push(a);
  }
  return out;
}

const trunc = (s, n = 80) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s);

/** Human view. The full, untruncated evidence is always one `--json` away. */
function print(fact) {
  const mark = fact.status === "observed" ? "▪" : "✖";
  console.log(`\n${mark} ${fact.check}  [${fact.status}]  ${fact.observedAt}`);
  console.log(`  input    : ${JSON.stringify(fact.input)}`);

  if (fact.status === "error") {
    // Loud, and explicitly not a finding — the distinction this engine is built on.
    console.log(`  error    : ${fact.error}`);
    console.log(`  result   : (none — INDETERMINATE, not a negative observation)`);
  } else if (Array.isArray(fact.result?.flags)) {
    // Composite (repo-address-audit): render each flag with its provenance. Still no verdict — the
    // counts say what was CLASSIFIED, not what it means, and every flag ships its own curls.
    console.log(`  scanned  : ${fact.result.addressesFound} unique address(es) from ${fact.evidence.extraction.occurrences} occurrence(s)`);
    console.log(`  classified:`);
    for (const [k, v] of Object.entries(fact.result.classified)) console.log(`      ${String(v).padStart(3)} × ${k}`);
    console.log(`  flags    : ${fact.result.flags.length}`);
    for (const f of fact.result.flags) {
      console.log(`\n    ── ${f.address}`);
      console.log(`       classification : ${f.classification}`);
      console.log(`       on ${String(f.claimedChain).padEnd(12)}: ${JSON.stringify(f.onClaimedChain)}`);
      for (const l of f.liveOn) {
        console.log(`       LIVE on ${l.chain.padEnd(9)}: ${l.bytecodeBytes} bytes @ block ${l.blockNumber}  codeHash=${l.codeHash.slice(0, 16)}…`);
      }
      console.log(`       source :`);
      for (const s of f.source.slice(0, 4)) {
        const d = s.declaredChainId ? `  [site declares chainId ${s.declaredChainId} @ line ${s.declaredAt.line}]` : `  [no chainId declared near site]`;
        console.log(`         ${s.file}:${s.line}  ${trunc(s.text, 76)}${d}`);
      }
      if (f.source.length > 4) console.log(`         …and ${f.source.length - 4} more site(s)`);
      console.log(`       re-verify:`);
      if (f.reproduce.claimedChain) console.log(`         claimed  : ${f.reproduce.claimedChain}`);
      for (const o of f.reproduce.otherChains) console.log(`         ${o.chain.padEnd(9)}: ${o.curl}`);
      console.log(`         source   : ${f.reproduce.source}`);
    }

    // Suppressions are PRINTED, never hidden. A refinement that silences quietly is a place for real
    // bugs to live; the reader must be able to re-check every suppression's declared chainId.
    if (fact.result.suppressed?.length) {
      console.log(`\n  suppressed: ${fact.result.suppressed.length} (declared-foreign, confirmed live there — shown so you can audit the suppression)`);
      for (const s of fact.result.suppressed) {
        console.log(`\n    ── ${s.address}  (would have been ${s.wouldHaveBeen})`);
        console.log(`       reason : ${s.reason}`);
        for (const d of s.declaredBy) {
          console.log(`       site   : ${d.file}:${d.line}  declares chainId ${d.declaredChainId} (${d.declaredChain}) @ line ${d.declaredAt.line}`);
          console.log(`                ${trunc(d.declaredAt.text, 100)}`);
        }
        for (const l of s.confirmedLiveOn) {
          console.log(`       live   : ${l.chain} (chainId ${l.chainId}) — ${l.bytecodeBytes} bytes @ block ${l.blockNumber}`);
        }
        console.log(`       re-check declared chain: ${s.reproduce.otherChains.map((o) => o.chain).join(", ")}`);
      }
    }
  } else if (Array.isArray(fact.result?.entries)) {
    // payto-vs-token
    console.log(`  HTTP 402 : x402Version=${fact.result.x402Version} · ${fact.result.entryCount} accepts entr(ies)`);
    if (fact.result.classification === "NO_TERMS_ADVERTISED") console.log(`  result   : NO_TERMS_ADVERTISED — ${fact.result.note}`);
    for (const e of fact.result.entries) {
      console.log(`\n    ── ${e.network}  (chainKnown=${e.chainKnown})`);
      console.log(`       classification         : ${e.classification}`);
      console.log(`       scheme / amount        : ${e.scheme} / ${e.amount}`);
      console.log(`       asset  (the token)     : ${e.asset}`);
      console.log(`       extra.verifyingContract: ${e.declaredVerifyingContract ?? "(absent ⇒ implicitly the asset = vanilla)"}`);
      console.log(`       effective EIP-712 domain: ${e.effectiveVerifyingContract}`);
      console.log(`       payTo                  : ${e.payTo}${e.onChain?.payToType ? `  [${e.onChain.payToType}]` : ""}`);
      if (e.onChain && !e.onChain.error) {
        console.log(`       extra.name vs token name(): ${JSON.stringify(e.extraName)} vs ${JSON.stringify(e.onChain.tokenName)}  → match=${e.onChain.domainNameMatchesToken}`);
      } else if (e.onChain?.error) {
        console.log(`       on-chain cross-check   : UNAVAILABLE (${e.onChain.error})`);
      }
    }
  } else if (fact.result?.powers !== undefined) {
    // owner-powers. The scannedAddress line matters more than it looks: on a proxy the powers come
    // from the IMPLEMENTATION's code, and a reader must see which blob was actually scanned.
    const r = fact.result;
    if (!r.powersObservable) {
      console.log(`  result   : hasCode=false — POWERS NOT OBSERVABLE (this is NOT "no powers")`);
      console.log(`             ${r.note}`);
    } else {
      console.log(`  proxy    : ${r.isProxy ? `YES → implementation ${r.implementation}` : "no"}`);
      if (r.eip1967Admin) console.log(`  1967admin: ${r.eip1967Admin}`);
      console.log(`  scanned  : ${r.scannedAddress} (${r.scannedBytecodeBytes} bytes, codeHash ${r.scannedCodeHash.slice(0, 16)}…)`);
      console.log(`  owner    : ${r.owner?.address ?? "—"}  [${r.owner?.type}] ${r.owner?.label}`);
      console.log(`  powers   : ${r.powersPresent.length ? r.powersPresent.join(", ") : "(none of the scanned groups matched)"}`);
      for (const [group, v] of Object.entries(r.powers)) {
        if (!v.present) continue;
        for (const m of v.matched) console.log(`      ${group.padEnd(18)} ${m.signature.padEnd(42)} ${m.selector}`);
      }
    }
    console.log(`  re-verify: ${fact.query.queries.length} raw call(s):`);
    for (const q of fact.query.queries) console.log(`      ${q.what.padEnd(24)} ${q.reproduce}`);
  } else {
    console.log(`  result   :`);
    for (const [k, v] of Object.entries(fact.result)) console.log(`      ${k.padEnd(14)} ${JSON.stringify(v)}`);
    if (fact.evidence?.bytecode !== undefined) {
      console.log(`  evidence : bytecode ${trunc(fact.evidence.bytecode)}`);
      console.log(`             HTTP ${fact.evidence.httpStatus}`);
    }
  }
  // ⚠️ COVERAGE IS PRINTED ON EVERY RESULT, especially clean ones. A pass that hides its blind spots
  // is the false clean bill this engine exists to prevent — so the limits sit next to the verdict,
  // not in a README nobody opens.
  const cov = fact.result?.coverage;
  if (cov) {
    console.log(`\n  ── COVERAGE — what this result does and does NOT cover ──`);
    for (const v of cov.checkedVia) console.log(`     ✓ checked via  : ${v}`);
    for (const n of cov.notCheckedFor) {
      console.log(`     ✗ NOT checked  : ${n.id}`);
      console.log(`                      ${trunc(n.why, 150)}`);
    }
  }

  // Two query shapes: an RPC read (method/params/reproduce) or a composite (extraction + per-flag
  // curls). Printing `undefined(...)` for the composite was a real bug on the first run — a tool
  // whose product IS provenance cannot be sloppy about rendering it.
  if (fact.query?.method) {
    console.log(`  query    : ${fact.query.method}(${JSON.stringify(fact.query.params ?? [])})`);
    console.log(`  reproduce: ${fact.query.reproduce}`);
    if (fact.query.explorer) console.log(`  explorer : ${fact.query.explorer}`);
  } else if (fact.query?.extraction) {
    console.log(`  extraction: ${fact.query.extraction}`);
    console.log(`  chainReads: ${fact.query.chainReads}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const name = args._[0];

if (args.list || !name) {
  console.log("\ndd — deterministic due-diligence checks. Facts + provenance. No verdicts.\n");
  for (const c of CHECKS) console.log(`  ${c.id.padEnd(16)} ${c.describe}\n  ${" ".repeat(16)} usage: ${c.usage}\n`);
  process.exit(name ? 0 : 1);
}

const check = byId.get(name);
if (!check) {
  console.error(`unknown check "${name}" — known: ${[...byId.keys()].join(", ")}`);
  process.exit(1);
}

const fact = await check.run(args);
if (args.json) console.log(JSON.stringify(fact, null, 2));
else print(fact);

// Exit code reflects WHETHER WE COULD OBSERVE, never what we observed. `hasCode: false` is a
// successful run. A tool that exits non-zero on an unwelcome fact is a tool with an opinion.
process.exit(fact.status === "observed" ? 0 : 2);
