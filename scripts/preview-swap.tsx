// preview-swap.tsx — a STATIC render of the THREE swap surfaces + the tab strip, openable in a
// browser without a session. The pre-deploy human gate for the face-lift. NOTHING ships on a suite
// alone.
//
//   npx tsx scripts/preview-swap.tsx && open preview-swap.html
//
// ⛔ SAME LOOP AS preview-panel.tsx, KEPT THAT WAY: it imports the REAL components with mock props
// and inlines the REAL src/styles.css, so nothing is reproduced and it cannot drift from what ships.
//
// ⭐ RENDERED AT 380px AS WELL AS DESKTOP — via an <iframe>, not a 380px <div>. styles.css reflows
// through @media (max-width: 440/520/560…), which key on the VIEWPORT; a narrow container would wrap
// flex rows but NEVER fire those rules. An iframe establishes its own viewport, so at width=380 the
// media queries actually evaluate and the mobile stacking is SEEN, not asserted from CSS presence.
//
// ⚠️ renderToStaticMarkup emits only a component's INITIAL state, so states behind a fetch or an
// interaction (amount entered, quote loaded, expired, unreliable, the DCA pause notice) are rendered
// through the EXPORTED sub-components with crafted props — the same reason SwapReview/BridgeQuoteSummary
// are exported.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, writeFileSync } from "node:fs";
import SwapTabs from "../src/components/SwapTabs";
import SwapPanel, { AgentSwapSummary } from "../src/components/SwapPanel";
import { SwapReview } from "../src/components/ManualSwapPanel";
import { DcaCreatePausedNotice } from "../src/components/DcaPanel";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const fonts = readFileSync(new URL("../index.html", import.meta.url), "utf8")
  .match(/<link[^>]*fonts\.googleapis[^>]*>/)?.[0] ?? "";

const OWNER = "0x8a3f000000000000000000000000000000000c21";
const agentWallet = {
  agentWallet: { address: OWNER, balance: "340.00", eurcBalance: "12.50" },
  address: OWNER, activeKind: "passkey", metamaskConnected: false, busy: false,
  swapFromAgent: async () => ({}),
} as any;

// A decoded swap (read from calldata, not the quote), band `none`: guaranteed floor is the headline.
const decoded = { beneficiary: OWNER, minTokenOut: 989_000n } as any; // 0.989000 EURC floor

const M = (node: React.ReactNode) => renderToStaticMarkup(node as React.ReactElement);

// ── 380px = its own viewport, via an iframe carrying the SAME inlined CSS ────────────────────────
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
function bothWidths(markup: string, tall = 760) {
  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">${fonts}<style>${css}
  body{margin:0}</style></head><body><div class="app" style="padding:12px">${markup}</div></body></html>`;
  return `<div class="pv-both">
    <div class="pv-col"><div class="pv-w">desktop</div><div class="app pv-desk">${markup}</div></div>
    <div class="pv-col"><div class="pv-w">mobile · 380px (real viewport)</div>
      <iframe class="pv-mob" width="380" height="${tall}" srcdoc="${esc(doc)}"></iframe></div>
  </div>`;
}
const label = (n: number, t: string, note: string) =>
  `<div class="pv-label">${n} — ${t}</div><div class="pv-note">${note}</div>`;

const sections = [
  label("1", "Agent swap · empty form",
    "Tab strip: <b>Agent swap</b> active, Recurring pill shows <b>paused</b>. The form as it first renders — no summary block yet, because there is no amount to describe.")
  + bothWidths(M(<><SwapTabs active="agent" dcaPaused /><SwapPanel wallet={agentWallet} /></>), 900),

  label("2", "Agent swap · amount entered — the indicative-floor row",
    "The summary block appears. ⛔ No rate/impact/fee NUMBERS (no quote exists on this path); the rows state the MECHANIC. The <b>Minimum out</b> row is the producer-bound floor sentence: Circle's minimum, set at execution, no percentage.")
  + bothWidths(M(<><SwapTabs active="agent" dcaPaused /><div className="plane"><AgentSwapSummary amount={25} tokenIn="USDC" tokenOut="EURC" /><button className="emerald btn-wide">Swap 25 USDC</button></div></>)),

  label("3", "Sign it yourself · pre-quote (rows ABSENT)",
    "Tab: <b>Sign it yourself</b> active. Before a quote, SwapReview is not rendered — there are no derived figures on screen. This is the reference-UI defect we do NOT reproduce (no Impact/Fee stated before a quote).")
  + bothWidths(M(<><SwapTabs active="manual" dcaPaused /><div className="plane"><div className="panel-eyebrow">Swap · your own wallet</div><h2>Swap from your own wallet</h2><div className="sub">Get a quote to see the guaranteed minimum before you sign.</div><button className="emerald btn-wide">Get quote</button></div></>), 520),

  label("4", "Sign it yourself · quoted — BINDING floor is the headline",
    "SwapReview with a live quote. <b>Guaranteed at least</b> is the headline (read from the decoded tx, not the quote) — a binding minimum, not indicative. Beneficiary shown in full.")
  + bothWidths(M(<><SwapTabs active="manual" dcaPaused /><div className="plane"><SwapReview decoded={decoded} owner={OWNER} tokenIn="USDC" tokenOut="EURC" amountIn={1} band="none" impliedLoss={0.011} secondsLeft={42} /><button className="emerald btn-wide">Sign & swap</button></div></>)),

  label("5", "Sign it yourself · quote EXPIRED",
    "secondsLeft = 0. The countdown reads expired; the sign action would be disabled (shown greyed).")
  + bothWidths(M(<><SwapTabs active="manual" dcaPaused /><div className="plane"><SwapReview decoded={decoded} owner={OWNER} tokenIn="USDC" tokenOut="EURC" amountIn={1} band="none" impliedLoss={0.011} secondsLeft={0} /><button className="emerald btn-wide" disabled>Quote expired — refresh</button></div></>)),

  label("6", "Sign it yourself · rateCheckUnreliable warning present",
    "The bordered advisory fires when the reference rate and the pool disagree. ⛔ It is an advisory, not a gate, and it says the CHECK is unreliable — never that the deal is good.")
  + bothWidths(M(<><SwapTabs active="manual" dcaPaused /><div className="plane"><SwapReview decoded={decoded} owner={OWNER} tokenIn="EURC" tokenOut="USDC" amountIn={1} band="none" impliedLoss={-0.13} secondsLeft={42} rateCheckUnreliable /><button className="emerald btn-wide">Sign & swap</button></div></>)),

  label("7", "Recurring · the paused state — pill and page notice must AGREE",
    "Tab: <b>Recurring</b> active with the <b>paused</b> pill; the page notice below says the same thing. Both trace to DCA_CREATE_GATED, so they cannot disagree. (Live today the gate is FALSE, so neither shows; this is the paused variant, forced for review.)")
  + bothWidths(M(<><SwapTabs active="recurring" dcaPaused /><div className="plane"><div className="panel-eyebrow">Recurring swap · DCA</div><h2>Swap on a schedule, while you're away.</h2><DcaCreatePausedNotice /></div></>), 560),
];

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>swap surfaces — static preview</title>${fonts}
<style>${css}
  body{padding:24px;background:var(--ink-2)}
  .pv-label{font-family:"Space Mono",monospace;font-size:12px;letter-spacing:.1em;text-transform:uppercase;
    color:var(--amber-hi);margin:40px 0 6px}
  .pv-note{color:var(--muted);font-size:12px;max-width:70ch;line-height:1.6;margin-bottom:12px}
  .pv-both{display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap}
  .pv-col{flex:0 0 auto}
  .pv-w{font-family:"Space Mono",monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;
    color:var(--muted);margin-bottom:6px}
  .pv-desk{width:560px;max-width:560px;margin:0}
  .pv-mob{border:1px solid var(--line-strong);border-radius:12px;background:var(--ink)}
</style></head><body>
  <div class="pv-label" style="color:var(--paper);font-size:15px">Swap surfaces — face-lift preview</div>
  <div class="pv-note">Real components, real styles.css, mock props. Each state at desktop and at a
    genuine 380px viewport (iframe). Judge hierarchy, the floor claims, and the paused pill/notice agreement.</div>
  ${sections.join("\n")}
</body></html>`;

writeFileSync("preview-swap.html", html);
console.log(`\n  wrote preview-swap.html  (${(html.length / 1024).toFixed(1)} KB)`);
console.log(`  open it directly in a browser — no server, no session.\n`);
