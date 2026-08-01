import { useEffect, useRef, useState } from "react";
import { agentClient } from "../lib/agentClient";
import SignInPrompt from "./SignInPrompt";
import type { useWallet } from "../wallet/useWallet";

// MyAgentPanel — Brick C "My Agent" surface. Re-mounts the agent-action UI (from
// the archived AgentPanel), restyled to the current design and pointed at the
// user's OWN per-user agent wallet. Every action is:
//   - auth-gated (a session token is attached; the endpoint 401s without it),
//   - session-wallet-resolved server-side (never client-supplied),
//   - per-transaction capped (AGENT_MAX_SPEND_USDC) + budget-spine day-ceiling,
//   - pay_for_service is blocked on the per-user wallet (Gateway not wired yet).
// These guardrails live in the ENDPOINTS (agent-act / agent-execute-plan /
// _actions / _budget); this surface just wires the token + renders results.
//
// NOTE: this moves real (testnet) USDC when a task executes.
//
// ── ONE PAGE, ONE JOB ────────────────────────────────────────────────────────────────
// This page TASKS THE AGENT. The Dashboard holds the money map. It did not used to be
// that way: this page also carried hop A (fund), withdraw, and the agent's raw address —
// the whole funding apparatus, duplicated. That duplication is not merely redundant, it
// is HARMFUL: two places describing custody drift apart, and the user has to hold two
// mental models of where their money is. The Dashboard's YOUR MONEY view answers "where
// is my money" for all three pockets at once, in flow order. It answers it better than a
// funding form bolted to a task page ever could. So the funding controls are GONE from
// here, replaced by one line of truth and a link to the page that owns the subject.
//
// What stays is the task box (the page's actual job, so it now LEADS) and the
// Send/Swap/Bridge shortcuts — but those shortcuts are no longer neutral "quick
// actions". A neutral Bridge button is exactly what let the author of this app mistake
// Bridge for a deposit. Consequence lives in the label, on every page, without exception.
type UnifiedWallet = ReturnType<typeof useWallet>;

const go = (id: string) => {
  window.location.hash = "/" + id;
};

const shortAddr = (a: string) =>
  a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

const describeStep = (s: any): string => {
  if (s?.type === "swap_tokens")
    return `Swap ${s.amountIn} ${String(s.tokenIn).toUpperCase()} → ${String(s.tokenOut).toUpperCase()}`;
  if (s?.type === "pay_for_service")
    return `Pay ${s.payAmountUsdc} USDC to ${shortAddr(String(s.payTo))}`;
  if (s?.type === "transfer_usdc")
    return `Send ${s.amountUsdc} USDC to ${shortAddr(String(s.to))}`;
  if (s?.type === "bridge_usdc")
    return `Bridge ${s.amountUsdc} USDC to ${s.destination}`;
  return JSON.stringify(s);
};

export default function MyAgentPanel({ wallet: w }: { wallet: UnifiedWallet }) {
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [planRun, setPlanRun] = useState<any>(null);
  const [planBusy, setPlanBusy] = useState(false);
  // Bridge (propose→confirm→execute, then async destination-mint polling).
  const [bridgeRun, setBridgeRun] = useState<any>(null);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  // Acceptance of a high-fee disclosure on THIS surface. The same 0.1 USDC bridge used to
  // behave differently depending on which page you reached: the Bridge page disclosed that
  // the fee EXCEEDS the arrival and required a tick, while here it was refused server-side
  // with no disclosure and no way to accept. This panel is the plain-language surface a user
  // is most likely to reach, so the honest path was the one they were least likely to find.
  const [bridgeAcked, setBridgeAcked] = useState(false);
  // Per-STEP acceptance for a multi-step plan. A plan can hold two bridges in different
  // bands, so this is keyed by step index rather than a single flag — one blanket tick
  // would be consent to whichever disclosure happened to render last.
  const [planAcked, setPlanAcked] = useState<Record<number, boolean>>({});
  const [mint, setMint] = useState<any>(null); // { state: 'pending'|'minted'|'failed', mintTx? }

  // ⭐ THE SINGLE SOURCE OF TRUTH FOR DELIVERY. Chain-verified receipts, owner-scoped
  // server-side. Every "did it arrive / how much arrived" question on this page answers
  // from here — never from IRIS, which attests completion but returns no amount.
  // Before this, three surfaces answered that question three different ways and could
  // disagree on screen ("Check status: Arrived" beside "in flight").
  const [bridgeReceipts, setBridgeReceipts] = useState<any[]>([]);
  const loadReceipts = async () => {
    try {
      const d = await w.listBridgeReceipts();
      setBridgeReceipts(d.receipts || []);
    } catch {
      /* read-only enrichment: never break the panel over it */
    }
  };
  useEffect(() => {
    if (w.agentWallet) loadReceipts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.agentWallet?.address]);

  // 🚨 A QUOTE BELONGS TO THE WALLET IT WAS PRICED FOR. Twice on 2026-08-01 a stale
  // agent-act result survived a session change, so the panel rendered a live-looking
  // bridge disclosure — fee band, checkbox, enabled button — with no session behind it.
  // Ticking it and confirming threw at ensureSession() before any request left the
  // browser, which is indistinguishable from "nothing happened" to the person doing it.
  // ⭐ A consent flow that can be read and accepted while attached to nothing is not a
  // consent flow. Changing wallets clears the quote, its acknowledgment, and the run.
  const lastOwner = useRef<string | null>(null);
  useEffect(() => {
    const addr = w.agentWallet?.address ?? null;
    if (lastOwner.current !== null && lastOwner.current !== addr) {
      setResult(null);
      setBridgeRun(null);
      setBridgeAcked(false);
      setMint(null);
      setPlanRun(null);
      setPlanMints({});
    }
    lastOwner.current = addr;
  }, [w.agentWallet?.address]);
  // Per-plan-step destination-mint status, keyed by step index (for bridge steps
  // inside a multi-step plan — Option A: the plan doesn't wait, these poll inline).
  const [planMints, setPlanMints] = useState<Record<number, any>>({});

  // The agent's float — READ ONLY on this page. Funding and withdrawal moved to the
  // Dashboard (see the header note); what remains here is the one number a person needs
  // before they hand the agent a task: how much can it actually spend?
  const agentBal = Number(w.agentWallet?.balance ?? 0);

  // Poll IRIS for a forwarded bridge's destination mint until it settles (or the
  // window elapses), applying each update via `onUpdate`. Shared by the standalone
  // bridge and each bridge step inside a plan.
  async function pollMint(
    burnHash: string,
    destinationKey: string,
    token: string,
    onUpdate: (s: any) => void
  ) {
    for (let i = 0; i < 48; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const s = await agentClient.bridgeStatus(burnHash, destinationKey, token);
        onUpdate(s);
        if (s.state === "minted" || s.state === "failed") break;
      } catch {
        /* transient IRIS hiccup — keep polling */
      }
    }
  }

  async function runTask() {
    setBusy(true);
    setError("");
    setResult(null);
    setPlanRun(null);
    setBridgeRun(null);
    setMint(null);
    setPlanMints({});
    try {
      const token = await w.ensureSession(); // auth: token required by the endpoint
      const data = await agentClient.act(task, token);
      setResult(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // quoteId comes straight from the quote that produced this plan and is passed through
  // untouched — it exists so the server-side record of what was PRICED can be joined to the
  // receipts of what RAN. It is not a credential and gates nothing.
  async function confirmPlan(plan: unknown[], ackTokens?: Record<number, string>, quoteId?: string) {
    setPlanBusy(true);
    setPlanMints({});
    try {
      const token = await w.ensureSession();
      const res = await agentClient.executePlan(plan, token, ackTokens, quoteId);
      setPlanRun(res);
      // Option A: any bridge step already fired its Arc burn and the plan moved
      // on. Poll each bridge step's destination mint INLINE (concurrently, in the
      // background) so its status fills in without blocking the finished plan.
      const bridges = (res?.results || []).filter(
        (r: any) => r?.ok && r?.kind === "bridge_usdc" && r?.burnHash
      );
      if (bridges.length) {
        setPlanMints(Object.fromEntries(bridges.map((r: any) => [r.index, { state: "pending" }])));
        bridges.forEach((r: any) =>
          pollMint(r.burnHash, r.destination.key, token, (s) =>
            setPlanMints((prev) => ({ ...prev, [r.index]: s }))
          )
        );
      }
    } catch (e: any) {
      setPlanRun({ error: e.message });
    } finally {
      setPlanBusy(false);
    }
  }

  // Confirm a bridge: fire the Arc burn, then poll IRIS for the destination mint.
  async function confirmBridge(amountUsdc: number, destinationKey: string, ackToken?: string) {
    setBridgeBusy(true);
    setMint(null);
    try {
      const token = await w.ensureSession();
      const res = await agentClient.bridge(amountUsdc, destinationKey, token, ackToken);
      setBridgeRun(res);
      // Stage 2: the Arc burn is done; poll until Circle's relayer mints (or fails).
      //
      // ⚠️ IRIS IS A HINT HERE, NOT THE ANSWER. Its `minted` says an attestation exists;
      // it carries NO amount and is not a chain read. The displayed arrival comes from
      // the RECEIPT (chain-verified by the settler), so the poll's only job now is to
      // tell us WHEN to re-read the receipt. See arrivalFrom() in AgentSummary.
      if (res?.executed && res?.burnHash) {
        setMint({ state: "pending" });
        await loadReceipts();
        await pollMint(res.burnHash, res.destination.key, token, setMint);
        // The settler verifies on-chain a moment after IRIS confirms; re-read then, and
        // again past the Blobs visibility window, rather than trusting one look.
        await loadReceipts();
        setTimeout(loadReceipts, 12000);
      }
    } catch (e: any) {
      setBridgeRun({ error: e.message });
    } finally {
      setBridgeBusy(false);
    }
  }

  return (
    <div className="plane">
      <div className="panel-eyebrow">Your agent</div>
      <h2>Give your agent a task</h2>
      <div className="sub">
        Your agent acts on-chain from its own wallet, in plain language — always
        spending only what's in that wallet and within your per-action, per-bridge,
        and cumulative daily safety caps.
      </div>

      {/* ── THE FLOAT, IN ONE LINE ────────────────────────────────────────────────────
          What the agent can spend, and a door to the page that owns funding. This
          REPLACES the whole hop-A / withdraw / raw-address apparatus that used to live
          here — not because that apparatus was wrong, but because it was the SECOND copy
          of it, and two money maps is worse than one.

          A ZERO BALANCE IS SAID OUT LOUD, never hidden. Hiding the empty state is exactly
          what built the old dead end: a user with an unfunded agent saw nothing at all
          and had nowhere to go. An empty float is the most important thing on the page
          when it happens, because no task can run. */}
      {w.agentWallet && (
        <div className="status" style={{ marginTop: 0, marginBottom: 4 }}>
          Your agent's wallet{" "}
          <span className="mono">{shortAddr(w.agentWallet.address)}</span> ·{" "}
          <b>{w.agentWallet.balance ?? "…"} USDC</b>{" "}
          <button className="linkbtn" onClick={() => go("dashboard")}>
            Fund or withdraw →
          </button>
          {agentBal <= 0 && w.agentWallet.balance != null && (
            <div className="sub" style={{ margin: "6px 0 0", color: "var(--warn)" }}>
              Empty — your agent can't spend anything yet. Fund it from your wallet on the
              Dashboard before giving it a task that moves money.
            </div>
          )}
        </div>
      )}

      {/* Signed out ⇒ the agent wallet hasn't resolved, so the fund control below can't
          render at all. Without this, the panel silently offers NO way back in — the same
          dead-end that stopped the first deposit attempt on #/unified. A signed-out state
          must be a door, not a wall. */}
      {!w.isAuthenticated && (
        <div style={{ marginTop: 12 }}>
          <div className="panel-eyebrow">Your agent wallet</div>
          <SignInPrompt
            wallet={w}
            message="Sign in to see your agent's wallet and fund it."
            onSignedIn={() => w.refreshAgentWallet().catch(() => {})}
          />
        </div>
      )}

      {/* ── THE TASK BOX — THE PAGE'S ACTUAL JOB, SO IT LEADS ────────────────────────
          It used to sit at the BOTTOM, under a funding form and three shortcut cards, as
          if it were an afterthought called "Multi-task". It is the reason this page
          exists. Everything that competed with it for the top of the page has either
          moved to the Dashboard (funding) or moved below it (shortcuts). */}
      <div className="panel-eyebrow" style={{ marginTop: 18 }}>Give it a task</div>
      <div className="sub" style={{ marginBottom: 8 }}>
        Describe any task in plain language, including multi-step plans — you'll confirm
        anything that moves funds before it runs.
      </div>

      <div className="row" style={{ marginTop: 0 }}>
        <input
          placeholder="e.g. swap 1 USDC to EURC then bridge 3 to Base · send 0.1 to 0x… then 0.1 to 0x…"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && task && !busy && w.address) runTask();
          }}
        />
        <button className="emerald" disabled={busy || !task || !w.address} onClick={runTask}>
          {busy ? "Working…" : "Run"}
        </button>
      </div>
      {!w.address && (
        <div className="sub" style={{ marginTop: 8, marginBottom: 0 }}>
          Continue with your passkey above first to set up your agent's wallet.
        </div>
      )}

      {busy && (
        <div className="status" style={{ marginTop: 14 }}>
          <span className="spinner" /> Your agent is deciding…
        </div>
      )}
      {error && (
        <div className="status" style={{ marginTop: 14, color: "var(--warn)" }}>
          {error}
        </div>
      )}

      {result && !busy && (
        <div style={{ marginTop: 14 }}>
          <AgentSummary
            data={result}
            planRun={planRun}
            planBusy={planBusy}
            planMints={planMints}
            planAcked={planAcked}
            onPlanAckChange={setPlanAcked}
            bridgeReceipts={bridgeReceipts}
            onConfirm={confirmPlan}
            bridgeRun={bridgeRun}
            bridgeBusy={bridgeBusy}
            bridgeAcked={bridgeAcked}
            walletReady={!!w.agentWallet}
            onAckChange={setBridgeAcked}
            mint={mint}
            onConfirmBridge={confirmBridge}
          />
        </div>
      )}

      {/* ── SHORTCUTS, SPLIT BY CONSEQUENCE ──────────────────────────────────────────────
          These were three neutral cards under a heading that said "Quick actions" — Send,
          Swap and Bridge, identical in weight, described only by mechanism ("Bridge USDC
          cross-chain to Ethereum, Base and more"). That framing tells you what the button
          DOES and nothing about what it COSTS you to be wrong, which is how Bridge got
          mistaken for a deposit by the person who wrote it.

          Now they are split by the only distinction that matters at the moment of
          clicking: does the money leave you or not? Same grouping, same wording, same
          ❗/amber grammar as the Dashboard — because a user who learns the rule on one
          page must not have to re-learn it on another. */}
      <div className="panel-eyebrow" style={{ marginTop: 26 }}>Move money out</div>
      <div className="sub" style={{ marginBottom: 8 }}>
        <b>This leaves you.</b> Both of these send USDC somewhere you don't control.
      </div>
      <div className="quick" style={{ marginTop: 4 }}>
        <button className="quick-card" onClick={() => go("send")}>
          <div className="qt">Send →</div>
          <div className="qd">
            <span style={{ color: "var(--warn)" }}>❗ Goes to someone else.</span> Gone —
            there is no undo.
          </div>
        </button>
        <button className="quick-card" onClick={() => go("bridge")}>
          <div className="qt">Bridge →</div>
          <div className="qd">
            <span style={{ color: "var(--warn)" }}>❗ Leaves Arc</span> for another chain.
            Bridging back costs a fee.
          </div>
        </button>
      </div>

      <div className="panel-eyebrow" style={{ marginTop: 20 }}>Stays with you</div>
      <div className="sub" style={{ marginBottom: 8 }}>
        Nothing leaves your agent's wallet — only the denomination changes.
      </div>
      <div className="quick" style={{ marginTop: 4 }}>
        <button className="quick-card" onClick={() => go("swap")}>
          <div className="qt">Swap →</div>
          <div className="qd">
            🔒 Stays on Arc, stays yours. Exchange between USDC and EURC.
          </div>
        </button>
      </div>
    </div>
  );
}

function TxLink({ url }: { url: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer">
      View transaction ↗
    </a>
  );
}

// Presentation of an agent-act result. Handles: needs_confirmation, plan (with
// confirm→execute), executed transfer/swap/pay, blocked, and no-op.
function AgentSummary({
  data,
  planRun,
  planBusy,
  planMints,
  planAcked,
  onPlanAckChange,
  bridgeReceipts,
  onConfirm,
  bridgeRun,
  bridgeBusy,
  bridgeAcked,
  walletReady,
  onAckChange,
  mint,
  onConfirmBridge,
}: {
  data: any;
  planRun: any;
  planBusy: boolean;
  planMints: Record<number, any>;
  planAcked: Record<number, boolean>;
  onPlanAckChange: (v: Record<number, boolean>) => void;
  bridgeReceipts: any[];
  onConfirm: (plan: unknown[], ackTokens?: Record<number, string>, quoteId?: string) => void;
  bridgeRun: any;
  bridgeBusy: boolean;
  bridgeAcked: boolean;
  walletReady: boolean;
  onAckChange: (v: boolean) => void;
  mint: any;
  onConfirmBridge: (amountUsdc: number, destinationKey: string, ackToken?: string) => void;
}) {
    // ⭐ ONE ANSWER TO "DID IT ARRIVE, AND HOW MUCH". Resolves a burnHash against the
    // chain-verified receipts and returns BOTH the claim and the number together, so no
    // caller can pair one source's confidence with another source's figure.
    // `verified` is true ONLY when the receipt says `minted` AND `delivery === "measured"`
    // AND an amount is present — the settler sets that combination on exactly one path, a
    // destination-chain read that succeeded. IRIS can never produce it: it returns no amount.
    const arrivalFor = (burnHash?: string) => {
      const rec = burnHash
        ? bridgeReceipts.find((x: any) => String(x.burnHash).toLowerCase() === String(burnHash).toLowerCase())
        : null;
      const verified =
        rec?.state === "minted" && rec?.delivery === "measured" && rec?.amountDelivered != null;
      return {
        verified,
        amount: verified ? Number(rec.amountDelivered) : null,
        mintTx: rec?.mintTx ?? null,
        state: rec?.state ?? null,
      };
    };
    const arrival = arrivalFor(bridgeRun?.burnHash);
  const d = data.decision || {};

  if (data.needsConfirmation) {
    return <div className="status" style={{ margin: 0 }}>{data.message}</div>;
  }

  // Bridge proposal → confirm → Arc burn → (async) destination mint.
  if (data.needsBridgeConfirm && data.bridge) {
    const b = data.bridge;
    const done = bridgeRun?.executed;
    return (
      <div className="status" style={{ margin: 0 }}>
        <div style={{ marginBottom: 6 }}>
          <b>Bridge {b.amountUsdc} USDC → {b.destination.label}</b>
        </div>
        <div style={{ opacity: 0.85, marginBottom: 8 }}>
          {/* ⚠️ 4dp MINIMUM ON EVERY BRIDGE AMOUNT. At 2dp the fee and the arrival collapse into
              the SAME displayed number: bridging 0.1 USDC the true split is 0.0532 fee /
              0.0468 arriving, and both render "~0.05" — the user cannot see that 53% went to
              fees. The fee is FLAT, so the smaller the bridge the worse the ratio, and 2dp is
              exactly where it becomes invisible. USDC is 6dp; never round bridge amounts to 2. */}
          Cross-chain fee ~{Number(b.feeUsdc).toFixed(4)} USDC (taken from the amount) ·
          {" "}~{Number(b.netUsdc).toFixed(4)} USDC arrives on {b.destination.label}.
          <br />
          Funds leave Arc — the burn is instant, the destination mint follows in ~1–2 min.
        </div>

        {/* ── THE FEE BAND, ON THE SURFACE USERS ACTUALLY REACH ─────────────────────────
            agent-act's quote already carries feeDisclosure, so this discloses BEFORE the
            submit rather than round-tripping through a refusal. The band is computed
            server-side by bridgeFeeBand() and threaded — this renders the verdict, it does
            not re-derive one from feeUsdc and amountUsdc. Re-deriving per surface is how
            the same bridge came to behave differently on two pages. */}
        {b.feeDisclosure?.band === "warn" && (
          <div className="status" style={{ color: "var(--warn)", marginBottom: 8 }}>
            Heads up — {(b.feeDisclosure.feeRatio * 100).toFixed(1)}% of this bridge goes to the
            network fee. The fee is flat, so bridging more at once costs the same.
          </div>
        )}
        {b.feeDisclosure?.band === "acknowledge" && (
          <div
            className="status"
            style={{ border: "1px solid var(--warn)", borderRadius: 8, padding: 12, marginBottom: 8 }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              This bridge loses {(b.feeDisclosure.feeRatio * 100).toFixed(1)}% to fees
            </div>
            <div style={{ lineHeight: 1.5 }}>
              {Number(b.feeUsdc) > Number(b.netUsdc) ? (
                <>
                  More goes to the fee ({Number(b.feeUsdc).toFixed(4)} USDC) than arrives
                  ({Number(b.netUsdc).toFixed(4)} USDC).{" "}
                </>
              ) : null}
              The cross-chain fee is flat, so it costs the same whether you bridge 0.1 or 100 USDC —
              on a small amount that is most of it. Bridging a larger amount at once, or not bridging,
              both leave you with more.
            </div>
            <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 10, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={bridgeAcked}
                onChange={(e) => onAckChange(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span style={{ lineHeight: 1.5 }}>
                I understand most of this amount will be spent on the network fee, and I want to
                bridge anyway.
              </span>
            </label>
          </div>
        )}

        {!bridgeRun && !walletReady && (
          <div className="status" style={{ color: "var(--warn)" }}>
            Your wallet isn't connected — this quote can't be acted on. Reconnect, then ask again
            so it can be re-priced for that wallet.
          </div>
        )}

        {!bridgeRun && (
          <button
            className="emerald"
            disabled={bridgeBusy || !walletReady || (b.feeDisclosure?.band === "acknowledge" && !bridgeAcked)}
            onClick={() => onConfirmBridge(b.amountUsdc, b.destination.key, b.feeDisclosure?.ackToken)}
          >
            {bridgeBusy ? "Bridging…" : "Confirm & bridge"}
          </button>
        )}

        {bridgeRun?.blocked && <div style={{ marginTop: 6 }}>Your agent held off — {bridgeRun.blocked}.</div>}
        {bridgeRun?.error && <div style={{ marginTop: 6, color: "var(--warn)" }}>Error — {bridgeRun.error}.</div>}

        {done && (
          <div style={{ marginTop: 8 }}>
            <div>
              ✓ Burned on Arc {bridgeRun.tx && <span style={{ marginLeft: 6 }}><TxLink url={bridgeRun.tx} /></span>}
            </div>
            <div style={{ marginTop: 6 }}>
              {/* ⭐ GATE AND FIGURE FROM THE SAME SOURCE.
                  This line used to read `✓ Minted ~{netUsdc}` where the ✓ came from IRIS
                  and the NUMBER was `amount − maxFee`, computed at submit time before the
                  mint existed. It asserted an arrival nobody had verified, and at 2dp the
                  fee and the arrival printed as the same "~0.05".
                  Now both halves come from the receipt: if it says `minted` AND carries a
                  chain-read `amountDelivered`, we claim arrival and print the exact figure.
                  Otherwise we say the arrival is not yet verified — we do NOT borrow IRIS's
                  confidence, because a ✓ beside a measured amount would still be a
                  composite claim, just a better-sourced one. */}
              {arrival.verified ? (
                <span>
                  ✓ Arrived — <b>exactly {arrival.amount!.toFixed(6)} USDC</b> on {bridgeRun.destination.label}
                  <span style={{ opacity: 0.7 }}> (read from the destination chain)</span>
                  {arrival.mintTx && <span style={{ marginLeft: 6 }}><a href={arrival.mintTx} target="_blank" rel="noreferrer">View mint ↗</a></span>}
                </span>
              ) : arrival.state === "mint_unverified" ? (
                <span style={{ color: "var(--warn)" }}>
                  ⚠ Needs review — Circle reported a mint our own read of {bridgeRun.destination.label} could not
                  confirm. Deliberately not retried automatically.
                </span>
              ) : arrival.state === "mint_unconfirmed" ? (
                <span style={{ color: "var(--warn)" }}>
                  Not confirmed in time — the Arc burn is final; the destination mint is <b>unproven</b>.
                  Estimated {Number(bridgeRun.netUsdc).toFixed(4)} USDC. It may still land.
                </span>
              ) : mint?.state === "minted" ? (
                <span>
                  Circle reports the mint landed — <b>arrival not yet verified</b> on-chain
                  {mint.mintTx && <span style={{ marginLeft: 6 }}><a href={mint.mintTx} target="_blank" rel="noreferrer">View mint ↗</a></span>}
                  <span style={{ opacity: 0.7 }}> · estimated {Number(bridgeRun.netUsdc).toFixed(4)} USDC</span>
                </span>
              ) : mint?.state === "failed" ? (
                <span style={{ color: "var(--warn)" }}>
                  Destination mint didn't confirm — the burn landed, so the funds are recoverable from the attestation. Check back shortly.
                </span>
              ) : (
                <span>
                  <span className="spinner" /> Bridging… burn done, waiting for the {bridgeRun.destination.label} mint (~1–2 min).
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (data.needsConfirm && Array.isArray(data.plan)) {
    const runResults = planRun?.results;
    // Server-priced, per step index. Absent for a plan with no bridge steps.
    const planDisclosures: Record<string, any> = data.stepDisclosures || {};
    // Every step that REQUIRES acceptance must have it before the plan can run. The server
    // re-prices and refuses independently — this only decides whether the button is live.
    const needAck = Object.entries(planDisclosures)
      .filter(([, d]: [string, any]) => d?.band === "acknowledge")
      .map(([k]) => Number(k));
    const allPlanAcksGiven = needAck.every((i) => planAcked[i]);
    // Only tokens for steps the user actually accepted are sent.
    const planAckTokens: Record<number, string> = {};
    for (const i of needAck) {
      if (planAcked[i] && planDisclosures[String(i)]?.ackToken) {
        planAckTokens[i] = planDisclosures[String(i)].ackToken;
      }
    }
    return (
      <div className="status" style={{ margin: 0 }}>
        <div style={{ marginBottom: 6 }}>
          <b>Proposed {data.plan.length}-step plan</b> — total ~{Number(data.totalUsdc).toFixed(4)} USDC
          {/* The fee the total used to omit entirely. `totalUsdc` sums REQUESTED amounts;
              a bridge takes its fee out of that, so without this line the plan described
              money the user would never see arrive. Priced per step at plan time. */}
          {Number(data.totalFeeUsdc) > 0 && (
            <> + ~{Number(data.totalFeeUsdc).toFixed(4)} USDC in cross-chain fees</>
          )}:
        </div>
        <ol style={{ margin: "0 0 8px 18px", padding: 0 }}>
          {data.plan.map((s: any, i: number) => {
            const r = runResults?.[i];
            const isBridge = r?.kind === "bridge_usdc" || s?.type === "bridge_usdc";
            const m = planMints?.[i];
            const stepArrival = arrivalFor(r?.burnHash);
            const mark = !r ? "" : r.ok ? " ✓" : " ✗";
            // Non-bridge note; a successful bridge shows its own two-stage line below.
            const note = !r
              ? ""
              : r.ok
                ? isBridge
                  ? ""
                  : // `state` is nested under the step's own payload — executeAction returns
                    // { ok, kind, swap, tx } with NO top-level state (only bridge_usdc has one,
                    // and bridges are handled above). Reading r.state made this always false, so
                    // a merely-SUBMITTED swap rendered " (done)". Non-swap kinds have no
                    // swap payload and correctly fall through to " (done)" — they confirm inline.
                    r.swap?.state === "submitted"
                    ? " (submitted)"
                    : " (done)"
                : ` (${r.blocked || r.error || "failed"})`;
            return (
              <li key={i} style={{ marginBottom: 2 }}>
                {describeStep(s)}
                <b>{mark}</b>
                <span style={{ opacity: 0.7 }}>{note}</span>
                {r?.ok && isBridge ? (
                  // Fire-and-continue bridge: Arc burn done, destination mint polls inline.
                  <div style={{ marginTop: 2, opacity: 0.85, fontSize: "0.92em" }}>
                    burned on Arc{" "}
                    {r.tx && <a href={r.tx} target="_blank" rel="noreferrer">↗</a>} ·{" "}
                    {/* Same rule as the single-action path: the ✓ and the amount come from
                        the receipt, or neither does. Plan completion used to show checkmarks
                        and no numbers at all, while `usdcAmount` sat unread in the receipt
                        job-run-status.mjs:90 already projects. */}
                    {stepArrival.verified ? (
                      <span>
                        arrived on {r.destination?.label ?? "destination"} ✓{" "}
                        <b>exactly {stepArrival.amount!.toFixed(6)} USDC</b>{" "}
                        {stepArrival.mintTx && <a href={stepArrival.mintTx} target="_blank" rel="noreferrer">↗</a>}
                      </span>
                    ) : stepArrival.state === "mint_unverified" ? (
                      <span style={{ color: "var(--warn)" }}>⚠ mint reported but unverified on-chain — needs review</span>
                    ) : stepArrival.state === "mint_unconfirmed" ? (
                      <span style={{ color: "var(--warn)" }}>mint unproven — burn is final, may still land</span>
                    ) : m?.state === "minted" ? (
                      <span>
                        Circle reports minted on {r.destination?.label ?? "destination"} — arrival not yet verified{" "}
                        {m.mintTx && <a href={m.mintTx} target="_blank" rel="noreferrer">↗</a>}
                      </span>
                    ) : m?.state === "failed" ? (
                      <span style={{ color: "var(--warn)" }}>mint didn't confirm yet — recoverable</span>
                    ) : (
                      <span><span className="spinner" /> minting on {r.destination?.label ?? "destination"}…</span>
                    )}
                  </div>
                ) : (
                  r?.ok && r?.tx && (
                    <span style={{ marginLeft: 8 }}>
                      <TxLink url={r.tx} />
                    </span>
                  )
                )}
              </li>
            );
          })}
        </ol>
        {/* ── PER-STEP FEE DISCLOSURE ──────────────────────────────────────────────
            A plan can hold two bridges in DIFFERENT bands, so each is disclosed and
            accepted on its own. Rendered from the server's `stepDisclosures` — the band
            is never re-derived here from two numbers, which is how three surfaces came to
            disagree about one fact. */}
        {Object.entries(planDisclosures).map(([k, d]: [string, any]) => {
          const i = Number(k);
          if (d.band === "warn") {
            return (
              <div key={k} className="status" style={{ color: "var(--warn)", marginBottom: 8 }}>
                Step {i + 1} — {(d.feeRatio * 100).toFixed(1)}% of that bridge goes to the network fee
                ({Number(d.feeUsdc).toFixed(4)} USDC of {Number(d.amountUsdc).toFixed(4)}).
              </div>
            );
          }
          if (d.band !== "acknowledge") return null;
          return (
            <div key={k} className="status" style={{ border: "1px solid var(--warn)", borderRadius: 8, padding: 12, marginBottom: 8 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                Step {i + 1} loses {(d.feeRatio * 100).toFixed(1)}% to fees
              </div>
              <div style={{ lineHeight: 1.5 }}>
                {Number(d.feeUsdc) > Number(d.netUsdc) ? (
                  <>More goes to the fee ({Number(d.feeUsdc).toFixed(4)} USDC) than arrives
                  ({Number(d.netUsdc).toFixed(4)} USDC). </>
                ) : null}
                Bridging {Number(d.amountUsdc).toFixed(4)} USDC to {d.destinationLabel}. The fee is flat,
                so it costs the same whether you bridge this or far more.
              </div>
              <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 10, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={!!planAcked[i]}
                  onChange={(e) => onPlanAckChange({ ...planAcked, [i]: e.target.checked })}
                  style={{ marginTop: 3 }}
                />
                <span style={{ lineHeight: 1.5 }}>
                  I understand most of step {i + 1} will be spent on the network fee, and I want to run
                  this plan anyway.
                </span>
              </label>
            </div>
          );
        })}

        {!planRun && (
          <button
            className="emerald"
            disabled={planBusy || !allPlanAcksGiven}
            onClick={() => onConfirm(data.plan, planAckTokens, data.quoteId)}
          >
            {planBusy ? "Executing…" : "Confirm & execute"}
          </button>
        )}
        {planRun?.blocked && <div style={{ marginTop: 6 }}>Plan blocked — {planRun.blocked}.</div>}
        {planRun?.error && <div style={{ marginTop: 6, color: "var(--warn)" }}>Error — {planRun.error}.</div>}
        {planRun?.executed && (
          <div style={{ marginTop: 6 }}>
            {planRun.completed
              ? "All steps executed."
              : `Stopped at step ${(planRun.stoppedAt ?? 0) + 1} — remaining steps not run.`}
          </div>
        )}
      </div>
    );
  }

  if (data.executed && d.action === "swap_tokens") {
    return (
      <div className="status" style={{ margin: 0 }}>
        <div>
          ✓ Swapped <b>{d.amountIn} {String(d.tokenIn).toUpperCase()}</b> → <b>{String(d.tokenOut).toUpperCase()}</b>
          {data.swap?.state === "submitted" ? " — submitted, balance updates shortly." : "."}
        </div>
        {data.tx && <div style={{ marginTop: 4 }}><TxLink url={data.tx} /></div>}
      </div>
    );
  }

  if (data.executed) {
    return (
      <div className="status" style={{ margin: 0 }}>
        <div>
          ✓ Sent <b>{d.amountUsdc} USDC</b> to <span className="mono">{shortAddr(String(d.to))}</span>.
        </div>
        {data.tx && <div style={{ marginTop: 4 }}><TxLink url={data.tx} /></div>}
      </div>
    );
  }

  if (data.blocked) {
    return (
      <div className="status" style={{ margin: 0 }}>
        Your agent held off — {data.blocked}.
      </div>
    );
  }

  return (
    <div className="status" style={{ margin: 0 }}>
      Your agent decided no on-chain action was needed.
      {d.reasoning && <div style={{ marginTop: 4 }}>{d.reasoning}</div>}
    </div>
  );
}
