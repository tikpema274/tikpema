// verify-published-offer.mjs — PUBLISHED_OFFER is "what buyers were TOLD", distinct from ARC (what we RUN on).
//
//   node scripts/verify-published-offer.mjs        (also: npm run test:publishedoffer, in test:all)
//
// Three sellers (x402-quote, x402-vanilla-seller, _dd-x402) used to carry the same startup pin as three
// copies of one literal: `if (NETWORK !== "eip155:<id>" || ASSET !== "0x3600…") throw`. The pin is
// RIGHT — a 402 challenge publishes a chain and an asset to a paying buyer, and a runtime flip must not
// silently advertise a different one — but three copies of a pin drift exactly like three copies of a
// value. Phase B (mainnet go/no-go §1) gives the pin ONE shape in shared/x402/published.mjs.
//
// What this suite proves:
//   1. assertPublishedOffer THROWS when the runtime network differs, and the message NAMES `network`
//      with both values; same for `asset`; a changed pair names BOTH; an equal pair returns quietly.
//   2. The asset comparison is case-insensitive (checksummed vs lower-cased is the same token).
//   3. The three sellers call it — and NONE of them still holds its own literal pin.
//   4. ⭐ published.mjs is in DD_SURFACE_FILES: _dd-x402 imports it, dd-analyze reaches it, so it MUST be in
//      the code-identity hash — a change to what the DD service TELLS BUYERS changes the artefact's identity.
//   5. PUBLISHED_OFFER is frozen, and today it AGREES with the runtime (the boot does not throw).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PUBLISHED_OFFER, assertPublishedOffer, PublishedOfferError } from "../shared/x402/published.mjs";
import { ARC, CONTRACTS } from "../netlify/functions/_arc.mjs";

let failed = 0;
const check = (label, fn) => { try { fn(); console.log(`  ✅ ${label}`); } catch (e) { failed++; console.log(`  ❌ ${label}\n     ${e.message}`); } };
const throws = (fn) => { try { fn(); } catch (e) { return e; } return null; };

const OK = { network: PUBLISHED_OFFER.network, asset: PUBLISHED_OFFER.asset, who: "suite" };

console.log("── 1. the assert discriminates, and NAMES what changed ─────────────────────");
check("an equal pair returns quietly", () => { assert.equal(assertPublishedOffer(OK), undefined); });
check("a changed NETWORK throws, naming `network` and both values", () => {
  const e = throws(() => assertPublishedOffer({ ...OK, network: "eip155:999999" }));
  assert.ok(e instanceof PublishedOfferError, "PublishedOfferError");
  assert.match(e.message, /suite: published chain\/asset changed/, "names the caller");
  assert.match(e.message, /network/, "names the field");
  assert.match(e.message, /eip155:999999/, "names the runtime value");
  assert.match(e.message, new RegExp(PUBLISHED_OFFER.network.replace(/[.:]/g, "\\$&")), "names the published value");
  assert.doesNotMatch(e.message, /asset=/, "does NOT blame the asset");
});
check("a changed ASSET throws, naming `asset` and both values", () => {
  const bogus = "0x" + "9".repeat(40);
  const e = throws(() => assertPublishedOffer({ ...OK, asset: bogus }));
  assert.ok(e instanceof PublishedOfferError);
  assert.match(e.message, /asset/); assert.match(e.message, new RegExp(bogus));
  assert.doesNotMatch(e.message, /network=/, "does NOT blame the network");
});
check("both changed → both named", () => {
  const e = throws(() => assertPublishedOffer({ ...OK, network: "eip155:1", asset: "0x" + "8".repeat(40) }));
  assert.match(e.message, /network=/); assert.match(e.message, /asset=/);
});
check("a MISSING runtime value is a change, never a pass (absence must not read as agreement)", () => {
  assert.ok(throws(() => assertPublishedOffer({ ...OK, network: undefined })) instanceof PublishedOfferError);
  assert.ok(throws(() => assertPublishedOffer({ ...OK, asset: null })) instanceof PublishedOfferError);
});

console.log("\n── 2. asset case-insensitivity ─────────────────────────────────────────────");
check("checksummed vs lower-cased asset is the same token", () => {
  assert.equal(assertPublishedOffer({ ...OK, asset: PUBLISHED_OFFER.asset.toUpperCase().replace("0X", "0x") }), undefined);
});

console.log("\n── 3. the three sellers use the ONE shape, and hold no literal pin of their own ──");
for (const f of ["netlify/functions/x402-quote.mjs", "netlify/functions/x402-vanilla-seller.mjs", "netlify/functions/_dd-x402.mjs"]) {
  const src = readFileSync(f, "utf8");
  check(`${f} calls assertPublishedOffer`, () => {
    assert.match(src, /import \{[^}]*assertPublishedOffer[^}]*\} from "[^"]*shared\/x402\/published\.mjs"/, "imports it");
    assert.match(src, /assertPublishedOffer\(\{/, "calls it");
  });
  check(`${f} no longer carries its own literal pin`, () => {
    assert.doesNotMatch(src, /!== "eip155:\d+"/, "no inline network pin");
    assert.doesNotMatch(src, /published chain\/asset changed/, "no inline error text — the message lives in published.mjs");
  });
}

console.log("\n── 4. ⭐ published.mjs is on the DD surface ────────────────────────────────");
check("scripts/stamp-build.mjs lists shared/x402/published.mjs in DD_SURFACE_FILES", () => {
  const stamp = readFileSync("scripts/stamp-build.mjs", "utf8");
  const block = stamp.match(/const DD_SURFACE_FILES = \[[\s\S]*?\n\];/)?.[0] ?? "";
  assert.ok(block.length > 0, "DD_SURFACE_FILES parsed");
  assert.match(block, /^\s*"shared\/x402\/published\.mjs"/m, "published.mjs is hashed into ddTree");
});

console.log("\n── 5. the offer is frozen and agrees with the runtime today ─────────────────");
check("PUBLISHED_OFFER is frozen", () => { assert.ok(Object.isFrozen(PUBLISHED_OFFER)); });
check("the runtime (ARC.chainId / CONTRACTS.USDC) matches the published offer — the sellers boot", () => {
  assert.equal(`eip155:${ARC.chainId}`, PUBLISHED_OFFER.network);
  assert.equal(CONTRACTS.USDC.toLowerCase(), PUBLISHED_OFFER.asset.toLowerCase());
});

console.log(`\n${failed === 0 ? "✅ the published offer is one shape, asserted, on the DD surface" : `❌ ${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
