// verify-circle-error-shape.mjs — ONE READER, BOTH SDK ERROR SHAPES, PROVEN AGAINST BOTH ON DISK.
//
//   node scripts/verify-circle-error-shape.mjs      (also: npm run test:circleerror)
//
// ═══ 🚨 THE DEFECT THIS LOCKS SHUT ══════════════════════════════════════════════════════════════
// @circle-fin/developer-controlled-wallets **v9 does not wrap thrown errors at all** — the raw
// `AxiosError` propagates and the detail sits at `e.response.data`. **v10 wraps 43 client methods**
// and rethrows a typed `HttpResponseError`, which carries `status`/`code`/`url`/`method` and keeps
// the Axios error behind a private `.error` getter — with **NO `.response` property**.
//
// Three money-path sites read `e.response?.status` / `e.response?.data`:
//   · netlify/functions/_x402.mjs               (the x402 payer)
//   · netlify/functions/_x402-vanilla.mjs       (the vanilla payer)
//   · netlify/functions/x402-vanilla-seller.mjs (the vanilla seller settle)
//
// ⚠️ ON v10 THOSE READS FAIL SILENTLY — optional chaining plus `?? null`, so nothing throws and no
// suite goes red. The buyer stops being told why the payment failed, and a 4xx ("your authorization
// is bad — do NOT retry") is reported as a 5xx ("we broke — please retry").
//
// ⭐⭐ THIS SUITE IS THE ONE THING IN THE REPO THAT TOUCHES A REAL SDK ERROR OBJECT. Measured: every
// one of the 46 suites in `test:all` mocks `_circle.mjs` or the SDK — across a full instrumented
// run, ZERO client methods were invoked. A signature- or error-shape change passes all 46. So this
// asserts against error objects built by the SDK's OWN `fromAxiosError`, from the copy on disk.
//
// ⭐ AND IT SURVIVES THE BUMP. The v10 factory is located wherever it lives — nested under
// adapter-circle-wallets today, top-level once the bump lands — and its ABSENCE IS A FAILURE,
// never a skip. [[absence-must-never-read-as-safe]]
//
// READ-ONLY. Zero money, zero network, zero chain, no credential.
import { readdirSync, existsSync } from "node:fs";
import { AxiosError } from "axios";
import { readCircleError, httpStatusForCircleFailure } from "../netlify/functions/_circle-error.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => {
  let ok = false, note = x;
  try { ok = typeof c === "function" ? !!c() : !!c; }
  catch (e) { ok = false; note = `threw: ${String(e?.message ?? e).slice(0, 70)}`; }
  if (ok) { pass++; console.log(`  ✅ ${l}${note ? ` — ${note}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${note ? ` — ${note}` : ""}`); }
};

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  CIRCLE ERROR SHAPE — one reader, v9 raw axios AND v10 typed        ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ── locate the v10 typed-error factory ────────────────────────────────────────────────────────
// 🚨 NOT A SKIP IF MISSING. A suite that quietly passes when it cannot find the thing it exists to
// test is the exact failure family this repo keeps paying for: the absence fills the result slot
// and reads as success. If no copy exports `fromAxiosError`, this suite FAILS.
const CANDIDATES = [];
const root = "node_modules/@circle-fin";
if (existsSync(root)) {
  for (const p of readdirSync(root)) {
    CANDIDATES.push(`../${root}/${p}/dist/developer-controlled-wallets.es.js`);
    const nested = `${root}/${p}/node_modules/@circle-fin/developer-controlled-wallets`;
    if (existsSync(nested)) CANDIDATES.push(`../${nested}/dist/developer-controlled-wallets.es.js`);
  }
}
let fromAxiosError = null, foundIn = "";
for (const rel of CANDIDATES) {
  const url = new URL(rel, import.meta.url);
  if (!existsSync(url)) continue;
  try {
    const m = await import(url.href);
    if (typeof m.fromAxiosError === "function") {
      fromAxiosError = m.fromAxiosError;
      foundIn = rel.replace(/^\.\.\//, "").replace("/dist/developer-controlled-wallets.es.js", "");
      break;
    }
  } catch { /* a copy that will not load is simply not the one */ }
}

console.log("\n── 0. THE v10 TYPED-ERROR FACTORY MUST BE PRESENT ──────────────────");
check("⭐ found a copy exporting fromAxiosError (v10 marker)", !!fromAxiosError, foundIn || "SEARCHED AND FOUND NONE");
if (!fromAxiosError) {
  console.log("\n❌ cannot test the v10 shape without the SDK's own factory — refusing to report a pass.");
  console.log(`   searched ${CANDIDATES.length} candidate path(s) under node_modules/@circle-fin/.`);
  process.exit(1);
}

// ── the fixtures ──────────────────────────────────────────────────────────────────────────────
// A realistic Circle failure for each status we actually meet on the money path.
const mkAxios = (status, data, { topLevelStatus = true } = {}) => {
  const e = new AxiosError(
    `Request failed with status code ${status}`,
    status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST",
    { url: "/v1/w3s/developer/transactions/contractExecution", method: "post" },
    {},
    { status, statusText: "", headers: {}, config: {}, data }
  );
  // ⭐ v9 bundles its OWN axios (^1.12.2), which sets `this.status = response.status`. An older
  // build might not. `topLevelStatus:false` proves the reader does not DEPEND on that field.
  if (!topLevelStatus) delete e.status;
  return e;
};

const CASES = [
  { status: 400, data: { code: 155106, message: "Invalid signature for transferWithAuthorization" }, note: "bad signature" },
  { status: 400, data: { code: 155201, message: "authorization is used or canceled" },              note: "replayed authorization" },
  { status: 401, data: { code: 401, message: "Unauthorized" },                                      note: "bad api key" },
  { status: 429, data: { code: 429, message: "Too many requests" },                                 note: "throttled" },
  { status: 500, data: { code: 500, message: "Internal error" },                                    note: "circle 5xx" },
  { status: 503, data: { code: 503, message: "Service unavailable" },                               note: "circle down" },
];

// ═══ 1. THE POINT OF THE WHOLE EXERCISE ═══════════════════════════════════════════════════════
console.log("\n── 1. ⭐⭐ THE READER EXTRACTS THE SAME FACTS FROM BOTH SHAPES ──────");
for (const { status, data, note } of CASES) {
  const v9 = mkAxios(status, data);
  const v10 = fromAxiosError(mkAxios(status, data));
  const r9 = readCircleError(v9);
  const r10 = readCircleError(v10);
  check(
    `HTTP ${status} (${note}) — status/code/body/message agree`,
    r9.status === r10.status &&
      r9.code === r10.code &&
      JSON.stringify(r9.body) === JSON.stringify(r10.body) &&
      r9.message === r10.message,
    `v9{status:${r9.status},code:${r9.code}} v10{status:${r10.status},code:${r10.code}}`
  );
  check(`   …and both recover Circle's own code (${data.code}), not the transport's`, r9.code === data.code && r10.code === data.code);
  check(`   …and both recover Circle's own message, not "Request failed with status code ${status}"`,
    r9.message === data.message && r10.message === data.message, r10.message);
  check("   …and the shapes are correctly identified", r9.shape === "axios" && r10.shape === "typed", `${r9.shape} / ${r10.shape}`);
}

// ═══ 2. THE REGRESSION LOCK — WHY THIS FILE EXISTS ════════════════════════════════════════════
console.log("\n── 2. 🚨 THE OLD READ IS PROVEN BROKEN ON v10 (do not reintroduce) ─");
{
  // verbatim from the three sites before this change
  const OLD_status = (e) => e.response?.status;
  const OLD_detail = (e) => e.response?.data ?? null;
  const OLD_http = (s) => (s && s < 500 ? 400 : 500);

  const data = { code: 155106, message: "Invalid signature for transferWithAuthorization" };
  const v10 = fromAxiosError(mkAxios(400, data));

  check("🚨 the OLD status read yields undefined on a v10 typed error", OLD_status(v10) === undefined);
  check("🚨 the OLD body read yields null on a v10 typed error", OLD_detail(v10) === null);
  check("🚨 …so the OLD mapping turns a 400 into a 500 — 'retry' on a permanently-bad authorization",
    OLD_http(OLD_status(v10)) === 500, "this is the money-path harm");
  check("⭐ the NEW reader gets 400 from the same object", readCircleError(v10).status === 400);
  check("⭐ …and the NEW mapping keeps it a 400", httpStatusForCircleFailure(readCircleError(v10).status).httpStatus === 400);
}

// ═══ 3. NO RESPONSE AT ALL ════════════════════════════════════════════════════════════════════
console.log("\n── 3. TRANSPORT FAILURE — no response, so no status to report ──────");
{
  const v9 = new AxiosError("connect ECONNREFUSED", "ECONNREFUSED", { url: "/x", method: "post" }, {}, undefined);
  const v10 = fromAxiosError(v9);
  const r9 = readCircleError(v9), r10 = readCircleError(v10);
  check("v9  transport error → status is null (UNKNOWN), not 0 and not undefined", r9.status === null, String(r9.status));
  check("v10 transport error → status is null (UNKNOWN), not 0 and not undefined", r10.status === null, String(r10.status));
  check("⭐ both keep the transport code so the cause is not lost", r9.code === "ECONNREFUSED" && r10.code === "ECONNREFUSED", `${r9.code} / ${r10.code}`);
  check("neither invents a body", r9.body === null && r10.body === null);
}

// ═══ 4. THE READER MUST NOT DEPEND ON A FIELD IT CANNOT COUNT ON ══════════════════════════════
console.log("\n── 4. AN OLDER AXIOS WITHOUT A TOP-LEVEL .status STILL READS ───────");
{
  const bare = mkAxios(400, { code: 155106, message: "Invalid signature for transferWithAuthorization" }, { topLevelStatus: false });
  check("`.status` really is absent on the fixture", bare.status === undefined);
  check("⭐ the reader falls back to .response.status and still gets 400", readCircleError(bare).status === 400);
}

// ═══ 5. NOT EVERY THROW IS A CIRCLE FAILURE ═══════════════════════════════════════════════════
console.log("\n── 5. A NON-CIRCLE ERROR IS NOT DRESSED UP AS ONE ──────────────────");
{
  const plain = new Error("Transaction still pending after timeout — it may still settle");
  const r = readCircleError(plain);
  check("status is null (we learned nothing about an HTTP status)", r.status === null);
  check("no code and no body are invented", r.code === null && r.body === null);
  check("shape is reported as opaque", r.shape === "opaque", r.shape);
  check("⭐ the message is preserved verbatim for the caller", r.message === plain.message);
}

// ═══ 6. ⭐ NEVER THROWS — IT RUNS ONLY ON THE ERROR PATH ══════════════════════════════════════
console.log("\n── 6. ⭐ A READER ON THE ERROR PATH MUST NOT PRODUCE A SECOND ERROR ─");
{
  const hostile = { get response() { throw new Error("boom"); }, get error() { throw new Error("boom"); }, get status() { throw new Error("boom"); }, message: "x" };
  check("a getter that throws does not escape the reader", () => { readCircleError(hostile); return true; });
  check("null / undefined / a string are all handled", () => {
    for (const v of [null, undefined, "nope", 7]) readCircleError(v);
    return true;
  });
  check("…and a hostile object still yields UNKNOWN rather than a wrong status", readCircleError(hostile).status === null);

  // ⭐ The nastier shape: a READABLE body but a throwing `status` getter, which reaches code the
  // all-throwing fixture short-circuits past. A guard that only tests the easy hostile object
  // leaves the branch it was written for unexercised.
  const halfHostile = { response: { data: { code: 155106, message: "Invalid signature" } }, get status() { throw new Error("boom"); }, message: "x" };
  check("⭐ a throwing .status with a readable body does not escape", () => { readCircleError(halfHostile); return true; });
  check("⭐ …and the body is still recovered", readCircleError(halfHostile).body?.code === 155106);
  check("⭐ …while the unreadable status reports UNKNOWN, not a guess", readCircleError(halfHostile).status === null);
}

// ═══ 7. ⭐⭐ THE STATUS DEFAULT — UNKNOWN IS ITS OWN BRANCH ════════════════════════════════════
console.log("\n── 7. ⭐⭐ UNKNOWN MUST NOT SILENTLY BECOME 500-AND-RETRY ───────────");
{
  const c4 = httpStatusForCircleFailure(400);
  const c429 = httpStatusForCircleFailure(429);
  const c5 = httpStatusForCircleFailure(503);
  const cU = httpStatusForCircleFailure(null);

  check("a 4xx → 400, known, not retry-safe", c4.httpStatus === 400 && c4.statusKnown === true && c4.retrySafe === false);
  check("a 5xx → 500, known, retry-safe", c5.httpStatus === 500 && c5.statusKnown === true && c5.retrySafe === true);
  check("⭐ 429 is the 4xx that IS retry-safe (http code unchanged at 400)", c429.httpStatus === 400 && c429.retrySafe === true);

  check("🚨 UNKNOWN does NOT map to 500", cU.httpStatus !== 500, `got ${cU.httpStatus}`);
  check("🚨 UNKNOWN does NOT map to 400 either — we did not observe a client error", cU.httpStatus !== 400);
  check("⭐ UNKNOWN maps to 502 — distinct on the wire from both", cU.httpStatus === 502);
  check("⭐ UNKNOWN reports statusKnown:false", cU.statusKnown === false);
  check("⭐⭐ UNKNOWN reports retrySafe:null — never true, and never silently false", cU.retrySafe === null);

  // The three outcomes must be mutually distinguishable by a caller reading only the wire.
  const codes = new Set([c4.httpStatus, c5.httpStatus, cU.httpStatus]);
  check("⭐ the three outcomes are three DIFFERENT http codes", codes.size === 3, [...codes].join("/"));

  // 🚨 The exact hole in the old expression: every falsy status fell through to 500.
  // ⭐⭐ `0` is the one that bites BOTH ways — it is a number, so a naive `typeof === "number"`
  // accepts it and `0 < 500` then reads as a CLIENT error, turning "no response" into a confident
  // "Circle rejected you". Pinned here alongside the out-of-range and wrong-type values.
  for (const bad of [undefined, null, NaN, 0, "", "400", -1, 99, 600, 1.5, Infinity, {}]) {
    const r = httpStatusForCircleFailure(bad);
    check(`not an observed status (${JSON.stringify(bad) ?? String(bad)}) → UNKNOWN, not 500 and not 400`,
      r.httpStatus === 502 && r.statusKnown === false && r.retrySafe === null, `got ${r.httpStatus}`);
  }

  // …and the reader must not hand such a value onward in the first place.
  for (const bad of [0, -1, 600, 1.5]) {
    const e = new AxiosError("x", "ERR", { url: "/x", method: "post" }, {}, { status: bad, statusText: "", headers: {}, config: {}, data: null });
    check(`⭐ the reader rejects status ${bad} at the source (reports UNKNOWN)`, readCircleError(e).status === null, String(readCircleError(e).status));
  }
}

// ═══ 8. THE THREE CALL SITES ACTUALLY USE IT ══════════════════════════════════════════════════
// ⭐ Asserting the reader is correct proves nothing if a site still reads `e.response` by hand.
// [[duplicate-source-of-truth-is-the-recurring-bug]] — grep for the OTHER copy.
console.log("\n── 8. ⭐ NO SITE STILL READS e.response BY HAND ────────────────────");
{
  const { readFileSync } = await import("node:fs");
  const SITES = [
    "netlify/functions/_x402.mjs",
    "netlify/functions/_x402-vanilla.mjs",
    "netlify/functions/x402-vanilla-seller.mjs",
  ];
  for (const f of SITES) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    // strip comments so the explanatory prose above each site does not count as a usage
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    check(`${f} imports the shared reader`, /_circle-error\.mjs/.test(code));
    check(`   …and no longer reads e.response?.status / .data itself`,
      !/\ber?r?\.response\?\.(status|data)\b/.test(code) && !/\be\.response\b/.test(code));
    check(`   …and no longer carries the old two-branch mapping`,
      !/status\s*&&\s*status\s*<\s*500\s*\?/.test(code));
  }
}

// ═══ 9. ⭐⭐ RENDERED OUTPUT — DRIVE A REAL SITE, READ WHAT IT ACTUALLY RETURNS ════════════════
// Section 8 is a SOURCE REGEX, and this repo's own rule is that a source grep has the blind spot
// it was built to close — a site could import the reader and still hardcode a status.
// [[assert-on-rendered-output-not-source-regex]]
//
// `payX402Vanilla`'s try{} opens at the challenge fetch, so making `fetch` throw reaches the very
// catch block this change rewrote — no seller fixture, no module mocks, no credential.
console.log("\n── 9. ⭐⭐ THE REAL SITE'S RETURNED {status, body}, NOT ITS SOURCE ───");
{
  process.env.DELEGATE_ADDRESS ||= "0x" + "de".repeat(20);
  const { payX402Vanilla } = await import("../netlify/functions/_x402-vanilla.mjs");
  const realFetch = globalThis.fetch;
  const drive = async (thrown) => {
    globalThis.fetch = async () => { throw thrown; };
    try { return await payX402Vanilla({ sellerUrl: "https://seller.invalid/x" }); }
    finally { globalThis.fetch = realFetch; }
  };

  const data400 = { code: 155106, message: "Invalid signature for transferWithAuthorization" };

  // 🚨 THE HEADLINE CASE: a v10 typed 400 must NOT come back as a 500.
  {
    const r = await drive(fromAxiosError(mkAxios(400, data400)));
    check("🚨 v10 typed 400 → the site returns HTTP 400 (was 500 before this change)", r.status === 400, `got ${r.status}`);
    check("   …and surfaces Circle's code to the buyer", r.body.circleCode === 155106, String(r.body.circleCode));
    check("   …and surfaces Circle's body (not null)", JSON.stringify(r.body.circleError) === JSON.stringify(data400));
    check("   …and Circle's message, not the transport's", r.body.error === data400.message, r.body.error);
    check("   …and marks the status known and NOT retry-safe", r.body.statusKnown === true && r.body.retrySafe === false);
  }

  // The same failure in the v9 shape must render identically — that is what makes it shippable now.
  {
    const v9 = await drive(mkAxios(400, data400));
    const v10 = await drive(fromAxiosError(mkAxios(400, data400)));
    check("⭐⭐ v9 and v10 render the SAME response body", JSON.stringify(v9.body) === JSON.stringify(v10.body));
    check("⭐⭐ …and the same HTTP status", v9.status === v10.status, `${v9.status} / ${v10.status}`);
  }

  // A genuine upstream 5xx still reads as a 5xx.
  {
    const r = await drive(fromAxiosError(mkAxios(503, { code: 503, message: "Service unavailable" })));
    check("a v10 typed 503 → the site returns HTTP 500, retry-safe", r.status === 500 && r.body.retrySafe === true, `got ${r.status}`);
  }

  // ⭐⭐ THE REQUIREMENT: an undetermined failure must not be dressed as a server error.
  {
    const r = await drive(new Error("socket hang up"));
    check("🚨 an UNDETERMINED failure does NOT return 500", r.status !== 500, `got ${r.status}`);
    check("⭐ it returns 502 — distinguishable on the wire from both 400 and 500", r.status === 502);
    check("⭐ circleStatus is null, not a guessed number", r.body.circleStatus === null, String(r.body.circleStatus));
    check("⭐⭐ statusKnown:false and retrySafe:null — the buyer is not told to retry", r.body.statusKnown === false && r.body.retrySafe === null);
    check("   …and the message is still carried through", r.body.error === "socket hang up", r.body.error);
  }
}

console.log("\n════════════════════════════════════════════════════════════════════════");
console.log(`${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log("⭐ One reader, both shapes. Unknown is a third answer, not a silent 500.\n");
