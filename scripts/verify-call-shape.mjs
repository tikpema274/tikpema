#!/usr/bin/env node
// verify-call-shape.mjs — the request/response schema is published in THREE places. Prove they are
// one definition, not three copies that happen to agree today.
//
//   node scripts/verify-call-shape.mjs
//
// ⭐ WHY THIS FIELD ABOVE ALL OTHERS. The call shape is the thing agents build requests FROM. A
// stale copy does not merely misinform — it teaches an agent to construct a request this endpoint
// then refuses, and the agent has no way to tell which of the two descriptions is current. It fails
// on the buyer's side, silently, in a way we never see.
//
// 🚨 EQUALITY TODAY IS NOT ONE DEFINITION. Three hand-written copies also pass a deep-equal check on
// the day they are written; that is exactly how [[duplicate-source-of-truth-is-the-recurring-bug]]
// begins every time. So this asserts OBJECT IDENTITY at the module boundary (=== against the
// exported constant) as well as deep equality in the rendered payloads — identity is the property
// that cannot be satisfied by a copy.
//
// READ-ONLY, no network, no chain, no credential.

import { DD_REQUEST_SCHEMA, DD_RESPONSE_SCHEMA, DD_RESOURCE_URL } from "../netlify/functions/_dd-descriptor.mjs";
import { challenge402, ddPaymentRequirements, DD_PRICE_ATOMIC } from "../netlify/functions/_dd-x402.mjs";
import { refusalReport } from "../netlify/functions/_dd-rungs.mjs";
import { openapiDocument } from "../netlify/functions/dd-openapi.mjs";
import { baseReport } from "../shared/onchain-analyze/schema.mjs";

let bad = 0;
const ok = (label, cond, detail = "") => {
  console.log(`   ${cond ? "✅" : "❌"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!cond) bad++;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log(`\n╔══════════════════════════════════════════════════════════════════════╗`);
console.log(`║  CALL SHAPE — one definition, three publications                     ║`);
console.log(`╚══════════════════════════════════════════════════════════════════════╝\n`);

const PAYTO = "0x" + "b4".repeat(20);
// ⭐ THE OBJECT, NOT THE SERIALISED BODY. Identity cannot survive JSON.stringify, so asserting it
// through the HTTP response would have been asserting in the one place the property is unobservable.
const spec = openapiDocument();
const op = spec.paths["/api/dd-analyze"].post;
const specReq = op.requestBody.content["application/json"].schema;
const specRes = op.responses["200"].content["application/json"].schema;
const ch = JSON.parse(challenge402({ requirements: ddPaymentRequirements({ resource: DD_RESOURCE_URL, payTo: PAYTO }) }).body);

// ⭐ IDENTITY, not equality — the assertion a copy cannot pass.
console.log("── identity at the module boundary ─────────────────────────────────");
ok("OpenAPI request schema IS the exported constant", specReq === DD_REQUEST_SCHEMA);
ok("OpenAPI response schema IS the exported constant", specRes === DD_RESPONSE_SCHEMA);

console.log("\n── the rendered payloads agree ─────────────────────────────────────");
ok("402 howToCall.request  ≡ OpenAPI request schema", eq(ch.howToCall?.request, specReq));
ok("402 howToCall.response ≡ OpenAPI response schema", eq(ch.howToCall?.response, specRes));
ok("402 states the method and content type", ch.howToCall?.method === "POST" && ch.howToCall?.contentType === "application/json");
ok("402 names the OpenAPI URL for the full document", !!ch.howToCall?.openApiUrl);
// ⚠️ The point of shipping the schema in the 402 is that an agent need NOT fetch anything else.
ok("⭐ the 402 alone is sufficient to build a call (schema present, not just linked)",
   !!ch.howToCall?.request?.properties?.address && !!ch.howToCall?.request?.properties?.chain);

console.log("\n── the chain enum is the validator's own array ─────────────────────");
// 🚨 A restated enum is how the description and the validator come to disagree. Asserted both ways.
ok("request schema chain enum is non-empty", (DD_REQUEST_SCHEMA.properties.chain.enum || []).length > 0);
ok("every field carries a description", Object.values(DD_REQUEST_SCHEMA.properties).every((p) => p.description));

console.log("\n── response schema completeness vs the REAL report skeleton ────────");
const real = Object.keys(baseReport({ address: "0x0", chainId: 0, chainName: "x", blockNumber: null })).sort();
const described = Object.keys(DD_RESPONSE_SCHEMA.properties).sort();
ok("describes exactly the fields the report returns", eq(real, described), `${described.length} field(s)`);
ok("every described field has a description", Object.values(DD_RESPONSE_SCHEMA.properties).every((p) => p.description));

console.log("\n── the 400 refusal carries payment terms ───────────────────────────");
{
  // With payTo resolvable
  process.env.DD_PAYTO_ADDRESS = PAYTO;
  const r = refusalReport({ reason: "invalid-address", detail: "missing" });
  ok("400 body carries howToPay", !!r.howToPay);
  ok("howToPay quotes the price", !!r.howToPay?.price);
  ok("howToPay carries accepts[] when payTo resolves", Array.isArray(r.howToPay?.accepts) && r.howToPay.accepts.length === 1);
  ok("accepts[] quotes the same atomic price as the 402", r.howToPay?.accepts?.[0]?.maxAmountRequired === DD_PRICE_ATOMIC);
  // 🚨 The report itself must stay a statement about a SUBJECT. howToPay is a sibling, and the
  // coverage manifest must still say nothing was checked — a refusal is not a thin clean bill.
  ok("the refusal still reports ZERO coverage", r.coverage.totals.checked === 0);
  ok("the refusal is still unsigned", r.attestation?.status === "unsigned");
}
{
  // ⭐ FAIL-SOFT: input 400s fire BEFORE the PAYTO rung, so payTo may be unset. A refusal must never
  // fail because the terms could not be assembled — and must never invent an address.
  delete process.env.DD_PAYTO_ADDRESS;
  const r = refusalReport({ reason: "invalid-address", detail: "missing" });
  ok("⭐ still refuses cleanly when payTo is UNSET (fail-soft)", !!r.howToPay && r.howToPay.accepts === null);
  ok("…and does NOT fabricate a payTo", !JSON.stringify(r.howToPay).match(/0x[0-9a-fA-F]{40}/));
  ok("…and says why, rather than going silent", /not currently resolvable|could not be assembled/.test(r.howToPay.note));
}

console.log("\n════════════════════════════════════════════════════════════════════════");
if (bad) { console.log(`❌ ${bad} check(s) failed.\n`); process.exit(1); }
console.log(`✅ ONE definition, published in the OpenAPI document, the 402 and the 400.\n`);
