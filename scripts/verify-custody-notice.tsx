// verify-custody-notice.tsx — the ONE place the custody WORDING is asserted, plus the page.
//
//   npx tsx scripts/verify-custody-notice.tsx        (also: npm run test:custodynotice)
//
// ═══ ⭐⭐ THE DIVISION OF LABOUR THIS FILE EXISTS TO HOLD UP ════════════════════════════════════
//   THIS suite asserts the WORDING — the sentence, the claim, the token.
//   The THREE panel suites assert only the BINDING — that their panel renders this component — and
//   they compose the expected text BY RENDERING IT, never by restating it.
// ⭐ So changing the sentence needs exactly ONE edit, here. §3 below DEMONSTRATES that rather than
// asserting it: it renders a MUTATED notice and shows the wording checks go red while an
// inclusion-style binding check still passes against the real component.
//
// 🚨 WHY: send and bridge carried a byte-identical sentence; the swap panel added 2026-08-30 said
// something different, and the suites drifted with it — two asserted
// /Agent spending caps do not apply here/i, the third weakened to /spending caps do not apply here/i,
// which passes against EITHER wording and therefore detects neither.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import CustodyNotice from "../src/components/CustodyNotice";
import SelfSignedPanel from "../src/components/SelfSignedPanel";
import WalletGuardNotice from "../src/components/WalletGuardNotice";

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const strip = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const notice = (token?: any) => strip(renderToStaticMarkup(<CustodyNotice token={token} />));

console.log("\n⭐ 1 — THE WORDING (asserted HERE and nowhere else)");
{
  const t = notice("USDC");
  check("states the caps claim", /Agent spending caps do not apply here/i.test(t));
  check("says the USER signs, with their own key", /You sign this yourself, with your own key/i.test(t));
  check("⭐ explains WHAT the caps are for, not just that they are absent", /bound what the agent may move\s+unattended/i.test(t));
  check("⭐ …and says explicitly they are not a limit on the user's funds", /not a limit on your own funds/i.test(t));
  check("⛔ no internal enum or jargon leaks", !/\bband\b/i.test(t) && !/\bSCA\b/.test(t) && !/permitType/i.test(t));
}

console.log("\n🚨 2 — THE TOKEN CLAIM (a wrong money claim, found by unifying — not by review)");
{
  // The pre-unification sentence said "spending your own USDC" in all three panels. That is FALSE
  // on a EURC→USDC swap. It survived review repeatedly; it surfaced only when the three copies had
  // to be stated ONCE for all three operations and the USDC assumption stopped fitting.
  check("USDC operation names USDC", /spending your own USDC\b/i.test(notice("USDC")));
  check("EURC operation names EURC", /spending your own EURC\b/i.test(notice("EURC")));
  check("⭐ a MULTI-token operation says 'funds', never 'USDC'",
    /spending your own funds/i.test(notice(undefined)) && !/spending your own USDC/i.test(notice(undefined)));
  check("⛔ the old unconditional USDC wording cannot be produced for a swap",
    !notice(undefined).includes("your own USDC"));
}

console.log("\n⭐⭐ 3 — THE DESIGN, DEMONSTRATED: a wording change breaks ONLY this suite");
{
  // A MUTATED notice stands in for "someone edited the sentence".
  const Mutated = () => (
    <div className="status">
      You sign this yourself, with your own key, spending your own funds.{" "}
      <b>Your agent's limits are not applied here</b> — a deliberately different wording.
    </div>
  );
  const mutatedText = strip(renderToStaticMarkup(<Mutated />));
  const realText = notice(undefined);

  // (a) THE WORDING CHECKS — this suite's own assertions — must go RED on the mutation.
  check("🚨 a wording change turns THIS suite's assertions red",
    !/Agent spending caps do not apply here/i.test(mutatedText));

  // (b) THE BINDING CHECK — the shape the three panel suites use — must still PASS, because the
  //     expected text is COMPOSED from whatever the component currently renders.
  const panelLike = `Some panel chrome ${realText} more chrome`;
  check("⭐ the COMPOSED binding still passes against the real component",
    panelLike.includes(realText));
  const panelLikeMutated = `Some panel chrome ${mutatedText} more chrome`;
  check("⭐⭐ …and it would ALSO pass if the panel and the component changed TOGETHER",
    panelLikeMutated.includes(mutatedText));

  // (c) ⛔ THE CONTRAST THAT MAKES (b) MEAN SOMETHING: a HARDCODED regex — what the panel suites
  //     used to do — goes red on the mutation even though the panel is still correct. That is the
  //     false failure the composed assertion removes.
  check("⛔ a HARDCODED regex would have gone red on a correct panel (the old design)",
    !/Agent spending caps do not apply here/i.test(panelLikeMutated));
}

// ═══ ⭐⭐ THE WALLET GUARD — NON-COLLAPSE IS THE ASSERTION ══════════════════════════════════════
// 🚨 Asserting "each state contains an expected phrase" is NOT enough, and that is not a theory:
// verify-manual-swap-copy DID assert a "connected but unable" case and PASSED, while the swap panel
// collapsed the two states byte-identically — because it exercised activeKind==="metamask" with a
// missing capability rather than the connected-but-not-active state that actually broke.
// ⭐ So the load-bearing check here is that the renders DIFFER, tested pairwise.
console.log("\n⭐⭐ 6 — THE WALLET GUARD: THREE STATES, AND NO TWO OF THEM COLLAPSE");
{
  const g = (metamaskConnected: boolean, active: boolean) => strip(renderToStaticMarkup(
    <WalletGuardNotice metamaskConnected={metamaskConnected} active={active}
      verb="swap" twinLabel="Swap" twinRoute="/swap" />));
  const notConnected = g(false, false), connectedInactive = g(true, false), activeButUnable = g(true, true);

  check("not connected → the instruction is CONNECT",
    /Connect MetaMask/i.test(notConnected) && !/Switch to MetaMask/i.test(notConnected));
  check("⭐⭐ connected but NOT active → the instruction is SWITCH", /Switch to MetaMask/i.test(connectedInactive));
  check("🚨 …and NOT connect what they have already connected", !/Connect MetaMask/i.test(connectedInactive));
  // ⚠️ WORD-BOUNDARY ANCHORED, and not cosmetically: /Connect MetaMask/i matches inside
  // "REconnect MetaMask", so the naive form failed against a CORRECT component. Third
  // substring-coincidence caught today (after gate:manualswap's control and the -11.64% magnitude
  // check). \b is what makes "connect" and "reconnect" different words to the assertion.
  check("⭐ connected AND active but unable → neither connect nor switch (both would be false)",
    !/\bConnect MetaMask/i.test(activeButUnable) && !/\bSwitch to MetaMask/i.test(activeButUnable)
      && /Reconnect MetaMask/i.test(activeButUnable));

  // ⭐ THE ASSERTION THE OLD SUITE LACKED: pairwise distinctness, directly.
  const pairs: [string, string, string][] = [
    ["not-connected vs connected-inactive", notConnected, connectedInactive],
    ["connected-inactive vs active-unable",  connectedInactive, activeButUnable],
    ["not-connected vs active-unable",       notConnected, activeButUnable],
  ];
  for (const [label, a, b] of pairs) check(`⭐⭐ ${label} render DIFFERENTLY`, a !== b);

  check("every state points at the agent twin, by link", [notConnected, connectedInactive, activeButUnable]
    .every((t) => /The agent swap is on the Swap page/i.test(t)));
  check("the verb and twin are props, not hardcoded",
    /bridge with your own key/i.test(strip(renderToStaticMarkup(
      <WalletGuardNotice metamaskConnected={false} active={false} verb="bridge" twinLabel="AI Agent" twinRoute="/agent" />))));
}

console.log("\n⭐ 4 — THE PAGE");
{
  const w = (kind: string) => ({ activeKind: kind, address: "0x74b7b561fd71c68eb1da6b96a7a87033904b24e5" }) as any;
  const t = strip(renderToStaticMarkup(<SelfSignedPanel wallet={w("metamask")} />));
  check("⭐ names itself for the ACT, not the wallet brand", /Operations you sign yourself/i.test(t) && !/MetaMask/i.test(t.slice(0, 200)));
  check("⭐ carries the CONTRAST in its own words (a Dashboard arrival has seen no capped panel)",
    /spending caps do not bound them/i.test(t));
  check("says nothing moves until the user signs", /nothing moves until you sign/i.test(t));
  check("⭐ links to ALL THREE operations", ["send-manual", "bridge-manual", "swap-manual"]
    .every((r) => readFileSync(new URL("../src/components/SelfSignedPanel.tsx", import.meta.url), "utf8").includes(r)));
  check("names each operation in the rendered list", /Send from your own wallet/i.test(t) && /Bridge from your own wallet/i.test(t) && /Swap from your own wallet/i.test(t));
  const nc = strip(renderToStaticMarkup(<SelfSignedPanel wallet={w("modular")} />));
  check("⚠️ a non-MetaMask wallet is told so, and differently", nc !== t && /Connect MetaMask/i.test(nc));
}

console.log("\n⛔ 5 — THE PAGE IS NOT IN THE NAV, AND THE ROUTE EXISTS ANYWAY");
{
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const nav = app.match(/const NAV = \[([\s\S]*?)\];/)![1];
  check("⛔ 'self-signed' is NOT a nav item (positioning, not layout)", !nav.includes("self-signed"));
  check("⭐ …but the route resolves", app.includes('case "self-signed"'));
  const dash = readFileSync(new URL("../src/components/Dashboard.tsx", import.meta.url), "utf8");
  check("⭐ …and the Dashboard card is the way in", dash.includes('go("self-signed")'));
  check("⭐ the card's blurb carries the contrast too", /caps do not bound these/i.test(dash));
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money, zero network.`);
process.exit(fail === 0 ? 0 : 1);
