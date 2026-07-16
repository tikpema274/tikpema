// repo-address-audit — every hardcoded address in a repo, checked against the chain the repo claims.
//
// THE BUG IT CATCHES. Arcent's README: "The first x402 implementation on Arc Network". Its executor:
// `usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e'` — Base Sepolia's USDC, hardcoded with no env
// override, on a code path that calls transferWithAuthorization on Arc. A jury, a README and a badge
// all missed it. Two eth_getCode calls do not.
//
// ⚠️ THE CROSS-CHAIN PROBE IS THE NOISE FILTER, NOT A BONUS FEATURE. "Empty on the claimed chain" is
// worthless on its own: every repo hardcodes EOAs — deployers, test wallets, payout addresses — and
// an EOA is empty on every chain, forever, correctly. Flag those and the tool cries wolf on its first
// run and gets switched off. The discriminator is the CONJUNCTION: empty HERE and live THERE. An EOA
// is empty everywhere, so it never trips. A cross-chain copy-paste is empty here and live there, so it
// always does. That single conjunction is the difference between a check and a nuisance.
//
// ⚠️ WHY A LIVE PROBE INSTEAD OF THE PROPOSED codeHash REGISTRY. A registry of known foreign codeHashes
// cannot detect this class at all: the address is EMPTY on the claimed chain, so it HAS no codeHash
// there to match against. The match has to be BY ADDRESS, on other chains, which is a live read. And
// the live version is strictly stronger — it catches a copy-paste of ANY contract, not just the tokens
// someone remembered to enumerate. It is also self-updating and cannot go stale. So detection needs no
// registry. A registry would only add LABELS ("that's Base Sepolia USDC"), which is a nicety layered on
// top of a finding that already stands without it. See scripts/dd/README-check2.md before wiring one.
//
// ⚠️ THE CLAIMED CHAIN IS AN INPUT, NOT A GUESS. The engine will not parse a README to infer what a
// project "meant". Which chain was claimed is a human's reading of a human's claim; the engine's job is
// to check the claim, not to invent it. Pass --chain. Guessing it would smuggle an inference into the
// one layer that must contain none.
//
// ⚠️ CLASSIFICATION DESCRIBES, IT DOES NOT EXPLAIN. The label is
// EMPTY_ON_CLAIMED_CHAIN__LIVE_ON_OTHER_CHAIN — an observation. It is NOT "COPY_PASTED_FROM_BASE",
// which asserts intent the chain cannot witness (maybe they plan to deploy; maybe it is dead config;
// maybe the README is wrong and the chain is right). "Copy-pasted" is the reader's inference from the
// engine's fact, and that boundary is the whole design.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { observed, failed, normalizeAddress } from "../fact.mjs";
import { CHAINS, chainNames, getChain } from "../chains.mjs";
import { runBatch } from "../batch.mjs";
import * as codeExists from "./code-exists.mjs";

export const id = "repo-address-audit";
export const describe = "every hardcoded 0x address in a repo, checked for code on the claimed chain and on others";
export const usage = "--chain <claimed> [--repo <path>] [--others a,b] [--include-empty-everywhere]";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "vendor"]);
const SKIP_FILES = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|deno\.lock|\.min\.js|\.map)$/;

// ⚠️ PROSE IS NOT A CODE PATH — learned by running this on tikpema itself.
// The self-audit flagged three addresses, all true observations, none a bug: two were addresses
// MENTIONED in MULTIMARKET_NOTES.md / PROGRESS.md, one was PROGRESS.md's own write-up of the Arcent
// finding, and one was this very check's source COMMENT explaining that finding. The tool flagged its
// own explanation of the bug it detects. The lesson generalises: an address in a paragraph is
// commentary; an address in a config or a call site is a thing the code will actually use. The check's
// question is "does the code reference an address that isn't there" — so docs are out by default.
// --include-docs opts them back in (useful when auditing a README's own claims).
const CODE_EXT = /\.(m?[jt]sx?|json|toml|ya?ml|env|sol|cfg|ini|sh)$/i;
const DOC_EXT = /\.(md|txt|rst|adoc)$/i;
const ADDRESS_RE = /0x[0-9a-fA-F]{40}/g;

// ── DECLARED-CHAIN CONTEXT — the multi-chain refinement ──────────────────────────────────────────
//
// THE PROBLEM IT FIXES. tikpema's _receipt.mjs:44 reads
//   base: { rpc: "https://sepolia.base.org", chainId: 84532, usdc: "0x036CbD53…" }
// Audited against arc-testnet, that address is empty-here/live-there — a TRUE observation of zero
// significance, because the repo never claims it is Arc's. It says, on the same line, that it is
// 84532's. Flagging it is how a tool earns a reputation for crying wolf.
//
// THE RULE. Suppress only when BOTH hold:
//   (a) EVERY source site declares a chainId that is a known chain and is NOT the claimed chain, and
//   (b) each declared chain is one where the address is CONFIRMED LIVE by our own eth_getCode.
// So "the repo says this is chain X's address" is only accepted once we have independently seen the
// address alive on chain X. A declaration is a claim; this engine does not suppress on claims.
//
// ⚠️ FAIL-CLOSED, DELIBERATELY. No declaration found → FLAG. Declaration we cannot resolve to a known
// chain → FLAG. Declaration naming the CLAIMED chain → FLAG (that is the bug: the repo treating a
// foreign address as if it were the claimed chain's). Suppression is the narrow, evidenced exception;
// flagging is the default. Getting this backwards would silence exactly the case the tool exists for.
//
// ⚠️ WHY THIS STILL CATCHES ARCENT. Its sites are not uniformly foreign-declared: x402Client.js:58 is
//   5042002: '0x036CbD53…'  // Arc Testnet (placeholder)
// which declares the CLAIMED chain, and arcExecutor.js:16 sits inside a config block whose chainId is
// 5042002. The repo genuinely treats a Base Sepolia token AS Arc's. Rule (a) fails → it still fires.
const KNOWN_CHAIN_IDS = Object.entries(CHAINS).map(([name, c]) => ({ name, id: c.id }));
const CONTEXT_WINDOW = 3; // lines either side — configs put chainId next to the address, not on it

/** Nearest declared chainId to a source line, with the exact line it was declared on (the evidence). */
export function declaredChainNear(lines, idx, window = CONTEXT_WINDOW) {
  for (let d = 0; d <= window; d++) {
    for (const j of d === 0 ? [idx] : [idx - d, idx + d]) {
      if (j < 0 || j >= lines.length) continue;
      for (const k of KNOWN_CHAIN_IDS) {
        // \b so 84532 does not match inside 845321 — a declaration is a number, not a substring.
        if (new RegExp(`\\b${k.id}\\b`).test(lines[j])) {
          return { chainId: k.id, chain: k.name, at: { line: j + 1, text: lines[j].trim().slice(0, 160) } };
        }
      }
    }
  }
  return null;
}

/**
 * Walk the repo, collecting every 0x+40hex with the file/line it came from — the address's provenance.
 * @param {string} root
 * @param {object} [opts]
 * @param {boolean} [opts.includeDocs] - also scan .md/.txt (default false; prose is not a code path)
 * @param {string[]} [opts.skipPaths]  - repo-relative prefixes to ignore (e.g. the auditor's own source)
 */
export function extractAddresses(root, { includeDocs = false, skipPaths = [] } = {}) {
  const hits = [];
  const matches = (name) => (includeDocs ? CODE_EXT.test(name) || DOC_EXT.test(name) : CODE_EXT.test(name));
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir is not a finding; skip quietly
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      const rel = relative(root, p);
      if (skipPaths.some((s) => rel === s || rel.startsWith(s + "/"))) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
        continue;
      }
      if (SKIP_FILES.test(e.name) || !matches(e.name)) continue;
      try {
        if (statSync(p).size > 2_000_000) continue; // skip giant generated blobs
        const lines = readFileSync(p, "utf8").split("\n");
        lines.forEach((line, i) => {
          for (const m of line.matchAll(ADDRESS_RE)) {
            hits.push({
              address: m[0].toLowerCase(),
              file: relative(root, p),
              line: i + 1,
              text: line.trim().slice(0, 160),
              // The chain this SITE says the address belongs to, plus where it said so. Captured at
              // extraction because only here do we still have the surrounding lines.
              declared: declaredChainNear(lines, i),
            });
          }
        });
      } catch {
        /* unreadable file — skip; not a finding */
      }
    }
  };
  walk(root);
  return hits;
}

/** Drop bytecode from a sub-fact's evidence: codeHash is a commitment to it, and `reproduce` refetches it. */
const slim = (f) => ({
  check: f.check,
  status: f.status,
  input: f.input,
  result: f.result,
  error: f.error,
  query: f.query ? { method: f.query.method, params: f.query.params, reproduce: f.query.reproduce } : null,
  evidenceNote:
    f.status === "observed"
      ? "bytecode omitted here; result.codeHash commits to it and query.reproduce refetches it byte-for-byte"
      : null,
});

export async function run({
  chain: claimedChain,
  repo,
  others,
  block,
  "include-empty-everywhere": includeEmpty,
  "include-docs": includeDocs = false,
  "skip-paths": skipPathsArg,
}) {
  const root = repo && typeof repo === "string" ? repo : process.cwd();
  const otherChains =
    typeof others === "string"
      ? others.split(",").map((s) => s.trim()).filter(Boolean)
      : chainNames().filter((c) => c !== claimedChain);
  // The auditor must not audit itself: scripts/dd's own comments quote the very addresses it hunts.
  const skipPaths = typeof skipPathsArg === "string" ? skipPathsArg.split(",").map((s) => s.trim()) : ["scripts/dd"];
  const input = {
    repo: root,
    claimedChain: claimedChain ?? null,
    otherChains,
    block: block ?? null,
    includeDocs: Boolean(includeDocs),
    skipPaths,
  };

  if (!claimedChain) {
    return failed({
      check: id,
      input,
      error: "--chain is required: the CLAIMED chain is a human's reading of the project's claim, not something the engine may guess",
    });
  }

  let hits;
  try {
    hits = extractAddresses(root, { includeDocs: Boolean(includeDocs), skipPaths });
  } catch (e) {
    return failed({ check: id, input, error: e });
  }

  // Unique addresses, each remembering every source site it appeared at + what chain that site declared.
  const sites = new Map();
  for (const h of hits) {
    const a = normalizeAddress(h.address);
    if (!a) continue;
    if (!sites.has(a)) sites.set(a, []);
    sites.get(a).push({ file: h.file, line: h.line, text: h.text, declared: h.declared });
  }
  const addresses = [...sites.keys()];
  const claimedChainId = getChain(claimedChain).id;

  if (addresses.length === 0) {
    return observed({
      check: id,
      input,
      result: { addressesFound: 0, flags: [], classified: {} },
      evidence: { extraction: { filesScannedFrom: root, occurrences: 0 } },
      query: { extraction: `grep -rInE '0x[0-9a-fA-F]{40}' ${root}`, chainReads: [] },
    });
  }

  try {
    // Claimed chain first: one client, one guard, one pinned block, N reads.
    const claimedFacts = await runBatch(
      addresses.map((address) => ({ address, chain: claimedChain })),
      { check: codeExists, block }
    );
    const claimedBy = new Map(claimedFacts.map((f, i) => [addresses[i], f]));

    // Only addresses that are EMPTY on the claimed chain are worth probing elsewhere — the rest are
    // live where they should be, and cost nothing more to confirm.
    const suspects = addresses.filter((a) => claimedBy.get(a)?.status === "observed" && claimedBy.get(a).result.hasCode === false);

    const otherFacts = new Map(); // address -> fact[]
    for (const other of otherChains) {
      const facts = await runBatch(suspects.map((address) => ({ address, chain: other })), { check: codeExists, block });
      facts.forEach((f, i) => {
        const a = suspects[i];
        if (!otherFacts.has(a)) otherFacts.set(a, []);
        otherFacts.get(a).push(f);
      });
    }

    // ── Classification. Pure function of the facts above. No inference, no model. ──
    const flags = [];
    const suppressed = [];
    const classified = {};
    for (const a of addresses) {
      const cf = claimedBy.get(a);
      const of = otherFacts.get(a) ?? [];
      const liveElsewhere = of.filter((f) => f.status === "observed" && f.result.hasCode);

      let classification;
      if (cf.status === "error") classification = "INDETERMINATE_ON_CLAIMED_CHAIN";
      else if (cf.result.hasCode) classification = "LIVE_ON_CLAIMED_CHAIN";
      else if (liveElsewhere.length) classification = "EMPTY_ON_CLAIMED_CHAIN__LIVE_ON_OTHER_CHAIN";
      else classification = "EMPTY_EVERYWHERE_CHECKED"; // EOA, unused constant, or a chain we did not check
      classified[classification] = (classified[classification] ?? 0) + 1;

      const isFlag =
        classification === "EMPTY_ON_CLAIMED_CHAIN__LIVE_ON_OTHER_CHAIN" ||
        (includeEmpty && classification === "EMPTY_EVERYWHERE_CHECKED") ||
        classification === "INDETERMINATE_ON_CLAIMED_CHAIN";
      if (!isFlag) continue;

      // ── The multi-chain refinement. Only ever narrows EMPTY_ON_CLAIMED__LIVE_ELSEWHERE; an
      // INDETERMINATE is never suppressed, because we do not silence what we could not read. ──
      if (classification === "EMPTY_ON_CLAIMED_CHAIN__LIVE_ON_OTHER_CHAIN") {
        const siteList = sites.get(a);
        const liveChainIds = new Set(liveElsewhere.map((f) => f.result.chainId));
        // (a) every site declares a KNOWN, non-claimed chain …
        const allForeignDeclared = siteList.every((s) => s.declared && s.declared.chainId !== claimedChainId);
        // (b) … and we have SEEN the address alive on every chain those sites named.
        const declarationsConfirmedLive =
          allForeignDeclared && siteList.every((s) => liveChainIds.has(s.declared.chainId));

        if (declarationsConfirmedLive) {
          classified[classification] -= 1;
          classified.SUPPRESSED_DECLARED_FOREIGN = (classified.SUPPRESSED_DECLARED_FOREIGN ?? 0) + 1;
          suppressed.push({
            address: a,
            claimedChain,
            wouldHaveBeen: classification,
            reason: "EVERY_SOURCE_SITE_DECLARES_A_FOREIGN_CHAIN_AND_THE_ADDRESS_IS_CONFIRMED_LIVE_THERE",
            // Evidence for the SUPPRESSION itself — a suppressed address must be as auditable as a
            // flagged one, or the refinement becomes a place for real bugs to hide.
            declaredBy: siteList.map((s) => ({
              file: s.file,
              line: s.line,
              text: s.text,
              declaredChainId: s.declared.chainId,
              declaredChain: s.declared.chain,
              declaredAt: s.declared.at, // the exact line the chainId was read from
            })),
            confirmedLiveOn: liveElsewhere.map((f) => ({
              chain: f.input.chain,
              chainId: f.result.chainId,
              blockNumber: f.result.blockNumber,
              bytecodeBytes: f.result.bytecodeBytes,
              codeHash: f.result.codeHash,
            })),
            reproduce: {
              claimedChain: cf.query?.reproduce ?? null,
              otherChains: liveElsewhere.map((f) => ({ chain: f.input.chain, curl: f.query.reproduce })),
              source: `grep -rn '${a}' ${root}`,
            },
          });
          continue;
        }
      }

      flags.push({
        address: a,
        claimedChain,
        classification,
        // Why this was NOT suppressed — the same evidence a suppression carries, so the two are
        // comparable side by side. `declared: null` means no chainId near that site; a declared id
        // equal to the claimed chain is the smoking gun (the repo treats a foreign address as ours).
        source: sites.get(a).map((s) => ({
          file: s.file,
          line: s.line,
          text: s.text,
          declaredChainId: s.declared?.chainId ?? null,
          declaredChain: s.declared?.chain ?? null,
          declaredAt: s.declared?.at ?? null,
        })),
        onClaimedChain: cf.status === "observed"
          ? { hasCode: cf.result.hasCode, chainId: cf.result.chainId, blockNumber: cf.result.blockNumber }
          : { error: cf.error },
        liveOn: liveElsewhere.map((f) => ({
          chain: f.input.chain,
          chainId: f.result.chainId,
          blockNumber: f.result.blockNumber,
          bytecodeBytes: f.result.bytecodeBytes,
          codeHash: f.result.codeHash,
        })),
        reproduce: {
          claimedChain: cf.query?.reproduce ?? null,
          otherChains: liveElsewhere.map((f) => ({ chain: f.input.chain, curl: f.query.reproduce })),
          source: `grep -rn '${a}' ${root}`,
        },
      });
    }

    return observed({
      check: id,
      input,
      result: { addressesFound: addresses.length, flags, suppressed, classified },
      evidence: {
        extraction: { root, occurrences: hits.length, uniqueAddresses: addresses.length },
        facts: {
          claimedChain: claimedFacts.map(slim),
          otherChains: Object.fromEntries([...otherFacts].map(([a, fs]) => [a, fs.map(slim)])),
        },
      },
      query: {
        extraction: `grep -rInE '0x[0-9a-fA-F]{40}' ${root}`,
        chainReads: "each flag carries its own reproduce.* curls; sub-facts carry theirs in evidence.facts",
      },
    });
  } catch (e) {
    return failed({ check: id, input, error: e });
  }
}
