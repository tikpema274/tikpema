// verify-agent-parameters-claim.mjs — what /api/agent-parameters says about HOW its values can change, pinned.
//
// ═══ WHY (2026-10-02) ═══════════════════════════════════════════════════════════════════════════════════
// The endpoint told every caller its values were "re-read from configuration on every request. An operator can
// change any of them at any time". MEASURED FALSE on 2026-10-01: with AGENT_SEND_CAP_USDC set to 9, 35 reads over
// 15 minutes all returned 10, with no deploy in the window. Netlify documents environment variables as fixed when a
// deploy is made, and its CLI says the same. A change takes effect on the NEXT DEPLOY, not on the next request.
// The false version overstated how fast a cap can move, and said nothing about the edit that takes effect NOWHERE
// (changed in the settings, never deployed): a reader of the settings would believe a cap the money paths do not enforce.
//
// This suite calls the REAL handler for every agent and pins the sentence it SERVES (not the source text), then
// checks the whole response for the two measured-false claims.

import { readFileSync } from "node:fs";
import { handler } from "../netlify/functions/agent-parameters.mjs";
import { AGENTS } from "../netlify/functions/_agents.mjs";

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 70 - t.length))}`);

// ⭐ THE PINNED SENTENCE. A change to it is a reviewed edit HERE, against the measurement above.
const EXPECTED =
  "MUTABLE, BUT ONLY BY A DEPLOY. These are the agent's CURRENT operating parameters, read from the environment " +
  "configuration of the deploy that served this request. That configuration is fixed when a deploy is made: an " +
  "operator changes a value by editing the configuration AND deploying again, and an edit that is not deployed takes " +
  "effect nowhere — not here, and not in the money paths. So a value here is true for the deploy that served " +
  "`readAt`, and is NOT a promise about the next one. They are the same values the money paths enforce. Do NOT read " +
  "them as guarantees — for the guarantees see `invariants`, and fetch the IPFS document it points at: nothing served " +
  "from this endpoint carries any authority, including the invariant text mirrored below.";
// The two claims measured false on 2026-10-01, in the forms they were served.
const FALSE_CLAIMS = /every request|re-read|at any time/i;

section("1 — the served disclaimer, for every agent, is the pinned sentence");
const served = [];
for (const a of AGENTS) {
  const r = await handler({ httpMethod: "GET", path: `/api/agent-parameters/${a.id}` });
  const body = r.statusCode === 200 ? JSON.parse(r.body) : null;
  served.push([a.id, body]);
  ok(`${a.id}: 200 and a disclaimer`, !!body && typeof body.disclaimer === "string", `status ${r.statusCode}`);
  ok(`⭐⭐ ${a.id}: the disclaimer IS the pinned sentence`, body?.disclaimer === EXPECTED, (body?.disclaimer ?? "").slice(0, 110));
}

section("2 — 🚨 no part of any response repeats a measured-false claim");
for (const [id, body] of served) {
  const s = JSON.stringify(body ?? {});
  ok(`🚨 ${id}: no "every request" / "re-read" / "at any time" anywhere in the response`, !FALSE_CLAIMS.test(s), (s.match(FALSE_CLAIMS) || [""])[0]);
}
ok("⭐ the response still labels itself mutable (a deploy can change it), not a guarantee",
  served.every(([, b]) => b?.mutable === true && b?.kind === "live-parameters"));

section("3 — the source's own description says the same (it is what the next editor reads)");
const src = readFileSync(new URL("../netlify/functions/agent-parameters.mjs", import.meta.url), "utf8");
const comments = (src.match(/^\s*\/\/.*$/gm) || []).join("\n");
ok("🚨 no comment says the values are re-read on every request or change at any time", !FALSE_CLAIMS.test(comments),
  (comments.match(new RegExp(`.*(${FALSE_CLAIMS.source}).*`, "i")) || [""])[0].trim().slice(0, 120));
ok("⭐ …and the header names the deploy as what changes a value", /deploy/i.test(comments.slice(0, 1500)));

section("4 — wiring");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
ok("this suite is in test:all", (pkg.suites || []).includes("test:paramsclaim") && /verify-agent-parameters-claim\.mjs/.test(pkg.scripts?.["test:paramsclaim"] ?? ""));

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0\n`);
