// owner-powers — what can this contract's owner DO to you, and who is the owner?
//
// ⚠️ THE SIGNATURE TABLES AND THE SELECTOR-SCAN METHOD ARE COPIED FROM netlify/functions/_vault.mjs
// (the Vault agent's inspector) — deliberately duplicated, not imported. scripts/dd/ must not import
// prod: the auditor cannot depend on the audited, or a prod refactor silently changes what an audit
// means, and a fact from last month stops being reproducible. `_vault.mjs` remains the ORIGINAL and
// the one wired to money; this is a read-only copy for auditing third parties. If you extend the
// tables there, extend them here too — they are allowed to diverge, and that is the cost of the
// independence. (Same call as chains.mjs: duplication with a stated reason beats coupling.)
//
// WHY SELECTOR-IN-BYTECODE, NOT AN EXPLORER ABI (the method _vault.mjs chose, and it is right):
// the Solidity dispatcher embeds every external selector in the deployed code, so scanning bytecode
// finds state-changing functions too. It works on UNVERIFIED contracts, needs no explorer, cannot be
// fooled by a wrong or partial ABI, and is portable to any chain. An ABI is somebody's claim about a
// contract; the bytecode is the contract.
//
// ⚠️ THE PROXY TRAP — the reason this check is not just "scan the address".
// A proxy's own bytecode is a delegatecall stub with NO business selectors in it. Today's recon hit
// exactly this: Circle's GatewayWallet proxy is ~163 bytes and holds none of `pause`/`denylist`/
// `upgradeToAndCall` — they all live in the implementation behind it. Scanning the proxy would report
// "no owner powers found" on a contract whose owner can pause, denylist and upgrade. That is a FALSE
// CLEAN BILL — the worst failure a DD tool can produce, because it is the one nobody double-checks.
// So: read the EIP-1967 implementation slot first, and scan the implementation's code when present.
//
// ⚠️ NO CODE ⇒ POWERS ARE UNOBSERVABLE, NOT ABSENT. An empty address must never yield `powers: []`,
// which reads as "clean". It yields `powers: null` + `powersObservable: false`. Same fail-open shape
// the whole engine is built to refuse.

import { observed, failed, sha256, normalizeAddress } from "../fact.mjs";
import { chainClient } from "../client.mjs";
// Shared fact-production primitives — the SINGLE SOURCE OF TRUTH shared with
// netlify/functions/_vault.mjs. Previously these tables and helpers were "COPIED VERBATIM" here
// (the old comment said so), which is the duplicate-source-of-truth bug: the copies had already
// drifted. `POWER_SIGS` is the UNION and equals this engine's old ALL_SIGS exactly (same nine
// groups, same order), so scanPowers is unchanged.
//
// ⚠️ ADOPTING classifyOwnerType FIXES THIS FILE'S DEFECT A. See the owner block in run(): an
// RPC-exhausted owner() read used to be caught and reported as `no-owner-fn`, indistinguishable
// from a genuine "no owner() function". The shared classifier distinguishes the third state, and
// the owner block now feeds it UNREADABLE on a transport-defeated read.
import {
  UNREADABLE,
  unread,
  sel,
  hasSel,
  POWER_SIGS,
  SAFE_SIGS,
  TIMELOCK_SIGS,
  EIP1967_IMPL_SLOT,
  classifyOwnerType,
} from "../../../shared/onchain-facts/index.mjs";

export const id = "owner-powers";
export const describe = "selector-scan a contract's (or its proxy implementation's) bytecode for owner powers, and classify the owner";
export const usage = "--address 0x… --chain <name> [--block <n>]";

// keccak256("eip1967.proxy.admin") - 1. dd/-specific and kept local: reading the admin slot is part
// of this engine's proxy handling (Step-2 extended shapes will build on it); the impl slot is shared.
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const addrFromWord = (w) => (w && w !== "0x" ? "0x" + w.slice(-40) : null);
const isZeroAddr = (a) => !a || /^0x0+$/.test(a);

// ── COVERAGE — every clean bill states its own limits, on its face ────────────────────────────────
//
// ⚠️ THIS IS NOT DOCUMENTATION, IT IS OUTPUT. A check that reports "powers: []" is issuing a PASS, and
// a pass is the one result nobody double-checks — a false flag gets argued with, a false clean bill
// gets believed and acted on. So the limits ride ON the fact, not in a README the reader never opens.
// If this check cannot see a class of power, the fact must say so in the same breath as the result.
//
// Each entry names a way this check could hand you a clean bill on a contract that is not clean.
const COVERAGE = {
  checkedVia: [
    "selector-in-bytecode (Solidity dispatcher embeds every external selector)",
    "erc1967-proxy-resolution (implementation slot read, implementation scanned)",
    "owner-fn (owner() + classification of the owner's own bytecode)",
  ],
  notCheckedFor: [
    {
      id: "eip2535-diamond-facets",
      why: "A diamond's powers live in FACET contracts reached via its selector table, not in the diamond's own bytecode. This scan would find none of them and report a clean bill on a fully-powered contract.",
    },
    {
      id: "accesscontrol-roles",
      why: "owner() is a convention. A contract using OpenZeppelin AccessControl (DEFAULT_ADMIN_ROLE, grantRole) has no owner() — this check reports 'no-owner-fn' and the contract LOOKS ownerless while a role-holder retains every power.",
    },
    {
      id: "non-1967-proxies",
      why: "Beacon proxies, transparent proxies with custom slots, UUPS variants storing the impl elsewhere, and metamorphic (CREATE2-redeploy) contracts are not resolved. The stub gets scanned; the logic behind it does not.",
    },
    {
      id: "unreachable-or-unlisted-selectors",
      why: "A selector present in bytecode may be unreachable, and a power may be exercised via delegatecall/fallback with no selector at all. Presence is evidence of a power; absence is NOT proof of its absence.",
    },
    {
      id: "off-chain-and-economic-control",
      why: "Upgrade keys held by a custodian, an RPC/frontend that can lie, or a token the contract depends on being pausable elsewhere. This check reads one contract's code, not the system around it.",
    },
  ],
};

/** Scan a blob of bytecode for every signature group. Returns which matched, and the selector it matched on. */
function scanPowers(code) {
  const out = {};
  for (const [group, sigs] of Object.entries(POWER_SIGS)) {
    const matched = sigs.filter((s) => hasSel(code, s)).map((s) => ({ signature: s, selector: "0x" + sel(s) }));
    out[group] = { present: matched.length > 0, matched };
  }
  return out;
}

export async function run({ address, chain: chainName, block, client }) {
  const input = { address, chain: chainName ?? client?.chain?.name, block: block ?? null };
  const addr = normalizeAddress(address);
  if (!addr) return failed({ check: id, input, error: `not a 20-byte hex address: ${JSON.stringify(address)}` });

  let c;
  try {
    c = client ?? chainClient(chainName, { block });
  } catch (e) {
    return failed({ check: id, input, error: e });
  }

  try {
    const chainId = await c.assert();
    const blk = await c.pin();
    const queries = [];

    // 1. The address's own code.
    const own = await c.call({ method: "eth_getCode", params: [addr, blk.tag] });
    queries.push({ what: "code@address", ...own.query });
    const ownCode = own.result;

    if (ownCode === "0x") {
      // Nothing deployed. Powers are UNOBSERVABLE — emphatically not "none".
      return observed({
        check: id,
        input: { ...input, address: addr },
        result: {
          hasCode: false,
          powersObservable: false,
          powers: null,
          owner: null,
          isProxy: null,
          note: "no bytecode at this address on this chain — powers cannot be observed (this is NOT 'no powers')",
          coverage: COVERAGE,
          chainId,
          blockNumber: blk.number,
        },
        evidence: { bytecode: "0x" },
        query: { queries, explorer: `${c.chain.explorer}/address/${addr}` },
      });
    }

    // 2. Proxy? Read the EIP-1967 slots. A non-zero impl slot means the logic — and the powers —
    //    live behind this address, so scanning here alone would be a false clean bill.
    const implSlot = await c.call({ method: "eth_getStorageAt", params: [addr, EIP1967_IMPL_SLOT, blk.tag] });
    queries.push({ what: "eip1967.implementation", ...implSlot.query });
    const adminSlot = await c.call({ method: "eth_getStorageAt", params: [addr, EIP1967_ADMIN_SLOT, blk.tag] });
    queries.push({ what: "eip1967.admin", ...adminSlot.query });

    const impl = addrFromWord(implSlot.result);
    const isProxy = !isZeroAddr(impl);
    const admin = addrFromWord(adminSlot.result);

    // 3. Scan the EFFECTIVE code: the implementation's if this is a proxy, else the address's own.
    let scannedAddress = addr;
    let scannedCode = ownCode;
    let implCodeFact = null;
    if (isProxy) {
      const ic = await c.call({ method: "eth_getCode", params: [impl, blk.tag] });
      queries.push({ what: "code@implementation", ...ic.query });
      implCodeFact = { address: impl, bytecodeBytes: ic.result === "0x" ? 0 : (ic.result.length - 2) / 2, codeHash: ic.result === "0x" ? null : sha256(ic.result) };
      if (ic.result !== "0x") {
        scannedAddress = impl;
        scannedCode = ic.result;
      }
      // If the impl slot is set but the impl has NO code, we say so rather than scanning the stub
      // and calling it clean — an upgradeable contract pointing at nothing is itself a finding.
    }

    const powers = scanPowers(scannedCode.toLowerCase());

    // 4. Who is the owner? owner() is a convention, not a guarantee — absence is reported, not assumed.
    //
    // 🚨 DEFECT A FIX. Before, the owner() read and the owner-code read shared ONE try/catch that
    // turned ANY failure — including an RPC-exhausted read that never reached the chain — into
    // `no-owner-fn`, indistinguishable from a genuine "no owner() function". The owner TYPE decision
    // is now the shared, tri-state-correct classifyOwnerType; TRANSPORT stays here. A transport-
    // defeated read is fed in as UNREADABLE → `unreadable` / `unreadable-kind` (INDETERMINATE), never
    // the reassuring "no owner". `err.transient` (tagged by rpcCall) is the discriminator: a genuine
    // JSON-RPC error such as "execution reverted" is a real answer (absent → null); an exhausted
    // transient is not (→ UNREADABLE). dd/'s historical output shape — its type strings (it emits
    // `safe-multisig` where the canonical type is `multisig`), labels, the fingerprint field, the
    // error string — is reattached below so nothing but the defect-A classes moves.
    const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
    let ownerValue;   // address | zero-address (renounced) | null (genuinely absent) | UNREADABLE
    let ownerCode;    // hex string | UNREADABLE | undefined (not read: early classes never touch it)
    let ownerErr = null;
    try {
      const o = await c.call({ method: "eth_call", params: [{ to: addr, data: "0x8da5cb5b" }, blk.tag] });
      queries.push({ what: "owner()", ...o.query });
      // An empty word reads as the zero address (renounced), unchanged from before.
      ownerValue = addrFromWord(o.result) ?? ZERO_ADDR;
    } catch (e) {
      ownerValue = e.transient ? UNREADABLE : null; // the ONLY behavioural change: transient ≠ absent
      ownerErr = String(e.message);
      if (e.query) queries.push({ what: "owner()", ...e.query });
    }
    // Read the owner's OWN bytecode only for a real, non-zero address (as before). Any failure to
    // read it is UNREADABLE → `unreadable-kind`, never a silent downgrade to no-owner-fn.
    if (!unread(ownerValue) && ownerValue && !isZeroAddr(ownerValue)) {
      try {
        const oc = await c.call({ method: "eth_getCode", params: [ownerValue, blk.tag] });
        queries.push({ what: "code@owner", ...oc.query });
        ownerCode = oc.result;
      } catch (e) {
        ownerCode = UNREADABLE;
        if (e.query) queries.push({ what: "code@owner", ...e.query });
      }
    }
    const { address: ownerAddr, type: ownerType } = classifyOwnerType(ownerValue, ownerCode);
    // Map the canonical type back to dd/'s historical output (strings + labels), so only the
    // defect-A classes are new. `multisig` → this engine's long-standing `safe-multisig`.
    const DD_OWNER = {
      renounced: { type: "renounced", label: "ownership renounced (zero address)" },
      eoa: { type: "eoa", label: "a single externally-owned key controls this contract" },
      multisig: { type: "safe-multisig", label: "a Safe multisig" },
      timelock: { type: "timelock", label: "a timelock contract" },
      contract: { type: "contract", label: "a contract (unfingerprinted)" },
      "no-owner-fn": { type: "no-owner-fn", label: "owner() absent or reverted — ownership not exposed by that convention" },
      unreadable: { type: "unreadable", label: "owner() could not be read (RPC exhausted) — ownership INDETERMINATE, not absent" },
      "unreadable-kind": { type: "unreadable-kind", label: "the owner's code could not be read — kind (key / multisig / timelock) INDETERMINATE" },
    };
    const owner = { address: ownerAddr, ...DD_OWNER[ownerType] };
    // The fingerprint rides on the fingerprinted-owner classes exactly as before.
    if (typeof ownerCode === "string" && ownerCode !== "0x" && (ownerType === "multisig" || ownerType === "timelock" || ownerType === "contract")) {
      const code = ownerCode.toLowerCase();
      owner.fingerprint = { safeSigsPresent: SAFE_SIGS.every((s) => hasSel(code, s)), timelockSigsPresent: TIMELOCK_SIGS.some((s) => hasSel(code, s)) };
    }
    if (ownerErr) owner.error = ownerErr;

    return observed({
      check: id,
      input: { ...input, address: addr },
      result: {
        hasCode: true,
        powersObservable: true,
        isProxy,
        implementation: isProxy ? impl : null,
        eip1967Admin: isZeroAddr(admin) ? null : admin,
        scannedAddress, // ⚠️ the address whose code the powers came from — the proxy's impl when proxied
        scannedBytecodeBytes: (scannedCode.length - 2) / 2,
        scannedCodeHash: sha256(scannedCode),
        powersPresent: Object.entries(powers).filter(([, v]) => v.present).map(([k]) => k),
        powers,
        owner,
        // ⚠️ Rides on EVERY result, especially the clean ones. See COVERAGE above.
        coverage: COVERAGE,
        chainId,
        blockNumber: blk.number,
      },
      evidence: {
        ownCodeHash: sha256(ownCode),
        ownBytecodeBytes: (ownCode.length - 2) / 2,
        implCode: implCodeFact,
        slots: { implementation: implSlot.result, admin: adminSlot.result },
        selectorMethod: "4-byte selector present in deployed bytecode (Solidity dispatcher embeds every external selector)",
      },
      query: { queries, explorer: `${c.chain.explorer}/address/${addr}` },
    });
  } catch (e) {
    return failed({ check: id, input, error: e, query: e.query ?? null });
  }
}
