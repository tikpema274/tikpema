import { DESTINATION_ORDER } from "../../shared/plan-capabilities.mjs";
import { useEffect, useState } from "react";
import { goToWalletAndReturn } from "../lib/returnTo";
import type { useWallet } from "../wallet/useWallet";
import { describeError } from "../lib/describeError";
import { formatUsdc, formatUsdcShort } from "../lib/formatUsdc";
import AddressDisplay from "./AddressDisplay";
import SignInPrompt from "./SignInPrompt";

type UnifiedWallet = ReturnType<typeof useWallet>;

// ═══ TREASURY — your USDC across chains: pockets, targets, proposed moves ══════════════════════
//
// PER-USER (decided 2026-09-19): "your treasury" is the signed-in user's own pockets — the Arc agent
// wallet, the Gateway unified balance, and USDC at destination-chain addresses the user names. Targets
// are percentages of the USDC total; the server (treasury-snapshot) reads every pocket and PROPOSES the
// moves that would close the drift. ⛔ NOTHING HERE MOVES MONEY. There is no seal on this page. Each
// proposal is a handoff to the surface that already carries that move's caps, pause, ledger and fee
// quote — #/unified (deposit / withdraw) or #/bridge — with the amount prefilled and a banner saying so.
// Pinned by verify-treasury-copy: the line below is present, ABOVE the proposals, and no button.emerald
// exists on the page.
export const NOTHING_MOVES_LINE =
  "Nothing here moves money. Each move is confirmed on its own page, within your agent's limits, with its fee shown first.";

export type Pocket = { id: string; label: string; chain: string; address?: string; asset?: string; usdc: string | null; ok: boolean; note?: string; perDomain?: { chain: string; domain: number; usdc: string | null; ok: boolean }[] };
export type Share = { id: string; usdc: string; sharePct: number; targetPct: number | null; driftUsdc: string | null };
export type Proposal = { kind: "ub_deposit" | "ub_withdraw" | "bridge"; from: string; to: string; amountUsdc: string; surface: "unified" | "bridge"; capNote: string | null; note: string | null };
export type Policy = { version: number; targets: { arc_sca: number; unified: number; dest: { chain: string; address: string; pct: number }[] }; minMoveUsdc: string; unallocatedPct?: number };
export type Snapshot = {
  walletAddress: string; owner: string; pockets: Pocket[]; policy: Policy | null; policyWarning: string | null;
  caps: { bridgeCapUsdc: string; ubDepositMaxPerTxUsdc: string };
  plan: { total: string | null; shares: Share[]; proposals: Proposal[]; unreadable: string[]; notMovable?: string[]; reason?: string; unallocatedPct?: number };
  readAt: string;
};
export type Draft = { arc_sca: number; unified: number; dest: { chain: string; address: string; pct: number }[] };
// ⭐ ONE SOURCE: the picker order from shared/plan-capabilities.mjs (the same order BridgePanel shows).
const DEST_CHAINS: readonly string[] = DESTINATION_ORDER.picker;

const trim6 = (v: string) => String(Number(v));
/** Where a proposal is confirmed — the hash route WITH the prefill the surface reads once at mount. */
export function handoffHash(p: Proposal): string {
  const amt = trim6(p.amountUsdc);
  if (p.kind === "bridge") { const chain = p.to.split(":")[1] ?? ""; return `/bridge?amount=${amt}&destination=${chain}`; }
  if (p.kind === "ub_deposit") return `/unified?deposit=${amt}`;
  return `/unified?withdraw=${amt}`;
}
const kindLabel: Record<Proposal["kind"], string> = { ub_deposit: "Deposit to unified balance", ub_withdraw: "Withdraw from unified balance", bridge: "Bridge from Arc" };
const surfaceLabel: Record<Proposal["surface"], string> = { unified: "Unified", bridge: "Bridge" };

function draftFrom(policy: Policy | null): Draft {
  return policy ? { arc_sca: policy.targets.arc_sca, unified: policy.targets.unified, dest: policy.targets.dest.map((d) => ({ ...d })) } : { arc_sca: 0, unified: 0, dest: [] };
}
const draftSum = (d: Draft) => d.arc_sca + d.unified + d.dest.reduce((s, r) => s + (Number(r.pct) || 0), 0);

/** The console, rendered from a snapshot. Exported so every state renders with crafted data (SSR cannot fetch). */
export function TreasuryView({
  snapshot, state, stateReason, draft: draftProp, saving, saveError, onSave, onRefresh, wallet,
}: {
  snapshot: Snapshot | null; state?: "ready" | "loading" | "signed-out" | "no-wallet" | "unreadable"; stateReason?: string;
  draft?: Draft; saving: boolean; saveError: string; onSave: (d: Draft) => void; onRefresh: () => void; wallet?: UnifiedWallet;
}) {
  const [draft, setDraft] = useState<Draft>(draftProp ?? draftFrom(snapshot?.policy ?? null));
  useEffect(() => { if (draftProp) setDraft(draftProp); }, [draftProp]);
  const s = state ?? (snapshot ? "ready" : "loading");

  const head = (
    <>
      <div className="panel-eyebrow">Treasury</div>
      <h2>Your USDC across chains</h2>
      <div className="sub">
        Every pocket of your USDC in one table, the share each holds, and the targets you set. The console proposes
        moves to close the drift; you confirm each one where it runs.
      </div>
    </>
  );
  if (s === "signed-out") return <div className="plane">{head}{wallet ? <SignInPrompt wallet={wallet} message="Sign in to read your treasury." /> : <div className="status">Sign in to read your treasury.</div>}</div>;
  if (s === "no-wallet") return <div className="plane">{head}<div className="status">Set up your wallet first — open <button className="linkbtn" onClick={goToWalletAndReturn}>Wallet</button> to connect one.</div></div>;
  // ⚠️ unreadable BEFORE the no-snapshot guard: an unreadable read has no snapshot either, and the suite
  //    caught this ordering rendering "Reading your pockets…" for a failed read — a pending claim for a failure.
  if (s === "unreadable") return <div className="plane">{head}<div className="status" style={{ borderLeft: "3px solid var(--warn)", paddingLeft: ".9rem" }}>Your treasury could not be read right now ({stateReason ?? "unknown"}). Nothing was moved. Try again in a moment.</div></div>;
  if (s === "loading" || !snapshot) return <div className="plane">{head}<div className="status">Reading your pockets…</div></div>;

  const { pockets, plan, policy } = snapshot;
  const shareOf = (id: string) => plan.shares.find((x) => x.id === id);
  const labelOf = (id: string) => pockets.find((p) => p.id === id)?.label ?? id;
  const unreadableNames = plan.unreadable.map(labelOf);
  const sum = draftSum(draft);
  const overSum = sum > 100;

  return (
    <div className="plane">
      {head}

      {/* ── HEADER: USDC-only total, null-preserving. Any unreadable pocket → no number, the pocket NAMED. ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
        <div className="status" style={{ margin: 0 }}>Read {snapshot.readAt.replace("T", " ").slice(0, 19)} UTC · <button className="linkbtn" onClick={onRefresh}>Refresh</button></div>
        <div style={{ textAlign: "right" }}>
          <div style={{ color: "var(--muted)", fontSize: "0.68rem", letterSpacing: "0.06em", textTransform: "uppercase" }}>Total</div>
          {plan.total === null ? (
            <div style={{ fontSize: "1.05rem", fontWeight: 600, color: "var(--warn)" }}>partly unavailable — {unreadableNames.join(", ")} unreadable</div>
          ) : (
            <div style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--paper)" }}>{formatUsdcShort(plan.total)} <span style={{ fontSize: "0.8rem", color: "var(--muted)", fontWeight: 400 }}>USDC</span></div>
          )}
        </div>
      </div>
      <div style={{ fontSize: "0.72rem", color: "var(--muted)", marginBottom: 12 }}>
        USDC only. EURC is shown as its own row and is <b>never summed</b> — there is no USD rate for it.
      </div>

      {/* ── THE TABLE ── */}
      <div className="tr-grid">
        <div className="tr-head"><div>Pocket</div><div>Where held</div><div className="tr-num">Balance</div><div className="tr-num">Share</div><div className="tr-num">Target</div><div className="tr-num">Drift</div></div>
        {pockets.map((p) => {
          const sh = shareOf(p.id);
          const isEurc = p.asset === "EURC";
          return (
            <div className="tr-row" key={p.id}>
              <div className="tr-pocket">{p.label}{isEurc ? <span className="tr-src">EURC · never summed</span> : null}</div>
              <div><div>{p.chain}</div>{p.address ? <AddressDisplay address={p.address} /> : null}{p.note ? <span className="tr-src">{p.note}</span> : null}
                {p.perDomain ? <span className="tr-src">{p.perDomain.map((d) => `${d.chain}: ${d.ok && d.usdc != null ? formatUsdc(d.usdc) : "unavailable"}`).join(" · ")}</span> : null}</div>
              <div className="tr-num">{p.usdc == null || !p.ok ? <span style={{ color: "var(--warn)" }}>unavailable</span> : formatUsdcShort(p.usdc)}</div>
              <div className="tr-num">{isEurc ? "—" : sh ? `${sh.sharePct.toFixed(2)} %` : "—"}</div>
              <div className="tr-num">{isEurc ? "—" : sh?.targetPct == null ? "—" : `${sh.targetPct} %`}</div>
              <div className="tr-num">{isEurc ? "—" : sh?.driftUsdc == null ? "—" : <span style={{ color: sh.driftUsdc.startsWith("-") ? "var(--warn)" : "var(--paper)" }}>{sh.driftUsdc.startsWith("-") ? "−" : "+"}{formatUsdcShort(sh.driftUsdc.replace("-", ""))}</span>}</div>
            </div>
          );
        })}
      </div>

      {/* ── TARGETS EDITOR ── */}
      <div className="panel-eyebrow" style={{ marginTop: 18 }}>Targets</div>
      {!policy && <div className="status" style={{ marginTop: 4 }}>No targets set yet — set what share of your USDC each pocket should hold, and the console will propose the moves.</div>}
      {snapshot.policyWarning && <div className="status" style={{ color: "var(--warn)" }}>{snapshot.policyWarning}</div>}
      <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
        <label className="status" style={{ margin: 0 }}>Agent wallet <input type="number" min="0" max="100" step="1" value={draft.arc_sca} onChange={(e) => setDraft({ ...draft, arc_sca: Number(e.target.value) })} style={{ maxWidth: 80, marginLeft: 6 }} /> %</label>
        <label className="status" style={{ margin: 0 }}>Unified balance <input type="number" min="0" max="100" step="1" value={draft.unified} onChange={(e) => setDraft({ ...draft, unified: Number(e.target.value) })} style={{ maxWidth: 80, marginLeft: 6 }} /> %</label>
      </div>
      {draft.dest.map((d, i) => (
        <div className="row" key={i} style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
          <select value={d.chain} onChange={(e) => setDraft({ ...draft, dest: draft.dest.map((r, j) => (j === i ? { ...r, chain: e.target.value } : r)) })}>{DEST_CHAINS.map((c) => <option key={c} value={c}>{c}</option>)}</select>
          <input placeholder="0x… address on that chain" value={d.address} onChange={(e) => setDraft({ ...draft, dest: draft.dest.map((r, j) => (j === i ? { ...r, address: e.target.value } : r)) })} style={{ minWidth: 300 }} />
          <input type="number" min="0" max="100" step="1" value={d.pct} onChange={(e) => setDraft({ ...draft, dest: draft.dest.map((r, j) => (j === i ? { ...r, pct: Number(e.target.value) } : r)) })} style={{ maxWidth: 80 }} /> %
          <button className="linkbtn" onClick={() => setDraft({ ...draft, dest: draft.dest.filter((_, j) => j !== i) })}>remove</button>
        </div>
      ))}
      <div className="row" style={{ gap: 12, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
        {draft.dest.length < 4 && <button className="linkbtn" onClick={() => setDraft({ ...draft, dest: [...draft.dest, { chain: "base", address: "", pct: 0 }] })}>+ add a destination address</button>}
        <span className="status" style={{ margin: 0, color: overSum ? "var(--warn)" : "var(--muted)" }}>Targets sum to {sum} %{overSum ? " — at most 100 %" : sum < 100 ? ` · ${100 - sum} % unallocated` : ""}</span>
        <button disabled={saving || overSum} onClick={() => onSave(draft)}>{saving ? "Saving…" : "Save targets"}</button>
      </div>
      {saveError && <div className="status" style={{ color: "var(--warn)" }}>{saveError}</div>}

      {/* ── PROPOSED MOVES — the line ABOVE the list, no seal on this page. ── */}
      <div className="status" style={{ borderLeft: "3px solid var(--warn)", paddingLeft: ".9rem", marginTop: 18 }}>
        <b>Read this first.</b> {NOTHING_MOVES_LINE}
      </div>
      <div className="panel-eyebrow" style={{ marginTop: 10 }}>Proposed moves</div>
      {plan.proposals.length === 0 ? (
        <div className="status">{plan.reason ?? (policy ? "On target — nothing to move." : "No targets set.")}</div>
      ) : (
        plan.proposals.map((p, i) => (
          <div className="summary-block" key={i}>
            <div className="summary-row"><span>Move</span><b>{kindLabel[p.kind]}</b></div>
            <div className="summary-row"><span>From → to</span><span>{labelOf(p.from)} → {labelOf(p.to)}</span></div>
            <div className="summary-row"><span>Amount</span><b className="mono">{formatUsdc(p.amountUsdc)} USDC</b></div>
            {p.capNote && <div className="summary-row"><span>Limit</span><span>{p.capNote}</span></div>}
            {p.note && <div className="summary-row"><span>Note</span><span>{p.note}</span></div>}
            <div className="summary-row"><span>Confirm on</span><a href={`#${handoffHash(p)}`} className="linkbtn">Do this on {surfaceLabel[p.surface]} →</a></div>
          </div>
        ))
      )}
      {plan.notMovable && plan.notMovable.length > 0 && (
        <div className="status" style={{ marginTop: 6 }}>Holding more than its target but <b>not movable from here</b>: {plan.notMovable.map(labelOf).join(", ")} — a named address is not ours to sign for.</div>
      )}
    </div>
  );
}

export default function TreasuryPanel({ wallet: w }: { wallet: UnifiedWallet }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "signed-out" | "no-wallet" | "unreadable">("loading");
  const [stateReason, setStateReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!w.address) { setState("signed-out"); return; }
      if (!w.agentWallet) { setState("no-wallet"); return; }
      setState("loading");
      try {
        const token = await w.ensureSession();
        const r = await fetch("/api/treasury-snapshot", { headers: { Authorization: `Bearer ${token}` } });
        const j = await r.json().catch(() => ({}));
        if (!alive) return;
        if (r.status === 401) { setState("signed-out"); return; }
        if (!r.ok) { setStateReason(j?.error || `HTTP ${r.status}`); setState("unreadable"); return; }
        setSnapshot(j); setState("ready");
      } catch (e: any) {
        if (!alive) return;
        setStateReason(describeError(e)); setState("unreadable");
      }
    })();
    return () => { alive = false; };
  }, [w.address, w.agentWallet, reload]);

  async function save(d: Draft) {
    setSaveError(""); setSaving(true);
    try {
      const token = await w.ensureSession();
      const r = await fetch("/api/treasury-policy", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ policy: { version: 1, targets: d } }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setReload((n) => n + 1);
    } catch (e: any) {
      setSaveError(describeError(e));
    } finally {
      setSaving(false);
    }
  }

  return <TreasuryView snapshot={snapshot} state={state} stateReason={stateReason} saving={saving} saveError={saveError} onSave={save} onRefresh={() => setReload((n) => n + 1)} wallet={w} />;
}
