import assert from "node:assert/strict";
import { readJson } from "../src/lib/readJson.ts";

// verify-read-json — an unreadable answer must never become an empty one.
//
// ═══ 🚨 THE AMPLIFIER THIS PINS ══════════════════════════════════════════════════════════════
// 17 call sites did `await r.json().catch(() => ({}))`. That collapses "I got something
// UNPARSEABLE" into "I got NOTHING" — different facts, same value — and the resulting `{}` flows on
// as a successful result.
//
// ⭐ MEASURED 2026-08-12: an unmatched `/api/*` GET is served by the SPA catch-all as **200 with
// HTML**. So `r.ok` is TRUE, `r.json()` throws, the `.catch` erases the throw, `if (!r.ok) throw`
// never fires, and `{}` is returned AS A SUCCESSFUL MONEY RESULT. Ten of the seventeen sites were
// money-adjacent (agent-send, agent-bridge, agent-execute-plan, agent-ub-deposit, the vault
// deposit/withdraw pair, job-bridge-approve, job-run ×2, agent-bridge-status).
//
// ⭐⭐ THE ROUTING IS THE SOURCE FIX; THIS IS THE CONTAINMENT. A rule that 404s unmatched `/api/*`
// removes the 200-HTML response at its origin and covers paths nobody has typed yet — but it
// changes routing for EVERY path and deserves its own proof. This closes every call site at once,
// with no routing change and no per-path proof.
//
// ⚠️ THE LINE THIS SUITE DEFENDS: refuse the unreadable, PASS THROUGH the merely unsuccessful. A
// 401 with a JSON error body must still parse, or every caller's `if (!res.ok) throw
// new Error(data.error)` loses its message and this "fix" makes error reporting worse.

const mk = (status: number, body: string, url = "https://app.tikpema.xyz/api/job-run-status") =>
  ({ status, url, text: async () => body }) as unknown as Response;

let pass = 0, fail = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e: any) { fail++; console.error(`  ❌ ${name}\n     ${e.message}`); }
};
const threw = async (res: Response) => {
  try { await readJson(res); return null; } catch (e: any) { return e.message as string; }
};

console.log("\n── readJson: unreadable ≠ empty ────────────────────────────────");

await t("⭐⭐ 200 + SPA HTML THROWS — the exact response that read as success", async () => {
  const m = await threw(mk(200, "<!doctype html><html><head>…"));
  assert.ok(m, "a 200 HTML page must NOT be returned as an object — that is the silent-success path");
  assert.match(m!, /did not reach the server/i, "the message must name the likely cause: a wrong address");
  assert.match(m!, /Nothing was sent or changed/i, "…and must say plainly that nothing happened");
});

await t("⭐ …and it names the status and URL, so the wrong path is identifiable", async () => {
  const m = await threw(mk(200, "<html>"));
  assert.match(m!, /200/);
  assert.match(m!, /job-run-status/);
});

await t("404 + SPA HTML also throws (the POST-shaped variant of the same miss)", async () => {
  assert.ok(await threw(mk(404, '<!DOCTYPE html>\n<html lang="en">')));
});

await t("⭐⭐ a 4xx with a JSON error body STILL PARSES — callers keep their message", async () => {
  const v: any = await readJson(mk(401, '{"error":"Authentication required"}'));
  assert.equal(v.error, "Authentication required",
    "refusing the unreadable must not break the merely unsuccessful, or error reporting gets WORSE");
});

await t("a normal JSON object passes through untouched", async () => {
  const v: any = await readJson(mk(200, '{"ok":true,"n":1}'));
  assert.deepEqual(v, { ok: true, n: 1 });
});

await t("⭐ an EMPTY body is a legitimate answer, not an unreadable one", async () => {
  assert.deepEqual(await readJson(mk(204, "")), {}, "204/no-content must not throw");
  assert.deepEqual(await readJson(mk(400, "   ")), {}, "whitespace-only is empty, not garbage");
});

await t("⭐ bare `null` and scalars throw — they would re-create 'unreadable became falsy'", async () => {
  assert.ok(await threw(mk(200, "null")), "null parses but is not the object shape callers assume");
  assert.ok(await threw(mk(200, "42")));
  assert.ok(await threw(mk(200, '"a string"')));
});

await t("truncated JSON throws rather than yielding a partial object", async () => {
  const m = await threw(mk(200, '{"amountUsdc": 1, "txHa'));
  assert.ok(m);
  assert.match(m!, /could not be read/i);
  assert.doesNotMatch(m!, /did not reach the server/i, "not HTML — must not blame the address");
});

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-read-json: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
