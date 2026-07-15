import { useState, useEffect } from "react";
import type { useWallet } from "../wallet/useWallet";

type UnifiedWallet = ReturnType<typeof useWallet>;

// The one allowlisted testnet vault (mirrors VAULT_ALLOWLIST server-side). The UI never sends a
// free-form address — only this key.
const VAULT_KEY = "xylo-usdc";

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

  const [amount, setAmount] = useState("1");
  const [depositing, setDepositing] = useState(false);
  // The caller's LIVE on-chain share balance in the vault (read-only, from /api/agent-vault-shares).
  // This — NOT a session deposit receipt — drives whether a reclaim is available, so a user who
  // deposited in a PRIOR session can still withdraw. `null` = not loaded; `sharesErr` set = the read
  // FAILED (fail-closed: we never show "nothing to reclaim" on a failed read). The reclaim amount is
  // still never typed or sent — the server reads the balance and redeems exactly it.
  const [shares, setShares] = useState<{ raw: string; formatted: string; symbol: string; hasShares: boolean } | null>(null);
  const [sharesErr, setSharesErr] = useState("");
  const [loadingShares, setLoadingShares] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);

  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const amountNum = Number(amount);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;

  const inspection = insp?.inspection ?? null;
  const level: string | null = inspection?.verdict?.level ?? null;
  const warns: Array<{ code: string; detail: string }> = inspection?.verdict?.warns ?? [];
  const blocks: Array<{ code: string; detail: string }> = inspection?.verdict?.blocks ?? [];
  const ackRequired: boolean = !!insp?.ackRequired;
  const depositable: boolean = !!insp?.depositable;

  // Load the live on-chain share balance. Fail-closed: on a read error we set `sharesErr` and clear
  // `shares` so the reclaim UI shows "can't read" (disabled), never a false "nothing to reclaim".
  async function refreshShares() {
    if (!w.isAuthenticated || !w.agentWallet) return;
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
        setMsg({ ok: true, text: data?.message || "Nothing to reclaim — you hold no shares in this vault." });
      } else {
        setMsg({ ok: true, text: `Reclaimed — received ${data?.usdcReceived ?? "?"} USDC back to your agent wallet.` });
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
              Withdraw: {inspection.withdraw?.withdrawFeePct ?? "?"} exit fee · no lock/delay ·
              retains ~{inspection.withdraw?.roundTripRetainedPct ?? "?"} on a round trip
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
