import { ARC, CONTRACTS } from "./_arc.mjs";
import { GATEWAY } from "./_gateway.mjs";
import { circle, waitForTx } from "./_circle.mjs";
import { publicClient } from "./_predict.mjs";
import { withRetry, isTransient, TransientChainError } from "./_retry.mjs";

// DELEGATE AUTHORIZATION PLANE — the one-time grant that lets the shared EOA signer spend
// a user's OWN Gateway balance.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────
// A Circle dev-controlled SCA CANNOT sign its own Gateway spend (ecrecover rejects the
// SCA's ERC-1271 signature), so DELEGATE_ADDRESS — a plain EOA — signs while funds are
// sourced from the SCA (see _pay.mjs / _ubspend.mjs).
//
// That authority is NOT ambient. It is granted per-depositor, on-chain, by
// `addDelegate(address token, address delegate)` on the Gateway Wallet, and read back with
// `isAuthorizedForBalance(address token, address depositor, address addr)`.
//
// PROVEN (scripts/probe-delegate-status.mjs): the shared agent SCA reads `true` — which is
// why spend works there today — while ALL 48 other SCAs on the entity read `false`. The
// authority does NOT carry over to a freshly-provisioned per-user wallet. Each user's SCA
// must grant it for ITSELF, exactly once.
//
// This is also the per-user SAFETY property: one shared signer cannot touch a wallet that
// has not authorized it. The Gateway itself enforces that — not our code.
//
// ── THE ORDERING (load-bearing — do not reorder) ─────────────────────────────────────
//   fund (hop A) → ensureDelegate → deposit → spend
//
// `addDelegate` is a gas-paying tx, and on Arc gas IS USDC. On a brand-new, EMPTY SCA that
// would be a chicken-and-egg. It isn't one, because this runs from INSIDE ubDeposit, AFTER
// its insufficient-funds check — so by construction the SCA already holds at least the
// deposit amount when we get here. There is NO code path that attempts addDelegate on an
// empty wallet: the balance check throws first.
//
// GAS SOURCE, concretely: per-user SCA userOps on Arc are paymaster-sponsored — decoded
// from real EntryPoint UserOperationEvents, paymaster 0x7ceA357B5AC0639F89F9e378a1f03Aa5005C0a25,
// across different wallets AND different wallet-sets (scripts/probe-addDelegate-gas.mjs).
// So the paymaster pays and the user's balance is untouched. BUT we do not depend on that:
// Gas Station policies can be contract-scoped, and we have not proven GatewayWallet is in
// scope. If it isn't, the SCA self-pays from the USDC it was just funded with (~0.07). The
// ordering above is what makes BOTH outcomes fine — that is the whole point of it.

const GATEWAY_ABI = [
  {
    type: "function",
    name: "isAuthorizedForBalance",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "depositor", type: "address" },
      { name: "addr", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
];

// Is `delegate` already authorized to spend `owner`'s Gateway USDC? A pure read — this is
// the SOURCE OF TRUTH for authorization, never a cached flag. A Blobs mirror could go stale
// against the chain (or lie after a failed tx); the chain cannot.
//
// ⚠️ TWO OUTCOMES, THREE MEANINGS. This returns a boolean, so it can only express "yes" and
// "no" — the third meaning, "the chain did not answer", is expressed by THROWING. A rate-limit
// is not a `false`. Retrying the transient class here (see _retry.mjs for the evidence that
// viem does not) turns most throttles back into a real answer; when it can't, the throw is a
// TransientChainError and callers must keep it distinct from `false`. Never .catch(() => false).
export async function isDelegateAuthorized(owner, delegate = process.env.DELEGATE_ADDRESS) {
  if (!owner) throw new Error("isDelegateAuthorized requires an owner");
  if (!delegate) throw new Error("Missing DELEGATE_ADDRESS");
  return withRetry(
    () =>
      publicClient().readContract({
        address: GATEWAY.WALLET,
        abi: GATEWAY_ABI,
        functionName: "isAuthorizedForBalance",
        args: [CONTRACTS.USDC, owner, delegate],
      }),
    { label: "check the Gateway spender authorization" }
  );
}

// The same read, as an explicit TRI-STATE for the one caller that must not conflate the
// third meaning with the second: { authorized: true } | { authorized: false } | { unknown: true }.
//
// ⚠️ THIS IS THE FIX FOR THE REAL BUG. ensureDelegate's post-failure re-read used to be
// `.catch(() => false)`, which turned "I could not read the chain" into "the chain says NO"
// — an INDETERMINATE collapsed into a definite FAIL, on the path that gates a fund action.
// A throttled re-read would then report the user's spender as unauthorized when it may well
// have been authorized all along. Unknown must never wear the face of a definite answer.
// ⚠️ THE UNKNOWN CARRIES ITS REASON. Both branches below return `unknown` — that part is
// right, because neither is an answer about authorization. But they are unknown for DIFFERENT
// reasons, and the caller must not describe one as the other. The first version of this
// hardcoded "Arc's network is rate-limiting requests" into every unknown's message, which
// would have asserted a throttle for a revert or a bad address — inventing a cause the
// evidence doesn't support. That is the same sin as writing "Arc RPC rate-limited" on a card
// that reads a REST API, and it was in this file.
async function readAuthorizationTriState(owner, delegate) {
  try {
    return { authorized: await isDelegateAuthorized(owner, delegate) };
  } catch (e) {
    // Couldn't read. Say THAT — do not guess, in either direction.
    if (e instanceof TransientChainError || isTransient(e)) {
      return { unknown: true, reason: "transient", cause: e };
    }
    // A non-transient read failure (bad address, ABI mismatch, chain gone) is also not a
    // `false`. It is a different unknown, and it is equally not an answer about authorization
    // — but it is NOT a rate limit, and must never claim to be.
    return { unknown: true, reason: "other", cause: e };
  }
}

// The words for an unknown, matched to WHY it is unknown. Only the transient branch names a
// cause, because only it has one on the evidence.
function unknownMessage(reason, verb) {
  const tail = `No funds moved; your USDC is still in your wallet.`;
  return reason === "transient"
    ? `Couldn't ${verb} the Gateway spender authorization — Arc's network is rate-limiting ` +
        `requests. ${tail} Try the deposit again in a moment.`
    : `Couldn't ${verb} the Gateway spender authorization. ${tail} ` +
        `This isn't a temporary network problem — please report it if it repeats.`;
}

// Exhausted retries while trying to VERIFY authorization. Distinct from DelegateAuthError:
// that one means "we tried to authorize and the chain said it didn't happen" (a definite
// negative). This one means "we do not know" — and the honest words are different.
//
// Both share `fundsMoved: false`, and that is not a guess: ensureDelegate runs BEFORE any
// approve/deposit (see the ordering note in _ubdeposit.mjs), so nothing can have moved by
// the time either is thrown.
export class DelegateAuthUnknownError extends Error {
  constructor(message, cause, reason = "other") {
    super(message);
    this.name = "DelegateAuthUnknownError";
    this.cause = cause;
    this.reason = reason; // "transient" | "other"
    this.recoverable = true;
    // ⚠️ NOT unconditionally true. This was `this.transient = true` for every unknown, which
    // would flag a revert or a bad address as a rate limit — the same false flag that misled
    // a reader on record dep:07fdbcb0, just pointed the other way. A flag must describe what
    // happened, not what usually happens.
    this.transient = reason === "transient";
    this.indeterminate = true; // NOT a definite "unauthorized" — do not render it as one
  }
}

export class DelegateAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "DelegateAuthError";
    this.recoverable = true; // no funds moved; retrying the deposit re-runs this
  }
}

// One short line from an error that may be a 15-line viem dump.
//
// viem's ContractFunctionExecutionError.message is a formatted BLOCK — "Raw Call Arguments",
// the hex calldata, "Docs: https://viem.sh/...", "Version: viem@2.52.2". Interpolating it into
// a user-facing string is what put a wall of hex on the screen on 2026-07-17. viem also
// carries the one line that actually means something in `.shortMessage` / `.details`, so
// prefer those; fall back to the first line, never the block.
function summarize(e) {
  const pick = e?.details || e?.shortMessage || e?.message || String(e);
  return String(pick).split("\n")[0].trim().slice(0, 160);
}

// Grant the delegate authority over `owner`'s Gateway balance — ONCE. Idempotent: reads
// first, and only writes if the chain says the delegate is not yet authorized. Safe to call
// on every deposit; a no-op (one eth_call) once authorized.
//
// RACE-SAFETY, without a lock: two concurrent deposits could both read `false` and both fire
// addDelegate. We do NOT take a Blobs mutex for this — a lock introduces a worse failure
// (a crash between claim and tx would strand the claim, permanently blocking the user).
// Instead the CHAIN arbitrates: if our addDelegate fails, we RE-READ. If a concurrent call
// already authorized us, the read says `true` and we succeed anyway. A duplicate grant is
// harmless (it sets an already-true mapping); a lost race is invisible. The only state that
// matters is on-chain, and we always re-derive it rather than trusting our own attempt.
export async function ensureDelegate({ owner, delegate = process.env.DELEGATE_ADDRESS }) {
  if (!owner) throw new Error("ensureDelegate requires an owner (the session's agent SCA)");
  if (!delegate) throw new Error("Missing DELEGATE_ADDRESS");

  // 1. Already authorized? Then this is a no-op — the common case on every deposit after
  //    the first.
  //
  // ⚠️ THIS READ IS WHERE THE RAW HEX CAME FROM. It had no error handling at all (the
  // try/catch below wraps only the addDelegate WRITE), so a throttled eth_call threw viem's
  // ~15-line dump straight up through ubDeposit into the Blobs record and onto the user's
  // screen. Proof it was this line and not the catch below: all three prod failures recorded
  // `delegateAuthFailed: false`, which is set from `e.name === "DelegateAuthError"` — so the
  // error never reached the throw at the end of this function.
  const first = await readAuthorizationTriState(owner, delegate);
  if (first.unknown) {
    // We could not read. Do NOT fall through to addDelegate: that would submit a gas-paying
    // tx on the assumption of a `false` we never actually observed.
    throw new DelegateAuthUnknownError(
      unknownMessage(first.reason, "verify"),
      first.cause,
      first.reason
    );
  }
  if (first.authorized) {
    return { authorized: true, alreadyAuthorized: true, txHash: null };
  }

  // 2. Not authorized — grant it. Direct contract execution polled by Circle tx id
  //    (waitForTx), the same path ubDeposit/agent-send use: it returns the REAL hash and
  //    cannot hit the App Kit 1098 async-hash race.
  const client = circle();
  try {
    const tx = await client.createContractExecutionTransaction({
      walletAddress: owner,
      blockchain: ARC.blockchain,
      contractAddress: GATEWAY.WALLET,
      abiFunctionSignature: "addDelegate(address,address)",
      abiParameters: [CONTRACTS.USDC, delegate],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const txHash = await waitForTx(client, tx.data?.id);
    return { authorized: true, alreadyAuthorized: false, txHash };
  } catch (e) {
    // 3. The tx failed — but did the STATE still end up right? A concurrent deposit may
    //    have granted it (our tx would then revert as a duplicate), or the tx may have
    //    landed while our poll timed out. Re-derive from the chain before calling it a
    //    failure. This is what makes the lock-free design safe.
    //
    // ⚠️ THIS RE-READ USED TO BE `.catch(() => false)` — THE REAL BUG. A throttled re-read
    // returned `false`, and `false` here means "the chain says the delegate is NOT
    // authorized", which we then reported to the user as a definite authorization failure.
    // It was an INDETERMINATE wearing the face of a FAIL, and it gated a fund action: the
    // user could have been authorized all along and been told otherwise. The re-read is
    // now a tri-state, and `unknown` gets its own words.
    const recheck = await readAuthorizationTriState(owner, delegate);
    if (recheck.authorized) {
      return { authorized: true, alreadyAuthorized: true, txHash: null, raced: true };
    }
    if (recheck.unknown) {
      // The write failed AND we cannot read the state back. We genuinely do not know whether
      // the grant landed. Still no funds moved (this is all pre-approve), and the deposit is
      // still safe to retry — ensureDelegate re-reads first, and a duplicate grant is a
      // harmless no-op. But we must not claim the definite negative we did not observe.
      throw new DelegateAuthUnknownError(
        unknownMessage(recheck.reason, "confirm"),
        recheck.cause,
        recheck.reason
      );
    }
    // Genuinely not authorized — the chain ANSWERED, and the answer was no. NO FUNDS HAVE
    // MOVED: ubDeposit calls this BEFORE any approve/deposit, so the user's USDC is still
    // plain in their own SCA. A clean, retryable state, not a stranded one.
    //
    // The cause is summarized, NOT interpolated raw: `${e.message}` on a viem error is a
    // ~15-line dump of the eth_call, its hex calldata and a docs link, and it used to go
    // straight to the user's screen. Operators get the full object on `.cause`.
    throw Object.assign(
      new DelegateAuthError(
        `Could not authorize the spender for your Gateway balance: ${summarize(e)}. ` +
          `No funds moved — your USDC is still in your wallet. Retry the deposit.`
      ),
      { cause: e }
    );
  }
}
