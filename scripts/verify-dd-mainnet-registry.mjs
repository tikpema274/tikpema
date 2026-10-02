// verify-dd-mainnet-registry.mjs — DD Morpho V2, STEP 1: the Arc mainnet entry in DD's chain registry and its PINS.
//
// ═══ WHAT IS PINNED, AND WHY THESE VALUES (2026-10-02, PROGRESS "DD MORPHO V2 — STEP 0") ════════════════════════
// Each pin is the runtime keccak of a singleton on Arc mainnet (5042), read at block 23889038 on BOTH
// rpc.mainnet.arc.io and arc-mainnet.drpc.org (agreed), and REPRODUCED from Morpho's tagged source by a local forge
// build: vault-v2 2026-08-13 (VaultV2Factory + MorphoVaultV1AdapterFactory exact; MorphoMarketV1AdapterV2Factory
// masked, immutables checked), morpho-blue-irm 2025-11-24 (AdaptiveCurveIrm, masked), morpho-blue v1.0.0 (Morpho Blue,
// masked, built with bytecode_hash=none: the ONE deviation, ruled by T 10-02, carried WITH the pin). All seven contracts
// verified on explorer.arc.io (T, by hand). T approved all five pins.
// ⛔ The expected values below are LITERAL BY DESIGN: a suite that imported its expectations from the registry would
// test nothing. A changed pin must change here too, in a reviewed edit (and it rotates ddTree, which is intended).
//
// Offline. The read-only chain proof is scripts/dd/prove-mainnet-pins.mjs (network; not in test:all).

import { readFileSync } from "node:fs";
import { getAddress } from "viem";
import * as REG from "../shared/dd/chains.mjs";
import * as EP from "../shared/onchain-analyze/endpoints.mjs";
import { SUPPORTED_CHAINS } from "../netlify/functions/_dd-descriptor.mjs";

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 70 - t.length))}`);

const EXPECT = {
  morphoBlue: { address: "0x34CD04070dD72b14E241112F6d83812Df5Af7fCD", codeHash: "0xeb0972f2c33d0d3443136e2c42688082b9eef4ff1594a32e890f4f08669f1b08", match: "masked" },
  adaptiveCurveIrm: { address: "0xF02615d094Fc02fC031C35fe705e175aA4653f20", codeHash: "0xb89ab90e08f8cf6f3ff4916f5d64d27ea1b86bdcb02c92c18690677184074d43", match: "masked" },
  vaultV2Factory: { address: "0x3b0eefaBfa22ec7CF2c73877ac16e78D76749f12", codeHash: "0xba55eb73d42937607d7e3c77f68353c2517c4fad4df02f0c9bbd2e4248475503", match: "exact" },
  morphoMarketV1AdapterV2Factory: { address: "0x6C2FF5114E45b50bc7195c2F1f87C98cbdad62Cc", codeHash: "0x6b28fe49a51d2abbe3a345b618e16c26b94e381c5390d7532511fd888935c2db", match: "masked" },
  morphoVaultV1AdapterFactory: { address: "0x77788033B22CEaB8D51Ec8F9dFD4a40E54F380B0", codeHash: "0x4e1024d5bfd17914a3ca6ad49905eabdfd60122ccd5a577406e7a4a765bd49ad", match: "exact" },
};

section("1 — the Arc mainnet entry exists and says what chain it is");
let c = null;
try { c = REG.getChain("arc-mainnet"); } catch (e) { ok("getChain('arc-mainnet') resolves", false, e.message); }
if (c) ok("getChain('arc-mainnet') resolves", true);
ok("⭐ id 5042 (0x13b2, measured on both endpoints)", c?.id === 5042, String(c?.id));
ok("rpc is Arc's public mainnet endpoint", c?.rpc === "https://rpc.mainnet.arc.io", c?.rpc);
ok("explorer is explorer.arc.io (where T verified the seven)", c?.explorer === "https://explorer.arc.io", c?.explorer);
ok("label says mainnet", /mainnet/i.test(c?.label ?? ""), c?.label);

section("2 — ⭐⭐ the five pins: exactly the reproduced values");
const pins = c?.pins ?? null;
ok("the entry carries pins", !!pins && typeof pins === "object");
ok("⭐ exactly these five pins, no more (a pin nobody reproduced is never trusted)",
  !!pins && Object.keys(pins).sort().join(",") === Object.keys(EXPECT).sort().join(","), Object.keys(pins ?? {}).join(","));
for (const [k, e] of Object.entries(EXPECT)) {
  const p = pins?.[k];
  ok(`⭐⭐ ${k}: address + codeHash are the reproduced ones`, p?.address === e.address && p?.codeHash === e.codeHash, `${p?.address} ${p?.codeHash?.slice(0, 12)}`);
  ok(`  ${k}: address is checksummed, codeHash is 32 bytes`, !!p && getAddress(p.address) === p.address && /^0x[0-9a-f]{64}$/.test(p.codeHash));
  ok(`  ${k}: records how it matched (${e.match}) and the source it was rebuilt from`, p?.match === e.match && typeof p?.source === "string" && p.source.length > 10, `${p?.match} / ${p?.source}`);
}
ok("⭐ Morpho Blue's pin CARRIES its deviation (bytecode_hash=none), so it never reads as a plain tag match",
  /bytecode_hash\s*=\s*none/.test(pins?.morphoBlue?.deviation ?? ""), pins?.morphoBlue?.deviation?.slice(0, 80));
ok("…and no other pin claims a deviation", Object.entries(pins ?? {}).every(([k, p]) => k === "morphoBlue" || p.deviation === undefined));
const sources = Object.fromEntries(Object.entries(pins ?? {}).map(([k, p]) => [k, p.source]));
ok("the vault-v2 pins name tag 2026-08-13; the IRM 2025-11-24; Morpho Blue v1.0.0",
  ["vaultV2Factory", "morphoMarketV1AdapterV2Factory", "morphoVaultV1AdapterFactory"].every((k) => /vault-v2/.test(sources[k] ?? "") && /2026-08-13/.test(sources[k] ?? "")) &&
  /morpho-blue-irm/.test(sources.adaptiveCurveIrm ?? "") && /2025-11-24/.test(sources.adaptiveCurveIrm ?? "") &&
  /morpho-blue/.test(sources.morphoBlue ?? "") && /v1\.0\.0/.test(sources.morphoBlue ?? ""), JSON.stringify(sources).slice(0, 120));

section("3 — the pins cannot be changed at runtime");
ok("⭐ pins and every pin are frozen", !!pins && Object.isFrozen(pins) && Object.values(pins).every((p) => Object.isFrozen(p)));
if (pins) { try { pins.morphoBlue.codeHash = "0x00"; } catch {} }
ok("…an assignment does not take", pins?.morphoBlue?.codeHash === EXPECT.morphoBlue.codeHash);

section("4 — the mainnet quorum endpoints: two, distinct, and separate from the testnet list");
const M = EP.ARC_MAINNET_QUORUM_ENDPOINTS;
ok("ARC_MAINNET_QUORUM_ENDPOINTS exists and is frozen", Array.isArray(M) && Object.isFrozen(M), String(M));
ok("⭐ exactly the two measured endpoints (distinct front ends, 2026-10-02)",
  Array.isArray(M) && M.length === 2 && M[0] === "https://rpc.mainnet.arc.io" && M[1] === "https://arc-mainnet.drpc.org", String(M));
const host = (u) => new URL(u).host;
ok("…two different hosts", Array.isArray(M) && new Set(M.map(host)).size === 2);
ok("⭐ no host shared with the TESTNET quorum list (that list, and its consumers, are untouched)",
  Array.isArray(M) && !M.some((u) => EP.ARC_QUORUM_ENDPOINTS.map(host).includes(host(u))));

section("5 — ⛔ registering the chain does NOT open the paid endpoint (09-28 decision 1)");
ok("⭐⭐ the paid surface's SUPPORTED_CHAINS is still exactly [arc-testnet]",
  SUPPORTED_CHAINS.length === 1 && SUPPORTED_CHAINS[0] === "arc-testnet" && !SUPPORTED_CHAINS.includes("arc-mainnet"), JSON.stringify(SUPPORTED_CHAINS));

section("6 — wiring");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
ok("this suite is in test:all", (pkg.suites || []).includes("test:ddmainnetregistry") && /verify-dd-mainnet-registry\.mjs/.test(pkg.scripts?.["test:ddmainnetregistry"] ?? ""));

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0\n`);
