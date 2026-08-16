import { useState } from "react";
import type { useWallet } from "../wallet/useWallet";

type UnifiedWallet = ReturnType<typeof useWallet>;

// DdReportCard — the in-app face of the due-diligence report.
//
// ═══ ⭐⭐ THE SERVER SENDS EVERYTHING; THIS RENDERS LESS ═══════════════════════════════════════
// `/api/agent-dd-report` deliberately has no "lite" mode: the response is byte-for-byte the
// artifact a paying buyer receives over x402, because a policy verdict is only worth something if
// the thing it evaluated can be INDEPENDENTLY CHECKED. The trimming happens HERE, at the point of
// display, where it costs nothing and hides nothing — the full payload stayed on the wire and is
// one click away in the raw view.
//
// ⚠️ SO DO NOT ADD A SERVER PROJECTION TO MAKE THIS COMPONENT SIMPLER. That would move the trim
// upstream of the attestation and quietly reintroduce the two-schema problem the route exists to
// avoid.
//
// ═══ 🚨 A POLICY GATE CAN NEVER SAY "SAFE" ════════════════════════════════════════════════════
// `policy.ceiling` (POLICY_CEILING) rides on every result and this card renders it verbatim, not a
// friendlier paraphrase. A pass means NOTHING WAS FOUND AGAINST YOUR RULES. The word "safe", a green
// tick alone, or a shield icon would each contradict a string handed to this component in the same
// object.
//
// ═══ 🚨 AND THE VERDICT AUTHORISES NOTHING TODAY ══════════════════════════════════════════════
// The policy is client-supplied on this cut, so `policy.authority === "display-only"`. This card
// shows that plainly instead of letting a confident-looking verdict imply it gated the deposit.
// The deposit gate remains the vault inspection + acknowledgement, untouched.

const CHECK_MARK = "✓";

/** ⭐⭐ THE TWO "COVERAGE" NUMBERS ARE DIFFERENT MEASUREMENTS AND MUST NEVER SHARE A LABEL.
 *
 *  · `policy.coverage`          → 9 of 9 POWER GROUPS. This is what `coverageThreshold` applies to.
 *  · `report.coverage.totals`   → 13 CHECKS RUN — the nine power groups PLUS shape detection and the
 *                                 owner reads.
 *
 *  Both are correct, both arrive in one response, and both are called "coverage" by their own
 *  schema. Rendering them near each other under one word would make the threshold look like it
 *  applies to the larger number, which would understate how much of the catalogue was actually
 *  required. So each is labelled at the point of display — never in a legend somewhere else, which
 *  is a second place to read and therefore a second place to not read.
 */
function CoverageRow({ policy, report }: { policy: any; report: any }) {
  const pc = policy?.coverage ?? {};
  const rt = report?.coverage?.totals ?? {};
  const ran = (rt.checked ?? 0) + (rt.notChecked ?? 0);
  return (
    <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr", marginTop: 12 }}>
      <div style={{ padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 8 }}>
        <div style={{ fontSize: ".72rem", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)" }}>
          Power groups checked
        </div>
        <div className="mono" style={{ fontSize: "1.05rem", marginTop: 4 }}>
          {pc.checked ?? "—"} of {pc.total ?? "—"}
        </div>
        <div style={{ fontSize: ".8rem", color: "var(--muted)", marginTop: 4 }}>
          {pc.threshold === null || pc.threshold === undefined
            ? "No threshold set in your rules."
            : <>Your threshold is <span className="mono">{pc.threshold}</span> — {pc.meets ? "met." : "NOT met."}</>}
        </div>
      </div>
      <div style={{ padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 8 }}>
        <div style={{ fontSize: ".72rem", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)" }}>
          Individual checks run
        </div>
        <div className="mono" style={{ fontSize: "1.05rem", marginTop: 4 }}>
          {rt.checked ?? "—"} of {ran || "—"}
        </div>
        <div style={{ fontSize: ".8rem", color: "var(--muted)", marginTop: 4 }}>
          The power groups plus shape detection and the owner reads.{" "}
          <b>Your threshold does not apply to this number.</b>
        </div>
      </div>
    </div>
  );
}

/**
 * ⭐ THE RESULT, AS A PURE COMPONENT. Exported so it can be RENDERED in a test rather than grepped —
 * every claim this card makes (which number the threshold applies to, that a pass never says "safe",
 * that the two failure buckets stay apart) is a claim about what a human READS, and source regexes
 * have already cost this repo four false alarms in a money panel.
 *
 * ⚠️ SPLIT THIS WAY DELIBERATELY, rather than giving the card a test-only `initialData` prop: a seam
 * that exists only for tests is a seam nobody exercises in production. This one is the real render
 * path — the card below has no other way to draw a result.
 */
export function DdReportResult({ data }: { data: any }) {
  const [raw, setRaw] = useState(false);
  const report = data?.report ?? null;
  const pol = data?.policy ?? null;
  // A refusal arrives as a REPORT with a populated `refusal`, at either level of the envelope.
  const refusal = data?.refusal ?? report?.refusal ?? null;
  const powersPresent: string[] = report?.powersPresent ?? [];
  const failures: any[] = pol?.failures ?? [];
  const unreadable: any[] = pol?.unreadableFailures ?? [];
  const split = report?.sources?.integrity?.providerDisagreement === true;

  return (
    <>
      {/* ⚠️ A REFUSAL IS A RESULT, NOT AN ERROR — rendered as one, with its reason, never as a
          silent empty state. An empty card would be the absence-reads-as-safe failure this whole
          subsystem exists to prevent. */}
      {refusal && (
        <div style={{ marginTop: 12, padding: "10px 12px", border: "1px solid var(--warn)", borderRadius: 8 }}>
          <div style={{ fontWeight: 600 }}>No result — this is INDETERMINATE, not a clean bill.</div>
          <div style={{ marginTop: 6, fontSize: ".86rem" }}>
            <span className="mono">{refusal.reason}</span> — {refusal.detail}
          </div>
        </div>
      )}

      {pol && !refusal && (
        <>
          {/* ── the verdict ─────────────────────────────────────────────────────────────────── */}
          <div
            style={{
              marginTop: 14,
              padding: "12px 14px",
              borderRadius: 8,
              border: `1px solid ${pol.passes ? "var(--line-strong)" : "var(--warn)"}`,
              background: pol.passes ? "transparent" : "var(--amber-soft)",
            }}
          >
            <div style={{ fontWeight: 600 }}>
              {pol.passes
                ? `${CHECK_MARK} Nothing was found against your rules`
                : "Your rules were not satisfied"}
            </div>
            {pol.reason && (
              <div style={{ marginTop: 4, fontSize: ".84rem", color: "var(--muted)" }}>
                <span className="mono">{pol.reason}</span>
              </div>
            )}
            <div style={{ marginTop: 6, fontSize: ".86rem" }}>{pol.detail}</div>
          </div>

          {/* ── ⭐ THE TWO BUCKETS STAY SEPARATE ──────────────────────────────────────────────
              "this vault is upgradeable" and "we could not establish whether it is" are DIFFERENT
              findings. Merging them into one list would let this card state the first when only the
              second is true — and would make an override of an unknown look identical to an
              override of a known power. */}
          {failures.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: ".78rem", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)" }}>
                Powers you refuse, and this contract has
              </div>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {failures.map((f) => (
                  <li key={f.group} style={{ marginTop: 4 }}>
                    <span className="mono">{f.group}</span>
                    {f.scope ? <span style={{ color: "var(--muted)" }}> · {f.scope}</span> : null}
                    <div style={{ fontSize: ".84rem", color: "var(--paper-dim)" }}>{f.detail}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {unreadable.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: ".78rem", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--warn)" }}>
                Powers you refuse that could NOT be established
              </div>
              <div style={{ fontSize: ".84rem", color: "var(--paper-dim)", marginTop: 4 }}>
                Not established is <b>not</b> absent. These are unknowns, not clean results.
              </div>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {unreadable.map((f) => (
                  <li key={f.group} style={{ marginTop: 4 }}>
                    <span className="mono">{f.group}</span>
                    <div style={{ fontSize: ".84rem", color: "var(--paper-dim)" }}>{f.detail}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <CoverageRow policy={pol} report={report} />

          {/* ── what the chain actually said, independent of anyone's rules ─────────────────── */}
          <div style={{ marginTop: 12, fontSize: ".86rem" }}>
            <span style={{ color: "var(--muted)" }}>Owner powers found: </span>
            {powersPresent.length === 0 ? (
              <span>none of the nine catalogue groups had a matching selector</span>
            ) : (
              powersPresent.map((p) => (
                <span key={p} className="mono" style={{ marginRight: 8 }}>{p}</span>
              ))
            )}
          </div>

          {/* 🚨 A POSITIVE FINDING ABOUT THE PROVIDERS, not an ordinary read failure. It bears on
              EVERY check in the report, not just the slot that split. */}
          {split && (
            <div style={{ marginTop: 12, padding: "10px 12px", border: "1px solid var(--warn)", borderRadius: 8 }}>
              <b>⚠️ The data sources disagreed.</b> Two independent endpoints returned different values
              for the same call at the same block, so at least one served something false. Treat every
              line above as unproven until that is resolved.
            </div>
          )}

          {/* ── 🚨 THE CEILING, VERBATIM ────────────────────────────────────────────────────── */}
          <div
            style={{
              marginTop: 14,
              paddingTop: 12,
              borderTop: "1px solid var(--line)",
              fontSize: ".8rem",
              color: "var(--muted)",
            }}
          >
            <div>{pol.ceiling}</div>
            {pol.authority === "display-only" && (
              <div style={{ marginTop: 8 }}>
                <b>This verdict does not gate anything.</b> It reflects rules supplied by this browser,
                not rules stored against your account, so it is shown for your judgement only. The
                deposit is still gated by the vault disclosure and your acknowledgement below.
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              Attestation: <span className="mono">{data?.verifiability?.attestation ?? report?.attestation?.status ?? "—"}</span>
              {" · "}
              sources: <span className="mono">{report?.sources?.mode ?? "—"}</span>
              {report?.sources?.quorum
                ? ` (${report.sources.quorum.required} of ${report.sources.quorum.configured})`
                : ""}
              {" · "}block <span className="mono">{report?.subject?.blockNumber ?? "—"}</span>
            </div>
            <button className="linkbtn" style={{ marginTop: 8 }} onClick={() => setRaw((v) => !v)}>
              {raw ? "Hide" : "Show"} the full signed report
            </button>
          </div>

          {/* ⭐ THE WHOLE ARTIFACT, not a summary — the thing a buyer could verify independently. */}
          {raw && (
            <pre
              style={{
                marginTop: 10, maxHeight: 320, overflow: "auto", fontSize: ".72rem",
                background: "var(--field)", border: "1px solid var(--line)", borderRadius: 8, padding: 10,
              }}
            >
              {JSON.stringify(data, null, 2)}
            </pre>
          )}
        </>
      )}
    </>
  );
}

export default function DdReportCard({
  wallet: w,
  address,
  label,
}: {
  wallet: UnifiedWallet;
  address: string;
  label?: string;
}) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  // ⚠️ THE RULES ARE THE USER'S, AND THERE IS NO STORE YET. This default is a STARTING POINT shown
  // in the UI, not a policy anybody set — which is exactly why the server refuses to treat an
  // absent policy as a pass. Once `agent-policy` exists this comes from the owner's record.
  const [refuseUpgradeable, setRefuseUpgradeable] = useState(true);
  const [refuseEmergency, setRefuseEmergency] = useState(true);
  const [refuseFees, setRefuseFees] = useState(false);

  const policy = {
    rules: {
      ...(refuseUpgradeable ? { upgradeable: "refuse" } : {}),
      ...(refuseEmergency ? { emergencyWithdraw: "refuse" } : {}),
      ...(refuseFees ? { feesSettable: "refuse" } : {}),
    },
    coverageThreshold: 9,
  };
  // ⚠️ AN EMPTY RULE SET IS NOT A POLICY. The server refuses `{}` as malformed rather than passing
  // it vacuously, so sending one would render a refusal that looks like our bug. Send null instead
  // and let the honest `no-policy` state show — which is the correct description of "you have
  // unticked everything".
  const hasRules = Object.keys(policy.rules).length > 0;

  async function run() {
    setLoading(true);
    setErr("");
    try {
      const d = await w.ddReport(address, hasRules ? policy : undefined);
      setData(d);
    } catch (e: any) {
      setErr(e?.message || "Could not load the report");
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="status"
      style={{ marginTop: 16, marginBottom: 16, padding: "14px 16px", border: "1px solid var(--line-strong)", borderRadius: 10 }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 600 }}>Due diligence{label ? ` — ${label}` : ""}</div>
          <div style={{ fontSize: ".82rem", color: "var(--muted)", marginTop: 2 }}>
            The same signed report this service sells to outside callers, checked against your rules.
          </div>
        </div>
        <button className="linkbtn" onClick={run} disabled={loading || !w.isAuthenticated}>
          {loading ? "Reading the chain…" : data ? "Re-check" : "Run the check"}
        </button>
      </div>

      {/* Your rules. Plain checkboxes — the point is that the user can see WHAT is being asked. */}
      <div style={{ marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap", fontSize: ".86rem" }}>
        {([
          ["Refuse upgradeable", refuseUpgradeable, setRefuseUpgradeable],
          ["Refuse emergency withdraw", refuseEmergency, setRefuseEmergency],
          ["Refuse settable fees", refuseFees, setRefuseFees],
        ] as const).map(([lbl, val, set]) => (
          <label key={lbl} style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={val} onChange={(e) => set(e.target.checked)} />
            {lbl}
          </label>
        ))}
      </div>
      {!hasRules && (
        <div style={{ marginTop: 8, fontSize: ".82rem", color: "var(--muted)" }}>
          No rules ticked — the check will report that <b>nothing was evaluated</b>. That is not a pass.
        </div>
      )}

      {err && (
        <div style={{ marginTop: 12, padding: "10px 12px", border: "1px solid var(--warn)", borderRadius: 8 }}>
          {err}
        </div>
      )}

      {data && <DdReportResult data={data} />}
    </div>
  );
}
