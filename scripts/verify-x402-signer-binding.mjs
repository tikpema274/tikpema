// verify-x402-signer-binding.mjs — the batched buyer signs as the account the payment is drawn from.
//
// ⛔ THE PROPERTY THAT MATTERS: `circleSigner` must resolve its Circle wallet BY ADDRESS, and that
// address must be the same account it advertises to the scheme as `from`. The batched scheme
// requires `ecrecover(sig) == from`; anything that lets the signing wallet and `from` diverge is a
// money-path fail-open that surfaces only as a vendor rejection, with no local signal.
//
// ═══ 🚨 THE DEFECT THIS EXISTS FOR — A DEAD BRANCH WITH A LIVE INVITATION ═════════════════════
// `circleSigner` took a `walletId` and preferred it: `walletId ? { walletId, data } : { … }`, under
// a comment reading "Prefer walletId (set by agent-init)". The sole call site passed a literal
// `null`, so the arm never ran — but the comment names `AGENT_WALLET_ID`, and ⛔ THAT VARIABLE IS
// SET IN PRODUCTION to `2c93ca5d-…`, the DD attestation identity, whose account is the SCA
// `0xc54d47…`. `from` here is the delegate EOA `0x6db396c1…`. Wiring the comment's suggestion would
// have authenticated to Circle and signed as a DIFFERENT WALLET than the payer — silently.
//
// ⭐⭐ AND IT WOULD NOT HAVE FAILED LOUDLY. An SCA signs ERC-1271, which does not ecrecover at all,
// so the break lands at the FACILITATOR: a working buy path starts returning vendor rejections
// while every local check still passes. That is why the parameter is REMOVED rather than
// documented — a dead branch plus an instruction to feed it is a defect waiting for a maintainer.
//
// ⚠️ NOTE WHICH ARM WAS LIVE. `walletAddress + blockchain` is the arm that has settled every real
// purchase (3 as of 2026-09-07). Making `walletId` *required* would have thrown on every call and
// killed the buy path — the opposite of the fix. The dead arm is the one that had to go.

import { readFileSync } from "node:fs";
import { circleSigner } from "../netlify/functions/_x402.mjs";

let pass = 0, fail = 0;
const check = (l, ok, d = "") => { if (ok) { pass++; console.log(`  ✅ ${l}`); } else { fail++; console.log(`  ❌ ${l}${d ? `  — ${d}` : ""}`); } };

const PAYER = "0x6db396c1a37024fd3bee1f3dbf3020aa3b2bb380";
const SCA   = "0xc54d47211997aca90ef4fcfbc742a3b511b4e621"; // the DD attestation account — NOT the payer
const CHAIN = "ARC-SEPOLIA";

/** A Circle client stub that records the input it was asked to sign with. ⚠️ Mocks the BOUNDARY
 *  (Circle's HTTP API), never the subject — `circleSigner` itself is the real thing. */
const spyClient = () => {
  const seen = [];
  return { seen, signTypedData: async (input) => { seen.push(input); return { data: { signature: "0xsig" } }; } };
};
const TYPED = { domain: { name: "USDC", chainId: 5042002 }, types: { A: [] }, primaryType: "A", message: { v: 1n } };

console.log("\n── 1. ⛔ THE WALLET IS RESOLVED BY ADDRESS, AND THERE IS NO ID ARM ─────");
{
  const client = spyClient();
  const signer = circleSigner({ client, address: PAYER, walletAddress: PAYER, blockchain: CHAIN });
  await signer.signTypedData(TYPED);
  const input = client.seen[0];
  check("the signing request carries walletAddress + blockchain",
    input.walletAddress === PAYER && input.blockchain === CHAIN, JSON.stringify(input && Object.keys(input)));
  check("🚨 …and carries NO walletId key at all",
    !Object.prototype.hasOwnProperty.call(input, "walletId"), JSON.stringify(Object.keys(input)));
  check("⭐ the signer advertises the payer as its address", signer.address === PAYER);
  check("   …and a signature still comes back (the live arm is intact)",
    (await signer.signTypedData(TYPED)) === "0xsig");
}

console.log("\n── 2. 🚨 A walletId CANNOT BE SMUGGLED BACK IN VIA THE OPTIONS ────────");
{
  const client = spyClient();
  // Pass the production AGENT_WALLET_ID exactly as a maintainer following the old comment would.
  const signer = circleSigner({
    client, address: PAYER, walletAddress: PAYER, blockchain: CHAIN,
    walletId: "2c93ca5d-be5c-5f51-883d-1a220647f7b1",
  });
  await signer.signTypedData(TYPED);
  check("⛔ an extra walletId option is IGNORED, not honoured",
    !Object.prototype.hasOwnProperty.call(client.seen[0], "walletId"), JSON.stringify(client.seen[0]));
  check("   …and the address-resolved wallet is still what Circle is asked for",
    client.seen[0].walletAddress === PAYER);
}

console.log("\n── 3. ⛔ SIGNING AS A DIFFERENT ACCOUNT THAN `from` IS REFUSED ────────");
{
  let threw = null;
  try { circleSigner({ client: spyClient(), address: PAYER, walletAddress: SCA, blockchain: CHAIN }); }
  catch (e) { threw = e; }
  check("🚨 advertised address != signing wallet THROWS", threw !== null);
  check("   …at CONSTRUCTION, before any signature is produced",
    threw !== null && /WRONG WALLET/i.test(threw.message), threw?.message);
  check("⭐ the refusal names BOTH accounts so the reader can tell which is which",
    threw !== null && threw.message.includes(PAYER) && threw.message.includes(SCA), threw?.message);
  check("   …and states the invariant that makes them inseparable",
    threw !== null && /ecrecover\(sig\) == from/.test(threw.message), threw?.message);

  // Case differences are not a divergence — the same account written two ways.
  let ok = true;
  try { circleSigner({ client: spyClient(), address: PAYER.toUpperCase().replace("0X", "0x"), walletAddress: PAYER, blockchain: CHAIN }); }
  catch { ok = false; }
  check("⚠️ …but a CASE difference is the same account, not a mismatch", ok);
}

console.log("\n── 4. ⛔ AN UNRESOLVABLE SIGNER FAILS CLOSED AT CONSTRUCTION ──────────");
for (const [label, opts] of [
  ["walletAddress missing", { address: PAYER, blockchain: CHAIN }],
  ["blockchain missing",    { address: PAYER, walletAddress: PAYER }],
  ["both missing",          { address: PAYER }],
]) {
  let threw = null;
  try { circleSigner({ client: spyClient(), ...opts }); } catch (e) { threw = e; }
  check(`🚨 ${label} → THROWS rather than guessing`, threw !== null);
  check(`   …and says the wallet is resolved by ADDRESS on purpose`,
    threw !== null && /resolved by ADDRESS/i.test(threw.message), threw?.message);
}

console.log("\n── 5. ⚠️ SOURCE — the removed branch stays removed ────────────────────");
{
  // ⚠️ SOURCE, labelled as the weaker instrument: sections 1–4 already prove the BEHAVIOUR. This
  // catches a reintroduction that a behavioural test would only see once someone wired it up.
  const raw = readFileSync(new URL("../netlify/functions/_x402.mjs", import.meta.url), "utf8");
  // Comments stripped first — the block above the function necessarily QUOTES the old branch to
  // explain it, and checking raw text would teach the next person to delete the explanation.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  check("⭐⭐ no CODE reads process.env.AGENT_WALLET_ID", !/process\.env\.AGENT_WALLET_ID/.test(src));
  check("⭐⭐ no CODE branches on a walletId when building the sign request",
    !/walletId\s*\?/.test(src), "the ternary that preferred an id over the address is back");
}

console.log(`\n${fail ? "❌" : "✅"} x402 signer binding: ${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
