// escrow-reclaim.mjs — T's ONE-TIME reclaim of the expired research-job escrow backlog.
//
//   node --env-file=.env scripts/escrow-reclaim.mjs              DRY RUN (default): lists what it WOULD reclaim
//   node --env-file=.env scripts/escrow-reclaim.mjs --confirm    submits claimRefund for each, one by one
//
// ⛔ T RUNS THIS. It moves money: each claimRefund returns a job's FULL budget to that job's client — which for
// most of the June–July backlog is the user's own LOGIN wallet (client = the identity that signed the job
// back then), and for later jobs the user's agent wallet. It cannot send funds anywhere else (the contract
// pays job.client). Gas is paid by ESCROW_RECLAIM_WALLET_ADDRESS, a Circle dev-controlled wallet (sponsored).
//
// Needs: CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET (the repo .env), ESCROW_RECLAIM_WALLET_ADDRESS (for --confirm),
// and the Netlify CLI login (read-only Blobs access to job-runs / job-deliverables for OUR job ids).
// Every result is recorded from the Refunded event (refunded:true), never from "the tx succeeded".
import { pathToFileURL } from "node:url";
import { acquireLock, releaseLock, breakStaleLock, refusalMessage, LOCK_EXIT } from "./run-lock.mjs";

export async function runReclaimCli({ argv = [], env = {}, deps, log = () => {} }) {
  const confirm = argv.includes("--confirm");
  const wallet = env.ESCROW_RECLAIM_WALLET_ADDRESS || null;
  if (confirm && !wallet) {
    return { mode: "confirm", refused: "ESCROW_RECLAIM_WALLET_ADDRESS is not set — nothing was sent. Set the wallet that pays gas, then re-run." };
  }
  const core = await import("../netlify/functions/_escrow-reclaim.mjs");
  const fees = await core.readEscrowFees({ readFee: deps.readFee });
  const plan = await core.planReclaim({ jobIds: await deps.jobIds(), readJob: deps.readJob, nowSec: deps.nowSec });
  // ⭐ THE LIST T READS BEFORE --confirm: full client, amount, expiry (UTC), and WHO the client is — sorted by
  // amount, largest first. An unattributed client is FLAGGED: a refund to a wallet nobody can name is worth
  // knowing about before it is sent, not after. (The contract pays job.client; this only says whose it is.)
  const describe = deps.describeClient ?? (async () => ({ kind: "unchecked" }));
  const rows = [];
  for (const r of plan.reclaimable) {
    const who = await describe(String(r.client)).catch(() => ({ kind: "unknown" }));
    rows.push({ ...r, expiresAtUtc: r.expiredAt ? new Date(Number(r.expiredAt) * 1000).toISOString() : null,
      clientKind: who.kind, clientOwner: who.owner ?? null });
  }
  rows.sort((a, b) => Number(b.budgetUsdc ?? 0) - Number(a.budgetUsdc ?? 0) || Number(a.jobId) - Number(b.jobId));
  const unattributed = rows.filter((r) => r.clientKind === "unknown" || r.clientKind === "unchecked").length;
  const total = rows.reduce((a, r) => a + Number(r.budgetUsdc ?? 0), 0);
  const whoText = (r) => r.clientKind === "login-identity" ? "a user's LOGIN wallet (their own key)"
    : r.clientKind === "agent-wallet" ? `agent wallet of ${r.clientOwner}` : "⚠️ UNATTRIBUTED — no record names this wallet";
  log(`escrow fees: ${fees.readable ? `platform ${fees.platformFeeBP} bps, evaluator ${fees.evaluatorFeeBP} bps` : `UNREADABLE (${fees.reason})`}`);
  log(`reclaimable (expired, still Funded/Submitted): ${rows.length} jobs, ${total.toFixed(6)} USDC — refunds go to each job's CLIENT:`);
  log(`  ${"job".padEnd(8)} ${"amount USDC".padStart(11)}  ${"expired (UTC)".padEnd(20)}  ${"client".padEnd(42)}  whose`);
  for (const r of rows) log(`  ${String(r.jobId).padEnd(8)} ${String(r.budgetUsdc).padStart(11)}  ${String(r.expiresAtUtc ?? "?").slice(0, 19).padEnd(20)}  ${String(r.client).padEnd(42)}  ${whoText(r)}`);
  log(`not expired: ${plan.notExpired.length} · settled: ${plan.settled.length} · unreadable: ${plan.unreadable.length} · unattributed clients: ${unattributed}`);
  if (!confirm) return { mode: "dry-run", fees, reclaimable: rows, totalUsdc: total.toFixed(6), unattributed, unreadable: plan.unreadable };

  const results = [];
  for (const entry of plan.reclaimable) {           // ONE BY ONE — a failure is recorded, the rest still run
    const r = await core.executeReclaim({ entry, submitClaim: deps.submitClaim, readReceiptLogs: deps.readReceiptLogs });
    results.push(r);
    log(`  job ${r.jobId}: ${r.refunded === true ? `REFUNDED ${r.amountUsdc} USDC → ${String(r.to).slice(0, 10)}…` : r.refunded === null ? `UNVERIFIED — ${r.reason}` : `FAILED — ${r.error}`}  ${r.txHash ?? ""}`);
    if (deps.record) await deps.record(r).catch((e) => log(`  ⚠️ could not record job ${r.jobId}: ${e.message}`));
  }
  return { mode: "confirm", fees, results };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // ⭐ ONE --confirm AT A TIME (2026-09-28, scripts/run-lock.mjs). --confirm moves money: two concurrent runs could each
  // submit claimRefund for the same job (the contract refuses the second, but it costs gas and muddles the record). The
  // lock is taken HERE, in-process — this script is run with `node` directly, so an npm-level wrapper would not bind it —
  // and BEFORE anything else: no config read, no network. A dry run takes no lock. Stale: --break-stale-lock (renames).
  const CONFIRM = process.argv.includes("--confirm");
  if (CONFIRM) {
    if (process.argv.includes("--break-stale-lock")) {
      const b = breakStaleLock({ name: "escrow-reclaim" });
      if (b.ok) console.error(`⚠️ escrow-reclaim: a stale lock was broken — ${b.proof}. Kept as ${b.movedTo}.`);
      else if (!b.absent) { console.error(`⛔ escrow-reclaim: --break-stale-lock refused — ${b.why}. Nothing was sent.`); process.exit(b.code === "held" ? LOCK_EXIT.held : LOCK_EXIT.unreadable); }
    }
    const lk = acquireLock({ name: "escrow-reclaim" });
    if (!lk.ok) { console.error(refusalMessage(lk, "escrow-reclaim")); process.exit(LOCK_EXIT[lk.code] ?? LOCK_EXIT.unreadable); }
    const release = () => releaseLock({ name: "escrow-reclaim", token: lk.token });
    process.on("exit", release);
    for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]]) process.on(sig, () => { release(); process.exit(code); });
  }
  const { getStore } = await import("@netlify/blobs");
  const { readFileSync } = await import("node:fs");
  const cfg = JSON.parse(readFileSync(`${process.env.HOME}/.config/netlify/config.json`, "utf8"));
  const token = Object.values(cfg.users)[0].auth.token;
  const siteID = JSON.parse(readFileSync(new URL("../.netlify/state.json", import.meta.url), "utf8")).siteId;
  const store = (name) => getStore({ name, siteID, token, consistency: "strong" });
  const core = await import("../netlify/functions/_escrow-reclaim.mjs");
  const live = await core.liveDeps({ walletAddress: CONFIRM ? process.env.ESCROW_RECLAIM_WALLET_ADDRESS ?? null : null });
  const watch = store("escrow-watch");
  // WHOSE is each client? From our own agent-wallets map: an owner KEY is a login identity; a record's
  // walletAddress is that owner's agent wallet. Anything else is unattributed.
  const aw = store("agent-wallets"); const owners = new Set(); const agentOf = new Map();
  for await (const page of aw.list({ paginate: true })) for (const b of page.blobs) {
    const owner = b.key.startsWith("owner:") ? b.key.slice(6).toLowerCase() : null;
    if (owner) owners.add(owner);
    const v = await aw.get(b.key, { type: "json" }).catch(() => null);
    if (v?.walletAddress) agentOf.set(v.walletAddress.toLowerCase(), owner ?? v.owner ?? null);
  }
  const describeClient = async (a) => { const k = a.toLowerCase();
    return agentOf.has(k) ? { kind: "agent-wallet", owner: agentOf.get(k) } : owners.has(k) ? { kind: "login-identity" } : { kind: "unknown" }; };
  const out = await runReclaimCli({
    argv: process.argv.slice(2), env: process.env, log: console.log,
    deps: { ...live, jobIds: () => core.ourJobIds({ getStore: store }), describeClient,
      record: (r) => watch.setJSON(`reclaim:${r.jobId}`, { ...r, recordedAt: new Date().toISOString() }) },
  });
  if (out.refused) { console.error(`⛔ REFUSED: ${out.refused}`); process.exit(2); }
  console.log(out.mode === "dry-run" ? "\nDRY RUN — nothing was sent. Re-run with --confirm to reclaim." : "\nDone.");
}
