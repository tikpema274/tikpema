// verify-receipt-adversarial.mjs — ZERO-MONEY adversarial proof of the receipt verifier.
// Pure reads (destination-chain RPC only). No signing, no tx, no Blobs writes.
//
//   node scripts/verify-receipt-adversarial.mjs
//
// THE CLAIM UNDER TEST: verifyMintOnChain() will NEVER return verified:true for a mint
// it cannot independently confirm on the CORRECT destination chain. A false
// verified:true is the single worst outcome in this design — it would publish a
// fabricated on-chain history inside a trust artifact.
//
// FALSIFIABILITY: a verifier that always returns false would pass every attack below
// while being useless. So CASE 0 is a CONTROL: the real, successful Base Sepolia mint
// from the UB spend (tx 0xf9ac9ae4…, recipient 0xc54d…e621). It MUST verify. If the
// control fails, the attack results prove nothing.
import { verifyMintOnChain } from "../netlify/functions/_receipt.mjs";

const AGENT = "0xc54d47211997aca90ef4fcfbc742a3b511b4e621";

// Real, successful USDC mint to AGENT on Base Sepolia (from the proven UB spend).
const REAL_MINT = "0xf9ac9ae42b87f6e52548f5ea2963d0738cbb76294dca0ad83fec7ea5108ec49b";
// Real, REVERTED tx on Base Sepolia (status 0x0), found by scanning recent blocks.
const REVERTED = "0xd166b727608237e6b74f633385fc0dba09191382ec4f9d18d82f7199bc33a57b";
// Fabricated — corresponds to no tx anywhere.
const BOGUS = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
// A DIFFERENT address — used to prove "successful tx on the right chain" is not enough.
const NOT_US = "0x1e18D9418BFB6bB9750a4b294eA5077b2cfe31Be";

// How the background verifier reacts to a given result (mirrors
// job-bridge-receipt-background.mjs): rpc_error / receipt_not_found look like a lagging
// node, so it KEEPS POLLING (→ eventually mint_unconfirmed). Anything else is genuine
// disagreement → mint_unverified, and it STOPS. Neither path can reach `minted`.
const reaction = (r) =>
  r.verified ? "minted"
  : r.reason === "rpc_error" || r.reason === "receipt_not_found" ? "continued-poll → mint_unconfirmed"
  : "mint_unverified (HUMAN REVIEW)";

const cases = [
  { n: "CONTROL", desc: "the REAL mint, correct chain + recipient", args: { destinationKey: "base",     mintTxHash: REAL_MINT, recipient: AGENT  }, expectMinted: true },
  { n: "ATTACK 1", desc: "bogus fabricated hash",                   args: { destinationKey: "base",     mintTxHash: BOGUS,     recipient: AGENT  }, expectMinted: false },
  { n: "ATTACK 2", desc: "REAL hash, WRONG chain (optimism)",       args: { destinationKey: "optimism", mintTxHash: REAL_MINT, recipient: AGENT  }, expectMinted: false },
  { n: "ATTACK 3", desc: "REVERTED tx (exists, status 0x0)",        args: { destinationKey: "base",     mintTxHash: REVERTED,  recipient: AGENT  }, expectMinted: false },
  { n: "ATTACK 4", desc: "real successful tx, WRONG recipient",     args: { destinationKey: "base",     mintTxHash: REAL_MINT, recipient: NOT_US }, expectMinted: false },
];

let pass = 0, fail = 0;
console.log("── Receipt verifier under adversarial input (all reads, zero money) ──\n");

for (const c of cases) {
  const r = await verifyMintOnChain(c.args);
  const react = reaction(r);
  const mintedProduced = r.verified === true;
  const ok = mintedProduced === c.expectMinted;
  ok ? pass++ : fail++;

  console.log(`${ok ? "✅" : "❌"} ${c.n}: ${c.desc}`);
  console.log(`     verified=${r.verified}${r.reason ? `  reason=${r.reason}` : ""}`);
  console.log(`     → receipt state: ${react}`);
  if (r.verified) console.log(`     chainId=${r.chainId} block=${r.blockNumber} usdcAmount=${r.usdcAmount} usdc=${r.usdcAddress}`);
  console.log();
}

console.log("── Verdict ──");
console.log(`  ${fail === 0 ? "✅ PASS" : "❌ FAIL"} — ${pass}/${cases.length} cases behaved correctly.`);
console.log("  Pass condition: NO attack produced a `minted` receipt, AND the control did.");
process.exit(fail === 0 ? 0 : 1);
