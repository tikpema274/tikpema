import { useState, useEffect } from "react";
import type { useWallet } from "../wallet/useWallet";

type UnifiedWallet = ReturnType<typeof useWallet>;

// The one allowlisted testnet vault (mirrors VAULT_ALLOWLIST server-side). The UI never sends a
// free-form address — only this key.
const VAULT_KEY = "xylo-usdc";

import { diffDisclosure, bps, type DisclosureDelta } from "../lib/disclosureDiff";
import DdReportCard from "./DdReportCard";

const shortAddr = (a?: string | null) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "—");

// VaultPanel — the Vault agent's UI. Two halves, in order:
//   1. INSPECT (read-only) → the disclosure band: is it a real ERC-4626, what is the underlying,
//      is it funded, and what powers does the owner hold. Framed as disclosure, not accusation.
//   2. DEPOSIT / WITHDRAW (moves testnet funds) — the deposit is GATED by the inspection: if the
//      vault raised a WARN, the plain-language acknowledgment below MUST be ticked, which is what
//      carries the server's ackToken back on deposit. Allowlisted ≠ warning silenced.
export default function VaultPanel({ wallet: w }: { wallet: UnifiedWallet }) {
  const [insp, setInsp] = useState<any>(null); // full agent-vault-inspect response
  const [inspecting, setInspecting] = useState(false);
  const [acked, setAcked] = useState(false);
  // ⭐ The delta between the disclosure the user ACCEPTED and the one now in force. Set only when a
  // refusal carries a fresh disclosure; rendered instead of a bare error.
  const [delta, setDelta] = useState<{ d: DisclosureDelta; level: string | null } | null>(null);

  const [amount, setAmount] = useState("1");
  const [depositing, setDepositing] = useState(false);
  // The caller's LIVE on-chain share balance in the vault (read-only, from /api/agent-vault-shares).
  // This — NOT a session deposit receipt — drives whether a reclaim is available, so a user who
  // deposited in a PRIOR session can still withdraw. `null` = not loaded; `sharesErr` set = the read
  // FAILED (fail-closed: we never show "nothing to reclaim" on a failed read). The reclaim amount is
  // still never typed or sent — the server reads the balance and redeems exactly it.
  const [shares, setShares] = useState<{ raw: string; formatted: string; symbol: string; hasShares: boolean } | null>(null);
  const [sharesErr, setSharesErr] = useState("");
  // ⭐⭐ HAS THE BALANCE BEEN LOOKED AT AT ALL? A THIRD STATE, and it exists because the fail-safe
  // below was built for the wrong absence. `sharesErr` covers a read that FAILED. Nothing covered a
  // read that NEVER HAPPENED — `refreshShares` returns early, setting no error, when the user is
  // signed out or the agent wallet has not provisioned. With `shares` null and `sharesErr` empty,
  // the render fell through to "Nothing to reclaim — you hold no shares in this vault".
  // 🚨 THAT IS NOT A FLASH. For a signed-out or unprovisioned user it is the TERMINAL state: the
  // page tells them they hold nothing, having never looked. On a money page that is the one lie
  // that matters, and it is the same family as `initiating` vs `failed` and `UNWIRED` vs
  // `NOT_ATTEMPTED` — "we could not look", "we did not look" and "there is nothing" are three
  // different answers and only one of them is safe to render as reassurance.
  const [sharesProbed, setSharesProbed] = useState(false);
  const [loadingShares, setLoadingShares] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);

  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const amountNum = Number(amount);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;

  const inspection = insp?.inspection ?? null;
  // ⭐ THE ADDRESS COMES FROM THE SERVER'S OWN RESOLUTION, never re-typed here. A second literal
  // would be a duplicate source of truth on the one field that decides WHAT was audited — the
  // card would happily report on a different contract than the one the gate inspected.
  const vaultAddress: string | null = insp?.vault?.address ?? null;
  const level: string | null = inspection?.verdict?.level ?? null;
  const warns: Array<{ code: string; detail: string }> = inspection?.verdict?.warns ?? [];
  const blocks: Array<{ code: string; detail: string }> = inspection?.verdict?.blocks ?? [];
  const ackRequired: boolean = !!insp?.ackRequired;
  const depositable: boolean = !!insp?.depositable;

  // Load the live on-chain share balance. Fail-closed: on a read error we set `sharesErr` and clear
  // `shares` so the reclaim UI shows "can't read" (disabled), never a false "nothing to reclaim".
  async function refreshShares() {
    // ⚠️ Early return WITHOUT an error, deliberately — nothing is wrong, we simply cannot look yet.
    // `sharesProbed` stays false so the render says that instead of inventing an empty balance.
    if (!w.isAuthenticated || !w.agentWallet) { setSharesProbed(false); return; }
    setLoadingShares(true);
    setSharesErr("");
    try {
      const d = await w.vaultShareBalance(VAULT_KEY);
      setShares({ raw: d.shareBalanceRaw, formatted: d.shareBalanceFormatted, symbol: d.shareSymbol, hasShares: !!d.hasShares });
    } catch (e: any) {
      setSharesErr(e?.message || "Could not read your balance");
      setShares(null);
    } finally {
      setLoadingShares(false);
      // ⭐ Probed means WE ASKED — true on success AND on failure. `sharesErr` distinguishes those
      // two; this flag only separates them both from "never asked".
      setSharesProbed(true);
    }
  }

  // Read the balance as soon as the wallet is ready — so a returning user sees (and can reclaim)
  // shares from a prior session WITHOUT having to deposit or even inspect first.
  useEffect(() => {
    refreshShares();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.isAuthenticated, w.agentWallet]);

  async function inspect() {
    setMsg(null);
    setAcked(false);
    setDelta(null);
    setInspecting(true);
    try {
      const data = await w.inspectVault(VAULT_KEY);
      setInsp(data);
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || "Inspection failed" });
    } finally {
      setInspecting(false);
    }
  }

  async function deposit() {
    if (!amountValid || !depositable) return;
    if (ackRequired && !acked) return;
    setMsg(null);
    setDepositing(true);
    try {
      // Send the ackToken ONLY when the vault required one. The server re-inspects and re-checks it
      // regardless — this cannot bypass the gate.
      const data = await w.depositToVault(VAULT_KEY, amountNum, ackRequired ? insp?.ackToken : undefined);
      const got = data?.sharesReceivedRaw;
      setMsg({ ok: true, text: `Deposited ${amountNum} USDC — received ${got ?? "?"} ${inspection?.funded?.shareSymbol || shares?.symbol || "shares"}.`.trim() });
      refreshShares(); // the reclaim below now reflects the new on-chain position
    } catch (e: any) {
      // ⭐⭐ A GATE REFUSAL CARRIES THE FRESH DISCLOSURE — USE IT. The server returns 409 with the
      // server-computed disclosure precisely so the UI can show what must be acknowledged. It used
      // to be discarded: the user saw a bare refusal beside a disclosure they had already ticked,
      // with the tick still set and no indication anything had moved underneath them. A gate
      // refusing without saying why.
      //
      // ⚠️ AND THE TICK IS CLEARED ONLY ALONGSIDE THE DELTA. Clearing it on its own would demand a
      // re-tick with nothing new to read, which is a formality — and a formality is trained
      // click-through.
      const fresh = e?.payload?.disclosure ?? null;
      if (fresh) {
        // The accepted side is assembled from the inspection the user was actually shown. ⚠️ The
        // third argument is TRUE because the server REFUSED an acknowledgement it issued — that
        // refusal is the authoritative "something moved", since the client holds only a hash of the
        // old digest and cannot compare it to the raw one.
        const acceptedSide = insp?.verdict
          ? { level: insp.verdict.level, warns: insp.verdict.warns, blocks: insp.verdict.blocks,
              withdrawFeeBps: insp?.withdraw?.withdrawFeeBps ?? null,
              depositFeeBps: insp?.ownerPowers?.settableFees?.currentBps?.deposit ?? null }
          : null;
        const d = diffDisclosure(acceptedSide, fresh, true);
        setDelta({ d, level: fresh.level ?? null });
        setAcked(false);
        setInsp((prev: any) => (prev ? { ...prev, verdict: { ...prev.verdict, level: fresh.level, warns: fresh.warns, blocks: fresh.blocks } } : prev));
      }
      setMsg({ ok: false, text: e?.message || "Deposit failed" });
    } finally {
      setDepositing(false);
    }
  }

  async function withdraw() {
    // Reclaims the ENTIRE on-chain position. No amount is sent — the server reads balanceOf and
    // redeems exactly it. We gate the click on the live balance we read; the server re-reads anyway.
    if (!shares?.hasShares) return;
    setMsg(null);
    setWithdrawing(true);
    try {
      const data = await w.withdrawFromVault(VAULT_KEY);
      if (data?.reclaimed === false) {
        // Genuine empty position (server read balance == 0). Not a failure.
        setMsg({ ok: true, text: data?.message || "Nothing to reclaim — you hold no shares in this vault." });
      } else if (data?.ok && data?.confirmed && data?.withdrawTx && Number.isFinite(data?.usdcReceived)) {
        // Success ONLY when the server proved it: mined tx + a real on-chain USDC delta. `usdcReceived`
        // is the real balance delta, so no "?" placeholder and no computed 70.772 can appear here.
        setMsg({ ok: true, text: `Reclaimed — received ${data.usdcReceived} USDC back to your agent wallet.` });
      } else {
        // Resolved but NOT a proven reclaim with a real amount (e.g. an empty/intercepted 200). Render
        // failure honestly — never a computed or placeholder number. This also kills "received ? USDC".
        setMsg({ ok: false, text: "Reclaim didn't confirm — your shares are still in the vault. Please try again." });
      }
      refreshShares();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || "Withdraw failed" });
    } finally {
      setWithdrawing(false);
    }
  }

  if (!w.agentWallet) {
    return (
      <div className="plane">
        <div className="panel-eyebrow">Vault</div>
        <h2>Yield vault</h2>
        <div className="sub" style={{ marginBottom: 0 }}>
          Set up your wallet first — open{" "}
          <button className="linkbtn" onClick={() => (window.location.hash = "/wallet")}>Wallet</button>{" "}
          to connect and fund it, then come back to deposit.
        </div>
      </div>
    );
  }

  const depositDisabled = depositing || !amountValid || !insp || !depositable || (ackRequired && !acked);

  return (
    <div className="plane">
      <div className="panel-eyebrow">Vault · testnet dress rehearsal</div>
      <h2>Yield vault</h2>
      <div className="sub">
        Deposit USDC into an allowlisted ERC-4626 vault — but read its terms first. This is a testnet
        rehearsal for the check that will matter on mainnet: the vault's owner powers are disclosed
        BEFORE you commit, and you must accept them.
      </div>

      <div className="status" style={{ marginTop: 0, marginBottom: 16 }}>
        Agent wallet <span className="mono">{shortAddr(w.agentWallet.address)}</span>
        {" · balance "}<span className="mono">{w.agentWallet.balance ?? "…"}</span> USDC
      </div>

      {/* ── STEP 1 · INSPECT ─────────────────────────────────────────────── */}
      <div className="row">
        <button className="emerald" disabled={inspecting} onClick={inspect}>
          {inspecting ? "Inspecting on-chain…" : insp ? "Re-inspect vault" : "Inspect vault"}
        </button>
        <span className="status" style={{ margin: 0 }}>XyloNet USDC Vault (xyUSDC)</span>
      </div>

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
              <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} style={{ marginTop: 3 }} />
              <span style={{ fontSize: 13, lineHeight: 1.5 }}>
                I understand these are the vault owner's powers over my deposit — including that they can
                raise the exit fee and can withdraw the underlying USDC — and I accept them.
              </span>
            </label>
          )}
        </div>
      )}

      {/* ── ⭐ DUE DILIGENCE — the same signed report sold to outside callers ──────────────
          Rendered only AFTER an inspection, and deliberately BETWEEN the disclosure and the
          deposit: it is a second, independent reading of the same contract, and it belongs where
          the user is deciding rather than after they have committed.

          ⚠️ IT DOES NOT GATE THE DEPOSIT AND MUST NOT LOOK LIKE IT DOES. The deposit gate is the
          inspection + acknowledgement below, unchanged. The policy verdict here is display-only
          (client-supplied rules, no server store yet), and the card says so in those words. */}
      {vaultAddress && (
        <DdReportCard wallet={w} address={vaultAddress} label={insp?.vault?.label} />
      )}

      {/* ── STEP 2 · DEPOSIT ─────────────────────────────────────────────── */}
      {insp && (
        <>
          <div className="row" style={{ marginTop: 18 }}>
            <input
              type="number" min="0" step="0.01" style={{ maxWidth: 120 }}
              value={amount} onChange={(e) => setAmount(e.target.value)}
            />
            <span className="status" style={{ margin: 0 }}>USDC</span>
            <button className="emerald" disabled={depositDisabled} onClick={deposit}>
              {depositing ? "Depositing…" : `Deposit ${amountValid ? amountNum : 0} USDC`}
            </button>
          </div>
          {!depositable && (
            <div className="status" style={{ color: "var(--warn)" }}>
              Deposits are refused — this vault failed a safety check (see above). No acknowledgment can override a BLOCK.
            </div>
          )}
          {depositable && ackRequired && !acked && (
            <div className="status" style={{ opacity: 0.8 }}>Tick the acknowledgment above to enable the deposit.</div>
          )}
        </>
      )}

      {/* ── WITHDRAW (reclaim) — driven by the LIVE on-chain balance, independent of inspect/deposit ─
          The reclaim redeems the caller's ENTIRE current share balance, read server-side (never a
          typed value, never a session receipt), so a user returning in a NEW session can always get
          their funds back. Fail-closed: if the balance can't be read, the action is disabled — never
          shown as "nothing to reclaim". Sits OUTSIDE the `insp` gate on purpose: reclaiming must not
          require inspecting first. */}
      <div className="sub" style={{ marginTop: 22, marginBottom: 6 }}>
        Withdraw (reclaim shares → USDC). Always available, never blocked by a pause. Redeems your
        entire on-chain balance — there is no amount to type.
      </div>
      {loadingShares && !shares && !sharesErr ? (
        <div className="status" style={{ opacity: 0.8 }}>Checking your vault balance on-chain…</div>
      ) : sharesErr ? (
        <div className="row">
          <span className="status" style={{ margin: 0, color: "var(--warn)" }}>
            ⚠ Couldn't read your on-chain balance — reclaim is disabled until it reads (fail-safe, so a
            read glitch never looks like an empty balance).
          </span>
          <button className="linkbtn" disabled={loadingShares} onClick={refreshShares}>
            {loadingShares ? "…" : "Retry"}
          </button>
        </div>
      ) : !sharesProbed ? (
        // 🚨 NEVER LOOKED ≠ NOTHING THERE. Terminal for a signed-out or unprovisioned user, so it
        // must not borrow the empty state's words — see `sharesProbed` above.
        <div className="status" style={{ opacity: 0.8 }}>
          We haven't checked your vault balance yet — it loads once your agent wallet is ready. This
          is <b>not</b> a statement that you hold no shares.
        </div>
      ) : shares?.hasShares ? (
        <div className="row">
          <span className="status mono" style={{ margin: 0 }}>
            {shares.formatted} {shares.symbol}
            <span style={{ opacity: 0.7 }}> held on-chain — the exact amount that will be redeemed</span>
          </span>
          <button className="emerald" disabled={withdrawing} onClick={withdraw}>
            {withdrawing ? "Withdrawing…" : "Withdraw all (reclaim)"}
          </button>
        </div>
      ) : (
        <div className="status" style={{ opacity: 0.8 }}>
          Nothing to reclaim — you hold no shares in this vault.
        </div>
      )}

      {msg && (
        <div className="status" style={{ color: msg.ok ? "var(--emerald)" : "var(--warn)", marginTop: 12 }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
