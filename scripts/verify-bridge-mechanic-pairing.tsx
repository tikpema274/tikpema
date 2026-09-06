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
  BRIDGE_SIGNERS, BRIDGE_SIGNER_COPY, bridgeSignerOf, bridgeSignerCopy,
} from "../shared/bridge-mechanic.mjs";
import React from "react";
const { BridgeQuoteSummary } = await import("../src/components/BridgeQuoteSummary");
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
section("3b — ⭐⭐ EXPLAIN A DERIVATION, NEVER A MEASUREMENT");
{
  // 🚨 FOUND BY LOOKING AT THE REAL LIST, NOT AT A FIXTURE. Rendered unconditionally, the mechanic
  // sentence put a 40-word disclaimer on all 57 existing receipts — verbatim, identical, burying the
  // one row that said something different. A caveat repeated on every row is one nobody reads.
  // ⛔ AND IT WAS IRRELEVANT THERE. Every sampled receipt is `minted` with `delivery: "measured"`
  // and an `amountDelivered` READ FROM THE CHAIN; the mechanic explains how a DERIVED figure was
  // reached and says nothing about a measured one. It was explaining an ambiguity the chain read
  // had already resolved.
  const withFees = { amountRequested: 1, feeCharged: 0.054, feeDisclosed: 0.054, destinationLabel: "Base (Sepolia)" };
  for (const m of BRIDGE_MECHANICS) {
    const derived = strip(BridgeReceiptStatus({ r: { ...withFees, state: "burn_confirmed", netPredicted: 1, feeMechanic: m } }));
    const measured = strip(BridgeReceiptStatus({ r: { ...withFees, state: "minted", delivery: "measured", amountDelivered: 0.9459, feeMechanic: m } }));
    check(`⭐ \`${m}\`: the sentence renders where the figure is DERIVED`,
      derived.includes(BRIDGE_MECHANIC_COPY[m].summary));
    check(`⛔ \`${m}\`: …and is SILENT where the arrival was MEASURED`,
      !measured.includes(BRIDGE_MECHANIC_COPY[m].summary), measured.slice(0, 100));
  }
  // ⚠️ AND THE MEASURED ROW STILL SAYS WHAT IT KNOWS — silence about the mechanic is not silence
  // about the money. Dropping the sentence must not drop the reading it was sitting beside.
  const meas = strip(BridgeReceiptStatus({ r: { ...withFees, state: "minted", delivery: "measured", amountDelivered: 0.9459 } }));
  check("⚠️ …and the measured row still reports the amount READ FROM THE CHAIN",
    /exactly 0\.945900 USDC/.test(meas) && /read from the destination chain/.test(meas), meas.slice(0, 120));
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
section("5 — ⛔ THE 4 SELF-SIGNED-ONLY SITES ARE CORRECT AND MUST NOT BE SWEPT");
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

  // ═══ ⭐⭐ THE FOURTH SITE: THE QUOTE SUMMARY LINE, RENDERED ═══════════════════════════════
  // 🚨 IT WAS THE ONE SELF-SIGNED SITE THAT STATED NO MECHANIC AT ALL. It read
  //     "1.0000 USDC → Base · fee 0.0543 · estimated arrival 0.9457"
  // — three numbers from which the reader was left to INFER subtraction. ⛔ The same three numbers
  // are consistent with EITHER mechanic, and the sibling agent path charges the fee ON TOP and says
  // so explicitly. A surface that states nothing is not neutral when its neighbour states the
  // opposite; it inherits the neighbour's meaning by default.
  //
  // ⭐ ASSERTED ON RENDERED OUTPUT, not on the source, and in BOTH DIRECTIONS — the deducted
  // sentence present AND the upfront one absent. [[assert-on-rendered-output-not-source-regex]]
  {
    const line = (mechanic: string | undefined) => {
      const c = bridgeMechanicCopy(mechanic);
      // The composition the panel performs, from the producer's fields only.
      return `fee 0.054300 USDC, ${c.feePlacement} — exact for this quote · ` +
             `${c.arrivalPrefix}0.945700 USDC ${c.arrivalSuffix}`;
    };
    const ded = line("deducted");
    const up = line("upfront");
    check("⭐⭐ the DEDUCTED summary says the fee is taken OUT OF the amount",
      /taken out of the amount/.test(ded), ded);
    check("⛔⛔ …and does NOT carry the upfront claim",
      !/on top of the amount/.test(ded) && !/full amount arrives/.test(ded));
    check("⭐⭐ the UPFRONT wording is genuinely different — or the check above is vacuous",
      /on top of the amount/.test(up) && ded !== up);
    check("⭐ the deducted line marks the ARRIVAL as the estimate, not the fee",
      /estimated 0\.945700 USDC to arrive/.test(ded) && /exact for this quote/.test(ded));
    check("⛔ …and `estimated` does not sit before the FEE figure",
      !/estimated 0\.054300/.test(ded));
    // ⚠️ A stale quote carrying no mechanic must claim NEITHER, rather than defaulting.
    // 🚨 THE FIRST DRAFT OF THIS CHECK WAS WRONG, AND IN THE RECORDED WAY. It scanned for the
    // absence of "on top of the amount" — and the `unknown` copy DENIES that phrase by naming it
    // ("does not say whether ON TOP OF THE AMOUNT or out of it"). A flat forbidden-phrase scan
    // fails honest denial copy; the guard went red on text that was correct.
    // ⭐ So the property is asserted POSITIVELY (the disclaimer is present) plus PAIRWISE (all
    // three lines differ), which needs no forbidden-phrase scan at all.
    // [[assert-on-rendered-output-not-source-regex]]
    const unk = line(undefined);
    check("⛔ a quote with NO mechanic says the record does not say — it does not default",
      /does not say whether/.test(unk), unk.slice(0, 90));
    check("⛔ …and it makes neither BARE claim",
      !/taken out of the amount/.test(unk) && !/charged on top of the amount/.test(unk));
    check("⭐⭐ all three lines are pairwise DISTINCT — one text satisfying three checks would be vacuous",
      new Set([ded, up, unk]).size === 3);

    // ⭐ AND THE PANEL ACTUALLY READS THE PRODUCER — a rendered check on composed strings proves
    // the copy composes; this proves the SURFACE is wired to it rather than to its own literal.
    // ⚠️ RE-POINTED. These pinned the one-line summary's INLINE implementation; that line is now the
    // shared three-row table, so the property moved rather than disappearing. The panel's job is to
    // THREAD the mechanic; the rendering is asserted on output in §8.
    check("⭐⭐ the panel threads the quote's mechanic into the shared table",
      /<BridgeQuoteSummary/.test(manual) && /mechanic=\{quote\.mechanic\}/.test(manual));
    check("⛔ …and writes NO mechanic sentence of its own",
      !/taken out of the amount/.test(mcode.replace(/A live cross-chain fee \(taken from the amount\)/g, " ")),
      "the only literal left is the pre-quote note, which is separately guarded above");
    check("⭐⭐ the producer PLUMBS the mechanic into the quote — without it the surface must guess",
      /mechanic: bridgeMechanicOf\(gate\.fee\.mechanic\)/.test(
        readFileSync("netlify/functions/user-bridge-start.mjs", "utf8")));

    // ⭐ 6dp now lives in the shared component and is asserted on RENDERED OUTPUT in §8, which is
    // stronger than counting call sites — it survives the figures moving between components.
    check("⭐ the panel declares its SIGNER, so it cannot inherit the wrong page instruction",
      /signer="browser"/.test(manual));
    check("⛔ …and no 4dp toFixed survives in this panel's quote line",
      !/quote\.\w+\.toFixed\(4\)/.test(manual));
  }

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

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — ⭐⭐ TWO AXES, INDEPENDENTLY KEYED");
{
  // ⛔ THE COUPLING THIS PREVENTS. `upfront` correlates with server-signed and `deducted` with
  // browser-signed TODAY — an accident of which two paths exist, not a rule. Keying the leave/stay
  // instruction on `mechanic` would make a `delegate` path (browser-INITIATED, server-RECORDED:
  // upfront-adjacent AND leavable) unrepresentable, and the coupling would then live in the type
  // system, where it is harder to see and no less wrong.
  check("⭐ three signers, and `unknown` is one of them",
    JSON.stringify(BRIDGE_SIGNERS) === JSON.stringify(["server", "browser", "unknown"]));
  check("⭐⭐ every signer has copy", BRIDGE_SIGNERS.every((x) => !!BRIDGE_SIGNER_COPY[x]));
  check("⛔ an unrecognised signer normalises to `unknown`, never a guess",
    bridgeSignerOf("delegate") === "unknown" && bridgeSignerOf(undefined) === "unknown");
  check("⛔⛔ `unknown` instructs NOTHING — 'you may leave' when we do not know is the one direction that loses a record",
    bridgeSignerCopy("unknown").pageInstruction === "" && bridgeSignerCopy("unknown").mustStay === null);
  check("⭐⭐ the two instructions are OPPOSITE and both non-empty — or the keying buys nothing",
    bridgeSignerCopy("server").mustStay === false && bridgeSignerCopy("browser").mustStay === true &&
    bridgeSignerCopy("server").pageInstruction !== bridgeSignerCopy("browser").pageInstruction);

  // ═══ ⭐⭐⭐ THE INDEPENDENCE FIXTURES — combinations that do not exist today MUST still render ═══
  // If `upfront + browser` or `deducted + server` were unreachable, the axes would be coupled in the
  // TYPES rather than in the code — the same defect wearing a different hat.
  const q = { amountUsdc: 1, feeUsdc: 0.0543, netUsdc: 1, netPredicted: 0.9457 };
  const render = (mechanic, signer) => strip(
    React.createElement(BridgeQuoteSummary, { quote: q, destinationLabel: "Base (Sepolia)", mechanic, signer, heldFeeNote: false }));
  const combos = [
    ["upfront", "server"], ["deducted", "browser"],
    ["upfront", "browser"],
    ["deducted", "server"],
  ];
  for (const [m, sg] of combos) {
    const out = render(m, sg);
    check(`⭐ ${m} + ${sg} renders coherently — the axes are not coupled`,
      out.length > 0 && /Fee/.test(out) && /You receive/.test(out) && /Leaves your wallet/.test(out));
    check(`   …with the ${m} placement and the ${sg} instruction, independently`,
      out.includes(bridgeMechanicCopy(m).feePlacement) &&
      (bridgeSignerCopy(sg).pageInstruction === "" || out.includes(bridgeSignerCopy(sg).pageInstruction)));
  }
  check("⭐⭐ flipping the SIGNER alone changes the render",
    render("upfront", "server") !== render("upfront", "browser"));
  check("⭐⭐ flipping the MECHANIC alone changes the render",
    render("upfront", "server") !== render("deducted", "server"));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("8 — ⭐⭐ THE ARITHMETIC IS THE MECHANIC, UNDER THE SAME THREE LABELS");
{
  const q = { amountUsdc: 1, feeUsdc: 0.0543, netUsdc: 1, netPredicted: 0.9457 };
  const rows = (mechanic) => strip(
    React.createElement(BridgeQuoteSummary, { quote: q, destinationLabel: "Base", mechanic, signer: "server", heldFeeNote: false }));
  const up = rows("upfront"), ded = rows("deducted");
  // ⭐ THE DEFECT THE SHARED TABLE MAKES POSSIBLE: right labels, wrong arithmetic. Nothing about
  // "You receive 1.000000" LOOKS wrong on a deducted quote — it is the number the user typed.
  check("⭐⭐ upfront: receive = the amount, leaves = amount + fee",
    /You receive 1\.000000 USDC/.test(up) && /Leaves your wallet 1\.054300 USDC/.test(up), up.slice(0, 120));
  check("⭐⭐ deducted: receive = amount − fee, leaves = THE AMOUNT",
    /You receive 0\.945700 USDC/.test(ded) && /Leaves your wallet 1\.000000 USDC/.test(ded), ded.slice(0, 120));
  check("⛔⛔ the two differ on BOTH figures — a table that moved neither would pass a one-sided check",
    !/You receive 1\.000000/.test(ded) && !/Leaves your wallet 1\.054300/.test(ded));
  check("⭐ 6dp everywhere — no 4dp figure survives in either render",
    !/\d\.\d{4} USDC/.test(up.replace(/\d\.\d{6} USDC/g, " ")) &&
    !/\d\.\d{4} USDC/.test(ded.replace(/\d\.\d{6} USDC/g, " ")));
  check("⭐ the mechanic SENTENCE sits alongside the table — both, not either",
    up.includes(bridgeMechanicCopy("upfront").feePlacement) &&
    ded.includes(bridgeMechanicCopy("deducted").feePlacement));
  check("⛔ …and neither render carries the OTHER mechanic's placement",
    !up.includes(bridgeMechanicCopy("deducted").feePlacement) &&
    !ded.includes(bridgeMechanicCopy("upfront").feePlacement));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("9 — ⚠️ TRIPWIRE: THE 'will be charged' SENTENCE LIVES ON EXACTLY ONE PANEL");
{
  // ═══ 🚨 WHY A TRIPWIRE AND NOT A COMMENT ══════════════════════════════════════════════════
  // "This is the fee that will be charged" OVERSTATES on both paths: `maxFee` is a CEILING and the
  // executed fee can be lower — measured, 55 of 67 third-party burns left surplus, 0 exceeded it.
  // PRE-EXISTING and deliberately NOT fixed here. ⛔ A comment saying "do not copy this" does not
  // prevent copying it. This counts.
  //
  // ⭐⭐ AND IT COUNTS PANELS, NOT SOURCE SITES. `BridgeQuoteSummary` is SHARED, so "one site in
  // source" and "one panel showing it" stopped being the same statement the moment it was reused —
  // which is exactly why the note is a gated prop rather than unconditional markup.
  const q = { amountUsdc: 1, feeUsdc: 0.0543, netUsdc: 1, netPredicted: 0.9457 };
  const withNote = (heldFeeNote) => strip(
    React.createElement(BridgeQuoteSummary, { quote: q, destinationLabel: "Base", mechanic: "upfront", signer: "server", heldFeeNote }));
  check("⭐ non-vacuity — the sentence really is rendered when the note is on",
    /fee that will be charged/.test(withNote(true)));
  check("⛔⛔ …and is ABSENT when it is off — the gate is real, not decorative",
    !/fee that will be charged/.test(withNote(false)));

  const panels = ["BridgePanel", "ManualBridgePanel"];
  const on = panels.filter((f) => {
    const src = readFileSync(`src/components/${f}.tsx`, "utf8")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/^\s*\/\/.*$/gm, " ");
    if (!/<BridgeQuoteSummary/.test(src)) return false;
    const tag = src.slice(src.indexOf("<BridgeQuoteSummary"));
    const props = tag.slice(0, tag.indexOf("/>"));
    return !/heldFeeNote=\{false\}/.test(props);
  });
  check("🚨 the 'will be charged' sentence is enabled on EXACTLY ONE panel",
    on.length === 1, on.join(", ") || "none");
  check("⭐ …and it is the agent panel — the self-signed one must not inherit an overstated claim",
    on[0] === "BridgePanel");
}

console.log(`\n${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail ? 1 : 0);
