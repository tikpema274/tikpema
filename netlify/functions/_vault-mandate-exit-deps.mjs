// _vault-mandate-exit-deps.mjs — piece 5 step 6: the PRODUCTION wiring for the exit executor and recovery
// (vault-mandate-exit-background.mjs, and the tick's recovery of `exiting` mandates). Lazy imports, so an offline suite
// loads none of the chain / Circle / Blobs machinery. ⚠️ Network wiring: exercised live, not by the offline suites
// (the same standing as productionTickDeps).
//
// Every chain figure is read on BOTH quorum endpoints and used only where they agree (the anchor's rule).

/** @param {{getStore:Function, event?:object}} a */
export async function productionExitDeps({ getStore, event = null }) {
  const [{ createPublicClient, http, parseAbi }, { ARC_QUORUM_ENDPOINTS }, store, exit, check, circleMod, arc] = await Promise.all([
    import("viem"), import("../../shared/onchain-analyze/endpoints.mjs"), import("./_vault-mandate-store.mjs"),
    import("./_vault-mandate-exit.mjs"), import("./_vault-mandate-check.mjs"), import("./_circle.mjs"), import("./_arc.mjs"),
  ]);
  const mstore = getStore(store.VAULT_MANDATE_STORE);
  const rstore = getStore(store.VAULT_MANDATE_RECEIPT_STORE);
  const clients = ARC_QUORUM_ENDPOINTS.map((rpc) => createPublicClient({ transport: http(rpc) }));
  const BAL = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const agreed = async (fn) => {
    const vals = await Promise.all(clients.map((c) => fn(c).catch(() => null)));
    return vals.length >= 2 && vals.every((x) => typeof x === "bigint") && new Set(vals.map(String)).size === 1 ? vals[0] : null;
  };
  const circle = () => circleMod.circle();

  async function circleState(id) {
    const { data } = await circle().getTransaction({ id });
    const t = data?.transaction;
    if (!t || typeof t.state !== "string") return null;
    if (t.state === "COMPLETE") return { state: "COMPLETE", txHash: t.txHash ?? null };
    if (["FAILED", "CANCELLED", "DENIED"].includes(t.state)) return { state: "FAILED", txHash: t.txHash ?? null };
    return { state: "PENDING" };
  }

  const deps = {
    now: () => Date.now(),
    mandates: store.mandateAdapter(mstore),
    depositIntents: store.intentAdapter(mstore),
    exitIntents: store.exitIntentAdapter(mstore),
    halt: store.haltAdapter(mstore),
    receipts: { read: async (key) => (await rstore.get(key, { type: "json", consistency: "strong" })) ?? null },
    record: async (key, value) => { await rstore.setJSON(key, value, { onlyIfNew: true }); },
    readers: ARC_QUORUM_ENDPOINTS.map(check.viemEndpointReader),
    usdcAddress: arc.CONTRACTS.USDC,
    circleState,
    /** The wallet's recent Circle transactions (there is no refId filter server-side; recovery matches refId). */
    async circleTxsForWallet({ walletAddress, since }) {
      try {
        const w = await circle().listWallets({ address: walletAddress, blockchain: arc.ARC.blockchain });
        const wallet = (w.data?.wallets ?? []).find((x) => x.address.toLowerCase() === String(walletAddress).toLowerCase());
        if (!wallet) return { readable: false, why: "the wallet is not one of this entity's" };
        const r = await circle().listTransactions({ walletIds: [wallet.id], blockchain: arc.ARC.blockchain, pageSize: 50, order: "DESC" });
        const floor = Date.parse(since ?? "") - 60_000;
        const txs = (r.data?.transactions ?? []).filter((t) => !Number.isFinite(floor) || Date.parse(t.createDate) >= floor);
        return { readable: true, txs };
      } catch (e) { return { readable: false, why: String(e?.message ?? e) }; }
    },
    /** The facts classifyExitOutcome reads, for THIS intent's transaction: Circle's state, the receipt, the share delta. */
    async exitFacts({ intent, record }) {
      const circleFacts = intent.circleId ? await circleState(intent.circleId).catch(() => null) : { state: "NONE" };
      const hash = intent.txHash;
      const receipts = await Promise.all(clients.map((c) => c.getTransactionReceipt({ hash }).catch(() => null)));
      let receipt = null, shares = { atParent: null, atTxBlock: null };
      if (receipts.every(Boolean) && new Set(receipts.map((x) => String(x.blockHash))).size === 1) {
        const rc = receipts[0];
        receipt = { found: true, status: rc.status, blockNumber: Number(rc.blockNumber), logs: rc.logs };
        const at = (n) => agreed((c) => c.readContract({ address: record.vault.address, abi: BAL, functionName: "balanceOf", args: [record.walletAddress], blockNumber: n }));
        shares = { atParent: await at(rc.blockNumber - 1n), atTxBlock: await at(rc.blockNumber) };
      } else if (receipts.every((x) => x === null)) {
        receipt = { found: false };
      }
      return { circle: circleFacts, receipt, shares };
    },
  };
  deps.runExit = ({ owner, id, finding }) => exit.runMandateExit({ owner, id, finding, deps });
  deps.recoverExit = ({ owner, id }) => exit.recoverMandateExit({ owner, id, deps });
  return deps;
}
