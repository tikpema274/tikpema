// verify-passkey-sponsorship.tsx — test:passkeysponsor. A PASSKEY USER-OP THAT CIRCLE REFUSES SHOWS OUR LINE, NEVER VIEM'S.
//
// ═══ THE DEFECT ═══════════════════════════════════════════════════════════════════════════════
// 2026-10-08: Circle paused Modular Wallets (status.circle.com q2q22hphfrb1), then re-enabled them at 21:56 UTC with the
// PAYMASTER still paused. T's passkey panel showed "Error: Missing or invalid parameters… the specified blockchain is either
// not supported or deprecated. Version: viem@2.52.2". Every passkey user-op here asks for `paymaster: true`.
//
// ⭐ ASSERTED ON OUTPUT, WITH REAL VIEM ERRORS (InternalRpcError / InvalidParamsRpcError) thrown by a MOCKED bundler — the
// shapes Circle's refusals arrive in — and rendered through describeChainError, which is what the panels call.
// ⛔ THE BOUNDARY is pinned in the source: in each of the four passkey functions (six sponsored sends), every fee/nonce read and every
// sendUserOperation sits inside beforeAccepted, every receipt wait inside afterAccepted, and the approval sentence is passed
// only for the step AFTER an approve confirmed.

import { readFileSync } from "node:fs";
import { InternalRpcError, InvalidParamsRpcError, RpcRequestError, HttpRequestError, UnknownRpcError, UserRejectedRequestError, custom, createPublicClient } from "viem";
import {
  STEP_LINE, NOTHING_SENT, SEND_UNKNOWN_LINE, APPROVAL_LANDED_LINE, UNCONFIRMED_LINE,
  beforeAccepted, afterAccepted, notSentError, isPasskeyCancel, recordCalls, detailsLine, type CallFailure,
  WALLET_SERVICE_LINE, connectFailureLine, isCircleServiceFailure,
} from "../src/lib/passkeySponsorship";
import { describeChainError } from "../src/lib/describeChainError";

let pass = 0, fail = 0;
const section = (t: string) => console.log(`\n── ${t}`);
const check = (label: string, ok: boolean, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${label}${!ok && detail ? `\n     ${detail}` : ""}`);
};

const circleRefusal = (msg: string, code: number) =>
  new RpcRequestError({ url: "https://modular-sdk.circle.com/v1/rpc/w3s/buidl/arcTestnet", body: { method: "pm_getPaymasterStubData" }, error: { code, message: msg } });
const refusals = [
  ["Internal error (what T saw after re-enable)", new InternalRpcError(circleRefusal("Internal error", -32603))],
  ["blockchain not supported (what T saw during the pause)", new InvalidParamsRpcError(circleRefusal("the specified blockchain is either not supported or deprecated.", -32602))],
] as const;
const cancel = Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" });

async function settle<T>(p: Promise<T>): Promise<unknown> { try { await p; return null; } catch (e) { return e; } }

section("0 — the precondition: a raw viem refusal DOES carry the version, so the defect is real");
for (const [label, e] of refusals) check(`${label}: viem's message names its version`, /Version: viem@/.test(e.message), e.message);

// (2026-10-12, T: "fix tikpema passkey") a Circle call that FAILS, through a recorded transport — the shape the real one has
function circleTransport(fail: Record<string, unknown>, log: CallFailure[]) {
  return recordCalls(custom({ async request({ method }: { method: string }) {
    if (method in fail) throw fail[method];
    if (method === "eth_chainId") return "0x4cef52";
    return "0x1";
  } }), log);
}
const pc = (fail: Record<string, unknown>, log: CallFailure[]) => createPublicClient({ transport: circleTransport(fail, log) });
const rpcErr = (method: string, msg: string, code: number) =>
  new RpcRequestError({ url: "https://modular-sdk.circle.com/v1/rpc/w3s/buidl/arcTestnet", body: { method }, error: { code, message: msg } });
const STEPS = [
  ["pm_getPaymasterStubData", "sponsor", rpcErr("pm_getPaymasterStubData", "the specified blockchain is either not supported or deprecated.", -32602)],
  ["pm_getPaymasterData", "sponsor", rpcErr("pm_getPaymasterData", "Internal error", -32603)],
  ["eth_estimateUserOperationGas", "estimate", rpcErr("eth_estimateUserOperationGas", "AA21 didn't pay prefund", -32500)],
  ["eth_sendUserOperation", "send", rpcErr("eth_sendUserOperation", "precheck failed: maxPriorityFeePerGas is 0 but must be at least 1189005", -32000)],
  ["circle_getAddress", "lookup", rpcErr("circle_getAddress", "Cannot find target wallet", -32602)],
  ["eth_getBlockByNumber", "read", rpcErr("eth_getBlockByNumber", "upstream timeout", -32603)],
] as const;

section("1 — ⭐ the line names THE STEP that failed (recorded at the transport), with Details — through describeChainError");
for (const [method, step, raw] of STEPS) {
  const log: CallFailure[] = [];
  const client = pc({ [method]: raw }, log);
  const e = await settle(beforeAccepted(() => client.request({ method } as never), {}, log));
  const shown = describeChainError(e);
  check(`${method} → "${STEP_LINE[step]}"`, shown.startsWith(`${STEP_LINE[step]} ${NOTHING_SENT} (Details: ${method} · `), shown);
  check(`${method} → Details carry Circle's code and message`, shown.includes(String((raw as { code?: number }).code)) && shown.includes(String((raw as { details?: string }).details)), shown);
  check(`${method} → no viem version`, !/viem@|Version:/i.test(shown), shown);
  const chain: unknown[] = []; for (let x = e as { cause?: unknown } | null, i = 0; x && i < 8; x = x.cause as typeof x, i++) chain.push(x);
  check(`${method} → Circle's error kept in the cause chain (for debugging)`, chain.includes(raw));
}
{
  const nonSponsor = STEPS.filter(([, step]) => step !== "sponsor");
  let blamed = 0;
  for (const [method, , raw] of nonSponsor) {
    const log: CallFailure[] = [];
    const shown = describeChainError(await settle(beforeAccepted(() => pc({ [method]: raw }, log).request({ method } as never), {}, log)));
    if (/sponsor/i.test(shown)) blamed++;
  }
  check("⛔ THE DEFECT: only pm_* failures mention sponsorship (fees, estimate, send, lookup, reads don't)", blamed === 0, `${blamed} blamed it`);
}
{
  const log: CallFailure[] = [];
  const noAnswer = new UnknownRpcError(new TypeError("Failed to fetch"));
  const e = await settle(beforeAccepted(() => pc({ eth_sendUserOperation: noAnswer }, log).request({ method: "eth_sendUserOperation" } as never), {}, log));
  const shown = describeChainError(e);
  check("a send that got NO answer → 'isn't known', never 'Nothing was transferred'", shown.startsWith(SEND_UNKNOWN_LINE) && !/Nothing was transferred/.test(shown), shown);
  check("…and its phase is sent-unconfirmed", (e as { tikpemaPhase?: string }).tikpemaPhase === "sent-unconfirmed");
}
{
  const log: CallFailure[] = [{ method: "pm_getPaymasterStubData", code: -32603, message: "an EARLIER attempt" }];
  const e = await settle(beforeAccepted(() => pc({ eth_estimateUserOperationGas: STEPS[2][2] }, log).request({ method: "eth_estimateUserOperationGas" } as never), {}, log));
  check("an earlier attempt's failure doesn't name this one", describeChainError(e).startsWith(STEP_LINE.estimate), describeChainError(e));
  const none = await settle(beforeAccepted(async () => { throw new Error("boom"); }, {}, []));
  check("nothing recorded → 'The wallet couldn't complete this.' with the error's own message in Details",
    describeChainError(none) === `${STEP_LINE.unknown} ${NOTHING_SENT} (Details: — · no code · boom)`, describeChainError(none));
}
check("Details hide a client key and a signature", detailsLine({ method: "x", code: 1, message: `TEST_CLIENT_KEY:abc:def sig 0x${"ab".repeat(70)}` }) === "x · 1 · [hidden] sig [hidden]");

section("2 — the second step of approve → act names the approval that landed");
{
  const log: CallFailure[] = [];
  const e = await settle(beforeAccepted(() => pc({ pm_getPaymasterStubData: STEPS[0][2] }, log).request({ method: "pm_getPaymasterStubData" } as never), { approvalLanded: true }, log));
  const shown = describeChainError(e);
  check("the step's line + nothing transferred + the approval sentence", shown.startsWith(`${STEP_LINE.sponsor} ${NOTHING_SENT} ${APPROVAL_LANDED_LINE} (Details: `), shown);
}

section("3 — ⛔ THE BOUNDARY: after acceptance it is 'not confirmed yet', never 'nothing was transferred'");
{
  const e = await settle(afterAccepted(async () => { throw refusals[0][1]; }));
  const shown = describeChainError(e);
  check("a failed receipt wait → the unconfirmed line", shown === UNCONFIRMED_LINE, shown);
  check("…and it does NOT say nothing was transferred", !/Nothing was transferred/.test(shown));
  const inner = await settle(afterAccepted(() => beforeAccepted(async () => { throw refusals[0][1]; }, {}, [])));
  check("an already-tagged error keeps its phase (not re-tagged)", (inner as { tikpemaPhase?: string }).tikpemaPhase === "not-sent" && describeChainError(inner).startsWith(STEP_LINE.unknown));
}

section("4 — a passkey cancel passes through untouched");
{
  check("isPasskeyCancel(NotAllowedError)", isPasskeyCancel(cancel));
  check("notSentError(cancel) is the cancel itself", notSentError(cancel) === cancel);
  check("beforeAccepted rethrows the cancel itself", (await settle(beforeAccepted(async () => { throw cancel; }))) === cancel);
}

section("5 — ⛔ THE FOUR FUNCTIONS (six sends): every send / fee read inside beforeAccepted, every wait inside afterAccepted");
const mw = readFileSync("src/wallet/useModularWallet.ts", "utf8");
const body = (name: string) => { const a = mw.indexOf(`const ${name} = useCallback(`); return a < 0 ? "" : mw.slice(a, mw.indexOf("\n  );", a)); };
const FIVE: Array<[string, number, boolean]> = [   // name, sends, two-step (approve → act)
  ["placeBetAsUser", 2, true], ["createJobAsUser", 1, false], ["fundJobAsUser", 2, true], ["fundAgentWallet", 1, false],
];
let sends = 0;
for (const [name, n, twoStep] of FIVE) {
  const b = body(name);
  check(`${name}: found`, b.length > 0);
  const raw = (b.match(/bundler\.sendUserOperation\(/g) || []).length;
  const wrapped = (b.match(/beforeAccepted\(\(\) => bundler\.sendUserOperation\(/g) || []).length;
  sends += raw;
  check(`${name}: ${n} send(s), every one inside beforeAccepted`, raw === n && wrapped === n, `raw ${raw}, wrapped ${wrapped}`);
  const fees = (b.match(/computeArcFees\(\)/g) || []).length, feesWrapped = (b.match(/beforeAccepted\(\(\) => Promise\.all\(\[computeArcFees\(\)/g) || []).length;
  check(`${name}: every fee/nonce read inside beforeAccepted`, fees === feesWrapped && fees === n, `fees ${fees}, wrapped ${feesWrapped}`);
  const waits = (b.match(/bundler\.waitForUserOperationReceipt\(/g) || []).length, waitsWrapped = (b.match(/afterAccepted\(\(\) => bundler\.waitForUserOperationReceipt\(/g) || []).length;
  check(`${name}: every receipt wait inside afterAccepted`, waits === n && waitsWrapped === n, `waits ${waits}, wrapped ${waitsWrapped}`);
  const firstWait = b.indexOf("waitForUserOperationReceipt");
  const flags = [...b.matchAll(/approvalLanded: true/g)].map((m) => m.index ?? 0);
  check(`${name}: the approval sentence ${twoStep ? "only AFTER the approve's wait" : "never"}`,
    twoStep ? flags.length === 2 && flags.every((i) => i > firstWait) : flags.length === 0, `flags at ${flags}, first wait ${firstWait}`);
  check(`${name}: its status line renders describeChainError, not \${e.message}`, !/\$\{e\.message\}/.test(b) && /describeChainError\(e\)/.test(b));
}
check("⭐ the modular transport (every send, fee and nonce read) is wrapped in recordCalls", /const modularTransport = recordCalls\(toModularTransport\(/.test(mw));
check("⭐ every paymaster-sponsored send in the file is one of these (6)", (mw.match(/paymaster: true/g) || []).length === 6 && sends === 6);

section("6 — the panel that shows createJob / fundJob errors renders describeChainError");
{
  const pp = readFileSync("src/components/PredictPanel.tsx", "utf8");
  const run = pp.slice(pp.indexOf("async function run("), pp.indexOf("\n  }", pp.indexOf("async function run(")));
  check("PredictPanel run(): setError(describeChainError(e))", /setError\(describeChainError\(e\)\)/.test(run) && !/setError\(e\.message\)/.test(run));
}

section("7 — ⭐ CONNECT (2026-10-09, T): a MOCKED Circle failure at sign-in → \"Circle's wallet service didn't respond…\", never viem, never sponsorship");
{
  check("the line is T's words exactly", WALLET_SERVICE_LINE === "Circle's wallet service didn't respond. Nothing was changed. Try again in a few minutes.");
  check("⛔ it does not mention gas sponsorship", !/sponsor|gas|paymaster/i.test(WALLET_SERVICE_LINE));
  const failures = [
    ...refusals,
    ["an HTTP failure from Circle's endpoint", new HttpRequestError({ url: "https://modular-sdk.circle.com/v1/rpc/w3s/buidl/arcTestnet", status: 503, details: "Service Unavailable" })],
    // the REAL shape: viem's buildRequest wraps a transport's raw TypeError as UnknownRpcError (a BaseError)
    ["the network never answered", new UnknownRpcError(new TypeError("Failed to fetch"))],
  ] as const;
  for (const [label, raw] of failures) {
    // what connect() would do: a mocked toCircleSmartAccount that throws Circle's failure
    const toCircleSmartAccount = async () => { throw raw; };
    const e = await settle(toCircleSmartAccount());
    const shown = connectFailureLine(e);
    check(`${label} → exactly the wallet-service line`, shown === WALLET_SERVICE_LINE, shown);
    check(`${label} → no viem, version or details`, !/viem|Version|Details:/i.test(shown), shown);
  }
  check("a passkey cancel is not Circle's failure — its own message stays", !isCircleServiceFailure(cancel) && connectFailureLine(cancel) === cancel.message);
  check("a wallet's rejection (code 4001) is a cancel, not Circle's failure", isPasskeyCancel(new UserRejectedRequestError(new Error("x"))) && !isCircleServiceFailure(new UserRejectedRequestError(new Error("x"))));
  check("⭐ a bare TypeError NOT from viem is not classified as Circle's (typed: no viem marker)", !isCircleServiceFailure(new TypeError("Failed to fetch")));
  const ours = new Error("Couldn't log in with your saved passkey.");
  check("our own plain message passes through", connectFailureLine(ours) === ours.message);
  const connectBody = mw.slice(mw.indexOf("const connect = useCallback("), mw.indexOf("}, []);", mw.indexOf("const connect = useCallback(")));
  check("⭐ connect()'s status line renders connectFailureLine, not ${e.message}",
    /setStatus\(`Error: \$\{connectFailureLine\(e\)\}`\)/.test(connectBody) && !/\$\{e\.message\}/.test(connectBody), connectBody.slice(-300));
}

console.log(`\n${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail ? 1 : 0);
