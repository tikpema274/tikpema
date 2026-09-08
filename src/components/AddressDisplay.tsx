import { useState, useEffect } from "react";

// AddressDisplay — a wallet address shown MASKED (0x4c6d…f320) by default, with
// click-to-expand to the full address and a copy-to-clipboard affordance. Pure
// client util: no network, no new data. Amber-on-ink, reuses existing tokens.
function mask(addr: string): string {
  // 6-char prefix ("0x" + 4) … 4-char suffix — e.g. 0x4c6d…f320.
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

// ⭐ `defaultExpanded` — OPT-IN, DEFAULT FALSE, so every existing call site is untouched.
// Masking is right where an address is INCIDENTAL CONTEXT (the Wallet page's pockets, the
// unified-balance owner): it keeps a long hex string from dominating a screen about something
// else. It is WRONG where the address IS THE CONTENT — a receive screen exists to hand someone an
// address, and a masked one cannot be READ ALOUD, compared against what a sender typed, or checked
// against the QR beside it. ⚠️ That last one is a safety property, not a convenience: verifying the
// address is the defence against substitution, and masking removes the thing being verified.
export default function AddressDisplay({ address, defaultExpanded = false }: { address: string; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);

  // Clear the transient "Copied" state; cleaned up on unmount / re-copy.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      /* clipboard blocked (insecure context / permissions) — no-op */
    }
  }

  return (
    <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
      {/* Toggle full/masked. A button so it's keyboard-focusable; styled as text
          so it reads as the address, not a control. */}
      <button
        className="mono"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? "Click to collapse" : "Click to show full address"}
        style={{
          border: "none",
          background: "none",
          padding: 0,
          color: "var(--paper)",
          fontSize: "0.85rem",
          wordBreak: expanded ? "break-all" : "normal",
          textAlign: "left",
        }}
      >
        {expanded ? address : mask(address)}
      </button>
      <button
        className="linkbtn"
        onClick={copy}
        style={{ fontSize: "0.78rem" }}
      >
        {copied ? "Copied ✓" : "Copy"}
      </button>
    </div>
  );
}
