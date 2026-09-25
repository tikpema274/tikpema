// verify-vault-withdraw-shares-after.mjs — a reclaim must say whether shares REMAIN.
//
//   node --experimental-test-module-mocks scripts/verify-vault-withdraw-shares-after.mjs
//
// THE DEFECT: vaultWithdraw returned confirmed:true on ANY positive USDC delta and never read the
// share balance afterwards. Every surface then said "Reclaimed X USDC" under a step labelled
// "Reclaim your whole position", whether or not the position was whole-ly reclaimed. Not
// producible on XyloVault (redeem burns exactly N or reverts), but the only live route —
// shares arriving between the caller's balanceOf and the redeem — exists on any vault, and a
// second vault arms it. The mandate's exit executor (piece 5) calls this same function.
//
// ⭐ THE REAL vaultWithdraw RUNS. Only the BOUNDARIES are faked: the Circle client (nothing signs)
// and the public client (a fixture chain). [[never-mock-the-function-under-test]]
//
// Three outcomes after a proven USDC delta, and none may collapse into another:
//   emptied        — shares-after READ as 0          → no remainder note
//   shares-remain  — shares-after READ as > 0        → a note naming what remains
//   unreadable     — shares-after could NOT be read  → a note saying we cannot tell; never "emptied"
// [[absence-must-never-read-as-safe]]
import { mock } from "node:test";
import { readFileSync } from "node:fs";

const REAL_CIRCLE = await import("../netlify/functions/_circle.mjs");

const OWNER = "0x1111111111111111111111111111111111111111";
const VAULT = "0x2222222222222222222222222222222222222222";
const ASSET = "0x3333333333333333333333333333333333333333";
const HASH = "0x" + "ab".repeat(32);

// ── the fixture chain ─────────────────────────────────────────────────────────────────────────
// `redeemed` flips when the (fake) Circle client submits the redeem, so every read knows whether
// it is BEFORE or AFTER — a shares-after read taken before the redeem would see the old balance.
let W;
const reset = (over = {}) => {
  W = {
    redeemed: false,
    usdcBefore: 100_000_000n, usdcAfter: 101_998_000n,
    sharesBefore: 1_999_996n, sharesAfter: 0n,
    sharesAfterReadFails: false,
    receiptStatus: "success",
    reads: [], // [{ what, phase }]
    ...over,
  };
};
const fakePc = {
  readContract: async ({ address, functionName, args }) => {
    const a = address.toLowerCase();
    const phase = W.redeemed ? "after" : "before";
    if (functionName === "balanceOf" && a === ASSET.toLowerCase()) {
      W.reads.push({ what: "usdc", phase });
      return W.redeemed ? W.usdcAfter : W.usdcBefore;
    }
    if (functionName === "balanceOf" && a === VAULT.toLowerCase()) {
      W.reads.push({ what: "shares", phase });
      if (W.redeemed && W.sharesAfterReadFails) throw new Error("fixture: rpc down");
      return W.redeemed ? W.sharesAfter : W.sharesBefore;
    }
    if (functionName === "decimals") return 6;
    throw new Error(`fixture: unexpected read ${functionName} on ${address} ${args ?? ""}`);
  },
  getTransactionReceipt: async () => ({ status: W.receiptStatus }),
};
const fakeCircle = {
  createContractExecutionTransaction: async ({ abiFunctionSignature }) => {
    if (abiFunctionSignature.startsWith("redeem(")) W.redeemed = true;
    return { data: { id: "circle-tx-1" } };
  },
};

mock.module("../netlify/functions/_circle.mjs", {
  namedExports: { ...REAL_CIRCLE, circle: () => fakeCircle, waitForTx: async () => HASH },
});
const REAL_PREDICT = await import("../netlify/functions/_predict.mjs");
mock.module("../netlify/functions/_predict.mjs", {
  namedExports: { ...REAL_PREDICT, publicClient: () => fakePc },
});

const { vaultWithdraw } = await import("../netlify/functions/_vault.mjs");
const VAULT_DESC = { key: "fixture-vault", address: VAULT, assetAddress: ASSET, shareSymbol: "fxSHR", label: "Fixture Vault" };
const run = () => vaultWithdraw({ walletAddress: OWNER, vault: VAULT_DESC, shares: W.sharesBefore.toString() });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n       → ${detail}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t}`);

section("A — the position EMPTIED: shares-after read as 0");
{
  reset();
  const r = await run();
  check("confirmed on the measured USDC delta", r.confirmed === true && r.usdcReceived === 1.998, JSON.stringify(r));
  check("⭐ position is 'emptied'", r.position === "emptied", `position=${r.position}`);
  check("sharesRemainingRaw is \"0\" (a READING, not a default)", r.sharesRemainingRaw === "0", `got ${r.sharesRemainingRaw}`);
  check("no remainder note", r.remainderNote === null, `got ${JSON.stringify(r.remainderNote)}`);
  const after = W.reads.filter((x) => x.what === "shares");
  check("⭐ the share balance was read AFTER the redeem", after.some((x) => x.phase === "after"), JSON.stringify(W.reads));
}

section("B — 🚨 SHARES REMAIN: shares-after read as > 0 (the defect)");
{
  reset({ sharesAfter: 750_000n });
  const r = await run();
  check("still confirmed — the USDC that arrived is real", r.confirmed === true && r.usdcReceived === 1.998, JSON.stringify(r));
  check("🚨 position is 'shares-remain', not a clean success", r.position === "shares-remain", `position=${r.position}`);
  check("sharesRemainingRaw carries the READ remainder", r.sharesRemainingRaw === "750000", `got ${r.sharesRemainingRaw}`);
  check("the note says shares are still in the vault",
    typeof r.remainderNote === "string" && /still in the vault/.test(r.remainderNote), JSON.stringify(r.remainderNote));
  check("the note names the remainder and the share symbol",
    typeof r.remainderNote === "string" && /0\.75/.test(r.remainderNote) && /fxSHR/.test(r.remainderNote), JSON.stringify(r.remainderNote));
}

section("C — ⛔ SHARES-AFTER UNREADABLE: never reported as emptied");
{
  reset({ sharesAfterReadFails: true });
  const r = await run();
  check("still confirmed — the USDC delta was read", r.confirmed === true && r.usdcReceived === 1.998, JSON.stringify(r));
  check("⛔ position is 'unreadable', NOT 'emptied'", r.position === "unreadable", `position=${r.position}`);
  check("sharesRemainingRaw is null — no reading, no number", r.sharesRemainingRaw === null, `got ${r.sharesRemainingRaw}`);
  check("the note says we cannot tell whether shares remain",
    typeof r.remainderNote === "string" && /couldn't read/.test(r.remainderNote), JSON.stringify(r.remainderNote));
}

section("D — the existing failure paths are unchanged");
{
  reset({ usdcAfter: 100_000_000n });
  const r = await run();
  check("no USDC delta → confirmed:false (unchanged)", r.confirmed === false, JSON.stringify(r));
  reset({ receiptStatus: "reverted" });
  const r2 = await run();
  check("reverted receipt → confirmed:false (unchanged)", r2.confirmed === false, JSON.stringify(r2));
}

// ── E: THE CALLER SET. A new field every surface ignores is the defect with extra steps. ────────
// [[guard-belongs-on-the-caller-set]] Four surfaces report a reclaim: the chat reply (agent-act),
// the chat card (MyAgentPanel), the vault panel (via agent-vault-withdraw, which spreads the
// executor's result), and the plan step list (agent-execute-plan → MyAgentPanel).
section("E — every surface that reports a reclaim carries the remainder note");
{
  const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const act = src("netlify/functions/agent-act.mjs");
  const wi = act.indexOf('if (decision.action === "vault_withdraw")');
  const block = act.slice(wi, act.indexOf('if (decision.action !== "transfer_usdc")', wi));
  check("agent-act: the chat reply appends r.remainderNote", /r\.remainderNote/.test(block));
  const endpoint = src("netlify/functions/agent-vault-withdraw.mjs");
  check("agent-vault-withdraw: spreads the executor's result (the note travels)", /\.\.\.r\b/.test(endpoint));
  const panel = src("src/components/VaultPanel.tsx");
  check("VaultPanel: the reclaim message renders data.remainderNote", /data\??\.remainderNote/.test(panel));
  const plan = src("netlify/functions/agent-execute-plan.mjs");
  check("agent-execute-plan: a step result carries remainderNote", /remainderNote:\s*r\.remainderNote/.test(plan));
  const my = src("src/components/MyAgentPanel.tsx");
  check("MyAgentPanel chat card: renders vw.remainderNote", /vw\.remainderNote/.test(my));
  check("MyAgentPanel plan step: renders r.remainderNote", /r\??\.remainderNote/.test(my));
}

console.log(`\n╔${"═".repeat(37)}`);
console.log(`║  ${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}`);
console.log(`╚${"═".repeat(37)}`);
process.exit(fail ? 1 : 0);
