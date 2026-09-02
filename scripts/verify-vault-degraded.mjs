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
function fakeClient({ ownerValue = EOA, multicallThrows = false, storageThrows = false, ownerCodeThrows = false, vaultCodeThrows = false }) {
  return () => ({
    getBytecode: async ({ address }) => {
      if (ownerCodeThrows && address.toLowerCase() !== XYLO.toLowerCase()) throw new Error("injected: owner bytecode read failed");
      // ⭐ THE VAULT'S OWN bytecode — the read every selector scan depends on.
      if (vaultCodeThrows && address.toLowerCase() === XYLO.toLowerCase()) throw new Error("injected: vault bytecode read failed");
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


// ⭐⭐ STEP 2: the owner-identity and power warns now come from the DD REPORT, not from inspectVault.
// This helper builds the report a LIVE run would produce for the degraded case under test — and the
// `kind` is taken from the inspection's OWN classification, which asserts something stronger than a
// hardcoded fixture would: both sides call the shared `classifyOwnerType`, so if they ever disagreed
// this helper would silently paper over it. §agreement below pins that they do not.
const { applyReportDisclosure } = await import("../netlify/functions/_vault.mjs");
const withReport = (i, kindOverride) => applyReportDisclosure(i, {
  subject: { address: XYLO.toLowerCase(), chainId: i.chainId },
  powersPresent: [],
  owner: { kind: kindOverride ?? i.ownerPowers.ownerIdentity },
  coverage: { notChecked: [] },
});

console.log("\n── DEFECT A · an owner() that was never read ──");
{
  const { inspectVault, disclosureDigest } = await load({ multicallThrows: true });
  const i = await inspectVault(XYLO);
  const codes = withReport(i).verdict.warns.map((w) => w.code);
  check("owner is NOT reported as renounced", i.ownerPowers.ownerIdentity !== "renounced", `got "${i.ownerPowers.ownerIdentity}"`);
  check("owner is classified 'unreadable'", i.ownerPowers.ownerIdentity === "unreadable");
  check("the label states UNKNOWN", /UNKNOWN/.test(i.ownerPowers.ownerIdentityLabel));
  check("the label never says 'Ownership renounced'", !/Ownership renounced/i.test(i.ownerPowers.ownerIdentityLabel));
  check("a WARN is raised (the old path raised none)", codes.includes("owner-unreadable"), codes.join(",") || "(no warns)");
  // The digest is what an ack is bound to. If the degraded disclosure shared a digest with a healthy
  // one, an ack taken on a good day would silently authorise a deposit against an unknown owner.
  const degraded = disclosureDigest(withReport(i));
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
  check("a WARN is raised", withReport(i).verdict.warns.some((w) => w.code === "owner-unreadable"));
  check("⭐⭐ the vault's own owner classification AGREES with the report's — one shared classifier",
    i.ownerPowers.ownerIdentity === "unreadable-kind");
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

console.log("\n── ⭐⭐ THE COINCIDENTAL SAFETY, PINNED · an unreadable VAULT bytecode ──");
// 🚨 WHY THIS ASSERTION EXISTS. Every owner-power scan in _vault.mjs runs `hasAny(code, …)` over the
// vault's own bytecode. That read USED TO fall back to the literal string "0x" — not to the
// UNREADABLE sentinel — so the tri-state was destroyed before `hasAny` was ever called.
//
// ⭐⭐ THE SAFETY WAS REAL BUT COINCIDENTAL: "0x" made `isContract` false, raising `not-a-contract`,
// and gateDeposit refuses on BLOCK before any disclosure renders. Two independent mechanisms
// happened to agree, and only one was documented as the guard. Worse, the SENTENCE was false — "it
// is not a deployed contract" is a claim about the chain that three failed RPC calls cannot support.
//
// ═══ ⭐ FIXED 2026-09-02 — THE COINCIDENCE IS NOW A DESIGN ═══════════════════
// `withRetry` no longer takes a fallback; an exhausted read returns UNREADABLE. The bytecode read is
// classified into THREE states and the unreadable one blocks under its own `bytecode-unreadable`,
// whose copy says the checks below it did not run. `not-a-contract` is now reserved for a read that
// SUCCEEDED and found no code.
//
// ⚠️ A PREDICTION MADE HERE WAS WRONG, AND THE MUTATION DISPROVED IT — kept because it is the
// reasoning, not the outcome: the claim that an UNREADABLE symbol would crash `hasAny` was false,
// because the value is wrapped in `String(...)` and `String(symbol)` is legal.
// ⭐ Recorded rather than quietly edited: a guard whose rationale is measured beats one whose
// rationale is plausible.
//
// This converts the coincidence into a guarantee: break either mechanism and it goes red.
{
  const { inspectVault, gateDeposit } = await load({ vaultCodeThrows: true });
  let i = null, threw = null;
  try { i = await inspectVault(XYLO); } catch (e) { threw = e; }

  check("⭐⭐ an unreadable vault bytecode does NOT crash the inspection",
    threw === null, threw ? `${threw.constructor.name}: ${String(threw.message).slice(0, 60)}` : "");
  if (i) {
    const blocks = i.verdict.blocks.map((b) => b.code);
    // ⭐⭐ THE PROPERTY, then the PRECISION. This used to assert `not-a-contract` — the block that
    // happened to fire, not the one that should. All three clauses matter:
    //   it BLOCKS                → the reassuring copy stays unreachable (what this file protects)
    //   under the UNREADABLE code → the user is not told a vault we could not read is fake
    //   and NOT under not-a-contract → the false claim is gone, which is what pins the fix
    check("⭐⭐ …it BLOCKS — never a clean report",
      i.verdict.level === "BLOCK", blocks.join(",") || "(no blocks)");
    check("⭐⭐ …under `bytecode-unreadable`, the code that says the checks did NOT run",
      blocks.includes("bytecode-unreadable"), blocks.join(","));
    check("🚨 …and NEVER `not-a-contract` — that asserts a fact about the chain we did not read",
      !blocks.includes("not-a-contract"), blocks.join(","));
    check("⭐⭐ …and the deposit gate REFUSES, so the reassuring copy is unreachable",
      gateDeposit({ inspection: i, ackToken: undefined }).ok === false);
    // ⚠️ The powers DO read as absent underneath — that is the coincidence. What makes it safe is
    // that BLOCK short-circuits before anyone is shown them. Asserted so the dependency is EXPLICIT:
    // if the BLOCK ever stops firing, these absences become user-visible claims.
    check("⚠️ (recorded) underneath, the powers DO read as absent — the BLOCK is what makes that safe",
      i.ownerPowers.emergencyWithdraw.present === false && i.ownerPowers.settableFees.present === false);
    check("⭐ an ack cannot buy past it — BLOCK outranks acknowledgement",
      gateDeposit({ inspection: i, ackToken: "f".repeat(64) }).ok === false);
  }
}

console.log("\n── ⭐⭐ THE DISCLOSURE CARRIES ITS OWN DIGEST INPUTS ──");
// 🚨 A moved digest invalidates an acknowledgement, and the UI must be able to say WHAT moved.
// `disclosureDigest` is `address | warn codes | withdrawFee | depositFee`; shipping only
// {level, blocks, warns, digest} made a FEE-ONLY change unexplainable — the digest moves and the
// payload contains nothing that accounts for it. The inputs must travel with the digest.
{
  const { inspectVault, gateDeposit } = await load({});
  // ⭐ ESTABLISHED FIRST — since step 2 the gate refuses a raw inspection outright, and its refusal
  // carries a null digest by design. Gating an un-established inspection here would test the
  // fail-closed catch (covered in verify-vault §ROW 1b) rather than the digest-inputs claim.
  const i = withReport(await inspectVault(XYLO));
  const g = gateDeposit({ inspection: i, ackToken: undefined });
  const d = g.disclosure;
  check("⭐⭐ the disclosure carries the withdraw fee (a digest input)", "withdrawFeeBps" in d, String(d.withdrawFeeBps));
  check("⭐⭐ …and the deposit fee (the other one)", "depositFeeBps" in d, String(d.depositFeeBps));
  check("⭐ …alongside the digest itself, so a consumer can explain a move", typeof d.digest === "string" && d.digest.length > 0);
  check("⭐ …and the warn codes, the third input", Array.isArray(d.warns));
  // ⚠️ The address is the fourth input and is already known to any caller, so it is not duplicated.
  check("  the digest is built from exactly those inputs", /\|warns:.*\|wf:.*\|df:/.test(d.digest), d.digest);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed. Zero money, zero network.`);
process.exit(fail === 0 ? 0 : 1);
