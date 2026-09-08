// Types for plan-acks.mjs. ⚠️ Hand-written because the module is plain .mjs so that BOTH a TSX
// component and a bare-node guard can import the one copy — see that file's header.
export type AckMaps = {
  planDisclosures?: Record<string, { band?: string; ackToken?: string | null }>;
  planVaults?: Record<string, { ackRequired?: boolean; ackToken?: string | null }>;
};
export function stepsNeedingAck(maps?: AckMaps): number[];
export function planAckTokensFor(maps: AckMaps, acked?: Record<number, boolean>): Record<number, string>;
