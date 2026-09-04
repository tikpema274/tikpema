export declare const CIRCLE_TX_ID_RE: RegExp;
export declare function isCircleTransactionId(txId: unknown): boolean;
export declare function circleCanBeAsked(record: { txId?: string | null } | null | undefined): boolean;
