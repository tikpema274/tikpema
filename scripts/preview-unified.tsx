// preview-unified.tsx — a STATIC render of #/unified, openable in a browser without a session.
//
//   npx tsx --experimental-test-module-mocks scripts/preview-unified.tsx
//   then open  preview-unified.html
//
// ⛔ WHAT THIS IS NOT. It is not the app. `netlify dev` has never worked in this project, and even
// a working dev server would not reach this state: the panel gates on a session and on parked
// funds, so without a passkey it renders "sign in", never the disclosure being judged.
//
// ⭐ IT RENDERS THE STATE THAT CARRIES THE COPY — `useGatewayBalance` is mocked with parked funds,
// because SSR does not run effects and the real hook would sit at `loading` forever.
//
// ⚠️ WHAT IT CANNOT SHOW: hover, focus rings, layout reflow, and anything behind an interaction.
// ⛔⛔ INCLUDING THE COLLAPSED EVIDENCE: renderToStaticMarkup emits only the INITIAL state, so the
// "about seven days" region is present in the DOM but `hidden` — exactly as a first-time reader
// sees it. It is rendered a SECOND time below, forced open, so the hidden content can be judged
// too. A preview that showed only the collapsed state would be judging half the design.

import { mock } from "node:test";
let gateway: any = {
  status: "ready",
  total: "7.5000",
  perChain: [{ chain: "Arc Testnet", ok: true, usdc: "7.5000" }],
  depositor: "0x" + "ab".repeat(20),
};
mock.module("../src/lib/useGatewayBalance", { namedExports: { useGatewayBalance: () => gateway } });

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, writeFileSync } from "node:fs";

const UnifiedBalancePanel = (await import("../src/components/UnifiedBalancePanel")).default;

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const fonts = readFileSync(new URL("../index.html", import.meta.url), "utf8")
  .match(/<link[^>]*fonts\.googleapis[^>]*>/)?.[0] ?? "";

const wallet: any = {
  agentWallet: { address: "0x" + "ab".repeat(20), balance: "12.3456" },
  address: "0x" + "cd".repeat(20),
  usdcBalance: "12.3456",
  busy: false,
  isAuthenticated: true,
  ensureSession: async () => "t",
  fundAgentWallet: async () => {},
  refreshAgentWallet: async () => {},
  refreshBalance: async () => {},
};

const panel = renderToStaticMarkup(<UnifiedBalancePanel wallet={wallet} />);

// ⭐⭐ THE WITHDRAW SECTION, RENDERED FOR REAL. UbExitStatus loads in a useEffect that SSR never
// runs, so inside the panel above it shows only "Checking your exit…" — which made the section look
// BARE and nearly caused a restructure of copy that was already there. It takes an `initial` prop
// for exactly this reason (see verify-ub-exit-view). Rendered separately so the heading, the
// pre-press disclosure and the button can actually be judged.
const UbExitStatus = (await import("../src/components/UbExitStatus")).default;
const exitHtml = renderToStaticMarkup(
  <UbExitStatus
    token={async () => "t"}
    initial={{ data: {
      owner: "0x" + "ab".repeat(20),
      balance: { readable: true, availableUsdc: "7.5000", withdrawableUsdc: "0" },
      withdrawals: [],
      disclosure: { approxDelayDays: 7.1, delayBlocks: "1209600", delayProvenance: "withdrawalDelay() on GatewayWallet" },
    } }}
  />
);
// ⭐ The same markup with the disclosure forced open — `hidden` is the ONLY difference, so the
//    second copy shows exactly what a press reveals and nothing else.
const opened = panel.replace(/ hidden=""/g, "");

const label = (t: string, note: string) =>
  `<div style="max-width:820px;margin:28px auto 8px;font:600 12px/1.4 Inter,system-ui;
     letter-spacing:.08em;text-transform:uppercase;color:#8b90a8">${t}</div>
   <div style="max-width:820px;margin:0 auto 12px;font:400 13px/1.5 Inter,system-ui;color:#6b7089">${note}</div>`;

writeFileSync(
  new URL("../preview-unified.html", import.meta.url),
  `<!doctype html><html><head><meta charset="utf-8">
<title>Unified Balance — static preview</title>${fonts}
<style>${css}
  body{padding:24px}
  .plane{max-width:820px;margin:0 auto}
</style></head><body>
${label("1 · As a first-time reader sees it", "Collapsed by default. The evidence sits behind the &ldquo;about seven days&rdquo; control in the deposit card.")}
${panel}
<hr style="max-width:820px;margin:40px auto;border:0;border-top:1px solid rgba(255,255,255,.08)">
<hr style="max-width:820px;margin:40px auto;border:0;border-top:1px solid rgba(255,255,255,.08)">
${label("1b · The withdraw section, loaded", "Inside the page above it can only say &ldquo;Checking your exit&hellip;&rdquo; &mdash; SSR runs no effects. This is what it really renders: heading, amount, pre-press disclosure, and the button.")}
<div class="plane">${exitHtml}</div>
${label("2 · The same page with the disclosure opened", "Identical markup, <code>hidden</code> removed — this is exactly what pressing &ldquo;about seven days&rdquo; reveals.")}
${opened}
</body></html>`
);
console.log("wrote preview-unified.html");
console.log("  order:", ["Unified balance", "across chains", "committed to your agent", "Move USDC from", "How this works"]
  .map((s) => `${s}@${renderToStaticMarkup(<UnifiedBalancePanel wallet={wallet} />).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").indexOf(s)}`)
  .join("  →  "));
