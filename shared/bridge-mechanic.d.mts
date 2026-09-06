// Type surface for shared/bridge-mechanic.mjs — the client imports the .mjs directly (both sides
// must read the SAME file, so a second copy is not an option), and TypeScript needs a declaration
// for it. ⚠️ Kept minimal and in step with the module: a declaration that drifts from its .mjs is a
// second source of truth for the same shape.
export declare const BRIDGE_MECHANICS: readonly ["upfront", "deducted", "unknown"];
export type BridgeMechanic = "upfront" | "deducted" | "unknown";
export interface BridgeMechanicCopy {
  readonly feePlacement: string;
  readonly arrival: string;
  readonly summary: string;
  readonly arrivalPrefix: string;
  readonly arrivalSuffix: string;
  readonly arrivalIsEstimate: boolean;
  readonly feeIsCeiling: boolean | null;
  readonly feeCeilingNote: string;
}
export declare const BRIDGE_MECHANIC_COPY: Readonly<Record<BridgeMechanic, BridgeMechanicCopy>>;
export declare function bridgeMechanicOf(v: unknown): BridgeMechanic;
export declare function bridgeMechanicCopy(v: unknown): BridgeMechanicCopy;

// ── the SECOND axis: who signs the burn. Independent of the mechanic; see the .mjs header. ──────
// ⚠️ `mustStay: boolean | null` — null on `unknown`, because "we do not know" is not "you may go".
export declare const BRIDGE_SIGNERS: readonly ["server", "browser", "unknown"];
export type BridgeSigner = "server" | "browser" | "unknown";
export interface BridgeSignerCopy {
  readonly signedBy: string;
  readonly pageInstruction: string;
  readonly mustStay: boolean | null;
}
export declare const BRIDGE_SIGNER_COPY: Readonly<Record<BridgeSigner, BridgeSignerCopy>>;
export declare function bridgeSignerOf(v: unknown): BridgeSigner;
export declare function bridgeSignerCopy(v: unknown): BridgeSignerCopy;

// ⚠️ `feeIsCeiling: boolean | null` — null on `unknown`: a record that does not say which mechanic
// applies cannot say whether its fee figure was a maximum or an exact charge.
