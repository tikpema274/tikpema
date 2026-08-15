// _mock-chain.mjs — the fake chain the DD suites analyse against. ONE definition, several consumers.
//
// ═══ ⭐ WHY THIS IS EXTRACTED ════════════════════════════════════════════════════════════════
// This harness defines what "a report" looks like in every offline test. A second copy would be a
// duplicate source of truth over the thing the tests measure WITH — so two suites could drift into
// exercising different engines while both stayed green, and the drift would be invisible precisely
// because each file looks self-consistent.
//
// ⚠️ THE INTERFACE IS NOT OBVIOUS AND MUST NOT BE GUESSED. `analyze()` calls ONE method —
// `call({ method, params })` — and expects `{ result, query, evidence }` back, plus `assert()` and
// `pin()`. A plausible-looking client with `getCode`/`getStorageAt` methods produces a
// `chain-unreachable` REFUSAL rather than an error, so a wrong harness silently tests refusals
// instead of reports. (Learned the hard way while writing verify-policy.)

import { sel } from "../../shared/onchain-facts/index.mjs";

export const SUBJ = "0x1111111111111111111111111111111111111111";
export const IMPL = "0x2222222222222222222222222222222222222222";
export const OWNER = "0x3333333333333333333333333333333333333333";
export const ZERO_WORD = "0x" + "0".repeat(64);
export const word = (a) => "0x" + a.replace(/^0x/, "").padStart(64, "0");
/** Bytecode containing the selectors for these signatures — how a power is "present". */
export const codeWith = (sigs) => "0x60806040" + sigs.map((s) => sel(s)).join("") + "00";

/**
 * A chain that answers from a handler table. A handler may be a VALUE (returned as a successful
 * read) or a FUNCTION (called, so it can throw — that is how a degraded endpoint is simulated).
 */
export function mockClient(handlers = {}) {
  return {
    chain: { name: "mock-chain" },
    assert: async () => 5042002,
    pin: async () => ({ number: 1000, tag: "0x3e8" }),
    async call({ method, params }) {
      const key =
        method === "eth_getCode" ? `code@${String(params[0]).toLowerCase()}`
        : method === "eth_getStorageAt" ? `slot@${String(params[1]).toLowerCase()}`
        : method === "eth_call" ? `call@${String(params[0]?.data)}`
        : method;
      const h = handlers[key];
      if (h === undefined) throw Object.assign(new Error(`mock: unhandled ${key}`), { transient: false });
      if (typeof h === "function") return h();
      return { result: h, query: { endpoint: "mock://", method, params, reproduce: `# mock ${key}` }, evidence: { httpStatus: 200 } };
    },
  };
}

/** "We could not ask" — retries exhausted. Becomes rpc-unreadable in the manifest. */
export const transientThrow = () => {
  throw Object.assign(new Error("request limit reached"),
    { transient: true, query: { endpoint: "mock://", method: "m", params: [], reproduce: "# mock" } });
};
/** "The chain answered, and the answer was an error" — a real observation, not an outage. */
export const revertThrow = () => {
  throw Object.assign(new Error("execution reverted"),
    { transient: false, query: { endpoint: "mock://", method: "m", params: [], reproduce: "# mock" } });
};

/** One endpoint of a quorum set: the same mock, tagged with its own rpc url and chain id. */
export const mkc = (rpc, handlers, chainId = 5042002) =>
  ({ ...mockClient(handlers), chain: { name: "mock", rpc }, assert: async () => chainId });
