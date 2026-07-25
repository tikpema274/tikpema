// shape.mjs — WHAT KIND OF THING is at this address, and therefore WHICH CODE the powers live in.
//
// ⚠️ SHAPE IS NOT COSMETIC — IT DECIDES WHETHER THE POWER SCAN IS VALID AT ALL.
// A proxy's own bytecode is a delegatecall stub holding no business selectors; a minimal clone is 45
// bytes of jump; a diamond's powers live in facets reached through its selector table. Scanning any
// of those directly returns an EMPTY power list — a FALSE CLEAN BILL, which
// scripts/dd/checks/owner-powers.mjs:17-23 correctly names as the worst output a DD tool can produce,
// because a false flag gets argued with and a false clean bill gets believed.
//
// ⚠️ "unknown" MEANS "COULD NOT ASK", NOT "DID NOT RECOGNISE".
// An unrecognised-but-readable contract is `plain-contract` — the honest residual. `unknown` is
// reserved for a shape-determining read that came back UNREADABLE, and it REFUSES, because of the
// portable rule from the vault inspector: an unreadable input BLOCKS when another conclusion is
// conditional on it. EVERY power finding is conditional on shape — scan the wrong code and the whole
// report is a clean bill on the wrong contract. So shape-unreadable blocks; it does not warn.
//
// ⚠️ transparent-vs-UUPS IS A HEURISTIC, AND IT IS ALLOWED TO SAY SO.
// Real deployments are ambiguous (a UUPS proxy whose admin slot happens to be populated; a transparent
// proxy behind a non-standard admin). Forcing one of the two names would be a guess wearing a verdict
// — defect A's exact shape. Refusing outright would throw away a correct, useful determination (it IS
// a 1967 proxy) over an unresolved sub-question. So the variant carries a third state,
// `indeterminate`, and the family stands.

import { UNREADABLE, unread, hasSel, EIP1967_IMPL_SLOT } from "../onchain-facts/index.mjs";
import { EIP1967_ADMIN_SLOT, eip1167Target, DIAMOND_LOUPE_SIGS, UUPS_SIGS } from "./slots.mjs";

const addrFromWord = (w) => (w && w !== "0x" ? "0x" + String(w).slice(-40).toLowerCase() : null);
const isZeroAddr = (a) => !a || /^0x0+$/.test(a);

/**
 * Determine shape. Every read goes through `cov.runCheck`, so a failed shape read lands in the
 * manifest exactly like a failed power check.
 *
 * Returns { class, family, variant, effectiveCodeAddress, effectiveCode, evidence }.
 * `effectiveCode` is the bytecode the powers should be scanned in — or UNREADABLE, or null when the
 * shape makes a direct scan invalid (diamond).
 */
export async function detectShape(cov, client, addr, blk) {
  const ev = {};

  // ── 1. The address's own code. Everything else branches off this. ──────────────────────────
  const own = await cov.runCheck("shape:code@address", { kind: "shape", step: "own-code" }, () =>
    client.call({ method: "eth_getCode", params: [addr, blk.tag] })
  );
  if (!own.ok) {
    // Could not ask. NOT "no code", which would read as an EOA and silence every power check.
    cov.skip("shape:proxy-slots", { kind: "shape", step: "proxy-slots" }, "own bytecode unreadable — proxy slots would describe an unknown thing");
    return { class: "unknown", family: "unknown", variant: null, effectiveCodeAddress: null, effectiveCode: UNREADABLE,
             evidence: { why: "eth_getCode at the subject address did not complete", detail: String(own.error?.message ?? own.error) } };
  }

  const ownCode = String(own.value).toLowerCase();
  ev.ownCodeBytes = ownCode === "0x" ? 0 : (ownCode.length - 2) / 2;

  // ── 2. No code: an EOA (or an address never deployed to — indistinguishable by code alone). ──
  if (ownCode === "0x") {
    cov.skip("shape:proxy-slots", { kind: "shape", step: "proxy-slots" }, "no bytecode at this address — proxy slots are not applicable");
    return { class: "eoa", family: "eoa", variant: null, effectiveCodeAddress: null, effectiveCode: null,
             evidence: { ...ev, note: "no bytecode. An EOA and a never-deployed address are indistinguishable by code alone." } };
  }

  // ── 3. EIP-1167 clone — decided by an exact bytecode pattern, so it costs no extra RPC. ─────
  const cloneTarget = eip1167Target(ownCode);
  if (cloneTarget) {
    cov.skip("shape:proxy-slots", { kind: "shape", step: "proxy-slots" }, "canonical EIP-1167 clone identified by bytecode pattern — it has no storage, so 1967 slots cannot apply");
    const tc = await cov.runCheck("shape:code@clone-target", { kind: "shape", step: "clone-target-code" }, () =>
      client.call({ method: "eth_getCode", params: [cloneTarget, blk.tag] })
    );
    return {
      class: "eip1167-clone", family: "eip1167", variant: null,
      effectiveCodeAddress: tc.ok ? cloneTarget : null,
      effectiveCode: tc.ok ? String(tc.value).toLowerCase() : UNREADABLE,
      effectiveCodeReadId: tc.readId ?? null,
      evidence: { ...ev, cloneTarget, note: "a minimal proxy holds no business selectors of its own — powers are scanned in the delegation target" },
    };
  }

  // ── 4. EIP-1967 slots. ──────────────────────────────────────────────────────────────────────
  const implS = await cov.runCheck("shape:eip1967-impl-slot", { kind: "shape", step: "impl-slot" }, () =>
    client.call({ method: "eth_getStorageAt", params: [addr, EIP1967_IMPL_SLOT, blk.tag] })
  );
  if (!implS.ok) {
    // 🚨 THE BLOCK. An unread impl slot is precisely defect B: "not upgradeable" asserted on no
    // evidence. Every selector finding below would be a scan of possibly-the-wrong-contract.
    return { class: "unknown", family: "unknown", variant: null, effectiveCodeAddress: null, effectiveCode: UNREADABLE,
             evidence: { ...ev, why: "the EIP-1967 implementation slot could not be read, so whether this address delegates elsewhere is unknown",
                         detail: String(implS.error?.message ?? implS.error) } };
  }
  const impl = addrFromWord(implS.value);
  ev.implSlot = implS.value;

  if (!isZeroAddr(impl)) {
    const adminS = await cov.runCheck("shape:eip1967-admin-slot", { kind: "shape", step: "admin-slot" }, () =>
      client.call({ method: "eth_getStorageAt", params: [addr, EIP1967_ADMIN_SLOT, blk.tag] })
    );
    const admin = adminS.ok ? addrFromWord(adminS.value) : UNREADABLE;

    const ic = await cov.runCheck("shape:code@implementation", { kind: "shape", step: "implementation-code" }, () =>
      client.call({ method: "eth_getCode", params: [impl, blk.tag] })
    );
    const implCode = ic.ok ? String(ic.value).toLowerCase() : UNREADABLE;

    // Variant. Transparent keeps an admin in the admin slot; UUPS keeps the upgrade entry point in
    // the IMPLEMENTATION and leaves the admin slot empty. Anything else stays `indeterminate`.
    let variant;
    if (unread(admin) || unread(implCode)) variant = "indeterminate";
    else if (!isZeroAddr(admin)) variant = "transparent";
    else if (UUPS_SIGS.some((s) => hasSel(implCode, s))) variant = "uups";
    else variant = "indeterminate";

    return {
      class: variant === "indeterminate" ? "eip1967-proxy" : `eip1967-${variant}`,
      family: "eip1967", variant,
      effectiveCodeAddress: unread(implCode) ? null : impl,
      effectiveCode: implCode,
      effectiveCodeReadId: ic.readId ?? null,
      evidence: {
        ...ev, implementation: impl,
        adminSlot: unread(admin) ? "unreadable" : adminS.value,
        admin: unread(admin) ? null : isZeroAddr(admin) ? null : admin,
        variantBasis: variant === "transparent" ? "admin slot is set" :
                      variant === "uups" ? "admin slot empty and the implementation exposes upgradeTo/upgradeToAndCall" :
                      "admin slot empty or unreadable and no UUPS entry point observed — the family is certain, the variant is not",
      },
    };
  }

  // ── 5. EIP-2535 diamond — the mandatory loupe is the fingerprint. ───────────────────────────
  if (DIAMOND_LOUPE_SIGS.every((s) => hasSel(ownCode, s))) {
    return { class: "eip2535-diamond", family: "eip2535", variant: null,
             effectiveCodeAddress: null, effectiveCode: null,
             evidence: { ...ev, note: "diamond loupe present. Powers live in FACET contracts reached via the selector table, not in this bytecode." } };
  }

  // ── 6. The honest residual. Code is here, it is not a shape we resolve, so scan it directly. ─
  //
  // 🚨 "plain-contract" IS A RESIDUAL, NOT A CLEAN BILL, and it must say so on its face.
  // Found by running the skeleton against Arc's native USDC (0x3600…): it came back plain-contract
  // WITH `upgradeable` present — an upgrade entry point and an EMPTY 1967 slot, i.e. either a UUPS
  // implementation reached directly or a proxy using a slot we do not read. The generated manifest
  // said "NOT checked (0)", which is true of the plan and misleading about reality: a shape nobody
  // looks for produces no notChecked entry, so the absence of a warning came from the absence of a
  // check. That is [[absence-must-never-read-as-safe]] reappearing one level up — in the PLAN rather
  // than in a read. The manifest is correct-by-construction only for what the plan contains, so the
  // plan's own boundary has to be part of the output.
  return {
    class: "plain-contract", family: "plain", variant: null,
    effectiveCodeAddress: addr, effectiveCode: ownCode, effectiveCodeReadId: own.readId,
    evidence: {
      ...ev,
      shapesTestedFor: ["eoa", "eip1167-clone", "eip1967-proxy (impl slot)", "eip2535-diamond (loupe)"],
      residual: "NONE of the shapes tested for matched. This is the residual class, not a positive identification of an ordinary contract.",
      shapesNotTestedFor: [
        "beacon proxies (EIP-1967 beacon slot)",
        "proxies storing the implementation in a non-standard slot",
        "EIP-1167 clone variants that are not the canonical 45-byte pattern",
        "metamorphic (CREATE2-redeploy) contracts",
      ],
      ...(hasSel(ownCode, UUPS_SIGS[0]) || hasSel(ownCode, UUPS_SIGS[1])
        ? { anomaly: "this bytecode exposes a UUPS upgrade entry point while its EIP-1967 implementation slot is empty — it may be an implementation reached directly, or a proxy using a slot this scan does not read" }
        : {}),
    },
  };
}
