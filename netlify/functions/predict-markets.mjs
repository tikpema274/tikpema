import { ARC, CONTRACTS, json } from "./_arc.mjs";
import { publicClient, listMarkets } from "./_predict.mjs";

// GET /api/predict-markets
//
// READ ONLY. Enumerates markets on-chain over the public Arc RPC and returns a
// cleaned, de-duplicated list (junk/placeholder questions removed, each distinct
// question kept once). Never touches keys, signs, or sends — see _predict.mjs.
// Each returned market carries its real on-chain id, so the analyze / bet /
// resolve actions can target it directly.
export async function handler(event) {
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return json(405, { error: "GET only" });
  }

  try {
    const client = publicClient();
    const { count, markets } = await listMarkets(client);
    return json(200, {
      contract: CONTRACTS.TIKPEMA_PREDICTION,
      explorer: `${ARC.explorer}/address/${CONTRACTS.TIKPEMA_PREDICTION}`,
      totalOnChain: count, // nextMarketId() — total ever created (pre-filter)
      count: markets.length, // after junk-filter + de-dup
      markets,
    });
  } catch (e) {
    return json(500, { error: e.message });
  }
}
