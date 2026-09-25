#!/usr/bin/env node
// verify-vault-mandate-transport.mjs — piece 3b: the check's TRANSPORT. Anchor block, a report
// SIGNED PER CHECK and verified against agentId 851891's on-chain owner, and our own reads at the
// same block on both endpoints.
//
//   node scripts/verify-vault-mandate-transport.mjs
//
// ═══ DECISION (T, 2026-09-25): SIGN EVERY PRE-DEPOSIT CHECK ══════════════════════════════════
// The disclosure says "verified by a signed report — anyone can check it". A user must be able to
// take the report from the receipt of the deposit that actually happened and verify it themselves.
//
// ═══ WHAT GOES WRONG HERE ════════════════════════════════════════════════════════════════════
//   · the pin: analyze() through the quorum client pins its OWN head. A wrapper that only looks like it
//     pins, or an inner client whose memoised pin leaks into a later check, reads the wrong block.
//   · the signature: verifyAttestation takes the registry and verifying contract FROM THE REPORT, so a
//     report can vouch for itself unless the caller pins both to the DD identity.
//   · the anchor: two endpoints must agree on the block HASH for the anchor number, or one of them is
//     serving something else.
//
// Offline: the shared mock chain, a throwaway key standing in for the DD wallet, and an ERC-1271 mock
// that recovers the signer (the same stand-in verify-attestation uses). No Circle call, no RPC.

import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { recoverAddress } from "viem";
import { quorumClient } from "../shared/onchain-analyze/quorum.mjs";
import { DOMAIN } from "../shared/onchain-analyze/attest.mjs";
import { EIP1967_IMPL_SLOT } from "../shared/onchain-facts/index.mjs";
import { SUBJ, OWNER, ZERO_WORD, word, codeWith, mkc } from "./dd/_mock-chain.mjs";
import { pinToAnchor, resolveAnchor } from "../shared/vault-mandate/anchor.mjs";
import { readStateAtAnchor } from "../shared/vault-mandate/state-reads.mjs";
import { signedCheckReport, runMandateCheck, readBaseline } from "../netlify/functions/_vault-mandate-check.mjs";
import { analyze } from "../shared/onchain-analyze/index.mjs";
import { decideMandateAction, ACTION, OBSERVED, CAUSE } from "../shared/vault-mandate/decide.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const attemptAsync = async (fn) => { try { return await fn(); } catch (e) { return { threw: String(e?.message ?? e) }; } };
const show = (o) => JSON.stringify(o ?? null, (k, v) => (typeof v === "bigint" ? v.toString() : v))?.slice(0, 180);

// ── the mock chain, with every call's params recorded and every endpoint pin() counted ────────
const A = "https://a.example", B = "https://b.example";
const HANDLERS = { [`code@${SUBJ}`]: codeWith(["upgradeTo(address)", "setFees(uint256,uint256,uint256)"]),
  [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD, ["call@0x8da5cb5b"]: word(OWNER), [`code@${OWNER}`]: "0x" };
function recording(rpc) {
  const inner = mkc(rpc, HANDLERS);
  const rec = { params: [], pins: 0 };
  return { rec, client: { ...inner, pin: async () => { rec.pins++; return inner.pin(); }, call: (x) => { rec.params.push(x.params); return inner.call(x); } } };
}
const ANCHOR = { blockNumber: 63960151, blockHash: "0x" + "ac".repeat(32) };
const tagOf = (n) => "0x" + n.toString(16);
// The block tag is the LAST param of every block-scoped read analyze() makes.
const blockTags = (params) => params.map((p) => p[p.length - 1]).filter((t) => typeof t === "string" && t.startsWith("0x") && t.length < 20);

// ── the DD identity stand-in: a throwaway key behind a mock registry + ERC-1271 account ──────
const key = privateKeyToAccount(generatePrivateKey());
const REG = "0x" + "44".repeat(20), VC = "0x" + "55".repeat(20);
const IDENTITY = { agentId: "851891", registry: REG, verifyingContract: VC, chainId: "31337", domain: DOMAIN.prod, keyId: "test", keyClass: "registered" };
const signOptions = (over = {}) => ({ sign: (message) => key.signMessage({ message }), ...IDENTITY, ...over });
// `account` is the ERC-1271 contract that validates `signer`; ownerOf answers `registryOwner`.
// eth_chainId answers `chainId` (the fixture identity's chain unless told otherwise).
function verifyClient({ registryOwner = VC, signer = key, down = false, account = VC, chainId = IDENTITY.chainId } = {}) {
  const wrap = (hex) => ({ result: hex, query: {}, evidence: { httpStatus: 200 } });
  return { async call({ method, params }) {
    if (down) throw new Error("rpc down");
    if (method === "eth_chainId") return wrap("0x" + BigInt(chainId).toString(16));
    const to = String(params?.[0]?.to ?? "").toLowerCase(), data = String(params?.[0]?.data ?? "");
    if (to === REG && data.startsWith("0x6352211e")) return wrap("0x" + BigInt(registryOwner).toString(16).padStart(64, "0"));
    if (to === account && data.startsWith("0x1626ba7e")) {
      const body = data.slice(10), digest = "0x" + body.slice(0, 64);
      const len = Number(BigInt("0x" + body.slice(128, 192))), sig = "0x" + body.slice(192, 192 + len * 2);
      let r; try { r = await recoverAddress({ hash: digest, signature: sig }); } catch { return wrap("0xffffffff" + "0".repeat(56)); }
      return wrap((r.toLowerCase() === signer.address.toLowerCase() ? "0x1626ba7e" : "0xffffffff") + "0".repeat(56));
    }
    throw new Error(`mock verify: unexpected ${to} ${data.slice(0, 10)}`);
  } };
}

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  VAULT MANDATE — transport: anchor, signed per check, both endpoints ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⭐⭐ the pin wrapper, on the REAL multi-endpoint client");
{
  const a = recording(A), b = recording(B);
  const q = quorumClient([a.client, b.client]);
  const pinned = await attemptAsync(() => pinToAnchor(q, ANCHOR));
  const rpt = await attemptAsync(() => analyze(SUBJ, { client: pinned }));
  ok("analyze through the wrapper reports the ANCHOR block", rpt?.subject?.blockNumber === ANCHOR.blockNumber, show(rpt?.subject ?? rpt?.threw));
  const tags = [...blockTags(a.rec.params), ...blockTags(b.rec.params)];
  ok("⭐ every block-scoped read at BOTH endpoints carried the anchor tag", tags.length > 0 && tags.every((t) => t === tagOf(ANCHOR.blockNumber)), `${tags.length} reads, tags ${[...new Set(tags)].join(",")}`);
  ok("⭐ neither endpoint's own pin() was ever called (the inner head was never resolved)", Boolean(rpt?.subject) && a.rec.pins === 0 && b.rec.pins === 0, `pins ${a.rec.pins}/${b.rec.pins}`);
  ok("the wrapper keeps the quorum's endpoints, quorum metadata, assert and call", Array.isArray(pinned?.endpoints) && pinned?.quorum?.required === 2 && typeof pinned?.assert === "function" && typeof pinned?.call === "function");

  // ⭐ The quorum memoises its pin. Pin the INNER client first (as another caller sharing it would),
  // then check through the wrapper: the memoised head must not leak into the check.
  const c = recording(A), d = recording(B);
  const q2 = quorumClient([c.client, d.client]);
  const innerPin = await q2.pin();
  c.rec.params.length = 0; d.rec.params.length = 0;
  const r2 = await attemptAsync(() => analyze(SUBJ, { client: pinToAnchor(q2, ANCHOR) }));
  const tags2 = [...blockTags(c.rec.params), ...blockTags(d.rec.params)];
  ok("⭐⭐ the inner client ALREADY pinned (to its head) → the check still reads at the anchor",
    innerPin?.number !== ANCHOR.blockNumber && r2?.subject?.blockNumber === ANCHOR.blockNumber && tags2.length > 0 && tags2.every((t) => t === tagOf(ANCHOR.blockNumber)),
    `inner pinned ${innerPin?.number}; report ${r2?.subject?.blockNumber}; tags ${[...new Set(tags2)].join(",")}`);
  const other = { blockNumber: ANCHOR.blockNumber + 7, blockHash: "0x" + "bd".repeat(32) };
  c.rec.params.length = 0; d.rec.params.length = 0;
  const r3 = await attemptAsync(() => analyze(SUBJ, { client: pinToAnchor(q2, other) }));
  const tags3 = [...blockTags(c.rec.params), ...blockTags(d.rec.params)];
  ok("⭐ a second wrapper on the SAME inner client reads at ITS anchor (no state carried between checks)",
    r3?.subject?.blockNumber === other.blockNumber && tags3.every((t) => t === tagOf(other.blockNumber)), show(r3?.subject));
  const p = await attemptAsync(() => pinToAnchor(q2, ANCHOR).pin());
  ok("the wrapper's pin names the anchor hash and says it was pinned by the mandate anchor",
    p?.number === ANCHOR.blockNumber && p?.tag === tagOf(ANCHOR.blockNumber) && p?.hash === ANCHOR.blockHash && p?.pinnedBy === "mandate-anchor", show(p));
  for (const [label, bad] of [["no anchor", undefined], ["no hash", { blockNumber: 5 }], ["a non-integer block", { blockNumber: "5", blockHash: ANCHOR.blockHash }]]) {
    ok(`the wrapper REFUSES ${label} (never falls back to the inner head)`, (await attemptAsync(() => pinToAnchor(q2, bad)))?.threw !== undefined);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — the anchor: one block number, the SAME hash at both endpoints");
{
  const H = "0x" + "11".repeat(32);
  const rdr = (endpoint, head, hashes = {}, { throwHead = false } = {}) => ({ endpoint,
    blockNumber: async () => { if (throwHead) throw new Error("down"); return head; },
    blockHash: async (n) => (n in hashes ? hashes[n] : null) });
  const a1 = await attemptAsync(() => resolveAnchor([rdr(A, 100, { 98: H }), rdr(B, 99, { 98: H })]));
  ok("anchor = one below the LOWER head, when both endpoints return the same hash", a1?.ok === true && a1?.anchor?.blockNumber === 98 && a1?.anchor?.blockHash === H, show(a1));
  ok("  …and it names both endpoints", a1?.anchor?.endpoints?.length === 2);
  ok("⭐ the hashes DIFFER → refused", (await attemptAsync(() => resolveAnchor([rdr(A, 100, { 98: H }), rdr(B, 99, { 98: "0x" + "22".repeat(32) })])))?.ok === false);
  ok("one endpoint does not have the block → refused", (await attemptAsync(() => resolveAnchor([rdr(A, 100, { 98: H }), rdr(B, 99, {})])))?.ok === false);
  ok("one endpoint is down → refused", (await attemptAsync(() => resolveAnchor([rdr(A, 100, { 98: H }), rdr(B, 99, { 98: H }, { throwHead: true })])))?.ok === false);
  ok("only ONE endpoint configured → refused", (await attemptAsync(() => resolveAnchor([rdr(A, 100, { 98: H })])))?.ok === false);
  ok("the same endpoint twice → refused", (await attemptAsync(() => resolveAnchor([rdr(A, 100, { 98: H }), rdr(A, 100, { 98: H })])))?.ok === false);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐⭐ one report per check: signed, then verified against the on-chain owner");
const quorum = () => quorumClient([mkc(A, HANDLERS), mkc(B, HANDLERS)]);
const healthy = async () => ({ serving: true });
const deps3 = (over = {}) => ({ health: healthy, analyzeClient: quorum(), signOptions: signOptions(), verifyClient: verifyClient(), identity: IDENTITY, ...over });
{
  const r = await attemptAsync(() => signedCheckReport({ address: SUBJ, anchor: ANCHOR, deps: deps3() }));
  ok("a report is produced AT the anchor, signed, and its signer verified", r?.report?.subject?.blockNumber === ANCHOR.blockNumber &&
    r?.report?.attestation?.status === "signed" && r?.verification?.valid === true, show(r?.why ?? r?.verification ?? r?.threw));
  ok("  exactly ONE signing call for the check", r?.cost?.signCalls === 1, show(r?.cost));
  const failed = (x) => x && x.report === null && typeof x.why === "string";

  const h0 = await attemptAsync(() => signedCheckReport({ address: SUBJ, anchor: ANCHOR, deps: deps3({ health: async () => ({ serving: false, reason: "canary stale" }) }) }));
  ok("the detector is not known good → no report, no signing call", failed(h0) && /known good|canary/i.test(h0.why) && h0?.cost?.signCalls === 0, show(h0));
  ok("health UNKNOWN (serving null) → no report", failed(await attemptAsync(() => signedCheckReport({ address: SUBJ, anchor: ANCHOR, deps: deps3({ health: async () => ({ serving: null }) }) }))));
  const sgn = await attemptAsync(() => signedCheckReport({ address: SUBJ, anchor: ANCHOR, deps: deps3({ signOptions: signOptions({ sign: async () => { throw new Error("circle 503"); } }) }) }));
  ok("signing fails → no report (never passed on unsigned)", failed(sgn) && /sign/i.test(sgn.why), show(sgn));
  const wrongOwner = await attemptAsync(() => signedCheckReport({ address: SUBJ, anchor: ANCHOR, deps: deps3({ verifyClient: verifyClient({ registryOwner: "0x" + "66".repeat(20) }) }) }));
  ok("⭐ the registry's owner of 851891 is NOT the verifying contract → refused", failed(wrongOwner) && /owner/i.test(wrongOwner.why), show(wrongOwner));
  const other = privateKeyToAccount(generatePrivateKey());
  const badSig = await attemptAsync(() => signedCheckReport({ address: SUBJ, anchor: ANCHOR, deps: deps3({ verifyClient: verifyClient({ signer: other }) }) }));
  ok("⭐ the owning account does NOT validate the signature → refused", failed(badSig) && /signature/i.test(badSig.why), show(badSig));
  const down = await attemptAsync(() => signedCheckReport({ address: SUBJ, anchor: ANCHOR, deps: deps3({ verifyClient: verifyClient({ down: true }) }) }));
  ok("the verification RPC is down → refused (indeterminate is not valid)", failed(down), show(down));
  // ⭐⭐ verifyAttestation reads the registry and verifying contract FROM THE REPORT. A report that names
  // a registry of its own choosing, whose "owner" validates anything, would verify. Pinned here.
  const REG2 = "0x" + "77".repeat(20);
  const selfVouch = { async call({ method, params }) {
    const to = String(params?.[0]?.to ?? "").toLowerCase(), data = String(params?.[0]?.data ?? "");
    if (to === REG2 && data.startsWith("0x6352211e")) return { result: "0x" + BigInt(VC).toString(16).padStart(64, "0") };
    return verifyClient().call({ method, params });
  } };
  const sv = await attemptAsync(() => signedCheckReport({ address: SUBJ, anchor: ANCHOR, deps: deps3({ signOptions: signOptions({ registry: REG2 }), verifyClient: selfVouch }) }));
  ok("⭐⭐ a report naming a DIFFERENT registry than the DD identity → refused even if it verifies", failed(sv) && /registry/i.test(sv.why), show(sv));
  const vc2 = await attemptAsync(() => signedCheckReport({ address: SUBJ, anchor: ANCHOR, deps: deps3({ signOptions: signOptions({ verifyingContract: "0x" + "88".repeat(20) }) }) }));
  ok("⭐ a report naming a verifying contract that is NOT ownerOf(851891) → refused (owner-key-mismatch)",
    failed(vc2) && vc2?.verification?.reason === "owner-key-mismatch", show(vc2?.verification ?? vc2));
  // ⭐ RELAXED 2026-09-25: the verifying contract is derived on-chain, never pinned. The owner account
  // rotates to VC3; the identity record still names the OLD VC; a report signed via VC3 must verify —
  // pinning VC would turn every check into an OUTAGE after a rotation.
  const VC3 = "0x" + "99".repeat(20);
  const rot = await attemptAsync(() => signedCheckReport({ address: SUBJ, anchor: ANCHOR, deps: deps3({
    signOptions: signOptions({ verifyingContract: VC3 }), verifyClient: verifyClient({ registryOwner: VC3, account: VC3 }) }) }));
  ok("⭐⭐ KEY ROTATION: ownerOf(851891) moved to a new account and the identity record still names the old one → VERIFIED",
    rot?.report !== null && rot?.verification?.valid === true && IDENTITY.verifyingContract !== VC3, show(rot?.why ?? rot?.verification));
  const wch = await attemptAsync(() => signedCheckReport({ address: SUBJ, anchor: ANCHOR, deps: deps3({ verifyClient: verifyClient({ chainId: "1" }) }) }));
  ok("⭐ the verification client is on ANOTHER chain (no quorum guard to exclude it) → refused, wrong-chain",
    failed(wch) && wch?.verification?.reason === "wrong-chain" && wch?.verification?.valid === null, show(wch?.verification ?? wch));
  const ag = await attemptAsync(() => signedCheckReport({ address: SUBJ, anchor: ANCHOR, deps: deps3({ signOptions: signOptions({ agentId: "1" }) }) }));
  ok("a report attesting a different agentId → refused", failed(ag), show(ag));
  // ⭐ verifyAttestation only ever calls client.call — never assert — so the quorum's chain guard would
  // never run for the verification reads. The transport must run it first.
  let asserted = 0;
  const guarded = { ...verifyClient(), assert: async () => { asserted++; throw new Error("endpoint on chain 1, expected the Arc chain"); } };
  const wc = await attemptAsync(() => signedCheckReport({ address: SUBJ, anchor: ANCHOR, deps: deps3({ verifyClient: guarded }) }));
  ok("⭐ the verification client's CHAIN GUARD runs before verifying, and a wrong chain refuses", failed(wc) && asserted === 1 && /chain/i.test(wc.why), show(wc));
  const refusing = quorumClient([mkc(A, {}), mkc(B, {})]);
  const rf = await attemptAsync(() => signedCheckReport({ address: SUBJ, anchor: ANCHOR, deps: deps3({ analyzeClient: refusing }) }));
  ok("the engine REFUSES the subject → no report, the refusal named, nothing signed", failed(rf) && /refus/i.test(rf.why) && rf?.cost?.signCalls === 0, show(rf));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — our own reads, at the anchor block hash, per endpoint");
const VAULT = { key: "xylo-usdc", address: "0x240Eb85458CD41361bd8C3773253a1D78054f747", assetAddress: "0x" + "36".repeat(20), chainId: 31337, label: "Xylo" };
const HOLDER = "0x3d7d4c52305ed0c394e01c7184701a522116097d";
function stubReader(endpoint, over = {}) {
  const vals = { withdrawFee: 10n, depositFee: 0n, decimals: 6n, balanceOf: 1999996n, maxRedeem: 1999996n,
    convertToAssets: 1000000n, previewRedeem: 999000n, totalAssets: 200n, assetBalanceOf: 300n, MAX_FEE: 2000n, ...over.vals };
  const seen = [];
  return { endpoint, seen,
    async read({ address, fn, args, blockHash }) {
      seen.push({ fn, blockHash });
      if (over.throwOn === fn) throw new Error("rpc failed");
      const k = fn === "balanceOf" && String(address).toLowerCase() === VAULT.assetAddress ? "assetBalanceOf" : fn;
      return vals[k];
    },
    async simulateRedeem({ shares, holder, blockHash }) {
      seen.push({ fn: "simulateRedeem", blockHash, shares: String(shares), holder });
      return over.sim ?? { outcome: "returned", assetsRaw: "1998000" };
    } };
}
{
  const rd = stubReader(A);
  const r = await attemptAsync(() => readStateAtAnchor({ reader: rd, vault: VAULT, holder: HOLDER, anchor: ANCHOR, cashOnly: true }));
  ok("a reading: endpoint + the anchor hash + ok", r?.ok === true && r?.endpoint === A && r?.blockHash === ANCHOR.blockHash, show(r));
  ok("⭐ EVERY read was made at the anchor block hash", rd.seen.length > 0 && rd.seen.every((s) => s.blockHash === ANCHOR.blockHash), `${rd.seen.length} reads`);
  ok("exit fee: declared 10 bps, measured from preview 10 bps", r?.exitFee?.declaredBps === 10 && r?.exitFee?.measuredBps === 10, show(r?.exitFee));
  ok("deposit fee 0, redemption full, position = the holder's shares", r?.depositFeeBps === 0 && r?.redemption?.state === "full" && r?.redemption?.positionShares === "1999996");
  ok("⭐ holding shares → the payability reading is a simulated redeem of EXACTLY those shares from the holder",
    r?.payability?.mode === "simulated-redeem" && r?.payability?.sharesRaw === "1999996" &&
    rd.seen.some((s) => s.fn === "simulateRedeem" && s.shares === "1999996" && s.holder === HOLDER), show(r?.payability));
  const r0 = await attemptAsync(() => readStateAtAnchor({ reader: stubReader(A, { vals: { balanceOf: 0n, maxRedeem: 0n } }), vault: VAULT, holder: HOLDER, anchor: ANCHOR, cashOnly: true }));
  ok("no position → the aggregate reading (cash vs counter), carrying the cashOnly profile",
    r0?.payability?.mode === "aggregate" && r0?.payability?.cashRaw === "300" && r0?.payability?.counterRaw === "200" && r0?.payability?.cashOnly === true, show(r0?.payability));
  ok("  …and the vault's cash is read from its ASSET's balanceOf(vault)", r0?.payability?.cashRaw === "300");
  const part = await attemptAsync(() => readStateAtAnchor({ reader: stubReader(A, { vals: { maxRedeem: 5n } }), vault: VAULT, holder: HOLDER, anchor: ANCHOR, cashOnly: true }));
  ok("maxRedeem below the position → partial", part?.redemption?.state === "partial");
  const blk = await attemptAsync(() => readStateAtAnchor({ reader: stubReader(A, { vals: { maxRedeem: 0n } }), vault: VAULT, holder: HOLDER, anchor: ANCHOR, cashOnly: true }));
  ok("maxRedeem 0 with a position → blocked", blk?.redemption?.state === "blocked");
  const t = await attemptAsync(() => readStateAtAnchor({ reader: stubReader(A, { throwOn: "withdrawFee" }), vault: VAULT, holder: HOLDER, anchor: ANCHOR, cashOnly: true }));
  ok("⭐ a core read fails → the whole reading is ok:false (never a partial reading with a guessed field)", t?.ok === false && typeof t?.why === "string", show(t));
  const nb = await attemptAsync(() => readStateAtAnchor({ reader: stubReader(A, { vals: { withdrawFee: "10" } }), vault: VAULT, holder: HOLDER, anchor: ANCHOR, cashOnly: true }));
  ok("a read that returns something other than an integer → ok:false", nb?.ok === false, show(nb));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — ⭐ one check, end to end");
const HH = "0x" + "11".repeat(32);
const anchorReaders = () => [A, B].map((endpoint) => ({ endpoint, blockNumber: async () => 1000, blockHash: async () => HH }));
// The chain id is the mock chain's own, read from a report, never a literal here (test:literals).
const MOCK_CHAIN_ID = (await analyze(SUBJ, { client: mkc(A, HANDLERS) })).subject.chainId;
const RECORD = { vault: { key: "xylo-usdc", address: SUBJ, chainId: MOCK_CHAIN_ID, label: "Xylo" }, walletAddress: HOLDER,
  rules: [
    { id: "r1", kind: "power", subject: "pausable", onFinding: "exit" },
    { id: "r2", kind: "state", subject: "owner-changed", baselineOwner: OWNER, onFinding: "pause" },
    { id: "r3", kind: "state", subject: "exit-fee-above", limitBps: 50, onFinding: "exit" },
    { id: "r4", kind: "state", subject: "vault-cannot-pay", onFinding: "pause" },
  ] };
const deps5 = (over = {}) => ({ ...deps3(), anchorReaders: anchorReaders(), stateReaders: [stubReader(A), stubReader(B)],
  resolveVault: (k) => (k === "xylo-usdc" ? { ...RECORD.vault, assetAddress: VAULT.assetAddress } : null), cashOnly: () => true, ...over });
{
  const c = await attemptAsync(() => runMandateCheck({ record: RECORD, deps: deps5() }));
  ok("a clean check: anchored, signed, both endpoints read", c?.anchor?.blockNumber === 999 && c?.report?.attestation?.status === "signed" && c?.readings?.length === 2, show(c?.check?.outage ?? c?.threw ?? c?.anchor));
  ok("  the report is at the anchor EXACTLY", Number.isInteger(c?.report?.subject?.blockNumber) && c.report.subject.blockNumber === c?.anchor?.blockNumber);
  ok("  one signing call", c?.cost?.signCalls === 1, show(c?.cost));
  const d = decideMandateAction({ rules: RECORD.rules, check: c?.check ?? {} });
  ok("⭐ …and the decider allows the deposit", d.action === ACTION.DEPOSIT, `${d.action} ${JSON.stringify(d.flags)} ${JSON.stringify(d.unestablished)}`.slice(0, 200));

  const s = await attemptAsync(() => runMandateCheck({ record: RECORD, deps: deps5({ signOptions: signOptions({ sign: async () => { throw new Error("circle 503"); } }) }) }));
  const o1 = s?.check?.observations?.r1;
  ok("⭐ signing fails → power + owner rules are OUTAGE, and the why says signing failed", o1?.status === OBSERVED.UNESTABLISHED && o1?.cause === CAUSE.OUTAGE && /sign/i.test(o1?.why ?? ""), show(o1));
  ok("  …while the state rules are still evaluated", s?.check?.observations?.r3?.status === OBSERVED.CLEAR);
  const an = await attemptAsync(() => runMandateCheck({ record: RECORD, deps: deps5({ anchorReaders: [anchorReaders()[0]] }) }));
  ok("no anchor → a whole-check OUTAGE, and NOTHING was signed", typeof an?.check?.outage?.reason === "string" && an?.cost?.signCalls === 0, show(an?.check?.outage ?? an?.threw));
  const nv = await attemptAsync(() => runMandateCheck({ record: RECORD, deps: deps5({ resolveVault: () => null }) }));
  ok("the record's vault is no longer on the allowlist → whole-check OUTAGE", typeof nv?.check?.outage?.reason === "string", show(nv?.check?.outage));
  const mv = await attemptAsync(() => runMandateCheck({ record: RECORD, deps: deps5({ resolveVault: () => ({ ...VAULT, address: "0x" + "99".repeat(20) }) }) }));
  ok("the allowlist entry's address differs from the record's → whole-check OUTAGE", typeof mv?.check?.outage?.reason === "string", show(mv?.check?.outage));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — the baseline for piece 3's createVaultMandate");
{
  const b = await attemptAsync(() => readBaseline({ ...RECORD.vault, assetAddress: VAULT.assetAddress }, deps5()));
  ok("ok: owner + kind from the SIGNED report, verified signer, the report block, the fee cap agreed by both endpoints",
    b?.ok === true && b?.owner?.address?.toLowerCase() === OWNER && b?.reportSigned === true && b?.signerVerified === true && Number.isInteger(b?.reportBlock) && b?.maxFeeBps === 2000, show(b));
  const dis = await attemptAsync(() => readBaseline({ ...RECORD.vault, assetAddress: VAULT.assetAddress }, deps5({ stateReaders: [stubReader(A), stubReader(B, { vals: { MAX_FEE: 1000n } })] })));
  ok("the endpoints disagree on the fee cap → maxFeeBps null (the disclosure then says it could not be read)", dis?.ok === true && dis?.maxFeeBps === null, show(dis));
  const bf = await attemptAsync(() => readBaseline({ ...RECORD.vault, assetAddress: VAULT.assetAddress }, deps5({ verifyClient: verifyClient({ down: true }) })));
  ok("the report cannot be verified → ok:false with the reason", bf?.ok === false && typeof bf?.why === "string", show(bf));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
