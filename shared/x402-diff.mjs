// x402-diff.mjs — compare two dated Circle x402 catalog harvests. PURE. No I/O, no network.
//
// ═══ 🚨 THE DENOMINATOR GATE IS LOAD-BEARING TWICE, AND IT REFUSES ════════════════════════════
// A diff between an unfiltered harvest and a `siwx=false` one shows ~165 phantom disappearances,
// EVERY ONE A TESTNET ROW, and it looks exactly like a real finding: a plausible count, a coherent
// network breakdown, no error anywhere. The filter is the hypothesis, not the data.
// ⛔ SO `diffHarvests` REFUSES. It does not warn, it does not degrade, it does not return partial
// counts with a flag set. A warning on a wrong number is still a wrong number published, and the
// warning is the part a reader skips. When the gate fails the result carries NO comparison at all.
//
// ⚠️ AND THE GATE RE-DERIVES FROM THE ROWS. Both harvests store a self-check, under DIFFERENT KEYS
// (`testnetSelfCheck` on 2026-08-27, `selfCheck` on 2026-09-11) and different shapes. Trusting
// either stored flag would be trusting a claim; counting the sentinel rows is reading the evidence.
// A stored flag that disagrees with the rows is itself reported, and does not override them.
//
// ═══ ⛔ "REMOVED" IS AN INFERENCE. THIS MODULE NEVER MAKES IT. ═════════════════════════════════
// Neither harvest can bound what it missed: 2026-08-27 never looked for a `total`, and while
// 2026-09-11 did find one, a paging hiccup, a rename or a delisting are indistinguishable from the
// outside. So every field is named for the OBSERVATION — `absentFromB`, `presentOnlyInB` — and the
// renderer is expected to say "absent from the <date> reading", never "removed" or "added".
// ⭐ The vocabulary is enforced, not merely intended: `FORBIDDEN_VERBS` below is asserted against
// the rendered page by the suite.
//
// ═══ ⛔ THE JOIN CANNOT USE A ROW IDENTITY, BECAUSE THERE ISN'T ONE ════════════════════════════
// `(resource, network, asset, scheme)` is NOT unique: 1,441 collisions in the 2026-09-11 harvest
// across 909 groups, of which 834 carry genuinely DIFFERENT values under one key — the same URL
// offered at both 0 and 20000. A last-write-wins Map silently drops a third of the rows and reports
// confident numbers over the survivors.
// ⭐ SO THE COMPARISON IS SET-VALUED, not row-paired. Per key we compare the SET of payTo values and
// the SET of amounts. That invents no identity, loses no row, and answers the question that matters
// ("does this offer now pay somewhere else?") without pretending to know which row became which.

export const SENTINELS = Object.freeze({ "eip155:84532": "Base Sepolia", "eip155:80002": "Polygon Amoy" });

// ⛔ Words the rendered page must never contain. Each asserts an event nobody observed.
export const FORBIDDEN_VERBS = Object.freeze(["removed", "deleted", "added", "delisted", "disappeared"]);

const key = (r) => `${r.resource}|${r.network}|${r.asset}|${r.scheme}`;
const host = (u) => { try { return new URL(u).host; } catch { return null; } };
const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const only = (a, b) => [...a].filter((x) => !b.has(x));

/**
 * ⭐ THE GATE. Counts sentinel rows FROM THE ROWS, and reports what the file claims separately.
 * A harvest missing either testnet network is the `siwx=false` signature.
 */
export function auditHarvest(h, label) {
  const rows = Array.isArray(h?.rows) ? h.rows : [];
  const observed = {};
  for (const caip of Object.keys(SENTINELS)) observed[caip] = 0;
  for (const r of rows) if (r.network in observed) observed[r.network]++;

  // Both harvest generations stored this under a different key and shape. Read either, trust neither.
  const claimedRaw = h?.selfCheck?.observed ?? h?.testnetSelfCheck ?? null;
  const claimed = claimedRaw ? Object.fromEntries(Object.keys(SENTINELS).map((c) => [c, claimedRaw[c] ?? null])) : null;

  const missing = Object.keys(SENTINELS).filter((c) => !(observed[c] > 0));
  const disagrees = claimed
    ? Object.keys(SENTINELS).filter((c) => claimed[c] !== null && claimed[c] !== observed[c])
    : [];

  return {
    label,
    rows: rows.length,
    listings: h?.listingsCollected ?? null,
    capturedAt: h?.capturedAt ?? label,
    sentinels: SENTINELS,
    observed,
    claimed,
    // ⚠️ A disagreement does NOT flip `passed` — the rows are the evidence and they are sufficient.
    // It is surfaced because a file whose own record is wrong is worth knowing about either way.
    claimDisagrees: disagrees,
    passed: rows.length > 0 && missing.length === 0,
    reason: rows.length === 0
      ? "the harvest carries no rows at all — nothing can be compared"
      : missing.length
        ? `${missing.map((c) => SENTINELS[c]).join(" and ")} absent — this is the siwx=false signature, and a filtered reading has a different denominator`
        : null,
  };
}

/** Per-key sets of payTo and amount, plus the per-network and per-host tallies. */
function index(rows) {
  const payTo = new Map(), amount = new Map(), networks = {}, hosts = {}, resources = new Set(), allPayTo = new Set();
  for (const r of rows) {
    const k = key(r);
    if (!payTo.has(k)) { payTo.set(k, new Set()); amount.set(k, new Set()); }
    if (r.payTo) { payTo.get(k).add(r.payTo); allPayTo.add(r.payTo); }
    if (r.amount !== null && r.amount !== undefined) amount.get(k).add(String(r.amount));
    networks[r.network] = (networks[r.network] || 0) + 1;
    if (r.resource) { resources.add(r.resource); const hh = host(r.resource); if (hh) hosts[hh] = (hosts[hh] || 0) + 1; }
  }
  return { payTo, amount, networks, hosts, resources, allPayTo };
}

/**
 * ⭐ THE DIFF. `a` is the earlier reading, `b` the later. Both must pass the gate or NOTHING is
 * computed — the returned object carries `gate` and no comparison fields.
 */
export function diffHarvests(a, b, { labelA, labelB } = {}) {
  const auditA = auditHarvest(a, labelA), auditB = auditHarvest(b, labelB);
  const gate = {
    passed: auditA.passed && auditB.passed,
    a: auditA,
    b: auditB,
    // ⛔ The refusal names WHICH reading failed and why, because "the diff is unavailable" sends a
    // reader to re-run the wrong one.
    refusal: auditA.passed && auditB.passed ? null
      : [auditA, auditB].filter((x) => !x.passed).map((x) => `${x.label}: ${x.reason}`).join("; "),
  };
  if (!gate.passed) return { gate, computed: false };

  const A = index(a.rows), B = index(b.rows);
  const allKeys = new Set([...A.payTo.keys(), ...B.payTo.keys()]);

  // ⭐⭐ THE HEADLINE: a seller silently repointing where money goes.
  // Only keys present in BOTH readings qualify — a key absent from one side is a presence question,
  // not a payout question, and conflating them would inflate this row with ordinary churn.
  const payToChanges = [];
  let priceChanges = 0;
  const priceExamples = [];
  let comparableKeys = 0;
  for (const k of allKeys) {
    const pa = A.payTo.get(k), pb = B.payTo.get(k);
    if (!pa || !pb || pa.size === 0 || pb.size === 0) continue;
    comparableKeys++;
    const [resource, network, asset, scheme] = k.split("|");
    if (!setEq(pa, pb)) {
      payToChanges.push({
        resource, network, asset, scheme,
        state: "verified-changed",
        onlyInEarlier: only(pa, pb), onlyInLater: only(pb, pa),
        inBoth: [...pa].filter((x) => pb.has(x)),
      });
    }
    const aa = A.amount.get(k), ab = B.amount.get(k);
    if (aa && ab && aa.size && ab.size && !setEq(aa, ab)) {
      priceChanges++;
      if (priceExamples.length < 12) priceExamples.push({
        resource, network, earlier: [...aa].sort(), later: [...ab].sort(),
      });
    }
  }
  payToChanges.sort((x, y) => x.resource.localeCompare(y.resource) || x.network.localeCompare(y.network));

  const hostsA = new Set(Object.keys(A.hosts)), hostsB = new Set(Object.keys(B.hosts));
  const netKeys = [...new Set([...Object.keys(A.networks), ...Object.keys(B.networks)])];

  return {
    gate,
    computed: true,
    // ⛔ EVERY NAME IS AN OBSERVATION. Nothing here is called removed, added or delisted.
    presence: {
      resources: {
        inEarlier: A.resources.size, inLater: B.resources.size,
        absentFromLater: only(A.resources, B.resources).length,
        presentOnlyInLater: only(B.resources, A.resources).length,
        inBoth: [...A.resources].filter((x) => B.resources.has(x)).length,
      },
      hosts: {
        inEarlier: hostsA.size, inLater: hostsB.size,
        absentFromLater: only(hostsA, hostsB), presentOnlyInLater: only(hostsB, hostsA),
      },
      payToAddresses: {
        inEarlier: A.allPayTo.size, inLater: B.allPayTo.size,
        absentFromLater: only(A.allPayTo, B.allPayTo).length,
        presentOnlyInLater: only(B.allPayTo, A.allPayTo).length,
        inBoth: [...A.allPayTo].filter((x) => B.allPayTo.has(x)).length,
      },
    },
    // ⭐ THE LEAD ROW. Zero is a measurement, so this is always present, never omitted when empty.
    payTo: {
      state: "verified",
      comparableOffers: comparableKeys,
      changedCount: payToChanges.length,
      changes: payToChanges,
      _method: "per (resource, network, asset, scheme), the SET of payTo values in each reading, " +
        "compared only where both readings carry at least one. Set-valued because the key is not " +
        "unique — 834 keys carry conflicting rows — so no row is paired with a specific successor.",
    },
    price: {
      state: "verified",
      changedCount: priceChanges,
      examples: priceExamples,
      _method: "same keys, the SET of advertised amounts. A key whose amount set differs is counted once.",
    },
    networks: netKeys.map((caip) => ({
      caip, earlier: A.networks[caip] ?? 0, later: B.networks[caip] ?? 0,
      delta: (B.networks[caip] ?? 0) - (A.networks[caip] ?? 0),
    })).sort((x, y) => y.later - x.later || y.earlier - x.earlier),
    totals: {
      rowsEarlier: a.rows.length, rowsLater: b.rows.length,
      listingsEarlier: a.listingsCollected ?? null, listingsLater: b.listingsCollected ?? null,
    },
    // ⛔ THE INTERVAL WARNING IS DATA, not page furniture — it belongs in the JSON an agent reads too.
    interval: intervalCaveat(auditA.capturedAt, auditB.capturedAt),
    notMeasured: [
      { field: "whatHappenedBetween", state: "not-measured",
        reason: "two readings bound their endpoints and say nothing about the interval; a value equal " +
          "on both dates may have changed and changed back" },
      { field: "causeOfAbsence", state: "cannot-distinguish",
        reason: "a listing absent from the later reading may be withdrawn, renamed, or missed by paging — " +
          "neither harvest can bound what it did not see" },
      { field: "payoutOwnership", state: "not-measured",
        reason: "a changed payTo is a changed catalog entry; whether the same party controls both " +
          "addresses was not checked on any chain" },
      { field: "liveness", state: "not-measured",
        reason: "no third-party endpoint was called in either reading, so neither says whether any of " +
          "these services answered" },
    ],
  };
}

/** ⛔ Two readings bound their endpoints only. Fifteen days of interval are unobserved. */
export function intervalCaveat(fromISO, toISO) {
  const d = Math.round((Date.parse(`${String(toISO).slice(0, 10)}T00:00:00Z`) -
                        Date.parse(`${String(fromISO).slice(0, 10)}T00:00:00Z`)) / 864e5);
  return {
    days: Number.isFinite(d) ? d : null,
    state: "unobserved",
    text: `These are two instants ${Number.isFinite(d) ? d : "?"} days apart, not a period of ` +
      `observation. Nothing here reports what happened in between: a value identical on both dates ` +
      `may have changed and changed back, a listing present on both may have been absent for a ` +
      `fortnight, and a single reading on either end could itself be atypical. "Unchanged" here ` +
      `means "equal at two instants", which is not the same as stable.`,
  };
}

export const pairId = (from, to) => `${from}..${to}`;

/**
 * ⭐ ONE DERIVATION OF "WHICH PAIRS EXIST", called by both the snapshot page and the diff page.
 * ⛔ They hold SEPARATE date lists — snapshot.mjs keys its frozen SNAPSHOTS, snapshot-diff.mjs keys
 * the harvest files — and those two lists can drift apart. Sharing the derivation does not prevent
 * that; only an assertion does, and verify-snapshot-diff.mjs §0 compares the two lists directly.
 */
export function pairsFor(dates) {
  const s = [...dates].sort();
  return s.slice(0, -1).map((d, i) => pairId(d, s[i + 1]));
}
