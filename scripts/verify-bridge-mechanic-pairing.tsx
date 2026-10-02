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
import * as MECH from "../shared/bridge-mechanic.mjs";
// ⭐ The proposal line lives with the rest of the fee-disclosure family (2026-10-02). Read through the namespace so a
// missing export fails the checks below, not the suite's load.
import * as ACKCOPY from "../shared/bridge-ack-copy.mjs";
const bridgeProposalFeeLine: (a: any) => string = (ACKCOPY as any).bridgeProposalFeeLine ?? (() => "");
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
section("8b — ⛔⛔ THE CEILING QUALIFIER: DEDUCTED ONLY, AND IT STATES THE RELATIONSHIP");
{
  // 🚨 THE MIRROR OF THE 'will be charged' NOTE. That sentence is EXACT on upfront (the contract
  // asserts collected == quoted; `maxFee` is EMPTY_MAX_FEE = 0 there). The CEILING is the deducted
  // path's property — `feeUsdc = toUsdc(maxFee)`, signed into the calldata as a real bound.
  // ⛔ A 2026-09-06 correction: the reverse was asserted across four artifacts on a measurement that
  // outlived the mechanic it measured. This pins the direction so it cannot be inverted again.
  const q = { amountUsdc: 1, feeUsdc: 0.0543, netUsdc: 1, netPredicted: 0.9457 };
  const r = (mechanic) => strip(React.createElement(BridgeQuoteSummary,
    { quote: q, destinationLabel: "Base", mechanic, signer: "server", heldFeeNote: false }));
  const up = r("upfront"), ded = r("deducted"), unk = r("nonsense");

  check("⭐ the producer marks the DEDUCTED fee as a ceiling and the UPFRONT one as not",
    bridgeMechanicCopy("deducted").feeIsCeiling === true &&
    bridgeMechanicCopy("upfront").feeIsCeiling === false);
  check("⛔ …and `unknown` claims NEITHER — it cannot say what its own figure was",
    bridgeMechanicCopy("unknown").feeIsCeiling === null &&
    bridgeMechanicCopy("unknown").feeCeilingNote === "");
  check("⭐⭐ the DEDUCTED render carries the ceiling qualifier",
    ded.includes(bridgeMechanicCopy("deducted").feeCeilingNote));
  check("⛔⛔ the UPFRONT render does NOT — a hedge there would be FALSE, the contract asserts equality",
    !/is a maximum/.test(up) && !/can be lower/.test(up), up.slice(0, 90));
  check("⛔ …and neither does an unrecognised mechanic", !/is a maximum/.test(unk));
  // ⭐ IT STATES THE RELATIONSHIP, NOT A HEDGE. "may be lower" alone is weaker than naming what the
  // number IS and when the real one is set.
  check("⭐⭐ the qualifier says it is a MAXIMUM and names when the real fee is set",
    /maximum/i.test(ded) && /when the burn runs/i.test(ded));
  // ⚠️ SCOPED TO THE QUALIFIER, NOT THE WHOLE RENDER. The first draft scanned `ded` for "usually"
  // and matched the SETTLEMENT row — `MINT_TIMING` is "usually under a minute" — so the guard went
  // red on a sentence it was not about. Third forbidden-phrase-scan mis-scope this session: assert
  // against the string you mean, never against everything that happens to be beside it.
  const ceilingCopy = bridgeMechanicCopy("deducted").feeCeilingNote;
  check("⛔ …and claims NO likelihood — no distribution has been measured on this path",
    !/usually|typically|most of the time|often|rarely/i.test(ceilingCopy), ceilingCopy);
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

  // ═══ ⭐⭐ THE SAME TREATMENT FOR THE CEILING QUALIFIER, IN THE OTHER DIRECTION ═══════════════
  // The 'will be charged' note must be on ONE panel because it OVERSTATES anywhere else. The
  // ceiling qualifier must be on ONE panel because it is FALSE anywhere else — the upfront contract
  // asserts collected == quoted. Same shape, opposite reason, so both are counted.
  const ceilingPanels = ["BridgePanel", "ManualBridgePanel"].filter((f) => {
    const src = readFileSync(`src/components/${f}.tsx`, "utf8")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/^\s*\/\/.*$/gm, " ");
    if (!/<BridgeQuoteSummary/.test(src)) return false;
    const tag = src.slice(src.indexOf("<BridgeQuoteSummary"));
    const props = tag.slice(0, tag.indexOf("/>"));
    // The qualifier follows the MECHANIC, so the panel that threads a deducted quote gets it.
    return /mechanic=\{quote\.mechanic\}/.test(props);
  });
  check("🚨 the ceiling qualifier reaches EXACTLY ONE panel — the deducted one",
    ceilingPanels.length === 1 && ceilingPanels[0] === "ManualBridgePanel",
    ceilingPanels.join(", ") || "none");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("10 — 🚨 THE CONVERSATIONAL AGENT SURFACE DERIVES ITS FEE SENTENCE — NEITHER MECHANIC BY HAND");
{
  // ═══ 🚨 THE DEFECT THIS PINS ═══════════════════════════════════════════════════════════════
  // `MyAgentPanel` (the bridge-proposal confirm) and `agent-act` (the reply message) each said
  // "(taken from the amount)" BY HAND — the deducted mechanic's words — on the agent path, which has
  // charged the fee ON TOP since upfront fees (`bridgeFee` declares "upfront", §5 above). Live and
  // false, and §9's panel census never looked at this file. Fixed by deriving both from
  // `bridgeProposalFeeLine`, keyed on the mechanic the server priced.
  //
  // ⭐⭐ BOTH DIRECTIONS, ON THE PRODUCER'S RENDERED OUTPUT: the upfront line carries the upfront
  // placement and NOT the deducted one; the deducted line the reverse; `unknown` claims neither and
  // extends no arrival. Then the SURFACES are pinned to the producer by source: they call it, and
  // carry NO placement literal of EITHER mechanic — so a hand-typed sentence of either kind fails
  // here, whichever direction it lies in. (§5 is the mirror for the self-signed panel.)
  const UP = BRIDGE_MECHANIC_COPY.upfront.feePlacement;
  const DED = BRIDGE_MECHANIC_COPY.deducted.feePlacement;
  const line = (mechanic) => bridgeProposalFeeLine({ feeUsdc: 0.054071, netUsdc: 1, destinationLabel: "Base", mechanic });
  check("⭐⭐ ONE home: shared/bridge-ack-copy.mjs exports bridgeProposalFeeLine, beside the acknowledgement forms",
    typeof (ACKCOPY as any).bridgeProposalFeeLine === "function");
  check("⛔ …and bridge-mechanic.mjs no longer does (a second export is a second home)", !("bridgeProposalFeeLine" in MECH));
  check("⭐ the two placements are DIFFERENT strings — or the pairing below cannot discriminate", UP !== DED && UP.length > 0 && DED.length > 0);
  check("⭐⭐ upfront line carries the UPFRONT placement", line("upfront").includes(`(${UP})`), line("upfront"));
  check("⛔ …and NOT the deducted one", !line("upfront").includes(DED) && !/taken from the amount/.test(line("upfront")));
  check("⭐⭐ deducted line carries the DEDUCTED placement", line("deducted").includes(`(${DED})`), line("deducted"));
  check("⛔ …and NOT the upfront one", !line("deducted").includes(UP));
  check("⭐⭐ `unknown` claims NEITHER placement and extends NO arrival",
    !line(undefined).includes(UP) && !line(undefined).includes(DED) && !/arrives/.test(line(undefined)), line(undefined));
  check("⭐ the fee renders at 4dp (0.054071 → 0.0541), where fee and arrival cannot collapse", /~0\.0541 USDC/.test(line("upfront")));

  const stripSrc = (f) => readFileSync(f, "utf8").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const surfaces = [
    ["src/components/MyAgentPanel.tsx", /^import\s*\{[^}]*\bbridgeProposalFeeLine\b[^}]*\}\s*from\s*"\.\.\/\.\.\/shared\/bridge-ack-copy\.mjs"/m],
    ["netlify/functions/agent-act.mjs", /^import\s*\{[^}]*\bbridgeProposalFeeLine\b[^}]*\}\s*from\s*"\.\.\/\.\.\/shared\/bridge-ack-copy\.mjs"/m],
    // ⭐ The proposal CARD (Discover run → approve). It said "taken out of the amount" by hand on the
    // upfront path too — a third copy of the same falsehood — and now derives both its indicative
    // sentence (bridgeMechanicCopy of the recorded mechanic) and its quoted line (the producer).
    ["src/components/jobTimeline.tsx", /^import\s*\{[^}]*\bbridgeProposalFeeLine\b[^}]*\}\s*from\s*"\.\.\/\.\.\/shared\/bridge-ack-copy\.mjs"/m],
  ];
  for (const [f, importRe] of surfaces) {
    const src = stripSrc(f);
    check(`⭐⭐ ${f} imports the sentence from the producer`, importRe.test(src));
    check(`⭐⭐ ${f} CALLS bridgeProposalFeeLine(…mechanic…)`, /bridgeProposalFeeLine\(\{[^}]*\bmechanic\b/.test(src));
    check(`⛔⛔ ${f} carries NO deducted-placement literal ("${DED}" / "taken from the amount")`,
      !src.includes(DED) && !/taken from the amount/.test(src), "a hand-typed deducted sentence on the upfront path");
    check(`⛔⛔ ${f} carries NO upfront-placement literal either ("${UP}") — derived means neither`,
      !src.includes(UP), "a hand-typed upfront sentence is right today and unguarded tomorrow");
  }
  // ⭐ THE MECHANIC REACHES THE PANEL FROM THE SERVER, normalised — the panel keys on `b.mechanic`,
  // so the server must put it there, and via bridgeMechanicOf, never raw.
  const act = stripSrc("netlify/functions/agent-act.mjs");
  check("⭐⭐ agent-act threads `mechanic: bridgeMechanicOf(fee.mechanic)` into the bridge proposal", /mechanic:\s*bridgeMechanicOf\(fee\.mechanic\)/.test(act));
  const card = stripSrc("src/components/jobTimeline.tsx");
  check("⭐⭐ the card's INDICATIVE sentence reads bridgeMechanicCopy(proposal.indicativeMechanic) — the recorded mechanic, not a constant",
    /bridgeMechanicCopy\(proposal\.indicativeMechanic\)/.test(card) && !/out of<\/b> the amount/.test(card));
  const panel = stripSrc("src/components/MyAgentPanel.tsx");
  check("⭐⭐ the panel keys the sentence on the SERVER's mechanic (`mechanic: b.mechanic`), not a constant",
    /bridgeProposalFeeLine\(\{[^}]*mechanic:\s*b\.mechanic\b/.test(panel) && !/mechanic:\s*"(upfront|deducted)"/.test(panel));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("11 — ⭐⭐ THE CHAT SURFACE, RENDERED: every bridge step shows its sealed fee; the window is quiet, then loud, then a re-price");
{
  // A state behind a transition is untested by default: MyAgentPanel's initial render carries no
  // proposal, so the per-step fee line and the countdown are asserted by rendering AgentSummary with
  // the proposal shape agent-act returns. [[state-behind-a-transition-is-untested-by-default]]
  const { AgentSummary } = await import("../src/components/MyAgentPanel");
  const UP = BRIDGE_MECHANIC_COPY.upfront.feePlacement;
  const disclosure = (over = {}) => ({ amountUsdc: 1, destinationKey: "base", destinationLabel: "Base", feeUsdc: 0.054071, netUsdc: 1,
    mechanic: "upfront", feeRatio: 0.054, band: "none", ackToken: null, quoteToken: "t.t", expiresInMs: 120_000, ...over });
  const base = { decision: { action: "plan" }, needsConfirm: true, plan: [{ type: "bridge_usdc", amountUsdc: 1, destination: "base" }], totalUsdc: 1, quoteId: "q" };
  const render = (data, quotedAt, now) => strip(React.createElement(AgentSummary, {
    data, planRun: null, planBusy: false, planMints: {}, planAcked: {}, onPlanAckChange: () => {}, bridgeReceipts: [],
    onConfirm: () => {}, onRequotePlan: () => {}, quotedAt, now, bridgeRun: null, bridgeBusy: false, bridgeAcked: false,
    walletReady: true, onAckChange: () => {}, mint: null, onConfirmBridge: () => {}, onRequoteBridge: () => {},
    vaultAcked: false, onVaultAckChange: () => {}, vaultDelta: null, vaultRun: null, vaultBusy: false, onConfirmVault: () => {} } as any));
  const t0 = 1_000_000;
  const ordinary = render({ ...base, stepDisclosures: { 0: disclosure() } }, t0, t0 + 1_000);
  check("⭐⭐ an ORDINARY-band bridge step renders its fee line (it used to render nothing below the warn band)",
    /Step 1 — Cross-chain fee ~0\.0541 USDC/.test(ordinary), ordinary.slice(0, 120));
  check("⭐⭐ …with the UPFRONT placement, derived", ordinary.includes(`(${UP})`));
  check("⛔ …and not the deducted one", !/taken out of the amount|taken from the amount/.test(ordinary));
  check("⭐ 119 s left: the window note is QUIET (no countdown above 30 s)", !/good for another/.test(ordinary) && /Confirm & execute/.test(ordinary));
  const late = render({ ...base, stepDisclosures: { 0: disclosure() } }, t0, t0 + 100_000);
  check("⭐ 20 s left: the window note appears, naming the seconds", /good for another 20s/.test(late), late.match(/good for another \d+s/)?.[0] ?? "absent");
  const expired = render({ ...base, stepDisclosures: { 0: disclosure() } }, t0, t0 + 121_000);
  check("⭐⭐ past the window: the button becomes a RE-PRICE, not a confirm", /Quote expired — price it again/.test(expired) && !/Confirm & execute/.test(expired));
  const unknownWindow = render({ ...base, stepDisclosures: { 0: disclosure({ expiresInMs: undefined }) } }, t0, t0 + 999_000);
  check("⛔ a server that sent no window is NOT treated as expired — ignorance is not expiry", /Confirm & execute/.test(unknownWindow) && !/price it again/.test(unknownWindow));
  const requoted = render({ ...base, requoted: true, quoteExpiredNote: true, stepDisclosures: { 0: disclosure() } }, t0, t0 + 1_000);
  check("⭐ after a 409 re-quote the surface SAYS the figure was priced again and nothing ran", /priced again — nothing ran/.test(requoted));
  const single = { decision: { action: "bridge_usdc" }, needsBridgeConfirm: true, bridge: { amountUsdc: 1, destination: { key: "base", label: "Base" },
    feeUsdc: 0.054071, netUsdc: 1, mechanic: "upfront", feeDisclosure: { band: "none", feeRatio: 0.054, ackToken: null }, quoteToken: "t.t", expiresInMs: 120_000 } };
  const s1 = render(single, t0, t0 + 1_000), s2 = render(single, t0, t0 + 121_000);
  check("⭐⭐ single-action: the fee line is derived (upfront placement) and the confirm is offered", s1.includes(`(${UP})`) && /Confirm & bridge/.test(s1));
  check("⭐⭐ single-action: past the window the confirm becomes a re-price", /Quote expired — price it again/.test(s2) && !/Confirm & bridge/.test(s2));
}

section("12 — 🚨 THE ACKNOWLEDGEMENT CARDS: an upfront fee is never a loss, and all three say it from ONE place");
{
  // ═══ WHY (2026-10-01) ═══════════════════════════════════════════════════════════════════════════
  // Three cards users read BEFORE acknowledging said "This bridge loses X% to fees" / "Step N loses X% to fees",
  // and the consent itself said "most of this amount will be spent on the network fee". On the agent path the fee is
  // UPFRONT: the full amount arrives and the fee is charged on top. Sections 3–11 watched "taken out of" / "on top
  // of", never "loses", which is how these survived the mechanic change. The wording now lives in
  // shared/bridge-ack-copy.mjs (React cannot import _bridge.mjs: it pulls Circle/Blobs/RPC clients in at module
  // scope). _bridge.mjs re-exports the sentence for the server. The family below fails on any UPFRONT fee surface;
  // DEDUCTED wording stays allowed on the self-signed path, where the fee really is deducted (§5).
  const FAMILY = /\b(lose|loses|lost|eats|deducted|only)\b|most of (this|it|step|the amount)/i;
  const ACK = await import("../shared/bridge-ack-copy.mjs").catch(() => null);
  check("⭐ shared/bridge-ack-copy.mjs exists and exports the four producers",
    !!ACK && ["bridgeAckSentence", "bridgeAckHeading", "bridgeAckConsent"].every((k) => typeof ACK[k] === "function") && typeof ACK?.BRIDGE_ACK_FLAT_FEE_NOTE === "string");
  const SERVER = await import("../netlify/functions/_bridge.mjs");
  check("⭐⭐ the server's bridgeAckSentence IS the shared one (re-export, not a copy)", !!ACK && SERVER.bridgeAckSentence === ACK.bridgeAckSentence);

  // Literal expectations (fee 0.054147 on 0.1 → 54.1%), so a producer change cannot silently re-pin itself.
  const SENT = "This bridge charges a fee of 0.0541 USDC on top of the 0.1 you're sending — 54.1% of the amount. The full 0.1 arrives; about 0.1541 leaves your wallet.";
  const NOTE = "The cross-chain fee is flat, so it costs the same whether you bridge 0.1 or 100 USDC. Bridging a larger amount at once, or not bridging, both leave you with more.";
  const H1 = "The fee is 54.1% of the amount, charged on top";
  const HS = "Step 1: the fee is 54.1% of the amount, charged on top";
  const C1 = "I understand the fee is charged on top of the amount, and I want to bridge anyway.";
  const CS = "I understand step 1's fee is charged on top of its amount, and I want to run this plan anyway.";
  const card = (text, head, consent) => { const a = text.indexOf(head), b = text.indexOf(consent); return a >= 0 && b > a ? text.slice(a, b + consent.length) : ""; };

  const { AgentSummary } = await import("../src/components/MyAgentPanel");
  const render = (data) => strip(React.createElement(AgentSummary, {
    data, planRun: null, planBusy: false, planMints: {}, planAcked: {}, onPlanAckChange: () => {}, bridgeReceipts: [],
    onConfirm: () => {}, onRequotePlan: () => {}, quotedAt: 1_000_000, now: 1_001_000, bridgeRun: null, bridgeBusy: false, bridgeAcked: false,
    walletReady: true, onAckChange: () => {}, mint: null, onConfirmBridge: () => {}, onRequoteBridge: () => {},
    vaultAcked: false, onVaultAckChange: () => {}, vaultDelta: null, vaultRun: null, vaultBusy: false, onConfirmVault: () => {} } as any));
  const single = render({ decision: { action: "bridge_usdc" }, needsBridgeConfirm: true, bridge: { amountUsdc: 0.1, destination: { key: "base", label: "Base" },
    feeUsdc: 0.054147, netUsdc: 0.1, mechanic: "upfront", feeDisclosure: { band: "acknowledge", feeRatio: 0.54147, ackToken: "a" }, quoteToken: "t.t", expiresInMs: 120_000 } });
  const sc = card(single, H1, C1);
  check("⭐⭐ AGENT BRIDGE CARD (MyAgentPanel): heading, the sentence, the flat-fee note, the consent", !!sc && sc.includes(SENT) && sc.includes(NOTE), sc.slice(0, 140) || single.slice(0, 160));
  check("🚨 …and the card says none of the family (lose/loses/lost/eats/deducted/only/most of)", !!sc && !FAMILY.test(sc), (sc.match(FAMILY) || [""])[0]);

  const plan = render({ decision: { action: "plan" }, needsConfirm: true, plan: [{ type: "bridge_usdc", amountUsdc: 0.1, destination: "base" }], totalUsdc: 0.1, quoteId: "q",
    stepDisclosures: { 0: { amountUsdc: 0.1, destinationKey: "base", destinationLabel: "Base", feeUsdc: 0.054147, netUsdc: 0.1, mechanic: "upfront",
      feeRatio: 0.54147, band: "acknowledge", ackToken: "a", quoteToken: "t.t", expiresInMs: 120_000 } } });
  const pc = card(plan, HS, CS);
  check("⭐⭐ PLAN STEP CARD (MyAgentPanel): heading, the sentence, the flat-fee note, the consent", !!pc && pc.includes(SENT) && pc.includes(NOTE), pc.slice(0, 140) || plan.slice(0, 160));
  check("🚨 …and the card says none of the family", !!pc && !FAMILY.test(pc), (pc.match(FAMILY) || [""])[0]);

  // BridgePanel's card is behind a fetched quote (state), so it is checked in SOURCE, scoped to its ack block.
  const bp = readFileSync("src/components/BridgePanel.tsx", "utf8").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const a0 = bp.indexOf('disclosure?.band === "acknowledge"'); const blk = a0 >= 0 ? bp.slice(a0, bp.indexOf("</label>", a0)) : "";
  check("⭐⭐ BRIDGE PANEL CARD: the ack block calls all four shared producers",
    /bridgeAckHeading\(/.test(blk) && /bridgeAckSentence\(/.test(blk) && /BRIDGE_ACK_FLAT_FEE_NOTE/.test(blk) && /bridgeAckConsent\(/.test(blk), blk ? "" : "ack block not found");
  check("🚨 …and its block writes none of the family by hand", !!blk && !FAMILY.test(blk), (blk.match(FAMILY) || [""])[0]);
  for (const f of ["MyAgentPanel", "BridgePanel"]) {
    const code = readFileSync(`src/components/${f}.tsx`, "utf8").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/^\s*\/\/.*$/gm, " ");
    check(`⛔ ${f}: no hand-written "loses … to fees" / "most of this amount" anywhere`, !/loses \{|loses [0-9]|to fees|most of (this|step|it)/.test(code));
  }

  // The family over EVERY upfront fee string the copy module holds; deducted wording stays where it is TRUE.
  const upStrings = Object.values(BRIDGE_MECHANIC_COPY.upfront).filter((v) => typeof v === "string").join(" | ");
  check("🚨 BRIDGE_MECHANIC_COPY.upfront: none of the family", !FAMILY.test(upStrings), (upStrings.match(FAMILY) || [""])[0]);
  const ackStrings = ACK ? [ACK.bridgeAckSentence({ amountUsdc: 0.1, feeUsdc: 0.054147, feeRatio: 0.54147 }), ACK.bridgeAckHeading({ feeRatio: 0.54147 }),
    ACK.bridgeAckHeading({ feeRatio: 0.54147, step: 1 }), ACK.BRIDGE_ACK_FLAT_FEE_NOTE, ACK.bridgeAckConsent({}), ACK.bridgeAckConsent({ step: 1 }),
    bridgeProposalFeeLine({ feeUsdc: 0.054147, netUsdc: 0.1, destinationLabel: "Base", mechanic: "upfront" })].join(" | ") : "";
  check("🚨 shared/bridge-ack-copy.mjs: none of the family in anything it produces", !!ackStrings && !FAMILY.test(ackStrings), (ackStrings.match(FAMILY) || [""])[0]);
  check("⭐ DEDUCTED copy is untouched and still says the fee comes out of the amount (true on the self-signed path)",
    /taken out of the amount/.test(BRIDGE_MECHANIC_COPY.deducted.summary));
}

section("13 — ⭐⭐ STRUCTURAL: every upfront fee disclosure states what ARRIVES and what LEAVES — whatever its words");
{
  // ═══ WHY A WORD LIST IS NOT ENOUGH (2026-10-01) ═════════════════════════════════════════════════
  // §12's family check caught "loses"; the warn-band lines then evaded it by describing the fee as PART of the amount
  // ("X% of this bridge goes to the network fee", "F USDC of A") without one listed word. A word list catches
  // phrasings, never omissions. This section is wording-blind: render the SAME proposal in the band and in band
  // "none", take what the band ADDED (common prefix/suffix removed), and require that text to carry two FIGURES —
  // the amount (what arrives; nothing is deducted) and amount + fee (what leaves the wallet). A disclosure that gives
  // only a percentage cannot contain 0.3541 by accident, in any words. Figures are matched numerically, so "0.3" and
  // "0.3000" both count as the amount.
  const { AgentSummary } = await import("../src/components/MyAgentPanel");
  const render = (data) => strip(React.createElement(AgentSummary, {
    data, planRun: null, planBusy: false, planMints: {}, planAcked: {}, onPlanAckChange: () => {}, bridgeReceipts: [],
    onConfirm: () => {}, onRequotePlan: () => {}, quotedAt: 1_000_000, now: 1_001_000, bridgeRun: null, bridgeBusy: false, bridgeAcked: false,
    walletReady: true, onAckChange: () => {}, mint: null, onConfirmBridge: () => {}, onRequoteBridge: () => {},
    vaultAcked: false, onVaultAckChange: () => {}, vaultDelta: null, vaultRun: null, vaultBusy: false, onConfirmVault: () => {} } as any));
  const added = (withBand, without) => {
    let a = 0; while (a < withBand.length && a < without.length && withBand[a] === without[a]) a++;
    let b = 0; while (b < withBand.length - a && b < without.length - a && withBand[withBand.length - 1 - b] === without[without.length - 1 - b]) b++;
    return withBand.slice(a, withBand.length - b);
  };
  const nums = (t) => (t.match(/\d+\.\d+|\d+/g) || []).map(Number);
  const states = (t, amount, fee) => {
    const n = nums(t);
    return { arrives: n.some((x) => Math.abs(x - amount) < 1e-9), leaves: n.some((x) => Math.abs(x - (amount + fee)) < 5e-5) };
  };
  const FEE = 0.054147;
  const single = (amount, band, ratio) => ({ decision: { action: "bridge_usdc" }, needsBridgeConfirm: true, bridge: { amountUsdc: amount,
    destination: { key: "base", label: "Base" }, feeUsdc: FEE, netUsdc: amount, mechanic: "upfront",
    feeDisclosure: { band, feeRatio: ratio, ackToken: band === "acknowledge" ? "a" : null }, quoteToken: "t.t", expiresInMs: 120_000 } });
  const plan = (amount, band, ratio) => ({ decision: { action: "plan" }, needsConfirm: true, plan: [{ type: "bridge_usdc", amountUsdc: amount, destination: "base" }],
    totalUsdc: amount, quoteId: "q", stepDisclosures: { 0: { amountUsdc: amount, destinationKey: "base", destinationLabel: "Base", feeUsdc: FEE, netUsdc: amount,
      mechanic: "upfront", feeRatio: ratio, band, ackToken: band === "acknowledge" ? "a" : null, quoteToken: "t.t", expiresInMs: 120_000 } } });
  const cases = [
    ["agent bridge, WARN band", single, 0.3, "warn"], ["agent bridge, ACKNOWLEDGE band", single, 0.1, "acknowledge"],
    ["plan step, WARN band", plan, 0.3, "warn"], ["plan step, ACKNOWLEDGE band", plan, 0.1, "acknowledge"],
  ];
  for (const [label, mk, amount, band] of cases) {
    const ratio = FEE / amount;
    const diff = added(render(mk(amount, band, ratio)), render(mk(amount, "none", ratio)));
    const st = states(diff, amount, FEE);
    check(`⭐⭐ ${label}: the band ADDS a disclosure`, diff.length > 20, diff.slice(0, 60));
    check(`🚨 ${label}: it states what ARRIVES (${amount}) and what LEAVES (${(amount + FEE).toFixed(4)})`, st.arrives && st.leaves,
      `arrives=${st.arrives} leaves=${st.leaves} — "${diff.slice(0, 150)}"`);
  }
  // BridgePanel's disclosure sits behind a fetched quote, so its structure is checked in source: EVERY band block
  // renders the shared sentence (which is what carries both figures). It has no warn block today; one added later
  // must call it too.
  const bp = readFileSync("src/components/BridgePanel.tsx", "utf8").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const blocks = [...bp.matchAll(/\{disclosure\?\.band === "(warn|acknowledge)" && \(/g)].map((m) => bp.slice(m.index, bp.indexOf("</div>\n      )}", m.index)));
  check("⭐ BridgePanel: at least one band block found", blocks.length >= 1, String(blocks.length));
  check("🚨 BridgePanel: EVERY band block renders bridgeAckSentence (the arrives + leaves figures)",
    blocks.length >= 1 && blocks.every((b) => /bridgeAckSentence\(/.test(b)), blocks.map((b) => b.slice(0, 40)).join(" | "));
  // And the producer itself carries both figures for ANY amount/fee — the property, not one fixture.
  const { bridgeAckSentence } = await import("../shared/bridge-ack-copy.mjs");
  const grid = [[0.07, 0.054147], [0.3, 0.054147], [1.234567, 0.06], [25, 0.11]];
  check("⭐ the shared sentence states both figures across a grid of amounts and fees",
    grid.every(([a, f]) => { const x = states(bridgeAckSentence({ amountUsdc: a, feeUsdc: f, feeRatio: f / a }), a, f); return x.arrives && x.leaves; }));

  // ═══ THE ORDINARY BAND (2026-10-02): the PROPOSAL LINE was the one exception ═══════════════════════════════════
  // Below the warn band the only fee disclosure is bridgeProposalFeeLine (reply message, confirm panel, plan steps,
  // the job card's quote). It stated what arrives and not what leaves. Same rule, same wording-blind figure test.
  // ⚠️ It serves THREE mechanics, so the figures are per mechanic: upfront arrives = amount, leaves = amount + fee;
  // deducted arrives ≈ amount − fee, leaves = amount (= net + fee: on BOTH paths what leaves is net + fee).
  // `unknown` states NEITHER: the record does not say which number arrived, and so not which one left.
  const near = (t, x) => nums(t).some((n) => Math.abs(n - x) <= 6e-5); // 4dp display: rounding error ≤ 5e-5
  for (const [label, mk, amount] of [["agent bridge, ORDINARY band (none)", single, 2], ["plan step, ORDINARY band (none)", plan, 2]]) {
    const text = render(mk(amount, "none", FEE / amount));
    check(`🚨 ${label}: the rendered proposal states what ARRIVES (${amount}) and what LEAVES (${(amount + FEE).toFixed(4)})`,
      near(text, amount) && near(text, amount + FEE), text.slice(0, 160));
  }
  const pgrid = [[0.07, 0.054147], [2, 0.054147], [1.234567, 0.06], [25, 0.11]];
  check("⭐⭐ upfront proposal line: arrives = amount AND leaves = amount + fee, across a grid",
    pgrid.every(([a, f]) => { const t = bridgeProposalFeeLine({ feeUsdc: f, netUsdc: a, destinationLabel: "Base", mechanic: "upfront" }); return near(t, a) && near(t, a + f); }),
    bridgeProposalFeeLine({ feeUsdc: 0.054147, netUsdc: 2, destinationLabel: "Base", mechanic: "upfront" }));
  check("⭐⭐ deducted proposal line: arrives ≈ amount − fee AND leaves = the amount, across a grid",
    pgrid.filter(([a, f]) => a > f).every(([a, f]) => { const t = bridgeProposalFeeLine({ feeUsdc: f, netUsdc: a - f, destinationLabel: "Base", mechanic: "deducted" }); return near(t, a - f) && near(t, a); }),
    bridgeProposalFeeLine({ feeUsdc: 0.054147, netUsdc: 2 - 0.054147, destinationLabel: "Base", mechanic: "deducted" }));
  const unk = bridgeProposalFeeLine({ feeUsdc: 0.054147, netUsdc: 2, destinationLabel: "Base", mechanic: undefined });
  check("⛔ unknown proposal line: states NEITHER an arrival nor a departure figure (only the fee)", !near(unk, 2) && !near(unk, 2 + 0.054147) && !/leaves|arrives/.test(unk), unk);
}

console.log(`\n${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail ? 1 : 0);
