import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import {
  createPublicClient,
  decodeEventLog,
  formatUnits,
  http,
  keccak256,
  parseUnits,
  toBytes,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { arcTestnet } from "viem/chains";

// To bootstrap provider wallet during setup (see Step 3)
const PROVIDER_STARTER_BALANCE = "1";

const AGENTIC_COMMERCE_CONTRACT =
  "0x0747EEf0706327138c69792bF28Cd525089e4583" as Address;
const JOB_BUDGET = parseUnits("5", 6); // 5 USDC (ERC-20, 6 decimals)

const JOB_QUESTION = "What was the result of the 2022 FIFA World Cup final?";
const RESEARCH_BASE =
  "https://6a3a6834ff74574b23e14fb1--tikpema-predict-test.netlify.app";

const circleClient = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(),
});

const agenticCommerceAbi = [
  {
    type: "function",
    name: "createJob",
    stateMutability: "nonpayable",
    inputs: [
      { name: "provider", type: "address" },
      { name: "evaluator", type: "address" },
      { name: "expiredAt", type: "uint256" },
      { name: "description", type: "string" },
      { name: "hook", type: "address" },
    ],
    outputs: [{ name: "jobId", type: "uint256" }],
  },
  {
    type: "function",
    name: "setBudget",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "optParams", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "fund",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "optParams", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "submit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "deliverable", type: "bytes32" },
      { name: "optParams", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "complete",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "reason", type: "bytes32" },
      { name: "optParams", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getJob",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "id", type: "uint256" },
          { name: "client", type: "address" },
          { name: "provider", type: "address" },
          { name: "evaluator", type: "address" },
          { name: "description", type: "string" },
          { name: "budget", type: "uint256" },
          { name: "expiredAt", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "hook", type: "address" },
        ],
      },
    ],
  },
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
] as const;

const STATUS_NAMES = [
  "Open",
  "Funded",
  "Submitted",
  "Completed",
  "Rejected",
  "Expired",
];

function extractJobId(txHash: Hex) {
  return publicClient
    .getTransactionReceipt({ hash: txHash })
    .then((receipt) => {
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: agenticCommerceAbi,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === "JobCreated") {
            return decoded.args.jobId;
          }
        } catch {
          continue;
        }
      }
      throw new Error("Could not parse JobCreated event");
    });
}

async function waitForTransaction(txId: string, label: string) {
  process.stdout.write(`  Waiting for ${label}`);
  for (let i = 0; i < 60; i++) {
    await delay(2000);
    const tx = await circleClient.getTransaction({ id: txId });
    const data = tx.data?.transaction;

    if (data?.state === "COMPLETE" && data.txHash) {
      const txHash = data.txHash;
      console.log(
        ` ✓\n  Tx: ${arcTestnet.blockExplorers.default.url}/tx/${txHash}`,
      );
      return txHash as Hex;
    }
    if (data?.state === "FAILED") {
      throw new Error(`${label} failed onchain`);
    }
    process.stdout.write(".");
  }
  throw new Error(`${label} timed out`);
}

async function printBalances(
  title: string,
  wallets: Array<{ label: string; id?: string; address?: string | null }>,
) {
  console.log(`\n${title}:`);

  for (const wallet of wallets) {
    const balances = await circleClient.getWalletTokenBalance({
      id: wallet.id!,
    });
    const usdc = balances.data?.tokenBalances?.find(
      (b) => b.token?.symbol === "USDC",
    );
    console.log(`  ${wallet.label}: ${wallet.address}`);
    console.log(`    USDC: ${usdc?.amount ?? "0"}`);
  }
}

// Resilient JSON extraction from model output — tolerate ```json fences or stray
// prose by falling back to the first {…last } span. Mirrors the research code.
function extractJson(text: string): any {
  const c = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(c);
  } catch {}
  const s = c.indexOf("{"),
    e = c.lastIndexOf("}");
  if (s !== -1 && e > s) {
    try {
      return JSON.parse(c.slice(s, e + 1));
    } catch {}
  }
  return null;
}

const EVALUATOR_SYSTEM_PROMPT = `You are an impartial work evaluator for a research job.
You receive the original question and the submitted deliverable. Judge RESPONSIVENESS ONLY:
does the deliverable actually answer the posed question and cite sources? You are NOT judging
whether the analysis is the best possible — only whether it adequately addresses the question.
Respond with ONLY JSON: {"verdict": "pass" | "fail", "reason": "<one sentence>"}`;

// Impartial AI evaluator. A SEPARATE Anthropic call (Haiku) from the Sonnet
// research run — same fetch pattern, no web search. Returns the parsed verdict.
async function evaluateDeliverable(question: string, deliverable: string) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY (env)");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system: EVALUATOR_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Original question:\n${question}\n\nSubmitted deliverable:\n${deliverable}`,
        },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || "Anthropic evaluator call failed");
  }
  const text = (data.content || [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("")
    .trim();
  return extractJson(text);
}

async function main() {
  console.log("── Step 1: Create wallets ──");

  const walletSet = await circleClient.createWalletSet({
    name: "ERC8183 Job Wallets",
  });

  const walletsResponse = await circleClient.createWallets({
    blockchains: ["ARC-TESTNET"],
    count: 2,
    walletSetId: walletSet.data?.walletSet?.id ?? "",
    accountType: "SCA",
  });

  const clientWallet = walletsResponse.data?.wallets?.[0]!;
  const providerWallet = walletsResponse.data?.wallets?.[1]!;

  console.log("\n── Step 2: Fund the client wallet ──");
  console.log("  Fund this wallet with Arc Testnet USDC:");
  console.log(`  Client: ${clientWallet.address}`);
  console.log(`  Wallet ID: ${clientWallet.id}`);
  console.log("  Public faucet:  https://faucet.circle.com");
  console.log("  Console faucet: https://console.circle.com/faucet");
  console.log("\n  This script will fund the provider wallet automatically.");

  const rl = createInterface({ input, output });
  await rl.question("\nPress Enter after the client wallet is funded... ");
  rl.close();

  console.log("\n── Step 3: Transfer starter USDC to provider ──");
  const transferTx = await circleClient.createTransaction({
    walletAddress: clientWallet.address!,
    blockchain: "ARC-TESTNET",
    tokenAddress: "0x3600000000000000000000000000000000000000",
    destinationAddress: providerWallet.address!,
    amount: [PROVIDER_STARTER_BALANCE],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  await waitForTransaction(
    transferTx.data?.id!,
    "transfer starter USDC to provider",
  );

  console.log("\n── Step 4: Check balances ──");
  await printBalances("Balances", [
    { label: "Client", ...clientWallet },
    { label: "Provider", ...providerWallet },
  ]);

  const now = await publicClient.getBlock();
  const expiredAt = now.timestamp + 3600n;

  console.log("\n── Step 5: Create job - createJob() ──");
  const createJobTx = await circleClient.createContractExecutionTransaction({
    walletAddress: clientWallet.address!,
    blockchain: "ARC-TESTNET",
    contractAddress: AGENTIC_COMMERCE_CONTRACT,
    abiFunctionSignature: "createJob(address,address,uint256,string,address)",
    abiParameters: [
      providerWallet.address!,
      clientWallet.address!,
      expiredAt.toString(),
      JOB_QUESTION,
      "0x0000000000000000000000000000000000000000",
    ],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const createJobTxHash = await waitForTransaction(
    createJobTx.data?.id!,
    "create job",
  );
  const jobId = await extractJobId(createJobTxHash);
  console.log(`  Job ID: ${jobId}`);

  console.log("\n── Step 6: Set budget - setBudget() ──");
  const setBudgetTx = await circleClient.createContractExecutionTransaction({
    walletAddress: providerWallet.address!,
    blockchain: "ARC-TESTNET",
    contractAddress: AGENTIC_COMMERCE_CONTRACT,
    abiFunctionSignature: "setBudget(uint256,uint256,bytes)",
    abiParameters: [jobId.toString(), JOB_BUDGET.toString(), "0x"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  await waitForTransaction(setBudgetTx.data?.id!, "set budget");

  console.log("\n── Step 7: Research deliverable ──");
  // Fetch a real research report from the deployed endpoint BEFORE any USDC is
  // locked, serialize it canonically (sorted keys so the same content always
  // produces the same bytes), write it to disk, and use the keccak256 of the
  // exact file bytes as the on-chain deliverable hash. Running this ahead of
  // approve / fund means a research timeout or unusable decision aborts with no
  // escrow at risk.
  console.log(`  Requesting research: ${JOB_QUESTION}`);
  const startRes = await fetch(
    `${RESEARCH_BASE}/.netlify/functions/research-start`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: JOB_QUESTION }),
    },
  );
  const startBody = startRes.ok
    ? ((await startRes.json()) as { jobId?: string })
    : null;
  const researchJobId = startBody?.jobId;
  if (!startRes.ok || !researchJobId) {
    throw new Error("research-start failed");
  }
  console.log(`  Research job: ${researchJobId}`);

  // Poll predict-status every 15s, up to a 3-minute timeout (12 × 15s).
  const POLL_INTERVAL_MS = 15_000;
  const POLL_ATTEMPTS = 12;
  let result: any = null;
  process.stdout.write("  Polling research status");
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await delay(POLL_INTERVAL_MS);
    const statusRes = await fetch(
      `${RESEARCH_BASE}/.netlify/functions/predict-status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: researchJobId }),
      },
    );
    const statusBody = (await statusRes.json().catch(() => null)) as
      | { status?: string; result?: any }
      | null;
    if (statusBody?.status === "done") {
      result = statusBody.result;
      console.log(" ✓");
      break;
    }
    process.stdout.write(".");
  }
  if (!result) {
    throw new Error(
      `research timed out — ERC-8183 job ${jobId} created but escrow NOT funded yet; safe to retry or abandon`,
    );
  }

  // Guard: never hash/submit a deliverable we can't stand behind.
  if (result.error || result.decision == null) {
    throw new Error(
      "research returned no usable decision; aborting before submit",
    );
  }

  const report = {
    question: result.question,
    model: result.model,
    decision: result.decision,
    generatedAt: new Date().toISOString(),
  };
  // Canonical JSON: sort keys at EVERY level (recursive) so identical content
  // always yields identical bytes. The stub's array-replacer form can't be used
  // here — an array replacer recurses into the nested `decision` object and
  // would strip its keys — so we use a recursive key-sorting replacer instead.
  let canonicalReport = JSON.stringify(report, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val)
            .sort()
            .map((k) => [k, val[k]]),
        )
      : val,
  );

  const reportsDir = "reports";
  mkdirSync(reportsDir, { recursive: true });
  const reportPath = join(reportsDir, `report-${jobId}.json`);

  // TEST OVERRIDE: when FORCE_BAD_DELIVERABLE is set, swap in an obviously
  // non-responsive deliverable BEFORE it is written — so the bad content is what
  // gets hashed, submitted, AND evaluated, exercising the evaluator's
  // fail → reject() path end to end. Must run before writeFileSync.
  if (process.env.FORCE_BAD_DELIVERABLE) {
    canonicalReport = JSON.stringify({
      note: "placeholder, no research performed",
    });
    console.log(
      "  ⚠ FORCE_BAD_DELIVERABLE set — substituting non-responsive deliverable",
    );
  }

  writeFileSync(reportPath, canonicalReport);

  const deliverableHash = keccak256(toBytes(readFileSync(reportPath, "utf8")));
  console.log(`  Report written: ${reportPath}`);
  console.log(`  keccak256(deliverable): ${deliverableHash}`);

  console.log("\n── Step 8: Approve USDC - approve() ──");
  const approveTx = await circleClient.createContractExecutionTransaction({
    walletAddress: clientWallet.address!,
    blockchain: "ARC-TESTNET",
    contractAddress: "0x3600000000000000000000000000000000000000",
    abiFunctionSignature: "approve(address,uint256)",
    abiParameters: [AGENTIC_COMMERCE_CONTRACT, JOB_BUDGET.toString()],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  await waitForTransaction(approveTx.data?.id!, "approve USDC");

  console.log("\n── Step 9: Fund escrow - fund() ──");
  const fundTx = await circleClient.createContractExecutionTransaction({
    walletAddress: clientWallet.address!,
    blockchain: "ARC-TESTNET",
    contractAddress: AGENTIC_COMMERCE_CONTRACT,
    abiFunctionSignature: "fund(uint256,bytes)",
    abiParameters: [jobId.toString(), "0x"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  await waitForTransaction(fundTx.data?.id!, "fund escrow");

  console.log("\n── Step 10: Submit deliverable - submit() ──");
  const submitTx = await circleClient.createContractExecutionTransaction({
    walletAddress: providerWallet.address!,
    blockchain: "ARC-TESTNET",
    contractAddress: AGENTIC_COMMERCE_CONTRACT,
    abiFunctionSignature: "submit(uint256,bytes32,bytes)",
    abiParameters: [jobId.toString(), deliverableHash, "0x"],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  await waitForTransaction(submitTx.data?.id!, "submit deliverable");

  console.log("\n── Step 11: AI evaluation → settle (complete or reject) ──");
  // Judge the submitted deliverable with a separate Haiku call, then let the
  // verdict decide settlement: pass → complete() (provider paid), fail →
  // reject() (client refunded in full, atomically per the verified contract).
  // The evaluator is job.evaluator on-chain — here the client wallet.
  const deliverableContent = readFileSync(reportPath, "utf8");
  console.log("  Evaluating deliverable responsiveness…");
  const verdict = await evaluateDeliverable(JOB_QUESTION, deliverableContent);
  if (!verdict || (verdict.verdict !== "pass" && verdict.verdict !== "fail")) {
    throw new Error("evaluator returned no usable verdict; aborting settlement");
  }
  const evaluatorReason =
    typeof verdict.reason === "string" && verdict.reason.trim()
      ? verdict.reason.trim()
      : verdict.verdict === "pass"
        ? "deliverable-approved"
        : "deliverable-rejected";
  const reasonHash = keccak256(toHex(evaluatorReason));
  console.log(`  Verdict: ${verdict.verdict.toUpperCase()}`);
  console.log(`  Reason:  ${evaluatorReason}`);

  if (verdict.verdict === "pass") {
    console.log("  → PASS: completing job — provider gets paid - complete()");
    const completeTx = await circleClient.createContractExecutionTransaction({
      walletAddress: clientWallet.address!,
      blockchain: "ARC-TESTNET",
      contractAddress: AGENTIC_COMMERCE_CONTRACT,
      abiFunctionSignature: "complete(uint256,bytes32,bytes)",
      abiParameters: [jobId.toString(), reasonHash, "0x"],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    await waitForTransaction(completeTx.data?.id!, "complete job");
  } else {
    console.log("  → FAIL: rejecting job — client refunded in full - reject()");
    const rejectTx = await circleClient.createContractExecutionTransaction({
      walletAddress: clientWallet.address!,
      blockchain: "ARC-TESTNET",
      contractAddress: AGENTIC_COMMERCE_CONTRACT,
      abiFunctionSignature: "reject(uint256,bytes32,bytes)",
      abiParameters: [jobId.toString(), reasonHash, "0x"],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    await waitForTransaction(rejectTx.data?.id!, "reject job");
  }

  console.log("\n── Step 12: Check final job state ──");
  const job = await publicClient.readContract({
    address: AGENTIC_COMMERCE_CONTRACT,
    abi: agenticCommerceAbi,
    functionName: "getJob",
    args: [jobId],
  });
  console.log(`  Job ID: ${jobId}`);
  console.log(`  Status: ${STATUS_NAMES[Number(job.status)]}`);
  console.log(`  Budget: ${formatUnits(job.budget, 6)} USDC`);
  console.log(`  Hook: ${job.hook}`);
  console.log(`  Deliverable hash submitted: ${deliverableHash}`);

  console.log("\n── Step 13: Check final balances ──");
  await printBalances("Balances", [
    { label: "Client", ...clientWallet },
    { label: "Provider", ...providerWallet },
  ]);
}

main().catch((error) => {
  console.error("\nError:", error.message || error);
  process.exit(1);
});
