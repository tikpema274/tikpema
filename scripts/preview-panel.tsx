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
  <div class="pv-label">1 — empty: nothing entered yet</div>
  <div class="pv-note">The panel as it first renders. FROM is a greyed, unchangeable select — the
    constraint is visible as a constraint. Settlement and Route are already filled: both are
    knowable before any quote, so the user learns what they will be told before asking.</div>
  ${renderToStaticMarkup(<BridgePanel wallet={wallet} />)}

  <div class="pv-label">2 — amount entered, not yet quoted</div>
  <div class="pv-note">Fee and You receive are still em-dashes. The held-quote promise is correctly
    ABSENT — it asserts a binding on a figure, and there is no figure yet.</div>
  <div class="plane">${renderToStaticMarkup(
    <BridgeQuoteSummary quote={null} destinationLabel="Base (Sepolia)" />)}</div>

  <div class="pv-label">3 — quoted (real figures from the live bridge)</div>
  <div class="pv-note">⭐ The state change is visible in the ROWS, not only the button label:
    em-dashes became values. That is the argument for always-present rows.</div>
  <div class="plane">${renderToStaticMarkup(
    <BridgeQuoteSummary quote={quote} destinationLabel="Base (Sepolia)" />)}</div>

  <div class="pv-label">4 — executing: the burn is in flight</div>
  <div class="pv-note">The summary keeps its values while bridging — the user can still see what
    they accepted. It is removed only once the confirmation supersedes it, rather than blanked to
    em-dashes above a confirmation carrying the real numbers.</div>
  <div class="plane">${renderToStaticMarkup(
    <BridgeQuoteSummary quote={quote} destinationLabel="Base (Sepolia)" />)}
    <button class="emerald btn-wide" disabled>Bridging…</button></div>

  <div class="pv-label">5 — the acknowledge band (≥25% to fees)</div>
  <div class="pv-note">Unchanged by this pass. Shown so the heaviest state can be judged beside the
    lightest.</div>
  <div class="plane">${renderToStaticMarkup(<FeeDisclosureBox
    disclosure={{ band: "acknowledge", feeRatio: 0.532, feeUsdc: 0.0532, netUsdc: 0.0468,
      amountUsdc: 0.1, destinationLabel: "Base (Sepolia)", ackToken: "x" } as any}
    busy={false} onAccept={() => {}} />)}</div>
</div></body></html>`;

writeFileSync("preview-bridge.html", html);
console.log(`\n  wrote preview-bridge.html  (${(html.length / 1024).toFixed(1)} KB)`);
console.log(`  open it directly in a browser — no server, no session.\n`);
