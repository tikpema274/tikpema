// verify-mock-shape.mjs — scripts/lib/mock-shape.mjs builds mocks that CANNOT break module loading, and every suite
// that mocks _bridge.mjs uses it.
//
//   node scripts/verify-mock-shape.mjs      (npm run test:mockshape)
//
// WHY (2026-10-01): a hand-listed `namedExports` mock fails MODULE INSTANTIATION when the code under test imports a new
// export — the kill-switch suite died that way three times (2026-07-31 for 33 days, shoutLedgerFailure, d5239d7).
// Reproduced on purpose: one new _bridge.mjs export used by its 16 importers made all FIVE hand-mocked suites fail to
// load; after the conversion all four test:all suites pass with that mutation in place. The guard below keeps it so.
import { readFileSync, readdirSync } from "node:fs";
import { mockShape, unstubbed } from "./lib/mock-shape.mjs";

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 64 - t.length))}`);

section("1 — the helper: functions stubbed, constants real, classes kept, overrides last");
{
  class Err extends Error {}
  const real = { TABLE: { a: 1 }, N: 5, fn: () => "REAL", fn2: async () => "REAL2", Err };
  const calls = [];
  const m = mockShape(real, { stub: (name) => () => { calls.push(name); return "STUB"; }, override: { fn2: async () => "OVERRIDE" } });
  ok("every real export name is present (a new export can never be 'missing')", Object.keys(real).every((k) => k in m));
  ok("constants are the REAL values", m.TABLE === real.TABLE && m.N === 5);
  ok("⭐ a function is the STUB, never the real code", m.fn() === "STUB" && calls.includes("fn"));
  ok("an override wins", (await m.fn2()) === "OVERRIDE");
  ok("a class stays real (instanceof still works)", m.Err === Err && new m.Err() instanceof Err);
  let threw = ""; try { unstubbed("_mod")("ghost")(); } catch (e) { threw = String(e.message); }
  ok("⭐ the default outside kill-switch suites THROWS, naming the function", /unstubbed _mod\.ghost\(\)/.test(threw), threw);
  let noStub = ""; try { mockShape(real, {}); } catch (e) { noStub = String(e.message); }
  ok("a mock with no stub factory is refused (no silent real spread)", /stub factory is required/.test(noStub));
}

section("2 — ⭐⭐ every suite that mocks _bridge.mjs builds it from the REAL shape");
{
  const files = readdirSync("scripts").filter((f) => /\.(mjs|tsx)$/.test(f)).map((f) => `scripts/${f}`);
  const mocking = files.filter((f) => f !== "scripts/verify-mock-shape.mjs" && readFileSync(f, "utf8").includes('mock.module("../netlify/functions/_bridge.mjs"'));
  ok("the suites that mock _bridge.mjs were found", mocking.length >= 5, mocking.join(", "));
  const bad = mocking.filter((f) => {
    const s = readFileSync(f, "utf8"), i = s.indexOf('mock.module("../netlify/functions/_bridge.mjs"');
    const blk = s.slice(i, s.indexOf("});", i) + 3); // up to the call's own close, wherever it sits
    return !/mockShape\(/.test(blk) && !/\.\.\.[A-Za-z_$][\w$]*/.test(blk); // the real shape, or at least a spread of the real module
  });
  ok("⭐⭐ none lists _bridge.mjs's exports by hand", bad.length === 0, bad.join(", "));
  const pause = readFileSync("scripts/verify-pause-enforcement.mjs", "utf8");
  ok("⭐ the KILL-SWITCH suite defaults every _bridge function to a TRIPWIRE (never a real call, never a plain spread)",
    /mockShape\(realBridge,\s*\{\s*stub:\s*\(name\)\s*=>\s*tripwire\(name\)/.test(pause));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-mock-shape — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
