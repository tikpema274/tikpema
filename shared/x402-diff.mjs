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

  // ⭐⭐ THE SHAPE OF THE CHANGE, DERIVED — because the shape is what separates the readings, and
  // the count alone does not. Someone diverting payments wants FEW destinations; one address per
  // endpoint is an accounting pattern, not a wallet. This is computed so the page can state the
  // benign reading from evidence rather than from charity.
  // ⛔ `topHost` is DATA. The renderer must not put it in a heading — a finding whose most quotable
  // sentence is a company name is an accusation wearing a measurement's clothes.
  const newAddrs = [], perHost = {};
  for (const c of payToChanges) {
    for (const a of c.onlyInLater) newAddrs.push(a);
    const h = host(c.resource);
    if (h) { (perHost[h] ??= { host: h, count: 0, chains: new Set() }); perHost[h].count++; perHost[h].chains.add(c.network); }
  }
  const distinctNew = new Set(newAddrs);
  const earlierAddrs = A.allPayTo;
  const top = Object.values(perHost).sort((x, y) => y.count - x.count)[0] ?? null;
  const pattern = {
    state: "verified",
    changedOffers: payToChanges.length,
    distinctNewAddresses: distinctNew.size,
    // ⭐ One address per changed offer, with none reused, is the signature of per-endpoint derivation.
    oneAddressPerChangedOffer: distinctNew.size === payToChanges.length,
    newAddressesAlreadyPresentInEarlierReading:
      [...distinctNew].filter((a) => earlierAddrs.has(a)).length,
    topHost: top ? { host: top.host, changedOffers: top.count, chains: [...top.chains].sort() } : null,
    topHostSpansMultipleChains: top ? top.chains.size > 1 : false,
    _why: "Diversion favours few destinations; per-endpoint derivation produces one address per " +
      "endpoint and regenerates them together. These fields let a reader weigh those without " +
      "being told which to believe.",
  };

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
      pattern,
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
      // ⛔ A PROPERTY OF THE INSTRUMENT, NOT A HEDGE. No amount of care with this data reaches
      // authorisation: the repoint is a database write that the chain never witnessed.
      { field: "whoChangedTheEntry", state: "structurally-unanswerable",
        reason: "the catalog records where money is pointed, never who pointed it or why. A repoint " +
          "is a write to Circle's index; no on-chain read can testify about it, so this is a limit " +
          "of the instrument rather than a gap in the effort" },
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
 *
 * ⭐⭐ EVERY ORDERED PAIR, NOT ONLY ADJACENT ONES. With three readings the interval question has
 * to be answerable BOTH WAYS: `08-27..09-25` spans the middle reading, `09-11..09-25` follows it.
 * A key equal at 08-27 and 09-25 that differs at 09-11 is the "changed and changed back" case the
 * interval caveat warns about — and only the SPAN pair can be shown to have been misled by it.
 * Adjacent-only would have hidden exactly the comparison the third reading exists to make.
 * For two dates this is unchanged: one pair. Sorted `from..to`, so the LAST entry is always the
 * newest adjacent pair — the bare `/snapshot/diff` redirect and the page copy both rely on that.
 */
export function pairsFor(dates) {
  const s = [...dates].sort();
  const out = [];
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) out.push(pairId(s[i], s[j]));
  return out.sort();
}

/**
 * ⭐⭐⭐ THE TEST OF "UNCHANGED ≠ STABLE". Three readings, in time order a → b → c.
 *
 * Every two-reading diff on this site carries the caveat that "equal at two instants" is not
 * "stable". A third reading is the first instrument that can put a NUMBER on how often that caveat
 * mattered — and the number was defined HERE, before the third harvest existed, so the day it is
 * read nobody re-derives what to count. Per key, over the SET of values (same join as diffHarvests):
 *
 *   unchangedAcrossAllThree      a == b == c   — equal at all three instants. Still not "stable",
 *                                                 but the caveat did not bite at any reading we have.
 *   unchangedThenChanged   ⭐     a == b != c   — THE NUMBER. The pair 08-27..09-11 reported this key
 *                                                 "unchanged"; the next reading shows it moved. This
 *                                                 is how many keys a pair-only reader would have
 *                                                 called settled that were not.
 *   changedThenHeld              a != b == c   — moved once, then equal at the last two instants.
 *   changedThenReverted    ⭐     a != b, b != c, a == c
 *                                              — the SPAN pair 08-27..09-25 reads "unchanged" for
 *                                                 this key, and it is wrong: the middle reading saw
 *                                                 a different value. The caveat's own example,
 *                                                 counted.
 *   changedTwice                 a != b, b != c, a != c — a different value at every reading.
 *
 * The five states partition the comparable keys, and the result says so (`partitions`).
 *
 * ⛔ Only keys carrying a non-empty set in ALL THREE readings are comparable. A key absent from
 * any reading is a presence question, and mixing it in would inflate every row with churn.
 * ⛔ The gate is the same one: all three readings must pass auditHarvest, or nothing is computed.
 */
export function stabilityAcrossThree(a, b, c, { labelA, labelB, labelC } = {}) {
  const audits = [auditHarvest(a, labelA), auditHarvest(b, labelB), auditHarvest(c, labelC)];
  const gate = {
    passed: audits.every((x) => x.passed),
    readings: audits,
    refusal: audits.every((x) => x.passed) ? null
      : audits.filter((x) => !x.passed).map((x) => `${x.label}: ${x.reason}`).join("; "),
  };
  if (!gate.passed) return { gate, computed: false };

  const A = index(a.rows), B = index(b.rows), C = index(c.rows);
  const measure = (field) => {
    const r = {
      comparable: 0, unchangedAcrossAllThree: 0, unchangedThenChanged: 0, changedThenHeld: 0,
      changedThenReverted: 0, changedTwice: 0,
      examples: { unchangedThenChanged: [], changedThenReverted: [] },
    };
    for (const k of A[field].keys()) {
      const sa = A[field].get(k), sb = B[field].get(k), sc = C[field].get(k);
      if (!sa?.size || !sb?.size || !sc?.size) continue;
      r.comparable++;
      const ab = setEq(sa, sb), bc = setEq(sb, sc), ac = setEq(sa, sc);
      const [resource, network] = k.split("|");
      if (ab && bc) r.unchangedAcrossAllThree++;
      else if (ab) {
        r.unchangedThenChanged++;
        if (r.examples.unchangedThenChanged.length < 12) r.examples.unchangedThenChanged.push({ resource, network, first: [...sa].sort(), third: [...sc].sort() });
      } else if (bc) r.changedThenHeld++;
      else if (ac) {
        r.changedThenReverted++;
        if (r.examples.changedThenReverted.length < 12) r.examples.changedThenReverted.push({ resource, network, ends: [...sa].sort(), middle: [...sb].sort() });
      } else r.changedTwice++;
    }
    // ⭐ The five states partition the comparable keys. Stated here so a renderer can trust the sum.
    r.partitions = r.unchangedAcrossAllThree + r.unchangedThenChanged + r.changedThenHeld +
      r.changedThenReverted + r.changedTwice === r.comparable;
    return r;
  };
  const payTo = measure("payTo"), amount = measure("amount");
  return {
    gate,
    computed: true,
    readings: audits.map((x) => ({ label: x.label, capturedAt: x.capturedAt })),
    payTo,
    amount,
    // ⭐⭐ THE VERDICT ON THE CAVEAT, stated as counts and never as "stable". A zero in both misled
    // rows says the pairs did not mislead over THESE keys at THESE three instants — no more.
    pairMisled: {
      byFirstPair: payTo.unchangedThenChanged + amount.unchangedThenChanged,
      bySpanPair: payTo.changedThenReverted + amount.changedThenReverted,
      _reads: "byFirstPair: keys the a..b pair called unchanged that c shows moved. bySpanPair: keys " +
        "the a..c pair calls unchanged that b shows moved in between. Either non-zero is a pair that " +
        "misled; both zero is silence over these keys, not stability.",
    },
    _method: "per (resource, network, asset, scheme), the SET of payTo values and the SET of amounts " +
      "in each of three readings, compared only where all three carry at least one. Same set-valued " +
      "join as diffHarvests; no row is paired with a successor.",
  };
}
