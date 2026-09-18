// verify-treasury-plan.mjs — the treasury policy document and the PURE rebalance planner.
//
//   node --experimental-test-module-mocks scripts/verify-treasury-plan.mjs   (npm run test:treasuryplan)
//
// ═══ THE PROPERTIES ══════════════════════════════════════════════════════════════════════════════
//   1. A policy is validated strictly: integer pcts 0–100 summing ≤ 100 (remainder = unallocated, stated),
//      known chains, valid addresses, ≤ 4 dest rows, UNKNOWN FIELDS REFUSED (never silently kept).
//   2. Money math is exact micro-units — no float — and the total is NULL if ANY USDC pocket is unreadable.
//   3. With a null total there are NO proposals (shares unknown); with no policy, shares but no proposals.
//   4. A proposal is clamped to min(surplus, deficit, per-tx cap) and the clamp is NAMED; below minMove nothing.
//   5. Only rails that exist: arc_sca→unified deposit · unified→arc_sca withdraw (~7d) · arc_sca→dest bridge ·
//      unified→dest = withdraw with a two-step note · dest→anything NOT movable. EURC is never a pocket.
//   6. The allowed destination chains are exactly the server's DESTINATION_CHAINS keys (no drift).
//   7. Transport: strong read; unreadable store ≠ absent policy; a stored-but-invalid document is reported.
import { mock } from "node:test";
const mem = new Map(); let unreadable = false;
mock.module("@netlify/blobs", { namedExports: { getStore: () => ({
  get: async (k) => { if (unreadable) throw new Error("store down"); return mem.has(k) ? JSON.parse(mem.get(k)) : null; },
  setJSON: async (k, v) => { mem.set(k, JSON.stringify(v)); return { modified: true }; },
  delete: async (k) => { mem.delete(k); },
}) } });
const P = await import("../shared/treasury/plan.mjs");
const { normalizeTreasuryPolicy, planRebalance, toUnits, fromUnits, totalUsdc, destPocketId, POCKET, MOVE } = P;
const T = await import("../netlify/functions/_treasury-policy.mjs");
const { DESTINATION_CHAINS } = await import("../netlify/functions/_receipt.mjs");

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const CHAINS = Object.keys(DESTINATION_CHAINS);
const ADDR = "0x" + "ab".repeat(20);
const norm = (raw) => normalizeTreasuryPolicy(raw, { allowedChains: CHAINS });
const pocket = (id, usdc, extra = {}) => ({ id, label: id, chain: id === POCKET.UNIFIED ? "Gateway" : "Arc", usdc, ok: usdc != null, ...extra });
const CAPS = { bridgeCapUsdc: "25", ubDepositMaxPerTxUsdc: "100" };

console.log("\nverify-treasury-plan — the policy document and the pure planner\n");

section("1 — units are exact");
{
  check("toUnits/fromUnits round-trip", fromUnits(toUnits("1.5")) === "1.500000" && fromUnits(toUnits("0.000001")) === "0.000001" && fromUnits(toUnits(2)) === "2.000000");
  check(">6 places, exponent, negative, junk → null", [toUnits("1.2345678"), toUnits("1e-7"), toUnits("-1"), toUnits("abc"), toUnits("")].every((v) => v === null));
  check("fromUnits negative", fromUnits(-1500000n) === "-1.500000");
}

section("2 — policy validation is strict");
{
  const ok = norm({ targets: { arc_sca: 40, unified: 40, dest: [{ chain: "base", address: ADDR, pct: 10 }] } });
  check("valid policy normalizes; unallocated stated", !!ok.policy && ok.policy.unallocatedPct === 10 && ok.policy.minMoveUsdc === "1.000000", ok.error);
  check("sum > 100 refused with the sum named", /110%/.test(norm({ targets: { arc_sca: 60, unified: 50 } }).error || ""));
  check("non-integer / out-of-range pct refused", /integer/.test(norm({ targets: { arc_sca: 33.3 } }).error || "") && /integer/.test(norm({ targets: { unified: 101 } }).error || ""));
  check("🚨 unknown top-level field REFUSED, not dropped", /unknown policy field/.test(norm({ targets: { arc_sca: 10 }, autoRebalance: true }).error || ""));
  check("🚨 unknown target REFUSED", /unknown target/.test(norm({ targets: { arc_sca: 10, base: 5 } }).error || ""));
  check("unknown dest chain refused", /unknown destination chain/.test(norm({ targets: { dest: [{ chain: "solana", address: ADDR, pct: 5 }] } }).error || ""));
  check("bad dest address refused", /not a valid address/.test(norm({ targets: { dest: [{ chain: "base", address: "0x12", pct: 5 }] } }).error || ""));
  check("duplicate dest refused; >4 rows refused", /duplicate/.test(norm({ targets: { dest: [{ chain: "base", address: ADDR, pct: 1 }, { chain: "base", address: ADDR.toUpperCase().replace("0X", "0x"), pct: 1 }] } }).error || "") && /at most 4/.test(norm({ targets: { dest: CHAINS.slice(0, 5).map((c) => ({ chain: c, address: ADDR, pct: 1 })) } }).error || ""));
  check("unknown dest field refused", /unknown dest field/.test(norm({ targets: { dest: [{ chain: "base", address: ADDR, pct: 1, note: "x" }] } }).error || ""));
  check("minMoveUsdc validated (6dp), default 1", norm({ targets: { arc_sca: 1 }, minMoveUsdc: "0.5" }).policy?.minMoveUsdc === "0.500000" && /minMoveUsdc/.test(norm({ targets: { arc_sca: 1 }, minMoveUsdc: "1e-9" }).error || ""));
  check("wrong version refused", /version/.test(norm({ version: 2, targets: { arc_sca: 1 } }).error || ""));
}

section("3 — total: exact, and NULL if any USDC pocket is unreadable; EURC never counted");
{
  const ps = [pocket(POCKET.ARC_SCA, "31.309999"), pocket(POCKET.UNIFIED, "4"), pocket("arc_sca_eurc", "0.175418", { asset: "EURC" })];
  check("⭐ total is the exact sum of USDC pockets (EURC excluded)", fromUnits(totalUsdc(ps)) === "35.309999");
  const bad = [pocket(POCKET.ARC_SCA, "31.309999"), pocket(POCKET.UNIFIED, null)];
  check("🚨 one unreadable pocket → total NULL, never a partial sum", totalUsdc(bad) === null);
  const plan = planRebalance({ pockets: bad, policy: norm({ targets: { arc_sca: 50, unified: 50 } }).policy, caps: CAPS });
  check("🚨 …and NO proposals, the unreadable pocket NAMED", plan.total === null && plan.proposals.length === 0 && plan.unreadable.includes(POCKET.UNIFIED) && /unreadable/.test(plan.reason));
  const noPolicy = planRebalance({ pockets: ps, policy: null, caps: CAPS });
  check("no policy → shares shown, no proposals, reason 'no targets set'", noPolicy.total === "35.309999" && noPolicy.proposals.length === 0 && /no targets/.test(noPolicy.reason) && noPolicy.shares.find((s) => s.id === POCKET.ARC_SCA).targetPct === null);
}

section("4 — proposals: drift → move, clamped and NAMED, minMove respected");
{
  const pol = norm({ targets: { arc_sca: 50, unified: 50 } }).policy;
  const ps = [pocket(POCKET.ARC_SCA, "80"), pocket(POCKET.UNIFIED, "20")];
  const plan = planRebalance({ pockets: ps, policy: pol, caps: CAPS });
  check("⭐ 80/20 with 50/50 targets → ONE ub_deposit of 30 from arc_sca to unified", plan.proposals.length === 1 && plan.proposals[0].kind === MOVE.UB_DEPOSIT && plan.proposals[0].amountUsdc === "30.000000" && plan.proposals[0].from === POCKET.ARC_SCA && plan.proposals[0].to === POCKET.UNIFIED, JSON.stringify(plan.proposals[0]));
  check("…shares and drift are reported", plan.shares.find((s) => s.id === POCKET.ARC_SCA).sharePct === 80 && plan.shares.find((s) => s.id === POCKET.UNIFIED).driftUsdc === "30.000000");
  const capped = planRebalance({ pockets: [pocket(POCKET.ARC_SCA, "400"), pocket(POCKET.UNIFIED, "0")], policy: pol, caps: CAPS });
  check("⭐ deposit clamped to the 100 cap with the clamp NAMED (closes 100 of 200)", capped.proposals[0].amountUsdc === "100.000000" && /limit of 100\.000000/.test(capped.proposals[0].capNote) && /100\.000000 of 200\.000000/.test(capped.proposals[0].capNote), capped.proposals[0]?.capNote);
  const rev = planRebalance({ pockets: [pocket(POCKET.ARC_SCA, "20"), pocket(POCKET.UNIFIED, "80")], policy: pol, caps: CAPS });
  check("⭐ the reverse drift → ub_withdraw of 30 with the ~7-day note, no cap", rev.proposals[0].kind === MOVE.UB_WITHDRAW && rev.proposals[0].amountUsdc === "30.000000" && /seven days/.test(rev.proposals[0].note) && rev.proposals[0].capNote === null);
  const dust = planRebalance({ pockets: [pocket(POCKET.ARC_SCA, "50.4"), pocket(POCKET.UNIFIED, "49.6")], policy: pol, caps: CAPS });
  check("drift below minMove (1) → no proposal", dust.proposals.length === 0);
  const eq = planRebalance({ pockets: [pocket(POCKET.ARC_SCA, "50"), pocket(POCKET.UNIFIED, "50")], policy: pol, caps: CAPS });
  check("on target → no proposal", eq.proposals.length === 0);
  const zero = planRebalance({ pockets: [pocket(POCKET.ARC_SCA, "0"), pocket(POCKET.UNIFIED, "0")], policy: pol, caps: CAPS });
  check("empty treasury → total 0, shares 0, no proposals, no division error", zero.total === "0.000000" && zero.proposals.length === 0 && zero.shares.every((s) => s.sharePct === 0));
}

section("5 — rails: bridge to a named destination; unified→dest is two-step; dest is not movable");
{
  const dest = destPocketId("base", ADDR);
  const pol = norm({ targets: { arc_sca: 50, unified: 0, dest: [{ chain: "base", address: ADDR, pct: 50 }] } }).policy;
  const p1 = planRebalance({ pockets: [pocket(POCKET.ARC_SCA, "100"), pocket(POCKET.UNIFIED, "0"), pocket(dest, "0", { chain: "base", address: ADDR })], policy: pol, caps: CAPS });
  check("⭐ arc_sca → dest = bridge, clamped to the 25 bridge cap and NAMED (25 of 50)", p1.proposals[0]?.kind === MOVE.BRIDGE && p1.proposals[0].amountUsdc === "25.000000" && /bridge per-transaction limit of 25\.000000/.test(p1.proposals[0].capNote) && p1.proposals[0].surface === "bridge", JSON.stringify(p1.proposals[0]));
  check("…the bridge fee is deferred to the Bridge page, not invented", /quoted on the Bridge page/.test(p1.proposals[0].note));
  const p2 = planRebalance({ pockets: [pocket(POCKET.ARC_SCA, "0"), pocket(POCKET.UNIFIED, "100"), pocket(dest, "0", { chain: "base", address: ADDR })], policy: pol, caps: CAPS });
  const kinds = p2.proposals.map((p) => `${p.kind}:${p.to}`);
  check("⭐ unified → arc_sca (withdraw 50) and unified → dest as a two-step withdraw note", kinds.includes(`${MOVE.UB_WITHDRAW}:${POCKET.ARC_SCA}`) && p2.proposals.some((p) => p.to === dest && p.kind === MOVE.UB_WITHDRAW && /two steps/.test(p.note)), JSON.stringify(kinds));
  const p3 = planRebalance({ pockets: [pocket(POCKET.ARC_SCA, "0"), pocket(POCKET.UNIFIED, "0"), pocket(dest, "100", { chain: "base", address: ADDR })], policy: pol, caps: CAPS });
  check("🚨 a surplus at a named destination is NOT movable from here — no proposal, listed in notMovable", p3.proposals.length === 0 && p3.notMovable.includes(dest));
  const eurc = planRebalance({ pockets: [pocket(POCKET.ARC_SCA, "50"), pocket(POCKET.UNIFIED, "50"), pocket("arc_sca_eurc", "999", { asset: "EURC" })], policy: norm({ targets: { arc_sca: 50, unified: 50 } }).policy, caps: CAPS });
  check("EURC never enters shares or proposals", eurc.total === "100.000000" && !eurc.shares.some((s) => s.id === "arc_sca_eurc") && eurc.proposals.length === 0);
  check("⭐ biggest deficit is served first", (() => { const d1 = destPocketId("base", ADDR), d2 = destPocketId("polygon", ADDR); const pol2 = norm({ targets: { arc_sca: 0, dest: [{ chain: "base", address: ADDR, pct: 10 }, { chain: "polygon", address: ADDR, pct: 20 }] } }).policy; const r = planRebalance({ pockets: [pocket(POCKET.ARC_SCA, "100"), pocket(POCKET.UNIFIED, "0"), pocket(d1, "0", { chain: "base", address: ADDR }), pocket(d2, "0", { chain: "polygon", address: ADDR })], policy: pol2, caps: CAPS }); return r.proposals[0]?.to === d2; })());
}

section("6 — allowed destination chains are exactly the server's DESTINATION_CHAINS keys");
{
  check("ALLOWED_DEST_CHAINS === Object.keys(DESTINATION_CHAINS)", JSON.stringify(T.ALLOWED_DEST_CHAINS) === JSON.stringify(CHAINS), JSON.stringify(T.ALLOWED_DEST_CHAINS));
  check("the eight CCTP destinations are present", ["ethereum", "base", "arbitrum", "optimism", "avalanche", "polygon", "unichain", "linea"].every((c) => CHAINS.includes(c)));
}

section("7 — transport: strong read, unreadable ≠ absent, invalid stored doc reported");
{
  mem.clear(); unreadable = false;
  const OWNER = "0x" + "77".repeat(20);
  const absent = await T.readTreasuryPolicy(OWNER);
  check("absent → readable:true, policy:null", absent.readable && absent.policy === null);
  const w = await T.writeTreasuryPolicy(OWNER, { targets: { arc_sca: 60, unified: 40 } });
  check("write validates and stores under o/<ownerLower>", w.ok && mem.has(`o/${OWNER.toLowerCase()}`));
  const r = await T.readTreasuryPolicy(OWNER.toUpperCase().replace("0X", "0x"));
  check("read back (case-insensitive owner) → the normalized policy + storedAt", r.policy?.targets.arc_sca === 60 && !!r.storedAt);
  const bad = await T.writeTreasuryPolicy(OWNER, { targets: { arc_sca: 60, unified: 50 } });
  check("invalid write refused with the reason", !bad.ok && /110%/.test(bad.error));
  mem.set(`o/${OWNER.toLowerCase()}`, JSON.stringify({ policy: { targets: { arc_sca: 999 } }, storedAt: "x" }));
  const inv = await T.readTreasuryPolicy(OWNER);
  check("a stored-but-invalid document → policy:null with the error named (not silently used)", inv.readable && inv.policy === null && /stored policy invalid/.test(inv.error));
  unreadable = true;
  const ur = await T.readTreasuryPolicy(OWNER);
  check("🚨 unreadable store → readable:false, NOT 'no policy'", ur.readable === false && /unreadable/.test(ur.error));
  unreadable = false;
  const c = await T.clearTreasuryPolicy(OWNER);
  check("clear removes it", c.ok && !mem.has(`o/${OWNER.toLowerCase()}`));
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0\n`);
