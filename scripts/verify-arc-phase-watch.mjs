// verify-arc-phase-watch.mjs — a watcher whose silence means "not yet", never "I could not look".
//
//   npm run test:arcphase
//
// ⛔ THE PROPERTY: this scrapes a docs page, so the failure that matters is a PARSE failure reading
// as "still Upcoming". Silence standing in for the event we are waiting for is the one direction
// that must never happen — the whole point is to be told when Arc mainnet lands.

import { parsePhases, verdict, BASELINE } from "../netlify/functions/arc-phase-watch.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const TABLE = `
| **Devnet**          | Internal | x |
| **Private Testnet** | Complete | x |
| **Public Testnet**  | Live     | x |
| **Private Mainnet** | Upcoming | x |
| **Public Mainnet**  | Upcoming | x |
`;

console.log("\n── 1. THE BASELINE PARSES AND READS STEADY ──────────────────");
{
  const p = parsePhases(TABLE);
  check("all five phases parse", Object.keys(BASELINE).every((k) => k in p), JSON.stringify(p));
  const v = verdict({ phases: p });
  check("⭐ unchanged → steady, and steady is the SILENT outcome", v.level === "steady");
  check("   …with nothing listed as changed", v.changed.length === 0);
}

console.log("\n── 2. 🚨🚨 MAINNET GOING LIVE IS THE EVENT ──────────────────");
{
  const v = verdict({ phases: parsePhases(TABLE.replace("| **Private Mainnet** | Upcoming", "| **Private Mainnet** | Live    ")) });
  check("🚨 detected as an EVENT, not a mere change", v.level === "event", v.level);
  check("⭐ the headline names the transition", /Private Mainnet: Upcoming → Live/.test(v.headline), v.headline.slice(0, 90));
  check("⭐⭐ …and points at the NEXT blocker rather than declaring victory",
    /Gateway domain/.test(v.headline),
    "chain-layer unblocked is not unified-balance-works — the two are separate gates");
  const pub = verdict({ phases: parsePhases(TABLE.replace("| **Public Mainnet**  | Upcoming", "| **Public Mainnet**  | Live    ")) });
  check("public mainnet going live is also an event", pub.level === "event");
}

console.log("\n── 3. ⛔ A PARSE FAILURE ALERTS — IT NEVER READS AS 'NOT YET' ──");
{
  const empty = verdict({ phases: parsePhases("<html>the docs are now a SPA</html>") });
  check("🚨 zero phases parsed → ERROR, not steady", empty.level === "error", empty.level);
  check("⭐ …and says WHY silence would be wrong here", /must never happen/.test(empty.headline));
  const gone = verdict({ phases: parsePhases("| **Devnet** | Internal | x |") });
  check("🚨 a RESTRUCTURED table (rows missing) → ERROR", gone.level === "error", gone.level);
  check("⭐ …naming which rows vanished", /Public Mainnet/.test(gone.headline), gone.headline.slice(0, 90));
  const net = verdict({ error: "HTTP 503" });
  check("🚨 a fetch failure → ERROR, explicitly UNKNOWN not 'no change'",
    net.level === "error" && /UNKNOWN, not/.test(net.headline));
}

console.log("\n── 4. ⚠️ A NON-MAINNET EDIT IS A CHANGE, NOT AN EVENT ────────");
{
  const v = verdict({ phases: parsePhases(TABLE.replace("| **Devnet**          | Internal", "| **Devnet**          | Retired ")) });
  check("⭐ flagged as change, so the baseline gets refreshed", v.level === "change", v.level);
  check("⛔ but NOT as the mainnet event — it is not one", !/MAINNET IS LIVE/.test(v.headline));
  check("   …and it says the baseline is stale", /baseline is stale/.test(v.headline));
}

console.log("\n── 5. ⭐ EXTRA TABLES ON THE PAGE DO NOT CONFUSE THE VERDICT ──");
{
  // ⚠️ The live page carries other pipe tables (Uptime, Transactions…). The parser is loose by
  // design — it would still find a phase row moved into another table — and the verdict only ever
  // compares BASELINE keys, so extra rows cannot change the outcome.
  const noisy = TABLE + "\n| **Uptime** | 100% | x |\n| **Transactions** | ~30.7M | x |\n";
  const v = verdict({ phases: parsePhases(noisy) });
  check("⭐ unrelated rows are parsed but ignored", v.level === "steady", v.level);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money, zero network.\n`);
process.exit(fail === 0 ? 0 : 1);
