// preview-agent.tsx — a STATIC render of #/agent, openable in a browser without a session.
//
//   npx tsx scripts/preview-agent.tsx  →  preview-agent.html
//
// ⛔ NOT THE APP. `netlify dev` has never worked here, and the panel needs a session to reach the
// funded state. Rendered directly with a mock wallet, exactly as verify-agent-panel-copy does.
// ⚠️ CANNOT SHOW: hover, focus, reflow, or anything behind an interaction (a task in flight, the
// per-step fee disclosure, the confirm gate). It answers "does the hierarchy read" and nothing else.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, writeFileSync } from "node:fs";
import MyAgentPanel from "../src/components/MyAgentPanel";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const fonts = readFileSync(new URL("../index.html", import.meta.url), "utf8")
  .match(/<link[^>]*fonts\.googleapis[^>]*>/)?.[0] ?? "";

const mk = (balance: string | null) => {
  const w: any = {
    agentWallet: { address: "0x3cb7000000000000000000000000000000002de9", balance },
    address: "0x" + "cd".repeat(20), usdcBalance: "12.3456", busy: false, isAuthenticated: true,
    ensureSession: async () => "t", fundAgentWallet: async () => {}, refreshAgentWallet: async () => {},
    refreshBalance: async () => {}, act: async () => ({}),
    listBridgeReceipts: async () => ({ receipts: [], degraded: false }),
  };
  return renderToStaticMarkup(<MyAgentPanel wallet={w} />);
};

const label = (t: string, note: string) =>
  `<div style="max-width:820px;margin:28px auto 8px;font:600 12px/1.4 Inter,system-ui;
     letter-spacing:.08em;text-transform:uppercase;color:#8b90a8">${t}</div>
   <div style="max-width:820px;margin:0 auto 12px;font:400 13px/1.5 Inter,system-ui;color:#6b7089">${note}</div>`;

writeFileSync(new URL("../preview-agent.html", import.meta.url),
`<!doctype html><html><head><meta charset="utf-8"><title>AI Agent — static preview</title>${fonts}
<style>${css} body{padding:24px} .plane{max-width:820px;margin:0 auto}</style></head><body>
${label("1 · Funded agent", "The ordinary state: state &rarr; action &rarr; shortcuts &rarr; explanation.")}
${mk("4.50")}
<hr style="max-width:820px;margin:40px auto;border:0;border-top:1px solid rgba(255,255,255,.08)">
${label("2 · Empty agent", "A zero balance is said out loud &mdash; hiding it is what built the old dead end.")}
${mk("0")}
</body></html>`);
console.log("wrote preview-agent.html");
