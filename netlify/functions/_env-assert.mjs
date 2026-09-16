// _env-assert.mjs — the SAME-ENVIRONMENT startup assert. PURE: no imports, no import-time side effect,
// NOT on the DD surface. `_arc.mjs` invokes assertSameEnvironment() at load with the four real values;
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
// A mainnet entry is present ONLY where Circle has PUBLISHED the value:
//   · gatewayWallet.mainnet — from Circle's mainnet Gateway list (0x7777…00eE)
//   · gatewayHost.mainnet   — Circle's published mainnet Gateway API base
// chainId and rpcHost have NO mainnet entry on purpose: Circle has not published Arc mainnet's chain id
// or RPC endpoint to us, so a mainnet chain id or RPC host reads UNKNOWN and REFUSES — the fail-closed
// direction. Do NOT invent one by mutating the testnet value. [[absence-must-never-read-as-safe]]
//
// ⭐ BEHAVIOURAL CONSEQUENCE — READ THIS AS THE GUARD WORKING, NOT A BUG (for a future migrator):
//   · Because chainId and rpcHost have NO mainnet entry, this assert ALSO blocks a FULL migration, not
//     only a partial one. Point ARC.chainId / ARC.rpc at mainnet and the boot REFUSES (UNKNOWN) until
//     you ADD those two mainnet entries here FROM A PUBLISHED SOURCE. That refusal is intended: a
//     migration is not done until every one of the four values is a known mainnet value. Adding them is
//     the migration step, not a workaround.
//   · By contrast gatewayHost and gatewayWallet DO have mainnet entries, so flipping ONLY the Gateway
//     classifies as mainnet and produces a SPLIT message (testnet chain vs mainnet Gateway) rather than
//     an UNKNOWN. That split is the half-migration case this guard exists for — the one nothing noticed
//     before 2026-09-16.
export const ENV_TABLE = Object.freeze({
  chainId: Object.freeze({
    testnet: 5042002,
    // mainnet: <UNPUBLISHED — intentionally ABSENT; a mainnet chain id must read UNKNOWN and refuse>
  }),
  rpcHost: Object.freeze({
    testnet: "rpc.testnet.arc.io",
    // mainnet: <UNPUBLISHED — intentionally ABSENT>
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
