// preview-panel.tsx — a STATIC render of #/bridge, openable in a browser without a session.
//
//   npx tsx scripts/preview-panel.tsx && open preview-bridge.html
//
// ⛔ WHAT THIS IS NOT. It is not the app. `npm run dev` is `netlify dev`, which has never worked in
// this project, and even a working dev server would not help here: BridgePanel gates on
// `!w.agentWallet`, so without a passkey session it renders the "set up your wallet first" state,
// never the form. This bypasses both by rendering the components directly with a mock wallet.
//
// ⭐ IT RENDERS BOTH STATES, which is the whole point. `renderToStaticMarkup` emits only the INITIAL
// state, so the summary block — the thing being judged — is invisible inside the panel. It is now
// its own component and is rendered here with real figures beside the default panel.
//
// ⚠️ WHAT IT CANNOT SHOW: hover, focus rings, the amber focus ring on the amount field, layout
// reflow, and any state behind an interaction (the acknowledge band, the burn confirmation). It
// answers "does the hierarchy read" and nothing else.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, writeFileSync } from "node:fs";
import BridgePanel from "../src/components/BridgePanel";
import { BridgeQuoteSummary } from "../src/components/BridgeQuoteSummary";
import { FeeDisclosureBox } from "../src/components/ManualBridgePanel";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const fonts = readFileSync(new URL("../index.html", import.meta.url), "utf8")
  .match(/<link[^>]*fonts\.googleapis[^>]*>/)?.[0] ?? "";

const wallet = {
  agentWallet: { address: "0x8a3f000000000000000000000000000000000c21", balance: "340.00" },
  address: "0x8a3f000000000000000000000000000000000c21",
  activeKind: "passkey", metamaskConnected: false, busy: false,
  listBridgeReceipts: async () => ({ receipts: [], degraded: false }),
  bridgeFromAgent: async () => ({}), checkBridgeStatus: async () => ({}),
} as any;

// ⭐ REAL FIGURES from the live 1 USDC → Base bridge, so the rows are judged at the widths they
// actually render at rather than at tidy round numbers.
const quote = {
  amountUsdc: 1, destination: { key: "base", label: "Base (Sepolia)" },
  feeUsdc: 0.054071, netUsdc: 0.945929, band: "none", feeRatio: 0.054071,
};

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>#/bridge — static preview</title>${fonts}
<style>${css}
  .pv-label{font-family:"Space Mono",monospace;font-size:11px;letter-spacing:.12em;
    text-transform:uppercase;color:var(--muted);margin:34px 0 10px}
  .pv-note{color:var(--muted);font-size:12px;max-width:60ch;line-height:1.6;margin-bottom:8px}
</style></head><body><div class="app">
  <div class="pv-label">1 — the panel as it first renders (no quote yet)</div>
  <div class="pv-note">Zone 1 state, the form, the unconditional hazard row, and zone 3 below.
    This is what a user sees before pressing Get quote.</div>
  ${renderToStaticMarkup(<BridgePanel wallet={wallet} />)}

  <div class="pv-label">2 — summary: no destination chosen yet</div>
  <div class="pv-note">All four rows present. Route is an em-dash because nothing has been chosen;
    Settlement is known regardless.</div>
  <div class="plane">${renderToStaticMarkup(<BridgeQuoteSummary quote={null} />)}</div>

  <div class="pv-label">3 — summary: destination chosen, not yet quoted</div>
  <div class="pv-note">Two real values, two em-dashes. The held-quote promise is correctly ABSENT —
    it would be asserting a binding on a figure that does not exist.</div>
  <div class="plane">${renderToStaticMarkup(
    <BridgeQuoteSummary quote={null} destinationLabel="Base (Sepolia)" />)}</div>

  <div class="pv-label">4 — summary: quoted (real figures from the live bridge)</div>
  <div class="pv-note">All four filled, and the held-quote promise now appears beside its figure.</div>
  <div class="plane">${renderToStaticMarkup(
    <BridgeQuoteSummary quote={quote} destinationLabel="Base (Sepolia)" />)}</div>

  <div class="pv-label">5 — the acknowledge band (≥25% to fees)</div>
  <div class="pv-note">Unchanged by this pass — thresholds and wording are as they were. Shown so
    the heaviest state on the panel can be judged beside the lightest.</div>
  <div class="plane">${renderToStaticMarkup(<FeeDisclosureBox
    disclosure={{ band: "acknowledge", feeRatio: 0.532, feeUsdc: 0.0532, netUsdc: 0.0468,
      amountUsdc: 0.1, destinationLabel: "Base (Sepolia)", ackToken: "x" } as any}
    busy={false} onAccept={() => {}} />)}</div>
</div></body></html>`;

writeFileSync("preview-bridge.html", html);
console.log(`\n  wrote preview-bridge.html  (${(html.length / 1024).toFixed(1)} KB)`);
console.log(`  open it directly in a browser — no server, no session.\n`);
