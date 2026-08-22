// POST /.netlify/functions/job-run { question, budgetUsdc }  (auth required)  — Sub-brick 2b
//
// ⚠️ THERE IS NO `/api/` ROUTE FOR THIS FUNCTION — call `/.netlify/functions/job-run`.
// The `/api/*` redirect covers 31 of 57 functions; the job plane (job-run, job-run-status,
// job-quote, job-set-budget, job-submit-background, plan-quote) is called DIRECTLY by the front end.
//
// 🚨 AND GETTING THIS WRONG FAILS SILENTLY, NOT LOUDLY. An unmatched `/api/*` GET is served by the
// SPA catch-all as **200 with an HTML body** (measured 2026-08-12). A caller doing
// `if (!res.ok) throw` sees res.ok === TRUE, and with `.catch(() => ({}))` on the parse it becomes
// an empty object treated as a successful response. A POST returns 404 (the SPA rule skips POST),
// so the failure mode DIFFERS BY METHOD and the GET one is the quiet one.
//
// Entry point for the server-driven research job. The ENTIRE lifecycle now runs
// on the AUTHENTICATED user's OWN agent wallet (from the 2a mapping, resolved
// from the session — never client-supplied, never the shared env wallet).
//
// This sync front door does only fast work: resolve the user's wallet, check its
// balance, and — if funded — kick off the background worker. The insufficient-
// funds case returns cleanly here (402); there is NO fallback to a shared wallet.
// The full create→fund→research→settle cycle (~26s) runs in job-run-background.
import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { formatUnits } from "viem";
import crypto from "node:crypto";
import { json, parseBody, CONTRACTS, USDC_DECIMALS, sendCapUsdc } from "./_arc.mjs";
import { requireSession, internalToken } from "./_auth.mjs";
import { ensureOwnerWallet, WALLET_PROVISIONING_STATUS, walletProvisioningRefusal, WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal, isWalletUnresolvable } from "./_agent-wallets.mjs";
import { assertNotPaused } from "./_pause.mjs";
import { AGENT } from "./_agents.mjs";
import { publicClient } from "./_predict.mjs";
import { makeRefuser, REFUSAL } from "./_budget.mjs";

const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectBlobs(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  // ⭐ ONE REFUSER PER HANDLER, bound once. `resolveOwner` is LAZY: the audit trail is keyed by the
  // AGENT WALLET, but the cap is checked BEFORE that wallet is resolved (deliberately — an over-cap
  // request should get the cap message, not a wallet error). So the owner is resolved only if a
  // refusal actually fires, and enforcement ORDER is unchanged.
  const refuse = makeRefuser({
    source: "job-run",
    resolveOwner: () => ensureOwnerWallet(session).then((w) => w?.walletAddress ?? null).catch(() => null),
  });


  const { question, budgetUsdc } = parseBody(event);
  if (!question || !String(question).trim()) {
    return json(400, { error: "question required" });
  }
  const budget = Number(budgetUsdc);
  if (!(budget > 0)) return json(400, { error: "valid budgetUsdc required" });

  // Per-transaction hard cap on the escrow deposit — the SAME sendCapUsdc used by
  // send/executeAction across the money surface. Server-side enforcement in the
  // authenticated path so no client can bypass it (the job-quote clamp is only a
  // suggestion). Reject, never clamp: funding a different amount than the user
  // asked for is never acceptable.
  const cap = sendCapUsdc();
  if (budget > cap) {
    return json(400, {
      error: `Deposit ${budget} exceeds per-transaction limit of ${cap} USDC`,
    });
  }

  // Resolve the caller's OWN wallet from the session. NEVER client-supplied,
  // NEVER the shared env wallet.
  let wallet;
  // ⭐ A THROW HERE IS A REFUSAL, NOT A CRASH. Unwrapped it surfaced as a bare 500 that said
  // nothing about retryability or whether anything happened. See walletUnresolvableRefusal.
  try { wallet = await ensureOwnerWallet(session); }
  // ⚠️ ONLY the tagged external failure earns this diagnosis. Anything else — a TypeError from
  // a bad refactor, say — RE-THROWS and surfaces unclaimed, rather than borrowing a
  // "temporary, please retry" it cannot honour.
  catch (e) {
    if (!isWalletUnresolvable(e)) throw e;
    return json(WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal(e));
  }
  if (wallet.pending) {
    return json(WALLET_PROVISIONING_STATUS, walletProvisioningRefusal());
  }
  const walletAddress = wallet.walletAddress;

  // Balance gate on the user's OWN wallet. Insufficient → clean error, no
  // fallback. (Gasless: the wallet needs only the budget, gas is sponsored.)
  let have = 0;
  try {
    const raw = await publicClient().readContract({
      address: CONTRACTS.USDC,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [walletAddress],
    });
    have = Number(formatUnits(raw, USDC_DECIMALS));
  } catch (e) {
    return json(502, { error: `could not read wallet balance: ${e.message}` });
  }
  // ── THE KILL SWITCH. A research job funds an escrow and then buys data — a paused
  // Researcher must not be able to start one. Checked BEFORE the funds gate so a paused
  // agent gets the honest reason, not "insufficient funds". Fail-closed. ──
  const paused = await assertNotPaused({ owner: walletAddress, agent: AGENT.RESEARCHER });
  if (paused) return json(409, { error: await refuse(REFUSAL.PAUSED, paused, budget), paused: true });

  if (have < budget) {
    return json(402, {
      error: "Insufficient funds — please fund your agent wallet.",
      need: Number(budget.toFixed(2)),
      have: Number(have.toFixed(2)),
      walletAddress,
    });
  }

  // Start the background lifecycle. Track it by a random runId the browser polls.
  const runId = crypto.randomUUID();
  const store = getStore("job-runs");
  await store.setJSON(`run:${runId}`, {
    runId,
    owner: session.address,
    walletAddress,
    // `question` is stored so job-run-status can RE-FIRE job-run-background if this run
    // stalls at "starting" (Netlify occasionally acks a background invocation without
    // running it). createJob needs the question string, and it lives only here.
    question: String(question),
    budgetUsdc: budget,
    status: "starting",
    createdAt: new Date().toISOString(),
  });

  const base =
    process.env.DEPLOY_URL ||
    `${event.headers["x-forwarded-proto"] || "https"}://${event.headers.host}`;
  try {
    await fetch(`${base}/.netlify/functions/job-run-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-token": internalToken() },
      body: JSON.stringify({ runId, question: String(question), budgetUsdc: budget, walletAddress, owner: session.address }),
    });
  } catch (e) {
    return json(502, { error: `could not start job worker: ${e.message}` });
  }

  return json(202, { runId, walletAddress });
}
