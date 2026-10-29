// powers.mjs — the enumeration loop and the per-shape probe PLAN.
//
// ⚠️ THE LOOP NEVER SEES THE RPC CLIENT. It receives the coverage recorder and the already-fetched
// effective bytecode. That is the correct-by-construction part: there is no way to reach the chain
// from in here without going through `cov.runCheck`, so a check cannot run unregistered.
//
// ⚠️ AN UNSCANNABLE GROUP THROWS. `scanGroup` refuses to answer when the bytecode is UNREADABLE
// instead of returning `present: false`. Nine reassuring absences from one failed read is the exact
// fail-open family this whole line of work exists to close ([[absence-must-never-read-as-safe]]);
// throwing routes all nine into notChecked automatically, and the caller cannot forget to do it.

import { UNREADABLE, unread, sel, hasSel, POWER_SIGS, classifyOwnerType } from "../onchain-facts/index.mjs";
import { unreadableInput } from "./coverage.mjs";
import { POWER_SCOPE, SCOPE_REACH } from "./schema.mjs";
import { EIP1967_ADMIN_SLOT } from "./slots.mjs";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const addrFromWord = (w) => (w && w !== "0x" ? "0x" + String(w).slice(-40).toLowerCase() : null);
const isZeroAddr = (a) => !a || /^0x0+$/.test(a);

/**
 * Which code, if any, may legitimately be selector-scanned for this shape — and if not, WHY NOT.
 * The `why` strings become the notChecked reasons, so they are user-facing text, not comments.
 */
export function planFor(shape) {
  switch (shape.family) {
    case "eoa":
      return { scannable: false, why: "no bytecode at this address — powers are UNOBSERVABLE here, which is emphatically not 'no powers'" };
    case "eip2535":
      return { scannable: false, why: "EIP-2535 diamond: powers live in facet contracts reached through the diamond's selector table. Facet traversal is not implemented in this slice, and scanning the diamond's own bytecode would report a false clean bill." };
    case "unknown":
      return { scannable: false, why: "the contract's shape could not be classified, so there is no code this scan could be sure was the right code to read" };
    default:
      if (unread(shape.effectiveCode)) return { scannable: false, why: "the effective bytecode could not be read — powers are INDETERMINATE, not absent" };
      if (!shape.effectiveCode) return { scannable: false, why: "no effective bytecode resolved for this shape" };
      return { scannable: true, code: shape.effectiveCode, scannedAddress: shape.effectiveCodeAddress,
               codeReadId: shape.effectiveCodeReadId ?? null };
  }
}

/** Scan one signature group. THROWS when it cannot conclude — never returns a reassuring false. */
function scanGroup(code, sigs) {
  if (unread(code)) throw unreadableInput("bytecode UNREADABLE — cannot determine presence or absence");
  if (typeof code !== "string" || !code.startsWith("0x")) throw unreadableInput("no bytecode to scan");
  const matched = sigs.filter((s) => hasSel(code, s)).map((s) => ({ signature: s, selector: "0x" + sel(s) }));
  return { present: matched.length > 0, matched };
}

/**
 * Enumerate every group in the SHARED catalogue. Iterating POWER_SIGS directly (not a local list) is
 * what makes the completeness invariant meaningful: the loop and the validator read the same source.
 */
export async function enumeratePowers(cov, shape, owner) {
  const plan = planFor(shape);
  const out = [];

  for (const [group, sigs] of Object.entries(POWER_SIGS)) {
    const meta = { kind: "power", group };

    if (!plan.scannable) {
      cov.skip(`power:${group}`, meta, plan.why);
      continue;
    }

    // 🚨 THE TRANSPARENT-PROXY ADMIN (2026-10-29). On an EIP-1967 proxy with an admin, the upgrade
    // entry point is in the PROXY, behind the admin — not in the implementation this loop scans. So
    // the implementation's selectors alone reported `upgradeable` absent while the admin could replace
    // every rule in this report. The admin slot decides it, keyed on the FAMILY and the slot read, not
    // on the class name: an unreadable admin makes the class `eip1967-proxy` (indeterminate), and that
    // case is exactly the one that must not read as absent.
    const admin = group === "upgradeable" ? proxyAdminOf(shape) : null;
    // ⚠️ NOT cov.skip: a skip is "deliberately not run". This is an input that could not be read, so
    // it is recorded the way an unreadable bytecode is — `input-unreadable`.
    if (admin?.state === "unreadable") {
      await cov.runCheck(`power:${group}`, meta, () => {
        throw unreadableInput("the EIP-1967 admin slot could not be read — whether an admin can replace the implementation is UNKNOWN, not absent");
      });
      continue;
    }

    const r = await cov.runCheck(`power:${group}`, meta, () => scanGroup(plan.code, sigs));
    if (!r.ok) continue; // already registered in notChecked, with its reason

    if (admin?.state === "set") {
      out.push({
        power: group,
        present: true,
        // the implementation's own upgrade selectors, if any, still listed — they are a second route
        matched: r.value.matched,
        holder: admin.address,
        // ⚠️ the admin's own code is not read in this version: EOA, ProxyAdmin or multisig is NOT established
        holderKind: "unclassified",
        severity: POWER_SCOPE[group],
        severityReach: SCOPE_REACH[POWER_SCOPE[group]],
        evidence: {
          method: "eip1967-admin-slot",
          slot: EIP1967_ADMIN_SLOT,
          readId: admin.readId,
          note: "the EIP-1967 admin slot holds a non-zero address: on a transparent proxy that address can replace the implementation, whatever owner() returns. What kind of account the admin is, and who controls it, was not read",
        },
      });
      continue;
    }

    out.push({
      power: group,
      present: r.value.present,
      matched: r.value.matched,
      holder: owner.address,
      holderKind: owner.type,
      severity: POWER_SCOPE[group],
      severityReach: SCOPE_REACH[POWER_SCOPE[group]],
      evidence: {
        method: "selector-in-bytecode",
        scannedAddress: plan.scannedAddress,
        // ⭐ the read that produced this finding — resolves to an entry in report.reads[], so a
        // reader can re-run the exact eth_getCode the selector was matched in.
        readId: plan.codeReadId,
        note: "presence of a selector is evidence of the power; ABSENCE is not proof of its absence (a power may be reachable via fallback/delegatecall with no selector)",
      },
    });
  }
  return out;
}

/**
 * The EIP-1967 admin, as the shape read it. `n/a` for any shape that is not an EIP-1967 proxy.
 * ⚠️ `unreadable` is its own state and must never collapse into `zero`.
 */
export function proxyAdminOf(shape) {
  if (shape?.family !== "eip1967") return { state: "n/a", address: null, readId: null };
  const ev = shape.evidence ?? {};
  if (ev.adminSlot === "unreadable") return { state: "unreadable", address: null, readId: null };
  if (ev.admin && !isZeroAddr(ev.admin)) return { state: "set", address: ev.admin, readId: ev.adminReadId ?? null };
  return { state: "zero", address: null, readId: null };
}

/**
 * Who else controls the subject, beside owner(). Always present on an answered report:
 *   []    — the checks this version makes found no second controller;
 *   [..]  — each one found, with the read it came from;
 *   null  — NOT ESTABLISHED (the admin slot, or the shape itself, could not be read). null is not [].
 */
export function stillControlledVia(shape) {
  if (shape?.family === "unknown") return null;
  const a = proxyAdminOf(shape);
  if (a.state === "unreadable") return null;
  if (a.state === "set") return [{ via: "eip1967-admin", address: a.address, readId: a.readId }];
  return [];
}

/**
 * Who holds the powers. TRANSPORT here, INTERPRETATION in the shared primitive — the Step-1 split.
 *
 * 🚨 The `.transient` discriminator is the defect-A fix carried forward: a transport-defeated read
 * becomes UNREADABLE (indeterminate), while a genuine JSON-RPC answer such as "execution reverted"
 * becomes `null` (a real observation that owner() is absent). Collapsing those two produced the most
 * reassuring possible answer on no evidence.
 *
 * ⚠️ holderKind uses the CANONICAL type strings from shared/onchain-facts (`multisig`, not dd/'s
 * historical `safe-multisig`). A new consumer starts canonical; dd/'s rename stays dd/'s.
 */
export async function resolveOwner(cov, client, addr, blk, shape) {
  if (shape.family === "eoa" || shape.family === "unknown") {
    cov.skip("owner:owner()", { kind: "owner" }, shape.family === "eoa"
      ? "no bytecode at this address — there is no owner() to call"
      : "shape unclassified — an owner() result could not be attributed to a known contract shape");
    return { address: null, type: shape.family === "eoa" ? "not-applicable" : "unreadable" };
  }

  let ownerValue;
  const o = await cov.runCheck("owner:owner()", { kind: "owner" }, () =>
    client.call({ method: "eth_call", params: [{ to: addr, data: "0x8da5cb5b" }, blk.tag] })
  );
  if (o.ok) {
    ownerValue = addrFromWord(o.value) ?? ZERO_ADDR;
  } else {
    // 🚨 DEFECT A, ONE LEVEL UP — caught by quorum fault injection, not by reasoning.
    // The discriminator is "did we LEARN anything?", not "was it transient". A quorum failure
    // (disagreement / quorum-unmet / all-endpoints-down) carries `.quorumFailed` but NOT
    // `.transient`, so the old test fell through to `null` → `no-owner-fn` — rendering "two
    // endpoints told us different owners" as the definite observation "this contract has no
    // owner() function". An unknown wearing a verdict, exactly the family this work exists to close.
    ownerValue = o.error?.transient || o.error?.quorumFailed ? UNREADABLE : null;
  }

  let ownerCode; // undefined = correctly not read (the early classes never touch it)
  if (!unread(ownerValue) && ownerValue && !isZeroAddr(ownerValue)) {
    const oc = await cov.runCheck("owner:code@owner", { kind: "owner" }, () =>
      client.call({ method: "eth_getCode", params: [ownerValue, blk.tag] })
    );
    ownerCode = oc.ok ? oc.value : UNREADABLE;
  } else {
    cov.skip("owner:code@owner", { kind: "owner" }, unread(ownerValue)
      ? "owner() was unreadable, so there is no owner address whose code could be classified"
      : "owner() is absent or the zero address — there is no owner contract to fingerprint");
  }

  return classifyOwnerType(ownerValue, ownerCode);
}
