// verify-analyze.mjs — acceptance for DD Step 2 slice 1.
//
// ⚠️ THE TWO HALVES ([[vault-inspect-live-defects]]). A healthy run proves the analyzer BROKE NOTHING;
// it cannot prove the coverage manifest DOES anything. Only fault injection proves that — so most of
// this file forces reads to fail and asserts the unknown is reported AS unknown, WITH CONTROLS that
// prove the honest paths did not move.
//
// The faults are injected through a MOCK CLIENT rather than by breaking a real RPC: deterministic,
// offline, and it can force the exact `.transient` vs non-transient distinction that the defect-A fix
// turns on. One LIVE row anchors the whole thing to the real chain.

import { analyze } from "../../shared/onchain-analyze/index.mjs";
import { assertReportValid, SCOPE_CLASSES, POWER_SCOPE } from "../../shared/onchain-analyze/schema.mjs";
import * as analyzeModule from "../../shared/onchain-analyze/index.mjs";
import { POWER_SIGS, sel } from "../../shared/onchain-facts/index.mjs";
import { DIAMOND_LOUPE_SIGS, UUPS_SIGS, EIP1967_ADMIN_SLOT, EIP1167_PREFIX, EIP1167_SUFFIX } from "../../shared/onchain-analyze/slots.mjs";
import { quorumClient } from "../../shared/onchain-analyze/quorum.mjs";
import { EIP1967_IMPL_SLOT } from "../../shared/onchain-facts/index.mjs";
import { analyzeOnArc } from "./analyze-run.mjs";

let pass = 0, fail = 0;
const ok = (cond, label, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? `\n       ${detail}` : ""}`); }
};

const SUBJ = "0x1111111111111111111111111111111111111111";
const IMPL = "0x2222222222222222222222222222222222222222";
const OWNER = "0x3333333333333333333333333333333333333333";
const ZERO_WORD = "0x" + "0".repeat(64);
const word = (a) => "0x" + a.replace(/^0x/, "").padStart(64, "0");
const codeWith = (sigs) => "0x60806040" + sigs.map((s) => sel(s)).join("") + "00";

/** A mock client. `handlers` maps a key to a value, a thrower, or omits it (→ default). */
function mockClient(handlers = {}) {
  return {
    chain: { name: "mock-chain" },
    assert: async () => 5042002,
    pin: async () => ({ number: 1000, tag: "0x3e8" }),
    async call({ method, params }) {
      const key =
        method === "eth_getCode" ? `code@${String(params[0]).toLowerCase()}`
        : method === "eth_getStorageAt" ? `slot@${String(params[1]).toLowerCase()}`
        : method === "eth_call" ? `call@${String(params[0]?.data)}`
        : method;
      const h = handlers[key];
      if (h === undefined) throw Object.assign(new Error(`mock: unhandled ${key}`), { transient: false });
      if (typeof h === "function") return h();               // a thrower
      return { result: h, query: { endpoint: "mock://", method, params, reproduce: `# mock ${key}` }, evidence: { httpStatus: 200 } };
    },
  };
}
const transientThrow = () => { throw Object.assign(new Error("request limit reached"), { transient: true, query: { endpoint: "mock://", method: "m", params: [], reproduce: "# mock" } }); };
const revertThrow = () => { throw Object.assign(new Error("execution reverted"), { transient: false, query: { endpoint: "mock://", method: "m", params: [], reproduce: "# mock" } }); };

const powerGroups = Object.keys(POWER_SIGS);
const notCheckedPowers = (r) => r.coverage.notChecked.filter((n) => n.kind === "power").map((n) => n.group);
const checkedPowers = (r) => r.coverage.checked.filter((c) => c.kind === "power").map((c) => c.group);

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n── ROW 1 · LIVE control: the real XyloVault on Arc ──");
{
  const r = await analyzeOnArc("0x240Eb85458CD41361bd8C3773253a1D78054f747");
  ok(r.shape.class === "plain-contract", `shape is plain-contract (got ${r.shape.class})`);
  ok(r.owner.kind === "eoa", `owner classified eoa (got ${r.owner.kind})`);
  ok(r.powers.find((p) => p.power === "emergencyWithdraw")?.present === true, "emergencyWithdraw PRESENT — matches verify-vault's known-bad case");
  ok(r.powers.find((p) => p.power === "feesSettable")?.present === true, "feesSettable PRESENT — matches verify-vault");
  ok(notCheckedPowers(r).length === 0, `every power group was actually checked (notChecked: ${notCheckedPowers(r).length})`);
  ok(r.refusal === null, "no refusal on a healthy read");
  ok(r.reads.length > 0 && r.reads.every((x) => typeof x.reproduce === "string"), "every read carries a reproducible query");
  // ⭐ "each power carries the read that produced it" — the readId must actually RESOLVE, not be null.
  const readIds = new Set(r.reads.map((x) => x.readId));
  ok(r.powers.every((p) => p.evidence.readId !== null), "every power's evidence.readId is populated (not null)");
  ok(r.powers.every((p) => readIds.has(p.evidence.readId)), "…and every readId resolves to an entry in report.reads[]");
  const codeRead = r.reads.find((x) => x.readId === r.powers[0].evidence.readId);
  ok(codeRead?.method === "eth_getCode", `…and it points at the eth_getCode the selectors were matched in (got ${codeRead?.method})`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n── ROW 2 · FAULT: own-code read defeated → unknown, and it is a REPORT not a throw ──");
{
  let threw = false, r = null;
  try { r = await analyze(SUBJ, { client: mockClient({ [`code@${SUBJ}`]: transientThrow }) }); }
  catch { threw = true; }
  ok(!threw, "analyze() did NOT throw — an honest 'cannot assess' settles, an exception reads as a broken service");
  ok(r?.shape.class === "unknown", `shape is unknown (got ${r?.shape.class})`);
  ok(r?.refusal?.reason === "shape-unclassified", `refusal.reason is shape-unclassified (got ${r?.refusal?.reason})`);
  ok(r?.powers.length === 0, "powers is empty");
  ok(notCheckedPowers(r).length === powerGroups.length, `ALL ${powerGroups.length} power groups landed in notChecked (got ${notCheckedPowers(r).length})`);
  ok(r?.coverage.summary.includes("not a clean bill"), "coverage summary states this is not a clean bill");
  // First-class means it satisfies the same schema as any other report.
  ok(["schemaVersion", "severityMeaning", "subject", "shape", "powers", "coverage", "reads", "refusal"].every((k) => k in r),
     "the refusal carries EVERY schema field — it is a first-class report");
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n── ROW 3 · FAULT: impl-slot read defeated → BLOCK (defect B's shape) ──");
{
  const r = await analyze(SUBJ, { client: mockClient({
    [`code@${SUBJ}`]: codeWith(["pause()"]),
    [`slot@${EIP1967_IMPL_SLOT}`]: transientThrow,
  }) });
  ok(r.shape.class === "unknown", `an unread impl slot BLOCKS rather than assuming 'not a proxy' (got ${r.shape.class})`);
  ok(r.powers.length === 0, "no powers reported from a possibly-wrong contract");
  const rpcUnreadable = r.coverage.notChecked.some((n) => n.reason === "rpc-unreadable");
  ok(rpcUnreadable, "the defeated read is recorded as rpc-unreadable in the manifest");
  // CONTROL: the same shape with a READ-AND-EMPTY slot must still scan.
  const c = await analyze(SUBJ, { client: mockClient({
    [`code@${SUBJ}`]: codeWith(["pause()"]),
    [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD,
    [`call@0x8da5cb5b`]: word(OWNER), [`code@${OWNER}`]: "0x",
  }) });
  ok(c.shape.class === "plain-contract", `CONTROL: a read-and-empty slot still yields plain-contract (got ${c.shape.class})`);
  ok(c.powers.find((p) => p.power === "pausable")?.present === true, "CONTROL: pausable still detected on the healthy path");
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n── ROW 4 · FAULT: owner() defeated vs reverted — defect A stays fixed through the lift ──");
{
  const base = { [`code@${SUBJ}`]: codeWith(["pause()"]), [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD };
  const t = await analyze(SUBJ, { client: mockClient({ ...base, [`call@0x8da5cb5b`]: transientThrow }) });
  ok(t.owner.kind === "unreadable", `RPC-exhausted owner() → 'unreadable' (got ${t.owner.kind})`);
  ok(t.owner.kind !== "renounced" && t.owner.kind !== "no-owner-fn", "…and NOT the reassuring renounced/no-owner-fn");

  const v = await analyze(SUBJ, { client: mockClient({ ...base, [`call@0x8da5cb5b`]: revertThrow }) });
  ok(v.owner.kind === "no-owner-fn", `CONTROL: a genuine revert → 'no-owner-fn' (got ${v.owner.kind})`);

  const z = await analyze(SUBJ, { client: mockClient({ ...base, [`call@0x8da5cb5b`]: ZERO_WORD }) });
  ok(z.owner.kind === "renounced", `CONTROL: a confirmed zero address → 'renounced' (got ${z.owner.kind})`);

  const k = await analyze(SUBJ, { client: mockClient({ ...base, [`call@0x8da5cb5b`]: word(OWNER), [`code@${OWNER}`]: transientThrow }) });
  ok(k.owner.kind === "unreadable-kind", `owner known, its code unreadable → 'unreadable-kind' (got ${k.owner.kind})`);
  ok(k.owner.address === OWNER, "…and the known address is still reported");
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n── ROW 5 · SHAPES: each branch, and the diamond must NOT read as clean ──");
{
  const eoa = await analyze(SUBJ, { client: mockClient({ [`code@${SUBJ}`]: "0x" }) });
  ok(eoa.shape.class === "eoa", `no bytecode → eoa (got ${eoa.shape.class})`);
  ok(eoa.powers.length === 0 && notCheckedPowers(eoa).length === powerGroups.length,
     "an empty address yields powers UNOBSERVABLE (all groups notChecked), never powers: [] reading as clean");

  const diamondCode = codeWith([...DIAMOND_LOUPE_SIGS, "pause()"]);
  const d = await analyze(SUBJ, { client: mockClient({ [`code@${SUBJ}`]: diamondCode, [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD, [`call@0x8da5cb5b`]: word(OWNER), [`code@${OWNER}`]: "0x" }) });
  ok(d.shape.class === "eip2535-diamond", `loupe selectors → eip2535-diamond (got ${d.shape.class})`);
  ok(d.powers.length === 0, "a diamond reports NO powers from its own bytecode…");
  ok(notCheckedPowers(d).length === powerGroups.length, "…and every group is in notChecked instead");
  ok(d.coverage.notChecked.every((n) => n.kind !== "power" || /facet/i.test(n.why ?? "")),
     "…each with the facet-traversal reason, so it cannot be read as a clean bill");
  ok(d.powers.find((p) => p.power === "pausable") === undefined,
     "🚨 pause() IS in the diamond's bytecode but is NOT reported — scanning a diamond directly is invalid, and the skeleton refuses rather than half-answering");

  const clone = "0x" + EIP1167_PREFIX + IMPL.replace(/^0x/, "") + EIP1167_SUFFIX;
  const cl = await analyze(SUBJ, { client: mockClient({
    [`code@${SUBJ}`]: clone, [`code@${IMPL}`]: codeWith(["emergencyWithdraw()"]),
    [`call@0x8da5cb5b`]: word(OWNER), [`code@${OWNER}`]: "0x",
  }) });
  ok(cl.shape.class === "eip1167-clone", `canonical minimal-proxy bytecode → eip1167-clone (got ${cl.shape.class})`);
  ok(cl.shape.scannedAddress === IMPL, `powers scanned in the delegation target, not the stub (got ${cl.shape.scannedAddress})`);
  ok(cl.powers.find((p) => p.power === "emergencyWithdraw")?.present === true, "the TARGET's power is found through the clone");

  const tp = await analyze(SUBJ, { client: mockClient({
    [`code@${SUBJ}`]: codeWith([]), [`slot@${EIP1967_IMPL_SLOT}`]: word(IMPL), [`slot@${EIP1967_ADMIN_SLOT}`]: word(OWNER),
    [`code@${IMPL}`]: codeWith(["pause()"]), [`call@0x8da5cb5b`]: word(OWNER), [`code@${OWNER}`]: "0x",
  }) });
  ok(tp.shape.class === "eip1967-transparent" && tp.shape.variant === "transparent", `impl+admin slots set → transparent (got ${tp.shape.class})`);
  ok(tp.shape.scannedAddress === IMPL, "powers scanned in the implementation, not the proxy stub");

  const uu = await analyze(SUBJ, { client: mockClient({
    [`code@${SUBJ}`]: codeWith([]), [`slot@${EIP1967_IMPL_SLOT}`]: word(IMPL), [`slot@${EIP1967_ADMIN_SLOT}`]: ZERO_WORD,
    [`code@${IMPL}`]: codeWith(UUPS_SIGS), [`call@0x8da5cb5b`]: word(OWNER), [`code@${OWNER}`]: "0x",
  }) });
  ok(uu.shape.variant === "uups", `admin slot empty + UUPS entry point in the impl → uups (got ${uu.shape.variant})`);

  const ind = await analyze(SUBJ, { client: mockClient({
    [`code@${SUBJ}`]: codeWith([]), [`slot@${EIP1967_IMPL_SLOT}`]: word(IMPL), [`slot@${EIP1967_ADMIN_SLOT}`]: ZERO_WORD,
    [`code@${IMPL}`]: codeWith(["pause()"]), [`call@0x8da5cb5b`]: word(OWNER), [`code@${OWNER}`]: "0x",
  }) });
  ok(ind.shape.variant === "indeterminate" && ind.shape.class === "eip1967-proxy",
     `ambiguous variant stays 'indeterminate' rather than guessing transparent/uups (got ${ind.shape.class}/${ind.shape.variant})`);
  ok(ind.powers.find((p) => p.power === "pausable")?.present === true,
     "…and the FAMILY determination still does its job: the impl is scanned anyway");
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n── ROW 6 · ⭐ THE COMPLETENESS INVARIANT: an unaccounted group REFUSES ──");
{
  const healthy = await analyze(SUBJ, { client: mockClient({
    [`code@${SUBJ}`]: codeWith(["pause()"]), [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD,
    [`call@0x8da5cb5b`]: word(OWNER), [`code@${OWNER}`]: "0x",
  }) });
  ok(healthy.refusal === null, "CONTROL: a fully-accounted report does not refuse");

  // Doctor the manifest to drop one group — simulating "a group was added to the catalogue and the
  // enumeration was never wired to it", the exact drift a static coverage list cannot catch.
  const doctored = structuredClone(healthy);
  doctored.coverage.checked = doctored.coverage.checked.filter((c) => c.group !== "denylist");
  const v = assertReportValid(doctored);
  ok(v.refusal?.reason === "coverage-incomplete", `dropping one group → refusal 'coverage-incomplete' (got ${v.refusal?.reason})`);
  ok(v.powers.length === 0, "…and the refusal empties powers rather than shipping a partial inventory as complete");
  ok(v.refusal.problems.some((p) => p.includes("denylist")), "…naming the unaccounted group");

  const dup = structuredClone(healthy);
  dup.coverage.checked.push({ kind: "power", group: "pausable", id: "power:pausable", outcome: "ran" });
  ok(assertReportValid(dup).refusal?.reason === "coverage-incomplete", "a double-registered group also refuses");

  const bogus = structuredClone(healthy);
  bogus.coverage.checked.push({ kind: "power", group: "notInCatalogue", id: "power:notInCatalogue", outcome: "ran" });
  ok(assertReportValid(bogus).refusal?.reason === "coverage-incomplete", "a group not in the shared catalogue also refuses");
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n── ROW 7 · SEVERITY IS SCOPE, NOT A SCORE ──");
{
  const r = await analyze(SUBJ, { client: mockClient({
    [`code@${SUBJ}`]: codeWith(["pause()", "upgradeTo(address)"]), [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD,
    [`call@0x8da5cb5b`]: word(OWNER), [`code@${OWNER}`]: "0x",
  }) });
  ok(r.powers.every((p) => typeof p.severity === "string"), "every severity is a string, never a number");
  ok(r.powers.every((p) => SCOPE_CLASSES.includes(p.severity)), "every severity is a declared scope class");
  ok(Object.keys(POWER_SIGS).every((g) => POWER_SCOPE[g]), "every catalogue group has a scope class");
  ok(typeof r.severityMeaning === "string" && /MUST NOT be summed/.test(r.severityMeaning),
     "the report carries the machine-readable scope-not-rank statement");
  const exported = Object.keys(analyzeModule);
  ok(!exported.some((k) => /score|total|aggregate|sum|rank|risk/i.test(k)),
     `the module exports no scorer/aggregator (exports: ${exported.join(", ")})`);
  const numeric = structuredClone(r); numeric.powers[0].severity = 3;
  ok(assertReportValid(numeric).refusal?.reason === "coverage-incomplete", "a NUMERIC severity is rejected by the validator");
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n── ROW 8 · ⭐ QUORUM MATRIX: agree→value, everything else→unreadable via coverage ──");
{
  const mkc = (rpc, handlers, chainId = 5042002) => ({ ...mockClient(handlers), chain: { name: "mock", rpc }, assert: async () => chainId });
  const A = "https://endpoint-a.example", B = "https://endpoint-b.example";
  const base = (code) => ({ [`code@${SUBJ}`]: code, [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD, [`call@0x8da5cb5b`]: word(OWNER), [`code@${OWNER}`]: "0x" });
  const q = (ha, hb) => quorumClient([mkc(A, ha), mkc(B, hb)]);
  const codeP = codeWith(["pause()"]);

  // 1. AGREE → value
  const agree = await analyze(SUBJ, { client: q(base(codeP), base(codeP)) });
  ok(agree.powers.find((p) => p.power === "pausable")?.present === true, "AGREE → the value stands (pausable detected)");
  ok(agree.coverage.notChecked.length === 0, "AGREE → nothing in notChecked");
  ok(agree.sources.mode === "quorum" && agree.sources.independenceVerified === false,
     "the report declares quorum mode AND independenceVerified=false");
  const codeCheck = agree.coverage.checked.find((c) => c.id === "shape:code@address");
  ok(codeCheck?.quorum?.agreed === 2, `the checked entry records agreed=2 of 2 (got ${codeCheck?.quorum?.agreed})`);
  ok(agree.reads.filter((r) => r.method === "eth_getCode").length >= 2, "BOTH endpoints' curls are recorded in reads[]");

  // 2. DISAGREE on a terminal claim (owner) → powers still reported, holder is not
  const dis = await analyze(SUBJ, { client: q(
    { ...base(codeP), [`call@0x8da5cb5b`]: word(OWNER) },
    { ...base(codeP), [`call@0x8da5cb5b`]: word("0x9999999999999999999999999999999999999999") }) });
  const ownerEntry = dis.coverage.notChecked.find((n) => n.id === "owner:owner()");
  ok(ownerEntry?.reason === "rpc-disagreement", `DISAGREE → notChecked reason "rpc-disagreement" (got ${ownerEntry?.reason})`);
  ok(ownerEntry?.responses?.length === 2, "…carrying BOTH endpoints' answers as evidence");
  ok(ownerEntry.responses.some((r) => String(r.value).includes("9999")) && ownerEntry.responses.some((r) => String(r.value).includes("3333")),
     "…and the two answers are visibly different");
  ok(dis.owner.kind === "unreadable", `…holder degrades to 'unreadable', never a picked winner (got ${dis.owner.kind})`);
  ok(dis.powers.length === 9, "…while the powers, which do not depend on the owner, are STILL reported");
  console.log("     ┌─ the coverage entry as it appears in the report:");
  console.log("     │ " + JSON.stringify({ id: ownerEntry.id, reason: ownerEntry.reason, responses: ownerEntry.responses }).slice(0, 300));

  // 2b. ⚠️ DOCUMENTED CONSEQUENCE: a genuinely ABSENT owner() reads as `unreadable` under quorum,
  //     not `no-owner-fn`. Both endpoints reverting is an AGREED negative observation, but error
  //     quorum cannot be done textually: the providers use different error vocabularies for the same
  //     condition (arc -32604 "this request method is not supported" vs drpc -32601 "method is not
  //     available"), so comparing error strings or codes across them is unsound. Pass 1 therefore
  //     treats all-throw as unreadable — fail-CLOSED, but a real behavioural difference from
  //     single-RPC mode that must not be discovered by surprise later.
  const bothRevert = await analyze(SUBJ, { client: q(
    { ...base(codeP), [`call@0x8da5cb5b`]: revertThrow },
    { ...base(codeP), [`call@0x8da5cb5b`]: revertThrow }) });
  ok(bothRevert.owner.kind === "unreadable",
     `both-revert on owner() → 'unreadable' under quorum, NOT 'no-owner-fn' (got ${bothRevert.owner.kind}) — documented fail-closed divergence from single-RPC`);

  // 3. DISAGREE on a CONDITIONAL claim (impl slot) → whole shape unknown → full refusal
  const disShape = await analyze(SUBJ, { client: q(
    { ...base(codeP), [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD },
    { ...base(codeP), [`slot@${EIP1967_IMPL_SLOT}`]: word(IMPL) }) });
  ok(disShape.shape.class === "unknown", `a split on the impl slot BLOCKS the whole shape (got ${disShape.shape.class})`);
  ok(disShape.refusal?.reason === "shape-unclassified", "…and the report is a refusal");
  ok(disShape.powers.length === 0 && notCheckedPowers(disShape).length === 9, "…with all nine groups unscanned");
  ok(disShape.coverage.notChecked.some((n) => n.reason === "rpc-disagreement"), "…the disagreement is named in the manifest");

  // 4. ONE READS, ONE THROWS → NOT the surviving value. quorum-unmet.
  const oneDown = await analyze(SUBJ, { client: q(base(codeP), { ...base(codeP), [`code@${SUBJ}`]: transientThrow }) });
  ok(oneDown.shape.class === "unknown", "ONE-THROWS → no value taken from the survivor (shape unknown)");
  const unmet = oneDown.coverage.notChecked.find((n) => n.reason === "rpc-quorum-unmet");
  ok(unmet !== undefined, `…reason "rpc-quorum-unmet" (got ${oneDown.coverage.notChecked.map((n) => n.reason).join(",")})`);
  ok(unmet?.responses?.some((r) => r.error) && unmet?.responses?.some((r) => r.value !== undefined),
     "…the manifest shows one endpoint answered and one threw");

  // 5. BOTH THROW → unreadable
  const bothDown = await analyze(SUBJ, { client: q({ [`code@${SUBJ}`]: transientThrow }, { [`code@${SUBJ}`]: transientThrow }) });
  ok(bothDown.shape.class === "unknown", "BOTH-THROW → shape unknown");
  ok(bothDown.coverage.notChecked.some((n) => n.reason === "rpc-unreadable"), "…reason 'rpc-unreadable' (distinct from a disagreement)");

  // 6. Nothing ever escapes as an exception.
  let threw = false;
  try { await analyze(SUBJ, { client: q({ [`code@${SUBJ}`]: transientThrow }, { [`code@${SUBJ}`]: revertThrow }) }); } catch { threw = true; }
  ok(!threw, "no quorum outcome escapes analyze() as a thrown error");

  // 7. Chain guard: an endpoint on the WRONG chain is excluded loudly, never tolerated.
  const wrongChain = quorumClient([mkc(A, base(codeP)), mkc(B, base(codeP), 8453)]);
  const wc = await analyze(SUBJ, { client: wrongChain });
  ok(wc.refusal?.reason === "chain-unreachable", `mismatched chain ids across endpoints → refusal (got ${wc.refusal?.reason})`);

  // 8. The completeness invariant still holds under quorum failure.
  for (const r of [dis, disShape, oneDown, bothDown]) {
    const n = [...r.coverage.checked, ...r.coverage.notChecked].filter((e) => e.kind === "power").length;
    if (n !== 9) { fail++; console.log(`  ❌ completeness invariant broke under quorum failure (${n}/9)`); }
  }
  ok(true, "the completeness invariant holds across every quorum failure mode (9/9 groups accounted for)");
}

console.log(`\n${"═".repeat(92)}`);
console.log(`verify-analyze: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
