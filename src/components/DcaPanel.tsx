import { useEffect, useState } from "react";
import type { useWallet } from "../wallet/useWallet";
import { agentClient } from "../lib/agentClient";
import { arcTestnet } from "../config/chain";

type UnifiedWallet = ReturnType<typeof useWallet>;
type Token = "USDC" | "EURC";

const EXPLORER = arcTestnet.blockExplorers.default.url;
const HOUR_MS = 3600 * 1000;

// Cadence options — the labels the disclosure copy reads back verbatim. Floor is 1h
// (MIN_CADENCE_MS server-side); anything shorter is rejected there, so it isn't offered here.
const CADENCES: { label: string; ms: number }[] = [
  { label: "hour", ms: HOUR_MS },
  { label: "6 hours", ms: 6 * HOUR_MS },
  { label: "day", ms: 24 * HOUR_MS },
  { label: "week", ms: 7 * 24 * HOUR_MS },
];

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

// DcaPanel — create and manage DCA mandates. Nav-less (#/dca), reached from the swap area.
//
// ⚠️ DISCLOSURE FIRST, AND IT IS NOT SOFTENED. A DCA mandate is the ONLY thing in Tikpema that
// moves money with no human present. The plain custodial truth leads the page, BEFORE the
// form, in an amber band the user must acknowledge — the same grammar as the vault owner-power
// band, turned on OUR OWN custody. The copy reads back the user's actual numbers so they
// authorize exactly what they configured, not an abstraction.
export default function DcaPanel({ wallet: w }: { wallet: UnifiedWallet }) {
  const [tokenIn, setTokenIn] = useState<Token>("USDC");
  const tokenOut: Token = tokenIn === "USDC" ? "EURC" : "USDC";
  const [perTick, setPerTick] = useState("5");
  const [cadenceMs, setCadenceMs] = useState(HOUR_MS * 24);
  const [totalBudget, setTotalBudget] = useState("50");
  // Default end date: 30 days out, as an epoch ms the server validates as future.
  const [endAt, setEndAt] = useState<number>(Date.now() + 30 * 24 * HOUR_MS);
  const [acked, setAcked] = useState(false);

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [mandates, setMandates] = useState<any[] | null>(null);

  const perTickNum = Number(perTick);
  const budgetNum = Number(totalBudget);
  const cadenceLabel = CADENCES.find((c) => c.ms === cadenceMs)?.label ?? "period";
  const swapsPlanned = perTickNum > 0 ? Math.floor(budgetNum / perTickNum) : 0;

  const formValid =
    Number.isFinite(perTickNum) && perTickNum > 0 &&
    Number.isFinite(budgetNum) && budgetNum >= perTickNum &&
    endAt > Date.now();

  async function refresh() {
    try {
      const token = await w.ensureSession();
      const r = await agentClient.dcaList(token);
      setMandates(r.mandates || []);
    } catch (e: any) {
      // A list failure shouldn't wipe the form; surface quietly.
      setMandates([]);
    }
  }

  useEffect(() => {
    if (w.isAuthenticated) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.isAuthenticated]);

  async function create() {
    setError("");
    if (!acked) {
      setError("Acknowledge the custodial terms above first.");
      return;
    }
    setCreating(true);
    try {
      const token = await w.ensureSession();
      await agentClient.dcaCreate(
        {
          id: crypto.randomUUID(),
          tokenIn,
          tokenOut,
          perTickAmount: perTickNum,
          cadenceMs,
          totalBudgetAmount: budgetNum,
          endAt,
        },
        token
      );
      setAcked(false);
      await refresh();
    } catch (e: any) {
      setError(e?.message || "Could not create the mandate");
    } finally {
      setCreating(false);
    }
  }

  async function cancel(id: string) {
    try {
      const token = await w.ensureSession();
      await agentClient.dcaCancel(id, token);
      await refresh();
    } catch (e: any) {
      setError(e?.message || "Could not cancel");
    }
  }

  return (
    <div className="plane">
      <div className="panel-eyebrow">Recurring swap · DCA</div>
      <h2>Swap on a schedule, while you're away.</h2>

      {/* ── THE CUSTODIAL DISCLOSURE BAND — LEADS THE PAGE, BEFORE THE FORM. ──────────────
          Not a tooltip, not below the fold, not softened. Reads back the user's live numbers.
          This is the vault owner-power band applied to our OWN custody: the one honest
          sentence about what they are actually authorizing. */}
      <div
        style={{
          marginTop: 6,
          border: "1px solid var(--amber)",
          borderRadius: 10,
          padding: "14px 16px",
          background: "var(--amber-soft)",
        }}
      >
        {/* ═══ 🚨 THIS BLOCK IS A CONSENT RECORD, NOT COPY ═══════════════════════════════════
            What it says is what the user agreed to. If it drifts, their authorization drifts with
            it, and nobody finds out — this surface already ran 22 days with its notes reading
            "fully verified" while the panel 404'd.

            ⚠️ TWO CLAIMS WERE CORRECTED 2026-08-20, both measured against the server:
            · "pause or cancel anytime" implied a PER-MANDATE pause. There is none: STATUS has only
              active/cancelled/complete/expired/stopped-failed, and the panel offers one button,
              Cancel. What exists is the AGENT-WIDE kill switch (`assertNotPaused`, checked
              fail-closed at dca-tick.mjs:372) — a different thing, since it stops everything the
              executor does, not just this schedule.
            · "cancelling stops it immediately" was FALSE for a fill already in flight.
              `dca-cancel` never looks at `pendingPeriod`, and the swap is already submitted
              on-chain, so it lands regardless. The honest form says what cancelling CAN and
              CANNOT reach.
            ⭐ Guarded by verify-dca-consent-copy.tsx, which pins both against the code. */}
        <div style={{ fontWeight: 600, marginBottom: 8 }}>⚠ This is custodial. Read it before you authorize.</div>
        <div style={{ fontSize: 14, lineHeight: 1.6, color: "var(--paper)" }}>
          <b>Tikpema's server</b> will swap up to{" "}
          <b>{formValid ? perTickNum : "—"} {tokenIn}</b> into {tokenOut} every{" "}
          <b>{cadenceLabel}</b> on your behalf <b>while you're offline</b>, until{" "}
          <b>{fmtDate(endAt)}</b> (or a total of <b>{formValid ? budgetNum : "—"} {tokenIn}</b>,
          whichever comes first). These swaps are <b>signed by a server-controlled key, not your
          passkey</b>. You can <b>cancel this schedule anytime</b>, and <b>stop your agent entirely</b> with
          the kill switch — <b>nothing swaps while your agent is stopped</b>. ⚠️ Cancelling stops
          every <b>future</b> swap; a swap already submitted will still land, because it is already
          on-chain and nothing can recall it. Every swap still obeys your per-swap cap and daily
          ceiling.
        </div>

        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 12, cursor: "pointer" }}>
          <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} style={{ marginTop: 3 }} />
          <span style={{ fontSize: 13, lineHeight: 1.5 }}>
            I understand Tikpema's server will move my USDC/EURC automatically while I'm offline,
            signed by a key it controls; that I can cancel this at any time, which stops every
            future swap but cannot recall one already submitted.
          </span>
        </label>
      </div>

      {/* ── THE FORM ─────────────────────────────────────────────────────────────────── */}
      <div style={{ marginTop: 18, display: "grid", gap: 12, maxWidth: 460 }}>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <span className="status" style={{ margin: 0 }}>Swap</span>
          <button className={tokenIn === "USDC" ? "emerald" : ""} onClick={() => setTokenIn("USDC")}>USDC → EURC</button>
          <button className={tokenIn === "EURC" ? "emerald" : ""} onClick={() => setTokenIn("EURC")}>EURC → USDC</button>
        </div>

        <label style={{ display: "grid", gap: 4 }}>
          <span className="status" style={{ margin: 0 }}>Amount per swap ({tokenIn})</span>
          <input type="number" min="0" step="0.01" value={perTick} onChange={(e) => setPerTick(e.target.value)} style={{ maxWidth: 160 }} />
        </label>

        <label style={{ display: "grid", gap: 4 }}>
          <span className="status" style={{ margin: 0 }}>Every</span>
          <select value={cadenceMs} onChange={(e) => setCadenceMs(Number(e.target.value))} style={{ maxWidth: 160 }}>
            {CADENCES.map((c) => (
              <option key={c.ms} value={c.ms}>{c.label}</option>
            ))}
          </select>
        </label>

        <label style={{ display: "grid", gap: 4 }}>
          <span className="status" style={{ margin: 0 }}>Total budget ({tokenIn})</span>
          <input type="number" min="0" step="0.01" value={totalBudget} onChange={(e) => setTotalBudget(e.target.value)} style={{ maxWidth: 160 }} />
          <span className="status" style={{ margin: 0, opacity: 0.7 }}>
            ≈ {swapsPlanned} swap{swapsPlanned === 1 ? "" : "s"} at {formValid ? perTickNum : "—"} {tokenIn} each
          </span>
        </label>

        <label style={{ display: "grid", gap: 4 }}>
          <span className="status" style={{ margin: 0 }}>End date</span>
          <input
            type="date"
            value={new Date(endAt).toISOString().slice(0, 10)}
            min={new Date(Date.now() + 24 * HOUR_MS).toISOString().slice(0, 10)}
            onChange={(e) => setEndAt(new Date(e.target.value + "T00:00:00Z").getTime())}
            style={{ maxWidth: 200 }}
          />
        </label>

        <div>
          <button className="emerald" disabled={creating || !formValid || !acked} onClick={create}>
            {creating ? "Creating…" : "Authorize recurring swap"}
          </button>
        </div>
        {error && <div className="status" style={{ color: "var(--warn)" }}>{error}</div>}
      </div>

      {/* ── EXISTING MANDATES — with an always-available Cancel. ──────────────────────── */}
      <div style={{ marginTop: 26 }}>
        <div className="panel-eyebrow">Your recurring swaps</div>
        {mandates === null && <div className="status">Loading…</div>}
        {mandates?.length === 0 && <div className="status" style={{ opacity: 0.7 }}>None yet.</div>}
        {mandates?.map((m) => (
          <div key={m.id} className="status" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
              <b>{m.perTickAmount} {m.tokenIn} → {m.tokenOut}</b> every{" "}
              {CADENCES.find((c) => c.ms === m.cadenceMs)?.label ?? `${m.cadenceMs / HOUR_MS}h`}{" "}
              · <span style={{ opacity: 0.8 }}>{m.spentAmount}/{m.totalBudgetAmount} {m.tokenIn} spent</span>
              {" · "}<span style={{ opacity: 0.8 }}>until {fmtDate(m.endAt)}</span>
              <div style={{ opacity: 0.7, marginTop: 2 }}>
                status: {m.status}
                {m.lastFillTx && (
                  <> · last fill <a href={`${EXPLORER}/tx/${m.lastFillTx}`} target="_blank" rel="noreferrer">↗</a></>
                )}
                {m.status === "active" && m.lastSkip && <> · last skip: {m.lastSkip}</>}
              </div>
            </div>
            {m.status === "active" && (
              <button onClick={() => cancel(m.id)}>Cancel</button>
            )}
          </div>
        ))}
      </div>

      <div className="row" style={{ marginTop: 20 }}>
        <button className="linkbtn" onClick={() => (window.location.hash = "/swap")}>← Back to swap</button>
      </div>
    </div>
  );
}
