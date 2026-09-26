// state-reads.mjs — ONE endpoint's reading of the vault at the anchor block, in the shape observe.mjs
// consumes. Pure over an injected reader; the viem reader lives in _vault-mandate-check.mjs.
//
// ⭐ EVERY READ IS AT THE ANCHOR BLOCK HASH (EIP-1898). Reading by hash, not number or `latest`, means
// a provider that silently serves another block fails the read instead of answering from the wrong state.
// ⭐ ALL OR NOTHING. If any core read fails, the reading is `ok:false` with the reason; observe then
// counts it out of the quorum (OUTAGE). A partial reading with a guessed field is never produced.
// The payability leg is the exception by design: a simulated redeem that REVERTS is an answer, sorted
// by redeem-sim.mjs, not a failed read.
//
// reader: { endpoint, read({address, fn, args, blockHash}) → bigint,
//           simulateRedeem({vault, shares, holder, blockHash}) → redeemSimulationOutcome(...) }

import { classifyRedemption } from "../vault-redemption.mjs";

const asBig = (v) => (typeof v === "bigint" ? v : null);

/** Exit cost the vault's own preview implies, in bps, rounded to nearest: (gross - net) / gross. */
function measuredExitBps(gross, net) {
  if (gross <= 0n || net > gross) return null;
  return Number(((gross - net) * 10000n + gross / 2n) / gross);
}

/**
 * @param {{redemptionSignal?: {signal: string|null, why?: string|null}}} a  what maxRedeem MEANS for this vault
 *   (shared/vault-redemption.mjs, via the allowlist declaration in _vault-mandate-check.mjs). Absent or no
 *   signal → redemption `unknown` with the reason, and maxRedeem is not read at all. ⛔ Never inferred here.
 */
export async function readStateAtAnchor({ reader, vault, holder, anchor, cashOnly, redemptionSignal }) {
  const blockHash = anchor?.blockHash;
  const base = { endpoint: reader?.endpoint, blockHash };
  const read = async (fn, args = [], address = vault.address) => {
    const v = asBig(await reader.read({ address, fn, args, blockHash }));
    if (v === null) throw new Error(`${fn} did not return an integer`);
    return v;
  };
  try {
    // ⭐ maxRedeem is read ONLY when the vault's declared signal says it means something (2026-09-26): on
    // Morpho V2 it is always 0, and reading it as a limit made every holder "blocked". Not reading it when
    // it cannot be interpreted also keeps a vault that lacks it from failing the whole reading.
    const signal = redemptionSignal?.signal ?? null;
    const [withdrawFee, depositFee, decimals, shares, maxRedeem] = await Promise.all([
      read("withdrawFee"), read("depositFee"), read("decimals"), read("balanceOf", [holder]),
      signal ? read("maxRedeem", [holder]) : Promise.resolve(null),
    ]);
    const probe = 10n ** decimals;
    const [gross, net] = await Promise.all([read("convertToAssets", [probe]), read("previewRedeem", [probe])]);

    const red = classifyRedemption({ signal, why: redemptionSignal?.why ?? null, maxRedeem, shares });
    let payability;
    if (shares > 0n) {
      const outcome = await reader.simulateRedeem({ vault: vault.address, shares, holder, blockHash });
      payability = { mode: "simulated-redeem", sharesRaw: shares.toString(), outcome };
    } else {
      const [cash, counter] = await Promise.all([read("balanceOf", [vault.address], vault.assetAddress), read("totalAssets")]);
      payability = { mode: "aggregate", cashOnly: cashOnly === true, cashRaw: cash.toString(), counterRaw: counter.toString() };
    }
    return {
      ...base, ok: true,
      exitFee: { declaredBps: Number(withdrawFee), measuredBps: measuredExitBps(gross, net) },
      depositFeeBps: Number(depositFee),
      redemption: { state: red.state, positionShares: shares.toString(), basis: signal, ...(red.why ? { why: red.why } : {}) },
      payability,
    };
  } catch (e) {
    return { ...base, ok: false, why: `read failed at ${reader?.endpoint}: ${String(e?.message ?? e)}` };
  }
}
