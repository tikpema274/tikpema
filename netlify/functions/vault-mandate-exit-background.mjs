// vault-mandate-exit-background.mjs — piece 5 step 6: the mandate EXIT EXECUTOR, as a Netlify BACKGROUND function.
// Triggered by the tick when a check decides EXIT (and re-runnable for recovery). Ships DISARMED: decideExit's shipped
// arming (MANDATE_EXIT_ARMED = false) stops every run at the decision, before anything is written.
//
// ═══ ⚠️ A BACKGROUND FUNCTION IS PUBLIC AT /.netlify/functions/vault-mandate-exit-background ═════════════════
//   · The trigger is AUTHENTICATED (requireInternal: the HMAC over SESSION_SECRET) BEFORE any store is opened.
//   · The payload names only WHICH mandate and WHICH receipt (owner, id, receiptKey). The FINDING — the check, its
//     anchor, the exit path — is loaded from the receipt STORE by that key, never from the payload; a payload's `check`
//     or `exitPath` is ignored. The receipt key must be this mandate's own (w/<owner>/<id>/…).
//   · A mandate already EXITING gets RECOVERY (look up, classify, settle — never a re-send), never a new exit.
//   · Netlify acks 202 before the function runs and discards its output, so the run's result is WRITTEN to the receipt
//     store (`exit-run/<owner>/<id>/<ISO>`), the one place it can be read.

import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { requireInternal } from "./_auth.mjs";

const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isId = (v) => typeof v === "string" && /^[A-Za-z0-9-]{1,80}$/.test(v);

/**
 * The job, over injected deps (the handler wires production). Pure of HTTP.
 * @param {{body:{owner, id, receiptKey}, deps:{mandates, receipts:{read}, runExit, recoverExit, record}}} a
 */
export async function runExitJob({ body, deps }) {
  const no = (code, why) => ({ ok: false, code, why });
  const owner = String(body?.owner ?? "").toLowerCase(), id = body?.id, receiptKey = body?.receiptKey;
  if (!isAddr(owner) || !isId(id) || typeof receiptKey !== "string") return no("bad-request", "owner (an address), id and receiptKey are required");
  if (!receiptKey.startsWith(`w/${owner}/${id}/`)) return no("receipt-not-this-mandate", "the receipt key is not this mandate's own (w/<owner>/<id>/…)");

  const m = await deps.mandates.read({ owner, id });
  if (!m?.readable) return no("mandate-unreadable", (m?.errors ?? []).join("; ") || "unreadable");
  if (!m.record) return no("no-mandate", "no such mandate");
  if (m.record.status === "exiting") return { via: "recovery", ...(await deps.recoverExit({ owner, id })) };

  let receipt;
  try { receipt = await deps.receipts.read(receiptKey); } catch (e) { return no("receipt-unreadable", String(e?.message ?? e)); }
  if (!receipt) return no("no-receipt", `no receipt at ${receiptKey}`);
  if (!receipt.check || !receipt.anchor) return no("receipt-incomplete", "the receipt stores no check (or no anchor) to re-decide from");
  // ⭐ THE FINDING, FROM THE STORE — whatever the payload carried beyond the keys is ignored.
  const finding = { check: receipt.check, anchor: receipt.anchor, exitPath: receipt.exitPath };
  return { via: "exit", ...(await deps.runExit({ owner, id, finding })) };
}

export async function handler(event) {
  if (!requireInternal(event)) {
    console.warn("[vault-mandate-exit] REFUSED — no valid x-internal-token; nothing was read or written");
    return { statusCode: 401, body: JSON.stringify({ error: "unauthorised" }) };
  }
  if (event?.httpMethod && event.httpMethod !== "POST") return { statusCode: 405, body: JSON.stringify({ error: "POST only" }) };
  if (event?.blobs) connectBlobs(event);
  let body = null;
  try { body = JSON.parse(event?.body || "{}"); } catch { body = null; }
  const { productionExitDeps } = await import("./_vault-mandate-exit-deps.mjs");
  const deps = await productionExitDeps({ getStore, event });
  let result;
  try { result = await runExitJob({ body, deps }); }
  catch (e) { result = { ok: false, code: "threw", why: String(e?.message ?? e) }; }
  const owner = String(body?.owner ?? "unknown").toLowerCase(), id = String(body?.id ?? "unknown");
  await deps.record(`exit-run/${owner}/${id}/${new Date().toISOString()}`, { at: new Date().toISOString(), request: { owner, id, receiptKey: body?.receiptKey ?? null }, result }).catch(() => {});
  console.log(`[vault-mandate-exit] ${JSON.stringify({ owner, id, code: result?.code ?? null, ok: result?.ok ?? null })}`);
  return { statusCode: 200, body: JSON.stringify(result) };
}
