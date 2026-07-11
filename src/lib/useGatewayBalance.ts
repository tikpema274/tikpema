import { useCallback, useEffect, useState } from "react";
import type { useWallet } from "../wallet/useWallet";

type UnifiedWallet = ReturnType<typeof useWallet>;

export type PerChain = { chain: string; usdc: string | null; ok: boolean };

// The Gateway balance is now PER-USER and AUTH-GATED (it used to be a public read of the
// shared agent wallet). That means the card has more than the two states it used to —
// "loading" and "here's a number" — and collapsing the new ones into "unavailable" would
// read as broken when nothing is wrong.
//
//   signed-out    → not authenticated. Don't fetch, don't 401, don't show $0. Invite sign-in.
//   provisioning  → the server returned 202: ensureOwnerWallet is mid-race on first login
//                   and the owner→wallet mapping hasn't converged (Blobs is eventually
//                   consistent, ~11s). NOT an error and NOT a zero — it resolves itself.
//   ready         → the caller's own balance. `total: "0"` is a perfectly HONEST value for a
//                   new user, and the UI must present it as "fund me", not as a failure.
//   error         → a genuine failure (network, Gateway API down).
export type GatewayBalance =
  | { status: "signed-out" }
  | { status: "loading" }
  | { status: "provisioning" }
  | { status: "error" }
  | { status: "ready"; depositor: string; total: string; perChain: PerChain[] };

const POLL_MS = 30_000;
// A 202 clears in ~11s (Blobs convergence). Poll faster than the steady-state cadence while
// provisioning so the card doesn't sit on "setting up" long after it's actually done.
const PROVISIONING_POLL_MS = 3_000;

export function useGatewayBalance(w: UnifiedWallet, reloadKey = 0): GatewayBalance {
  const [state, setState] = useState<GatewayBalance>({ status: "loading" });

  // Gate the whole thing on an EXISTING session. We must not call ensureSession() when
  // signed out: it would try to authenticate, and a background balance poll popping a
  // passkey prompt at a signed-out visitor is a hostile surprise. Signed-out is a
  // first-class state here, not a failed fetch.
  const authed = w.isAuthenticated;

  const load = useCallback(async (): Promise<GatewayBalance> => {
    if (!authed) return { status: "signed-out" };
    try {
      const token = await w.ensureSession(); // reuses the live token; won't prompt when authed
      const r = await fetch("/api/gateway-balance", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: "{}",
      });
      if (r.status === 401) return { status: "signed-out" };
      if (r.status === 202) return { status: "provisioning" }; // first-provision race
      const d = await r.json().catch(() => null);
      if (!r.ok || !Array.isArray(d?.perChain)) return { status: "error" };
      return {
        status: "ready",
        depositor: d.depositor ?? "",
        total: d.unifiedBalanceUsdc ?? "0",
        perChain: d.perChain,
      };
    } catch {
      return { status: "error" };
    }
  }, [authed, w]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      const next = await load();
      if (!alive) return;
      setState(next);
      // Back off to the normal cadence once we're out of the provisioning race.
      timer = setTimeout(tick, next.status === "provisioning" ? PROVISIONING_POLL_MS : POLL_MS);
    };

    // Signed-out needs no poll at all — flip immediately and idle.
    if (!authed) {
      setState({ status: "signed-out" });
      return () => {
        alive = false;
      };
    }

    setState((s) => (s.status === "ready" ? s : { status: "loading" }));
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [authed, load, reloadKey]);

  return state;
}
