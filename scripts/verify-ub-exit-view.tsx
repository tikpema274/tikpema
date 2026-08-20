// verify-ub-exit-view.tsx — THE REAL SERVER PAYLOAD, THROUGH THE REAL COMPONENT, RENDERED.
//
//   npx tsx --experimental-test-module-mocks scripts/verify-ub-exit-view.tsx   (also: npm run test:ub)
//
// ═══ 🚨 WHY THIS EXISTS — A GUARD THAT REPORTED COVERAGE IT DID NOT HAVE ══════════════════════
// `verify-unified-balance-copy` named `UbExitStatus` among the child components its whole-rendered-
// tree checks reach. Measured 2026-08-20: it contributes **ZERO CHARACTERS** to a 4,152-char
// render. `loading` starts `true` and every claim-bearing branch sits behind a `useEffect` fetch of
// `/api/ub-withdraw` that `renderToStaticMarkup` never runs.
//
// ⭐⭐ AND THE FAILURE WAS SILENT BY CONSTRUCTION: an ABSENCE check over a component that renders
// nothing PASSES. The suite was green and blind simultaneously — not an absent guard, but a present
// one reporting coverage it could not deliver. Five phrases were probed and all were missing,
// including "Nothing arrives in your own wallet automatically", the hop-3 caveat that is the most
// load-bearing line in the product now that hop 2 works: `completed` means the funds reached the
// SCA, NOT the user.
//
// ═══ ⭐ THE PAYLOAD IS SERVER-PRODUCED, NOT HAND-WRITTEN ═════════════════════════════════════
// A fixture I typed would assert that the component renders whatever I imagined the server sends.
// So this drives the REAL `ub-withdraw` GET handler — with the REAL stored record for withdrawal
// 16be509f, the first exit ever completed end to end — and feeds ITS output into the REAL
// component. ⚠️ A binding can only be tested across what it binds, and the server/client boundary
// is exactly where the `synthesis` projection gap hid for months.
//
// ⚠️ ONE DEVIATION FROM THE STORED BYTES, and it is in the fixture rather than here: the owner
// address is synthetic. A testnet identity in a committed file becomes a mainnet one. No assertion
// below depends on it.
//
// ⚠️ PRESENT AND ABSENT BOTH. A phrase appearing does not mean the wrong one left, and every claim
// here has a matching negative — a component that rendered the reassuring branch unconditionally
// would pass a presence-only suite while telling a user their money is home when it is not.

import { mock } from "node:test";
import { readFileSync } from "node:fs";

const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/ub-withdrawal-16be509f.json", import.meta.url), "utf8")
);
const RECORD = FIXTURE.record;
const OWNER = RECORD.owner;

// ── the four seams the GET handler needs, and nothing more ────────────────────────────────────
// ⚠️ Chain state and store contents are INPUTS chosen per scenario; the handler's own projection
// logic (tri-state balance, unreadable-vs-empty withdrawals, the disclosure block) is REAL.
let EXIT: any = { readable: true, availableAtomic: "1510000", availableUsdc: "1.51",
  withdrawableAtomic: "0", withdrawableUsdc: "0", delayBlocks: "1209600", approxDelayDays: 7.1,
  delayProvenance: "1209600 BLOCKS (not seconds …) about 7 days" };
let STORE_ROWS: any[] = [RECORD];
let STORE_READABLE = true;

mock.module("../netlify/functions/_blobs.mjs", { namedExports: { connectBlobs: () => {} } });
mock.module("../netlify/functions/_auth.mjs",
  { namedExports: { requireSession: () => ({ ok: true, owner: OWNER, address: OWNER }) } });
// ⚠️ `walletAddress`, NOT `address` — ub-withdraw.mjs:82 reads `wallet.walletAddress`. My first
// mock returned `address` and the handler produced `owner: undefined`, which the section-0 check
// caught. ⭐ A mock that does not honour the real contract is the harness inside the measurement:
// it would have let every assertion below run against a payload the server never emits.
mock.module("../netlify/functions/_agent-wallets.mjs", { namedExports: {
  ensureOwnerWallet: async () => ({ ok: true, walletAddress: OWNER }),
  WALLET_PROVISIONING_STATUS: 202, walletProvisioningRefusal: () => ({}),
  WALLET_UNRESOLVABLE_STATUS: 503, walletUnresolvableRefusal: () => ({}),
  isWalletUnresolvable: () => false,
} });
mock.module("../netlify/functions/_ubwithdraw.mjs", { namedExports: {
  readExitState: async () => EXIT,
  ubInitiateWithdrawal: async () => { throw new Error("not exercised by this suite"); },
} });
mock.module("../netlify/functions/_ubwithdraw-record.mjs", { namedExports: {
  listByOwner: async () => STORE_READABLE
    ? { readable: true, rows: STORE_ROWS, matchedKeys: STORE_ROWS.length, returned: STORE_ROWS.length, skipped: 0 }
    : { readable: false, rows: [], matchedKeys: 0, returned: 0, skipped: 0, error: "store down" },
  createRecord: async () => RECORD, patchRecord: async () => RECORD,
  STATE: { INITIATING: "initiating", WAITING: "waiting", COMPLETING: "completing",
           COMPLETED: "completed", FAILED: "failed" },
  blocksNewWithdrawal: () => false,
} });

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { handler } = await import("../netlify/functions/ub-withdraw.mjs");
const UbExitStatus = (await import("../src/components/UbExitStatus")).default;

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

/** Ask the REAL handler, then paint the REAL component with what it said. */
async function serverThenRender() {
  const res = await handler({ httpMethod: "GET", headers: { authorization: "Bearer t" } }, {});
  const payload = JSON.parse(res.body);
  const html = renderToStaticMarkup(
    <UbExitStatus token={async () => "t"} initial={{ data: payload }} />
  );
  const text = html.replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ").trim();
  return { payload, text, status: res.statusCode };
}

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  UB EXIT STATUS — real GET handler → real component → rendered       ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("0 — 🚨 THE COMPONENT MUST ACTUALLY RENDER SOMETHING");
// The whole point. Every assertion below is vacuous against an empty string, which is precisely how
// the previous guard passed while covering nothing.
const completed = await serverThenRender();
check("🚨 the handler answered 200", completed.status === 200);
check("🚨🚨 the component contributes a NON-EMPTY render — the failure this suite exists for",
  completed.text.length > 200, `${completed.text.length} chars`);
check("⭐ …and the payload came from the server's own projection, not a hand-written fixture",
  completed.payload.owner === OWNER && !!completed.payload.disclosure);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⭐⭐ THE HOP-3 CAVEAT: `completed` IS NOT 'YOUR MONEY IS BACK'");
check("⭐⭐ the user is told funds do NOT reach their own wallet automatically",
  /Nothing arrives in your own wallet automatically/.test(completed.text));
check("⭐ …and that the last step is theirs to take",
  /separate step you control/.test(completed.text));
check("🚨 …and the page NEVER says the money is back",
  !/your money is back|funds are back|returned to you/i.test(completed.text));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⚠️ THE WAIT IS DESCRIBED, NEVER PROMISED");
check("⭐ 'about seven days' appears", /about seven days/.test(completed.text));
check("🚨 …and NO countdown or fixed date is rendered — a derived estimate must not read as a deadline",
  !/\d+ days? (left|remaining|to go)/i.test(completed.text) &&
  !/\b20\d\d-\d\d-\d\d\b/.test(completed.text), completed.text.match(/\b20\d\d-\d\d-\d\d\b/)?.[0] ?? "");
check("⭐ …and it says the wait cannot be cancelled once begun",
  /cannot be cancelled once it begins/.test(completed.text));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — 🚨 UNREADABLE IS NOT ZERO, AND NOT EMPTY (both tri-states, both directions)");
EXIT = { readable: false, error: "rpc down",
  detail: "the Gateway balance could not be read, so nothing can be said about this exit" };
const unreadable = await serverThenRender();
check("🚨 an unreadable CHAIN never renders a zero balance",
  !/0\.000000/.test(unreadable.text), unreadable.text.slice(0, 90));
check("⭐ …and says so in words", /could not|couldn’t|couldn't/i.test(unreadable.text));
EXIT = { readable: true, availableAtomic: "1510000", availableUsdc: "1.51", withdrawableAtomic: "0",
  withdrawableUsdc: "0", delayBlocks: "1209600", approxDelayDays: 7.1, delayProvenance: "x" };

STORE_READABLE = false;
const storeDown = await serverThenRender();
check("🚨🚨 an unreadable STORE must NOT read as 'you have no withdrawals'",
  !/Nothing on its way out right now/.test(storeDown.text));
// ⚠️ PINNED TO THE RENDERED SENTENCE, after my first pattern guessed at wording the component does
// not use. Widening a pattern until it passes is how the bridge guard produced four false alarms
// and then missed a real deletion; the fix is to assert what is actually painted.
check("⭐ …it states that we could not LOOK, which is a different answer from 'you have none'",
  /We couldn’t read your withdrawal list/.test(storeDown.text) &&
  /not a statement that you have none/.test(storeDown.text));
STORE_READABLE = true;

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⭐ THE EMPTY STATE IS ALLOWED TO SAY 'NOTHING PENDING' — and only then");
STORE_ROWS = [];
const empty = await serverThenRender();
check("⭐ with a READABLE and empty store, the reassuring line is correct and present",
  /Nothing on its way out right now/.test(empty.text));
check("🚨 …and the hop-3 caveat is NOT dropped just because nothing is pending",
  /Nothing arrives in your own wallet automatically/.test(empty.text));
STORE_ROWS = [RECORD];

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — ⭐ SIX DECIMALS, because 2dp hides material differences on a money page");
check("⭐ the balance renders with six decimals", /\d\.\d{6}\b/.test(completed.text),
  completed.text.match(/\d\.\d{6}\b/)?.[0] ?? "none found");

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
