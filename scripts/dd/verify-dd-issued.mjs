// verify-dd-issued.mjs — EVERY DD REPORT A CALLER IS GIVEN LEAVES A RECORD (netlify/functions/_dd-issued.mjs).
//
//   node --experimental-test-module-mocks scripts/dd/verify-dd-issued.mjs
//
// ═══ WHAT IT ASSERTS ═════════════════════════════════════════════════════════════════════════
//   A. THE CALLER SET. Every site that hands a caller a DD report records it, and a NEW site fails here
//      until it records or is exempted with a reason. Six paths: paid, paid-free, in-app-card,
//      deposit-disclosure, deposit-execution, mandate-check. [[guard-belongs-on-the-caller-set]]
//   B. THE RECORD. What it carries (subject, canon hash, shape, owner, powers, what was shown) and what
//      it never carries (refusals; the holder or any user identity — T, 2026-10-29).
//   C. THE FAILURE PATH. A failed write still serves, is counted under its own prefix (never the
//      canary's `health:` key), alerts once per window with the count, and a counter that also fails
//      still resolves. A hung store resolves within the timeout.
//   D. BEHAVIOUR AT FOUR SITES, in-process: deposit-disclosure, deposit-execution, paid retrieve,
//      mandate-check each write exactly one record with the right path and what was shown.
//      ⚠️ paid-free and in-app-card are covered by A only (their handlers need the full x402/session
//      ladder); their call is checked in source, not run.
//
// Zero money, zero network: Blobs, the RPC client, the signer and the payment check are all doubles.

import { mock } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${l}${x ? ` — ${x}` : ""}`); };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 70 - t.length))}`);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("A — the caller set: every site that hands out a report records it");
{
  const FN = "netlify/functions";
  const src = (f) => readFileSync(`${FN}/${f}`, "utf8");
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
  const files = readdirSync(FN).filter((f) => f.endsWith(".mjs"));
  const callers = (re, except) => files.filter((f) => f !== except && re.test(code(src(f))));
  const records = (f, path) => new RegExp(`recordIssued\\(\\s*\\{[^}]*path:\\s*"${path}"`).test(code(src(f)));

  // Where a report is produced, and where each producer's report reaches a caller.
  const disclosureSites = callers(/\bapplyReportDisclosure\(/, "_vault.mjs");
  check("applyReportDisclosure is called at exactly the two known sites",
    JSON.stringify(disclosureSites.sort()) === JSON.stringify(["_actions.mjs", "_vault-disclosure.mjs"]), disclosureSites.join(", "));
  check("…_vault-disclosure.mjs records deposit-disclosure", records("_vault-disclosure.mjs", "deposit-disclosure"));
  check("…_actions.mjs records deposit-execution", records("_actions.mjs", "deposit-execution"));

  const produceSites = callers(/\bmakeProduceReport\(\s*\{/, "_dd-rungs.mjs");
  check("makeProduceReport is called at exactly the two known sites",
    JSON.stringify(produceSites.sort()) === JSON.stringify(["agent-dd-report.mjs", "dd-analyze.mjs"]), produceSites.join(", "));
  check("…agent-dd-report.mjs records in-app-card", records("agent-dd-report.mjs", "in-app-card"));
  check("…dd-analyze's report reaches the caller through _dd-x402: paid (retrieve)", records("_dd-x402.mjs", "paid"));
  check("…and paid-free (the not-chargeable answer)", records("_dd-x402.mjs", "paid-free"));

  const checkSites = callers(/\bsignedCheckReport\(\s*\{/, "_vault-mandate-check.mjs");
  check("signedCheckReport has no caller outside its module", checkSites.length === 0, checkSites.join(", "));
  check("…_vault-mandate-check.mjs records mandate-check", records("_vault-mandate-check.mjs", "mandate-check"));

  // A report produced anywhere else is a new site. analyze() is called directly only by the producers.
  const analyzeSites = callers(/\banalyze\(\s*[a-zA-Z_.]+\s*,\s*\{\s*client/);
  check("analyze() is called directly only by the known producers",
    analyzeSites.every((f) => ["_dd-rungs.mjs", "_vault-report.mjs", "_vault-mandate-check.mjs"].includes(f)), analyzeSites.join(", "));

  const shared = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? shared(`${dir}/${d.name}`) : d.name.endsWith(".mjs") ? [`${dir}/${d.name}`] : []);
  const inEngine = shared("shared").filter((f) => /recordIssued|_dd-issued/.test(readFileSync(f, "utf8")));
  check("⛔ the shared engine never records (analyze() stays storage-free; canary runs are not recorded)", inEngine.length === 0, inEngine.join(", "));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The doubles. Registered before any module that uses them is imported.
const stores = new Map();
const failing = new Set();
const hanging = new Set();
const storeOf = (name) => {
  if (!stores.has(name)) stores.set(name, new Map());
  const m = stores.get(name);
  return {
    async setJSON(k, v) {
      if (hanging.has(name)) return new Promise(() => {});
      if (failing.has(name)) throw new Error(`injected: ${name} unwritable`);
      m.set(k, JSON.parse(JSON.stringify(v)));
    },
    async get(k) { return m.has(k) ? m.get(k) : null; },
  };
};
const resetStores = () => { stores.clear(); failing.clear(); hanging.clear(); };
mock.module("@netlify/blobs", { namedExports: { getStore: (n) => storeOf(typeof n === "string" ? n : n?.name), connectLambda: () => {} } });

const { analyze } = await import("../../shared/onchain-analyze/index.mjs");
const { ERC4626_METHODS } = await import("../../shared/onchain-facts/vault-profiles.mjs");
const { EIP1967_IMPL_SLOT } = await import("../../shared/onchain-facts/index.mjs");
const { EIP1967_ADMIN_SLOT } = await import("../../shared/onchain-analyze/slots.mjs");
const { SUBJ, IMPL, OWNER, ZERO_WORD, word, codeWith, mockClient } = await import("./_mock-chain.mjs");

const XYLO = "0x240Eb85458CD41361bd8C3773253a1D78054f747";
const HOLDER = "0xbafec950627579cf786acf875e6e216995e995a3"; // a user wallet — must never appear in a record
const USDC = "0x3600000000000000000000000000000000000000";
const VAULT_CODE = codeWith([...ERC4626_METHODS, "setFees(uint256,uint256,uint256)", "emergencyWithdraw(address,uint256)"]);
const reportFor = (addr) => analyze(addr, { client: mockClient({
  [`code@${addr.toLowerCase()}`]: VAULT_CODE, [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD,
  [`call@0x8da5cb5b`]: word(OWNER), [`code@${OWNER}`]: "0x",
}) });

const { recordIssued, buildIssuedRecord, _resetAlertThrottle, DD_ISSUED_STORE, FAILURE_PREFIX, ALERT_WINDOW_MS, ISSUED_PATHS } =
  await import("../../netlify/functions/_dd-issued.mjs");
const { DD_HEALTH_STORE } = await import("../../netlify/functions/_dd-health.mjs");
const issued = () => [...(stores.get(DD_ISSUED_STORE) ?? new Map()).values()];
// ⭐ A throw or a hang from recordIssued is itself the defect under test, so it must fail a NAMED check,
// not crash the suite: `settled` returns {threw} or {hung} instead. The guard timer keeps the loop alive.
const settled = (p, ms = 3000) => {
  let timer;
  const guard = new Promise((res) => { timer = setTimeout(() => res({ hung: true }), ms); });
  return Promise.race([p.catch((e) => ({ threw: String(e?.message ?? e) })), guard]).finally(() => clearTimeout(timer));
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("B — the record");
{
  const ADMIN = "0x" + "ad".repeat(20);
  const proxy = await analyze(SUBJ, { client: mockClient({
    [`code@${SUBJ}`]: codeWith(["upgradeToAndCall(address,bytes)"]), [`slot@${EIP1967_IMPL_SLOT}`]: word(IMPL),
    [`slot@${EIP1967_ADMIN_SLOT}`]: word(ADMIN), [`code@${IMPL}`]: codeWith(["pause()"]), [`call@0x8da5cb5b`]: ZERO_WORD,
  }) });
  const r = buildIssuedRecord({ path: "paid", report: proxy, pendingHandle: "h-1" }, { now: () => Date.UTC(2026, 9, 29) });
  check("subject, block and schema", r.subject.address === SUBJ && r.subject.blockNumber === 1000 && r.schemaVersion === "onchain-analyze/0.4.0");
  check("shape and the admin", r.shape.class === "eip1967-transparent" && r.shape.admin === ADMIN);
  check("owner kind and stillControlledVia", r.owner.kind === "renounced" && r.owner.stillControlledVia?.[0]?.address === ADMIN);
  check("powersPresent carries upgradeable", r.powersPresent.includes("upgradeable"), r.powersPresent.join(","));
  check("canonHash is 64 hex and stable", /^[0-9a-f]{64}$/.test(r.canonHash) &&
    r.canonHash === buildIssuedRecord({ path: "paid", report: proxy }).canonHash);
  check("pendingHandle only on paid", r.pendingHandle === "h-1" &&
    buildIssuedRecord({ path: "mandate-check", report: proxy, pendingHandle: "h-1" }).pendingHandle === null);
  let threw = false; try { buildIssuedRecord({ path: "nope", report: proxy }); } catch { threw = true; }
  check("an unknown path throws (a typo cannot invent a path)", threw);
  check("the six paths", ISSUED_PATHS.join(",") === "paid,paid-free,in-app-card,deposit-disclosure,deposit-execution,mandate-check");

  resetStores(); _resetAlertThrottle();
  const ref = await recordIssued({ path: "paid-free", report: { ...proxy, refusal: { reason: "chain-unreadable" } } });
  const nul = await recordIssued({ path: "deposit-disclosure", report: null });
  check("⛔ a refusal is NOT recorded", ref.recorded === false && ref.reason === "refusal-not-recorded");
  check("⛔ no report, no record", nul.recorded === false && issued().length === 0);

  const withId = await recordIssued({ path: "deposit-disclosure", report: proxy, holder: HOLDER, owner: HOLDER, walletAddress: HOLDER,
    shown: { level: "WARN", warnCodes: ["upgradeable", "emergency-withdraw"], digest: "d", holder: HOLDER } });
  const stored = JSON.stringify(issued());
  check("a real issuance is recorded", withId.recorded === true && issued().length === 1);
  check("⛔ no user identity: the holder never reaches the record, even when a caller passes it", !stored.toLowerCase().includes(HOLDER));
  check("shown is the level, the sorted warn codes and the digest only",
    JSON.stringify(issued()[0].shown) === JSON.stringify({ level: "WARN", warnCodes: ["emergency-withdraw", "upgradeable"], digest: "d" }));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("C — a failed write still serves; counted, alerted once per window");
{
  const report = await reportFor(SUBJ);
  let t = Date.UTC(2026, 9, 29, 12);
  const alerts = [];
  const logs = [];
  const deps = { now: () => t, alert: (c) => { alerts.push(c); return true; }, log: { error: (m) => logs.push(m) } };

  resetStores(); _resetAlertThrottle();
  failing.add(DD_ISSUED_STORE);
  const a = await settled(recordIssued({ path: "in-app-card", report }, deps));
  const fails = [...(stores.get(DD_HEALTH_STORE) ?? new Map()).keys()];
  check("the call resolves (the caller serves) with recorded:false — it never throws", a.recorded === false && a.reason === "write-failed", JSON.stringify(a));
  check("the failure is counted under its own prefix in the DD health store", fails.length === 1 && fails[0].startsWith(FAILURE_PREFIX), fails.join(","));
  check("⛔ …and never under the canary's `health:` key", fails.every((k) => !k.startsWith("health:")));
  check("one alert, naming the path and the count", alerts.length === 1 && /1 DD report/.test(alerts[0]) && /in-app-card/.test(alerts[0]));
  check("a log line every time", logs.some((l) => /record write FAILED/.test(l)));

  t += 60_000; await recordIssued({ path: "in-app-card", report }, deps);
  t += 60_000; await recordIssued({ path: "in-app-card", report }, deps);
  check("inside the window: counted, NOT re-alerted", alerts.length === 1 && stores.get(DD_HEALTH_STORE).size === 3);
  t += ALERT_WINDOW_MS; await recordIssued({ path: "in-app-card", report }, deps);
  check("after the window: one alert with the count since the last", alerts.length === 2 && /3 DD report/.test(alerts[1]), alerts[1]?.split("\n")[0]);

  failing.add(DD_HEALTH_STORE); _resetAlertThrottle(); logs.length = 0; alerts.length = 0;
  const b = await settled(recordIssued({ path: "in-app-card", report }, deps));
  check("the counter failing too still resolves — it never throws", b.recorded === false && b.counted === false, JSON.stringify(b));
  check("…and the alert says this is the only record", /could not be written either/.test(alerts[0] ?? ""));
  check("…and the log says so", logs.some((l) => /COUNTER could not be written/.test(l)));

  resetStores(); _resetAlertThrottle(); hanging.add(DD_ISSUED_STORE);
  const t0 = Date.now();
  const h = await settled(recordIssued({ path: "in-app-card", report }, { ...deps, timeoutMs: 100 }), 1000);
  check("a hung store resolves within the timeout", h.recorded === false && !h.hung && Date.now() - t0 < 1000, `${Date.now() - t0} ms ${h.hung ? "(HUNG)" : ""}`);

  failing.clear(); hanging.clear(); _resetAlertThrottle(); logs.length = 0;
  failing.add(DD_ISSUED_STORE);
  const saved = process.env.DD_WATCH_WEBHOOK; delete process.env.DD_WATCH_WEBHOOK;
  await recordIssued({ path: "in-app-card", report }, { now: () => t, log: { error: (m) => logs.push(m) } });
  if (saved !== undefined) process.env.DD_WATCH_WEBHOOK = saved;
  check("with DD_WATCH_WEBHOOK unset, the log says the alert reached nobody", logs.some((l) => /reached NOBODY/.test(l)));
  failing.clear();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The four sites, in-process. Doubles for everything that would touch money or the network.
const VALUES = {
  asset: USDC, totalAssets: 8_000_000_000_000n, decimals: 6, symbol: "xyUSDC", name: "x",
  totalSupply: 7_900_000_000_000n, withdrawFee: 10n, depositFee: 0n, performanceFee: 0n, MAX_FEE: 2000n,
  owner: OWNER, convertToAssets: 1_000_000n, previewRedeem: 999_000n, maxRedeem: 0n, balanceOf: 0n,
};
mock.module("../../netlify/functions/_predict.mjs", { namedExports: { publicClient: () => ({
  getBytecode: async ({ address }) => (address.toLowerCase() === XYLO.toLowerCase() ? VAULT_CODE : "0x"),
  multicall: async ({ contracts }) => contracts.map((c) =>
    c.functionName in VALUES ? { status: "success", result: VALUES[c.functionName] } : { status: "failure", error: new Error("absent") }),
  getStorageAt: async () => ZERO_WORD,
  readContract: async () => { throw new Error("not in this double"); },
}) } });
let ddReport = null;
mock.module("../../netlify/functions/_vault-report.mjs", { namedExports: { vaultDdReport: async () => ddReport } });
mock.module("../../netlify/functions/_pause.mjs", { namedExports: { assertNotPaused: async () => null } });
const realBudget = await import("../../netlify/functions/_budget.mjs");
mock.module("../../netlify/functions/_budget.mjs", { namedExports: {
  ...realBudget, canSpendDay: async () => ({ allowed: true }), recordAgentSpend: async () => {}, recordBlocked: async () => {}, shoutLedgerFailure: () => {},
} });
let signed = false;
mock.module("../../netlify/functions/_circle.mjs", { namedExports: {
  circle: () => ({ createContractExecutionTransaction: async () => { signed = true; return { data: { id: "x" } }; } }),
  waitForTx: async () => "0xFAKE", TxPendingError: class extends Error {},
} });
const realConfirm = await import("../../netlify/functions/_x402-confirm.mjs");
mock.module("../../netlify/functions/_x402-confirm.mjs", { namedExports: {
  ...realConfirm, readGatewayBalance: async () => 10n ** 12n, confirmPayment: () => ({ confirmed: true, evidence: { double: true } }),
} });
const { ARC } = await import("../../netlify/functions/_arc.mjs");
const ID = { registry: "0x8004a818bfb912233c491871b3d84c89a494bd9e", agentId: 851891, chainId: ARC.chainId, domain: "test" };
const realAttest = await import("../../shared/onchain-analyze/attest.mjs");
mock.module("../../shared/onchain-analyze/attest.mjs", { namedExports: {
  ...realAttest,
  attachAttestation: async (r) => ({ ...r, attestation: { status: "signed", ...ID } }),
  verifyAttestation: async () => ({ valid: true }),
} });

section("D — the four sites write one record each");
{
  ddReport = await reportFor(XYLO);

  resetStores(); _resetAlertThrottle();
  const { depositDisclosure } = await import(`../../netlify/functions/_vault-disclosure.mjs?t=${Math.random()}`);
  const { resolveVault } = await import("../../netlify/functions/_vault.mjs");
  const d = await depositDisclosure({ vault: resolveVault("xylo-usdc"), owner: HOLDER });
  const dr = issued();
  check("deposit-disclosure: one record", dr.length === 1 && dr[0].path === "deposit-disclosure", dr.map((x) => x.path).join(","));
  check("…shown = the gate the caller got", dr[0]?.shown?.level === d.gate.level &&
    JSON.stringify(dr[0].shown.warnCodes) === JSON.stringify(d.gate.warns.map((w) => w.code).sort()), JSON.stringify(dr[0]?.shown));
  check("…with the digest the ack is bound to", !!dr[0]?.shown?.digest && dr[0].shown.digest.startsWith(XYLO.toLowerCase()), dr[0]?.shown?.digest);
  check("⛔ …and no holder", !JSON.stringify(dr).toLowerCase().includes(HOLDER));

  resetStores();
  ddReport = { ...ddReport, refusal: { reason: "chain-unreadable" } };
  await depositDisclosure({ vault: resolveVault("xylo-usdc"), owner: HOLDER });
  check("deposit-disclosure: a refusal report writes nothing", issued().length === 0);
  ddReport = await reportFor(XYLO);

  resetStores();
  const { executeAction } = await import(`../../netlify/functions/_actions.mjs?t=${Math.random()}`);
  const ex = await executeAction({ type: "vault_deposit", vault: "xylo-usdc", amountUsdc: 5 }, { walletAddress: HOLDER });
  const er = issued();
  check("deposit-execution: refused without an ack, nothing signed", ex.ok === false && signed === false, ex.blocked);
  check("deposit-execution: one record", er.length === 1 && er[0].path === "deposit-execution", er.map((x) => x.path).join(","));
  check("…shown = the disclosure the gate refused on", er[0]?.shown?.level === ex.disclosure?.level && er[0]?.shown?.digest === ex.disclosure?.digest,
    `${er[0]?.shown?.level} / ${ex.disclosure?.level}`);
  check("⛔ …and no holder", !JSON.stringify(er).toLowerCase().includes(HOLDER));

  resetStores();
  const { retrievePaid } = await import(`../../netlify/functions/_dd-x402.mjs?t=${Math.random()}`);
  const pending = storeOf("dd-analyze-pending");
  await pending.setJSON("h-9", { handle: "h-9", payTo: "0x1", baseline: "0", amountAtomic: "1", settledAt: 0, report: ddReport });
  const served = await retrievePaid({ handle: "h-9", store: pending, rpcCall: async () => null });
  const pr = issued();
  check("paid: served", served.statusCode === 200);
  check("paid: one record, with the handle", pr.length === 1 && pr[0].path === "paid" && pr[0].pendingHandle === "h-9", pr.map((x) => x.path).join(","));

  resetStores();
  const { signedCheckReport } = await import(`../../netlify/functions/_vault-mandate-check.mjs?t=${Math.random()}`);
  const anchor = { blockNumber: 1000, blockHash: "0x" + "ab".repeat(32) };
  const mc = await signedCheckReport({ address: XYLO, anchor, deps: {
    health: async () => ({ serving: true }),
    analyzeClient: mockClient({ [`code@${XYLO.toLowerCase()}`]: VAULT_CODE, [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD, [`call@0x8da5cb5b`]: word(OWNER), [`code@${OWNER}`]: "0x" }),
    signOptions: {}, identity: ID, verifyClient: {},
  } });
  const mr = issued();
  check("mandate-check: the report was signed and verified", mc.report !== null, mc.why ?? "");
  check("mandate-check: one record, signed", mr.length === 1 && mr[0].path === "mandate-check" && mr[0].attestation === "signed", mr.map((x) => x.path).join(","));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
