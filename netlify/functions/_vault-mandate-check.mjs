// _vault-mandate-check.mjs — piece 3b: ONE mandate check's transport. Anchor → a DD report produced AT the
// anchor, SIGNED, and verified against agentId 851891's on-chain owner → our own reads at the same block on
// both endpoints → observeMandateCheck. Moves no money; the one write is a signature (Circle signMessage).
//
// ═══ DECISION (T, 2026-09-25): SIGN EVERY PRE-DEPOSIT CHECK ══════════════════════════════════
// The disclosure says "verified by a signed report — anyone can check it". The report in the receipt of
// the deposit that actually happened must be one the user can verify themselves; a baseline signature
// only verifies a decision made weeks earlier. So: one signMessage per check, not per mandate.
// (Contrast _vault-report.mjs, the interactive deposit gate, which deliberately does NOT sign.)
//
// ═══ ⭐⭐ THE IDENTITY IS PINNED, NOT TRUSTED FROM THE REPORT ═════════════════════════════════════
// verifyAttestation pins registry, agentId, chainId and domain (shared/dd/identity.mjs) and checks
// eth_chainId before either read; this transport passes deps.identity so a test chain pins its own.
// The pre-check below compares the same four fields, so a mismatch is named here before any call.
// ⭐ The verifying contract is NOT pinned (relaxed 2026-09-25): verifyAttestation derives it as
// ownerOf(851891) on the pinned registry, so rotating the identity's owner account does not turn
// every mandate check into an OUTAGE. A report naming any other account is still refused
// (owner-key-mismatch).
//
// ⭐ HEALTH IS NOT SKIPPED (the same rule as _vault-report.mjs): a detector that fails its own
// known-shape fixtures must not be the thing a mandate deposits on. Unknown health refuses too.
//
// ⚠️ BLOCK BINDING: the signature binds subject.blockNumber (canon/1), not the block hash —
// verifyAttestation marks the hash binding "pass 2 not built". The check records the anchor HASH beside
// the report (both endpoints agreed on it). See PROGRESS for why the mandate does not wait on pass 2.

import { readExitPath, agreedExitPath } from "../../shared/vault-mandate/exit-path.mjs";
import { createPublicClient, http, parseAbi } from "viem";
import { analyze } from "../../shared/onchain-analyze/index.mjs";
import { attachAttestation, verifyAttestation } from "../../shared/onchain-analyze/attest.mjs";
import { quorumClient } from "../../shared/onchain-analyze/quorum.mjs";
import { ARC_QUORUM_ENDPOINTS } from "../../shared/onchain-analyze/endpoints.mjs";
import { chainClient } from "../../shared/dd/client.mjs";
import { ddAttestationOptions } from "../../shared/dd/attest-circle.mjs";
import { DD_IDENTITY } from "../../shared/dd/identity.mjs";
import { pinToAnchor, resolveAnchor } from "../../shared/vault-mandate/anchor.mjs";
import { readStateAtAnchor } from "../../shared/vault-mandate/state-reads.mjs";
import { redeemSimulationOutcome } from "../../shared/vault-mandate/redeem-sim.mjs";
import { observeMandateCheck } from "../../shared/vault-mandate/observe.mjs";
import { redemptionSignalFor } from "../../shared/vault-redemption.mjs";

/**
 * Vaults whose `totalAssets` is cash: no code path moves the asset anywhere but redeem/withdraw, fees
 * and the owner's emergencyWithdraw. Only these may use the cash-vs-counter payability reading.
 */
export const CASH_ONLY_VAULTS = Object.freeze({
  "xylo-usdc": "verified source (explorer, 2026-09-25): setStrategy only stores an address; totalAssets is a storage counter moved only by deposit/mint/withdraw/redeem/harvest",
});

/**
 * WHICH VAULT PROFILE each allowlisted vault is — so the mandate's state reads know what `maxRedeem` MEANS
 * (shared/vault-redemption.mjs). Declared here, beside CASH_ONLY_VAULTS, rather than recognised per check:
 * the check reads by blockHash on two endpoints and does not re-derive the profile from bytecode.
 * ⛔ Every allowlisted vault must be declared (test:redemptionsignal) — widening the allowlist without a
 * declaration is red. An undeclared vault reads its redemption as UNKNOWN, never as maxRedeem.
 */
export const VAULT_PROFILE_OF = Object.freeze({
  "xylo-usdc": "xylo", // XyloVault family — the inspector's recognition gate matches its setFees/emergencyWithdraw surface
});
export const redemptionSignalForVault = (key) => redemptionSignalFor(Object.prototype.hasOwnProperty.call(VAULT_PROFILE_OF, key) ? VAULT_PROFILE_OF[key] : null);

// The verifying contract is deliberately absent: it is derived on-chain (ownerOf), never pinned.
const IDENTITY_FIELDS = ["registry", "agentId", "chainId", "domain"];
const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/**
 * The DD report for one check: health → analyze at the anchor → sign → pin the identity → verify.
 * @returns {{report:object|null, verification:object|null, why:string|null, cost:{signCalls:number}}}
 *   `report` is non-null ONLY when signed and verified. Anything else is `why`, never a half-report.
 */
export async function signedCheckReport({ address, anchor, deps }) {
  const cost = { signCalls: 0 };
  const no = (why, extra = {}) => ({ report: null, verification: null, why, cost, ...extra });

  let health;
  try { health = await deps.health(); } catch (e) { return no(`the DD detector's health could not be read: ${String(e?.message ?? e)}`); }
  if (health?.serving !== true) return no(`the DD detector is not known good (${health?.reason ?? "health unknown"})`);

  let report;
  try { report = await analyze(address, { client: pinToAnchor(deps.analyzeClient, anchor) }); }
  catch (e) { return no(`the DD engine failed: ${String(e?.message ?? e)}`); }
  if (report?.refusal) return no(`the DD engine refused this vault (${report.refusal.reason ?? "unspecified"})`);
  if (report?.subject?.blockNumber !== anchor.blockNumber) {
    return no(`the DD report is at block ${report?.subject?.blockNumber}, not the anchor ${anchor.blockNumber}`);
  }

  let signed;
  cost.signCalls++;
  try { signed = await attachAttestation(report, deps.signOptions); }
  catch (e) { return no(`signing the report failed: ${String(e?.message ?? e)}`); }

  const att = signed.attestation ?? {};
  for (const f of IDENTITY_FIELDS) {
    if (!same(att[f], deps.identity[f])) {
      return no(`the report's attestation names ${f} ${JSON.stringify(att[f] ?? null)}, not the DD identity's ${JSON.stringify(deps.identity[f])}`);
    }
  }
  // ⭐ The quorum's chain guard EXCLUDES a wrong-chain endpoint (verifyAttestation's own eth_chainId check
  // would instead see the two endpoints disagree and go indeterminate). Run it first.
  if (typeof deps.verifyClient?.assert === "function") {
    try { await deps.verifyClient.assert(); }
    catch (e) { return no(`the verification endpoints failed their chain guard: ${String(e?.message ?? e)}`); }
  }
  let v;
  try { v = await verifyAttestation(signed, { client: deps.verifyClient, identity: deps.identity, expect: { agentId: deps.identity.agentId, domain: deps.identity.domain } }); }
  catch (e) { return no(`the report's signature could not be checked: ${String(e?.message ?? e)}`); }
  if (v?.valid !== true) {
    return no(`the report's signature did not verify (${v?.reason ?? "unknown"}): ${v?.detail ?? ""}`.trim(), { verification: v });
  }
  return { report: signed, verification: v, why: null, cost };
}

/**
 * One full check for a stored mandate record. Never throws for a chain or signer failure: those become
 * OUTAGE observations (or a whole-check outage when no anchor or vault can be established).
 */
export async function runMandateCheck({ record, deps }) {
  const cost = { signCalls: 0 };
  // ⭐ TIMING (piece 4). The deposit refuses a check whose anchor is older than the freshness window, and
  // that window is set from the MEASURED anchor → signed + verified latency (decision 4). `anchoredAt` is
  // taken the moment the anchor is agreed; `verifiedAt` when the signed report has verified (or failed).
  const clock = typeof deps.now === "function" ? deps.now : Date.now;
  const timing = { anchoredAt: null, verifiedAt: null, signingLatencyMs: null };
  // ⭐ WHICH clock timed this check travels with it (non-enumerable: never serialised into a receipt), so the
  // write can refuse to compare anchoredAt against any other clock (depositForMandate). See PROGRESS 2026-09-26.
  Object.defineProperty(timing, "clock", { value: clock, enumerable: false });
  const whole = (reason) => ({ anchor: null, check: { outage: { reason }, observations: {}, anchor: null },
    report: null, verification: null, reportFailure: null, readings: [], cost, timing });

  const v = deps.resolveVault(record?.vault?.key);
  if (!v) return whole(`vault ${JSON.stringify(record?.vault?.key)} is no longer on the allowlist`);
  if (!same(v.address, record.vault.address)) return whole("the allowlisted vault's address is not the one this mandate was made for");

  const a = await resolveAnchor(deps.anchorReaders);
  if (!a.ok) return whole(`no anchor block: ${a.why}`);
  timing.anchoredAt = clock();

  const [rep, readings, exitPaths] = await Promise.all([
    signedCheckReport({ address: v.address, anchor: a.anchor, deps }).then((r) => {
      timing.verifiedAt = clock(); timing.signingLatencyMs = timing.verifiedAt - timing.anchoredAt; return r;
    }),
    Promise.all(deps.stateReaders.map((reader) =>
      readStateAtAnchor({ reader, vault: v, holder: record.walletAddress, anchor: a.anchor, cashOnly: deps.cashOnly(v.key),
        redemptionSignal: deps.redemptionSignal?.(v.key) }))),
    // piece 5 step 5, BLOCKER 3: the vault's EXIT PATH (profile + adapter) at the anchor, both endpoints. The exit's
    // fresh reads compare against it (exit-path.mjs). Additive: unreadable is recorded as such and changes nothing else.
    Promise.all(deps.stateReaders.map((reader) => readExitPath({ reader, vault: v, anchor: a.anchor }))),
  ]);
  const exitPath = agreedExitPath(exitPaths);
  cost.signCalls += rep.cost.signCalls;

  const check = observeMandateCheck({
    rules: record.rules, vault: { address: v.address, chainId: v.chainId }, anchor: a.anchor,
    // The report is produced AT the anchor, so no staleness is tolerated.
    maxReportAgeBlocks: 0,
    report: rep.report, reportFailure: rep.why, stateReadings: readings,
  });
  return { anchor: a.anchor, check, report: rep.report, verification: rep.verification, reportFailure: rep.why, readings, exitPath, cost, timing };
}

/**
 * The baseline piece 3's createVaultMandate records: the owner from a SIGNED, VERIFIED report at an
 * anchor, and the vault's fee cap where both endpoints agree on it (else null → "could not be read").
 * Piece 4: + `vaultAckToken`, the deposit gate's token for the disclosure the user is shown now
 * (deps.vaultAckToken({vault, holder}) — production: depositDisclosure → ackTokenFor). Without one the
 * baseline is refused: a mandate cannot deposit against a disclosure nobody acknowledged.
 */
export async function readBaseline(vault, deps, { holder = null } = {}) {
  const a = await resolveAnchor(deps.anchorReaders);
  if (!a.ok) return { ok: false, why: `no anchor block: ${a.why}` };
  const rep = await signedCheckReport({ address: vault.address, anchor: a.anchor, deps });
  if (!rep.report) return { ok: false, why: rep.why, cost: rep.cost };
  const caps = await Promise.all(deps.stateReaders.map((r) =>
    r.read({ address: vault.address, fn: "MAX_FEE", args: [], blockHash: a.anchor.blockHash }).catch(() => null)));
  const agreed = caps.length >= 2 && caps.every((c) => typeof c === "bigint") && new Set(caps.map(String)).size === 1;
  let vaultAckToken = null;
  if (typeof deps.vaultAckToken === "function") {
    try { vaultAckToken = await deps.vaultAckToken({ vault, holder }); }
    catch (e) { return { ok: false, why: `the vault's deposit disclosure could not be read: ${String(e?.message ?? e)}`, cost: rep.cost }; }
  }
  return {
    vaultAckToken,
    ok: true, owner: rep.report.owner, reportBlock: rep.report.subject.blockNumber,
    reportSigned: true, signerVerified: true, maxFeeBps: agreed ? Number(caps[0]) : null,
    anchor: a.anchor, report: rep.report, cost: rep.cost,
  };
}

/**
 * THE MANDATE'S VAULT ACK TOKEN, from a `depositDisclosure` result (_vault-disclosure.mjs) — the SAME function
 * the interactive deposit uses (inspectVault + the DD report + the dry-run gate). Pure: the caller reads the
 * disclosure and injects `digestOf` (disclosureDigest) and `tokenOf` (ackTokenFor) from _vault.mjs.
 *
 * ═══ 🚨 THE TOKEN IS RETURNED ONLY WHEN ackRequired === true (T, 2026-09-27) ═══════════════════════════
 * depositDisclosure mints `ackToken` whenever the vault's OWN verdict is WARN — deliberately, "so a caller can
 * still SHOW the token's disclosure in a blocked state". The gate can ADD a BLOCK the inspection did not carry
 * (an asset mismatch), and then `ackRequired` is false while `ackToken` is still set. A caller that took the
 * token alone would bake a BLOCKED vault's token into a mandate baseline (and into its fingerprint). So:
 * ackRequired must be exactly `true`, the vault depositable, no block present, and the token must be
 * sha256 of the digest of the inspection SHOWN — what is stored is what was shown.
 * ⚠️ A vault whose verdict is OK has no token, so a mandate cannot be made on it: `checkBaseline` requires
 * one. That is the current contract, stated here so it is not mistaken for a bug when the allowlist widens.
 *
 * `disclosure` is always returned (refusals included), so the operator sees WHY; `token` only on success, and
 * a refusal's disclosure never carries it.
 * @returns {{ok:true, token:string, disclosure:object} | {ok:false, why:string, disclosure:object|null}}
 */
export function vaultAckFromDisclosure(d, { digestOf, tokenOf }) {
  if (!d || typeof d !== "object") return { ok: false, why: "no vault disclosure was read", disclosure: null };
  const insp = d.inspection;
  let digest = null;
  try { digest = insp ? digestOf(insp) : null; } catch { digest = null; }
  const shown = {
    vault: d.vault ?? null,
    level: d.gate?.level ?? null, blocks: Array.isArray(d.gate?.blocks) ? d.gate.blocks : [], warns: Array.isArray(d.gate?.warns) ? d.gate.warns : [],
    depositable: d.depositable === true, ackRequired: d.ackRequired === true,
    holder: insp?.disclosure?.holder ?? null, holderKind: insp?.disclosure?.holderKind ?? null,
    withdrawFeeBps: insp?.withdraw?.withdrawFeeBps ?? null,
    depositFeeBps: insp?.ownerPowers?.settableFees?.currentBps?.deposit ?? null,
    // The acknowledgement token is sha256(digest): shown so anyone can check which disclosure it stands for.
    digest,
  };
  const no = (why) => ({ ok: false, why, disclosure: shown });
  if (shown.level === "BLOCK" || shown.blocks.length) {
    return no(`the vault is blocked for deposits: ${shown.blocks.map((b) => `${b.code} (${b.detail})`).join("; ") || "BLOCK"}`);
  }
  if (d.depositable !== true) return no("the vault is not depositable");
  if (d.ackRequired !== true) {
    return no(shown.level === "OK"
      ? "this vault's disclosure carries no warnings, so it has no acknowledgement token, and a mandate's baseline requires one"
      : "the disclosure does not require an acknowledgement (ackRequired is not true), so there is no token to record");
  }
  const token = d.ackToken;
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return no("the disclosure's acknowledgement token is missing or malformed");
  let expected = null;
  try { expected = insp ? tokenOf(insp) : null; } catch { expected = null; }
  if (token !== expected) return no("the acknowledgement token is not the one for the disclosure shown; nothing is recorded");
  return { ok: true, token, disclosure: { ...shown, token } };
}

// ── production wiring (viem per endpoint; the DD quorum for analyze + verification) ─────────────
const VAULT_ABI = parseAbi([
  "function withdrawFee() view returns (uint256)", "function depositFee() view returns (uint256)",
  // uint8 on the vault; read as uint256 (identical encoding) so every read returns a bigint.
  "function decimals() view returns (uint256)", "function balanceOf(address) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)", "function convertToAssets(uint256) view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)", "function totalAssets() view returns (uint256)",
  "function MAX_FEE() view returns (uint256)", "function redeem(uint256,address,address) returns (uint256)",
  "function previewDeposit(uint256) view returns (uint256)",
]);

/**
 * The anchor's view of a viem block: `{hash, timestamp}` from ONE getBlock (no extra call for the time). viem returns
 * the timestamp as a bigint; it becomes integer seconds here, and a missing one stays null (resolveAnchor refuses it).
 * A missing block → null, never a block with guessed fields.
 */
export function anchorBlockFacts(b) {
  if (!b) return null;
  return { hash: b.hash ?? null, timestamp: typeof b.timestamp === "bigint" ? Number(b.timestamp) : null };
}

export function viemEndpointReader(rpc) {
  const pc = createPublicClient({ transport: http(rpc) });
  return {
    endpoint: rpc,
    blockNumber: async () => Number(await pc.getBlockNumber()),
    block: async (n) => anchorBlockFacts(await pc.getBlock({ blockNumber: BigInt(n) })),
    read: ({ address, fn, args, blockHash }) => pc.readContract({ address, abi: VAULT_ABI, functionName: fn, args, blockHash }),
    // EIP-1898 by block HASH (measured 2026-09-29: both Arc testnet endpoints serve eth_getCode this way)
    code: ({ address, blockHash }) => pc.request({ method: "eth_getCode", params: [address, { blockHash }] }),
    async simulateRedeem({ vault, shares, holder, blockHash }) {
      try {
        const r = await pc.simulateContract({ address: vault, abi: VAULT_ABI, functionName: "redeem", args: [shares, holder, holder], account: holder, blockHash });
        return redeemSimulationOutcome({ result: r.result });
      } catch (error) { return redeemSimulationOutcome({ error }); }
    },
  };
}

/**
 * @param {{health:()=>Promise, resolveVault:Function, sign?:boolean, vaultAckToken?:Function, now?:Function}} o
 *   sign:false → signOptions omitted (probe only). vaultAckToken: readBaseline's disclosure-token reader;
 *   the create endpoint (piece 6) passes it — absent, readBaseline yields no token and creation refuses.
 *   now: the clock the check stamps anchoredAt with. The mandate tick passes ITS clock, so the check and the
 *   write share one clock by construction (depositForMandate throws otherwise); absent → Date.now (probes).
 */
export function productionDeps({ health, resolveVault, sign = true, vaultAckToken = undefined, now = undefined }) {
  const readers = ARC_QUORUM_ENDPOINTS.map(viemEndpointReader);
  const quorum = () => quorumClient(ARC_QUORUM_ENDPOINTS.map((rpc) => chainClient("arc-testnet", { rpc })));
  return {
    health, resolveVault, vaultAckToken,
    ...(typeof now === "function" ? { now } : {}),
    analyzeClient: quorum(),
    verifyClient: quorum(),
    signOptions: sign ? ddAttestationOptions() : { sign: async () => { throw new Error("signing disabled for this read-only run"); }, ...DD_IDENTITY },
    identity: DD_IDENTITY,
    anchorReaders: readers, stateReaders: readers,
    cashOnly: (key) => key in CASH_ONLY_VAULTS,
    redemptionSignal: redemptionSignalForVault,
  };
}
