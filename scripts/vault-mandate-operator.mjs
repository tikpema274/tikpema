// vault-mandate-operator.mjs — OPERATOR TOOLING, NOT SHIPPED APP CODE.
//
// A thin CLI for the operator-only vault mandate path (netlify/functions/vault-mandate-operator.mjs):
// create · ack · cancel, for the operator's OWN agent wallet. The dca-rehearsal-create.mjs precedent.
//
// ⚠️ Imports NOTHING from the app; imported by nothing. It sends a Bearer session token it does NOT mint:
//    paste one from your authenticated browser session (SESSION_TOKEN). It never reads SESSION_SECRET, so a
//    DEV-secret token can never be sent to prod by accident (see scripts/_prod-session.mjs for that trap).
//    A token for any address not in OPERATOR_MANDATE_OWNERS gets a plain 403 — by design, the same 403 as none.
//
// ── USAGE ─────────────────────────────────────────────────────────────────────────────────────────
//   SESSION_TOKEN=<paste> node scripts/vault-mandate-operator.mjs create --vault xylo-usdc \
//       --amount 10 --total 100 --cadence weekly --rules rules.json
//   SESSION_TOKEN=<paste> node scripts/vault-mandate-operator.mjs ack --id <id> --fingerprint <64 hex>
//   SESSION_TOKEN=<paste> node scripts/vault-mandate-operator.mjs cancel --id <id>
// rules.json: [{ "kind": "power", "subject": "upgradeable", "onFinding": "pause" }, …] — pause rules only
// (exit rules are refused until piece 5). Override the host with OPERATOR_BASE (default: prod). --json for raw.
//
// ⭐ `create` PRINTS BOTH DISCLOSURES — the vault's (the one the stored ack token stands for) and the mandate's —
// then the fingerprint and the exact ack command. It never acknowledges for you: acknowledging the fingerprint
// acknowledges both disclosures, so read them first.

import { readFileSync } from "node:fs";

const BASE = (process.env.OPERATOR_BASE || "https://app.tikpema.xyz").replace(/\/+$/, "");
const URL_ = `${BASE}/.netlify/functions/vault-mandate-operator`;
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) die(`unexpected argument: ${a}`);
    const k = a.slice(2);
    if (k === "json") { out.json = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) die(`--${k} needs a value`);
    out[k] = v; i++;
  }
  return out;
}

async function call(body) {
  const token = process.env.SESSION_TOKEN;
  if (!token || !token.trim()) die("SESSION_TOKEN is empty: paste a session token from your signed-in browser session");
  const res = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token.trim()}` }, body: JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json };
}

function printVault(d) {
  if (!d) return console.log("  (no vault disclosure)");
  console.log(`  vault      ${d.vault?.label ?? d.vault?.key ?? "?"} at ${d.vault?.address ?? "?"}`);
  console.log(`  level      ${d.level}${d.blocks?.length ? `  BLOCKED: ${d.blocks.map((b) => `${b.code} (${b.detail})`).join("; ")}` : ""}`);
  for (const w of d.warns ?? []) console.log(`  warns      ${w.code} — ${w.detail}`);
  console.log(`  holder     ${d.holder ?? "unreadable"} (${d.holderKind ?? "?"})`);
  console.log(`  fees       withdraw ${d.withdrawFeeBps ?? "?"} bps · deposit ${d.depositFeeBps ?? "?"} bps`);
  console.log(`  digest     ${d.digest ?? "?"}`);
  if (d.token) console.log(`  ack token  ${d.token}   (= sha256 of the digest above)`);
}

const [cmd, ...rest] = process.argv.slice(2);
const f = flags(rest);
if (cmd === "create") {
  for (const k of ["vault", "amount", "total", "rules"]) if (!f[k]) die(`create needs --${k}`);
  let rules; try { rules = JSON.parse(readFileSync(f.rules, "utf8")); } catch (e) { die(`--rules: ${e.message}`); }
  const body = { op: "create", vault: f.vault, amountPerDepositUsdc: Number(f.amount), maxTotalUsdc: Number(f.total), rules, ...(f.cadence ? { cadence: f.cadence } : {}) };
  const r = await call(body);
  if (f.json) { console.log(JSON.stringify(r, null, 2)); process.exit(r.status === 201 ? 0 : 1); }
  if (r.status !== 201) {
    console.log(`✗ ${r.status}: ${r.json?.error ?? "(no body)"}`);
    if (r.json?.vaultDisclosure) { console.log("\nVAULT DISCLOSURE"); printVault(r.json.vaultDisclosure); }
    process.exit(1);
  }
  const j = r.json;
  console.log(`✓ created ${j.id} — origin ${j.origin}, ${j.status}. NOTHING acts until you acknowledge.\n`);
  console.log("VAULT DISCLOSURE (what the stored ack token stands for)"); printVault(j.vaultDisclosure);
  console.log("\nMANDATE DISCLOSURE"); console.log(j.disclosure?.text?.split("\n").map((l) => `  ${l}`).join("\n"));
  console.log(`\nfingerprint ${j.fingerprint}\n${j.acknowledge}\n`);
  console.log(`To acknowledge BOTH disclosures above:\n  SESSION_TOKEN=<paste> node scripts/vault-mandate-operator.mjs ack --id ${j.id} --fingerprint ${j.fingerprint}`);
} else if (cmd === "ack") {
  if (!f.id || !f.fingerprint) die("ack needs --id and --fingerprint");
  const r = await call({ op: "ack", id: f.id, fingerprint: f.fingerprint });
  console.log(r.status === 200 ? `✓ ${r.json.id} is ${r.json.status}` : `✗ ${r.status}: ${r.json?.error ?? "(no body)"}`);
  process.exit(r.status === 200 ? 0 : 1);
} else if (cmd === "cancel") {
  if (!f.id) die("cancel needs --id");
  const r = await call({ op: "cancel", id: f.id });
  console.log(r.status === 200 ? `✓ ${r.json.id} is ${r.json.status}` : `✗ ${r.status}: ${r.json?.error ?? "(no body)"}`);
  process.exit(r.status === 200 ? 0 : 1);
} else {
  die("usage: create | ack | cancel (see the header)");
}
