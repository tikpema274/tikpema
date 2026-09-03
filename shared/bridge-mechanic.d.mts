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
}
export declare const BRIDGE_MECHANIC_COPY: Readonly<Record<BridgeMechanic, BridgeMechanicCopy>>;
export declare function bridgeMechanicOf(v: unknown): BridgeMechanic;
export declare function bridgeMechanicCopy(v: unknown): BridgeMechanicCopy;
