// dca-rehearsal-create.mjs — REHEARSAL TOOLING, NOT SHIPPED APP CODE.
//
// A thin CLI to create / list / cancel a test DCA mandate against the DEPLOYED
// dca-create / dca-list / dca-cancel endpoints, so the live rehearsal can run
// without hand-crafting curl or pasting session tokens into a shell.
//
// ⚠️ Lives only in scripts/. Imports NOTHING from the app; is imported by nothing.
//    Do not wire this into the app, and do not deploy it.
//
// ── SECURITY POSTURE (verified against the endpoint before writing this) ──────────
//   `owner` and `walletAddress` are SERVER-DERIVED from the authenticated session
//   (dca-create.mjs: requireSession → ensureOwnerWallet → owner: session.address).
//   The request body supplies ONLY bounds. So this script CANNOT and MUST NOT send
//   an owner — it sends bounds + a Bearer session token it does not mint. You paste
//   a real session token from your authenticated browser session (SESSION_TOKEN);
//   this script never touches SESSION_SECRET and never forges a token.
//
// ── USAGE ─────────────────────────────────────────────────────────────────────────
//   SESSION_TOKEN=<paste-from-browser> node scripts/dca-rehearsal-create.mjs create \
//       --in USDC --out EURC --amount 1 --cadence 1h --budget 3 --end 2h
//   SESSION_TOKEN=<paste> node scripts/dca-rehearsal-create.mjs list
//   SESSION_TOKEN=<paste> node scripts/dca-rehearsal-create.mjs cancel --id <uuid>
//
//   Add --json for raw JSON output. Override host with DCA_BASE (default: prod).
//
// The client-side checks below MIRROR validateAndBuildMandate so an obviously-bad
// mandate fails before the network call, with the same messages. The SERVER remains
// authoritative — this script only rejects, never clamps.

import crypto from "node:crypto";

// Default to prod (where the scheduler is proven firing). Overridable via DCA_BASE.
const BASE = (process.env.DCA_BASE || "https://app.tikpema.xyz").replace(/\/+$/, "");
const fnUrl = (name) => `${BASE}/.netlify/functions/${name}`;

// Bounds that mirror the endpoint's constants (_dca.mjs). Kept in sync by hand;
// the server re-validates, so drift here can only make this script stricter.
const MIN_CADENCE_MS = 60 * 60 * 1000; // 1h floor (MIN_CADENCE_MS)
const TOKENS = ["USDC", "EURC"];       // the only pair Arc testnet swaps (SWAP_TOKENS)

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// --- tiny arg parser: --flag value ------------------------------------------------
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) die(`unexpected argument: ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) die(`--${key} needs a value`);
    out[key] = next;
    i++;
  }
  return out;
}

// "1h" / "90m" / "45s" / "3d" / bare-ms → milliseconds. Rejects garbage.
function parseDuration(s) {
  if (s == null) return NaN;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(String(s).trim());
  if (!m) return NaN;
  const n = Number(m[1]);
  const unit = m[2] || "ms";
  const mult = { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[unit];
  return n * mult;
}

// --end accepts a duration-from-now ("2h", "3d") OR an ISO date; returns epoch ms.
function parseEnd(s, now) {
  const dur = parseDuration(s);
  if (Number.isFinite(dur)) return now + dur;
  const t = Date.parse(String(s));
  if (Number.isFinite(t)) return t;
  return NaN;
}

function requireToken() {
  const t = process.env.SESSION_TOKEN;
  if (!t || !t.trim()) {
    die(
      "SESSION_TOKEN not set. Paste a session token from your authenticated browser " +
        "session (30-min TTL). This script does NOT mint tokens."
    );
  }
  return t.trim();
}

async function call(name, method, body) {
  const token = requireToken();
  const res = await fetch(fnUrl(name), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let payload = null;
  const text = await res.text();
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { status: res.status, payload };
}

// Human-readable outcome that never dresses a failure as a success.
function report({ status, payload }, opts) {
  if (opts.json) {
    console.log(JSON.stringify({ status, payload }, null, 2));
    return status >= 200 && status < 300 ? 0 : 1;
  }
  if (status === 401) {
    console.error("✗ 401 — session token missing/expired. Re-authenticate and re-paste SESSION_TOKEN.");
    return 1;
  }
  if (status === 202) {
    console.error(`⏳ 202 — ${payload?.message || "agent wallet provisioning; retry shortly."}`);
    return 1;
  }
  if (status >= 400) {
    console.error(`✗ ${status} — ${payload?.error || JSON.stringify(payload)}`);
    return 1;
  }
  return 0; // caller prints the success detail
}

function summarizeMandate(m) {
  if (!m) return "(no mandate in response)";
  return [
    `  id:        ${m.id}`,
    `  owner:     ${m.owner}          (server-derived)`,
    `  wallet:    ${m.walletAddress}  (server-derived)`,
    `  pair:      ${m.tokenIn} → ${m.tokenOut}`,
    `  perTick:   ${m.perTickAmount}`,
    `  cadence:   ${m.cadenceMs} ms (${m.cadenceMs / 3600000}h)`,
    `  budget:    ${m.totalBudgetAmount} (spent ${m.spentAmount})`,
    `  endAt:     ${m.endAt} (${new Date(m.endAt).toISOString()})`,
    `  status:    ${m.status}`,
  ].join("\n");
}

// --- commands ---------------------------------------------------------------------
async function cmdCreate(flags, opts) {
  const now = Date.now();
  const tokenIn = String(flags.in || "").toUpperCase();
  const tokenOut = String(flags.out || "").toUpperCase();
  const perTickAmount = Number(flags.amount);
  const cadenceMs = parseDuration(flags.cadence);
  const totalBudgetAmount = Number(flags.budget);
  const endAt = parseEnd(flags.end, now);

  // Client-side pre-checks mirroring validateAndBuildMandate (server is authoritative).
  if (!TOKENS.includes(tokenIn) || !TOKENS.includes(tokenOut) || tokenIn === tokenOut) {
    die(`--in/--out must be two distinct tokens from ${TOKENS.join("/")}`);
  }
  if (!Number.isFinite(perTickAmount) || perTickAmount <= 0) {
    die("--amount (perTickAmount) must be a positive number");
  }
  if (!Number.isFinite(cadenceMs) || cadenceMs < MIN_CADENCE_MS) {
    die(`--cadence must be at least 1h (got ${flags.cadence ?? "nothing"})`);
  }
  if (!Number.isFinite(totalBudgetAmount) || totalBudgetAmount < perTickAmount) {
    die("--budget (totalBudgetAmount) must be >= --amount");
  }
  if (!Number.isFinite(endAt) || endAt <= now) {
    die(`--end must be a future duration ("2h") or ISO date (got ${flags.end ?? "nothing"})`);
  }

  // Caller-supplied collision-free id, as the endpoint requires.
  const id = crypto.randomUUID();

  // NOTE: no owner / walletAddress in the body — the server derives both.
  const body = { id, tokenIn, tokenOut, perTickAmount, cadenceMs, totalBudgetAmount, endAt };

  if (!opts.json) {
    console.log(`→ POST ${fnUrl("dca-create")}`);
    console.log(`  body (bounds only): ${JSON.stringify(body)}`);
  }
  const res = await call("dca-create", "POST", body);
  const code = report(res, opts);
  if (code === 0 && !opts.json) {
    console.log(`✓ 201 — mandate created:`);
    console.log(summarizeMandate(res.payload?.mandate));
    console.log(`\n  to cancel: node scripts/dca-rehearsal-create.mjs cancel --id ${id}`);
  }
  process.exit(code);
}

async function cmdList(_flags, opts) {
  if (!opts.json) console.log(`→ GET ${fnUrl("dca-list")}`);
  const res = await call("dca-list", "GET", null);
  const code = report(res, opts);
  if (code === 0 && !opts.json) {
    const mandates = res.payload?.mandates || [];
    console.log(`✓ 200 — ${mandates.length} mandate(s) for your session:`);
    for (const m of mandates) console.log(summarizeMandate(m) + "\n");
  }
  process.exit(code);
}

async function cmdCancel(flags, opts) {
  const id = flags.id;
  if (!id || typeof id !== "string") die("cancel needs --id <mandate-uuid>");
  if (!opts.json) console.log(`→ POST ${fnUrl("dca-cancel")} { id: ${id} }`);
  const res = await call("dca-cancel", "POST", { id });
  const code = report(res, opts);
  if (code === 0 && !opts.json) {
    if (res.payload?.alreadyClosed) {
      console.log(`✓ 200 — already terminal (${res.payload.mandate?.status}); cancel is idempotent.`);
    } else {
      console.log(`✓ 200 — cancelled:`);
      console.log(summarizeMandate(res.payload?.mandate));
    }
  }
  process.exit(code);
}

// --- entrypoint -------------------------------------------------------------------
function usage() {
  console.log(
    [
      "dca-rehearsal-create.mjs — create/list/cancel a test DCA mandate (rehearsal tooling)",
      "",
      "Requires: SESSION_TOKEN=<paste from authenticated browser session>",
      "Optional: DCA_BASE=<host>  (default https://app.tikpema.xyz)   --json  (raw output)",
      "",
      "  create --in USDC --out EURC --amount 1 --cadence 1h --budget 3 --end 2h",
      "  list",
      "  cancel --id <uuid>",
    ].join("\n")
  );
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    usage();
    process.exit(cmd ? 0 : 1);
  }
  // Pull --json out of the flag stream before parsing the rest.
  const jsonIdx = rest.indexOf("--json");
  const opts = { json: jsonIdx !== -1 };
  if (jsonIdx !== -1) rest.splice(jsonIdx, 1);
  const flags = parseFlags(rest);

  if (cmd === "create") return cmdCreate(flags, opts);
  if (cmd === "list") return cmdList(flags, opts);
  if (cmd === "cancel") return cmdCancel(flags, opts);
  die(`unknown command: ${cmd} (expected create | list | cancel)`);
}

main().catch((e) => die(e?.message || String(e)));
