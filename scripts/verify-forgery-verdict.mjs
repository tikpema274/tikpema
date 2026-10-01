// verify-forgery-verdict.mjs — the decisions gate:forgery makes, called directly (scripts/lib/forgery-verdict.mjs).
//
// ⭐ WHY (2026-10-01): deploy 6abe1aca's gate:forgery went red because the Base fee (~0.0649) rose above the FIXED
// 0.06 probe, and the log said only "step 1 did not yield a sealed acknowledge-band quote". Whether the acknowledge
// gate was BROKEN or merely NOT EXAMINED had to be re-derived by hand. This suite pins: the amount is derived from
// the live fee; today's exact refusal reads UNTESTED (red, exit 3) not FAIL (exit 1) and never PASS; the spend guard
// still refuses to send step 2 below the acknowledge band.

import { readFileSync } from "node:fs";
import { TARGET_RATIO, BAND_ACKNOWLEDGE, MAX_PROBE_USDC, EXIT, probeAmountFromFee, readReferenceFee, step1Reached,
  step2Verdict, verdictLine } from "./lib/forgery-verdict.mjs";

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 70 - t.length))}`);

section("1 — the probe amount comes from the LIVE fee");
const today = probeAmountFromFee(0.0649);
ok("⭐⭐ today's fee 0.0649 → a probe inside the band (the fixed 0.06 was refused by the floor)",
  today.ok && today.amountUsdc > 0.0649 && today.ratio >= BAND_ACKNOWLEDGE && today.ratio < 1, JSON.stringify(today));
ok("…at ~60%, rounded UP (the ratio may only fall toward 60%, never rise past it)", today.ok && today.ratio <= TARGET_RATIO && today.ratio > 0.59, String(today.ratio));
const last = probeAmountFromFee(0.054251);
ok("last night's fee 0.054251 → also inside the band", last.ok && last.ratio >= BAND_ACKNOWLEDGE && last.ratio < 1, JSON.stringify(last));
ok("🚨 a fee that needs more than the ceiling is REFUSED, never a bigger probe", probeAmountFromFee(0.2).ok === false && /ceiling/.test(probeAmountFromFee(0.2).why), probeAmountFromFee(0.2).why);
ok("…the ceiling itself is small (it is what a BROKEN gate would spend)", MAX_PROBE_USDC <= 0.25, String(MAX_PROBE_USDC));
for (const bad of [0, -1, NaN, null, undefined, "x"]) ok(`no usable fee (${String(bad)}) → not ok`, probeAmountFromFee(bad).ok === false);

section("2 — the band threshold is the server's, not a second copy that can drift");
const bridgeSrc = readFileSync(new URL("../netlify/functions/_bridge.mjs", import.meta.url), "utf8");
const served = Number(bridgeSrc.match(/export const FEE_BAND_ACKNOWLEDGE = ([0-9.]+)/)?.[1]);
ok("⭐ BAND_ACKNOWLEDGE equals _bridge.mjs FEE_BAND_ACKNOWLEDGE", served === BAND_ACKNOWLEDGE, `${served} vs ${BAND_ACKNOWLEDGE}`);

section("3 — 🚨 TODAY'S EXACT REFUSAL is UNTESTED: red, not FAIL, never PASS");
const TODAY = { executed: false, blocked: "step 1: the fee to Base (Sepolia) is ~0.0649 USDC — as much as or more than the 0.06 USDC being moved. Nothing was executed." };
const s1 = step1Reached(200, TODAY);
ok("⭐⭐ the fee-floor body → not reached, verdict UNTESTED", s1.reached === false && s1.verdict === "UNTESTED", JSON.stringify(s1));
ok("⭐ …and the reason QUOTES the server's refusal (the old log printed `requoted=undefined`)", s1.why.includes("~0.0649 USDC"), s1.why);
ok("the same body as the reference quote → UNTESTED too", readReferenceFee(200, TODAY).verdict === "UNTESTED");
ok("⭐⭐ UNTESTED is RED: a non-zero exit, distinct from FAIL's", EXIT.UNTESTED !== 0 && EXIT.UNTESTED !== EXIT.FAIL && EXIT.FAIL !== 0 && EXIT.PASS === 0, JSON.stringify(EXIT));
ok("⭐ the log line names the verdict and is greppable", verdictLine("UNTESTED", "why") === "gate:forgery VERDICT=UNTESTED — why");

section("4 — 🚨 THE SPEND GUARD: step 2 is sent ONLY on a sealed acknowledge-band quote");
const sealed = (band) => ({ executed: false, requoted: true, stepDisclosures: [{ band, quoteToken: "seal", ackToken: "srv" }] });
ok("⭐ sealed + acknowledge → reached", step1Reached(200, sealed("acknowledge")).reached === true);
ok("🚨🚨 sealed + WARN → NOT reached (a valid seal below the band would EXECUTE)", step1Reached(200, sealed("warn")).reached === false);
ok("🚨🚨 sealed + none → NOT reached", step1Reached(200, sealed("none")).reached === false);
ok("acknowledge but NO seal → NOT reached", step1Reached(200, { executed: false, requoted: true, stepDisclosures: [{ band: "acknowledge" }] }).reached === false);
ok("🚨 step 1 reporting executed=true → FAIL, not UNTESTED", step1Reached(200, { executed: true }).verdict === "FAIL");
ok("🚨 step 1 with executed MISSING (e.g. a non-JSON body) → FAIL, never assumed false", step1Reached(200, { _nonJson: "<html>" }).verdict === "FAIL");

section("5 — step 2: the property, or why it was not examined");
const forged = "f".repeat(64);
const v = (b) => step2Verdict(200, b, { forged, disclosure: { ackToken: "served-token-abc" } });
ok("⭐⭐ needsAck + a served token ≠ forged → PASS", v({ executed: false, needsAck: true }).verdict === "PASS");
ok("🚨🚨 executed=true → FAIL (CRITICAL)", v({ executed: true }).verdict === "FAIL" && /CRITICAL/.test(v({ executed: true }).why));
ok("🚨 served token EQUALS the forged one → FAIL", step2Verdict(200, { executed: false, needsAck: true }, { forged, disclosure: { ackToken: forged } }).verdict === "FAIL");
ok("🚨 needsAck but NO served token → FAIL", step2Verdict(200, { executed: false, needsAck: true }, { forged, disclosure: {} }).verdict === "FAIL");
ok("⭐ refused before the comparison (a cap) → UNTESTED, quoting it", v({ executed: false, blocked: "per-transaction cap" }).verdict === "UNTESTED" && /cap/.test(v({ executed: false, blocked: "per-transaction cap" }).why));
ok("🚨 neither needsAck nor a reason → FAIL (unexplained is never UNTESTED)", v({ executed: false }).verdict === "FAIL");

section("6 — the gate USES these decisions (no second copy)");
const gate = readFileSync(new URL("./verify-ack-forgery.mjs", import.meta.url), "utf8");
for (const fn of ["probeAmountFromFee", "readReferenceFee", "step1Reached", "step2Verdict", "verdictLine"]) ok(`gate calls ${fn}`, new RegExp(`\\b${fn}\\(`).test(gate));
ok("⭐ no fixed probe amount remains", !/PROBE_AMOUNT|\b0\.06\)/.test(gate));
ok("⭐ the missing-secret exit also prints a verdict line", /verdictLine\("UNTESTED", "SESSION_SECRET/.test(gate));

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-forgery-verdict — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
