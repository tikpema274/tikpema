// _env-assert.mjs — the SAME-ENVIRONMENT startup assert. PURE: no imports, no import-time side effect.
// ⚠️ ON THE DD SURFACE since 2026-09-16 (DD_SURFACE_FILES): `_arc.mjs` imports it, and dd-analyze reaches
// _arc, so this module runs inside what ddTree must hash — edits here rotate ddTree and buy a refusal
// window. (Its logic is still unit-testable in isolation.) `_arc.mjs` invokes assertSameEnvironment()
// this file only defines the table and the check, so it is unit-testable in isolation.
//
// ⛔ WHY THIS EXISTS (2026-09-16). Four independent values decide which environment the money path is
// in: the CHAIN ID, the RPC host, the Gateway API host, and the Gateway WALLET. Three already differ
// between testnet and mainnet; the Gateway DOMAIN (26) does NOT, so it cannot discriminate. Until
// 2026-09-16 the Gateway wallet was "just the deposit contract" — the same address across the chains
// within an environment, and so not an environment tell. Then Circle's MAINNET Gateway list published a
// DIFFERENT wallet (0x77777777Dcc4…) from testnet (0x0077777d…). So the wallet is now a load-bearing
// environment TELL, and a partial migration — Gateway moved to mainnet while the chain stayed testnet
// (or the reverse), or a wallet typo'd into the other environment's address — became possible with
// nothing in the codebase to notice it. This refuses unless all four resolve to ONE known environment.
//
// 🚨 NEVER derive one column from the other by editing a string. The two Gateway wallets differ by only
// a few characters and typo into each other — that similarity is the entire reason the wallet became a
// discriminator. Every value below is a LITERAL entered from its own published source.

export class EnvironmentAssertionError extends Error {
  constructor(message) { super(message); this.name = "EnvironmentAssertionError"; }
}

// KNOWN values ONLY. A value absent here is UNKNOWN → refuse; it is NEVER assumed to be testnet.
// A mainnet entry is present ONLY where the value has been PUBLISHED, and each names its source:
//   · gatewayWallet.mainnet — Circle's mainnet Gateway list (0x7777…00eE), 2026-09-16
//   · gatewayHost.mainnet   — Circle's published mainnet Gateway API base
//   · chainId.mainnet 5042 and rpcHost.mainnet rpc.mainnet.arc.io — ADDED 2026-09-20 from
//     docs.arc.io/arc/references/rpc-endpoints ("Chain ID (Mainnet) 5042", "Primary (Circle)
//     https://rpc.mainnet.arc.io") and /arc/references/connect-to-arc; eth_chainId on that host answered
//     0x13b2 (= 5042) read-only the same day. Until then these two were deliberately ABSENT — the
//     fail-closed direction while Circle had published nothing. Do NOT invent a value by mutating the
//     testnet one; a new row is read from a page and cites it. [[absence-must-never-read-as-safe]]
//
// ⭐ BEHAVIOURAL CONSEQUENCE — READ THIS AS THE GUARD WORKING, NOT A BUG (for a future migrator):
//   · With all four mainnet rows present, a FULL migration (ARC.chainId, ARC.rpc, GATEWAY.API_BASE,
//     GATEWAY.WALLET all mainnet) classifies as "mainnet" and BOOTS. Any HALF migration — one, two or
//     three levers moved — classifies as a SPLIT and REFUSES, naming both sides. That split is the
//     half-migration case this guard exists for — the one nothing noticed before 2026-09-16.
//   · A value in NEITHER column (a typo, an unpublished chain) is UNKNOWN and REFUSES. The rows are
//     exact values, not a mainnet catch-all.
//   · Filling these rows is NOT the migration: the migration is the three package sources + these rows
//     + shared/x402/published.mjs moving together (mainnet go/no-go §1). Today the sources are testnet.
//
// ⚠️ RESIDUAL GAP — WHAT A PASSING ASSERT DOES NOT PROVE. Unanimity is AGREEMENT, not correctness: the
//   assert proves the four values name ONE environment, NOT that the literals in this table are right.
//   A consistently-WRONG value — e.g. a testnet slot mistyped to another testnet-shaped address — passes,
//   because all four still agree on "testnet". The mutation proof (verify-env-assert) covers the
//   CLASSIFIER (fall-through, split, unknown), NOT these literals. The literals are trusted from their
//   published source; nothing here re-checks them against the chain. Keep them exact.
//
// 🚨 TWO STANDING GAPS THIS ASSERT DOES NOT CLOSE (true today, see PROGRESS "env-assert duplication gap"):
//   (1) DUPLICATES. This reads ONE copy per lever — ARC.rpc and GATEWAY.WALLET. The RPC literal lives in
//       6 files and the testnet Gateway wallet in 4 (_dd-x402/_x402-confirm/x402-quote + _gateway). A
//       change here that misses a duplicate PASSES this assert while x402/DD verify against the wrong
//       network's Gateway wallet. Fix = one source per lever + a grep-guard (HELD until the mainnet
//       decision; it touches 5 DD-surface files and rides Deploy 1's refusal window when it ships).
//   (2) DOMAIN-KEYED CHECKS. Arc's Gateway/CCTP domain is 26 and Base's is 6 on BOTH networks — the
//       domain never discriminates testnet from mainnet; only the paired ADDRESS or IRIS host does. This
//       assert covers the Arc-domain-26 case via the WALLET slot; Base domain 6, ARC_CCTP_DOMAIN 26, and
//       the BRIDGE_DESTINATIONS cctpDomains are UNGUARDED (3 of 4). That is why the wallet, not the
//       domain, is the discriminator here.
export const ENV_TABLE = Object.freeze({
  chainId: Object.freeze({
    testnet: 5042002,
    mainnet: 5042,                    // docs.arc.io/arc/references/rpc-endpoints "Chain ID (Mainnet)", read 2026-09-20; eth_chainId → 0x13b2
  }),
  rpcHost: Object.freeze({
    testnet: "rpc.testnet.arc.io",
    mainnet: "rpc.mainnet.arc.io",    // docs.arc.io/arc/references/rpc-endpoints "Primary (Circle)", read 2026-09-20
  }),
  gatewayHost: Object.freeze({
    testnet: "gateway-api-testnet.circle.com",
    mainnet: "gateway-api.circle.com",
  }),
  gatewayWallet: Object.freeze({
    testnet: "0x0077777d7eba4688bdef3e311b846f25870a19b9",
    mainnet: "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee",
  }),
});

const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return String(u ?? "").trim().toLowerCase(); } };
function norm(field, v) {
  if (v == null) return v;
  if (field === "chainId") return Number(v);
  if (field === "rpcHost" || field === "gatewayHost") return hostOf(v);
  if (field === "gatewayWallet") return String(v).trim().toLowerCase();
  return v;
}

/**
 * Return "testnet" | "mainnet" for a field's value, or null if it matches NEITHER column.
 * There is NO default and NO fallback — an unrecognised value is null, which the caller refuses on.
 */
export function classify(field, value) {
  const table = ENV_TABLE[field];
  if (!table) throw new EnvironmentAssertionError(`assert misconfigured: unknown field "${field}"`);
  const target = norm(field, value);
  for (const [env, known] of Object.entries(table)) {
    if (norm(field, known) === target) return env;
  }
  return null; // UNKNOWN — never "probably testnet"
}

/**
 * Refuse unless chainId, rpc, gatewayApiBase and gatewayWallet ALL resolve to the SAME known
 * environment. Throws EnvironmentAssertionError on:
 *   (a) any value in neither column → refuse rather than assume, OR
 *   (b) a split across environments → the message NAMES every field, its value, and the label it
 *       produced, on BOTH sides of the split.
 * Returns the single agreed environment ("testnet"|"mainnet") when all four match.
 */
export function assertSameEnvironment({ chainId, rpc, gatewayApiBase, gatewayWallet } = {}) {
  const seen = [
    ["chainId", chainId],
    ["rpcHost", rpc],
    ["gatewayHost", gatewayApiBase],
    ["gatewayWallet", gatewayWallet],
  ].map(([field, value]) => ({ field, value, label: classify(field, value) }));

  // (a) UNKNOWN first — a value we cannot place is refused, NEVER assumed testnet.
  const unknown = seen.filter((s) => s.label === null);
  if (unknown.length) {
    const list = unknown.map((s) => `${s.field}=${String(s.value)}`).join(", ");
    throw new EnvironmentAssertionError(
      `same-environment assert REFUSED — value(s) in NEITHER the testnet nor the mainnet column: ${list}. ` +
      `An unrecognised value is refused, never assumed testnet; add it to ENV_TABLE only when its environment is published/certain.`
    );
  }

  // (b) SPLIT — more than one known environment across the four values.
  const byLabel = { testnet: [], mainnet: [] };
  for (const s of seen) byLabel[s.label].push(`${s.field}=${String(s.value)}`);
  const present = Object.keys(byLabel).filter((l) => byLabel[l].length);
  if (present.length > 1) {
    const parts = present.map((l) => `${l}: {${byLabel[l].join(", ")}}`).join("  vs  ");
    throw new EnvironmentAssertionError(
      `same-environment assert REFUSED — the money-path config spans TWO environments. ${parts}. ` +
      `All four of {chain id, RPC, Gateway host, Gateway wallet} must belong to ONE environment; refusing to boot.`
    );
  }

  return present[0]; // the one environment all four agree on
}

/**
 * ═══ ⭐ CROSS-PACKAGE AGREEMENT — app-server vs dd-core (mainnet go/no-go §1, phase B) ═══════════
 * assertSameEnvironment binds ONE package's four levers to one environment. It never bound the PACKAGES
 * to each other: shared/dd/chains.mjs (dd-core) carries its OWN chain table by design — the DD engine must
 * reach chains prod has never heard of, and must not import the app it audits — so a flip that moved
 * _arc.mjs and forgot chains.mjs would boot, and the PAID DD path would analyse the wrong chain while the
 * challenge named the right one. This takes both packages' values and REFUSES on any disagreement.
 *
 * PURE, like everything in this file: no import of either package — the CALLER (_arc.mjs) passes the
 * values, so this module can be imported from the DD surface without an import-time side effect.
 * Only server ↔ dd-core is checkable at boot; the CLIENT (src/config/chain.ts) is bound at test time by
 * verify-chain-literals.mjs C1 and verify-site-claims.mjs — a function cannot import TypeScript source.
 * ⚠️ An ABSENT dd-core value is a disagreement, never a pass.
 */
export function assertPackagesAgree({ server, ddCore } = {}) {
  const diffs = [];
  const sId = norm("chainId", server?.chainId), dId = norm("chainId", ddCore?.id);
  if (!Number.isFinite(sId) || !Number.isFinite(dId) || sId !== dId) diffs.push(`chainId: app-server=${String(server?.chainId)} vs dd-core=${String(ddCore?.id)}`);
  const sHost = norm("rpcHost", server?.rpc), dHost = norm("rpcHost", ddCore?.rpc);
  if (!sHost || !dHost || sHost !== dHost) diffs.push(`rpcHost: app-server=${String(sHost || server?.rpc)} vs dd-core=${String(dHost || ddCore?.rpc)}`);
  if (diffs.length) {
    throw new EnvironmentAssertionError(
      `cross-package assert REFUSED — app-server (_arc.mjs) and dd-core (shared/dd/chains.mjs) disagree: ${diffs.join("; ")}. ` +
      `Both packages must name ONE chain; a flip that moves one and forgets the other is refused at boot, not discovered in a sold report.`
    );
  }
}
