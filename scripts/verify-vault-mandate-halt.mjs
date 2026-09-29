#!/usr/bin/env node
// verify-vault-mandate-halt.mjs — piece 5 step 3: the SHARE LIMIT min(tracked, live) and the HALT LATCH.
//
//   node --experimental-test-module-mocks scripts/verify-vault-mandate-halt.mjs
//
// ═══ THE REQUIREMENTS (T, 2026-09-29; design: PROGRESS "FOR THE EXECUTOR PIECE: BEYOND_MANDATE_SHARES") ═════
//   SHARE LIMIT — pure, min(tracked, live):
//     · refuses a tracked figure with gaps; NEVER reads a gap (or a missing gap count) as 0;
//     · the executor CANNOT submit more than it, so BEYOND_MANDATE_SHARES only ever detects a defect;
//     · today's live case: the wallet holds 1009998 shares the mandate did NOT deposit, tracked = 0 → the limit is 0,
//       an exit redeems nothing, and that is the CORRECT answer, not an error.
//   HALT LATCH — stored, stops ALL mandate machinery (deposits and exits, every mandate):
//     · set when the classifier reports BEYOND_MANDATE_SHARES;
//     · the tick and the exit both read it and FAIL CLOSED if it cannot be read;
//     · never auto-cleared: a human clears it by COMMITTING the incident id to MANDATE_HALT_CLEARED (a deploy).

import { mock } from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";

// _pause.mjs (via _vault-mandate-exit.mjs) imports @netlify/blobs; nothing here reads the pause store.
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: () => ({ async get() { return null; }, async setJSON() { throw new Error("not used"); } }) } });

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const show = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? `${x}n` : x));
const tryImport = async (p) => { try { return await import(p); } catch (e) { console.log(`  (import ${p} failed: ${e.message.split("\n")[0]})`); return {}; } };

const SL = await tryImport("../shared/vault-mandate/share-limit.mjs");
const H = await tryImport("../shared/vault-mandate/halt.mjs");
const EX = await tryImport("../netlify/functions/_vault-mandate-exit.mjs");
const ST = await tryImport("../netlify/functions/_vault-mandate-store.mjs");
const DEP = await tryImport("../netlify/functions/_vault-mandate-deposit.mjs");
const OUT = await import("../shared/vault-mandate/exit-outcome.mjs");

const adapter = (s) => (typeof ST.haltAdapter === "function" ? ST.haltAdapter(s) : { async read() { return null; }, async record() { throw new Error("no haltAdapter"); } });
const haltIf = async (a) => { try { return await EX.haltIfBeyondMandate(a); } catch (e) { return { threw: e.message }; } };
const limit = (a) => { try { return SL.mandateShareLimit(a); } catch (e) { return { threw: e.message }; } };
const WALLET = "0x3cb76ac688f3fc02dfe4033d388989a44f132de9";
const VAULT = { key: "xylo-usdc", address: "0x240Eb85458CD41361bd8C3773253a1D78054f747" };
const USDC = "0x3600000000000000000000000000000000000000";
const rec = (progress) => ({ owner: "0x74b7b561fd71c68eb1da6b96a7a87033904b24e5", id: "vm-1", walletAddress: WALLET, vault: VAULT, progress });

// ════════════════════════════════════════════════════════════════════════════════════════════════
section("SHARE LIMIT — today's live case: 1009998 manual shares, mandate tracks 0");
{
  const r = limit({ sharesTrackedRaw: "0", sharesTrackedGaps: 0, liveShares: 1009998n });
  ok("⭐⭐ ok (NOT an error): the mandate owns nothing, so there is nothing of ITS to redeem", r?.ok === true, show(r));
  ok("⭐⭐ …shares = \"0\"", r?.shares === "0");
  ok("…nothingToRedeem = true", r?.nothingToRedeem === true);
  ok("…the 1009998 are stated as NOT the mandate's (never a reason to redeem them)", r?.notTheMandates === "1009998", show(r?.notTheMandates));
  const fromRecord = (() => { try { return SL.shareLimitForRecord(rec({ sharesTrackedRaw: "0", sharesTrackedGaps: 0 }), 1009998n); } catch (e) { return { threw: e.message }; } })();
  ok("the record-reading form gives the same answer (progress.sharesTrackedRaw / sharesTrackedGaps)", fromRecord?.ok === true && fromRecord?.shares === "0", show(fromRecord));
}

section("SHARE LIMIT — min(tracked, live)");
{
  const a = limit({ sharesTrackedRaw: "500", sharesTrackedGaps: 0, liveShares: 1009998n });
  ok("tracked < live → tracked (the manual shares stay)", a?.ok && a.shares === "500" && a.notTheMandates === "1009498", show(a));
  const b = limit({ sharesTrackedRaw: "800", sharesTrackedGaps: 0, liveShares: 300n });
  ok("tracked > live → live (the rest is already gone, e.g. a manual reclaim)", b?.ok && b.shares === "300" && b.trackedNotRedeemable === "500", show(b));
  const c = limit({ sharesTrackedRaw: "700", sharesTrackedGaps: 0, liveShares: 700n });
  ok("equal → that figure", c?.ok && c.shares === "700" && c.nothingToRedeem === false, show(c));
  const d = limit({ sharesTrackedRaw: "700", sharesTrackedGaps: 0, liveShares: 0n });
  ok("live 0 → 0, nothing to redeem", d?.ok && d.shares === "0" && d.nothingToRedeem === true, show(d));
  const e = limit({ sharesTrackedRaw: "700", sharesTrackedGaps: 0, liveShares: "650" });
  ok("a decimal-string live figure is read", e?.ok && e.shares === "650", show(e));
  let worst = null;
  for (const t of [0n, 1n, 2n, 999n, 1000n, 1009998n, 10n ** 30n]) for (const l of [0n, 1n, 998n, 1000n, 1009998n, 10n ** 30n]) {
    const r = limit({ sharesTrackedRaw: t.toString(), sharesTrackedGaps: 0, liveShares: l });
    const want = t < l ? t : l;
    if (!(r?.ok && BigInt(r.shares) === want && BigInt(r.shares) <= t && BigInt(r.shares) <= l)) { worst = { t, l, r }; break; }
  }
  ok("⭐ over a 7×6 grid the limit is exactly min(tracked, live), never above either", worst === null, show(worst));
}

section("SHARE LIMIT — GAPS REFUSE; a gap is NEVER read as 0");
{
  const g = limit({ sharesTrackedRaw: "500", sharesTrackedGaps: 1, liveShares: 1009998n });
  ok("⭐ gaps > 0 → refused (tracked is only a lower bound; the mandate's true holding is unknown)", g?.ok === false && g?.code === SL.SHARE_LIMIT_REFUSED?.TRACKED_HAS_GAPS, show(g));
  ok("…a refusal carries NO shares figure to misuse", g && !("shares" in g));
  for (const bad of [undefined, null, "0", "1", 0.5, -1, NaN, Infinity, true, {}]) {
    const r = limit({ sharesTrackedRaw: "500", sharesTrackedGaps: bad, liveShares: 1009998n });
    ok(`⭐ gaps = ${show(bad) ?? "undefined"} → refused as UNKNOWN, never read as 0`, r?.ok === false && r?.code === SL.SHARE_LIMIT_REFUSED?.GAPS_UNKNOWN && !("shares" in r), show(r));
  }
  const noKey = limit({ sharesTrackedRaw: "500", liveShares: 1009998n });
  ok("⭐ the gaps FIELD absent → refused (an absence is not a clean count)", noKey?.ok === false && noKey?.code === SL.SHARE_LIMIT_REFUSED?.GAPS_UNKNOWN, show(noKey));
}

section("SHARE LIMIT — an unknown tracked or live figure refuses");
{
  for (const bad of [undefined, null, "", "-1", "1.5", "abc", " 5", 5, 5n, "0x10"]) {
    const r = limit({ sharesTrackedRaw: bad, sharesTrackedGaps: 0, liveShares: 1009998n });
    ok(`tracked = ${show(bad) ?? "undefined"} → refused TRACKED_UNKNOWN`, r?.ok === false && r?.code === SL.SHARE_LIMIT_REFUSED?.TRACKED_UNKNOWN, show(r));
  }
  for (const bad of [undefined, null, -1n, "", "1.5", "-3", 5, NaN]) {
    const r = limit({ sharesTrackedRaw: "500", sharesTrackedGaps: 0, liveShares: bad });
    ok(`⭐ live = ${show(bad) ?? "undefined"} (an unreadable balance) → refused LIVE_UNKNOWN, never read as 0`, r?.ok === false && r?.code === SL.SHARE_LIMIT_REFUSED?.LIVE_UNKNOWN, show(r));
  }
  const noProg = (() => { try { return SL.shareLimitForRecord({ ...rec(undefined) }, 5n); } catch (e) { return { threw: e.message }; } })();
  ok("a record with no progress → refused (TRACKED_UNKNOWN), not a limit of 0", noProg?.ok === false && noProg?.code === SL.SHARE_LIMIT_REFUSED?.TRACKED_UNKNOWN, show(noProg));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
section("THE EXECUTOR CANNOT SUBMIT MORE THAN THE LIMIT (submitMandateExitRedeem)");
const notHalted = { async read() { return { readable: true, halted: false, open: [] }; } };
const capture = () => { const calls = []; return { calls, submit: async (a) => { calls.push(a); return { circleId: "c-1", redeemHash: "0xab" }; } }; };
const exitSubmit = async (args) => { try { return await EX.submitMandateExitRedeem(args); } catch (e) { return { threw: e.message }; } };
{
  const cap = capture();
  const r = await exitSubmit({ record: rec({ sharesTrackedRaw: "0", sharesTrackedGaps: 0 }), liveShares: 1009998n, halt: notHalted, submit: cap.submit });
  ok("⭐⭐ today's live case → NOTHING submitted (0 calls), reported as nothing-to-redeem", cap.calls.length === 0 && r?.submitted === false && r?.code === "nothing-to-redeem", show(r));

  let bad = null;
  for (const t of [1n, 500n, 1009998n, 10n ** 24n]) for (const l of [0n, 1n, 499n, 1009998n, 10n ** 25n]) {
    const c = capture();
    const out = await exitSubmit({ record: rec({ sharesTrackedRaw: t.toString(), sharesTrackedGaps: 0 }), liveShares: l, halt: notHalted, submit: c.submit });
    const want = t < l ? t : l;
    const sent = c.calls[0]?.shares;
    const good = want === 0n ? c.calls.length === 0 : (c.calls.length === 1 && BigInt(sent) === want && BigInt(sent) <= t && BigInt(sent) <= l && out?.sharesSubmitted === want.toString());
    if (!good) { bad = { t, l, calls: c.calls, out }; break; }
  }
  ok("⭐⭐ over a 4×5 grid: exactly ONE submit, of exactly min(tracked, live), never above either (0 → no submit)", bad === null, show(bad));

  const c2 = capture();
  await exitSubmit({ record: rec({ sharesTrackedRaw: "500", sharesTrackedGaps: 0 }), liveShares: 1009998n, halt: notHalted, submit: c2.submit });
  ok("the wallet and vault submitted are the RECORD's own", c2.calls[0]?.walletAddress === WALLET && c2.calls[0]?.vault?.address === VAULT.address, show(c2.calls[0]));

  const c3 = capture();
  const forced = await exitSubmit({ record: rec({ sharesTrackedRaw: "500", sharesTrackedGaps: 0 }), liveShares: 1009998n, shares: "1009998", halt: notHalted, submit: c3.submit });
  ok("⭐ a caller-supplied `shares` is REFUSED outright (there is no way to hand the exit a number)", c3.calls.length === 0 && /no share amount/i.test(forced?.threw ?? ""), show(forced));

  const c4 = capture();
  const inflated = await exitSubmit({ record: rec({ sharesTrackedRaw: "500", sharesTrackedGaps: 0 }), liveShares: 10n ** 30n, halt: notHalted, submit: c4.submit });
  ok("⭐ an inflated LIVE figure cannot raise it past TRACKED (the mandate's authority)", c4.calls[0]?.shares === "500", show(c4.calls[0]?.shares ?? inflated));

  const c5 = capture();
  const gapped = await exitSubmit({ record: rec({ sharesTrackedRaw: "500", sharesTrackedGaps: 2 }), liveShares: 1009998n, halt: notHalted, submit: c5.submit });
  ok("gaps → no submit, refused with the limit's code", c5.calls.length === 0 && gapped?.submitted === false && gapped?.code === SL.SHARE_LIMIT_REFUSED?.TRACKED_HAS_GAPS, show(gapped));
}

section("…so BEYOND_MANDATE_SHARES is a DEFECT DETECTOR, never an ordinary outcome");
{
  // Whatever the executor submitted is the intent's sharesToRedeem. A vault that burns EXACTLY that never flags; only a
  // chain that burned MORE than was submitted (a defect: the executor, or the vault) does.
  const facts = (burned, before) => ({
    circle: { state: "COMPLETE", txHash: "0x" + "ab".repeat(32) },
    receipt: { found: true, status: "success", blockNumber: 100, logs: [
      { address: VAULT.address, ...encWithdraw(burned, 1000n) },
      { address: USDC, ...encTransfer(VAULT.address, WALLET, 1000n) },
    ] },
    shares: { atParent: before, atTxBlock: before - burned },
  });
  const c = capture();
  const r = await exitSubmit({ record: rec({ sharesTrackedRaw: "500", sharesTrackedGaps: 0 }), liveShares: 1009998n, halt: notHalted, submit: c.submit });
  const submitted = BigInt(c.calls[0]?.shares ?? "0");
  const normal = OUT.classifyExitOutcome({ config: { vault: VAULT.address, usdc: USDC, wallet: WALLET },
    intent: { sharesToRedeem: submitted.toString(), sharesTracked: "500", sharesTrackedGaps: 0 }, facts: facts(submitted, 1009998n) });
  ok("⭐ the chain burns what was submitted → exited, NO BEYOND flag (1009498 manual shares left, reported apart)", normal.outcome === "exited" && !normal.flags.includes("BEYOND_MANDATE_SHARES") && normal.otherSharesInWallet === "1009498", show({ submitted, normal }));
  const defect = OUT.classifyExitOutcome({ config: { vault: VAULT.address, usdc: USDC, wallet: WALLET },
    intent: { sharesToRedeem: submitted.toString(), sharesTracked: "500", sharesTrackedGaps: 0 }, facts: facts(submitted + 1n, 1009998n) });
  ok("…one share MORE burned than submitted → BEYOND_MANDATE_SHARES (the detector still fires)", defect.flags.includes("BEYOND_MANDATE_SHARES") && defect.beyondMandateShares === "1", show(defect.flags));
  void r;
}

section("THE EXIT READS THE LATCH, AND FAILS CLOSED");
{
  const record = rec({ sharesTrackedRaw: "500", sharesTrackedGaps: 0 });
  const cases = [
    ["halted", { async read() { return { readable: true, halted: true, open: ["i-1"] }; } }, "halted"],
    ["unreadable", { async read() { return { readable: false, why: "blobs down" }; } }, "halt-unreadable"],
    ["read throws", { async read() { throw new Error("boom"); } }, "halt-unreadable"],
    ["a malformed answer", { async read() { return { readable: true }; } }, "halt-unreadable"],
    ["no latch reader at all", undefined, "halt-unreadable"],
  ];
  for (const [label, halt, code] of cases) {
    const c = capture();
    const r = await exitSubmit({ record, liveShares: 1009998n, halt, submit: c.submit });
    ok(`⭐ latch ${label} → NOTHING submitted, code ${code}`, c.calls.length === 0 && r?.submitted === false && r?.code === code, show(r));
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
section("HALT STATE — pure");
{
  const s = (keys, cleared) => { try { return H.haltStateFrom({ keys, cleared }); } catch (e) { return { threw: e.message }; } };
  ok("no incident keys → not halted", s([], [])?.halted === false);
  const one = s(["halt/2026-09-29T15-00-00-000Z-abababababab"], []);
  ok("one incident → HALTED, naming it", one?.halted === true && one?.open?.length === 1, show(one));
  ok("⭐ that incident listed in the COMMITTED cleared list → not halted", s(["halt/2026-09-29T15-00-00-000Z-abababababab"], ["2026-09-29T15-00-00-000Z-abababababab"])?.halted === false);
  const two = s(["halt/a-1", "halt/b-2"], ["a-1"]);
  ok("two incidents, one cleared → STILL halted by the other", two?.halted === true && show(two.open) === show(["b-2"]), show(two));
  const weird = s(["halt/", "halt/x/y"], []);
  ok("⭐ an unparseable key under the prefix → HALTED (unknown is not clear)", weird?.halted === true, show(weird));
  ok("MANDATE_HALT_CLEARED ships EMPTY and FROZEN", Array.isArray(H.MANDATE_HALT_CLEARED) && H.MANDATE_HALT_CLEARED.length === 0 && Object.isFrozen(H.MANDATE_HALT_CLEARED));
}

section("SETTING THE LATCH — on BEYOND_MANDATE_SHARES only");
const memStore = () => {
  const m = new Map(); const ops = [];
  return { m, ops,
    async setJSON(k, v, o = {}) { ops.push(["set", k]); if (o.onlyIfNew && m.has(k)) return { modified: false }; m.set(k, JSON.parse(JSON.stringify(v))); return { modified: true, etag: "e" }; },
    async list({ prefix }) { ops.push(["list", prefix]); return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
    async delete(k) { ops.push(["delete", k]); m.delete(k); },
  };
};
const beyondOutcome = { outcome: "exited", txHash: "0x" + "cd".repeat(32), blockNumber: 777, flags: ["BEYOND_MANDATE_SHARES"], beyondMandateShares: "1009998", usdcReceivedMinor: "1009000", mandateSharesRedeemed: "500" };
const ctx = { owner: "0x74b7b561fd71c68eb1da6b96a7a87033904b24e5", id: "vm-1", walletAddress: WALLET, vault: VAULT.address, sharesToRedeem: "500", sharesTracked: "500", sharesTrackedGaps: 0 };
{
  const st = memStore(); const halt = adapter(st);
  const hit = await haltIf({ halt, classified: beyondOutcome, context: ctx, now: Date.parse("2026-09-29T15:00:00Z") });
  ok("⭐ BEYOND_MANDATE_SHARES → the latch is RECORDED", hit?.halted === true && hit?.recorded === true, show(hit));
  const stored = [...st.m.entries()].find(([k]) => k.startsWith("halt/"))?.[1];
  ok("…the incident holds both share counts, the tx, the block, and the tracked figure the executor used",
    stored?.code === "BEYOND_MANDATE_SHARES" && stored?.beyondMandateShares === "1009998" && stored?.sharesToRedeem === "500" && stored?.sharesTracked === "500" && stored?.txHash === beyondOutcome.txHash && stored?.blockNumber === 777 && stored?.owner === ctx.owner && stored?.id === "vm-1", show(stored));
  ok("…and the user's sentence, plainly: shares that were NOT the mandate's, stopped, never a success", /were not the mandate's/i.test(stored?.userMessage ?? "") && /stopped all autonomous/i.test(stored?.userMessage ?? "") && !/success/i.test(stored?.userMessage ?? ""), stored?.userMessage);
  const after = await halt.read().catch((e) => ({ threw: e.message }));
  ok("⭐ reading back → HALTED", after?.readable === true && after?.halted === true, show(after));

  const clean = memStore(); const h2 = adapter(clean);
  const miss = await haltIf({ halt: h2, classified: { ...beyondOutcome, flags: [] }, context: ctx, now: 1 });
  ok("no BEYOND flag → nothing written, not halted", miss?.halted === false && clean.m.size === 0, show(miss));
  const lower = await haltIf({ halt: h2, classified: { ...beyondOutcome, flags: ["TRACKED_LOWER_BOUND"] }, context: ctx, now: 1 });
  ok("TRACKED_LOWER_BOUND alone does not halt (it is not the incident)", lower?.halted === false && clean.m.size === 0, show(lower));

  // a second incident while halted: its own record; the first untouched
  const second = await haltIf({ halt, classified: { ...beyondOutcome, txHash: "0x" + "ef".repeat(32) }, context: ctx, now: Date.parse("2026-09-29T16:00:00Z") });
  const halts = [...st.m.keys()].filter((k) => k.startsWith("halt/"));
  ok("a second incident → a SECOND record; the first is never overwritten", second?.recorded === true && halts.length === 2, show(halts));

  // ⛔ THE SAME INCIDENT ID TWICE: create-only must hold, or a later write could rewrite the evidence (T, 2026-09-29).
  const dupStore = memStore(); const dup = adapter(dupStore);
  const t = Date.parse("2026-09-29T17:00:00Z");
  const firstRec = await haltIf({ halt: dup, classified: beyondOutcome, context: ctx, now: t });
  const firstKey = [...dupStore.m.keys()].find((k) => k.startsWith("halt/"));
  const firstBody = JSON.stringify(dupStore.m.get(firstKey));
  const direct = await dup.record({ ...firstRec.incident, beyondMandateShares: "1", userMessage: "rewritten" }).catch((e) => ({ threw: e.message }));
  ok("⭐ record() of the SAME incident id again → refused (exists), not written", direct?.ok === false && direct?.exists === true, show(direct));
  ok("⭐ …the stored incident is byte-for-byte the FIRST one", JSON.stringify(dupStore.m.get(firstKey)) === firstBody, dupStore.m.get(firstKey)?.userMessage);
  const again = await haltIf({ halt: dup, classified: { ...beyondOutcome, beyondMandateShares: "2" }, context: ctx, now: t });
  ok("the same exit reported again (same time, same tx → same id) → still halted, ONE record, the first unchanged",
    again?.halted === true && [...dupStore.m.keys()].filter((k) => k.startsWith("halt/")).length === 1 && JSON.stringify(dupStore.m.get(firstKey)) === firstBody, show(again?.incident?.incidentId));

  const broken = { async record() { throw new Error("blobs down"); }, async read() { return { readable: false }; } };
  const failedWrite = await haltIf({ halt: broken, classified: beyondOutcome, context: ctx, now: 1 });
  ok("⭐ the latch write FAILS → still reported halted:true, recorded:false (the caller must stop anyway)", failedWrite?.halted === true && failedWrite?.recorded === false, show(failedWrite));
}

section("HALT STORE — fail closed on read");
{
  const down = { async list() { throw new Error("blobs down"); } };
  const r = await adapter(down).read();
  ok("⭐ the list throws → readable:false (never 'not halted')", r?.readable === false, show(r));
  const st = memStore(); st.m.set("m/0xabc/vm-1", {}); st.m.set("d/0xabc/vm-1/1", {});
  const r2 = await adapter(st).read();
  ok("mandate and intent keys are not incidents (only halt/ is listed)", r2?.readable === true && r2?.halted === false, show(r2));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
section("THE TICK READS THE LATCH FIRST, AND FAILS CLOSED");
const counting = () => { const calls = []; return { calls, mandates: { async list() { calls.push("list"); return [{ owner: "0xabc", id: "vm-1" }]; }, async read() { calls.push("read"); return { readable: true, record: null }; } } }; };
const tick = async (halt, haltPresent = true) => {
  const c = counting();
  const deps = { now: () => Date.parse("2026-09-29T15:00:00Z"), mandates: c.mandates, runCheck: async () => { c.calls.push("check"); return {}; } };
  if (haltPresent) deps.halt = halt;
  let out; try { out = await DEP.runMandateTick({ deps }); } catch (e) { out = { threw: e.message }; }
  return { out, calls: c.calls };
};
{
  const t0 = await tick(notHalted);
  ok("not halted → the tick proceeds (it lists the mandates)", t0.calls.includes("list"), show(t0));
  for (const [label, halt, present] of [
    ["HALTED", { async read() { return { readable: true, halted: true, open: ["i-1"] }; } }, true],
    ["unreadable", { async read() { return { readable: false, why: "blobs down" }; } }, true],
    ["read throws", { async read() { throw new Error("boom"); } }, true],
    ["a malformed answer", { async read() { return {}; } }, true],
    ["no latch reader in deps", undefined, false],
  ]) {
    const t = await tick(halt, present);
    ok(`⭐ latch ${label} → the tick touches NO mandate (0 calls) and says halted`, t.calls.length === 0 && t.out?.halted === true && t.out?.ok === false && Array.isArray(t.out?.results) && t.out.results.length === 0, show(t));
  }
  const many = [];
  const halted = { async read() { return { readable: true, halted: true, open: ["i-1"] }; } };
  for (let i = 0; i < 5; i++) many.push(await tick(halted));
  ok("⭐ never auto-cleared: five ticks in a row, all halted, none touching a mandate", many.every((t) => t.out?.halted === true && t.calls.length === 0));
}

section("SOURCE GUARDS");
{
  const files = [...readdirSync("netlify/functions").filter((f) => f.includes("vault-mandate")).map((f) => `netlify/functions/${f}`),
    ...readdirSync("shared/vault-mandate").map((f) => `shared/vault-mandate/${f}`)].filter((f) => f.endsWith(".mjs"));
  const calls = files.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\bsubmitRedeem\s*\(/g)].map(() => f));
  ok("⭐ in all mandate code, the ONLY submitRedeem call is in _vault-mandate-exit.mjs (inside submitMandateExitRedeem)", calls.length === 1 && calls[0] === "netlify/functions/_vault-mandate-exit.mjs", show(calls));
  const exitSrc = existsSync("netlify/functions/_vault-mandate-exit.mjs") ? readFileSync("netlify/functions/_vault-mandate-exit.mjs", "utf8") : "";
  const body = exitSrc.slice(exitSrc.indexOf("export async function submitMandateExitRedeem"));
  const fnBody = body.slice(0, body.indexOf("\n}\n") + 2);
  ok("…and inside it, the shares passed are the limit's own (`shares: lim.shares`)", /submitRedeem[\s\S]*?shares:\s*lim\.shares/.test(fnBody) || /shares:\s*lim\.shares/.test(fnBody), fnBody.length ? "" : "function not found");
  const code = exitSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  ok("the exit module never calls executeAction (finding C; comments stripped)", !/\bexecuteAction\s*\(/.test(code));
  const deleters = files.filter((f) => /halt/.test(readFileSync(f, "utf8")) && /\.delete\s*\(/.test(readFileSync(f, "utf8")));
  ok("⭐ no mandate file deletes anything while knowing about the halt (clearing is a COMMIT, never code)", deleters.length === 0, show(deleters));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-vault-mandate-halt — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// ── log encoders (after the exit: hoisted function declarations) ──
function encWithdraw(shares, assets) {
  const t = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return { topics: ["0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db", t(WALLET), t(WALLET), t(WALLET)],
    data: "0x" + assets.toString(16).padStart(64, "0") + shares.toString(16).padStart(64, "0") };
}
function encTransfer(from, to, value) {
  const t = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return { topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", t(from), t(to)], data: "0x" + value.toString(16).padStart(64, "0") };
}
