import { CRON_MS as MONEY_CRON_MS } from "./watch.mjs";

// ═══ THE WATCHER'S WATCHER — is ub-withdraw-sweep still running? ══════════════════════════════
//
// 🚨 THE GAP THIS CLOSES: the overdue alert lives INSIDE the sweeper. A sweeper that never runs
// cannot alert about itself — an alarm inside the thing that goes quiet inherits the silence it
// exists to break. So the sweeper writes a heartbeat every tick (including clean ones) and
// SOMETHING ELSE reads it.
//
// ═══ ⭐ WHY THIS LIVES IN strong-read-watch AND NOT IN dd-watch OR ITS OWN FUNCTION ═══════════
// strong-read-watch.mjs's own header already settled this argument once:
//
//     "dd-canary guards the DD ENGINE, which is going standalone and will leave this repo. This
//      guards the TIKPEMA APP'S money path… Folding the two together would mean the pause and
//      budget switches silently lose their monitor the day DD moves out."
//
// The same sentence applies verbatim to a user's exit from the unified balance. Putting it in
// dd-watch would mean USER-FUNDS monitoring leaves with DD, and would page the DD channel about
// money. Putting it in a NEW function would add a fourth schedule to guard without adding the
// independence that matters — the independence we need is from THE SWEEPER, and this function
// already has it: different process, different schedule, different store.
//
// ═══ ⚠️ THE HONEST BOUND, STATED UP FRONT ════════════════════════════════════════════════════
// This closes the sweeper-died gap. It does NOT close the general one: if strong-read-watch
// itself dies, nothing watches it. That is the level we accept, and it is the level the money
// path has always run at. Recursion has to stop somewhere; it stops here, deliberately and in
// writing, rather than by nobody asking.

/** Where the sweeper writes. ⭐ BARE NAME AT THE CALL SITE — never `getStore({ name, consistency })`;
 *  a store-level read default leaks into WRITES. Same rule as this monitor's own store. */
export const SWEEPER_STORE = "ub-withdrawals";
export const HEARTBEAT_KEY = "heartbeat";

/** ub-withdraw-sweep's schedule. ⚠️ Duplicated from netlify.toml by necessity (a function cannot
 *  read the TOML at runtime) — `gate:watch` is what keeps the two honest. */
export const SWEEPER_CRON = "*/30 * * * *";
export const SWEEPER_CRON_MS = Number(SWEEPER_CRON.match(/^\*\/(\d+) \* \* \* \*$/)[1]) * 60 * 1000;

/**
 * ⭐ DERIVED, NOT PICKED. Tolerate one missed tick, refuse to tolerate two — the same derivation
 * dd-watch uses for its grace against the canary period. Anything tighter pages on ordinary
 * scheduler jitter and trains everyone to ignore it; anything looser lets a dead sweeper sit
 * through most of a working day.
 *
 * ⚠️ THE MARGIN IS NOT DECORATION. Blob reads here are EVENTUALLY CONSISTENT (strong throws in
 * this project — see the monitor's header), so a fresh heartbeat can READ old. The margin absorbs
 * that; it cannot eliminate it, which is why every stale message says the read may be cached and
 * prints the timestamp it actually saw rather than only an age.
 */
export const STALE_AFTER_MS = SWEEPER_CRON_MS * 2 + 10 * 60 * 1000; // 70 min

/** Closed set. An unrecognised reason must map to CANNOT-VERIFY, never to "the sweeper is dead". */
export const HB_REASON = Object.freeze({
  ALIVE: "alive",
  STALE: "stale",                 // observed the sweeper's OWN timestamp, and it is old
  MISSING: "missing",             // no heartbeat key at all
  UNREADABLE: "unreadable",       // the store could not be read
  MALFORMED: "malformed",         // present but its `at` is not a usable timestamp
});

/** Reasons where we OBSERVED the problem, so a consequence claim is earned. */
export const OBSERVED_REASONS = Object.freeze([HB_REASON.STALE]);

/**
 * Judge one heartbeat read.
 *
 * ⭐⭐ THE RETURN HAS NO `ok` FIELD. It has `sweeperOk`. This is not a naming preference — it makes
 * the failure the caller must avoid UNSPELLABLE: no spread, merge or `Object.assign` of this
 * object into the monitor's record can clobber the money path's `ok`, because there is no `ok`
 * here to clobber. A property the type system enforces beats a property a comment requests.
 *
 * ⭐ ABSENCE IS NOT HEALTH. `missing`, `unreadable` and `malformed` all yield sweeperOk:false. A
 * heartbeat we could not find is not a sweeper we know is running — that is the recurring
 * fail-open family this repo keeps closing. They differ from `stale` only in what the MESSAGE is
 * allowed to claim.
 */
export function judgeHeartbeat({ hb, now = Date.now(), staleAfterMs = STALE_AFTER_MS } = {}) {
  const base = { checkedAt: new Date(now).toISOString(), staleAfterMs };

  if (hb === null || hb === undefined) {
    return { ...base, sweeperOk: false, reason: HB_REASON.MISSING, ageMs: null, heartbeatAt: null,
      detail: "no heartbeat key in the store — nothing is claiming the sweeper has run. This is " +
              "NOT a statement that it is dead; it is the absence of any statement at all." };
  }
  const at = typeof hb === "object" ? hb.at : null;
  const t = Date.parse(at ?? "");
  if (!Number.isFinite(t)) {
    return { ...base, sweeperOk: false, reason: HB_REASON.MALFORMED, ageMs: null, heartbeatAt: at ?? null,
      detail: "a heartbeat exists but its timestamp is unusable, so its age cannot be judged" };
  }

  const ageMs = now - t;
  // ⚠️ A heartbeat from the FUTURE is not fresh, it is malformed. Clock skew of a few minutes is
  // ordinary; a timestamp beyond one sweeper period ahead is a bug, and treating it as fresh
  // would let a broken writer permanently silence this check.
  if (ageMs < -SWEEPER_CRON_MS) {
    return { ...base, sweeperOk: false, reason: HB_REASON.MALFORMED, ageMs, heartbeatAt: at,
      detail: `the heartbeat is dated ${Math.round(-ageMs / 60000)} min in the FUTURE, so it cannot be trusted as fresh` };
  }

  if (ageMs > staleAfterMs) {
    return { ...base, sweeperOk: false, reason: HB_REASON.STALE, ageMs, heartbeatAt: at,
      open: hb.open ?? null, totalKeys: hb.totalKeys ?? null,
      detail: `the sweeper last reported ${Math.round(ageMs / 60000)} min ago; it runs every ` +
              `${SWEEPER_CRON_MS / 60000} min, so it has missed at least two ticks` };
  }
  return { ...base, sweeperOk: true, reason: HB_REASON.ALIVE, ageMs, heartbeatAt: at,
    open: hb.open ?? null, totalKeys: hb.totalKeys ?? null,
    detail: `the sweeper reported ${Math.round(ageMs / 60000)} min ago` };
}

/**
 * Read and judge, WITHOUT EVER THROWING OR REJECTING.
 *
 * 🚨 THIS IS THE ADDITIVE CONTRACT, AND IT IS PINNED BY A SUITE RATHER THAN PROMISED HERE.
 * strong-read-watch is load-bearing and 212/0. A heartbeat read that threw would take the money
 * path's own verdict down with it — this check would then have made the thing it monitors LESS
 * reliable, which is the worst possible outcome for a monitor. `read` is injected so the suite
 * can hand it a thrower, a rejecter and a garbage-returner and assert the property directly.
 */
export async function observeSweeper({ read, now = Date.now(), staleAfterMs = STALE_AFTER_MS }) {
  try {
    const hb = await read();
    return judgeHeartbeat({ hb, now, staleAfterMs });
  } catch (e) {
    return {
      checkedAt: new Date(now).toISOString(), staleAfterMs,
      sweeperOk: false, reason: HB_REASON.UNREADABLE, ageMs: null, heartbeatAt: null,
      detail: `the ${SWEEPER_STORE} store could not be read (${String(e?.name || "Error")}), so nothing ` +
              `can be said about the sweeper — INDETERMINATE, never "it is running".`,
    };
  }
}

/**
 * ⭐⭐ THE COMPOSITION POINT, EXTRACTED SO THE ADDITIVE PROPERTY IS TESTABLE.
 *
 * The monitor's `ok` is the MONEY PATH's verdict and nothing else. Written as one function with
 * one assertion behind it, rather than as care distributed across the handler — "wrapped and
 * never-throws" is exactly the sort of claim that should be pinned, not trusted, on a monitor
 * this much depends on.
 */
export function composeVerdict({ moneyJudgement, sweeperObservation }) {
  return {
    ok: moneyJudgement.ok,           // ⭐ money path ALONE. Never `&&`, never `||`.
    reason: moneyJudgement.reason,
    sweeper: sweeperObservation ?? null,
  };
}

/**
 * ═══ 🚨 TWO CONCERNS, TWO PREVS ══════════════════════════════════════════════════════════════
 * The existing decideNotify keys on ONE prevOk. If both concerns shared it, a money path
 * RECOVERING would emit "recovered" and mark the transition consumed while the sweeper was still
 * stale — silencing a live problem with an unrelated fix. The reverse is just as bad: a sweeper
 * recovering would suppress a money-path regression.
 *
 * ⭐ So the sweeper carries its OWN prev and its OWN lastNotifiedAt on the same record. The
 * transition FUNCTION is shared (one implementation, no drift); the STATE it reads is not.
 */
export function sweeperPrev(prev) {
  const ok = prev?.sweeper && typeof prev.sweeper.sweeperOk === "boolean" ? prev.sweeper.sweeperOk : null;
  return { prevOk: ok, lastNotifiedAt: prev?.sweeperLastNotifiedAt ?? null };
}

const HEADLINE = Object.freeze({
  [HB_REASON.STALE]:      "🕳️ UB SWEEPER HAS STOPPED REPORTING",
  [HB_REASON.MISSING]:    "🕳️ UB SWEEPER — NO HEARTBEAT AT ALL",
  [HB_REASON.UNREADABLE]: "🕳️ UB SWEEPER — CANNOT VERIFY",
  [HB_REASON.MALFORMED]:  "🕳️ UB SWEEPER — HEARTBEAT UNUSABLE",
});

/**
 * ⭐ ITS OWN HEADLINE, so nobody reads a sweeper alert as a strong-read alert. Same channel
 * (both are money), different first line — the thing a human sees at 3am is the headline.
 *
 * ⚠️ THE CONSEQUENCE PARAGRAPH IS EARNED, NOT ASSUMED — the lesson this monitor's first wrong
 * alert taught. Only `stale` observed the sweeper's own timestamp; the rest observed an absence,
 * and an absence does not license "withdrawals are not completing".
 */
export function sweeperMessage({ kind, observation }) {
  const o = observation;
  const observed = OBSERVED_REASONS.includes(o.reason);

  if (kind === "recovered") {
    return [
      "✅ UB SWEEPER IS REPORTING AGAIN",
      `The heartbeat is ${Math.round((o.ageMs ?? 0) / 60000)} min old (\`${o.heartbeatAt}\`).`,
      "⚠️ Recovery of the SWEEPER is not recovery of any withdrawal it missed. Check the store for " +
      "records still open past their maturity — the overdue alert only fires from ticks that ran.",
    ].join("\n");
  }

  const lines = [HEADLINE[o.reason] ?? HEADLINE[HB_REASON.UNREADABLE], "", o.detail, ""];

  if (observed) {
    lines.push(
      "**What this costs.** Step 3 of the unified-balance exit is driven by this sweeper. While it " +
      "is not running, a matured withdrawal is NOT completed and the overdue alert cannot fire — " +
      "the alarm lives inside the thing that has gone quiet. Someone's money sits behind an " +
      "expired clock, and nothing else will say so.",
    );
  } else {
    // 🚨 NO CONSEQUENCE CLAIM. We did not observe the sweeper failing; we failed to observe it.
    lines.push(
      "**We have not observed a failure — we have failed to observe.** This says nothing about " +
      "whether withdrawals are completing. The likeliest cause is this check's own reach into the " +
      `\`${SWEEPER_STORE}\` store, not the sweeper.`,
    );
  }

  lines.push(
    "",
    `**Check directly:** \`netlify blobs:get ${SWEEPER_STORE} ${HEARTBEAT_KEY}\`, then the function ` +
    "log for `ub-withdraw-sweep`.",
    `⚠️ Read as of \`${o.checkedAt}\`; heartbeat \`${o.heartbeatAt ?? "none"}\`. Blob reads here are ` +
    "eventually consistent, so a fresh heartbeat can read old — confirm before acting.",
  );
  if (kind === "still-failing") lines.push("_(reminder — this has been unresolved for a while)_");
  return lines.join("\n");
}
