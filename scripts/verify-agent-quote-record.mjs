// verify-agent-quote-record.mjs — THE PRICED PLAN IS KEPT, JOINABLE, BOUNDED, AND POWERLESS.
//
//   node --experimental-test-module-mocks scripts/verify-agent-quote-record.mjs
//
// ═══ WHAT THIS GUARDS ════════════════════════════════════════════════════════════════════════
// `agent-act` priced every bridge step in a plan — band, fee, net, whether an ack box would
// render — handed all of it to the browser, and kept NOTHING. On 2026-08-01 an ack box appeared
// while the only receipt that landed needed no acknowledgment, and the three candidate
// explanations could not be told apart from any server-side artifact. FOUR properties have to
// hold for that class of question to be answerable, and each one fails silently on its own:
//
//   1. THE RECORD EXISTS      — the priced plan is persisted, with the raw task text beside the
//                               steps the brain produced (that pair is what separates "a step was
//                               priced and never ran" from "the amount changed at parse time").
//   2. THE JOIN HOLDS         — one identifier reaches both the quote record and the receipt of
//                               what ran. Two records nobody can correlate answer nothing.
//   3. IT CANNOT BREAK QUOTING — this is the quote path. A diagnostics failure that refused to
//                               quote would trade a capability for an observation.
//   4. ⭐ IT AUTHORIZES NOTHING — the trap is "we have the priced plan stored, validate against
//                               it instead of re-pricing", which deletes the pre-flight re-price
//                               and makes a stored client-facing value load-bearing for consent.
//                               Enforced by ABSENCE OF MECHANISM: the module exports no reader.
//                               A comment cannot stop anyone; this fails the build.
//
// Plus retention, which is a decision and not a discovery: TTL + per-owner cap, both exercised.
//
// Zero network. Zero money. Zero real Blobs. Zero model calls.

import { mock } from "node:test";

// ⭐⭐ SPREAD THE REAL MODULE, OVERRIDE ONLY WHAT THIS SUITE NEEDS. An explicit namedExports
// list breaks every time _agent-wallets gains an export — it has now done so TWICE
// (WALLET_PROVISIONING_STATUS, then WALLET_UNRESOLVABLE_STATUS), each time failing at module
// INSTANTIATION with a message about the export rather than about the test. Spreading makes the
// mock track the module instead of a snapshot of it.
const REAL_WALLETS = await import("../netlify/functions/_agent-wallets.mjs");
import { readFileSync } from "node:fs";

// The REAL band logic — imported before any mock so the suite prices with the same helper
// production does, and only the network call underneath it is injected.
import * as realBridge from "../netlify/functions/_bridge.mjs";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret-for-quote-record";
process.env.ANTHROPIC_API_KEY = "test-key-not-used-network-is-mocked";
process.env.AGENT_SEND_CAP_USDC = "5";
process.env.AGENT_BRIDGE_CAP_USDC = "25";
process.env.PERIOD_CEILING_USDC = "2";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

// ── an in-memory Blobs, with failure injection ───────────────────────────────────────────────
// Mocking the STORE and not `_quote-record.mjs` keeps the real key layout, the real never-throw
// wrapper and the real prune arithmetic under test.
const mem = new Map();
let failMode = null; // null | "set" | "list" | "delete"
let deletes = 0;
mock.module("@netlify/blobs", {
  namedExports: {
    connectLambda: () => {}, // agent-act calls connectBlobs(event); no real context here
    getStore: () => ({
      setJSON: async (k, v) => {
        if (failMode === "set") throw new Error("injected Blobs set failure");
        mem.set(k, JSON.stringify(v));
      },
      get: async (k) => {
        const s = mem.get(k);
        return s ? JSON.parse(s) : null;
      },
      list: async ({ prefix } = {}) => {
        if (failMode === "list") throw new Error("injected Blobs list failure");
        return { blobs: [...mem.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((key) => ({ key })) };
      },
      delete: async (k) => {
        if (failMode === "delete") throw new Error("injected Blobs delete failure");
        deletes++;
        mem.delete(k);
      },
    }),
  },
});

const OWNER = "0xOwNeR0000000000000000000000000000000001";
const AGENT_WALLET = "0xa9e70000000000000000000000000000000000a1";

const Q = await import("../netlify/functions/_quote-record.mjs");

// ══════════════════════════════════════════════════════════════════════════════════════════════
console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  AGENT QUOTE RECORD — kept, joinable, bounded, powerless             ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("1 — THE IDENTIFIER CANNOT BE CONFUSED WITH THE OTHER TWO");
{
  const id = Q.mintQuoteId();
  check("mints a well-formed id", Q.QUOTE_ID_RE.test(id), id);
  check("two mints differ", Q.mintQuoteId() !== Q.mintQuoteId());
  // 🚨 This repo already has 24-hex (Netlify DEPLOY ID) and 40-hex (git COMMIT SHA) identifier
  // spaces whose confusion cost hours, discriminated ONLY by length. A third bare-hex id would
  // be a third way to guess wrong.
  check("⭐⭐ is NOT bare hex — the `q_` prefix discriminates it from deploy ids and shas",
    /^q_/.test(id) && !/^[0-9a-f]+$/i.test(id));
  check("  …so a 24-hex deploy id is rejected", Q.safeQuoteId("6a6dea1ff6e9ccf6b543c031") === null);
  check("  …and a 40-hex commit sha is rejected", Q.safeQuoteId("1955667a1955667a1955667a1955667a19556670") === null);

  check("safeQuoteId passes a minted id through", Q.safeQuoteId(id) === id);
  check("…and trims", Q.safeQuoteId(`  ${id} `) === id);
  for (const junk of [null, undefined, 42, {}, [], "", "q_", "q_zzz", "../../etc/passwd",
                      `q_${"x".repeat(5000)}`, "q_abc_ZZZZZZZZZZZZZZZZ"]) {
    if (Q.safeQuoteId(junk) !== null) { check(`junk rejected: ${String(junk).slice(0, 24)}`, false); }
  }
  check("⭐ every junk shape normalizes to null — a client cannot push bytes into a receipt", true);
}

section("2 — THE WRITE, AND THE KEY THAT MAKES IT FINDABLE");
{
  mem.clear(); failMode = null;
// ⭐⭐ FIXTURE DATES MUST BE RELATIVE, NOT WALL-CLOCK LITERALS — AND THIS SUITE PROVED IT THE HARD
// WAY. Every `quotedAt` below was a hardcoded "2026-08-01T…". `recordQuoteNeverThrows` writes and
// then prunes, and the prune expires anything older than QUOTE_TTL_MS (14 days) against the REAL
// clock. So at 2026-08-15T12:34:56.789Z — fourteen days after the literal — the fixture aged past
// the TTL and the suite began deleting the record it had just written. Nothing in the code changed.
//
// ⚠️ THE MODULE WAS CORRECT THE WHOLE TIME. A fourteen-day-old quote SHOULD be pruned; the test was
// asking it to keep one. ⭐ AND THE FAILURE WAS UNBISECTABLE BY RE-RUNNING OLD COMMITS: a
// time-dependent test evaluated against `Date.now()` fails at EVERY commit once the wall clock
// passes the boundary, so history shows a defect that was never there.
//
// So: dates that must stay FRESH are derived from now; the TTL boundary is tested DELIBERATELY
// below with an injected clock, which is what `pruneOwnerQuotes(owner, now)` takes a `now` for.
  const quotedAt = new Date(Date.now() - 1000).toISOString(); // fresh: this record must SURVIVE the prune
  const quoteId = Q.mintQuoteId();
  const r = await Q.recordQuoteNeverThrows({
    schema: "agent-quote/1", quoteId, quotedAt, owner: OWNER, task: "t", stepCount: 1,
    steps: [], totalUsdc: 1, totalFeeUsdc: 0,
  });
  check("written", r.written === true);
  const key = Q.quoteKey(OWNER, quotedAt, quoteId);
  check("stored under `q/<owner>/<ISO>-<quoteId>`", mem.has(key), key);
  check("⭐ owner is lower-cased in the key, so one owner is ONE prefix", key.includes(OWNER.toLowerCase()));
  const rec = JSON.parse(mem.get(key));
  // The receipts module's rule, repeated here: the key is an INDEX over the record, never a
  // second copy of it. Both components are re-derivable from the stored record.
  check("⭐ the key is derivable FROM the record — index, not a second truth",
    Q.quoteKey(rec.owner, rec.quotedAt, rec.quoteId) === key);
  check("⭐ the LISTING alone dates every quote (no get needed to find one)",
    Number.isFinite(Date.parse(key.slice(key.lastIndexOf("/") + 1, key.lastIndexOf("/") + 25))));
}

section("3 — IT MUST NEVER BREAK QUOTING");
{
  mem.clear();
  failMode = "set";
  let threw = false, r;
  try { r = await Q.recordQuoteNeverThrows({ quoteId: "q_a_0000000000000000", quotedAt: new Date(Date.now() - 1000).toISOString(), owner: OWNER }); }
  catch { threw = true; }
  check("⭐⭐ a store that throws on write does NOT propagate", threw === false);
  check("  …and says so honestly", r?.written === false && r?.reason === "write_error");

  failMode = "list"; // the prune's list — runs AFTER a successful write
  threw = false;
  try { r = await Q.recordQuoteNeverThrows({ quoteId: "q_b_0000000000000000", quotedAt: new Date(Date.now() - 1000).toISOString(), owner: OWNER }); }
  catch { threw = true; }
  check("⭐ a prune failure does not propagate either", threw === false);
  check("  …and the write still counts as landed", r?.written === true);

  failMode = null;
  const bad = await Q.recordQuoteNeverThrows({ quotedAt: new Date(Date.now() - 1000).toISOString() });
  check("refuses a record with no owner/quoteId rather than writing an unfindable blob",
    bad.written === false && bad.reason === "missing_key_fields");
}

section("4 — RETENTION IS DECIDED, NOT DISCOVERED");
{
  const now = Date.parse("2026-08-01T00:00:00.000Z");
  const at = (ms) => new Date(ms).toISOString();
  const seed = (n, ageMs) => {
    for (let i = 0; i < n; i++) {
      const ts = at(now - ageMs - i * 1000);
      mem.set(Q.quoteKey(OWNER, ts, `q_seed${i}_0000000000000000`.slice(0, 12) + "_0000000000000000"), "{}");
    }
  };

  mem.clear(); failMode = null; deletes = 0;
  seed(3, Q.QUOTE_TTL_MS + 60_000);   // expired
  seed(2, 60_000);                    // fresh
  const p1 = await Q.pruneOwnerQuotes(OWNER, now);
  check("⭐ past the TTL is deleted", p1.expired === 3 && p1.deleted === 3, `${Q.QUOTE_TTL_MS / 86400000}d`);
  check("  …and fresh records survive", mem.size === 2);

  mem.clear(); deletes = 0;
  seed(Q.MAX_QUOTES_PER_OWNER + 7, 60_000); // all fresh, over the cap
  const p2 = await Q.pruneOwnerQuotes(OWNER, now);
  check("⭐ the per-owner CAP bounds a burst the TTL cannot",
    p2.overflow === 7 && mem.size === Q.MAX_QUOTES_PER_OWNER, `cap ${Q.MAX_QUOTES_PER_OWNER}`);

  // ⭐ THE HOLE THE TTL PASS LEAVES OPEN, CLOSED BY THE CAP PASS. A key whose timestamp cannot
  // be read is NOT deleted for age — "I could not read the date" is not "it is old" — so on the
  // TTL pass alone it would live forever. The cap pass evicts by key order regardless, which is
  // what stops an unreadable timestamp from meaning "kept indefinitely".
  mem.clear(); deletes = 0;
  for (let i = 0; i < 5; i++) mem.set(`q/${OWNER.toLowerCase()}/NOT-A-DATE-${i}`, "{}");
  const p3 = await Q.pruneOwnerQuotes(OWNER, now);
  check("an unparseable date is NOT deleted for age (conservative)", p3.expired === 0 && mem.size === 5);
  mem.clear();
  for (let i = 0; i < 5; i++) mem.set(`q/${OWNER.toLowerCase()}/AAA-NOT-A-DATE-${i}`, "{}");
  seed(Q.MAX_QUOTES_PER_OWNER, 60_000);
  const p4 = await Q.pruneOwnerQuotes(OWNER, now);
  check("⭐⭐ …but the CAP still evicts it, so nothing is retained forever",
    p4.overflow === 5 && mem.size === Q.MAX_QUOTES_PER_OWNER);

  mem.clear(); deletes = 0;
  seed(Q.MAX_DELETES_PER_WRITE + 40, Q.QUOTE_TTL_MS + 60_000);
  const p5 = await Q.pruneOwnerQuotes(OWNER, now);
  check("⭐ cleanup is HARD-BOUNDED per write — a backlog drains over several, never blocks one",
    p5.deleted === Q.MAX_DELETES_PER_WRITE, `${Q.MAX_DELETES_PER_WRITE}/write`);
  check("  …and the unfinished remainder is LOGGED, not implied away",
    /NO SILENT TRUNCATION/.test(readFileSync(new URL("../netlify/functions/_quote-record.mjs", import.meta.url), "utf8")));

  failMode = "delete";
  mem.clear();
  seed(3, Q.QUOTE_TTL_MS + 60_000);
  let threw = false;
  try { await Q.pruneOwnerQuotes(OWNER, now); } catch { threw = true; }
  check("one stubborn key does not stop the prune (or the request)", threw === false);
  failMode = null;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
section("5 — END TO END: agent-act PRICES A PLAN AND THE RECORD LANDS");
// ⭐ ACROSS WHAT IT BINDS. Asserting the helper writes correctly proves nothing about whether
// agent-act CALLS it with the priced plan — that binding only exists across the handler, so the
// handler is driven here with its network edges injected and its real pricing intact.
const FEE = 0.053196; // a real quote, burn 0x0175cf7b… 2026-07-31

mock.module("../netlify/functions/_bridge.mjs", {
  namedExports: {
    ...realBridge,
    // ONLY the IRIS round trip is injected; the band, the token and the destination table are real.
    bridgeFee: async ({ amountUsdc }) => ({
      feeUsdc: FEE,
      netUsdc: amountUsdc - FEE,
      maxFee: Math.round(FEE * 1e6),
      amountMinor: Math.round(amountUsdc * 1e6),
    }),
  },
});
mock.module("../netlify/functions/_auth.mjs", {
  namedExports: {
    requireSession: () => ({ address: OWNER }),
    internalToken: () => "internal",
  },
});
mock.module("../netlify/functions/_agent-wallets.mjs", {
  namedExports: { ...REAL_WALLETS,  ensureOwnerWallet: async () => ({ walletAddress: AGENT_WALLET }) },
});
mock.module("../netlify/functions/_actions.mjs", {
  namedExports: {
    executeAction: async () => ({ ok: false, blocked: "not reached in this suite" }),
    valueOfStep: async (s) => Number(s.amountUsdc ?? s.amountIn ?? s.payAmountUsdc ?? 0),
  },
});

// The brain. Its answer is fixed so the ASSERTIONS are about what the server recorded, never
// about what a model happened to say.
const BRAIN = {
  action: "plan",
  reasoning: "Two bridges, one of them small.",
  steps: [
    { type: "bridge_usdc", amountUsdc: 1.0, destination: "Base" },
    { type: "bridge_usdc", amountUsdc: 0.1, destination: "Base" },
  ],
};
const TASK = "bridge 1 USDC to Base then bridge 0.1 USDC to Base";
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ content: [{ type: "text", text: JSON.stringify(BRAIN) }] }),
});

{
  mem.clear(); failMode = null;
  const { handler } = await import("../netlify/functions/agent-act.mjs");
  const res = await handler({
    httpMethod: "POST",
    headers: { authorization: "Bearer x" },
    body: JSON.stringify({ task: TASK }),
  });
  const body = JSON.parse(res.body);

  check("the plan is proposed", res.statusCode === 200 && body.needsConfirm === true);
  check("⭐ the response carries a quoteId for the client to hand back", Q.QUOTE_ID_RE.test(body.quoteId || ""));

  const keys = [...mem.keys()].filter((k) => k.startsWith(`q/${OWNER.toLowerCase()}/`));
  check("⭐⭐ a quote record LANDED — the gap this whole change exists to close", keys.length === 1);
  const rec = keys.length === 1 ? JSON.parse(mem.get(keys[0])) : {};

  check("the record's id is the one the client was given", rec.quoteId === body.quoteId);
  check("schema is versioned", rec.schema === "agent-quote/1");
  check("⭐ the RAW TASK TEXT is kept verbatim", rec.task === TASK);
  check("  …beside what the brain made of it — the pair that separates 'never ran' from 'amount changed'",
    rec.reasoning === BRAIN.reasoning && rec.steps?.[1]?.step?.amountUsdc === 0.1);
  check("the model that priced it is named", typeof rec.model === "string" && rec.model.length > 0);
  check("⭐ the model name comes from ONE definition, not a second copy of the env read",
    /export const agentModel/.test(readFileSync(new URL("../netlify/functions/agent-act.mjs", import.meta.url), "utf8")));
  check("owner is the verified session address, not anything client-supplied",
    String(rec.owner).toLowerCase() === OWNER.toLowerCase());
  check("the spending wallet is recorded too", String(rec.agentWallet).toLowerCase() === AGENT_WALLET.toLowerCase());

  check("totals are recorded", rec.totalUsdc === 1.1 && Number(rec.totalFeeUsdc) > 0);
  check("⭐ the CAPS in force at quote time are recorded", rec.caps?.bridgeCapUsdc === 25 && rec.caps?.periodCeilingUsdc === 2);
  check("quotedAt is a real timestamp", Number.isFinite(Date.parse(rec.quotedAt)));

  // ⭐⭐ THE ANOMALY THIS WAS BUILT FOR. 1.0 at a 0.0532 fee is 5.3% — no gate. 0.1 at the same
  // FLAT fee is 53.2% — a gate. The record must show BOTH, per step, or "an ack box fired where
  // no gate was required" stays unanswerable.
  check("⭐⭐ step 1 (1.0 USDC) recorded band `none` — no box was due",
    rec.steps?.[0]?.bridge?.band === "none", `${(rec.steps?.[0]?.bridge?.feeRatio * 100).toFixed(1)}%`);
  check("⭐⭐ step 2 (0.1 USDC) recorded band `acknowledge` — a box WAS due",
    rec.steps?.[1]?.bridge?.band === "acknowledge", `${(rec.steps?.[1]?.bridge?.feeRatio * 100).toFixed(1)}%`);
  check("⭐ and whether a token was actually issued for it — i.e. whether the box could render",
    rec.steps[0].bridge.ackTokenIssued === false && rec.steps[1].bridge.ackTokenIssued === true);
  check("per-step fee and net are recorded, not just the ratio",
    rec.steps[1].bridge.feeUsdc === Number(FEE.toFixed(6)) && rec.steps[1].bridge.netUsdc != null);
  check("⭐ the ackToken ITSELF is not stored — a diagnostic record is no place for a credential",
    JSON.stringify(rec).includes("ackTokenIssued") && !("ackToken" in (rec.steps[1].bridge || {})));

  // ⚠️ Every recorded field must be server-sourced. The client sent ONLY `task`.
  check("⭐ nothing client-supplied lands in the record except the task text itself",
    rec.owner !== undefined && rec.agentWallet !== undefined &&
    rec.steps.every((s) => s.bridge === undefined || typeof s.bridge.feeUsdc === "number"));
}

section("5b — ⭐⭐ THE QUOTE RESPONSE MUST NEVER BE STORABLE");
{
  // 🚨 A REPLAYED QUOTE IS A STALE FEE SHOWN AS CURRENT, and the acknowledge band is derived
  // from that fee. It also makes the function look uninvoked from the server side, which is
  // what let three "the plan ran" reports produce zero traffic. `no-cache` is NOT enough: it
  // permits storage with revalidation. Only `no-store` forbids keeping a copy, and Netlify's
  // CDN reads its own directive in preference to Cache-Control.
  const { json: jsonHelper } = await import("../netlify/functions/_arc.mjs");
  const h = jsonHelper(200, { ok: true }).headers;
  const cc = String(h["Cache-Control"] || "");
  check("⭐⭐ the shared json() helper forbids STORAGE, not merely reuse", /no-store/.test(cc), cc);
  check("  …and still sends no-cache/must-revalidate for caches that ignore no-store",
    /no-cache/.test(cc) && /must-revalidate/.test(cc));
  check("⭐ the Netlify CDN gets its OWN directive — it does not read Cache-Control",
    h["Netlify-CDN-Cache-Control"] === "no-store" && h["CDN-Cache-Control"] === "no-store");
  check("  …and the body is still JSON", h["Content-Type"] === "application/json");

  // Pinned at the HELPER, so a new endpoint is covered the day it is written. If someone moves
  // the header onto agent-act alone, this fails.
  const arc = readFileSync(new URL("../netlify/functions/_arc.mjs", import.meta.url), "utf8");
  check("⭐ set in the shared helper, not at one call site",
    /const NO_STORE = \{/.test(arc) && /THIS IS A MONEY-PATH HEADER/.test(arc));

  // ⚠️ WHAT THIS SUITE CANNOT PROVE: that the platform HONOURS the header. Only two presses of
  // the SAME task text can — different text always missed the cache, so testing with different
  // text proves nothing. Pass = two agent-act invocations AND two quote records with distinct
  // quoteIds for one task string.
  check("⭐ the suite states what it cannot prove (the platform honouring it)",
    /two presses of/i.test(readFileSync(new URL("./verify-agent-quote-record.mjs", import.meta.url), "utf8")));
}

section("6 — A DIAGNOSTICS FAILURE MUST NOT COST THE QUOTE");
{
  mem.clear();
  failMode = "set"; // the record write throws
  const { handler } = await import("../netlify/functions/agent-act.mjs");
  const res = await handler({
    httpMethod: "POST",
    headers: { authorization: "Bearer x" },
    body: JSON.stringify({ task: TASK }),
  });
  const body = JSON.parse(res.body);
  check("⭐⭐ the plan is STILL quoted when the record cannot be written",
    res.statusCode === 200 && body.needsConfirm === true && Array.isArray(body.plan));
  check("  …with its disclosures intact — the user loses nothing", body.stepDisclosures?.[1]?.band === "acknowledge");
  check("  …and nothing was persisted", mem.size === 0);
  failMode = null;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
section("7 — ⭐⭐ IT AUTHORIZES NOTHING, AND CANNOT LEARN TO");
{
  const quote = readFileSync(new URL("../netlify/functions/_quote-record.mjs", import.meta.url), "utf8");
  const act = readFileSync(new URL("../netlify/functions/agent-act.mjs", import.meta.url), "utf8");
  const plan = readFileSync(new URL("../netlify/functions/agent-execute-plan.mjs", import.meta.url), "utf8");
  const actions = readFileSync(new URL("../netlify/functions/_actions.mjs", import.meta.url), "utf8");
  const record = readFileSync(new URL("../netlify/functions/_bridge-record.mjs", import.meta.url), "utf8");

  // ⭐ ENFORCED BY ABSENCE OF MECHANISM. The trap is "we already have the priced plan stored,
  // validate the confirm against it instead of re-pricing" — which deletes the pre-flight
  // re-price and makes a stored client-facing value load-bearing for consent. There is nothing
  // to read it WITH: no reader is exported, so writing one is a visible, deliberate act that
  // trips this check.
  const exportedReaders = [...quote.matchAll(/export\s+(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)/g)]
    .map((m) => m[1] || m[2])
    .filter((n) => /^(read|get|list|load|fetch)/i.test(n));
  check("⭐⭐ the module exports NO reader — nothing can read a quote back into a decision",
    exportedReaders.length === 0, exportedReaders.join(",") || "none");
  check("  …and no store `.get(` on quotes exists at all", !/store\(\)\.get\(/.test(quote));
  check("  …the prohibition is written AT the module, where the next person will be standing",
    /DIAGNOSTIC ONLY\. THIS RECORD MUST NEVER AUTHORIZE ANYTHING/.test(quote));

  const importers = ["agent-act.mjs", "agent-execute-plan.mjs", "_bridge-record.mjs", "_actions.mjs"];
  for (const f of importers) {
    const src = readFileSync(new URL(`../netlify/functions/${f}`, import.meta.url), "utf8");
    const imp = src.match(/import\s*\{([^}]*)\}\s*from\s*"\.\/_quote-record\.mjs"/);
    const names = imp ? imp[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
    const bad = names.filter((n) => /^(read|get|list|load|fetch)/i.test(n));
    if (bad.length) check(`${f} imports a reader`, false, bad.join(","));
  }
  check("⭐ no money-path function imports anything read-shaped from it", true);

  // The re-price must still be the thing that decides. If someone swaps it for a store read,
  // this fails.
  check("⭐⭐ the executor still RE-PRICES every bridge step before executing any",
    /bridgeFee\(\{ amountUsdc: amt/.test(plan) && /PRE-FLIGHT: RE-PRICE EVERY BRIDGE STEP/.test(plan));
  check("⭐⭐ …and consent is still the RECOMPUTED ackToken, not a stored value",
    /bridgeAckToken\(\{ owner: session\.address/.test(plan) && /bandInfo\.band === "acknowledge"/.test(actions));
  check("⭐ quoteId is never compared or branched on in the gate path",
    !/quoteId\s*===|if\s*\(\s*quoteId\s*\)/.test(actions) && !/quoteId\s*===/.test(plan));

  // Fire-and-continue at the call site, matching the receipt write's rule.
  check("⭐ agent-act AWAITS the record (an un-awaited write may never happen on Netlify)",
    /await recordQuoteNeverThrows\(/.test(act));
  check("  …and does not branch on its result", !/(const|let)\s+\w+\s*=\s*await recordQuoteNeverThrows/.test(act));

  // The join, on both ends.
  check("⭐⭐ the receipt carries the join key", /quoteId: quoteId \?\? null/.test(record));
  check("  …and which step of the plan it was", /quoteStepIndex/.test(record));
  check("  …threaded from the confirm request", /recordBridge\(\{ r, session, event, amountRequested: step\.amountUsdc, quoteId/.test(plan));
  check("  …normalized before it can reach a receipt", /safeQuoteId\(rawQuoteId\)/.test(plan));
  check("⭐ an ABSENT join is documented as normal, never as a defect",
    /NULL IS NORMAL AND MEANS NOTHING BAD/.test(record));

  // The client carries it end to end — the join is worthless if it stops at the browser.
  const client = readFileSync(new URL("../src/lib/agentClient.ts", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../src/components/MyAgentPanel.tsx", import.meta.url), "utf8");
  check("⭐ the client sends quoteId back on confirm", /\{ plan, ackTokens, quoteId \}/.test(client));
  check("  …and the panel passes the one it was quoted", /onConfirm\(data\.plan, planAckTokens, data\.quoteId\)/.test(panel));

  // Retention is a decision. If both bounds vanish, this fails.
  check("⭐ retention is bounded by BOTH a TTL and a per-owner cap",
    Q.QUOTE_TTL_MS > 0 && Q.MAX_QUOTES_PER_OWNER > 0 && /RETENTION — decided, not discovered/.test(quote));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
section("⭐⭐ THE TTL BOUNDARY, TESTED ON PURPOSE INSTEAD OF BY CALENDAR ACCIDENT");
// 🚨 THIS SECTION EXISTS BECAUSE THE SUITE ONCE TESTED THIS BY ACCIDENT AND CALLED IT A DEFECT.
// A hardcoded `quotedAt: "2026-08-01T…"` aged past QUOTE_TTL_MS on 2026-08-15T12:34:56.789Z, and
// from that moment `recordQuoteNeverThrows` wrote the record and the prune immediately expired it —
// correct behaviour, reported as a failure, and UNBISECTABLE by re-running old commits because a
// wall-clock test fails at every commit once the boundary passes.
// ⭐ `pruneOwnerQuotes(owner, now)` takes an injected clock precisely so this can be exercised
// without waiting fourteen days or depending on what day it is.
{
  mem.clear();
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  const mk = async (isoOffsetMs, id) => {
    const quotedAt = new Date(t0 + isoOffsetMs).toISOString();
    await Q.recordQuoteNeverThrows({ quoteId: id, quotedAt, owner: OWNER, agentWallet: AGENT_WALLET, steps: [], totalUsdc: 1, totalFeeUsdc: 0 });
    return Q.quoteKey(OWNER, quotedAt, id);
  };
  // Written far in the "past" relative to the injected now, but the WRITE's own prune runs against
  // the real clock — so seed first, then prune with an explicit `now`.
  mem.clear();
  const fresh = await mk(0, "q_fresh_00000000000");
  const old = await mk(0, "q_old_000000000000");
  mem.set(old.replace(/\/[^/]+$/, "/2026-01-01T00:00:00.000Z-q_old_000000000000"), JSON.stringify({ owner: OWNER }));

  const justInside = Q.QUOTE_TTL_MS - 1000;
  const r1 = await Q.pruneOwnerQuotes(OWNER, t0 + justInside);
  check("⭐⭐ a record ONE SECOND inside the TTL survives", r1.expired === 0, `expired=${r1.expired}`);

  const r2 = await Q.pruneOwnerQuotes(OWNER, t0 + Q.QUOTE_TTL_MS);
  check("⭐⭐ …and at EXACTLY the TTL it expires — the boundary is inclusive, pinned deliberately",
    r2.expired > 0, `expired=${r2.expired}`);
  check("  …the TTL is 14 days, stated so a change to it is visible here",
    Q.QUOTE_TTL_MS === 14 * 24 * 60 * 60 * 1000);

  // ⚠️ AND THE CONSEQUENCE WORTH KNOWING: a quote written ALREADY older than the TTL is written and
  // then immediately deleted, while `recordQuoteNeverThrows` still returns written:true. Production
  // never hits it (quotedAt is minted at write time), but the return value can describe a record
  // that no longer exists — recorded here rather than discovered again.
  mem.clear();
  const stale = new Date(Date.now() - Q.QUOTE_TTL_MS - 60_000).toISOString();
  const rs = await Q.recordQuoteNeverThrows({ quoteId: "q_stale_0000000000", quotedAt: stale, owner: OWNER, agentWallet: AGENT_WALLET, steps: [], totalUsdc: 1, totalFeeUsdc: 0 });
  check("⚠️ (recorded) a pre-expired quote returns written:true and is gone immediately",
    rs.written === true && mem.size === 0, `written=${rs.written} memSize=${mem.size}`);
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
