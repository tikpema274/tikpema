// verify-escrow-reclaim.mjs — RECLAIM AN EXPIRED JOB ESCROW, AND NOTHING ELSE.
//
// ═══ WHAT THIS GUARDS ════════════════════════════════════════════════════════════════════════
// A research job's budget sits in the ERC-8183 escrow (AgenticCommerce). A job that stalls after funding
// never settles; the escrow expires 24h later and NOTHING reclaimed it — measured 2026-09-25: 25 of our 360
// jobs still Funded/Submitted, all past expiry, 59.25 USDC. The contract's claimRefund(jobId) is
// permissionless after expiredAt and pays the full budget to job.client — it cannot be redirected.
//
//   §1 classification: only Funded/Submitted AND past expiry is reclaimable; an unreadable job never is
//   §2 the plan covers ONLY the ids it is given (never discovers other people's jobs)
//   §3 a cutoff excludes jobs that expired before it (the backlog is T's run, not the schedule's)
//   §4 a reclaim is RECORDED only from the Refunded event — never derived from "the tx succeeded"
//   §5 the only write this code can make is claimRefund(uint256) — never reject/complete
//   §6 the escrow fees are read tri-state, and a change is DETECTED (surface, not discover later)
//   §7 the scheduled sweep ships DISARMED: it records what it WOULD reclaim and moves nothing
//   §8 armed, the sweep still never touches a job that expired before its cutoff
//   §9 the CLI is a dry run unless --confirm, and refuses --confirm without a configured wallet
//
//   node scripts/verify-escrow-reclaim.mjs     — zero network, zero money (every chain call injected)
import { readFileSync } from "node:fs";
import { encodeEventTopics, parseAbiItem, encodeAbiParameters } from "viem";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
const load = async (p) => { try { return await import(p); } catch (e) { fail++; console.log(`  ❌ cannot import ${p} — ${String(e?.message).split("\n")[0]}`); return {}; } };
const attempt = async (label, fn) => { try { return await fn(); } catch (e) { fail++; console.log(`  ❌ ${label} THREW — ${e?.message}`); return undefined; } };

const core = await load("../netlify/functions/_escrow-reclaim.mjs");
const sweeper = await load("../netlify/functions/escrow-reclaim-sweep.mjs");
const cli = await load("./escrow-reclaim.mjs");

const NOW = 1_800_000_000n;           // a fixed "now" (seconds)
const HOUR = 3600n;
const C = "0x00000000000000000000000000000000000000c1";
// status: 0 Open, 1 Funded, 2 Submitted, 3 Completed, 4 Rejected, 5 Expired (AgenticCommerce.JobStatus)
const JOBS = {
  "10": { id: 10n, client: C, budget: 200000n, expiredAt: NOW - 90n * 24n * HOUR, status: 2 }, // backlog: Submitted, expired 90 days ago
  "11": { id: 11n, client: C, budget: 200000n, expiredAt: NOW - 2n * HOUR, status: 1 },        // Funded, expired 2h ago
  "12": { id: 12n, client: C, budget: 200000n, expiredAt: NOW + 5n * HOUR, status: 1 },        // Funded, NOT yet expired (slow, not stalled)
  "13": { id: 13n, client: C, budget: 200000n, expiredAt: NOW - HOUR, status: 3 },             // Completed
  "14": { id: 14n, client: C, budget: 200000n, expiredAt: NOW - HOUR, status: 4 },             // Rejected
  "15": { id: 15n, client: C, budget: 0n, expiredAt: NOW - HOUR, status: 0 },                  // Open (never funded)
};
const readJob = async (id) => { if (id === "99") throw new Error("rpc down"); const j = JOBS[id]; if (!j) return { id: 0n }; return j; };

// ── §1 ─────────────────────────────────────────────────────────────────────────────────────
section("§1 ONLY Funded/Submitted PAST EXPIRY IS RECLAIMABLE");
const cls = (id) => core.classifyJob?.(JOBS[id], NOW)?.class;
check("Submitted + expired → reclaimable", cls("10") === "reclaimable", cls("10"));
check("Funded + expired → reclaimable", cls("11") === "reclaimable");
check("⭐ Funded but NOT expired → not-expired (a slow job is left alone)", cls("12") === "not-expired", cls("12"));
check("Completed → settled", cls("13") === "settled");
check("Rejected → settled", cls("14") === "settled");
check("Open (never funded) → nothing to reclaim", cls("15") === "open", cls("15"));

// ── §2, §3 ──────────────────────────────────────────────────────────────────────────────────
section("§2 THE PLAN COVERS ONLY THE IDS IT IS GIVEN · §3 THE CUTOFF");
const plan = await attempt("plan", () => core.planReclaim({ jobIds: ["10", "11", "12", "13", "99"], readJob, nowSec: NOW }));
check("reclaimable = exactly the expired Funded/Submitted among the given ids", plan?.reclaimable?.map((r) => r.jobId).join() === "10,11", plan?.reclaimable?.map((r) => r.jobId).join());
check("⭐ an unreadable job is reported unreadable, NEVER reclaimable", plan?.unreadable?.map((r) => r.jobId).join() === "99");
check("job 14/15, not in the given ids, are never looked at", !JSON.stringify(plan ?? {}).includes('"14"') && !JSON.stringify(plan ?? {}).includes('"15"'));
const cut = await attempt("cutoff plan", () => core.planReclaim({ jobIds: ["10", "11"], readJob, nowSec: NOW, expiredAfterSec: NOW - 24n * HOUR }));
check("⭐ a job that expired BEFORE the cutoff is excluded (the backlog)", cut?.reclaimable?.map((r) => r.jobId).join() === "11" && cut?.excludedBeforeCutoff?.map((r) => r.jobId).join() === "10",
  JSON.stringify({ r: cut?.reclaimable?.map((r) => r.jobId), x: cut?.excludedBeforeCutoff?.map((r) => r.jobId) }));

// ── §4 ─────────────────────────────────────────────────────────────────────────────────────
section("§4 A RECLAIM IS RECORDED ONLY FROM THE Refunded EVENT");
const REFUNDED = parseAbiItem("event Refunded(uint256 indexed jobId, address indexed client, uint256 amount)");
const refundLog = (jobId, amount = 200000n) => ({ address: core.ESCROW_ADDRESS, topics: encodeEventTopics({ abi: [REFUNDED], eventName: "Refunded", args: { jobId: BigInt(jobId), client: C } }), data: encodeAbiParameters([{ type: "uint256" }], [amount]) });
const submitted = [];
const submitClaim = async (jobId) => { submitted.push(jobId); return "0xhash" + jobId; };
const entry11 = plan?.reclaimable?.find((r) => r.jobId === "11");
const ok = await attempt("execute ok", () => core.executeReclaim({ entry: entry11, submitClaim, readReceiptLogs: async () => [refundLog("11")] }));
check("submitClaim was called with the job id", submitted.join() === "11");
check("⭐ refunded:true only because the receipt carries Refunded(11)", ok?.refunded === true && ok?.amountUsdc === "0.2" && ok?.to?.toLowerCase() === C, JSON.stringify(ok));
const none = await attempt("execute no event", () => core.executeReclaim({ entry: entry11, submitClaim, readReceiptLogs: async () => [] }));
check("⭐ no Refunded event → refunded:null (UNVERIFIED), never true", none?.refunded === null && /Refunded/.test(none?.reason ?? ""), JSON.stringify(none));
const wrong = await attempt("execute wrong job", () => core.executeReclaim({ entry: entry11, submitClaim, readReceiptLogs: async () => [refundLog("12")] }));
check("a Refunded event for a DIFFERENT job does not count", wrong?.refunded === null);
const thrown = await attempt("execute throws", () => core.executeReclaim({ entry: entry11, submitClaim: async () => { throw new Error("estimation failed"); }, readReceiptLogs: async () => [] }));
check("a failed submission is reported, not thrown, and not refunded", thrown?.refunded === false && /estimation failed/.test(thrown?.error ?? ""), JSON.stringify(thrown));

// ── §5 ─────────────────────────────────────────────────────────────────────────────────────
section("§5 THE ONLY WRITE IS claimRefund(uint256)");
let src = "";
try { src = readFileSync(new URL("../netlify/functions/_escrow-reclaim.mjs", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""); }
catch { /* missing module — the checks below go red rather than the suite crashing */ }
check("the core module source is readable", src.length > 0);
const sigs = [...src.matchAll(/abiFunctionSignature:\s*"([^"]+)"/g)].map((m) => m[1]);
check("⭐ exactly one write signature, and it is claimRefund(uint256)", sigs.length === 1 && sigs[0] === "claimRefund(uint256)", sigs.join(","));
// ⚠️ \b matters: "claimRefund(uint256" CONTAINS "fund(uint256" — the unanchored pattern flagged the one allowed write.
check("⭐ no reject / complete / fund anywhere in the code (comments excluded)", !/\b(reject|complete|fund)\(uint256/.test(src));

// ── §6 ─────────────────────────────────────────────────────────────────────────────────────
section("§6 ESCROW FEES: READ TRI-STATE, A CHANGE IS DETECTED");
const fees0 = await attempt("fees read", () => core.readEscrowFees({ readFee: async () => 0n }));
check("fees readable, both 0", fees0?.readable === true && fees0?.platformFeeBP === 0 && fees0?.evaluatorFeeBP === 0, JSON.stringify(fees0));
const feesX = await attempt("fees unreadable", () => core.readEscrowFees({ readFee: async () => { throw new Error("rpc"); } }));
check("⭐ an unreadable fee is readable:false with null values — never 0", feesX?.readable === false && feesX?.platformFeeBP === null);
check("first observation is recorded, not called a change", core.feeChange?.(null, fees0)?.changed === false);
check("⭐ 0/0 → 100/0 IS a change", core.feeChange?.(fees0, { readable: true, platformFeeBP: 100, evaluatorFeeBP: 0 })?.changed === true);
check("0/0 → 0/0 is not", core.feeChange?.(fees0, fees0)?.changed === false);
check("an unreadable read is not a change (and not a zero)", core.feeChange?.(fees0, feesX)?.changed === false);

// ── §7, §8 ──────────────────────────────────────────────────────────────────────────────────
section("§7 THE SCHEDULED SWEEP SHIPS DISARMED · §8 ARMED, THE CUTOFF STILL HOLDS");
check("⭐ RECLAIM_ARMED is false in the shipped sweeper", sweeper.RECLAIM_ARMED === false);
const mkFeeStore = (prev) => { const m = new Map(prev ? [["fees", prev]] : []); return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) }; };
const notes = [];
const tripwire = async (id) => { throw new Error(`TRIPWIRE: submitClaim(${id}) while disarmed`); };
const disarmed = await attempt("sweep disarmed", () => sweeper.sweep?.({
  jobIds: ["10", "11", "12"], readJob, nowSec: NOW, armed: false, armedFromSec: NOW - 24n * HOUR,
  readFee: async (n) => (n === "platformFeeBP" ? 100n : 0n), feeStore: mkFeeStore(fees0), submitClaim: tripwire,
  readReceiptLogs: async () => [], notify: async (msg) => notes.push(msg),
}));
check("⭐ disarmed: nothing submitted (the tripwire never fired)", disarmed && !disarmed.errors?.some((e) => /TRIPWIRE/.test(e)), JSON.stringify(disarmed?.errors ?? []));
check("disarmed: records what it WOULD reclaim (only after the cutoff)", disarmed?.wouldReclaim?.map((r) => r.jobId).join() === "11", JSON.stringify(disarmed?.wouldReclaim));
check("⭐ the fee change 0 → 100 bps is surfaced (notify) and recorded", notes.some((m) => /platform fee/i.test(m) && /100/.test(m)) && disarmed?.fees?.platformFeeBP === 100, notes.join(" | "));
const armedSubs = [];
const armed = await attempt("sweep armed", () => sweeper.sweep?.({
  jobIds: ["10", "11", "12"], readJob, nowSec: NOW, armed: true, armedFromSec: NOW - 24n * HOUR,
  readFee: async () => 0n, feeStore: mkFeeStore(fees0), submitClaim: async (id) => { armedSubs.push(id); return "0xh" + id; },
  readReceiptLogs: async () => [refundLog("11")], notify: async () => {},
}));
check("⭐⭐ armed: reclaims job 11 ONLY — the 90-day backlog job 10 is untouched", armedSubs.join() === "11", armedSubs.join());
check("armed: the slow job 12 (not expired) is untouched", !armedSubs.includes("12"));
check("armed: the result is the Refunded-verified record", armed?.reclaimed?.[0]?.refunded === true);

// ── §9 ─────────────────────────────────────────────────────────────────────────────────────
section("§9 THE CLI: DRY RUN UNLESS --confirm; --confirm NEEDS A WALLET");
const cliSubs = [];
const deps = { jobIds: async () => ["10", "11", "12"], readJob, nowSec: NOW, readFee: async () => 0n, submitClaim: async (id) => { cliSubs.push(id); return "0xc" + id; }, readReceiptLogs: async (h) => [refundLog(h.replace("0xc", ""))] };
const dry = await attempt("cli dry", () => cli.runReclaimCli?.({ argv: [], env: { ESCROW_RECLAIM_WALLET_ADDRESS: "0xabc" }, deps }));
check("⭐ no flag → DRY RUN: nothing submitted", cliSubs.length === 0 && dry?.mode === "dry-run", JSON.stringify({ mode: dry?.mode, subs: cliSubs }));
check("…and it lists the backlog it WOULD reclaim (both expired jobs)", dry?.reclaimable?.map((r) => r.jobId).join() === "10,11");
const refused = await attempt("cli no wallet", () => cli.runReclaimCli?.({ argv: ["--confirm"], env: {}, deps }));
check("⭐ --confirm with no ESCROW_RECLAIM_WALLET_ADDRESS is REFUSED before anything is sent", refused?.refused && cliSubs.length === 0, JSON.stringify(refused));
const run = await attempt("cli confirm", () => cli.runReclaimCli?.({ argv: ["--confirm"], env: { ESCROW_RECLAIM_WALLET_ADDRESS: "0xabc" }, deps }));
check("--confirm reclaims every expired job, one by one, and records each from its event", cliSubs.join() === "10,11" && run?.results?.every((r) => r.refunded === true), JSON.stringify(run?.results));
check("--confirm never touches the not-expired job", !cliSubs.includes("12"));

section("§9b THE DRY-RUN LIST T READS BEFORE --confirm");
{
  const lines = [];
  const who = async (a) => (a.toLowerCase() === C ? { kind: "agent-wallet", owner: "0x000000000000000000000000000000000000dEaD" } : { kind: "unknown" });
  const rep = await attempt("cli dry report", () => cli.runReclaimCli?.({ argv: [], env: {}, log: (l) => lines.push(l),
    deps: { ...deps, jobIds: async () => ["10", "11"], describeClient: who } }));
  const rows = rep?.reclaimable ?? [];
  check("⭐ rows are SORTED BY AMOUNT (largest first)", rows.length === 2 && Number(rows[0].budgetUsdc) >= Number(rows[1].budgetUsdc));
  check("⭐ each row carries the FULL client address, the amount and the expiry as a UTC date",
    rows.every((r) => /^0x[0-9a-fA-F]{40}$/.test(r.client) && r.budgetUsdc && /^\d{4}-\d{2}-\d{2}T/.test(r.expiresAtUtc ?? "")), JSON.stringify(rows[0]));
  check("⭐ each row says WHO the client is (describeClient), never blank", rows.every((r) => r.clientKind === "agent-wallet" && r.clientOwner));
  const table = lines.join("\n");
  check("the printed table shows the full client and whose it is", table.includes(C) && /agent wallet of 0x/i.test(table), table.split("\n").slice(0, 4).join(" / "));
  const unk = await attempt("cli dry unknown", () => cli.runReclaimCli?.({ argv: [], env: {}, log: () => {}, deps: { ...deps, jobIds: async () => ["11"], describeClient: async () => ({ kind: "unknown" }) } }));
  check("⭐ an UNATTRIBUTED client is flagged, not hidden", unk?.reclaimable?.[0]?.clientKind === "unknown" && unk?.unattributed === 1, JSON.stringify({ k: unk?.reclaimable?.[0]?.clientKind, u: unk?.unattributed }));
}

// ── §10 ────────────────────────────────────────────────────────────────────────────────────
section("§10 THE SCHEDULE IS REGISTERED (netlify.toml) — AND IT IS THE DISARMED FILE");
const toml = readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
check("escrow-reclaim-sweep has a schedule in netlify.toml", /\[functions\."escrow-reclaim-sweep"\]\s*\n\s*schedule\s*=/.test(toml));

console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
