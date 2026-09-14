// Type surface for shared/balance-unverified-copy.mjs — the client imports the .mjs directly (one
// sentence, one file, both sides). Kept in step with the module; a drift here is a second source.
export declare const BALANCE_UNVERIFIED_NOTE: string;
/** The note when — and only when — the producer said the balance was NOT checked (`false`). */
export declare function balanceUnverifiedNote(balanceChecked: unknown): string | null;
