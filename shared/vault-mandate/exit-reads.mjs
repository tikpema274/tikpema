// exit-reads.mjs — piece 5 step 5: the FRESH EXECUTION READS, taken before anything is written. Pure over injected
// endpoint readers (the viem reader is _vault-mandate-check.mjs's viemEndpointReader).
// Design: PROGRESS piece 5 §4 ("fresh execution reads + simulated redeem"), C9 (the SIMULATED redeem, never maxRedeem),
// blocker 3 (the exit path), and T's order (2026-09-29): READS → INTENT → SUBMIT.
//
// ═══ WHY THESE RUN FIRST ═════════════════════════════════════════════════════════════════════════════
// Every refusal here happens BEFORE the intent, so it burns no attempt: a vault short of cash right now is refused by
// the simulated redeem and simply retried on a later tick. Attempts are consumed only by real submissions.
//
// ═══ WHAT IS READ, AND THE RULE FOR EACH ═════════════════════════════════════════════════════════════
// One FRESH anchor both endpoints agree on (resolveAnchor: hash AND chain time), then at that block hash, on BOTH:
//   · the wallet's live share balance → the step-3 limit min(tracked, live)
//   · the vault's declared exit fee (withdrawFee, bps) → decideExit's fee gate; and the preview-implied fee, recorded
//   · the exit path (exit-path.mjs) → the blocker-3 gate
//   · a SIMULATED redeem of exactly the LIMIT (never the whole wallet), classified by redeem-sim.mjs
// Every figure is used only where both endpoints agree. A failed read is a retry, never a 0.

import { resolveAnchor } from "./anchor.mjs";
import { shareLimitForRecord } from "./share-limit.mjs";
import { classifyRedeemSimulation, REDEEM_SIM_CLASS } from "./redeem-sim.mjs";
import { readExitPath, agreedExitPath } from "./exit-path.mjs";

const asBig = (v) => (typeof v === "bigint" ? v : null);
const no = (code, why, then) => ({ ok: false, code, why, then });

/**
 * @param {{record:object, readers:Array}} a
 * @returns {{ok:true, anchor, liveShares, limit, exitFeeBps, measuredExitBps, exitPath, simulation:{class, assetsRaw}}
 *          | {ok:false, code, why, then:"retry"|"none"}}
 */
export async function readExitExecution({ record, readers }) {
  if (!Array.isArray(readers) || readers.length < 2) return no("reads-failed", "the exit reads need two endpoints", "retry");
  const a = await resolveAnchor(readers);
  if (!a.ok) return no("no-anchor", `no fresh anchor both endpoints agree on: ${a.why}`, "retry");
  const anchor = a.anchor;
  const vault = record.vault, holder = record.walletAddress;

  const one = async (reader) => {
    const read = async (fn, args = []) => {
      const v = asBig(await reader.read({ address: vault.address, fn, args, blockHash: anchor.blockHash }));
      if (v === null) throw new Error(`${fn} did not return an integer`);
      return v;
    };
    try {
      const [shares, withdrawFee, decimals] = await Promise.all([read("balanceOf", [holder]), read("withdrawFee"), read("decimals")]);
      const probe = 10n ** decimals;
      const [gross, net] = await Promise.all([read("convertToAssets", [probe]), read("previewRedeem", [probe])]);
      const exitPath = await readExitPath({ reader, vault, anchor });
      const measured = gross > 0n && net <= gross ? Number(((gross - net) * 10000n + gross / 2n) / gross) : null;
      return { ok: true, shares, withdrawFee, measured, exitPath };
    } catch (e) { return { ok: false, why: `read failed at ${reader?.endpoint}: ${String(e?.message ?? e)}` }; }
  };
  const rs = await Promise.all(readers.map(one));
  const bad = rs.find((r) => !r.ok);
  if (bad) return no("reads-failed", bad.why, "retry");
  const same = (f) => new Set(rs.map((r) => String(f(r)))).size === 1;
  if (!same((r) => r.shares) || !same((r) => r.withdrawFee) || !same((r) => r.measured)) {
    return no("reads-unagreed", "the endpoints disagree on the live shares or the exit fee", "retry");
  }
  const exitPath = agreedExitPath(rs.map((r) => r.exitPath));

  // the step-3 limit, on the agreed live balance
  const limit = shareLimitForRecord(record, rs[0].shares);
  if (!limit.ok) return no(limit.code, limit.why, "none");
  if (limit.nothingToRedeem) return no("nothing-to-redeem", `the mandate holds no shares of its own (tracked ${limit.tracked}); ${limit.notTheMandates} in the wallet are not the mandate's`, "none");

  // the simulated redeem of EXACTLY the limit, on both endpoints
  const sims = await Promise.all(readers.map((reader) => reader.simulateRedeem({ vault: vault.address, shares: BigInt(limit.shares), holder, blockHash: anchor.blockHash })
    .then(classifyAndKeep, (e) => ({ class: REDEEM_SIM_CLASS.RPC_FAILURE, why: String(e?.message ?? e) }))));
  const classes = sims.map((s) => s.class);
  if (classes.every((c) => c === REDEEM_SIM_CLASS.SHORTFALL)) {
    return no("vault-cannot-pay", `the vault cannot pay the mandate's ${limit.shares} shares right now (simulated redeem: ${sims[0].why}); a later tick tries again — no attempt was used`, "retry");
  }
  if (classes.some((c) => c === REDEEM_SIM_CLASS.RPC_FAILURE || c === REDEEM_SIM_CLASS.OUR_ERROR)) {
    return no("simulation-outage", `the simulated redeem got no usable answer (${sims.map((s) => s.why).join("; ")})`, "retry");
  }
  if (classes.some((c) => c === REDEEM_SIM_CLASS.UNRECOGNISED)) {
    return no("simulation-unrecognised", `the simulated redeem's answer is not one we recognise (${sims.map((s) => s.why).join("; ")}); never read as a pass`, "none");
  }
  if (!classes.every((c) => c === REDEEM_SIM_CLASS.PAID) || new Set(sims.map((s) => s.assetsRaw)).size !== 1) {
    return no("reads-unagreed", `the endpoints disagree on the simulated redeem (${sims.map((s) => `${s.class}:${s.assetsRaw ?? "-"}`).join(" vs ")})`, "retry");
  }
  return {
    ok: true, anchor, liveShares: rs[0].shares.toString(), limit,
    exitFeeBps: Number(rs[0].withdrawFee), measuredExitBps: rs[0].measured,
    exitPath, simulation: { class: REDEEM_SIM_CLASS.PAID, assetsRaw: sims[0].assetsRaw },
  };
}

function classifyAndKeep(outcome) {
  const c = classifyRedeemSimulation(outcome);
  return { ...c, assetsRaw: outcome?.outcome === "returned" ? String(outcome.assetsRaw) : null };
}
