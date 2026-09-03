// verify-bridge-mechanic-pairing.tsx — THE COPY MUST MATCH THE MECHANIC, IN EITHER DIRECTION.
//
//   npx tsx scripts/verify-bridge-mechanic-pairing.mjs   (also: npm run test:mechanicpairing)
//
// ═══ ⛔ WHY A PAIRING GUARD AND NOT A COPY GUARD ═══════════════════════════════════════════════
//
// Two fee mechanics are live at once — `upfront` on the agent path (the fee is charged on the source
// in addition to the amount, the recipient gets the FULL amount) and `deducted` on the self-signed
// path (the fee comes out of the amount). ~31 sites render a claim about this. 23 serve the agent
// path, **3 serve the self-signed path and are CORRECT AS THEY STAND**, and 5 serve BOTH.
//
// 🚨 A GUARD THAT PINNED THE SENTENCE WOULD BE WRONG FOR ONE PATH NO MATTER WHICH SENTENCE IT PINNED.
// So this asserts the PAIR: for each mechanic, its copy is rendered AND the other mechanic's copy is
// absent. Flip a path's mechanic and its own copy suite reddens — the vault-allowlist shape, and
// what stops the two vocabularies drifting into each other.
//
// ⭐ AND THE LABEL MUST AGREE WITH THE ARITHMETIC. A mechanic is not a decoration on a number: for
// `upfront`, `bridgeNetUsdc(amount) === amount`; for `deducted`, `bridgeNetDeducted === amount − fee`.
// Either side can be flipped and the other catches it.
//
// Zero network. Zero money.

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BRIDGE_MECHANICS, BRIDGE_MECHANIC_COPY, bridgeMechanicOf, bridgeMechanicCopy,
} from "../shared/bridge-mechanic.mjs";
import { bridgeNetUsdc, bridgeNetDeducted } from "../netlify/functions/_bridge.mjs";
const { BridgeReceiptStatus } = await import("../src/components/bridgeReceiptStatus");

let pass = 0, fail = 0;
const check = (l, c, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
  return !!c;
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
const strip = (n) => renderToStaticMarkup(n)
  .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/\s+/g, " ").trim();

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  MECHANIC ↔ COPY PAIRING — both directions, per mechanic             ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — THE CLOSED SET, BOTH DIRECTIONS");
check("⭐ three mechanics, and `unknown` is one of them",
  JSON.stringify(BRIDGE_MECHANICS) === JSON.stringify(["upfront", "deducted", "unknown"]));
// ⛔ EVERY MECHANIC HAS COPY, and every copy key names a mechanic. A mechanic a producer can emit
// with no copy renders nothing; a copy key nothing can produce is dead text that reads as coverage.
const copyKeys = Object.keys(BRIDGE_MECHANIC_COPY);
check("⭐⭐ every mechanic has copy", BRIDGE_MECHANICS.every((m) => !!BRIDGE_MECHANIC_COPY[m]));
check("⭐⭐ …and every copy key is a declared mechanic — no dead entries",
  copyKeys.every((k) => BRIDGE_MECHANICS.includes(k)), copyKeys.join(", "));
// ⭐ EVERY FIELD IS ANSWERABLE FOR ALL THREE. If a sentence cannot be written for `unknown` without
// asserting a mechanic, the surface should not be rendering it at all.
const fields = Object.keys(BRIDGE_MECHANIC_COPY.upfront);
check("⭐ every copy field is present for all three mechanics",
  BRIDGE_MECHANICS.every((m) => fields.every((f) => BRIDGE_MECHANIC_COPY[m][f] !== undefined)),
  fields.join(", "));
// ⛔ AND THE THREE MUST ACTUALLY DIFFER. Identical copy would pass every pairing check below while
// telling all three paths the same thing.
for (const f of ["feePlacement", "arrival", "summary"]) {
  const vals = BRIDGE_MECHANICS.map((m) => BRIDGE_MECHANIC_COPY[m][f]);
  check(`⛔ \`${f}\` is DISTINCT across all three — identical copy would pass vacuously`,
    new Set(vals).size === 3);
}
// ⚠️ Normalisation: anything unrecognised becomes `unknown`, never a guess.
for (const bad of [null, undefined, "", "UPFRONT", "on-top", 0, {}]) {
  check(`⚠️ ${JSON.stringify(bad)} normalises to \`unknown\``, bridgeMechanicOf(bad) === "unknown");
}
check("⭐ …and the two real values survive normalisation",
  bridgeMechanicOf("upfront") === "upfront" && bridgeMechanicOf("deducted") === "deducted");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⭐⭐ THE LABEL AGREES WITH THE ARITHMETIC");
{
  const A = 1_000_000n, F = 54_129n;
  // ⭐ A mechanic is not a decoration on a number. Flip either side and the other catches it.
  check("⭐⭐ `upfront`: net === amount — the recipient gets the full amount",
    bridgeNetUsdc({ amountMinor: A }) === 1, `${bridgeNetUsdc({ amountMinor: A })}`);
  check("⭐⭐ `deducted`: net === amount − fee",
    Math.abs(bridgeNetDeducted({ amountMinor: A, maxFee: F }) - (1 - 0.054129)) < 1e-9,
    `${bridgeNetDeducted({ amountMinor: A, maxFee: F })}`);
  // ⛔ AND THEY MUST DISAGREE WITH EACH OTHER. If the two producers returned the same number the
  // mechanic would be a label with nothing behind it.
  check("⛔ the two arithmetics DIFFER — otherwise the mechanic labels nothing",
    bridgeNetUsdc({ amountMinor: A }) !== bridgeNetDeducted({ amountMinor: A, maxFee: F }));
  // ⭐ AND THE COPY'S OWN CLAIM MATCHES ITS ARITHMETIC, read as text rather than assumed.
  check("⭐ `upfront` copy says the full amount arrives, and its arithmetic does too",
    /full amount arrives/.test(BRIDGE_MECHANIC_COPY.upfront.arrival) &&
    bridgeNetUsdc({ amountMinor: A }) === 1);
  check("⭐ `deducted` copy says amount − fee, and its arithmetic does too",
    /amount − fee/.test(BRIDGE_MECHANIC_COPY.deducted.arrival) &&
    bridgeNetDeducted({ amountMinor: A, maxFee: F }) < 1);
  // ⛔⛔ `unknown` MUST CLAIM NEITHER — the constraint the whole third value exists for.
  const u = BRIDGE_MECHANIC_COPY.unknown;
  check("⛔⛔ `unknown` claims NEITHER mechanic — not 'full amount', not 'out of the amount'",
    !/the full amount arrives/.test(u.summary + u.arrival) &&
    !/taken out of the amount/.test(u.summary + u.arrival) &&
    !/nets amount − fee/.test(u.summary + u.arrival), `${u.arrival} | ${u.summary}`);
  check("⭐ …and it says WHY it cannot, rather than merely omitting",
    /does not say/.test(u.summary) && /predates/.test(u.summary));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — 🚨 THE PAIRING, RENDERED: each mechanic's copy present AND the other's ABSENT");
{
  const base = { state: "burn_confirmed", netPredicted: 1, amountRequested: 1,
    feeCharged: 0.054129, feeDisclosed: 0.054129, debitDisclosed: 1.054129,
    destinationLabel: "Base (Sepolia)" };
  const rendered = Object.fromEntries(
    BRIDGE_MECHANICS.map((m) => [m, strip(BridgeReceiptStatus({ r: { ...base, feeMechanic: m } }))]));

  for (const m of BRIDGE_MECHANICS) {
    const mine = BRIDGE_MECHANIC_COPY[m].summary;
    const others = BRIDGE_MECHANICS.filter((o) => o !== m).map((o) => BRIDGE_MECHANIC_COPY[o].summary);
    check(`⭐⭐ \`${m}\` renders ITS OWN sentence`, rendered[m].includes(mine), rendered[m].slice(-120));
    // 🚨 THE HALF THAT MATTERS. A row rendering BOTH would satisfy a one-directional check while
    // telling the user two contradictory things about where their money went.
    check(`🚨 \`${m}\` renders NEITHER of the other two sentences`,
      others.every((o) => !rendered[m].includes(o)));
  }
  // ⛔ AND THE THREE RENDERS MUST DIFFER. Identical output would pass every check above if the
  // sentences happened to be substrings of one another.
  check("⛔ the three renders are pairwise DISTINCT — not one text satisfying three checks",
    new Set(Object.values(rendered)).size === 3);

  // ⭐ THE DEBIT LINE IS UPFRONT-ONLY. On the deducted path the wallet parts with exactly the
  // amount, so "N left your wallet" beside an arrival of N − fee reads as a contradiction.
  check("⭐⭐ 'left your wallet' renders ONLY for `upfront`",
    /left your wallet/.test(rendered.upfront) &&
    !/left your wallet/.test(rendered.deducted) && !/left your wallet/.test(rendered.unknown));
  // ⭐ AND THE ESTIMATE WORD FOLLOWS THE MECHANIC, not the state. On the upfront path the arrival
  // is the amount requested — calling it an estimate would understate what is known.
  check("⭐ `upfront` does not call the arrival an estimate; `deducted` does",
    !/estimated/i.test(rendered.upfront) && /estimated/i.test(rendered.deducted));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⛔ NO SURFACE WRITES ITS OWN SENTENCE");
{
  // 🚨 The whole design fails if a component composes its own wording: it could render a TRUE
  // sentence for the WRONG path and nothing about it would look wrong.
  const comp = readFileSync("src/components/bridgeReceiptStatus.tsx", "utf8");
  const code = comp.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/^\s*\/\/.*$/gm, " ");
  check("⭐⭐ the receipt component reads its sentence from the shared copy",
    /bridgeMechanicCopy\(/.test(code) && /copy\.summary/.test(code));
  check("⛔ …and does not hand-write either mechanic's claim",
    !/taken out of the amount/.test(code) && !/charged on top of the amount/.test(code),
    "a hand-written sentence can be true for the wrong path");
  check("⭐ the mechanic is derived ONCE, at the top, not per branch",
    (code.match(/bridgeMechanicOf\(r\.feeMechanic\)/g) || []).length === 1);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — ⛔ THE 3 SELF-SIGNED-ONLY SITES ARE CORRECT AND MUST NOT BE SWEPT");
{
  // ═══ 🚨 THIS IS A GUARD AGAINST A FUTURE FIX, NOT AGAINST A BUG ════════════════════════════
  // `ManualBridgePanel` says "only N USDC would arrive" and "estimated arrival" — TRUE, because
  // that path burns through BridgingKitContract where the fee IS deducted. A sweep that rewrote
  // every "would arrive" to the upfront wording would break honest copy on the one path that
  // cannot migrate. Pinned so the conversion cannot happen quietly.
  const manual = readFileSync("src/components/ManualBridgePanel.tsx", "utf8");
  const mcode = manual.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/^\s*\/\/.*$/gm, " ");
  check("⭐⭐ the self-signed panel still says the fee comes out of the amount",
    /would arrive/.test(mcode), "correct for the DEDUCTED mechanic");
  check("⭐⭐ …and still calls its arrival an ESTIMATE — netPredicted there is arithmetic",
    /estimated/i.test(mcode));
  check("⛔ …and has NOT acquired the upfront path's claim",
    !/full amount arrives/.test(mcode) && !/charged on top/.test(mcode) &&
    !/left your wallet/.test(mcode),
    "a sweep converting this would make it lie about a path that deducts");

  // ⭐ AND ITS PRODUCER STILL DECLARES THE DEDUCTED MECHANIC — the pairing, one layer down.
  const bridge = readFileSync("netlify/functions/_bridge.mjs", "utf8");
  check("⭐⭐ `bridgeFeeDeducted` still declares the DEDUCTED mechanic",
    /export async function bridgeFeeDeducted[\s\S]{0,1600}?mechanic: "deducted"/.test(bridge));
  check("⭐⭐ `bridgeFee` still declares the UPFRONT mechanic",
    /export async function bridgeFee\([\s\S]{0,2400}?mechanic: "upfront"/.test(bridge));
  const user = readFileSync("netlify/functions/_user-bridge.mjs", "utf8");
  check("⭐ the self-signed path still prices with the DEDUCTED producer",
    /bridgeFeeDeducted\(/.test(user) && !/\bbridgeFee\(/.test(user.replace(/bridgeFeeDeducted\(/g, "")));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — THE ORIGIN GAP IS CLOSED, END TO END");
{
  // 🚨 `promoteUserBridge` rebuilt `r` by include-list and never read `origin`, so every promoted
  // self-signed receipt reached the durable store indistinguishable from an agent one. Audited
  // field by field: `origin` was the ONLY loss — but an include-list rebuild can only lose, so the
  // shape guarantees there can be others the day a field is added to the intent and not to it.
  const rec = readFileSync("netlify/functions/_bridge-record.mjs", "utf8");
  check("⭐⭐ the promotion carries `origin` through the rebuild", /origin: pending\.origin \?\? null/.test(rec));
  check("⭐⭐ …and derives the mechanic from the path rather than guessing",
    /pending\.origin === "user-signed" \? "deducted" : "unknown"/.test(rec));
  check("⭐ the shared writer persists both", /origin: r\.origin \?\? null/.test(rec) &&
    /feeMechanic: bridgeMechanicOf\(src\?\.feeMechanic\)/.test(rec));
  const exp = readFileSync("netlify/functions/bridge-receipts.mjs", "utf8");
  check("⭐⭐ the exposure projects both — a field written and never projected is invisible",
    /feeMechanic: bridgeMechanicOf\(r\.feeMechanic\)/.test(exp) && /origin: r\.origin \?\? null/.test(exp));
  // ⛔ AND THE DEFAULT IS `unknown` EVERYWHERE IT IS READ.
  check("⛔ nothing defaults to a mechanic it was not told",
    !/feeMechanic.*\?\?\s*"upfront"/.test(rec + exp) && !/feeMechanic.*\?\?\s*"deducted"/.test(rec + exp),
    "a permanent record must not assert a mechanic it never recorded");
}

console.log(`\n${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail ? 1 : 0);
