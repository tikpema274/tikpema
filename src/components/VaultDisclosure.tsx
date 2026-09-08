import { bps, type DisclosureDelta } from "../lib/disclosureDiff";

// ═══ ⭐⭐ ONE CONSENT SURFACE, MOUNTED WHEREVER A DEPOSIT IS DECIDED ══════════════════════════
//
// This is the text a user reads before committing funds to a third-party, unaudited contract, and
// the tick that turns reading into consent. It was written once, inside VaultPanel, and stayed
// there while the only way to deposit was that page.
//
// 🚨 THE AGENT CHANGED THAT, AND THE OBVIOUS MOVE WAS THE WRONG ONE. Giving the agent panel its
// own warnings-and-tick would have made TWO producers of the same consent copy — the exact defect
// this repo keeps finding, on the highest-stakes text in the app. ⛔ And the half that would have
// been forgotten is knowable in advance: not the warning list, which is obvious and would get
// copied, but the DISCLOSURE-CHANGED RECOVERY below. It is the branch nobody hits while building,
// and the one that decides whether a stale acknowledgement can be spent.
// [[duplicate-source-of-truth-is-the-recurring-bug]] · [[one-claim-two-producers]]
//
// ⭐ SO IT IS A COMPONENT, NOT A COPY. VaultPanel, the agent's single-action confirm, and each
// vault step inside a multi-step plan all mount THIS. Widening the disclosure widens it in three
// places at once, which is the only way three surfaces can be made to agree about one contract.
//
// ═══ ⛔ WHAT THIS DELIBERATELY DOES NOT DO ═══════════════════════════════════════════════════
// It renders and it reports a tick. It does NOT decide whether a deposit may proceed: `ackRequired`
// and the BLOCK verdict come from the SERVER's gate, and the server re-inspects and re-checks the
// token at execution time regardless of anything here. A consent UI that also adjudicated consent
// would be a client deciding its own gate. [[absence-must-never-read-as-safe]]
//
// It also excludes the DD report card: that is a second, independent reading, it is display-only,
// and it says so in its own words. Folding it in here would put a non-gating verdict inside the
// gating surface.

const shortAddr = (a?: string | null) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "—");

export type VaultDelta = { d: DisclosureDelta; level: string | null } | null;

export default function VaultDisclosure({
  inspection,
  delta = null,
  ackRequired,
  acked,
  onAckChange,
  ackId,
}: {
  inspection: any;
  delta?: VaultDelta;
  ackRequired: boolean;
  acked: boolean;
  onAckChange: (v: boolean) => void;
  /** Distinguishes several mounts on one page — a plan can hold more than one vault step. */
  ackId?: string;
}) {
  const level: string | null = inspection?.verdict?.level ?? null;
  const warns: Array<{ code: string; detail: string }> = inspection?.verdict?.warns ?? [];
  const blocks: Array<{ code: string; detail: string }> = inspection?.verdict?.blocks ?? [];

  return (
    <>
      {/* ⭐⭐ WHAT CHANGED SINCE YOU ACCEPTED — computed, not announced. Rendered ABOVE the
          disclosure band so it is read before the tick is offered again. A bare "this changed,
          look again" would leave the user to diff two things they cannot see, and a re-tick nobody
          can check is a formality. */}
      {delta && delta.d.changed && (
        <div className="status" style={{ marginBottom: 14, padding: "12px 14px", border: "1px solid var(--warn)", borderRadius: 8 }}>
          <b>Your acknowledgement no longer applies — this vault&apos;s disclosure changed.</b>
          <div style={{ marginTop: 8 }}>
            {delta.d.levelChange && (
              <div>Overall verdict moved from <b>{delta.d.levelChange.from ?? "unknown"}</b> to <b>{delta.d.levelChange.to ?? "unknown"}</b>.</div>
            )}
            {delta.d.warnsAdded.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <b>New since you accepted:</b>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                  {delta.d.warnsAdded.map((w) => (<li key={w.code}><span className="mono">{w.code}</span>{w.detail ? ` — ${w.detail}` : ""}</li>))}
                </ul>
              </div>
            )}
            {delta.d.warnsRemoved.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <b>No longer reported:</b>{" "}
                {delta.d.warnsRemoved.map((w) => (<span key={w.code} className="mono" style={{ marginRight: 8 }}>{w.code}</span>))}
              </div>
            )}
            {/* ⭐⭐ THE OWNERSHIP TRANSFER — the change v1 could not even detect. It is rendered
                FIRST-CLASS rather than folded into the warn list, because "a warn appeared" and
                "the people who hold every power above are now different people" are not the same
                sentence, and only one of them is why the acknowledgement died. */}
            {delta.d.holderChange && (
              <div style={{ marginTop: 6 }}>
                <b>The owner changed.</b>{" "}
                <span className="mono">{shortAddr(delta.d.holderChange.fromAddress) || "none"}</span>
                {delta.d.holderChange.fromKind ? ` (${delta.d.holderChange.fromKind})` : ""}
                {" → "}
                <span className="mono">{shortAddr(delta.d.holderChange.toAddress) || "none"}</span>
                {delta.d.holderChange.toKind ? ` (${delta.d.holderChange.toKind})` : ""}
                <div style={{ fontSize: ".85rem" }}>
                  Every owner power disclosed above is now held by a different party than the one you
                  acknowledged.
                </div>
              </div>
            )}
            {delta.d.feeChanges.map((f) => (
              <div key={f.label} style={{ marginTop: 6 }}>
                The <b>{f.label}</b> moved from <b>{bps(f.fromBps)}</b> to <b>{bps(f.toBps)}</b>.
              </div>
            ))}
            {/* ⚠️ NEVER SILENT. The digest moved and none of the inputs we render explains it — say
                exactly that rather than showing an empty panel that reads as "nothing important". */}
            {delta.d.unexplained && (
              <div style={{ marginTop: 6 }}>
                ⚠️ The disclosure changed in a way this page cannot itemise. Re-inspect before depositing,
                and treat the vault as unreviewed until you have.
              </div>
            )}
          </div>
          <div style={{ marginTop: 10 }}>
            Read the disclosure below again before accepting it. Your previous acknowledgement has been cleared.
          </div>
        </div>
      )}

      {/* ── The disclosure band ──────────────────────────────────────────── */}
      {inspection && (
        <div
          style={{
            marginTop: 16,
            border: `1px solid ${level === "BLOCK" ? "var(--warn)" : "rgba(245,180,80,0.5)"}`,
            borderRadius: 10,
            padding: "14px 16px",
            background: "rgba(245,180,80,0.06)",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            {level === "BLOCK" ? "⛔ This vault cannot be deposited into" : level === "WARN" ? "⚠ Read before you deposit" : "✓ Vault terms"}
          </div>

          <ul className="mono" style={{ margin: "0 0 10px", paddingLeft: 18, lineHeight: 1.7, fontSize: 13 }}>
            <li>ERC-4626: {inspection.conformance?.erc4626 ? "conformant ✓" : "NOT conformant ✗"}</li>
            <li>Underlying: {inspection.asset?.isUsdc ? "USDC ✓" : `${shortAddr(inspection.asset?.address)} (not the expected USDC)`}</li>
            <li>
              Funded: {inspection.funded?.isShell ? "EMPTY SHELL ✗" : `~${Number(inspection.funded?.totalAssetsUsdc ?? 0).toLocaleString()} USDC held`}
            </li>
            {/* ⭐⭐ REDEMPTION — FOUR STATES, AND THE PARTIAL CASE CARRIES ITS AMOUNT.
                ⛔ "Redeemable in part" without the figure is the same threshold discard this
                replaced: a vault permitting 1% and one permitting 100% would read identically.
                ⛔ AND `unknown` NEVER RENDERS AS BLOCKED. Both would read as "you cannot withdraw",
                but one is a fact about the vault and the other is the absence of one.
                ⭐ Wherever the user sees a figure and would later receive less, the difference is
                NAMED rather than absorbed — the held amount is stated beside the redeemable one. */}
            <li>
              Redeemable now:{" "}
              {inspection.redemption?.state === "full" ? (
                <>in full ✓</>
              ) : inspection.redemption?.state === "partial" ? (
                <span style={{ color: "var(--warn)" }}>
                  ⚠ in part — {inspection.redemption?.redeemableAssets ?? "?"} USDC of{" "}
                  {inspection.redemption?.positionAssets ?? "?"} USDC held. The rest stays yours and
                  stays in the vault; this is the vault's limit, not a change in your balance.
                </span>
              ) : inspection.redemption?.state === "blocked" ? (
                <span style={{ color: "var(--warn)" }}>
                  ⚠ BLOCKED — this vault currently allows no withdrawals. Your position is still
                  yours and still recorded.
                </span>
              ) : (
                <span style={{ color: "var(--warn)" }}>
                  ⚠ could not read — whether you can withdraw right now is UNKNOWN, not blocked.
                </span>
              )}
            </li>
            <li>
              {/* "no lock/delay" was hardcoded HERE, independently of the inspector — the claim the
                  user actually read came from this line, not from inspection.withdraw. The inspector
                  does not check locks/delays/cooldowns at all, so this now says so.
                  See VAULT_INSPECT_DEFECTS.md (defect C). */}
              Withdraw: {inspection.withdraw?.withdrawFeePct ?? "?"} exit fee ·
              retains ~{inspection.withdraw?.roundTripRetainedPct ?? "?"} on a round trip ·
              lock/delay <strong>not checked</strong>
            </li>
            <li>Owner: {inspection.ownerPowers?.ownerIdentityLabel ?? "unknown"} <span style={{ opacity: 0.7 }}>({shortAddr(inspection.ownerPowers?.owner)})</span></li>
          </ul>

          {blocks.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              {blocks.map((b) => (
                <div key={b.code} className="status" style={{ margin: "2px 0", color: "var(--warn)" }}>⛔ {b.detail}</div>
              ))}
            </div>
          )}

          {warns.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>What the vault owner can do to your deposit:</div>
              {warns.map((wn) => (
                <div key={wn.code} className="status" style={{ margin: "3px 0", lineHeight: 1.5 }}>• {wn.detail}</div>
              ))}
            </div>
          )}

          {/* The ack — required whenever the vault raised a WARN. Ticking it is what lets the
              deposit send the server's ackToken; without it the deposit stays disabled here AND
              is refused server-side (fail-closed). */}
          {ackRequired && (
            <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 12, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={acked}
                onChange={(e) => onAckChange(e.target.checked)}
                style={{ marginTop: 3 }}
                data-ack={ackId ?? "vault"}
              />
              <span style={{ fontSize: 13, lineHeight: 1.5 }}>
                I understand these are the vault owner's powers over my deposit — including that they can
                raise the exit fee and can withdraw the underlying USDC — and I accept them.
              </span>
            </label>
          )}
        </div>
      )}
    </>
  );
}
