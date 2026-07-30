#!/usr/bin/env node
// verify-watch-promotion-gate.mjs — does a REAL, REACHABLE push channel exist in a given context?
//
//   node scripts/verify-watch-promotion-gate.mjs                       # production (the gate)
//   node scripts/verify-watch-promotion-gate.mjs --context deploy-preview
//   node scripts/verify-watch-promotion-gate.mjs --no-network          # syntax only; still FAILS
//
// ═══ WHY THIS IS A GATE AND NOT A CODE DEFAULT ═══════════════════════════════════════════════
// strong-read-watch resolves its webhook from WATCH_ALERT_WEBHOOK and NOTHING ELSE — no fallback,
// so every context is an explicit act. That is the right default, and it has one consequence worth
// gating: an unset variable means the monitor records "cannot reach anyone" and pushes nothing. A
// monitor with no push channel is a log file. It looks healthy precisely because it is silent.
//
// So a channel that does not resolve is a FAILED PROMOTION, exactly as UNCALIBRATED is a failure
// and not an unknown. Absence must not read as safe — including the absence of the channel whose
// job is to report absences.
//
// ═══ 🚨 THE GATE'S OWN HISTORY OF THIS EXACT DEFECT ══════════════════════════════════════════
// Every tightening below came from something that actually got stored and looked fine:
//
//   1. UNSET, but `netlify env:get` prints "No value set …" to STDOUT and EXITS 0. Reading the
//      exit code makes unset look set; capturing stdout makes the sentence look like a value.
//   2. The literal string `<url>` — the placeholder from the example command, pasted verbatim.
//      Netlify stored it. From the dashboard the variable looked configured.
//   3. A discord.gg INVITE LINK. It is a perfectly well-formed https:// URL, so a syntax check
//      that only required an https:// prefix ACCEPTED it and the gate PASSED. An invite link can
//      never receive a webhook post; the monitor would have been silent forever.
//
// (3) is the important one, because it is the gate committing the very error it exists to catch:
// treating URL-SHAPED as USABLE. A syntax check cannot close that. So the gate now does a LIVE,
// NON-DESTRUCTIVE GET and requires the channel to answer for itself.
//
// ⭐ A GET ON A DISCORD WEBHOOK IS READ-ONLY. `GET /api/webhooks/{id}/{token}` returns the webhook
// object as JSON and POSTS NOTHING. Only a POST delivers a message. So this proves the channel
// EXISTS and is reachable without putting a test message in anyone's channel — the verification
// method does not mutate.
//
// ⚠️ NEVER PRINTS THE VALUE. A webhook URL is a credential: anyone holding it can post to the
// channel. This reports a truncated sha256 fingerprint, plus the webhook's own name/channel_id
// from the metadata — those are identifiers, not credentials, and they are what actually answers
// "did this land in the dedicated alerts channel or in the feedback channel?"

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { EXPECTED_CRON, FUNCTION_NAME, DEFAULT_TARGET_URL, DEFAULT_STORE_NAME, checkEnvOverride }
  from "../shared/strong-read-watch/watch.mjs";

/**
 * 🚨 STANDING CONSTRAINT: THIS VARIABLE MUST NEVER BE SET `--secret`.
 *
 * `netlify env:set --secret` makes a value unreadable afterwards. That is normally good hygiene for
 * a credential, and here it would BREAK THE GATE: the existence check below has to READ the URL to
 * perform the live GET. A secret value would come back unset/unparseable, the gate would refuse a
 * perfectly good channel — or worse, a future "fix" would relax the parser to accommodate it and
 * we would be back to a syntax check that cannot tell a real channel from a well-formed dead one.
 * That is the exact false-negative class this whole gate exists to eliminate.
 *
 * The credential hygiene here comes from FINGERPRINT-NOT-PRINT, not from unreadability: the value
 * is never logged, only its truncated sha256. Copying it between contexts is done through a shell
 * variable, verified by comparing fingerprints, never by echoing the URL.
 */
export const WATCH_WEBHOOK_VAR = "WATCH_ALERT_WEBHOOK";
const PROBE_TIMEOUT_MS = 8000;

/**
 * ═══ 🚨 IS THE SCHEDULE ACTUALLY DECLARED? ═══════════════════════════════════════════════════
 * Proving this monitor on a draft REQUIRES commenting the schedule out, because Netlify returns
 * 403 for HTTP invocation of a scheduled function and crons do not fire on drafts — unreachable by
 * both routes. So the restore step is a manual act, and a manual act gets forgotten.
 *
 * ⭐ THE BUILD STAMP CANNOT CATCH IT. netlify.toml is outside the stamp's hashed surface
 * (netlify/functions + shared), which is exactly why a schedule-off draft and a schedule-on prod
 * deploy share an identical tree hash — the property that makes proving-on-a-draft honest. The same
 * property means a forgotten restore produces a MATCHING hash, a PASSING build-provenance check,
 * and a monitor that never runs. Silently. The guardrail that proved D is structurally blind here.
 *
 * ⚠️ A COMMENTED-OUT BLOCK MUST NOT READ AS "MISSING", AND MUST NEVER READ AS PRESENT. TOML
 * comments are `#`-prefixed, and a naive regex over the raw file happily matches inside a comment.
 * So comment lines are STRIPPED FIRST, then matched — and if the block exists only in the stripped-
 * out text, that gets its own reason code, because "you commented it out for the draft proof and
 * did not put it back" is a different instruction to the reader than "it was never there".
 *
 * @returns {{ok:boolean, reason:string, detail:string, cron:string|null}}
 */
export function checkScheduleDeclared(tomlText, { functionName = FUNCTION_NAME, expectedCron = EXPECTED_CRON } = {}) {
  const no = (reason, detail, cron = null) => ({ ok: false, reason, detail, cron });
  const blockRe = new RegExp(
    `\\[functions\\."${functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\]\\s*\\n\\s*schedule\\s*=\\s*"([^"]+)"`
  );

  const raw = String(tomlText ?? "");
  // Drop whole-line comments. A trailing comment after a value is harmless and stays.
  const live = raw
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  const found = live.match(blockRe);
  if (!found) {
    if (blockRe.test(raw.split("\n").map((l) => l.replace(/^\s*#\s?/, "")).join("\n"))) {
      return no("commented-out",
        `[functions."${functionName}"] is present but COMMENTED OUT. This is the draft-proof state — ` +
        `the schedule was removed so the function could be invoked over HTTP, and it was never ` +
        `restored. The build stamp cannot see this: netlify.toml is not in the hashed surface, so ` +
        `the tree hash matches a scheduled build exactly. Uncomment it before promoting.`);
    }
    if (new RegExp(`\\[functions\\."${functionName}"\\]`).test(live)) {
      return no("no-schedule-key", `[functions."${functionName}"] exists but declares no schedule key`);
    }
    return no("block-missing", `netlify.toml has no [functions."${functionName}"] schedule block at all`);
  }
  if (found[1] !== expectedCron) {
    return no("cron-mismatch",
      `netlify.toml schedules ${JSON.stringify(found[1])} but this monitor is designed for ` +
      `${JSON.stringify(expectedCron)} — the ordering invariant MIN_RERUN < cron < TTL is calibrated ` +
      `to the latter`, found[1]);
  }
  return { ok: true, reason: "scheduled", detail: `netlify.toml registers ${functionName} on ${found[1]}, uncommented`, cron: found[1] };
}

/** Hosts whose /api/webhooks/ path can actually receive a post. UNKNOWN HOSTS FAIL: pointing this
 *  at Slack or elsewhere must be a deliberate extension here, not something a typo achieves. */
const WEBHOOK_URL_RE =
  /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/(\d+)\/([\w-]+)$/;

/** Invite links are the trap that got through. Recognised SPECIFICALLY so the message names the
 *  mistake instead of saying "malformed", which sends someone checking for a typo in a URL that
 *  has none. */
const INVITE_RE = /^https:\/\/(?:www\.)?(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)/i;

/**
 * Is this string a usable webhook ENDPOINT? Shape only — existence is a separate question.
 * @returns {{ok:boolean, reason:string, detail:string, id:string|null}}
 */
export function classifyWebhookUrl(value) {
  const v = String(value ?? "").trim();
  const no = (reason, detail) => ({ ok: false, reason, detail, id: null });

  if (v === "") return no("empty-value", "the value is empty");
  if (/^<[^>]*>$/.test(v)) {
    return no("placeholder-literal",
      `the stored value is the literal placeholder ${JSON.stringify(v)} — the env:set ran with the example text instead of a real webhook URL`);
  }
  if (INVITE_RE.test(v)) {
    return no("invite-link",
      "this is a Discord server INVITE link, not a webhook endpoint. It is a valid https:// URL and " +
      "a syntax check would accept it, but it can never receive a webhook post — the monitor would " +
      "be silent forever. A webhook URL looks like https://discord.com/api/webhooks/<id>/<token> " +
      "and comes from Channel Settings → Integrations → Webhooks, not from the Invite button.");
  }
  if (!/^https:\/\/\S+$/.test(v)) return no("not-a-url", "the value is not a bare https:// URL");
  if (/^https:\/\/(example\.|localhost|127\.0\.0\.1)/i.test(v)) {
    return no("placeholder", "the value looks like a placeholder host, not a real channel");
  }
  const m = v.match(WEBHOOK_URL_RE);
  if (!m) {
    return no("not-a-webhook-url",
      "the value is a URL but not a Discord webhook endpoint (expected /api/webhooks/<id>/<token>). " +
      "URL-shaped is not usable — supporting another provider means extending WEBHOOK_URL_RE deliberately.");
  }
  return { ok: true, reason: "shape-ok", detail: "the value is a well-formed Discord webhook endpoint", id: m[1] };
}

/**
 * Interpret one `netlify env:get` invocation, fail-closed, then classify the value's shape.
 * @returns {{resolved:boolean, value:string|null, reason:string, detail:string}}
 */
export function interpretEnvGet(r) {
  const no = (reason, detail) => ({ resolved: false, value: null, reason, detail });

  if (r?.error) return no("cli-failed", `the CLI could not be run (${r.error})`);
  if (r?.status !== 0) return no("cli-nonzero", `netlify env:get exited ${r?.status}`);

  const out = typeof r.stdout === "string" ? r.stdout : "";
  if (out.trim() === "") return no("empty-output", "the CLI printed nothing at all");

  // ⭐ THE TRAP, HANDLED EXPLICITLY: this sentence arrives on STDOUT at EXIT 0.
  if (/no value set/i.test(out)) return no("unset", "the variable is not set in this context");

  const candidate = out.split("\n").map((l) => l.trim()).find((l) => l !== "" && !/^⬥|^VERSION|^USAGE/.test(l));
  if (candidate === undefined) return no("unparseable", "the output contained no value line");

  const shape = classifyWebhookUrl(candidate);
  if (!shape.ok) return no(shape.reason, shape.detail);
  return { resolved: true, value: candidate, reason: "shape-ok", detail: shape.detail };
}

/**
 * Interpret the live GET. A real webhook answers 200 with its own object; a revoked or fabricated
 * one answers 401/404. Anything else is a failure, never a pass.
 * @returns {{exists:boolean, reason:string, detail:string, meta:object|null}}
 */
export function interpretWebhookProbe(res) {
  const no = (reason, detail) => ({ exists: false, reason, detail, meta: null });

  if (res?.timedOut) return no("timeout", "the webhook endpoint did not answer before the deadline");
  if (res?.networkError) return no("unreachable", `the webhook endpoint could not be reached (${res.networkError})`);
  if (res?.status === 404) return no("webhook-not-found", "Discord says this webhook does not exist (404) — deleted, or never existed");
  if (res?.status === 401 || res?.status === 403) {
    return no("webhook-unauthorized", `Discord rejected the token (${res.status}) — the webhook was regenerated or revoked`);
  }
  if (res?.status !== 200) return no("unexpected-response", `the endpoint answered HTTP ${res?.status}`);

  let body;
  try {
    body = JSON.parse(String(res.body ?? ""));
  } catch {
    return no("unexpected-response", "the endpoint answered 200 but not with JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.id !== "string") {
    return no("unexpected-response", "the 200 response is not a webhook object (no id)");
  }
  return {
    exists: true,
    reason: "live",
    detail: "the webhook exists and answered its own metadata to a read-only GET",
    // Identifiers, not credentials — these are what tell you WHICH channel this is.
    meta: { name: body.name ?? null, channelId: body.channel_id ?? null, guildId: body.guild_id ?? null, type: body.type ?? null },
  };
}

/** Truncated fingerprint. Enough to compare two channels; useless for posting to one. */
export const fingerprint = (v) => createHash("sha256").update(String(v)).digest("hex").slice(0, 12);

const readVar = (name, context, { raw = false } = {}) => {
  try {
    const stdout = execFileSync("npx", ["netlify", "env:get", name, "--context", context], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    // raw mode: these are not webhooks, so skip the webhook-shape classification and hand back the
    // literal value (or "" when unset) for an exact comparison.
    if (raw) {
      const line = stdout.split("\n").map((l) => l.trim()).find((l) => l !== "");
      return { value: /no value set/i.test(stdout) ? "" : (line ?? "") };
    }
    return interpretEnvGet({ stdout, status: 0 });
  } catch (err) {
    if (raw) return { value: "" };
    return interpretEnvGet({
      stdout: err?.stdout ?? "", status: err?.status ?? null,
      error: err?.status === undefined ? String(err?.code || err?.name || "spawn-failed") : null,
    });
  }
};

/** Read-only GET. Never POSTs, so it cannot put a message in anyone's channel. */
async function probeWebhook(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", signal: ctl.signal, headers: { "user-agent": "tikpema-watch-gate/1" } });
    const body = await res.text().catch(() => "");
    return interpretWebhookProbe({ status: res.status, body, networkError: null, timedOut: false });
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    return interpretWebhookProbe({ status: null, body: null, timedOut, networkError: timedOut ? null : String(err?.name || "Error") });
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const i = process.argv.indexOf("--context");
  const context = i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : "production";
  const noNetwork = process.argv.includes("--no-network");

  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  STRONG-READ WATCH — PROMOTION GATE                                   ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");
  console.log(`\ncontext under test: ${context}\n`);

  // Cheapest check first, and the one the build stamp is blind to. Gating ONLY for production: a
  // deploy-preview draft legitimately has the schedule commented out, because that is the only way
  // to invoke a scheduled function at all. Promotion is the act that needs it back.
  const isProd = context === "production";
  let schedule;
  try {
    schedule = checkScheduleDeclared(readFileSync(new URL("../netlify.toml", import.meta.url), "utf8"));
  } catch (err) {
    schedule = { ok: false, reason: "toml-unreadable", detail: `could not read netlify.toml (${err?.code || err?.name})`, cron: null };
  }
  const schedMark = schedule.ok ? "✅" : isProd ? "❌" : "⚠️ ";
  console.log(`  ${schedMark} schedule  — ${schedule.reason}: ${schedule.detail}`);
  if (!schedule.ok && !isProd) {
    console.log("     (not gating: this is not the production context. It MUST be restored before promotion.)");
  }

  // ⭐ LEFTOVER DRAFT-PROOF OVERRIDES. The HOTFIX fixture is a static asset that ships to prod, so a
  // stale WATCH_TARGET_URL would make the monitor watch a file that always says HOTFIX — a permanent
  // fake outage, paging hourly, while the real money path went unwatched. Unsetting these has been a
  // manual step on every proof; this enforces it. Legitimate outside production.
  const overrides = [
    ["WATCH_TARGET_URL", DEFAULT_TARGET_URL],
    ["WATCH_STORE", DEFAULT_STORE_NAME],
  ].map(([name, expected]) => {
    const r = readVar(name, context, { raw: true });
    return { name, ...checkEnvOverride(name, r.value, expected) };
  });
  for (const o of overrides) {
    const mark = o.ok ? "✅" : isProd ? "❌" : "⚠️ ";
    console.log(`  ${mark} override  — ${o.name}: ${o.reason}`);
    if (!o.ok) console.log(`     ${o.detail}`);
  }
  if (overrides.some((o) => !o.ok) && !isProd) {
    console.log("     (not gating: not the production context. These MUST be cleared before promotion.)");
  }

  const watch = readVar(WATCH_WEBHOOK_VAR, context);
  console.log(`  ${watch.resolved ? "✅" : "❌"} shape     — ${watch.reason}: ${watch.detail}`);

  let live = null;
  if (watch.resolved) {
    console.log(`     fingerprint: ${fingerprint(watch.value)}  (value withheld)`);
    if (noNetwork) {
      live = { exists: false, reason: "unverified", detail: "--no-network was passed, so existence was NOT checked. A shape check cannot tell a real channel from a well-formed dead one.", meta: null };
    } else {
      live = await probeWebhook(watch.value);
    }
    console.log(`  ${live.exists ? "✅" : "❌"} existence — ${live.reason}: ${live.detail}`);
    if (live.meta) {
      console.log(`     channel: name=${JSON.stringify(live.meta.name)} channel_id=${live.meta.channelId}`);
    }
  }

  const pass = watch.resolved && live?.exists === true && (schedule.ok || !isProd)
    && (overrides.every((o) => o.ok) || !isProd);

  // Informational, not a pass/fail criterion. Which channel it is, is the operator's call — but if
  // it is the SAME one the in-app feedback form posts to, say so now rather than during an outage.
  if (pass) {
    const feedback = readVar("DISCORD_FEEDBACK_WEBHOOK", context);
    if (feedback.resolved && fingerprint(feedback.value) === fingerprint(watch.value)) {
      console.log("\n  ⚠️  NOTE: this is the SAME webhook the in-app feedback form posts to.");
      console.log("      Money-path alerts will arrive interleaved with user feedback.");
    } else if (feedback.resolved) {
      console.log("\n  ✅ a DIFFERENT channel from the feedback webhook (dedicated alerts channel).");
    }
  }

  console.log("\n╔══════════════════════════════════════════════════════════════════════");
  if (pass) {
    console.log(`║  ✅ GATE PASSES — real reachable channel${isProd ? " + schedule declared" : ""} in ${context}`);
    console.log("║");
    console.log("║  ⚠️  THE GATE PROVES THE SCHEDULE IS DECLARED, NOT THAT IT FIRES. Cron");
    console.log("║  registration is only proven AFTER promotion, by watching the record's");
    console.log("║  producedAt advance on the real interval. Until you have seen it move");
    console.log("║  twice, treat the monitor as unproven in production.");
  } else {
    console.log(`║  ❌ GATE FAILS in ${context}. DO NOT PROMOTE.`);
    if (isProd && !schedule.ok) {
      console.log("║");
      console.log(`║  SCHEDULE (${schedule.reason}): a monitor that is never invoked reports nothing,`);
      console.log("║  and reporting nothing is indistinguishable from a healthy money path.");
      console.log("║  The build stamp CANNOT catch this — netlify.toml is outside the hashed");
      console.log("║  surface, so the tree hash matches a scheduled build exactly. Restore:");
      console.log(`║    [functions."${FUNCTION_NAME}"]`);
      console.log(`║      schedule = "${EXPECTED_CRON}"`);
    }
    if (!watch.resolved || live?.exists !== true) {
      console.log("║");
      console.log('║  CHANNEL: without one the monitor records "cannot reach anyone" and stays');
      console.log("║  silent, which is also indistinguishable from a healthy money path:");
      console.log(`║    netlify env:set ${WATCH_WEBHOOK_VAR} "<the webhook URL>" --context ${context}`);
      console.log("║  NEVER --context all. The URL comes from the channel's");
      console.log("║  Settings → Integrations → Webhooks, NOT from the server Invite button.");
    }
  }
  console.log("╚══════════════════════════════════════════════════════════════════════");
  process.exit(pass ? 0 : 1);
}

// Only run when invoked directly — the suite imports the pure functions to test the trap cases.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) await main();
