import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

// AGENT QUOTE RECORDS — what the server PROPOSED, kept where it can be joined to what RAN.
//
// ═══ THE GAP THIS CLOSES ═══════════════════════════════════════════════════════════════
// `agent-act`'s plan branch priced every bridge step (band, fee, net, ackToken), summed the
// totals, handed all of it to the browser — and kept NOTHING. So on 2026-08-01 an ack box
// appeared where the only receipt that landed needed no acknowledgment, and the three
// candidate explanations (a step priced but never run / a step run and refused / an amount
// that changed between the phrasing and the quote) could not be told apart from any
// server-side artifact. The only evidence was a screenshot nobody took.
//
// `netlify logs` does carry full text here — agent-act is a regular HTTP function, not a
// `*-background` one, so a `console.log` would be readable. A log is still the wrong shape:
// ⭐ IT CANNOT BE JOINED. The question is never "what was quoted" alone, it is "what was
// quoted VERSUS what ran", and answering it needs one identifier present on both sides.
// That is `quoteId`: minted here at pricing time, threaded through the confirm request, and
// landed on the bridge receipt. Proposed-vs-ran becomes one lookup instead of a reconstruction.
//
// ═══ 🚨 DIAGNOSTIC ONLY. THIS RECORD MUST NEVER AUTHORIZE ANYTHING. ════════════════════
// The next reasonable-sounding idea about this store is a trap:
//
//     "we already have the priced plan stored — validate the confirm against it
//      instead of re-pricing"
//
// That would delete the pre-flight re-price, whose ENTIRE purpose is that the fee is
// volatile (0.0541 / 0.053520 / 0.053196 / 0.053212 / 0.0533 in one day, 0.203065 three
// weeks earlier) and a quote left open on screen goes stale. It would also make a stored,
// client-facing value load-bearing for consent. Authorization stays exactly where it is:
// `_actions.mjs` RECOMPUTES the ackToken from the band it prices itself, and compares.
//
// ⭐ PINNED STRUCTURALLY, NOT BY THIS COMMENT: this module exports a WRITE and nothing that
// reads. There is no `readQuote`, no `listQuotes`, no HTTP surface. Reaching this data
// requires the Netlify CLI, i.e. a human deciding to look — which is what a diagnostic is.
// `scripts/verify-agent-quote-record.mjs` fails the build if a reader appears.
//
// ═══ HOW A HUMAN ACTUALLY READS IT ═════════════════════════════════════════════════════
//   netlify blobs:list agent-quotes --prefix q/<owner-address-lowercase>/
//     -> keys are `q/<owner>/<ISO timestamp>-<quoteId>`, so the LISTING ALONE dates every
//        quote and names it. No get needed to find the right one.
//   netlify blobs:get agent-quotes "q/<owner>/<ISO>-<quoteId>"
//     -> the priced plan: raw task text, the brain's steps and reasoning, per-step band and
//        fee, totals, caps in force.
// To go the other way, from a bridge that RAN: the receipt in `bridge-receipts` carries
// `quoteId`; list the owner prefix above and match the suffix.

export const AGENT_QUOTES_STORE = "agent-quotes";

// ── RETENTION — decided, not discovered ────────────────────────────────────────────────
// Most quotes are never confirmed, so without a bound this store grows forever and nothing
// in the product would ever notice. Two bounds, because either alone leaks:
//   · TTL bounds how OLD a record gets. 14 days: long enough that an anomaly noticed a week
//     later is still answerable, short enough that the store stays small.
//   · A per-owner CAP bounds how MANY accumulate inside that window, so a loop that quotes
//     a thousand times in an hour cannot outrun the TTL.
// ⭐ COLLECTED BY THE CODE THAT CREATES THE GARBAGE. The prune runs on the write path, so
// retention needs no cron to be scheduled, noticed, or kept alive — a quote that is never
// written creates nothing to collect. It is hard-bounded and swallowed (see below).
export const QUOTE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_QUOTES_PER_OWNER = 200;
/** Never spend more than this on cleanup inside a quote request. A backlog drains over
 *  several writes rather than blocking one. */
export const MAX_DELETES_PER_WRITE = 25;
/** Cleanup is best-effort; it must not eat the handler's budget if Blobs is slow. */
const PRUNE_BUDGET_MS = 1500;

const norm = (a) => String(a || "").toLowerCase();

/**
 * Mint a quote identifier.
 *
 * 🚨 DELIBERATELY NOT BARE HEX. This repo already has two 0-9a-f identifier spaces whose
 * confusion cost hours — 24 hex is a Netlify DEPLOY ID, 40 hex is a git COMMIT SHA, and
 * length is the only discriminator. A third bare-hex id would be a third way to guess wrong.
 * The `q_` prefix and the `_` separator make this one unmistakable at a glance, and the
 * leading base36 timestamp makes it roughly sortable by eye.
 */
export function mintQuoteId(now = Date.now()) {
  return `q_${now.toString(36)}_${crypto.randomBytes(8).toString("hex")}`;
}

/** The only shape this system ever mints. Used to reject anything else echoed back by a
 *  client — not as a security check (a quoteId authorizes nothing) but so a client cannot
 *  push arbitrary bytes into a receipt field. */
export const QUOTE_ID_RE = /^q_[0-9a-z]{1,12}_[0-9a-f]{16}$/;

/** Normalize a client-echoed quoteId to either a well-formed id or null. Never throws. */
export function safeQuoteId(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return QUOTE_ID_RE.test(s) ? s : null;
}

/** `q/<owner>/<ISO>-<quoteId>` — the timestamp is IN the key so a plain `blobs:list` dates
 *  every record without reading one, and so pruning is a key-name comparison rather than a
 *  full read of the store. Both components are also fields on the record, so the key stays
 *  an index over the truth and never becomes a second copy of it. */
export function quoteKey(owner, quotedAt, quoteId) {
  return `q/${norm(owner)}/${quotedAt}-${quoteId}`;
}

const ISO_LEN = 24; // "2026-08-01T12:34:56.789Z"
/** 🚨 SHAPE-CHECKED BEFORE PARSING, and this is not pedantry. `Date.parse` is LENIENT:
 *  `Date.parse("NOT-A-DATE-0")` returns 946681200000 — a real timestamp in the year 2000.
 *  Without this guard a key with no date at all reads as a definite, ancient one and is
 *  deleted for age, while the code claims to be conservative about unreadable dates. Same
 *  family as every other bug in this repo where an absence quietly filled a result slot. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Epoch ms encoded in a key, or NaN when it cannot be read. */
function keyTime(key) {
  const tail = String(key).slice(String(key).lastIndexOf("/") + 1);
  const iso = tail.slice(0, ISO_LEN);
  return ISO_RE.test(iso) ? Date.parse(iso) : NaN;
}

function store() {
  return getStore(AGENT_QUOTES_STORE);
}

/**
 * Drop this owner's expired and overflowing quotes. Bounded, best-effort, never throws.
 *
 * Two passes, in order:
 *   1. AGE — delete anything past the TTL whose timestamp is READABLE. Conservative on
 *      purpose: an unparseable key is not deleted here, because "I could not read the date"
 *      is not "it is old".
 *   2. COUNT — if more than the cap survive, delete the oldest overflow by key order
 *      (which, for this key layout, is chronological). ⭐ This pass is what closes the hole
 *      pass 1 leaves open: a key whose date cannot be read is still evicted eventually,
 *      so an unreadable timestamp can never mean "kept forever".
 *
 * Returns counts for logging. NO CALLER MAY BRANCH ON THEM.
 */
export async function pruneOwnerQuotes(owner, now = Date.now()) {
  // ⚠️ THE BUDGET IS WALL CLOCK; `now` IS LOGICAL. They are not the same clock, and adding
  // PRUNE_BUDGET_MS to the caller's `now` conflated them — under an injected timestamp the
  // deadline landed in the past and the prune deleted NOTHING while reporting a backlog. The
  // suite caught it; in production it would have shown up as a store that never shrank.
  const deadline = Date.now() + PRUNE_BUDGET_MS;
  let deleted = 0, expired = 0, overflow = 0;
  try {
    const prefix = `q/${norm(owner)}/`;
    const { blobs } = await store().list({ prefix });
    const keys = (blobs || []).map((b) => b.key).sort(); // chronological for this layout

    const doomed = [];
    const keep = [];
    for (const k of keys) {
      const t = keyTime(k);
      if (Number.isFinite(t) && now - t >= QUOTE_TTL_MS) { doomed.push(k); expired++; }
      else keep.push(k);
    }
    if (keep.length > MAX_QUOTES_PER_OWNER) {
      const extra = keep.slice(0, keep.length - MAX_QUOTES_PER_OWNER);
      overflow = extra.length;
      doomed.push(...extra);
    }

    for (const k of doomed.slice(0, MAX_DELETES_PER_WRITE)) {
      if (Date.now() > deadline) break;
      try { await store().delete(k); deleted++; } catch { /* one stubborn key must not stop the rest */ }
    }
    if (doomed.length > deleted) {
      // ⭐ NO SILENT TRUNCATION. A backlog we did not finish is reported, not implied away.
      console.log(`[agent-quote] PRUNE partial owner=${norm(owner)} deleted=${deleted} remaining=${doomed.length - deleted}`);
    }
  } catch (e) {
    console.warn(`[agent-quote] PRUNE FAILED (swallowed) owner=${norm(owner)} — ${e?.message}`);
  }
  return { deleted, expired, overflow };
}

/**
 * Persist a priced plan. THIS MUST NEVER THROW.
 *
 * ⚠️ SAME RULE AS THE RECEIPT WRITE, FOR A DIFFERENT REASON. The receipt write may not throw
 * because the money has already moved. This one may not throw because it sits on the QUOTE
 * path: a diagnostics failure that broke quoting would take out the ability to propose a
 * plan at all, trading a real capability for an observation. Fire and continue — a missing
 * quote record degrades to exactly the state before this existed.
 *
 * ⚠️ AWAITED, not fire-and-forget. A Netlify function can freeze the moment its handler
 * returns, so an un-awaited write may simply never happen — the defect that stranded a
 * receipt for 7h58m. One small write costs ~100ms.
 *
 * Returns { written } for logging only. NO CALLER MAY BRANCH ON IT into an error response.
 */
export async function recordQuoteNeverThrows(quote) {
  try {
    if (!quote?.owner || !quote?.quoteId || !quote?.quotedAt) {
      console.warn("[agent-quote] refusing to write a quote with no owner/quoteId/quotedAt");
      return { written: false, reason: "missing_key_fields" };
    }
    const key = quoteKey(quote.owner, quote.quotedAt, quote.quoteId);
    await store().setJSON(key, quote);
    console.log(`[agent-quote] WROTE ${key} steps=${quote.stepCount} total=${quote.totalUsdc} fees=${quote.totalFeeUsdc}`);
    await pruneOwnerQuotes(quote.owner);
    return { written: true, key };
  } catch (e) {
    // Swallowed ON PURPOSE. See above.
    console.error(`[agent-quote] WRITE FAILED (swallowed) quoteId=${quote?.quoteId} — ${e?.message}`);
    return { written: false, reason: "write_error", detail: e?.message };
  }
}
