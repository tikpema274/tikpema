// verify-vault-degraded.mjs — FAULT INJECTION for defects A and B.
//
// verify-vault.mjs proves the HEALTHY path is unchanged (same digest, same ack). That is necessary
// and not sufficient: it cannot distinguish a working tri-state from one that never fires. This file
// is the other half — it forces each read to FAIL and asserts the disclosure says so.
//
// ⚠️ WHY THIS FILE EXISTS AT ALL. The defects it covers were invisible precisely because the failure
// path was never exercised: the fallback took the safest-looking branch and every test ran against a
// healthy RPC. A regression test that only runs the happy path would re-admit both defects without
// turning red. The assertions here are all of the form "the UNKNOWN is reported AS unknown".
//
//   node --experimental-test-module-mocks scripts/verify-vault-degraded.mjs
//
// Zero money, zero network: the RPC client is replaced wholesale, so nothing leaves this process.
import { mock } from "node:test";

const XYLO = "0x240Eb85458CD41361bd8C3773253a1D78054f747";
const ZERO = "0x0000000000000000000000000000000000000000";
const EOA = "0x5b967871bb9b2ce1ac7e3a3a2ab2ec5c1e4b8a2f";
const OK_SLOT = "0x0000000000000000000000000000000000000000000000000000000000000000";
// Any non-empty bytecode: enough to make isContract true so the owner/proxy branches are reached.
const SOME_CODE = "0x60806040523480156100105760006000fd5b50" + "00".repeat(64);

// The real, on-chain XyloVault digest, captured from a healthy read. Any degraded disclosure that
// produced this string would let an ack minted on a good day authorise a deposit on a bad one.
const HEALTHY_DIGEST =
  "0x240eb85458cd41361bd8c3773253a1d78054f747|warns:emergency-withdraw,fees-settable,owner-is-eoa,performance-fee|wf:10|df:0|v1";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};

// A fake public client. Each read is independently switchable to "throws" so we can degrade exactly
// one surface at a time — a blanket outage would prove less, because it could not show that an
// unreadable owner alone is enough to change the disclosure.
function fakeClient({ ownerValue = EOA, multicallThrows = false, storageThrows = false, ownerCodeThrows = false }) {
  return () => ({
    getBytecode: async ({ address }) => {
      if (ownerCodeThrows && address.toLowerCase() !== XYLO.toLowerCase()) throw new Error("injected: owner bytecode read failed");
      return address.toLowerCase() === XYLO.toLowerCase() ? SOME_CODE : "0x";
    },
    multicall: async ({ contracts }) => {
      if (multicallThrows) throw new Error("injected: multicall failed (total RPC failure)");
      return contracts.map((c) =>
        c.functionName === "owner" ? { status: "success", result: ownerValue } : { status: "failure", error: new Error("absent") }
      );
    },
    getStorageAt: async () => {
      if (storageThrows) throw new Error("injected: eth_getStorageAt failed");
      return OK_SLOT;
    },
  });
}

const load = async (opts) => {
  mock.restoreAll();
  mock.module("../netlify/functions/_predict.mjs", { namedExports: { publicClient: fakeClient(opts) } });
  const mod = await import(`../netlify/functions/_vault.mjs?t=${Math.random()}`);
  return mod;
};

console.log("\n── DEFECT A · an owner() that was never read ──");
{
  const { inspectVault, disclosureDigest } = await load({ multicallThrows: true });
  const i = await inspectVault(XYLO);
  const codes = i.verdict.warns.map((w) => w.code);
  check("owner is NOT reported as renounced", i.ownerPowers.ownerIdentity !== "renounced", `got "${i.ownerPowers.ownerIdentity}"`);
  check("owner is classified 'unreadable'", i.ownerPowers.ownerIdentity === "unreadable");
  check("the label states UNKNOWN", /UNKNOWN/.test(i.ownerPowers.ownerIdentityLabel));
  check("the label never says 'Ownership renounced'", !/Ownership renounced/i.test(i.ownerPowers.ownerIdentityLabel));
  check("a WARN is raised (the old path raised none)", codes.includes("owner-unreadable"), codes.join(",") || "(no warns)");
  // The digest is what an ack is bound to. If the degraded disclosure shared a digest with a healthy
  // one, an ack taken on a good day would silently authorise a deposit against an unknown owner.
  const degraded = disclosureDigest(i);
  check("the unread owner is IN the digest string", degraded.includes("owner-unreadable"), degraded);
  check("degraded digest ≠ the healthy XyloVault digest", degraded !== HEALTHY_DIGEST);
}

console.log("\n── DEFECT A · owner() read fine, owner's own bytecode unreadable ──");
{
  const { inspectVault } = await load({ ownerValue: EOA, ownerCodeThrows: true });
  const i = await inspectVault(XYLO);
  check("not silently classified as an EOA", i.ownerPowers.ownerIdentity !== "eoa", `got "${i.ownerPowers.ownerIdentity}"`);
  check("classified 'unreadable-kind'", i.ownerPowers.ownerIdentity === "unreadable-kind");
  check("owner ADDRESS is still reported (it was read)", String(i.ownerPowers.owner).toLowerCase() === EOA);
  check("a WARN is raised", i.verdict.warns.some((w) => w.code === "owner-unreadable"));
}

console.log("\n── CONTROL · a CONFIRMED zero-address owner still reports renounced ──");
{
  const { inspectVault } = await load({ ownerValue: ZERO });
  const i = await inspectVault(XYLO);
  check("renounced is still reachable from a real zero read", i.ownerPowers.ownerIdentity === "renounced");
  check("renounced raises no owner warn (unchanged behaviour)", !i.verdict.warns.some((w) => w.code.startsWith("owner-")));
}

console.log("\n── DEFECT B · an EIP-1967 slot that was never read ──");
{
  const { inspectVault } = await load({ storageThrows: true });
  const i = await inspectVault(XYLO);
  const blocks = i.verdict.blocks.map((b) => b.code);
  check("NOT reported as 'not upgradeable'", i.ownerPowers.upgradeable.present !== false, `present=${String(i.ownerPowers.upgradeable.present)}`);
  check("upgradeable.present is null (UNKNOWN)", i.ownerPowers.upgradeable.present === null);
  check("proxySlotUnreadable flag is set", i.ownerPowers.upgradeable.proxySlotUnreadable === true);
  check("the note does not claim the slot is empty", !/no proxy slot/.test(i.ownerPowers.upgradeable.note));
  check("verdict BLOCKS on proxy-status-unreadable", blocks.includes("proxy-status-unreadable"), blocks.join(",") || "(no blocks)");
  check("level is BLOCK", i.verdict.level === "BLOCK");
}

console.log("\n── CONTROL · a slot that WAS read and is empty still says 'not upgradeable' ──");
{
  const { inspectVault } = await load({});
  const i = await inspectVault(XYLO);
  check("present === false (a real observation)", i.ownerPowers.upgradeable.present === false);
  check("no proxy block on a healthy read", !i.verdict.blocks.some((b) => b.code === "proxy-status-unreadable"));
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed. Zero money, zero network.`);
process.exit(fail === 0 ? 0 : 1);
