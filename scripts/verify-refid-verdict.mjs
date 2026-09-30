#!/usr/bin/env node
// verify-refid-verdict.mjs — the refId round-trip spike's VERDICT (scripts/spikes/refid-verdict.mjs), pure.
//
// ⛔ THE RULE (T, 2026-09-30): a FAILED READ IS NEVER A FINDING. The first --refid run reported DOES-NOT-ROUND-TRIP
// when both listings had ERRORED (Circle 400, code 2, from our own malformed call) — an unreadable read counted as "the
// refId did not come back". Only a READABLE listing that lacks the refId can say it does not round-trip.
let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); } };
let V = {};
try { V = await import("./spikes/refid-verdict.mjs"); } catch (e) { console.log(`  (import failed: ${e.message.split("\n")[0]})`); }
const v = (a) => { try { return V.refidVerdict(a); } catch (e) { return `threw: ${e.message}`; } };
const found = { readable: true, found: true }, missing = { readable: true, found: false }, broken = { readable: false, why: "400 code 2" };

ok("the send refused → SEND-REFUSED", v({ sentOk: false, reads: [] }) === "SEND-REFUSED", v({ sentOk: false, reads: [] }));
ok("every read readable and found → ROUND-TRIPS", v({ sentOk: true, reads: [found, found] }) === "ROUND-TRIPS");
ok("found on a later read only → ROUND-TRIPS-LATE", v({ sentOk: true, reads: [missing, found] }) === "ROUND-TRIPS-LATE");
ok("⭐ found once, the other read UNREADABLE → ROUND-TRIPS-LATE (a positive is a positive)", v({ sentOk: true, reads: [broken, found] }) === "ROUND-TRIPS-LATE");
ok("every read readable, never found → DOES-NOT-ROUND-TRIP (the only way to say it)", v({ sentOk: true, reads: [missing, missing] }) === "DOES-NOT-ROUND-TRIP");
ok("⭐⭐ THE FIRST RUN: every read UNREADABLE → INCONCLUSIVE, never DOES-NOT-ROUND-TRIP", v({ sentOk: true, reads: [broken, broken] }) === "INCONCLUSIVE", v({ sentOk: true, reads: [broken, broken] }));
ok("⭐ one readable-missing + one unreadable → INCONCLUSIVE (the unreadable one might have shown it)", v({ sentOk: true, reads: [missing, broken] }) === "INCONCLUSIVE", v({ sentOk: true, reads: [missing, broken] }));
ok("no reads at all → INCONCLUSIVE", v({ sentOk: true, reads: [] }) === "INCONCLUSIVE");
ok("a malformed read (neither readable nor unreadable) → INCONCLUSIVE, never a finding", v({ sentOk: true, reads: [{}] }) === "INCONCLUSIVE");
ok("⭐ a READABLE read that says nothing about `found` → INCONCLUSIVE (a missing answer is not a 'no')", v({ sentOk: true, reads: [{ readable: true }, { readable: true, found: false }] }) === "INCONCLUSIVE", v({ sentOk: true, reads: [{ readable: true }, { readable: true, found: false }] }));

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-refid-verdict — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
