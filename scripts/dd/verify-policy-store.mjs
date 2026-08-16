// verify-policy-store.mjs — the four things storage had to get right.
//
// Storage is what would let a policy stop being advisory, so each of these is a consent question
// rather than a data question:
//   1. 🚨 it STILL cannot gate, and that is enforced by a throw rather than by a field nobody reads
//   2. ⭐ absent / empty / all-allow / active are FOUR states and never collapse
//   3. ⚠️ unknown group names are rejected at WRITE and at READ — never dropped
//   4. ⭐ the digest is server-computed, and coverageThreshold has bounds plus null≠0
//
//   node scripts/dd/verify-policy-store.mjs
//
// Zero network, zero money — the pure layer is exercised directly.

import {
  POLICY_STATE, POLICY_AUTHORITY, CATALOGUE_SIZE,
  classifyPolicy, normalizePolicy, policyDigest, assertMayGate,
} from "../../shared/onchain-analyze/policy-doc.mjs";
import { POWER_SIGS } from "../../shared/onchain-facts/index.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 64 - t.length))}`);
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("1 🚨🚨 STORAGE STILL CANNOT GATE — enforced by a THROW");
{
  // ⭐ THE POINT OF THIS SECTION. Shipping storage without the override token is what makes a policy
  // able to block a deposit with no escape. The safeguard is not "we set a field to display-only" —
  // it is that acting on a verdict raises an exception until the override exists.
  const e1 = threw(() => assertMayGate(POLICY_AUTHORITY.ENFORCING));
  check("🚨🚨 even ENFORCING authority THROWS while the override token does not exist",
    !!e1 && /override token does not exist/.test(e1.message));
  const e2 = threw(() => assertMayGate(POLICY_AUTHORITY.DISPLAY_ONLY));
  check("🚨 display-only throws too", !!e2);
  check("⭐ …and the throw names the file and flag to change, so the flip is deliberate",
    /policy-doc\.mjs/.test(e1.message) && /OVERRIDE_TOKEN_EXISTS/.test(e1.message));
  check("⭐ the authority vocabulary is a closed set of two",
    Object.values(POLICY_AUTHORITY).sort().join(",") === "display-only,enforcing");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("2 ⭐⭐ FOUR STATES — absent / empty / all-allow / active never collapse");
{
  check("absent: null", classifyPolicy(null) === POLICY_STATE.ABSENT);
  check("absent: undefined", classifyPolicy(undefined) === POLICY_STATE.ABSENT);
  // ⚠️ THE WIPE SHAPE. `{}` is what a failed migration or a half-completed delete leaves behind, and
  // a user whose rules got wiped has made NO decision. Reading it as consent is the consent bug.
  check("⚠️ empty: rules {} is its OWN state, not absent",
    classifyPolicy({ rules: {} }) === POLICY_STATE.EMPTY);
  check("⚠️ …and not all-allow either",
    classifyPolicy({ rules: {} }) !== POLICY_STATE.ALL_ALLOW);
  // ⭐ THE DELIBERATE SHAPE. Someone permitted every power. That IS a decision and legitimately
  // passes — but for a different reason than "nothing was found".
  check("⭐ all-allow: every rule `allow` is its OWN state",
    classifyPolicy({ rules: { upgradeable: "allow", denylist: "allow" } }) === POLICY_STATE.ALL_ALLOW);
  check("active: at least one refuse",
    classifyPolicy({ rules: { upgradeable: "refuse", denylist: "allow" } }) === POLICY_STATE.ACTIVE);
  check("⭐⭐ all four are distinct values", new Set(Object.values(POLICY_STATE)).size === 4);

  // ⚠️ And the ROUTE gives each its own sentence — a shared string would re-collapse them in the UI.
  const src = (await import("node:fs")).readFileSync("netlify/functions/agent-policy.mjs", "utf8");
  const meanings = [...src.matchAll(/\[POLICY_STATE\.(\w+)\]:\s*\n?\s*"([^"]+)"/g)].map((m) => m[2]);
  check("⭐ every state has its own distinct sentence in the response",
    meanings.length === 4 && new Set(meanings).size === 4, `${meanings.length} sentences`);
  check("⚠️ …and the EMPTY one says it is not the same as allowing everything",
    meanings.some((m) => /not the same as allowing everything/i.test(m)));
  check("⭐ …and the ALL-ALLOW one says it passes because nothing is refused",
    meanings.some((m) => /because you refuse nothing/i.test(m)));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("3 ⚠️⚠️ UNKNOWN GROUPS ARE REJECTED — never dropped");
{
  // 🚨 THE TYPO CASE. `upgradable` would silently fail to refuse `upgradeable`: the user's own safety
  // rule quietly doing nothing, with a UI still showing it as set.
  const typo = normalizePolicy({ rules: { upgradable: "refuse" } });
  check("🚨🚨 a typo'd group REJECTS the whole policy", typo.ok === false);
  check("🚨 …and names the offender", typo.errors.some((e) => /upgradable/.test(e)));
  check("⭐ …and lists the real catalogue, so the error is actionable",
    typo.errors.some((e) => /upgradeable/.test(e) && /denylist/.test(e)));
  check("🚨🚨 …and the rule is NOT silently kept with the bad key dropped", typo.policy === null);

  const bad = normalizePolicy({ rules: { upgradeable: "maybe" } });
  check("an unrecognised verdict rejects too", bad.ok === false && bad.errors.some((e) => /maybe/.test(e)));

  // ⚠️ READ-TIME IS NOT REDUNDANT: a policy stored before a catalogue change can name a group that
  // no longer exists. The same normaliser runs on read, so it surfaces instead of evaporating.
  const storeSrc = (await import("node:fs")).readFileSync("netlify/functions/_policy-store.mjs", "utf8");
  check("⚠️⚠️ readPolicy RE-VALIDATES rather than trusting the write",
    /normalizePolicy\(raw\.policy \?\? raw\)/.test(storeSrc));
  check("⭐ …and returns the errors rather than a usable policy",
    /if \(!n\.ok\)/.test(storeSrc) && /policy: null/.test(storeSrc));

  const good = normalizePolicy({ rules: { upgradeable: "refuse", denylist: "allow" }, coverageThreshold: 5 });
  check("a valid policy normalises", good.ok === true && good.policy.rules.upgradeable === "refuse");
  check("⭐ every catalogue group is accepted",
    normalizePolicy({ rules: Object.fromEntries(Object.keys(POWER_SIGS).map((g) => [g, "refuse"])) }).ok === true);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("4 ⭐ SERVER-COMPUTED DIGEST, AND coverageThreshold BOUNDS");
{
  // ⚠️ null ≠ 0. `null` = no threshold set. `0` = a threshold that is trivially met, which is a
  // STATEMENT ("I require no coverage"), not an absence. Coercing 0 → null erases a decision.
  const noneT = normalizePolicy({ rules: { upgradeable: "refuse" } });
  const zeroT = normalizePolicy({ rules: { upgradeable: "refuse" }, coverageThreshold: 0 });
  check("⭐⭐ null and 0 are preserved as DIFFERENT thresholds",
    noneT.policy.coverageThreshold === null && zeroT.policy.coverageThreshold === 0);
  check("⭐⭐ …and they digest differently",
    policyDigest(noneT.policy) !== policyDigest(zeroT.policy),
    `${policyDigest(noneT.policy)} vs ${policyDigest(zeroT.policy)}`);
  check("⭐ a null threshold renders as an explicit marker, not an empty slot",
    /\|cov:none\|/.test(policyDigest(noneT.policy)));

  // 🚨 A THRESHOLD ABOVE THE CATALOGUE SIZE CAN NEVER BE MET — a lockout the user wrote themselves,
  // rejected where it is still a typo rather than a mystery about a vault.
  const tooHigh = normalizePolicy({ rules: { upgradeable: "refuse" }, coverageThreshold: CATALOGUE_SIZE + 1 });
  check("🚨🚨 an unsatisfiable threshold is REJECTED at write time", tooHigh.ok === false);
  check("🚨 …and says it would refuse every contract forever",
    tooHigh.errors.some((e) => /never be satisfied/.test(e) && /forever/.test(e)));
  check("⭐ exactly the catalogue size IS allowed (satisfiable, if only by a full report)",
    normalizePolicy({ rules: { upgradeable: "refuse" }, coverageThreshold: CATALOGUE_SIZE }).ok === true);
  check("negative rejects", normalizePolicy({ rules: { upgradeable: "refuse" }, coverageThreshold: -1 }).ok === false);
  check("non-integer rejects", normalizePolicy({ rules: { upgradeable: "refuse" }, coverageThreshold: 2.5 }).ok === false);

  // ⭐ CANONICAL: rule ORDER must not change the digest, or an override token would bind to a
  // key-insertion order rather than to a set of rules.
  const a = normalizePolicy({ rules: { upgradeable: "refuse", denylist: "allow" } });
  const b = normalizePolicy({ rules: { denylist: "allow", upgradeable: "refuse" } });
  check("⭐⭐ digest is canonical — rule order does not change it",
    policyDigest(a.policy) === policyDigest(b.policy), policyDigest(a.policy));
  check("⭐ …but a changed VERDICT does",
    policyDigest(a.policy) !== policyDigest(normalizePolicy({ rules: { upgradeable: "allow", denylist: "allow" } }).policy));
  check("⭐ versioned from the start, so a future input can bump it", /\|v1$/.test(policyDigest(a.policy)));

  // 🚨 NEVER ACCEPTED FROM THE CLIENT — an override token binds to this, so a caller-supplied digest
  // would bind an override to rules nobody stored. Refused LOUDLY, not ignored.
  const routeSrc = (await import("node:fs")).readFileSync("netlify/functions/agent-policy.mjs", "utf8");
  check("🚨🚨 a request carrying `digest` is REJECTED, not silently ignored",
    /if \("digest" in body\)/.test(routeSrc) && /computed server-side/.test(routeSrc));
  const storeSrc = (await import("node:fs")).readFileSync("netlify/functions/_policy-store.mjs", "utf8");
  check("⭐ the stored digest is computed from the NORMALISED document",
    /const digest = policyDigest\(n\.policy\)/.test(storeSrc));
  check("⭐ the owner key comes from the session, never the body",
    /policyKey\(owner\)/.test(storeSrc) && !/body\.owner/.test(storeSrc));

  // ⚠️ STRONG READS — a cached PERMISSIVE policy outliving the stricter one that replaced it is the
  // dangerous direction, same lesson as the health artifact.
  check("⚠️ the store reads with strong consistency", /consistency: READ_CONSISTENCY/.test(storeSrc) &&
    /const READ_CONSISTENCY = "strong"/.test(storeSrc));
  check("⚠️ …and an unreadable store is NOT reported as an absent policy",
    /readable: false/.test(storeSrc) && /NOT "no policy"/.test(storeSrc));

  // ⚠️ AND THE REPORT ROUTE MUST NOT FALL BACK TO THE BODY ON A STORE OUTAGE.
  const rptSrc = (await import("node:fs")).readFileSync("netlify/functions/agent-dd-report.mjs", "utf8");
  check("🚨🚨 an unreadable policy store REFUSES rather than using the request body",
    /if \(!stored\.readable\)/.test(rptSrc) && /Refusing rather than/.test(rptSrc));
  check("⭐ a stored-but-invalid policy surfaces instead of being skipped",
    /storedPolicyInvalid|stored-policy-invalid/.test(rptSrc));
  check("⭐ the response says WHERE the rules came from",
    /source: usingStored \? "stored"/.test(rptSrc));
}

console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
