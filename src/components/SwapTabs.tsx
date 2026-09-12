import { DCA_CREATE_GATED } from "../../shared/dca-gate.mjs";

// SwapTabs — wayfinding across the THREE swap surfaces. ⛔ Tabs, but NAVIGATION, not a segmented
// toggle: each is a real link to its own page (#/swap, #/swap-manual, #/dca). An in-place toggle
// would imply one surface with modes; these are different products (agent-signed indicative floor /
// self-signed binding floor / recurring per-fill minimum), so they stay separate pages and the strip
// only helps you move between them. Labels name WHO signs and WHEN — never Market/Limit/DCA, which
// would say they are order types on one book. See docs / the swap-surface audit.
//
// ⭐ THE RECURRING PILL READS THE GATE BEFORE THE CLICK. DCA creation can be paused server-side
// (DCA_CREATE_GATED, the SAME constant dca-create enforces and the DcaPanel notice shows), so a tab
// leading to a paused surface says so in the strip rather than after the click. `dcaPaused` defaults
// to that constant; it is a prop ONLY so the static preview can show the paused variant.

type SwapRoute = "agent" | "manual" | "recurring";

const TABS: { key: SwapRoute; hash: string; label: string }[] = [
  { key: "agent", hash: "#/swap", label: "Agent swap" },
  { key: "manual", hash: "#/swap-manual", label: "Sign it yourself" },
  { key: "recurring", hash: "#/dca", label: "Recurring" },
];

export default function SwapTabs({
  active,
  dcaPaused = DCA_CREATE_GATED,
}: {
  active: SwapRoute;
  dcaPaused?: boolean;
}) {
  return (
    <nav className="swap-tabs" aria-label="Swap surfaces">
      {TABS.map((t) => {
        const isActive = t.key === active;
        const paused = t.key === "recurring" && dcaPaused;
        return (
          <a
            key={t.key}
            href={t.hash}
            className={`swap-tab${isActive ? " active" : ""}`}
            aria-current={isActive ? "page" : undefined}
            // ⛔ The pill is a fact the reader needs BEFORE clicking; on a paused tab it is not
            // disabled — you must still reach the page to view or cancel an existing schedule.
            title={paused ? "New schedules are paused — existing schedules still run and can be cancelled" : undefined}
          >
            {t.label}
            {paused && <span className="swap-tab-pill">paused</span>}
          </a>
        );
      })}
    </nav>
  );
}
