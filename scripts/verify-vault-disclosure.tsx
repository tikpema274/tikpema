// verify-vault-disclosure.tsx — THE CONSENT SURFACE, RENDERED, IN EVERY STATE IT HAS.
//
//   npx tsx scripts/verify-vault-disclosure.tsx        (also: npm run test:vaultdisclosure)
//
// ═══ 🚨 WHY THIS EXISTS, AND THE HOLE THAT PROVED IT ═════════════════════════════════════════
// VaultDisclosure is the text a user reads before committing funds to a third-party unaudited
// contract, and the tick that turns reading into consent. It was extracted from VaultPanel so the
// agent's deposit confirm and every vault step in a plan render THE SAME words.
//
// ⛔ WHEN THE EXTRACTION WAS MUTATION-TESTED, DELETING THE ACKNOWLEDGEMENT TICK ENTIRELY LEFT
// `test:vault` GREEN. Nothing in the repo asserted that the consent control renders — on the
// highest-stakes gate in the app. The server still fail-closes (no token ⇒ refuse), so it was
// never a money-loss path; it was a surface that would silently offer no way to consent. ⭐ And
// the inverse is the dangerous one: a tick that renders when NO acknowledgement is required trains
// the click, and nothing objected to that either. Both directions are pinned below.
// [[guard-green-through-semantic-change]] · [[collapse-needs-pairwise-inequality]]
//
// ⚠️ THE DELTA-RECOVERY BLOCK IS THE OTHER REASON. It is the branch nobody hits while building —
// "your acknowledgement died because the vault changed underneath you" — and therefore the half a
// COPY of this component would have quietly dropped. It is asserted here per change-kind, and its
// `unexplained` case is asserted to never render silently.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const VaultDisclosure = (await import("../src/components/VaultDisclosure")).default;

let pass = 0, fail = 0;
const check = (l: string, c: boolean, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

const INSPECTION = (over: any = {}) => ({
  verdict: { level: "WARN", warns: [{ code: "owner-can-withdraw", detail: "The owner can withdraw the underlying USDC." }], blocks: [] },
  conformance: { erc4626: true },
  asset: { isUsdc: true },
  funded: { isShell: false, totalAssetsUsdc: 4171 },
  redemption: { state: "full" },
  withdraw: { withdrawFeePct: "0.10%", roundTripRetainedPct: "99.90%" },
  ownerPowers: { ownerIdentityLabel: "an externally-owned account", owner: "0x" + "ab".repeat(20) },
  ...over,
});

const raw = (props: any) => renderToStaticMarkup(<VaultDisclosure {...props} />);
const txt = (props: any) =>
  raw(props).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ").trim();

const base = { inspection: INSPECTION(), ackRequired: true, acked: false, onAckChange: () => {} };

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  VAULT DISCLOSURE — the consent surface, rendered, both directions   ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("0 — it renders at all");
{
  const t = txt(base);
  check("⚠️ non-empty render — every absence check below is vacuous otherwise",
    t.length > 200, `${t.length} chars`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — 🚨 THE ACKNOWLEDGEMENT TICK: PRESENT WHEN REQUIRED, ABSENT WHEN NOT");
{
  // 🚨 THE MEASURED HOLE. Deleting this control left the whole vault suite green.
  const withAck = raw(base);
  const noAck = raw({ ...base, ackRequired: false });
  check("🚨🚨 the tick RENDERS when the server says an acknowledgement is required",
    /type="checkbox"/.test(withAck),
    "deleting this control left test:vault green — the consent gate had no render assertion");
  check("⭐ …and it carries the sentence naming what is being accepted",
    /vault owner's powers over my deposit/.test(txt(base)) &&
      /raise the exit fee/.test(txt(base)) && /withdraw the underlying USDC/.test(txt(base)),
    "a tick beside unnamed terms is a formality, not consent");
  // ⛔ THE INVERSE, WHICH IS THE DANGEROUS ONE. A tick offered when nothing needs acknowledging
  // trains the click, and the next real disclosure is met by a trained hand.
  check("⛔⛔ …and NO tick renders when the server requires none",
    !/type="checkbox"/.test(noAck),
    "a tick with nothing to accept is trained click-through");
  check("⭐ the two states render DIFFERENT markup — otherwise neither check discriminates",
    withAck !== noAck);
  // The checked state must reflect the prop, or the control lies about what was accepted.
  check("⭐ the tick reflects `acked` rather than its own state",
    !/checked=""/.test(raw({ ...base, acked: false })) && /checked=""/.test(raw({ ...base, acked: true })));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⭐⭐ THE THREE VERDICTS SAY DIFFERENT THINGS");
{
  const warn = txt(base);
  const block = txt({ ...base, inspection: INSPECTION({ verdict: { level: "BLOCK", warns: [], blocks: [{ code: "empty-shell", detail: "The vault holds no assets." }] } }) });
  const ok = txt({ ...base, ackRequired: false, inspection: INSPECTION({ verdict: { level: "OK", warns: [], blocks: [] } }) });
  check("⛔ BLOCK says the vault cannot be deposited into", /cannot be deposited into/.test(block));
  check("⚠ WARN says read before you deposit", /Read before you deposit/.test(warn));
  check("✓ OK states the terms without alarm", /Vault terms/.test(ok) && !/cannot be deposited/.test(ok));
  check("⭐⭐ all three differ — a collapse would pass a presence-only test",
    warn !== block && block !== ok && warn !== ok);
  check("⛔ a BLOCK renders its reasons, not just its verdict",
    /The vault holds no assets/.test(block));
  check("⭐ a WARN renders what the owner can do, under a heading that says so",
    /What the vault owner can do to your deposit/.test(warn) &&
      /The owner can withdraw the underlying USDC/.test(warn));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐⭐ THE DISCLOSURE-CHANGED RECOVERY — THE BRANCH A COPY WOULD DROP");
{
  const D = (over: any = {}) => ({
    d: { changed: true, levelChange: null, warnsAdded: [], warnsRemoved: [], holderChange: null,
         feeChanges: [], unexplained: false, ...over },
    level: "WARN",
  });
  const none = txt({ ...base, delta: { d: { changed: false, levelChange: null, warnsAdded: [], warnsRemoved: [], holderChange: null, feeChanges: [], unexplained: false }, level: "WARN" } });
  check("⛔ an UNCHANGED disclosure renders no recovery block — it must not cry wolf",
    !/no longer applies/.test(none));

  const lvl = txt({ ...base, delta: D({ levelChange: { from: "WARN", to: "BLOCK" } }) });
  check("⭐ a changed disclosure says the acknowledgement no longer applies",
    /Your acknowledgement no longer applies/.test(lvl));
  check("⭐ …and names the verdict move", /moved from WARN to BLOCK/.test(lvl));
  check("⭐ …and says the previous tick was cleared",
    /previous acknowledgement has been cleared/.test(lvl));

  const added = txt({ ...base, delta: D({ warnsAdded: [{ code: "owner-can-pause", detail: "The owner can pause withdrawals." }] }) });
  check("⭐ a NEW warning is itemised, not merely counted",
    /New since you accepted/.test(added) && /owner-can-pause/.test(added) && /can pause withdrawals/.test(added));

  // ⭐⭐ THE OWNERSHIP TRANSFER, FIRST-CLASS. "a warn appeared" and "every power above is now held
  // by different people" are not the same sentence, and only one of them is why the ack died.
  const holder = txt({ ...base, delta: D({ holderChange: { fromAddress: "0x" + "11".repeat(20), fromKind: "EOA", toAddress: "0x" + "22".repeat(20), toKind: "contract" } }) });
  check("⭐⭐ an OWNERSHIP TRANSFER is rendered as its own change, not folded into the warns",
    /The owner changed/.test(holder) && /now held by a different party/.test(holder));
  check("⭐ …and shows both parties", /0x1111…1111/.test(holder) && /0x2222…2222/.test(holder));

  const fee = txt({ ...base, delta: D({ feeChanges: [{ label: "exit fee", fromBps: 10, toBps: 200 }] }) });
  check("⭐ a FEE move is stated with both figures", /exit fee/.test(fee) && /0\.10%/.test(fee) && /2\.00%/.test(fee));

  // ⚠️ NEVER SILENT. The digest moved and nothing we render explains it — say exactly that, rather
  // than an empty panel that reads as "nothing important changed".
  const unexp = txt({ ...base, delta: D({ unexplained: true }) });
  check("🚨 an UNEXPLAINED change says so rather than rendering an empty box",
    /cannot itemise/.test(unexp) && /treat the vault as unreviewed/.test(unexp),
    "an absence that renders as calm is the failure this repo keeps finding");

  // ⛔ ORDER MATTERS: the recovery must be read BEFORE the tick is offered again.
  const both = raw({ ...base, delta: D({ levelChange: { from: "OK", to: "WARN" } }) });
  check("⛔⛔ the recovery block renders ABOVE the tick it invalidates",
    both.indexOf("no longer applies") < both.indexOf('type="checkbox"'),
    "a re-tick offered before the reason is read is a formality");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⛔ IT REPORTS CONSENT; IT DOES NOT ADJUDICATE IT");
{
  // The component must not decide depositability. `ackRequired` and the BLOCK verdict are the
  // SERVER's, and the server re-inspects and re-checks the token at execute time regardless.
  // A client that computed its own gate would be a gate its own author could edit.
  const src = (await import("node:fs")).readFileSync("src/components/VaultDisclosure.tsx", "utf8");
  check("⛔ no ackToken is computed, held or emitted by the consent UI",
    !/ackToken/.test(src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")),
    "the token is the server's; this surface reports a tick");
  check("⛔ …and it performs no fetch of its own",
    !/fetch\(|agentClient|await /.test(src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")));
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money, zero network.`);
process.exit(fail === 0 ? 0 : 1);
