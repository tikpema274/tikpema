import { useCallback, useEffect, useState } from "react";
import { readJson } from "../lib/readJson";
import { formatUsdc, formatBalance, NO_AMOUNT } from "../lib/formatUsdc";
import { describeError } from "../lib/describeError";

// UbExitStatus — the READ side of the unified-balance exit.
//
// ═══ ⭐ WHY THIS SHIPS BEFORE THE BUTTON ═════════════════════════════════════════════════════
// There is already a live withdrawal (16be509f, initiated 2026-08-12) that NOBODY CAN SEE IN THE
// APP. The read side has a real user need today; the write side has none. It also proves auth,
// routing and response shape against known values before anything moves.
//
// ═══ 🚨 THE THREE RULES THIS SURFACE EXISTS TO KEEP ══════════════════════════════════════════
// 1. `readable:false` GATES THE NUMBERS. An unreadable chain is not a zero balance. On a page
//    answering "where is my money", rendering an absence as "0.000000" is the one lie that matters.
// 2. SIX DECIMALS, ALWAYS. The server's formatUnits output trims zeros ("2.51", "2"), and 2dp
//    hides material differences — established by the bridge work on this exact surface.
// 3. "ABOUT SEVEN DAYS", NEVER A COUNTDOWN OR A DATE. `maturesApprox` is derived from a BLOCK
//    count at a measured block time, so it drifts. A ticking clock or a fixed date would present a
//    derived estimate as a promise.
//
// ⚠️ `withdrawals` IS NOT ALWAYS AN ARRAY. The server returns `{unreadable:true}` when the store
// could not be read — distinct from `[]` ("you have none"). Collapsing those would tell a user
// they have no withdrawals when we simply could not look.

type Balance = { readable?: boolean; availableUsdc?: string; withdrawableUsdc?: string; detail?: string };
type Row = {
  withdrawalId?: string; amountUsdc?: string; state?: string;
  maturesApprox?: string | null; initiateTxHash?: string | null; stillNeedsAgentWithdraw?: boolean;
};
type Payload = {
  owner?: string;
  balance?: Balance;
  withdrawals?: Row[] | { unreadable: true; detail?: string };
  disclosure?: { waitDescription?: string; steps?: string[]; automatic?: string };
};

/** The user-facing name for each state. ⭐ A CLOSED MAP: an unrecognised state renders as itself
 *  rather than being silently treated as done — a new state must never read as "completed". */
const STATE_LABEL: Record<string, string> = {
  initiating: "starting",
  waiting: "waiting — about seven days",
  completing: "finishing now",
  completed: "arrived in your agent wallet",
  failed: "did not start",
};

const isOpen = (s?: string) => s === "initiating" || s === "waiting" || s === "completing";

/**
 * ⚠️⚠️ `initial` IS A TEST-ONLY SEAM, AND IT EXISTS FOR A MEASURED REASON.
 *
 * 🚨 THIS COMPONENT WAS UNREACHABLE BY EVERY GUARD IN THE REPO. `verify-unified-balance-copy`
 * listed it among the children its whole-rendered-tree checks cover — and it contributed **ZERO
 * CHARACTERS** to a 4,152-char render, because `loading` starts `true` and every claim-bearing
 * branch sits behind a `useEffect` fetch that `renderToStaticMarkup` never runs. An absence check
 * over a component that renders nothing PASSES, so the suite was green and blind at once.
 *
 * ⚠️ AND MOCKING `fetch` DOES NOT FIX IT. There is no DOM and no effect pass under SSR, so the
 * request never happens however it is stubbed — the seam has to be the RESULT, not the transport.
 *
 * ⭐ Same shape as `_research.mjs`'s documented `forceDecision`: production passes nothing and
 * behaviour is identical; a guard seeds the state the fetch would have produced. It is read ONCE,
 * to initialise, so it cannot diverge from real behaviour mid-life.
 * ⭐ The guard that uses it drives the REAL `ub-withdraw` GET handler to produce that payload, so
 * what is rendered here is what the server actually emits — a binding can only be tested across
 * what it binds.
 */
export type UbExitInitial = { data?: Payload | null; error?: string };

export default function UbExitStatus({
  token,
  reloadKey = 0,
  initial,
}: {
  token: () => Promise<string>;
  reloadKey?: number;
  initial?: UbExitInitial;
}) {
  const [data, setData] = useState<Payload | null>(initial?.data ?? null);
  const [error, setError] = useState(initial?.error ?? "");
  // ⚠️ Seeded state means the first paint is NOT loading — otherwise the seam would render the
  // spinner and prove nothing, which is exactly the failure it exists to end.
  const [loading, setLoading] = useState(!(initial?.data || initial?.error));
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [startErr, setStartErr] = useState("");
  const [started, setStarted] = useState<{ amountUsdc?: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const t = await token();
      const r = await fetch("/api/ub-withdraw", { headers: { Authorization: `Bearer ${t}` } });
      // ⭐ readJson, not r.json(): an unmatched /api GET is served 200 with SPA HTML, and a raw
      // res.ok check reads that CDN page as success. See src/lib/readJson.ts.
      const d = await readJson<Payload>(r);
      if (!r.ok) throw new Error((d as any)?.error || "Could not read your exit status");
      setData(d);
      setError("");
    } catch (e: any) {
      // ⚠️ An error here means WE COULD NOT LOOK. It must never be rendered as "nothing pending".
      setData(null);
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load, reloadKey]);

  /**
   * ⚠️ `busy` GUARDS THE DOUBLE PRESS ONLY IN THIS TAB. The real protection is the server's 409
   * (ub-withdraw.mjs) — a refresh, a second tab or a direct call all bypass React state, and a
   * second start would be a second irreversible seven-day clock.
   */
  const start = useCallback(async () => {
    if (busy) return;
    setBusy(true); setStartErr(""); setStarted(null);
    try {
      const t = await token();
      const r = await fetch("/api/ub-withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ amountUsdc: Number(amount) }),
      });
      const d = await readJson<any>(r);

      // ⭐ THE CONFLICT IS NOT AN ERROR THE USER CAUSED — it means their money is already on its
      // way. Say that, and say the existing one is untouched, rather than "request failed".
      if (r.status === 409) {
        setStartErr(
          `${d?.error ?? "You already have a withdrawal on its way out."} ` +
            `Nothing new was started and the existing one is unaffected.`
        );
        await load();
        return;
      }
      // ⚠️ A 502 here is INDETERMINATE, not failed — the chain call may have landed. Never invite
      // a retry, because a retry against a request that DID land starts a second clock.
      if (r.status === 502 && d?.indeterminate) {
        setStartErr(
          "We couldn’t confirm whether this started. Do NOT try again — we’re checking it " +
            "automatically, and it will appear above if it began."
        );
        await load();
        return;
      }
      if (!r.ok) throw new Error(d?.error || "Could not start the withdrawal");

      setStarted({ amountUsdc: d?.amountUsdc ?? amount });
      setAmount("");
      await load();
    } catch (e: any) {
      setStartErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }, [amount, busy, load, token]);

  if (loading && !data && !error) return <div className="qd">Checking your exit…</div>;

  if (error) {
    return (
      <div className="qd" style={{ color: "var(--warn)" }}>
        <b>We couldn’t read your exit status.</b> This is <b>not</b> a statement that you have
        nothing pending — we could not look. {error}
      </div>
    );
  }

  const rows = Array.isArray(data?.withdrawals) ? (data!.withdrawals as Row[]) : null;
  const rowsUnreadable = !!data?.withdrawals && !Array.isArray(data.withdrawals);
  const open = rows?.filter((r) => isOpen(r.state)) ?? [];
  const available = formatBalance(data?.balance, "availableUsdc");
  const withdrawable = formatBalance(data?.balance, "withdrawableUsdc");
  const unreadableChain = data?.balance?.readable !== true;

  return (
    <div style={{ marginTop: 12 }}>
      <div
        style={{
          color: "var(--muted)", fontSize: "0.72rem", letterSpacing: "0.06em",
          textTransform: "uppercase", marginBottom: 6,
        }}
      >
        Getting money out
      </div>

      {/* ── THE NUMBERS, GATED ON readable ─────────────────────────────────────────────── */}
      {unreadableChain ? (
        <div className="qd" style={{ color: "var(--warn)" }}>
          <b>We couldn’t read your unified balance just now.</b> That is different from it being
          zero — we don’t know the amount, so we’re not showing one.
        </div>
      ) : (
        <div className="qd">
          <span className="mono">{available}</span> USDC available to withdraw
          {withdrawable !== NO_AMOUNT && Number(withdrawable) > 0 && (
            <>
              {" · "}
              <span className="mono">{withdrawable}</span> USDC ready to land
            </>
          )}
        </div>
      )}

      {/* ── OPEN WITHDRAWALS ───────────────────────────────────────────────────────────── */}
      {rowsUnreadable && (
        <div className="qd" style={{ color: "var(--warn)" }}>
          We couldn’t read your withdrawal list. <b>This is not a statement that you have none.</b>
        </div>
      )}

      {rows && open.length === 0 && (
        <div className="qd" style={{ color: "var(--muted)" }}>Nothing on its way out right now.</div>
      )}

      {open.map((r) => (
        <div
          key={r.withdrawalId}
          className="qd"
          style={{
            marginTop: 8, padding: "10px 12px", background: "var(--field)",
            border: "1px solid var(--line)", borderRadius: 10,
          }}
        >
          <div>
            <b><span className="mono">{formatUsdc(r.amountUsdc)}</span> USDC</b>
            {" — "}
            {STATE_LABEL[r.state ?? ""] ?? r.state ?? "unknown state"}
          </div>
          {/* ⚠️ APPROXIMATE, AND SAID SO. No countdown, no fixed date: maturesApprox is derived
              from a block count and drifts with block time. */}
          {r.maturesApprox && (
            <div style={{ color: "var(--muted)" }}>
              Expected around <b>{new Date(r.maturesApprox).toLocaleDateString()}</b> — approximate,
              not a deadline. The wait is set by Arc’s Gateway, not by us.
            </div>
          )}
          {/* ⭐ WHERE IT LANDS. A user who waits seven days and finds the money "not arrived"
              would be reading a UI that omitted this. */}
          {r.stillNeedsAgentWithdraw !== false && (
            <div style={{ color: "var(--muted)" }}>
              It arrives in your <b>agent wallet</b>. Moving it on to your login wallet is a
              separate step you control.
            </div>
          )}
        </div>
      ))}

      <div className="qd" style={{ color: "var(--muted)", marginTop: 8 }}>
        We finish this automatically — <b>you do not have to come back</b>.
      </div>

      {/* ═══ PART 2 — THE ACTION ════════════════════════════════════════════════════════════
          ⭐ THE DISCLOSURE TRAVELS WITH THE BUTTON, following YourMoney.tsx's standard:
          "If this disclosure is ever separated from the button, the trap is back." The ~7 days
          is a COMMITMENT HORIZON, not a delay on a button — it belongs before the press, not
          in a spinner after it. */}
      {!unreadableChain && open.length === 0 && available !== NO_AMOUNT && Number(available) > 0 && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <div className="qd" style={{ color: "var(--warn)" }}>
            <b>Before you start:</b> this takes <b>about seven days</b> and cannot be cancelled once
            it begins — the wait is set by Arc’s Gateway, not by us.{" "}
            {/* ⭐ WHERE THE MONEY LANDS. A user who waits seven days and finds the money "not
                arrived" would be reading a UI that omitted this. The server says it in
                whatHappensNext; it must be said here, BEFORE the press. */}
            The funds arrive in your <b>agent wallet</b> — moving them on to your login wallet is a{" "}
            <b>separate step you control</b>. Nothing arrives in your own wallet automatically.
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              className="field"
              inputMode="decimal"
              placeholder="Amount in USDC"
              value={amount}
              disabled={busy}
              onChange={(e) => setAmount(e.target.value)}
              style={{ maxWidth: 180 }}
            />
            <button
              className="btn"
              // ⚠️ DISABLED ON FIRST PRESS — but that is CONTAINMENT, not the guard. A refresh, a
              // second tab or a direct call all bypass client state, so the server refuses a
              // second open withdrawal with 409. See ub-withdraw.mjs.
              disabled={busy || !(Number(amount) > 0)}
              onClick={start}
            >
              {busy ? "Starting…" : "Start withdrawal"}
            </button>
            <button
              className="linkbtn"
              disabled={busy}
              onClick={() => setAmount(available)}
              type="button"
            >
              all ({available})
            </button>
          </div>

          {startErr && (
            <div className="qd" style={{ color: "var(--danger)", marginTop: 6 }}>{startErr}</div>
          )}
          {started && (
            <div className="qd" style={{ marginTop: 6 }}>
              <b>Started.</b> {formatUsdc(started.amountUsdc)} USDC is on its way out.{" "}
              {/* ⚠️ Say precisely what HAS happened. Nothing has moved yet. */}
              No funds have moved yet — the wait has begun.
            </div>
          )}
        </div>
      )}

      {/* ⭐ WHY THE FORM IS ABSENT, SAID OUT LOUD. A control that silently vanishes reads as a
          missing feature; this is the server's own rule, surfaced. */}
      {!unreadableChain && open.length > 0 && (
        <div className="qd" style={{ color: "var(--muted)", marginTop: 10 }}>
          You can start another once this one finishes — one at a time.
        </div>
      )}
    </div>
  );
}
