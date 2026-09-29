// halt.mjs — piece 5 step 3: the MANDATE-MACHINERY HALT LATCH. Pure (the store adapter is in _vault-mandate-store.mjs).
// Design: PROGRESS "FOR THE EXECUTOR PIECE: BEYOND_MANDATE_SHARES is NOT an ordinary flag" (T), 2026-09-28/29.
//
// ═══ WHAT IT STOPS, AND WHY ═══════════════════════════════════════════════════════════════════════
// BEYOND_MANDATE_SHARES means an exit burned MORE shares than the executor submitted, and the executor submits at most
// min(tracked, live) (share-limit.mjs). So the flag is a DEFECT — the executor's own invariant failed, or the vault did
// something the design does not model — never an outcome. It stops ALL mandate machinery: every mandate, deposits and
// exits, until a human has looked. The same class as the tick's CLOCK_BUG refusal.
//
// ═══ THE SHAPE: INCIDENT RECORDS, NOT A BOOLEAN ═══════════════════════════════════════════════════
// Each incident is its own CREATE-ONLY record `halt/<incidentId>` in the mandate store. The machinery is HALTED while
// any incident exists that is not listed in MANDATE_HALT_CLEARED. A second incident is a second record; nothing is ever
// overwritten, so the evidence of the first survives the second.
//
// ═══ ⛔ NEVER AUTO-CLEARED. HOW A HUMAN CLEARS IT ═════════════════════════════════════════════════════
// Clearing is a COMMIT: after investigating, a human adds the incident id to MANDATE_HALT_CLEARED below, with a comment
// saying who looked, what was found and what changed, and deploys. The incident record stays in the store as evidence.
// So clearing is reviewed, in git history, and takes a deploy — never a dashboard toggle, never code. No mandate code
// deletes a halt record (a source guard in test:mandatehalt).
// ⚠️ Residual, stated: anyone with access to the site's Blobs can DELETE an incident record, which un-halts. That also
// destroys the evidence and is not a toggle anyone would mistake for routine; the store has no finer access control.
//
// ⛔ UNKNOWN IS HALTED. A key under the prefix that does not parse as an incident id halts. An unreadable store halts
// (the adapter returns readable:false and every reader fails closed).

export const HALT_PREFIX = "halt/";
export const HALT_CODE = Object.freeze({ BEYOND_MANDATE_SHARES: "BEYOND_MANDATE_SHARES" });

// ⛔ THE ONLY WAY TO CLEAR A HALT. Add an incident id here IN A COMMIT, after a human has investigated it:
//   "<incidentId>", // <date> <who>: <what was found>, <what changed>
export const MANDATE_HALT_CLEARED = Object.freeze([]);

const ID = /^[A-Za-z0-9-]+$/;
export const haltKey = (incidentId) => `${HALT_PREFIX}${incidentId}`;

/** A key-safe id: the incident's time (ISO, ':' and '.' → '-') + the first 12 hex of the tx hash. */
export function incidentIdFor({ at, txHash }) {
  const t = new Date(at).toISOString().replace(/[:.]/g, "-");
  const h = typeof txHash === "string" && /^0x[0-9a-fA-F]{12}/.test(txHash) ? txHash.slice(2, 14).toLowerCase() : "nohash";
  return `${t}-${h}`;
}

/**
 * @param {{keys:string[], cleared?:readonly string[]}} a — every key listed under HALT_PREFIX
 * @returns {{halted:boolean, open:string[], cleared:string[], unparseable:string[], why:string|null}}
 */
export function haltStateFrom({ keys, cleared = MANDATE_HALT_CLEARED }) {
  const open = [], done = [], unparseable = [];
  for (const k of keys ?? []) {
    const id = String(k).startsWith(HALT_PREFIX) ? String(k).slice(HALT_PREFIX.length) : null;
    if (!id || !ID.test(id)) { unparseable.push(String(k)); continue; }
    (cleared.includes(id) ? done : open).push(id);
  }
  const halted = open.length > 0 || unparseable.length > 0;
  const why = !halted ? null
    : open.length ? `the mandate machinery is HALTED by ${open.length} uncleared incident(s): ${open.join(", ")}`
      : `the mandate machinery is HALTED: unrecognised halt record(s) ${unparseable.join(", ")}`;
  return { halted, open, cleared: done, unparseable, why };
}

/** The sentence the user is told (PROGRESS, T's wording). Never a success, never folded into a generic warning. */
export function haltUserMessage({ beyondMandateShares, usdcReceivedMinor }) {
  const usdc = typeof usdcReceivedMinor === "string" && /^\d+$/.test(usdcReceivedMinor)
    ? `, worth about ${(Number(usdcReceivedMinor) / 1e6).toFixed(2)} USDC in all from this exit` : "";
  return `Your mandate's exit redeemed ${beyondMandateShares} shares that were not the mandate's (shares you deposited yourself)${usdc}. ` +
    "They are in your agent wallet as USDC. This should not have happened; we have stopped all autonomous actions while it is investigated.";
}

/**
 * The incident for a classified exit outcome, or null when it carries no BEYOND_MANDATE_SHARES flag.
 * @param {{classified:object, context:{owner, id, walletAddress, vault, sharesToRedeem, sharesTracked, sharesTrackedGaps}, now:number}} a
 */
export function buildHaltIncident({ classified, context, now }) {
  if (!Array.isArray(classified?.flags) || !classified.flags.includes(HALT_CODE.BEYOND_MANDATE_SHARES)) return null;
  const at = new Date(now).toISOString();
  return {
    incidentId: incidentIdFor({ at: now, txHash: classified.txHash }),
    code: HALT_CODE.BEYOND_MANDATE_SHARES,
    at,
    owner: context?.owner ?? null, id: context?.id ?? null, walletAddress: context?.walletAddress ?? null, vault: context?.vault ?? null,
    txHash: classified.txHash ?? null, blockNumber: classified.blockNumber ?? null,
    // both share counts, and the tracked figure the executor used
    sharesToRedeem: context?.sharesToRedeem ?? null,
    beyondMandateShares: classified.beyondMandateShares ?? null,
    mandateSharesRedeemed: classified.mandateSharesRedeemed ?? null,
    sharesTracked: context?.sharesTracked ?? null,
    sharesTrackedGaps: context?.sharesTrackedGaps ?? null,
    usdcReceivedMinor: classified.usdcReceivedMinor ?? null,
    outcome: classified.outcome ?? null,
    userMessage: haltUserMessage({ beyondMandateShares: classified.beyondMandateShares ?? "?", usdcReceivedMinor: classified.usdcReceivedMinor }),
    clearedBy: "a commit adding this incidentId to MANDATE_HALT_CLEARED (shared/vault-mandate/halt.mjs)",
  };
}

/** Read the latch (the tick and the exit both call this); anything but a well-formed readable answer is unreadable (fail closed). */
export async function readHaltLatch(halt) {
  if (!halt || typeof halt.read !== "function") return { readable: false, why: "no halt latch reader: the latch cannot be checked" };
  let r;
  try { r = await halt.read(); } catch (e) { return { readable: false, why: `halt latch unreadable: ${String(e?.message ?? e)}` }; }
  if (!r || r.readable !== true || typeof r.halted !== "boolean") return { readable: false, why: r?.why ?? "the halt latch returned no clear answer" };
  return r;
}
