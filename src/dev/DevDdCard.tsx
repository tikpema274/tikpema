// DevDdCard.tsx — DEV-ONLY page at #/dev/dd-card. Renders DdReportResult side by side with two canned
// reports (no network, no wallet): the power-surface-unrecognised NO-VERDICT state and a recognised
// verdict for comparison. Reached only through the import.meta.env.DEV gate in App.tsx, so it and its
// fixture are excluded from the production build.
import { DdReportResult } from "../components/DdReportCard";
import { noVerdictData, xyloVerdictData, DEV_FIXTURE_MARKER } from "./dd-card-fixtures";

export default function DevDdCard() {
  return (
    <div style={{ padding: 24, maxWidth: 1040, margin: "0 auto", font: "14px system-ui, sans-serif" }}>
      <h2 style={{ margin: "0 0 4px" }}>DEV — DD card states (canned fixtures, no network)</h2>
      <p className="mono" style={{ color: "var(--muted)", fontSize: ".78rem", margin: "0 0 20px" }}>
        route #/dev/dd-card · fixture {DEV_FIXTURE_MARKER}
      </p>
      <div style={{ display: "grid", gap: 28, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <section>
          <h3 style={{ fontSize: ".95rem" }}>① NO-VERDICT — power-surface-unrecognised</h3>
          <DdReportResult data={noVerdictData} />
        </section>
        <section>
          <h3 style={{ fontSize: ".95rem" }}>② Recognised vault — normal verdict (compare)</h3>
          <DdReportResult data={xyloVerdictData} />
        </section>
      </div>
    </div>
  );
}
