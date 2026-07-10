// POST /api/job-run { question, budgetUsdc }  (auth required)  — Sub-brick 2b
//
// Entry point for the server-driven research job. The ENTIRE lifecycle now runs
// on the AUTHENTICATED user's OWN agent wallet (from the 2a mapping, resolved
// from the session — never client-supplied, never the shared env wallet).
//
// This sync front door does only fast work: resolve the user's wallet, check its
// balance, and — if funded — kick off the background worker. The insufficient-
// funds case returns cleanly here (402); there is NO fallback to a shared wallet.
// The full create→fund→research→settle cycle (~26s) runs in job-run-background.
import { connectLambda, getStore } from "@netlify/blobs";
import { formatUnits } from "viem";
import crypto from "node:crypto";
import { json, parseBody, CONTRACTS, USDC_DECIMALS, sendCapUsdc } from "./_arc.mjs";
import { requireSession, internalToken } from "./_auth.mjs";
import { ensureOwnerWallet } from "./_agent-wallets.mjs";
import { publicClient } from "./_predict.mjs";

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
  if (event.blobs) connectLambda(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

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
  const wallet = await ensureOwnerWallet(session);
  if (wallet.pending) {
    return json(202, {
      status: "provisioning",
      message: "Your agent wallet is being set up — retry shortly.",
    });
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
