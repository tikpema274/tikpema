import { useEffect, useState } from "react";
import type { useWallet } from "../wallet/useWallet";
import { agentClient } from "../lib/agentClient";
import { arcTestnet } from "../config/chain";
import { describeError } from "../lib/describeError";

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

// DcaPanel — create and manage DCA mandates. Nav-less (#/dca).
//
// ⚠️ THIS COMMENT USED TO SAY "reached from the swap area." IT WAS FALSE, and had been for as long
// as the route existed: nothing anywhere in src/ links to #/dca. Every sibling nav-less route has a
// quick-card (swap → MyAgentPanel, bridge → MyAgentPanel + Dashboard, vault/nanopay → Dashboard);
// this one had none, so the only way in was typing the hash. 🚨 A comment asserting an entry point
// that does not exist is the claim-nothing-checks species — it sends the next reader hunting for a
// link, and it is why "is DCA wired?" took an hour to answer instead of one grep.
//
// 🚧 CREATE IS NOW GATED (see CREATE_GATED in _dca.mjs for the reason and the UNBLOCK CONDITION).
// The gate state is read from dca-list, never duplicated here. Cancel and list stay fully live.
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
  // ⭐ Defaults FALSE so the ungated surface is what renders when the server has not answered —
  // including under verify-dca-consent-copy.tsx, which must keep testing the consent copy that
  // will be shown the moment the gate lifts. A guard that only tested the gated view would let the
  // authorization text rot unwatched, which is exactly how this surface failed before.
  const [createGated, setCreateGated] = useState(false);

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
      setCreateGated(r.createGated === true); // server is the only source of truth for the gate
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
      setError(describeError(e));
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
      setError(describeError(e));
    }
  }

  return (
    <div className="plane">
      <div className="panel-eyebrow">Recurring swap · DCA</div>
      <h2>Swap on a schedule, while you're away.</h2>

      {/* ── 🚧 THE GATE NOTICE. Says what is closed AND what still works, because a user with a
          running schedule must never be left wondering whether they can still stop it. ────── */}
      {createGated && (
        <div
          style={{
            marginTop: 10,
            border: "1px solid var(--warn)",
            borderRadius: 10,
            padding: "12px 16px",
            fontSize: 14,
            lineHeight: 1.6,
          }}
        >
          <b>New schedules are paused.</b> We're not accepting new recurring swaps while we finish
          work on how unconfirmed swaps are counted against your daily limit.{" "}
          <b>Any schedule you already have keeps running, and you can still cancel it below.</b>
        </div>
      )}

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
            ⚠️ A THIRD CLAIM WAS CORRECTED 2026-08-21, and this one was not a wording slip:
            · "Every swap still obeys your per-swap cap and daily ceiling" read as a promise about
              the COUNTERS. Both ARE enforced before a swap is submitted (_actions.mjs checks the
              per-swap cap, then canSpendDay, and returns blocked BEFORE agentSwap runs) — so the
              sentence was true of the swap it described. 🚨 WHAT IT HID IS THE FORWARD EFFECT: the
              SwapPendingConfirm branch (dca-tick.mjs) ledgered NOTHING, so a fill that landed after
              the 60s waitForTx deadline was never counted, and the daily ceiling then UNDERSTATED
              for every later swap — the user's own manual sends and swaps included, not just DCA's.
              An uncounted fill does not just under-report; it hands out headroom nobody authorized.
            ⭐⭐ AND THAT EXCEPTION WAS REMOVED 2026-08-22, BECAUSE THE DEFECT IT DESCRIBED IS FIXED.
              dca-tick's SwapPendingConfirm branch now charges the day ceiling AT SUBMIT
              (idempotently, so the reconcile's own charge cannot double-count), and a witnessed
              FAILED/CANCELLED/DENIED gives the amount back via reverseChargeById.
              🚨 THE REMOVAL IS AS LOAD-BEARING AS THE ADDITION WAS. A consent record that still
              warned of an under-count that no longer happens is not harmless over-caution — it
              describes a system the user is not using, and "the words are still there" is exactly
              what a presence check would have kept certifying. The sentence must track the code in
              BOTH directions or it is not a record of anything.
            ⚠️ WHAT IS DELIBERATELY *NOT* CLAIMED: only the DAY CEILING moves at submit.
              recordDcaSpend (DCA's own half, via yieldsToUser) stays confirm-gated, so a second
              mandate of the same owner can still fill against a briefly understated DCA half. The
              copy says nothing about DCA's internal half-share, so it does not overstate — but do
              not "improve" it into a general promise that everything is counted at submit.
            ⭐ Guarded by verify-dca-consent-copy.tsx, which pins all of these against the code —
              §1 pins the ORDER in _actions.mjs, that the pending branch charges the day ceiling
              and NOTHING ELSE, and that the obsolete warning is GONE rather than merely joined. */}
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
          on-chain and nothing can recall it. Every swap is checked against your <b>per-swap cap</b>
          and <b>daily ceiling</b> before it is submitted, and it is{" "}
          <b>counted against your daily total as soon as it is submitted</b> — not when it
          confirms — so a swap that is still settling can never quietly free up room for another
          one. If we then see on-chain that it <b>failed</b>, the amount is given back.
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
          <button className="emerald" disabled={creating || !formValid || !acked || createGated} onClick={create}>
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
