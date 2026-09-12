// Type surface for shared/swap-fill-floor.mjs — the client imports the .mjs directly (both sides
// must read the SAME file), so TypeScript needs a declaration. ⚠️ Keep in step with the module.
export interface SwapExecuteRequestBody {
  readonly tokenInAddress: string;
  readonly tokenOutAddress: string;
  readonly tokenInChain: string;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly amount: string;
}
export declare function swapExecuteRequestBody(args: {
  tokenInAddress: string;
  tokenOutAddress: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
}): SwapExecuteRequestBody;

export declare const SLIPPAGE_KEYS: readonly string[];
export declare const SWAP_FILL_FLOOR_SOURCES: readonly ["circle", "caller", "unknown"];
export type SwapFillFloorSource = "circle" | "caller" | "unknown";
export declare function swapFillFloorSource(requestBody: unknown): SwapFillFloorSource;
export interface SwapFillFloorCopy {
  readonly summary: string;
  readonly single: string;
}
export declare const SWAP_FILL_FLOOR_COPY: Readonly<Record<SwapFillFloorSource, SwapFillFloorCopy>>;
export declare function swapFillFloorCopy(v: unknown): SwapFillFloorCopy;
export declare const SWAP_FILL_FLOOR_SOURCE: SwapFillFloorSource;
