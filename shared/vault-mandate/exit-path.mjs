// exit-path.mjs — piece 5 step 5, BLOCKER 3: does the vault's EXIT PATH (its liquidity adapter) still match the one the
// finding check recorded? Pure, over an injected reader.
// Design: PROGRESS piece 5 blocker 3 (T, 2026-09-28: the allocator's zero-timelock redirect) + T's step-5 rule
// (2026-09-29): xylo is trivially satisfied (no adapter); a V2 vault REFUSES until the DD V2 profile exists — the
// comparison is never skipped. A structural refusal, not a note.
//
// ═══ WHAT IS COMPARED ═══════════════════════════════════════════════════════════════════════════════
// The vault's governance PROFILE, recognised from its bytecode at the block (vault-profiles.mjs, the same recognition
// the DD engine and the deposit gate use), and the ADAPTER that profile routes redemptions through. The finding check
// records it; the fresh execution reads re-derive it; the exit goes only if both are READABLE, both are a KNOWN exit
// path, and they are the same.
//
// ⛔ AN UNKNOWN EXIT PATH REFUSES, ON EITHER SIDE, EVEN WHEN BOTH SIDES AGREE. "Recorded unknown == fresh unknown" is
// not a match: it is two readings that do not know where the redeem's liquidity comes from. A Morpho V2 vault is
// unrecognised today (no V2 profile) → `exit-path-unverifiable` until the DD V2 window adds the profile AND an adapter
// reading here.
// ⛔ STRUCTURAL: EXIT_PATHS may only declare `adapter: null` today. An entry that declares an adapter THROWS at load
// (assertExitPathRegistry), because no adapter comparison is built: a V2 entry cannot be added by editing a table.

import { recognizeVaultProfile } from "../onchain-facts/vault-profiles.mjs";
import { hasSel } from "../onchain-facts/index.mjs";

/** Exit paths we KNOW. xylo: redeem() pays from the vault's own cash (previewRedeem → asset.transfer, verified source). */
export const EXIT_PATHS = Object.freeze({
  xylo: Object.freeze({ adapter: null, why: "XyloVault redeems from its own cash: no liquidity adapter" }),
});

/** ⛔ Load-time guard: an entry that routes through an adapter needs an adapter READING and comparison, which do not exist. */
export function assertExitPathRegistry(registry) {
  for (const [name, p] of Object.entries(registry ?? {})) {
    if (!p || p.adapter !== null) {
      throw new Error(`exit-path: profile "${name}" declares an adapter (${JSON.stringify(p?.adapter)}), but no adapter reading or comparison is built — build them (the DD V2 window) before adding it`);
    }
  }
}
assertExitPathRegistry(EXIT_PATHS);

/** The exit path a recognised profile name implies. Unregistered or null → unknown. */
export function exitPathFromProfile(profile) {
  const p = typeof profile === "string" && Object.prototype.hasOwnProperty.call(EXIT_PATHS, profile) ? EXIT_PATHS[profile] : null;
  return p ? { known: true, profile, adapter: p.adapter } : { known: false, profile: profile ?? null, adapter: null, why: `no known exit path for ${JSON.stringify(profile ?? null)}` };
}

/**
 * One endpoint's reading: the vault's code at the block HASH (EIP-1898) → its profile → its exit path.
 * @returns {{readable:true, known:boolean, profile, adapter} | {readable:false, why}}
 */
export async function readExitPath({ reader, vault, anchor }) {
  if (typeof reader?.code !== "function") return { readable: false, why: "this reader cannot read code" };
  let code;
  try { code = await reader.code({ address: vault.address, blockHash: anchor?.blockHash }); }
  catch (e) { return { readable: false, why: `code read failed at ${reader.endpoint}: ${String(e?.message ?? e)}` }; }
  if (typeof code !== "string" || !/^0x[0-9a-fA-F]*$/.test(code) || code.length <= 2) return { readable: false, why: `no code at ${vault.address} (at ${reader.endpoint})` };
  const profile = recognizeVaultProfile((sig) => hasSel(code.toLowerCase(), sig))?.name ?? null;
  return { readable: true, ...exitPathFromProfile(profile) };
}

/** Both endpoints must read it, and agree. One endpoint, a failure, or a disagreement → unreadable. */
export function agreedExitPath(readings) {
  if (!Array.isArray(readings) || readings.length < 2) return { readable: false, why: "fewer than two endpoints read the exit path" };
  const bad = readings.find((r) => r?.readable !== true);
  if (bad) return { readable: false, why: bad?.why ?? "an endpoint could not read the exit path" };
  const key = (r) => `${r.known}|${r.profile}|${r.adapter}`;
  if (new Set(readings.map(key)).size !== 1) return { readable: false, why: `the endpoints disagree on the exit path (${readings.map(key).join(" vs ")})` };
  return readings[0];
}

/**
 * The gate. `recorded` = what the finding check recorded; `fresh` = the execution reads.
 * @returns {{ok:true, profile} | {ok:false, code, why, then:"retry"|"none"}}
 */
export function exitPathGate({ recorded, fresh }) {
  const no = (code, why, then = "none") => ({ ok: false, code, why, then });
  if (!recorded) return no("exit-path-unrecorded", "the finding check recorded no exit path; the exit's liquidity route is never assumed");
  if (recorded.readable !== true) return no("exit-path-unrecorded", `the finding check could not read the exit path (${recorded.why ?? "unreadable"})`);
  if (!fresh || fresh.readable !== true) return no("exit-path-unreadable", `the exit path could not be read now (${fresh?.why ?? "unreadable"})`, "retry");
  if (recorded.known !== true || fresh.known !== true) {
    return no("exit-path-unverifiable", `the vault's exit path is not one we know (recorded ${JSON.stringify(recorded.profile)}, now ${JSON.stringify(fresh.profile)}): refused until its profile and adapter reading exist (the DD V2 window), never skipped`);
  }
  if (recorded.profile !== fresh.profile) return no("exit-path-changed", `the vault's profile changed since the finding (${recorded.profile} → ${fresh.profile})`);
  const reg = exitPathFromProfile(fresh.profile);
  if (recorded.adapter !== reg.adapter || fresh.adapter !== reg.adapter) {
    return no("exit-path-changed", `the adapter does not match the ${fresh.profile} exit path (recorded ${JSON.stringify(recorded.adapter)}, now ${JSON.stringify(fresh.adapter)}, expected ${JSON.stringify(reg.adapter)})`);
  }
  return { ok: true, profile: fresh.profile, adapter: reg.adapter };
}
