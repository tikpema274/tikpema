// describeChainError.ts — A CHAIN REFUSAL, WITHOUT THE CALLDATA.
//
// ═══ 🚨 THE LEAK ═══════════════════════════════════════════════════════════════════════════════
// A passkey "Fund agent" reverted on 2026-09-14 and the panel rendered viem's ENTIRE error — the
// reason, then "Contract Call: address / function / args: (0x…, 1000000000000000000) / sender",
// then a docs link and the viem version. describeError passes a non-empty message through
// byte-identical BY DESIGN (it exists for the no-message case); that is right for a message we
// cannot classify and wrong for one we can. Same class as the pay-plane mint leak (687dc89), where
// the raw SDK error carried ~600 chars of attestation calldata to the user — that one was
// classified on the server; nothing classified a viem error thrown in the browser.
//
// ═══ ⭐ THE RULE ═══════════════════════════════════════════════════════════════════════════════
// The user needs the REASON ("transfer amount exceeds balance") and the fact that the chain, not
// the server, refused. They do not need the calldata — and on the money path a hex blob beside a
// figure is worse than noise: the 1e18 in that args line was the defect, and no reader can see
// 10^12 in it. viem keeps the two apart for us: `shortMessage` is the one-line reason, `message`
// is the reason plus the request dump. Walk the cause chain for a revert reason first, then take
// shortMessage, and only then fall back to describeError's honest pass-through.
//
// ⚠️ Deliberately narrow: this is for a value thrown by viem (or anything shaped like it). A fetch
// error, a thrown string, an Error with no message all go to describeError unchanged.

import { describeError } from "./describeError";

/** viem's BaseError surface, as much of it as we read. Structural on purpose — no viem import. */
type ViemLike = {
  shortMessage?: unknown;
  reason?: unknown;
  walk?: (fn: (err: unknown) => boolean) => unknown;
  message?: unknown;
};

/** The headers viem appends below the reason. Anything after the first one is request detail. */
const DETAIL_BLOCK = /\n\s*(Contract Call|Request Arguments|Raw Call Arguments|Estimate Gas Arguments|Request body|Details|Docs|Version):/;

export function describeChainError(e: unknown): string {
  const v = e as ViemLike | null | undefined;
  if (!v || typeof v !== "object") return describeError(e);

  // 1. A revert REASON anywhere in the cause chain is the most specific fact available.
  const reverted =
    typeof v.walk === "function"
      ? (v.walk((err) => typeof (err as ViemLike)?.reason === "string" && !!(err as ViemLike).reason) as ViemLike | null)
      : null;
  const reason = (reverted?.reason ?? v.reason) as unknown;
  if (typeof reason === "string" && reason.trim()) {
    return `The chain refused this transaction: ${reason.trim()}. Nothing was sent.`;
  }

  // 2. viem's one-line summary, which never carries the request dump.
  if (typeof v.shortMessage === "string" && v.shortMessage.trim()) return v.shortMessage.trim();

  // 3. A message that LOOKS like viem's (reason + detail blocks) but came without shortMessage:
  //    keep the part above the first detail block.
  if (typeof v.message === "string") {
    const cut = v.message.split(DETAIL_BLOCK)[0]?.trim();
    if (cut) return cut;
  }

  return describeError(e);
}
