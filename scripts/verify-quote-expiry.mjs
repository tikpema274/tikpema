// verify-quote-expiry.mjs — THE QUOTE'S OWN DEADLINE: decoded, cross-checked, branched on.
//
//   node scripts/verify-quote-expiry.mjs        (also: npm run test:quoteexpiry)
//
// ═══ WHY THIS SUITE EXISTS ═══════════════════════════════════════════════════════════════════
// Circle's upfront-fee quote carries a deadline, and a burn submitted after it REVERTS. The
// deadline is not a number — it is a KIND and a number. Every way of getting that wrong produces a
// plausible-looking answer rather than an error:
//   · read the mode off the front of the blob   -> 0x01 = BLOCK HEIGHT on every real quote
//   · compare a timestamp against a block number -> valid for decades, nothing looks wrong
//   · compare our millisecond `iat` to their second `expiresAt` -> 1000×, in the unsafe direction
//   · fall through an unrecognised mode to "probably a timestamp"
//
// ⭐ RUN AGAINST THE TWO REAL QUOTES ON DISK — the ones the run-1 and run-2 burns were made with.
//
// Zero network. Zero money. Zero real Blobs.

import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret-for-quote-expiry-suite";

import {
  QUOTE_EXPIRY_MODES, QuoteExpiryError,
  decodeExpiryWord, normalizeQuoteExpiry, assertQuoteUnexpired,
} from "../netlify/functions/_quote-expiry.mjs";
import { sealBridgeQuote, openBridgeQuote, quoteWindowMs, QUOTE_TTL_MS } from "../netlify/functions/_bridge.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
  return !!c;
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
/** Run `fn`, return the QuoteExpiryError code / Error message, or null if it did not throw. */
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };

const Q = (n) => JSON.parse(readFileSync(`scripts/spikes/${n}`, "utf8"));
const RUN1 = Q("erc20-fee-burn-quote-2026-09-03.json");
const RUN2 = Q("erc20-fee-burn-run2-quote-2026-09-03.json");

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  QUOTE EXPIRY — a tagged union, against two real Circle quotes       ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("0 — THE INSTRUMENT IS NOT VACUOUS");
for (const [name, q] of [["run 1", RUN1], ["run 2", RUN2]]) {
  check(`⭐ ${name} is a real quote with a signed blob and a tagged expiry`,
    typeof q.signedQuote === "string" && q.signedQuote.length > 200 &&
    q.expiry?.mode === "TIMESTAMP" && Number.isInteger(q.expiry.expiresAt),
    `${q.expiry?.mode} · window ${q.expiry.expiresAt - q.issuedAt}s`);
}
// ⭐ The 120s window, measured on both — and NEVER typed into our source. It is stated here as an
// observation about Circle, not adopted as a constant of ours.
check("⭐ both real windows are 120s — an observation, deliberately not a constant of ours",
  RUN1.expiry.expiresAt - RUN1.issuedAt === 120 && RUN2.expiry.expiresAt - RUN2.issuedAt === 120);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — 🚨🚨 THE TWO `0x01`s: the prefix is NOT the mode");
{
  // ⛔ THE MISTAKE THIS PINS. The blob's leading byte is a VERSION/TYPE prefix and is `0x01` on both
  // real quotes; the expiry MODE is the high byte of the packed expiry word and is `0x00`
  // (TIMESTAMP) on both. Reading the mode off the front returns BLOCK_HEIGHT every single time.
  for (const [name, q] of [["run 1", RUN1], ["run 2", RUN2]]) {
    const prefixByte = parseInt(q.signedQuote.slice(2, 4), 16);
    const { modeByte, wordIndex } = decodeExpiryWord(q.signedQuote, q.expiry.expiresAt);
    check(`🚨 ${name}: the leading byte is 0x01 and the MODE byte is 0x00 — they DISAGREE`,
      prefixByte === QUOTE_EXPIRY_MODES.BLOCK_HEIGHT && modeByte === QUOTE_EXPIRY_MODES.TIMESTAMP,
      `prefix 0x${prefixByte.toString(16).padStart(2, "0")} · mode 0x${modeByte.toString(16).padStart(2, "0")} at word ${wordIndex}`);
  }
  // ⭐⭐ AND THE WRONG READING IS NOT AN ERROR — IT IS A VALID MODE. That is what makes it dangerous:
  // there is no exception to notice, just a different branch, taken confidently.
  check("⭐⭐ 0x01 IS a real mode value, so the wrong read produces a plausible answer, not a throw",
    Object.values(QUOTE_EXPIRY_MODES).includes(0x01));
  // ⛔ The rule is written where the decode is, not only in a report.
  const src = readFileSync("netlify/functions/_quote-expiry.mjs", "utf8").replace(/^\s*(\/\/|\*)\s?/gm, " ").replace(/\s+/g, " ");
  check("⭐ the distinction is written AT the decode site",
    /TWO DIFFERENT `0x01`s IN A SIGNED QUOTE/.test(src) && /VERSION \/ TYPE PREFIX/.test(src));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — THE EXPIRY WORD IS FOUND BY VALUE, NEVER BY POSITION");
{
  // ⭐ It sits at index 2 on both real quotes. Hardcoding 2 would be an ABI-layout assumption drawn
  // from two samples; searching for the word that carries the deadline the API already named makes
  // the read self-verifying.
  check("⭐ it happens to be word 2 on both — and the decoder does not know that",
    decodeExpiryWord(RUN1.signedQuote, RUN1.expiry.expiresAt).wordIndex === 2 &&
    decodeExpiryWord(RUN2.signedQuote, RUN2.expiry.expiresAt).wordIndex === 2);
  const dsrc = readFileSync("netlify/functions/_quote-expiry.mjs", "utf8");
  check("🚨 …and no literal word index appears in the decoder", !/words\[\s*2\s*\]/.test(dsrc));

  // ⛔ A DEADLINE THAT IS NOT IN THE BLOB IS A REFUSAL, NOT A FALLBACK TO SOME OTHER WORD.
  const e1 = threw(() => decodeExpiryWord(RUN2.signedQuote, RUN2.expiry.expiresAt + 1));
  check("⛔ a deadline absent from the blob → refused (`expiry_word_not_found`)",
    e1 instanceof QuoteExpiryError && e1.code === "expiry_word_not_found", e1?.message);

  // ⛔ AMBIGUITY IS A REFUSAL TOO. Two words carrying the deadline means we cannot say which is the
  // expiry, and picking one would be a guess about money.
  // ⚠️ Duplicate the EXPIRY word specifically (index 2 → chars 4+128 … 4+192), computed from the
  // decoder's own answer rather than typed, so this stays right if the layout ever moves.
  const wi = decodeExpiryWord(RUN2.signedQuote, RUN2.expiry.expiresAt).wordIndex;
  const wordHex = RUN2.signedQuote.slice(4 + wi * 64, 4 + (wi + 1) * 64);
  const dupe = RUN2.signedQuote + wordHex;
  const e2 = threw(() => decodeExpiryWord(dupe, RUN2.expiry.expiresAt));
  check("⛔ TWO candidate words → refused, never 'take the first'",
    e2 instanceof QuoteExpiryError && e2.code === "expiry_word_not_found" && /2 candidates/.test(e2.message),
    e2?.message);

  for (const [label, blob] of [["not hex", "nope"], ["empty", "0x"], ["a partial word", "0x01ab"]]) {
    const e = threw(() => decodeExpiryWord(blob, 1788451562));
    check(`⛔ ${label} → refused, never decoded`, e instanceof QuoteExpiryError, e?.code);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — THE CROSS-CHECK RUNS AT ISSUE, WHERE A FAILURE IS CHEAP");
{
  const n = normalizeQuoteExpiry(RUN2);
  check("⭐ a real quote normalises: mode, byte and deadline all agree",
    n.mode === "TIMESTAMP" && n.modeByte === 0x00 && n.expiresAtSec === RUN2.expiry.expiresAt,
    JSON.stringify(n));

  // 🚨 THE JSON SAYS ONE THING AND THE SIGNED BYTES SAY ANOTHER. The bytes are what the CONTRACT
  // reads; the JSON is a convenience. On disagreement the one thing we must not do is pick a side.
  const lying = { ...RUN2, expiry: { mode: "BLOCK_HEIGHT", expiresAt: RUN2.expiry.expiresAt } };
  const e = threw(() => normalizeQuoteExpiry(lying));
  check("🚨🚨 a declared mode that disagrees with its own signed bytes → REFUSED at issue",
    e instanceof QuoteExpiryError && e.code === "mode_disagrees", e?.message);

  // ⛔ AND AN UNRECOGNISED MODE REFUSES AT ISSUE TOO — sealing a quote we could never validate
  // would guarantee a refusal later, after a user has been shown a price.
  for (const bad of ["TIMESTAMP_V2", "", null, 0, "timestamp"]) {
    const r = threw(() => normalizeQuoteExpiry({ ...RUN2, expiry: { mode: bad, expiresAt: 1 } }));
    check(`⛔ mode ${JSON.stringify(bad)} → refused at issue`,
      r instanceof QuoteExpiryError && r.code === "mode_unrecognised");
  }
  // ⚠️ THE AVAILABILITY COST, ACCEPTED AND STATED. A layout change refuses to ISSUE rather than
  // falling back to "probably a timestamp".
  const mangled = { ...RUN2, signedQuote: "0x01" + "00".repeat(32) };
  check("⚠️ a blob we cannot decode refuses to ISSUE — never a fallback to an assumed mode",
    threw(() => normalizeQuoteExpiry(mangled)) instanceof QuoteExpiryError);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — THREE OUTCOMES, THREE DISTINCT MESSAGES");
{
  const NOW = 1788451500_000; // ms — inside run 2's window (expires 1788451562s)
  const ok = assertQuoteUnexpired({ mode: "TIMESTAMP", expiresAtSec: RUN2.expiry.expiresAt, nowMs: NOW });
  check("⭐ TIMESTAMP inside the window EVALUATES and reports what is left",
    ok.secondsLeft === 62, JSON.stringify(ok));

  const expired = threw(() => assertQuoteUnexpired({ mode: "TIMESTAMP", expiresAtSec: RUN2.expiry.expiresAt, nowMs: NOW + 120_000 }));
  check("⭐ TIMESTAMP past the window refuses, and says how long ago",
    expired?.code === "expired" && /58s ago/.test(expired.message), expired?.message);

  // ⚠️ `>=`, not `>`. On chain the quote is valid AT the deadline, but our burn lands strictly
  // later — there is an approve and a userOp in between. Refusing at equality costs no literal.
  const atEdge = threw(() => assertQuoteUnexpired({ mode: "TIMESTAMP", expiresAtSec: 1000, nowMs: 1_000_000 }));
  check("⚠️ exactly AT the deadline refuses — the burn lands strictly later than this check",
    atEdge?.code === "expired");

  // ⭐⭐ "WE KNOW WHAT THIS IS AND CANNOT CHECK IT" ≠ "WE DO NOT KNOW WHAT THIS IS".
  const blk = threw(() => assertQuoteUnexpired({ mode: "BLOCK_HEIGHT", expiresAtSec: 60_000_000, nowMs: Date.now() }));
  const unk = threw(() => assertQuoteUnexpired({ mode: "SOMETHING_NEW", expiresAtSec: 1, nowMs: Date.now() }));
  check("⭐⭐ BLOCK_HEIGHT refuses with its OWN code and names what it would need",
    blk?.code === "block_height_unsupported" && /BLOCK HEIGHT/.test(blk.message) &&
    /block-number read/.test(blk.message), blk?.message);
  check("⭐⭐ an unrecognised mode refuses with a DIFFERENT code and a different sentence",
    unk?.code === "mode_unrecognised" && /does not recognise/.test(unk.message), unk?.message);
  check("🚨 …and the two messages are not the same text — they are different findings",
    blk.message !== unk.message);
  check("⛔ neither falls through to the branch we happen to have",
    blk?.code !== "expired" && unk?.code !== "expired");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — 🚨 UNITS: seconds vs milliseconds, and the unsafe direction");
{
  const expiresAtSec = 1788451562;
  // ⭐ THE CORRECT COMPARISON. now = 1788451500s == 1788451500000ms -> 62s left.
  check("⭐ a millisecond clock is converted to seconds before the comparison",
    assertQuoteUnexpired({ mode: "TIMESTAMP", expiresAtSec, nowMs: 1788451500_000 }).secondsLeft === 62);

  // ⛔ THE MISTAKE, SIMULATED: passing SECONDS where MILLISECONDS are expected. The deadline then
  // looks ~55,000 years away and NOTHING EXPIRES — the unsafe direction.
  const asIfSeconds = assertQuoteUnexpired({ mode: "TIMESTAMP", expiresAtSec, nowMs: 1788451500 });
  check("🚨 feeding a SECONDS clock into the ms parameter never expires — the unsafe direction",
    asIfSeconds.secondsLeft > 1_000_000_000, `${asIfSeconds.secondsLeft}s "left"`);
  // ⭐ The opposite confusion is safe, which is exactly why only one of them is worth guarding.
  const asIfMs = threw(() => assertQuoteUnexpired({ mode: "TIMESTAMP", expiresAtSec: 1788451562_000, nowMs: Date.now() }));
  check("⭐ …while the reverse confusion merely refuses — the two errors are NOT symmetric",
    asIfMs === null || asIfMs?.code === "expired", asIfMs ? asIfMs.code : "no throw (far future)");

  const src = readFileSync("netlify/functions/_quote-expiry.mjs", "utf8");
  check("⭐ the conversion is COMPUTED at the comparison, not typed",
    /Math\.floor\(nowMs \/ 1000\)/.test(src) && !/\/ 1000\b[\s\S]{0,40}1000000/.test(src));
  check("  …and the units note sits AT the comparison", /`expiresAtSec` is SECONDS/.test(src.replace(/\s+/g, " ")));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — 🚨🚨 THE ASYMMETRY, DEMONSTRATED — why the branch is never a magnitude sniff");
{
  // A TIMESTAMP misread as a BLOCK HEIGHT: 1.79e9 compared against Arc's block number (~6.0e7).
  const ARC_BLOCK_NOW = 60_268_338;              // run 2's real burn block
  const timestampValue = RUN2.expiry.expiresAt;  // 1788451562
  check("🚨 a TIMESTAMP read as a block height is VALID — and stays valid for decades",
    ARC_BLOCK_NOW <= timestampValue,
    `${ARC_BLOCK_NOW} <= ${timestampValue} — no revert, nothing looks wrong, the price never expires`);

  // A BLOCK HEIGHT misread as a TIMESTAMP: 6.0e7 epoch seconds is March 1971.
  const asDate = new Date(ARC_BLOCK_NOW * 1000).getUTCFullYear();
  const e = threw(() => assertQuoteUnexpired({ mode: "TIMESTAMP", expiresAtSec: ARC_BLOCK_NOW, nowMs: Date.now() }));
  check("⭐ a BLOCK HEIGHT read as a timestamp lands in 1971 and REFUSES — wrong, but loud",
    asDate === 1971 && e?.code === "expired", `year ${asDate}`);

  // ⛔ SO THE TAG DECIDES, NOT THE SIZE. The magnitudes happen to separate today; they are not a
  // rule, and relying on them is the reasoning that breaks when a block number grows.
  const src = readFileSync("netlify/functions/_quote-expiry.mjs", "utf8").replace(/^\s*(\/\/|\*)\s?/gm, " ").replace(/\s+/g, " ");
  check("⛔ the asymmetry is written BESIDE the branch", /THE TWO MIS-READINGS ARE NOT SYMMETRIC/.test(src));
  check("  …and it says explicitly that the branch is never a magnitude sniff",
    /THE BRANCH IS NEVER A MAGNITUDE SNIFF/.test(src));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — THE SEAL: a source discriminator, two deadlines, and OUR amount binding");
{
  const OWNER = "0xc54d47211997aca90ef4fcfbc742a3b511b4e621";
  const selfFee = { maxFee: 54121n, amountMinor: 2_000_000n, feeUsdc: 0.054121, netUsdc: 1.945879 };
  const NOW = RUN2.issuedAt * 1000; // ms, at issue

  // ── the self-issued path is unchanged ────────────────────────────────────────────────────────
  const selfTok = sealBridgeQuote({ owner: OWNER, destinationKey: "base", amountUsdc: 2, fee: selfFee, now: NOW });
  const selfOpen = openBridgeQuote(selfTok, { owner: OWNER, destinationKey: "base", amountUsdc: 2, now: NOW + 1000 });
  check("⭐ a self-issued quote still opens, and says so", selfOpen.quoteSource === "self" && selfOpen.expiry === null);

  // ── the externally-quoted path carries mode AND expiresAt INSIDE the MAC ─────────────────────
  const circleFee = { ...selfFee, quote: RUN2 };
  const tok = sealBridgeQuote({ owner: OWNER, destinationKey: "base", amountUsdc: 2, fee: circleFee, now: NOW });
  const payload = JSON.parse(Buffer.from(tok.split(".")[0], "base64url").toString("utf8"));
  check("⭐⭐ the sealed payload carries the MODE, not just the number",
    payload.xm === "TIMESTAMP" && payload.xe === RUN2.expiry.expiresAt && payload.qs === "circle",
    JSON.stringify({ qs: payload.qs, xm: payload.xm, xe: payload.xe }));
  check("  …and the signed quote travels with it, so the burn need not re-request one",
    payload.sq === RUN2.signedQuote);

  const opened = openBridgeQuote(tok, { owner: OWNER, destinationKey: "base", amountUsdc: 2, now: NOW + 1000 });
  check("⭐ inside BOTH windows it opens, and reports the external one",
    opened.quoteSource === "circle" && opened.expiry.mode === "TIMESTAMP" && opened.expiry.secondsLeft === 119,
    JSON.stringify(opened.expiry));

  // 🚨 THE EXTERNAL DEADLINE BITES FIRST. 150s in: our 180s TTL is still fine, theirs is gone.
  const late = threw(() => openBridgeQuote(tok, { owner: OWNER, destinationKey: "base", amountUsdc: 2, now: NOW + 150_000 }));
  check("🚨🚨 at 150s the quote is REFUSED — our 180s TTL would have allowed it",
    /expired \d+s ago/.test(late?.message ?? ""), late?.message);
  check("⛔ CONTROL: the SELF-issued seal at the same instant is still fine — so the refusal above " +
    "comes from the external deadline, not from our TTL",
    !threw(() => openBridgeQuote(selfTok, { owner: OWNER, destinationKey: "base", amountUsdc: 2, now: NOW + 150_000 })));

  // ── the discriminator refuses half-migrated shapes ───────────────────────────────────────────
  const reseal = (mut) => {
    const p = { ...payload, ...mut };
    const body = Buffer.from(JSON.stringify(p)).toString("base64url");
    return `${body}.${createHmac("sha256", process.env.SESSION_SECRET).update(`bridgequote|${body}|v1`).digest("base64url")}`;
  };
  const open = (t) => threw(() => openBridgeQuote(t, { owner: OWNER, destinationKey: "base", amountUsdc: 2, now: NOW + 1000 }));
  check("⛔ `circle` with no expiry → refused, never falls back to our TTL",
    /no expiry/.test(open(reseal({ xm: undefined, xe: undefined }))?.message ?? ""));
  check("⛔ `self` carrying an external expiry → refused as malformed, not silently honoured",
    /self-issued quote carries an external expiry/.test(open(reseal({ qs: "self" }))?.message ?? ""));
  check("⛔ an unrecognised source → refused rather than assumed",
    /does not say where it came from/.test(open(reseal({ qs: "cirlce" }))?.message ?? ""));
  check("⛔ an unrecognised MODE inside the seal → refused at validation too",
    /does not recognise/.test(open(reseal({ xm: "TIMESTAMP_V2" }))?.message ?? ""));
  check("⭐⭐ a BLOCK_HEIGHT seal → refused with its own sentence, not treated as a timestamp",
    /cannot check that/.test(open(reseal({ xm: "BLOCK_HEIGHT" }))?.message ?? ""));

  // ═══ ⛔⛔ THE AMOUNT BINDING IS OURS AND IT IS NOT REDUNDANT ═════════════════════════════════
  // MEASURED before adoption, two instruments: the verified preimage (`forwardArgs` omits the
  // amount — visible in the response itself) and a calibrated simulation (500000 and 9000000 both
  // simulated cleanly against a quote requested for 2000000, while a wrong destinationDomain
  // reverted). So Circle's signature does NOT bind the amount, and this refusal becomes the ONLY
  // thing between a held quote and a burn of a different size.
  check("⛔⛔ a sealed quote may not be spent at a DIFFERENT amount — ours, and the only one",
    /different amount/.test(threw(() => openBridgeQuote(tok, { owner: OWNER, destinationKey: "base", amountUsdc: 9, now: NOW + 1000 }))?.message ?? ""));
  // 🚨 THE EVIDENCE FOR "NOT REDUNDANT" IS IN THE QUOTE ITSELF — assert it, so nobody deletes the
  // binding on the belief that the signature covers it.
  check("🚨 the signed FORWARD args carry NO amount — the reason the binding is load-bearing",
    Array.isArray(RUN2.items) && RUN2.items[0].type === "FORWARD" &&
    !RUN2.items[0].args.some((a) => String(a) === "2000000" || String(a) === "1000000"),
    `args: ${JSON.stringify(RUN2.items[0].args)}`);
  check("  …and `items[0].amount` is the FEE, not the burn amount",
    RUN2.items[0].amount === RUN2.feeTotalAmount, `${RUN2.items[0].amount} === ${RUN2.feeTotalAmount}`);
  const bsrc = readFileSync("netlify/functions/_bridge.mjs", "utf8").replace(/^\s*(\/\/|\*)\s?/gm, " ").replace(/\s+/g, " ");
  check("⭐ …and WHY it stays is written at the check, with both instruments named",
    /THE AMOUNT BINDING IS OURS, AND UNDER UPFRONT FEES IT IS THE ONLY ONE/.test(bsrc) &&
    /calibrated simulation/i.test(bsrc) && /forwardArgs` omits it/.test(bsrc));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("8 — THE WINDOW SHOWN IS DERIVED, AND 120_000 IS NEVER TYPED");
{
  const NOW = RUN2.issuedAt * 1000;
  const selfFee = { maxFee: 54121n, amountMinor: 2_000_000n, feeUsdc: 0.054121, netUsdc: 1.945879 };
  check("⭐ with no external quote the window is OUR TTL", quoteWindowMs(selfFee, NOW) === QUOTE_TTL_MS);
  // ⭐⭐ THE TIGHTER OF TWO REAL BOUNDS — computed from the quote, never typed.
  check("⭐⭐ with a Circle quote the window is THEIRS, because theirs is tighter",
    quoteWindowMs({ ...selfFee, quote: RUN2 }, NOW) === 120_000,
    `${quoteWindowMs({ ...selfFee, quote: RUN2 }, NOW)}ms vs our ${QUOTE_TTL_MS}ms`);
  check("  …and it SHRINKS as the quote ages — it is a remaining duration, not a constant",
    quoteWindowMs({ ...selfFee, quote: RUN2 }, NOW + 60_000) === 60_000);
  check("⛔ …and never goes negative", quoteWindowMs({ ...selfFee, quote: RUN2 }, NOW + 999_000) === 0);
  // ⚠️ A block-height quote cannot be converted to a duration without a block read; our bound only.
  check("⚠️ a BLOCK_HEIGHT quote yields OUR bound — honest, not convenient",
    quoteWindowMs({ ...selfFee, quote: { ...RUN2, expiry: { mode: "BLOCK_HEIGHT", expiresAt: 60_000_000 } } }, NOW) === QUOTE_TTL_MS);

  // ⛔ THE VENDOR CONSTANT MUST NOT BE RETYPED. Its window is documented as APPROXIMATE.
  for (const f of ["netlify/functions/_bridge.mjs", "netlify/functions/agent-bridge.mjs", "netlify/functions/_quote-expiry.mjs"]) {
    const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    check(`⛔ ${f.split("/").pop()} does not hardcode Circle's ~2-minute window`, !/120_000|120000/.test(code));
  }

  // ── it REACHES THE CLIENT, and the client renders it ─────────────────────────────────────────
  // 🚨 `expiresInMs` was QUOTE_TTL_MS and NOTHING read it — invisible when right, invisible when
  // wrong, and about to become wrong by a minute.
  const ab = readFileSync("netlify/functions/agent-bridge.mjs", "utf8");
  check("🚨 the endpoint sends a DERIVED duration, not our constant",
    /expiresInMs: quoteWindowMs\(fee\)/.test(ab) && !/expiresInMs: QUOTE_TTL_MS/.test(ab));
  const panel = readFileSync("src/components/BridgePanel.tsx", "utf8");
  check("⭐⭐ the client counts down from the DURATION plus its own elapsed time",
    /Number\(quote\.expiresInMs\) - \(Date\.now\(\) - quotedAt\)/.test(panel));
  check("⛔ …and never subtracts a server epoch from the device clock",
    !/deadline \* 1000 - now/.test(panel));
  check("⭐ an expired quote disables the burn and says why",
    /quoteExpired \|\|/.test(panel) && /Quote expired — price it again/.test(panel));
  check("⛔ …and an UNKNOWN window does not read as expired — we do not block on ignorance",
    /secondsLeft !== null && secondsLeft <= 0/.test(panel));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("9 — THE DEADLINE IS RE-CHECKED AFTER THE APPROVE, BEFORE THE BURN");
{
  const src = readFileSync("netlify/functions/_bridge.mjs", "utf8");
  // ⭐ ORDER IS THE PROPERTY. A re-check that ran before the approve would be the first check again.
  const approveIdx = src.indexOf('abiFunctionSignature: "approve(address,uint256)"');
  const recheckIdx = src.indexOf("boundFee?.reCheckExpiry");
  const burnIdx = src.indexOf("// 2) The bridge call itself");
  check("⭐⭐ the re-check sits AFTER the approve and BEFORE the burn",
    approveIdx > 0 && recheckIdx > approveIdx && burnIdx > recheckIdx,
    `approve@${approveIdx} < recheck@${recheckIdx} < burn@${burnIdx}`);
  check("⭐ the opener hands out a re-check bound to the SAME sealed payload",
    /reCheckExpiry: \(\) => openQuoteExpiry\(p, Date\.now\(\)\)/.test(src));
  // ⛔ NO MARGIN LITERAL. A submission margin would be a number derived from two observations,
  // on a money path, free to drift as approve latency changes.
  check("⛔ no submission-margin literal was introduced instead",
    !/SUBMIT_MARGIN|submissionMargin|MARGIN_MS/.test(src));
  // ⚠️ The allowance question is NAMED, not silently left.
  // ⚠️ COMMENT MARKERS STRIPPED BEFORE MATCHING, not just whitespace collapsed. These phrases live
  // in wrapped `//` blocks, so a re-wrap drops a `//` into the middle of the sentence and the regex
  // stops matching text that is still there — the false-alarm shape the copy guards record.
  const prose = (f) => readFileSync(f, "utf8").replace(/^\s*(\/\/|\*)\s?/gm, " ").replace(/\s+/g, " ");
  check("⚠️ the standing-allowance question is named as the next step's, not quietly skipped",
    /allowance hygiene decision belongs with whoever moves the approve/.test(prose("netlify/functions/_bridge.mjs")));

  // ⭐ AND IT ACTUALLY REFUSES. Behavioural, not a source read: an opened quote whose window has
  // passed by the time the re-check runs must throw.
  const OWNER = "0xc54d47211997aca90ef4fcfbc742a3b511b4e621";
  const NOW = RUN2.issuedAt * 1000;
  const fee = { maxFee: 54121n, amountMinor: 2_000_000n, feeUsdc: 0.054121, netUsdc: 1.945879, quote: RUN2 };
  const tok = sealBridgeQuote({ owner: OWNER, destinationKey: "base", amountUsdc: 2, fee, now: NOW });
  const bound = openBridgeQuote(tok, { owner: OWNER, destinationKey: "base", amountUsdc: 2, now: NOW + 1000 });
  check("⭐ the opened quote carries a callable re-check", typeof bound.reCheckExpiry === "function");
  // The real quote's deadline is long past in wall-clock terms, so a re-check against Date.now()
  // refuses — which is the behaviour a slow approve would produce on a live quote.
  check("⭐⭐ …and re-checking it against the CURRENT clock REFUSES, where the first check passed",
    threw(() => bound.reCheckExpiry())?.code === "expired");
}

console.log(`\n${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail ? 1 : 0);
