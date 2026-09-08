// POST /api/agent-vault-inspect { vault }  (auth required) — READ-ONLY, moves nothing.
//
// The read half of the Vault agent. Given an allowlisted vault KEY, read the vault on-chain and
// return the DISCLOSURE the user needs before depositing — conformance, underlying asset,
// funded-vs-shell, withdraw mechanics, and OWNER POWERS — plus the exact ackToken the deposit
// endpoint will require if the vault raises a WARN. The ackToken is deterministic over the
// disclosure, so a UI that shows the warnings and has the user tick "I understand" simply echoes
// this token back on deposit; if the vault's terms change in between, the token no longer matches
// and the deposit refuses (fail-closed — see _vault.gateDeposit).
import { json, parseBody } from "./_arc.mjs";
import { connectBlobs } from "./_blobs.mjs";
import { requireSession } from "./_auth.mjs";
import { resolveVault, SUPPORTED_VAULT_KEYS } from "./_vault.mjs";
import { depositDisclosure } from "./_vault-disclosure.mjs";
import { tryOwnerWallet } from "./_agent-wallets.mjs";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectBlobs(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { vault } = parseBody(event);
  const v = resolveVault(vault);
  if (!v) {
    return json(400, { error: `unsupported vault "${vault}" (not on the allowlist)`, supported: SUPPORTED_VAULT_KEYS });
  }

  // ⭐ THE HOLDER, RESOLVED NON-FATALLY. `maxRedeem` is per-holder, so the redemption block needs
  // this address — but inspection is a READ that worked before this existed, and a wallet hiccup
  // must not start failing it. A failure here yields `owner: null`, which produces the `unknown`
  // redemption state WITH ITS REASON rather than a missing field or a reassuring default.
  // ⛔ Deliberately NOT the refusal treatment agent-vault-shares gives it: there, the wallet IS the
  // subject; here it is one input among many.
  // ⭐ `tryOwnerWallet`, NOT `ensureOwnerWallet` — the best-effort contract is NAMED rather than
  // hidden in a bare catch, and the caller-set guard keeps covering every site that must refuse.
  const holder = await tryOwnerWallet(session);

  // ⭐ THE THREE ORDERED STEPS MOVED TO _vault-disclosure.mjs, because the agent's deposit
  // proposal needs the IDENTICAL answer and re-typing an ordered sequence is how the second site
  // ends up skipping step 2 (applyReportDisclosure). See that module's header.
  let d;
  try {
    d = await depositDisclosure({ vault: v, owner: holder, event });
  } catch (e) {
    return json(502, { error: `cannot inspect vault ${v.label}: ${e.message}` });
  }
  return json(200, d);
}
