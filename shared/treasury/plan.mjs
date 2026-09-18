// shared/treasury/plan.mjs — the TREASURY policy document and the PURE rebalance planner.
//
// ═══ WHAT A "TREASURY" IS HERE (decided 2026-09-19) ═════════════════════════════════════════════
// PER-USER. "Your treasury" = the signed-in user's own USDC pockets: the Arc agent SCA, the Gateway
// unified balance (Arc + Base Sepolia domains), and USDC held at destination-chain addresses the user
// NAMES. Targets are percentages of the USDC total. The planner computes drift and PROPOSES moves; it
// never executes one. Every proposal is confirmed on the surface that already carries that move's
// disclosures and caps (#/unified for deposit/withdraw, #/bridge for a bridge) — the fee is quoted
// THERE, never invented here. ⛔ No scheduler, no signer, no pooled wallet.
//
// ═══ THE RULES THE PLANNER KEEPS ════════════════════════════════════════════════════════════════
//   · integer micro-units throughout — no float on money ([[conversation-sourced-numbers-must-be-marked]])
//   · a total is NULL if ANY USDC pocket is unreadable, and with a null total there are NO proposals:
//     shares cannot be known, and a move sized from a guess is a move the user did not ask for
//     ([[absence-must-never-read-as-safe]])
//   · EURC is shown by the console but is NEVER a pocket here — no USD rate exists
//   · a move is clamped to the SMALLER of: the surplus, the deficit, the move's per-transaction cap;
//     the clamp is NAMED in `capNote` so a partial move is not read as a full one
//   · below `minMoveUsdc` no proposal is made (dust moves cost fees and prove nothing)
//   · only rails that EXIST are proposed: arc_sca→unified = ub_deposit · unified→arc_sca =
//     ub_withdraw (~7 days) · arc_sca→dest = bridge · unified→dest = ub_withdraw with a two-step note
//     · dest→anything = NOT movable from here (a named address is not ours to sign for)
export const POLICY_VERSION = 1;
export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const MAX_DEST_ROWS = 4;
export const DEFAULT_MIN_MOVE_USDC = "1";
export const POCKET = Object.freeze({ ARC_SCA: "arc_sca", UNIFIED: "unified" });
export const MOVE = Object.freeze({ UB_DEPOSIT: "ub_deposit", UB_WITHDRAW: "ub_withdraw", BRIDGE: "bridge" });

const UNITS = 1_000_000n;
const low = (s) => String(s || "").toLowerCase();

/** Exact decimal string → micro-units (BigInt). ≤6 places; anything else → null. */
export function toUnits(v) {
  const s = (typeof v === "number" ? String(v) : String(v ?? "")).trim();
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return null;
  return BigInt(m[1]) * UNITS + BigInt((m[2] ?? "").padEnd(6, "0"));
}
/** micro-units → 6dp string. Exact. */
export function fromUnits(u) {
  const neg = u < 0n; const a = neg ? -u : u;
  const s = a.toString().padStart(7, "0");
  return `${neg ? "-" : ""}${s.slice(0, -6)}.${s.slice(-6)}`;
}
export const destPocketId = (chain, address) => `dest:${chain}:${low(address)}`;

/**
 * Validate a raw policy document. Returns { policy } or { error }. Pure; `allowedChains` = the
 * DESTINATION_CHAINS keys the server can read (passed in so this module imports no server code).
 * Unknown fields are REFUSED, not dropped: a field we do not understand is a claim we would silently
 * keep and later act on.
 */
export function normalizeTreasuryPolicy(raw, { allowedChains }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "policy must be an object" };
  const known = new Set(["version", "targets", "minMoveUsdc"]);
  const unknown = Object.keys(raw).filter((k) => !known.has(k));
  if (unknown.length) return { error: `unknown policy field(s): ${unknown.join(", ")}` };
  if (raw.version !== undefined && raw.version !== POLICY_VERSION) return { error: `unsupported policy version ${raw.version}` };
  const t = raw.targets;
  if (!t || typeof t !== "object" || Array.isArray(t)) return { error: "targets must be an object" };
  const tKnown = new Set(["arc_sca", "unified", "dest"]);
  const tUnknown = Object.keys(t).filter((k) => !tKnown.has(k));
  if (tUnknown.length) return { error: `unknown target(s): ${tUnknown.join(", ")}` };
  const pct = (v, name) => {
    if (v === undefined) return 0;
    if (!Number.isInteger(v) || v < 0 || v > 100) throw new Error(`${name} target must be an integer 0–100`);
    return v;
  };
  try {
    const arc = pct(t.arc_sca, "arc_sca"); const uni = pct(t.unified, "unified");
    const destIn = t.dest === undefined ? [] : t.dest;
    if (!Array.isArray(destIn)) return { error: "dest must be an array" };
    if (destIn.length > MAX_DEST_ROWS) return { error: `at most ${MAX_DEST_ROWS} destination rows` };
    const dest = []; const seen = new Set();
    for (const row of destIn) {
      if (!row || typeof row !== "object") return { error: "dest row must be an object" };
      const rk = Object.keys(row).filter((k) => !["chain", "address", "pct"].includes(k));
      if (rk.length) return { error: `unknown dest field(s): ${rk.join(", ")}` };
      if (!allowedChains.includes(row.chain)) return { error: `unknown destination chain "${row.chain}"` };
      if (!ADDRESS_RE.test(row.address || "")) return { error: `dest address for ${row.chain} is not a valid address` };
      const id = destPocketId(row.chain, row.address);
      if (seen.has(id)) return { error: `duplicate destination ${row.chain} ${row.address}` };
      seen.add(id);
      dest.push({ chain: row.chain, address: row.address, pct: pct(row.pct, `${row.chain} dest`) });
    }
    const sum = arc + uni + dest.reduce((s, d) => s + d.pct, 0);
    if (sum > 100) return { error: `targets sum to ${sum}% — at most 100% (the remainder is unallocated)` };
    const mm = raw.minMoveUsdc === undefined ? DEFAULT_MIN_MOVE_USDC : String(raw.minMoveUsdc);
    const mmU = toUnits(mm);
    if (mmU === null || mmU < 0n) return { error: "minMoveUsdc must be a decimal number with at most 6 places" };
    return { policy: { version: POLICY_VERSION, targets: { arc_sca: arc, unified: uni, dest }, minMoveUsdc: fromUnits(mmU), unallocatedPct: 100 - sum } };
  } catch (e) {
    return { error: e.message };
  }
}

/** Sum the USDC pockets. Null if any USDC pocket is unreadable — never a partial sum. */
export function totalUsdc(pockets) {
  let sum = 0n;
  for (const p of pockets) {
    if (p.asset && p.asset !== "USDC") continue;
    if (!p.ok || p.usdc == null) return null;
    const u = toUnits(p.usdc); if (u === null) return null;
    sum += u;
  }
  return sum;
}

function railFor(from, to) {
  const isDest = (id) => id.startsWith("dest:");
  if (from === POCKET.ARC_SCA && to === POCKET.UNIFIED) return { kind: MOVE.UB_DEPOSIT, capKey: "ubDepositMaxPerTxUsdc", surface: "unified", note: null };
  if (from === POCKET.UNIFIED && to === POCKET.ARC_SCA) return { kind: MOVE.UB_WITHDRAW, capKey: null, surface: "unified", note: "about seven days: the Gateway holds a withdrawal for its delay before it returns to your agent wallet" };
  if (from === POCKET.ARC_SCA && isDest(to)) return { kind: MOVE.BRIDGE, capKey: "bridgeCapUsdc", surface: "bridge", note: "the bridge fee is quoted on the Bridge page before anything moves" };
  if (from === POCKET.UNIFIED && isDest(to)) return { kind: MOVE.UB_WITHDRAW, capKey: null, surface: "unified", note: "two steps: withdraw to your agent wallet first (about seven days), then bridge from Arc once it lands" };
  return null; // dest → anything: not movable from here
}

/**
 * planRebalance — pure. Input pockets [{id, label, chain, address?, asset?, usdc, ok}], a normalized
 * policy (or null), caps {bridgeCapUsdc, ubDepositMaxPerTxUsdc} as decimal strings.
 * Output { total, shares:[{id, usdc, sharePct, targetPct, driftUsdc}], proposals:[…], unreadable:[ids], reason? }.
 */
export function planRebalance({ pockets, policy, caps }) {
  const usdcPockets = pockets.filter((p) => !p.asset || p.asset === "USDC");
  const unreadable = usdcPockets.filter((p) => !p.ok || p.usdc == null).map((p) => p.id);
  const total = totalUsdc(usdcPockets);
  if (total === null) return { total: null, shares: [], proposals: [], unreadable, reason: `no proposals: ${unreadable.length} pocket(s) unreadable, so shares are unknown` };
  if (!policy) return { total: fromUnits(total), shares: usdcPockets.map((p) => ({ id: p.id, usdc: fromUnits(toUnits(p.usdc)), sharePct: total === 0n ? 0 : Number((toUnits(p.usdc) * 10000n) / total) / 100, targetPct: null, driftUsdc: null })), proposals: [], unreadable: [], reason: "no targets set" };
  const targetPct = new Map([[POCKET.ARC_SCA, policy.targets.arc_sca], [POCKET.UNIFIED, policy.targets.unified]]);
  for (const d of policy.targets.dest) targetPct.set(destPocketId(d.chain, d.address), d.pct);
  const shares = usdcPockets.map((p) => {
    const u = toUnits(p.usdc); const tp = targetPct.get(p.id) ?? 0;
    const targetU = (total * BigInt(tp)) / 100n;
    return { id: p.id, usdc: fromUnits(u), sharePct: total === 0n ? 0 : Number((u * 10000n) / total) / 100, targetPct: tp, driftUsdc: fromUnits(targetU - u), _u: u, _target: targetU };
  });
  const minMove = toUnits(policy.minMoveUsdc) ?? 0n;
  const capU = (key) => (key && caps?.[key] != null ? toUnits(caps[key]) : null);
  // surplus pockets give, deficit pockets receive; biggest deficit first, then biggest surplus.
  const deficits = shares.filter((s) => s._target > s._u).map((s) => ({ id: s.id, need: s._target - s._u })).sort((a, b) => (b.need > a.need ? 1 : b.need < a.need ? -1 : 0));
  const surpluses = shares.filter((s) => s._u > s._target).map((s) => ({ id: s.id, have: s._u - s._target })).sort((a, b) => (b.have > a.have ? 1 : b.have < a.have ? -1 : 0));
  const proposals = [];
  for (const d of deficits) {
    for (const s of surpluses) {
      if (d.need < minMove) break;
      if (s.have < minMove) continue;
      const rail = railFor(s.id, d.id);
      if (!rail) continue;
      let amt = d.need < s.have ? d.need : s.have;
      const cap = capU(rail.capKey);
      let capNote = null;
      if (cap !== null && amt > cap) { capNote = `capped at the ${rail.kind === MOVE.BRIDGE ? "bridge" : "deposit"} per-transaction limit of ${fromUnits(cap)} USDC — this closes ${fromUnits(cap)} of ${fromUnits(amt)}; run again after it lands`; amt = cap; }
      if (amt < minMove) continue;
      proposals.push({ kind: rail.kind, from: s.id, to: d.id, amountUsdc: fromUnits(amt), surface: rail.surface, capNote, note: rail.note });
      d.need -= amt; s.have -= amt;
    }
  }
  const notMovable = surpluses.filter((s) => s.id.startsWith("dest:") && s.have >= minMove).map((s) => s.id);
  return { total: fromUnits(total), shares: shares.map(({ _u, _target, ...s }) => s), proposals, unreadable: [], notMovable, unallocatedPct: policy.unallocatedPct };
}
