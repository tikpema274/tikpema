// verify-ack-token-keyed.mjs — the acknowledge token is KEYED, and the receipt stores only a hash.
//
// ═══ ⭐⭐ THE TWO PROPERTIES, AND WHY THEY ARE ONE CHANGE ════════════════════════════════════════
// 1. The token is an HMAC over a server key, so it can only originate from a disclosure THIS server
//    issued. Before v3 it was `sha256(<public string>)` — recomputable by any caller from the plan it
//    was already proposing — so the gate's refusal stopped a client that had not bothered, not one
//    intending to bypass.
// 2. The receipt stores a HASH of the token, never the token. A permanent record is the worst place
//    for a bearer credential.
//
// ⚠️ NEITHER IS WORTH DOING ALONE. Hashing a publicly-derivable value removes no capability and
// preserves no evidence; keying without hashing puts a real credential in a permanent record. The
// suite therefore asserts both, and asserts the LINK: the stored value must verify AGAINST the token
// while not BEING the token.
//
//   node scripts/verify-ack-token-keyed.mjs

import { createHash, createHmac } from "node:crypto";

process.env.SESSION_SECRET ||= "test-session-secret-0123456789abcdef";
const { bridgeAckToken } = await import("../netlify/functions/_bridge.mjs");
// ⭐ The fingerprint lives with the RECEIPT FORMAT, not with minting — see the pointer in _bridge.mjs.
const { ackTokenFingerprint } = await import("../netlify/functions/_bridge-receipts.mjs");

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ──────────────────────────────────────`);

const ARGS = { owner: "0x" + "ab".repeat(20), destinationKey: "base", amountUsdc: 0.1, band: "acknowledge" };

console.log("\nverify-ack-token-keyed — the refusal is an authentication, not arithmetic\n");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — 🚨 THE TOKEN IS NOT DERIVABLE FROM PUBLIC INPUTS");
{
  const tok = bridgeAckToken(ARGS);
  // The exact v2 construction, recomputed here. This is what an outside caller could do BEFORE v3 —
  // and it reproduced the real stored token exactly on 2026-08-17.
  const v2 = createHash("sha256")
    .update(`bridge|${ARGS.owner.toLowerCase()}|base|0.1|band:acknowledge|v2`).digest("hex");
  check("🚨🚨 the old public-input recomputation NO LONGER produces the token", tok !== v2);
  // …and neither does the same string under v3 without the key.
  const unkeyed = createHash("sha256")
    .update(`bridge|${ARGS.owner.toLowerCase()}|base|0.1|band:acknowledge|v3`).digest("hex");
  check("🚨 …nor does an unkeyed digest of the v3 string — the KEY is what makes it unforgeable", tok !== unkeyed);
  check("⭐ it IS the keyed HMAC (recomputable only WITH the secret)",
    tok === createHmac("sha256", process.env.SESSION_SECRET)
      .update(`bridge|${ARGS.owner.toLowerCase()}|base|0.1|band:acknowledge|v3`).digest("hex"));
  check("  …still 64 hex, so nothing downstream that assumes the shape breaks", /^[0-9a-f]{64}$/.test(tok));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — the key actually participates, and the binding still holds");
{
  const base = bridgeAckToken(ARGS);
  const prev = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "a-different-secret-0123456789abcdef";
  check("⭐⭐ a DIFFERENT key yields a different token — the secret is load-bearing, not decorative",
    bridgeAckToken(ARGS) !== base);
  process.env.SESSION_SECRET = prev;
  check("  …and restoring the key restores the token (deterministic, not random)", bridgeAckToken(ARGS) === base);

  // The v2 bindings must survive the change — they were the reason for v2 in the first place.
  check("⚠️ still bound to OWNER", bridgeAckToken({ ...ARGS, owner: "0x" + "cd".repeat(20) }) !== base);
  check("⚠️ still bound to AMOUNT", bridgeAckToken({ ...ARGS, amountUsdc: 0.2 }) !== base);
  check("⚠️ still bound to DESTINATION", bridgeAckToken({ ...ARGS, destinationKey: "arbitrum" }) !== base);
  check("⚠️ still bound to BAND", bridgeAckToken({ ...ARGS, band: "warn" }) !== base);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — 🚨 FAIL-CLOSED: a missing key must never degrade to a weak token");
{
  const prev = process.env.SESSION_SECRET;
  for (const [label, val] of [["unset", undefined], ["empty", ""], ["too short", "short"]]) {
    if (val === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = val;
    let threw = false;
    try { bridgeAckToken(ARGS); } catch { threw = true; }
    check(`🚨 a ${label} SESSION_SECRET THROWS rather than minting an unkeyed token`, threw);
  }
  process.env.SESSION_SECRET = prev;
  // ⭐ The alternative — falling back to an unkeyed digest — would silently restore the exact property
  // being removed, and every caller would keep working. That is the absence-reads-as-safe family.
  check("⭐ …and the module never falls back to createHash for the token",
    !/return createHash\("sha256"\)\.update\(digest\)/.test(
      await import("node:fs").then((fs) => fs.readFileSync("netlify/functions/_bridge.mjs", "utf8"))));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⭐⭐ THE RECEIPT STORES A FINGERPRINT, NOT THE TOKEN");
{
  const tok = bridgeAckToken(ARGS);
  const fp = ackTokenFingerprint(tok);
  check("🚨🚨 the stored value is NOT the token", fp !== tok);
  check("⭐⭐ …but it VERIFIES against the token — evidence survives", fp === createHash("sha256").update(tok).digest("hex"));
  check("⭐ …and the token cannot be read back out of it (different value, same length)",
    /^[0-9a-f]{64}$/.test(fp) && fp !== tok);
  check("⚠️ null stays null — 'no acknowledgment required' must not become a hash of nothing",
    ackTokenFingerprint(null) === null && ackTokenFingerprint("") === null && ackTokenFingerprint(undefined) === null);

  // 🚨 THE WHOLE POINT, ASSERTED AGAINST THE WRITER: a raw token must not reach the durable record.
  const src = await import("node:fs").then((fs) => fs.readFileSync("netlify/functions/_bridge-record.mjs", "utf8"));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("🚨🚨 the record writer stores NO raw ackToken field",
    !/^\s*ackToken:/m.test(code), "comments stripped — the property is about code, not prose");
  check("⭐ …it stores ackTokenHash, via the fingerprint helper",
    /ackTokenHash:\s*ackTokenFingerprint\(/.test(code));
  // ⭐⭐ COUNTED, NOT PINNED — CHANGED 2026-08-28 when a THIRD builder was added.
  // This asserted `=== 2` because there were two record builders. A third correct one then FAILED
  // it, and the tempting fix — bump the literal to 3 — is the wrong one: a hardcoded count says
  // nothing about whether the NEXT builder fingerprints, and someone bumping it to silence a
  // failure would let a builder that stores nothing sail through.
  // 🚨 THE PROPERTY IS A RATIO, NOT A NUMBER: every receipt written from this module must carry a
  // fingerprint. So count the WRITES and require as many fingerprints. A new builder that forgets
  // one now fails for the right reason, and a new builder that has one passes without an edit here.
  const writes = (code.match(/await\s+write(Pending)?ReceiptNeverThrows\(/g) || []).length;
  const prints = (code.match(/ackTokenHash:\s*ackTokenFingerprint\(/g) || []).length;
  check("⭐ EVERY record builder fingerprints — a pending receipt must not leak what a settled one hides",
    writes > 0 && writes === prints, `${writes} receipt write(s), ${prints} fingerprint(s)`);
}

console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
