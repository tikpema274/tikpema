// fixtures.mjs — known-shape contracts whose CORRECT classification we already know.
//
// Each fixture asserts the FULL expected report, not "it ran". A canary that only checks for a
// non-crash would sail straight past a detector that answers confidently and wrongly, which is the
// exact failure this whole engine exists to prevent in other people's code.
//
// ═══ WHY THESE ARE SYNTHETIC AND HERMETIC ════════════════════════════════════════════════════
// These fixtures use constructed bytecode and an injected client: NO RPC, NO network, deterministic.
// That matters for the stop-serving decision, because it separates two questions that must not be
// conflated:
//
//   "is the DETECTOR correct?"        → these fixtures. Hermetic, so they can essentially ALWAYS
//                                       produce a verdict. A missing verdict means the canary itself
//                                       died — which is exactly when we want to stop serving.
//   "did something change UNDER us?"  → a live probe against real Arc addresses (separate, and it
//                                       must pin each subject's codehash, or an upstream contract
//                                       upgrade is indistinguishable from our detector breaking).
//
// A live fixture pinned to a mutable contract conflates "our detector broke" with "the subject
// changed". Keeping the halting gate hermetic means an upstream deployment cannot cause a
// self-inflicted outage, while a real regression still stops the service.

import { POWER_SIGS, sel, EIP1967_IMPL_SLOT } from "../onchain-facts/index.mjs";
import { DIAMOND_LOUPE_SIGS, UUPS_SIGS, EIP1967_ADMIN_SLOT, EIP1167_PREFIX, EIP1167_SUFFIX } from "../onchain-analyze/slots.mjs";

const SUBJ = "0x1111111111111111111111111111111111111111";
const IMPL = "0x2222222222222222222222222222222222222222";
const OWNER = "0x3333333333333333333333333333333333333333";
const ZERO_WORD = "0x" + "0".repeat(64);
const word = (a) => "0x" + a.replace(/^0x/, "").padStart(64, "0");
const codeWith = (sigs) => "0x60806040" + sigs.map((s) => sel(s)).join("") + "00";
const powerGroups = Object.keys(POWER_SIGS);

/** The hermetic transport. Any read the fixture did not declare is a THROWN miss, never a default —
 *  a fixture that silently reads a default is testing nothing. */
function mockClient(handlers = {}) {
  return {
    chain: { name: "canary-fixture" },
    assert: async () => 5042002,
    pin: async () => ({ number: 1000, tag: "0x3e8" }),
    async call({ method, params }) {
      const key =
        method === "eth_getCode" ? `code@${String(params[0]).toLowerCase()}`
        : method === "eth_getStorageAt" ? `slot@${String(params[1]).toLowerCase()}`
        : method === "eth_call" ? `call@${String(params[0]?.data)}`
        : method;
      const h = handlers[key];
      if (h === undefined) throw Object.assign(new Error(`fixture: undeclared read ${key}`), { transient: false });
      return { result: h, query: { endpoint: "fixture://", method, params, reproduce: `# fixture ${key}` }, evidence: { httpStatus: 200 } };
    },
  };
}

const notCheckedPowers = (r) => r.coverage.notChecked.filter((n) => n.kind === "power").map((n) => n.group);

/**
 * The fixture set. `expect` returns an array of PROBLEM STRINGS — empty means the detector is right.
 * Returning problems rather than throwing means one broken detector does not hide the others.
 */
export const FIXTURES = Object.freeze([
  {
    id: "eip2535-diamond",
    label: "a diamond must be identified AND must refuse to report its own selectors",
    client: () => mockClient({
      [`code@${SUBJ}`]: codeWith([...DIAMOND_LOUPE_SIGS, "pause()"]),
      [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD,
      [`call@0x8da5cb5b`]: word(OWNER),
      [`code@${OWNER}`]: "0x",
    }),
    expect: (r) => {
      const p = [];
      if (r.shape.class !== "eip2535-diamond") p.push(`shape.class is ${r.shape.class}, expected eip2535-diamond`);
      if (r.powers.length !== 0) p.push(`a diamond reported ${r.powers.length} powers from its own bytecode; scanning a diamond directly is invalid`);
      if (notCheckedPowers(r).length !== powerGroups.length) p.push("not every power group landed in notChecked — a diamond with gaps reads as a partial clean bill");
      // 🚨 THE ENCODED FINDING: pause() IS in the bytecode. Reporting it would be a confident wrong
      // answer, because a diamond's real selectors live in its facets.
      if (r.powers.some((x) => x.power === "pausable")) p.push("🚨 pause() was reported from a diamond's own bytecode — the detector is half-answering instead of refusing");
      if (r.refusal !== null) p.push(`expected a first-class report, got refusal ${r.refusal.reason}`);
      return p;
    },
  },
  {
    id: "uups-empty-admin-slot",
    label: "an EMPTY admin slot must NOT read as 'not upgradeable'",
    client: () => mockClient({
      [`code@${SUBJ}`]: codeWith([]),
      [`slot@${EIP1967_IMPL_SLOT}`]: word(IMPL),
      [`slot@${EIP1967_ADMIN_SLOT}`]: ZERO_WORD,
      [`code@${IMPL}`]: codeWith(UUPS_SIGS),
      [`call@0x8da5cb5b`]: word(OWNER),
      [`code@${OWNER}`]: "0x",
    }),
    expect: (r) => {
      const p = [];
      // 🚨 THE ENCODED FINDING, and the reason this fixture exists at all. A zero at the EIP-1967
      // admin slot is what UUPS LOOKS LIKE — upgrade authority lives inside the implementation. Any
      // detector that reads that zero as "no admin, therefore immutable" produces a reassuring,
      // confident, WRONG answer. This is published in the public mirror README as a warning to
      // readers; the canary is what keeps it true of our own code.
      if (r.shape.variant !== "uups") p.push(`🚨 shape.variant is ${r.shape.variant}, expected uups — an empty admin slot was misread`);
      if (r.shape.class === "eoa" || r.shape.class === "plain-contract") p.push(`🚨 a UUPS proxy was classified ${r.shape.class} — proxy-ness was lost entirely`);
      if (r.shape.scannedAddress !== IMPL) p.push(`powers scanned at ${r.shape.scannedAddress}, expected the implementation ${IMPL}`);
      return p;
    },
  },
  {
    id: "eip1167-clone",
    label: "a minimal proxy must resolve to its target and find the TARGET's powers",
    client: () => mockClient({
      [`code@${SUBJ}`]: "0x" + EIP1167_PREFIX + IMPL.replace(/^0x/, "") + EIP1167_SUFFIX,
      [`code@${IMPL}`]: codeWith(["emergencyWithdraw()"]),
      [`call@0x8da5cb5b`]: word(OWNER),
      [`code@${OWNER}`]: "0x",
    }),
    expect: (r) => {
      const p = [];
      if (r.shape.class !== "eip1167-clone") p.push(`shape.class is ${r.shape.class}, expected eip1167-clone`);
      if (r.shape.scannedAddress !== IMPL) p.push(`scannedAddress is ${r.shape.scannedAddress}, expected the delegation target ${IMPL} — the stub was scanned instead`);
      if (r.powers.find((x) => x.power === "emergencyWithdraw")?.present !== true) p.push("the TARGET's emergencyWithdraw was not found through the clone");
      return p;
    },
  },
  {
    id: "fee-settable-vault",
    label: "a fee-settable vault must have its fee power FOUND, not missed",
    client: () => mockClient({
      [`code@${SUBJ}`]: codeWith([...POWER_SIGS.feesSettable, ...POWER_SIGS.emergencyWithdraw]),
      [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD,
      [`call@0x8da5cb5b`]: word(OWNER),
      [`code@${OWNER}`]: "0x",
    }),
    expect: (r) => {
      const p = [];
      if (r.powers.find((x) => x.power === "feesSettable")?.present !== true) p.push("🚨 feesSettable is present in the bytecode but was NOT reported — a fee power missed reads as a clean bill");
      if (r.powers.find((x) => x.power === "emergencyWithdraw")?.present !== true) p.push("emergencyWithdraw present in bytecode but not reported");
      if (r.powers.find((x) => x.power === "pausable")?.present === true) p.push("pausable reported PRESENT though absent from the bytecode — false positive");
      if (r.refusal !== null) p.push(`expected a first-class report, got refusal ${r.refusal.reason}`);
      return p;
    },
  },
  {
    id: "eoa-unobservable",
    label: "an address with no code yields UNOBSERVABLE powers, never powers:[] reading as clean",
    client: () => mockClient({ [`code@${SUBJ}`]: "0x" }),
    expect: (r) => {
      const p = [];
      if (r.shape.class !== "eoa") p.push(`shape.class is ${r.shape.class}, expected eoa`);
      if (notCheckedPowers(r).length !== powerGroups.length) p.push("powers were not all recorded as notChecked — an empty address must not read as 'no powers'");
      if (r.powers.length !== 0) p.push(`reported ${r.powers.length} powers at an address with no bytecode`);
      return p;
    },
  },
]);

/**
 * Run every fixture. `analyzeFn` is INJECTED so the acceptance test can substitute a deliberately
 * broken detector and prove the suite catches it.
 *
 * Never throws: a fixture that explodes is recorded as a failure, because a canary that dies
 * mid-suite must not leave the caller unable to tell pass from crash.
 */
export async function runFixtures(analyzeFn) {
  const results = [];
  for (const f of FIXTURES) {
    try {
      const report = await analyzeFn(SUBJ, { client: f.client() });
      const problems = f.expect(report);
      results.push({ id: f.id, label: f.label, ok: problems.length === 0, problems });
    } catch (e) {
      results.push({ id: f.id, label: f.label, ok: false, problems: [`fixture threw: ${e?.message ?? e}`] });
    }
  }
  return { passed: results.every((r) => r.ok), results };
}
