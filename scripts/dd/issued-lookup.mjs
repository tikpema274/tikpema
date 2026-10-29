#!/usr/bin/env node
// issued-lookup.mjs — READ-ONLY: which DD reports were issued, about what, saying what.
//
//   npm run dd:issued -- [--subject 0x…] [--shape eip1967-transparent] [--owner-kind renounced]
//                        [--power upgradeable] [--path deposit-disclosure] [--since 2026-10-29] [--json]
//
// Reads the `dd-issued` store (netlify/functions/_dd-issued.mjs) with the Netlify CLI's own login, the same
// way bridge-discover-run does. Lists only; never writes. Records exist from the deploy that shipped the
// store onward — nothing earlier can be listed except the paid reports in `dd-analyze-pending`.
//
// ⚠️ A record names a subject and what was said about it, never who was told (T, 2026-10-29).
// The canonHash links a record to a signed report: sha256 of canon/1 (attest.mjs canonicalize).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getStore } from "@netlify/blobs";
import { DD_ISSUED_STORE } from "../../netlify/functions/_dd-issued.mjs";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const want = {
  subject: opt("subject")?.toLowerCase() ?? null,
  shape: opt("shape"), ownerKind: opt("owner-kind"), power: opt("power"), path: opt("path"), since: opt("since"),
};

const cfg = JSON.parse(readFileSync(join(homedir(), ".config", "netlify", "config.json"), "utf8"));
const token = cfg.users[Object.keys(cfg.users)[0]].auth.token;
const siteID = JSON.parse(readFileSync(".netlify/state.json", "utf8")).siteId;
const store = getStore({ name: DD_ISSUED_STORE, siteID, token });

// Keys are `<ISO time>-<uuid>`, so --since narrows by key before any record is fetched.
const keys = [];
for await (const page of store.list({ paginate: true })) for (const b of page.blobs) keys.push(b.key);
const inRange = keys.filter((k) => !want.since || k >= want.since).sort();

const rows = [];
for (const k of inRange) {
  const r = await store.get(k, { type: "json", consistency: "strong" });
  if (!r) continue;
  if (want.subject && r.subject?.address !== want.subject) continue;
  if (want.shape && r.shape?.class !== want.shape) continue;
  if (want.ownerKind && r.owner?.kind !== want.ownerKind) continue;
  if (want.power && !(r.powersPresent ?? []).includes(want.power)) continue;
  if (want.path && r.path !== want.path) continue;
  rows.push(r);
}

if (args.includes("--json")) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
console.log(`${rows.length} of ${keys.length} record(s) match${inRange.length !== keys.length ? ` (${inRange.length} since ${want.since})` : ""}`);
for (const r of rows) {
  console.log(`${r.issuedAt}  ${r.path.padEnd(18)} ${r.subject.address} @${r.subject.blockNumber}  ${r.shape.class}  owner:${r.owner.kind}` +
    `  powers:[${r.powersPresent.join(",")}]${r.shown ? `  shown:${r.shown.level}[${r.shown.warnCodes.join(",")}]` : ""}  canon:${r.canonHash.slice(0, 16)}…`);
}
