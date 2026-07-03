// job-run-background.mjs — the server-driven create+fund stage (Sub-brick 2b).
//
// Internal-only (server-to-server, internal token). Runs the on-chain job setup
// on the AUTHENTICATED user's OWN agent wallet (threaded in from job-run — never
// env, never client-supplied): createJob (client=provider=evaluator=the wallet),
// setBudget, approve, fund. Then hands off to job-submit-background (research +
// submit + settle), threading the same wallet. Progress is written to the
// "job-runs" store under the runId so the browser can poll job-run-status.
//
// This is contained to WALLET RESOLUTION + orchestration — it reuses the exact
// contract calls the client-side path used, just signed by the per-user wallet.
import { connectLambda, getStore } from "@netlify/blobs";
import { parseEventLogs } from "viem";
import { ARC, CONTRACTS, USDC_DECIMALS, parseBody } from "./_arc.mjs";
import { circle, waitForTx } from "./_circle.mjs";
import { requireInternal, internalToken } from "./_auth.mjs";
import { publicClient } from "./_predict.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";

const JOB_CREATED_ABI = [
  {
    type: "event",
    name: "JobCreated",
    inputs: [
      { indexed: true, name: "jobId", type: "uint256" },
      { indexed: true, name: "client", type: "address" },
      { indexed: true, name: "provider", type: "address" },
      { indexed: false, name: "evaluator", type: "address" },
      { indexed: false, name: "expiredAt", type: "uint256" },
      { indexed: false, name: "hook", type: "address" },
    ],
    anonymous: false,
  },
];

export async function handler(event) {
  if (event.blobs) connectLambda(event);
  if (!requireInternal(event)) return { statusCode: 401, body: "unauthorized" };

  const { runId, question, budgetUsdc, walletAddress, owner } = parseBody(event);
  if (!runId || !walletAddress) return { statusCode: 400, body: "runId and walletAddress required" };

  const store = getStore("job-runs");
  const setRun = (patch) =>
    store.setJSON(`run:${runId}`, { runId, owner, walletAddress, budgetUsdc, ...patch });

  try {
    const circleClient = circle();
    const units = BigInt(Math.round(Number(budgetUsdc) * 10 ** USDC_DECIMALS)).toString();
    const expiredAt = String(Math.floor(Date.now() / 1000) + 86400); // +24h

    const exec = async (contractAddress, sig, params) => {
      const tx = await circleClient.createContractExecutionTransaction({
        walletAddress,
        blockchain: ARC.blockchain,
        contractAddress,
        abiFunctionSignature: sig,
        abiParameters: params,
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      });
      return waitForTx(circleClient, tx.data?.id);
    };

    // 1. createJob — the user's wallet is client, provider AND evaluator (a
    // personal agent that funds its own research budget).
    await setRun({ status: "creating" });
    const createHash = await exec(
      CONTRACTS.AGENTIC_COMMERCE,
      "createJob(address,address,uint256,string,address)",
      [walletAddress, walletAddress, expiredAt, String(question), ZERO]
    );
    const rcpt = await publicClient().getTransactionReceipt({ hash: createHash });
    const created = parseEventLogs({ abi: JOB_CREATED_ABI, eventName: "JobCreated", logs: rcpt.logs })[0];
    if (!created) throw new Error("could not parse JobCreated event");
    const jobId = created.args.jobId.toString();
    await setRun({ jobId, status: "funding" });

    // 2. setBudget → 3. approve → 4. fund (all on the user's own wallet).
    await exec(CONTRACTS.AGENTIC_COMMERCE, "setBudget(uint256,uint256,bytes)", [jobId, units, "0x"]);
    await exec(CONTRACTS.USDC, "approve(address,uint256)", [CONTRACTS.AGENTIC_COMMERCE, units]);
    await exec(CONTRACTS.AGENTIC_COMMERCE, "fund(uint256,bytes)", [jobId, "0x"]);
    await setRun({ jobId, status: "funded" });

    // 5. Hand off to research + submit + settle, threading the same wallet.
    const base =
      process.env.DEPLOY_URL ||
      `${event.headers["x-forwarded-proto"] || "https"}://${event.headers.host}`;
    await fetch(`${base}/.netlify/functions/job-submit-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-token": internalToken() },
      body: JSON.stringify({ jobId, question, walletAddress }),
    });
  } catch (e) {
    await setRun({ status: "failed", error: e.message });
  }
  return { statusCode: 202 };
}
