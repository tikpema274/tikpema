// demo-quorum-disagreement.mjs — show what a LYING ENDPOINT looks like in the report.
//
// ⚠️ EVERYTHING HERE IS REAL EXCEPT ONE VALUE. Both endpoints are the actual Arc providers, reading
// the actual chain at the actual pinned block. A thin wrapper sits in front of ONE of them and
// rewrites exactly one response — the `owner()` eth_call — to a different address. Every other read
// (bytecode, proxy slots, owner code) is untouched and genuinely fetched from both providers.
//
// This is the fault the quorum layer exists for: one provider returning a plausible, well-formed,
// WRONG answer. It is indistinguishable from a correct answer to any single-RPC reader — which is
// the whole point. A single-endpoint run reports the lie as fact; the quorum run reports that it
// cannot tell you who the owner is, and shows you both answers so you can go look.
//
// Run:  node scripts/dd/demo-quorum-disagreement.mjs [--full]

import { chainClient } from "./client.mjs";
import { quorumClient } from "../../shared/onchain-analyze/quorum.mjs";
import { analyze } from "../../shared/onchain-analyze/index.mjs";
import { digest, QUORUM_ENDPOINTS } from "./analyze-run.mjs";

const XYLO = "0x240Eb85458CD41361bd8C3773253a1D78054f747";
const OWNER_SELECTOR = "0x8da5cb5b";
const LIE = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

/**
 * Wrap a real client so ONE method returns a tampered value. The rewritten response keeps the real
 * `query` — so the curl printed in reads[] is the REAL request, and anyone re-running it will get
 * the honest answer and see the tamper for what it was. The evidence stays checkable.
 */
function tamperOwner(inner, fakeAddress) {
  return {
    ...inner,
    chain: inner.chain,
    assert: () => inner.assert(),
    pin: () => inner.pin(),
    async call({ method, params }) {
      const out = await inner.call({ method, params });
      if (method === "eth_call" && params?.[0]?.data === OWNER_SELECTOR) {
        return { ...out, result: "0x" + fakeAddress.replace(/^0x/, "").padStart(64, "0") };
      }
      return out;
    },
  };
}

const full = process.argv.includes("--full");
const [urlA, urlB] = QUORUM_ENDPOINTS;

console.log(`\nInjecting a disagreement: ${urlB} will report owner() = ${LIE}`);
console.log(`Every other read on both endpoints is real and untampered.\n`);

const honest = chainClient("arc-testnet", { rpc: urlA });
const liar = tamperOwner(chainClient("arc-testnet", { rpc: urlB }), LIE);

const report = await analyze(XYLO, { client: quorumClient([honest, liar]) });

console.log(full ? JSON.stringify(report, null, 2) : digest(report, "XyloVault — QUORUM with an injected owner() disagreement"));

// The assertion the demo is really making.
const entry = report.coverage.notChecked.find((n) => n.id === "owner:owner()");
console.log("\n" + "─".repeat(92));
console.log("the coverage entry, verbatim:");
console.log(JSON.stringify(entry, null, 2));
console.log("─".repeat(92));
console.log(`owner reported as : ${report.owner.address ?? "null"}  [${report.owner.kind}]`);
console.log(`picked a winner?  : ${report.owner.address === null ? "NO — refused to choose" : "⚠️ YES, THIS IS A BUG"}`);
console.log(`powers still read?: ${report.powers.length} groups reported (owner-independent findings survive)`);
