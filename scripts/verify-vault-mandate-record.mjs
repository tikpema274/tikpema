#!/usr/bin/env node
// verify-vault-mandate-record.mjs — the mandate RECORD: what the user authorised, the disclosure built
// from it, the acknowledgement that binds the two, and the store that holds it.
//
//   node scripts/verify-vault-mandate-record.mjs
//
// ═══ WHAT THIS RECORD IS ═════════════════════════════════════════════════════════════════════
// The standing authorisation for an agent to deposit, and on a finding to WITHDRAW, when no user is
// present. So the stored record is a security artefact, not config (the DCA mandate's rule). The
// shapes that would let it act on something the user did not agree to:
//   · a rule without an explicit pause/exit choice, silently defaulted
//   · a client-supplied owner baseline (a caller picks the owner the "changed" rule compares to)
//   · "exit" stored on a pause-only rule, caught only later at decide time
//   · a disclosure that does not match the rules it sits beside
//   · a rule changed after the acknowledgement, still acting on the old acknowledgement
//   · a record written straight into the store as already acknowledged
//
// ⚠️ The store is passed in (an in-memory fake with the same onlyIfNew / onlyIfMatch semantics as
// @netlify/blobs); the functions under test are the real ones.

import {
  buildMandateRecord, renderDisclosure, mandateFingerprint, verifyMandateRecord,
  acknowledgeMandate, amendMandateRules, MANDATE_STATUS, MANDATE_SCHEMA,
} from "../shared/vault-mandate/record.mjs";
import {
  writeNewMandate, readMandate, acknowledgeStoredMandate, createVaultMandate, vaultMandateKey,
} from "../netlify/functions/_vault-mandate-store.mjs";
import {
  EXIT_NOT_GUARANTEED, EXIT_FEE_RISE, VERIFIED_PARAGRAPH, MONITORED_PARAGRAPH, CHECKED_AFTER_PARAGRAPH,
} from "../shared/vault-mandate/copy.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const attempt = (fn) => { try { return fn(); } catch (e) { return { threw: String(e?.message ?? e) }; } };
const attemptAsync = async (fn) => { try { return await fn(); } catch (e) { return { threw: String(e?.message ?? e) }; } };
const show = (o) => JSON.stringify(o ?? null)?.slice(0, 180);
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── an in-memory store with @netlify/blobs' conditional-write semantics ──────────────────────
function fakeStore({ failReads = false } = {}) {
  const m = new Map(); let n = 0;
  return {
    _map: m,
    async get(key) { if (failReads) throw new Error("store down"); return m.has(key) ? clone(m.get(key).data) : null; },
    async getWithMetadata(key) {
      if (failReads) throw new Error("store down");
      return m.has(key) ? { data: clone(m.get(key).data), etag: m.get(key).etag } : null;
    },
    async setJSON(key, data, opts = {}) {
      if (opts.onlyIfNew && m.has(key)) return { modified: false };
      if (opts.onlyIfMatch !== undefined && (!m.has(key) || m.get(key).etag !== opts.onlyIfMatch)) return { modified: false };
      const etag = `"e${++n}"`; m.set(key, { data: clone(data), etag }); return { modified: true, etag };
    },
  };
}

const OWNER = "0xaaaa000000000000000000000000000000000001";
const WALLET = "0xbbbb000000000000000000000000000000000002";
const VAULT_OWNER = "0x94e0dc7ad29b94ec9819f6cec3364dd34f41b3c6";
const VAULT = { key: "xylo-usdc", address: "0x240Eb85458CD41361bd8C3773253a1D78054f747", chainId: 31337, label: "XyloNet USDC Vault (xyUSDC)" }; // fixture chain id (test:literals)
const BASELINE = { ok: true, owner: { address: VAULT_OWNER, kind: "eoa" }, reportBlock: 63960000, reportSigned: true, signerVerified: true, maxFeeBps: 2000, vaultAckToken: "ab".repeat(32) };
// Piece 4 (vault-mandate/2): deposit terms. test:mandatedeposit covers them; here they are only present.
const TERMS = { amountPerDepositUsdc: 10, maxTotalUsdc: 100, cadence: "weekly" };
const INPUT_RULES = [
  { kind: "power", subject: "upgradeable", onFinding: "exit" },
  { kind: "state", subject: "exit-fee-above", limitBps: 50, onFinding: "exit" },
  { kind: "state", subject: "owner-changed", onFinding: "pause" },
  { kind: "state", subject: "vault-cannot-pay", onFinding: "pause" },
];
// ⚠️ INPUT_RULES carries EXIT rules, which creation refuses until piece 5 (EXIT_AVAILABLE = false; proven in
// test:mandatedeposit). This suite pins the record's semantics for the exit shapes piece 5 will enable, so its
// builder passes the seam `exitAvailable: true`. The CREATE path (section 5) never does, and uses pause rules.
const PAUSE_RULES = INPUT_RULES.map((r) => ({ ...r, onFinding: "pause" }));
const NOW = Date.parse("2026-09-25T12:00:00Z");
const build = (over = {}) => attempt(() => buildMandateRecord({
  owner: OWNER, walletAddress: WALLET, vault: VAULT, terms: TERMS, rules: INPUT_RULES, baseline: BASELINE, now: NOW, id: "vm-1", exitAvailable: true, ...over }));
const refusedWith = (r, needle) => r?.ok === false && (!needle || (r.errors ?? []).join(" | ").includes(needle));

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  VAULT MANDATE — the record, its disclosure, its acknowledgement     ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — building the record: what the user wrote, nothing defaulted");
const built = build();
const rec = built?.record;
{
  ok("a well-formed request builds a record", built?.ok === true, show(built?.errors ?? built?.threw));
  ok("  schema, owner from the session argument, wallet, vault", rec?.schema === MANDATE_SCHEMA && rec?.owner === OWNER && rec?.walletAddress === WALLET && rec?.vault?.key === "xylo-usdc");
  ok("  it starts AWAITING the acknowledgement, not active", rec?.status === MANDATE_STATUS.AWAITING_ACK && rec?.ack === null);
  ok("  every stored rule states its choice explicitly", rec?.rules?.length === 4 && rec.rules.every((r) => r.onFinding === "pause" || r.onFinding === "exit"));
  ok("  rule ids are assigned by the server", rec?.rules?.every((r, i) => r.id === `r${i + 1}`), show(rec?.rules?.map((r) => r.id)));
  const own = rec?.rules?.find((r) => r.subject === "owner-changed");
  ok("⭐ the owner rule stores the owner AS IT WAS AT CREATION, from the signed baseline", own?.baselineOwner === VAULT_OWNER, show(own));
  ok("  the baseline itself is recorded (owner, kind, report block, fee cap)",
    rec?.baseline?.owner === VAULT_OWNER && rec?.baseline?.ownerKind === "eoa" && rec?.baseline?.reportBlock === 63960000 && rec?.baseline?.maxFeeBps === 2000, show(rec?.baseline));
  ok("  a 64-hex fingerprint", /^[0-9a-f]{64}$/.test(rec?.fingerprint ?? ""));

  ok("a rule with NO onFinding → refused, not defaulted",
    refusedWith(build({ rules: [{ kind: "power", subject: "upgradeable" }] }), "onFinding"));
  ok("⭐ a client-supplied baselineOwner → refused (the server records the baseline)",
    refusedWith(build({ rules: [{ kind: "state", subject: "owner-changed", onFinding: "pause", baselineOwner: OWNER }] }), "baselineOwner"));
  ok("a client-supplied rule id → refused (unknown field)", refusedWith(build({ rules: [{ id: "x", kind: "power", subject: "upgradeable", onFinding: "pause" }] }), "id"));
  ok("⭐⭐ exit on vault-cannot-pay → refused AT WRITE TIME (build)",
    refusedWith(build({ rules: [{ kind: "state", subject: "vault-cannot-pay", onFinding: "exit" }] }), "vault-cannot-pay"));
  ok("⭐⭐ exit on redemption-restricted → refused at build",
    refusedWith(build({ rules: [{ kind: "state", subject: "redemption-restricted", onFinding: "exit" }] }), "redemption-restricted"));
  ok("an owner rule when the baseline owner could not be read → refused (no baseline to compare to)",
    refusedWith(build({ baseline: { ...BASELINE, owner: { address: null, kind: "unreadable" } } }), "owner"));
  ok("a baseline from an UNSIGNED report → refused", refusedWith(build({ baseline: { ...BASELINE, reportSigned: false } }), "signed"));
  ok("a baseline whose signer was NOT verified → refused", refusedWith(build({ baseline: { ...BASELINE, signerVerified: false } }), "signer"));
  ok("a failed baseline read → refused", refusedWith(build({ baseline: { ok: false, why: "dd engine down" } }), "baseline"));
  ok("no vault → refused", refusedWith(build({ vault: null }), "vault"));
  ok("no owner (no session) → refused", refusedWith(build({ owner: null }), "owner"));
  ok("an empty rule list → refused", refusedWith(build({ rules: [] })));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — the disclosure is BUILT FROM the record");
{
  const text = rec?.disclosure?.text ?? "";
  const lines = rec?.disclosure?.ruleLines ?? [];
  ok("one rule line per rule", lines.length === rec?.rules?.length, `${lines.length} lines`);
  ok("⭐ each line says 'if found: <that rule's choice>'",
    lines.length === 4 && rec.rules.every((r, i) => lines[i].endsWith(`if found: ${r.onFinding}.`)), show(lines));
  ok("  …and every rule line appears in the text", lines.length > 0 && lines.every((l) => text.includes(l)));
  ok("the owner line names the owner recorded at creation", lines[2]?.includes(VAULT_OWNER), lines[2]);
  ok("the fee line names the limit", /0\.50%/.test(lines[1] ?? ""), lines[1]);
  ok("power + owner lines say VERIFIED, fee + payability lines say MONITORED",
    /verified/i.test(lines[0] ?? "") && /verified/i.test(lines[2] ?? "") && /monitored/i.test(lines[1] ?? "") && /monitored/i.test(lines[3] ?? ""), show(lines));
  ok("a pause-only rule's line says it can only pause", /can only pause/i.test(lines[3] ?? ""), lines[3]);
  ok("⭐ 'An exit is not guaranteed …' verbatim", text.includes(EXIT_NOT_GUARANTEED));
  ok("⭐ the fee-rise sentence verbatim", text.includes(EXIT_FEE_RISE));
  ok("  …with this vault's fee cap beside it (20.00%)", /20\.00%/.test(text));
  ok("verified / monitored / checked-after paragraphs verbatim",
    text.includes(VERIFIED_PARAGRAPH) && text.includes(MONITORED_PARAGRAPH) && text.includes(CHECKED_AFTER_PARAGRAPH));
  const r2 = attempt(() => renderDisclosure(rec));
  ok("renderDisclosure(record) reproduces the stored disclosure exactly", r2?.text === text && JSON.stringify(r2?.ruleLines) === JSON.stringify(lines));
  const noCap = build({ baseline: { ...BASELINE, maxFeeBps: null } })?.record?.disclosure?.text ?? "";
  ok("an unreadable fee cap is SAID, not omitted", /cap could not be read/i.test(noCap), noCap.slice(0, 0));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐⭐ the acknowledgement binds the rules AND the disclosure");
{
  const v0 = attempt(() => verifyMandateRecord(rec));
  ok("a fresh record verifies, but may NOT act before the acknowledgement", v0?.ok === true && v0?.mayAct === false, show(v0));
  const acked = attempt(() => acknowledgeMandate(rec, rec?.fingerprint, NOW + 1000));
  ok("acknowledged with its own fingerprint → ACTIVE", acked?.ok === true && acked?.record?.status === MANDATE_STATUS.ACTIVE, show(acked?.errors ?? acked?.threw));
  ok("  …and now it may act", attempt(() => verifyMandateRecord(acked?.record))?.mayAct === true);
  // The fingerprint must bind BOTH halves directly, not only through verify's re-render: each is
  // changed alone here, with the other held fixed.
  const fp0 = attempt(() => mandateFingerprint(rec));
  const textOnly = clone(rec ?? {}); if (textOnly.disclosure) textOnly.disclosure.text += " ";
  ok("⭐ the fingerprint moves when ONLY the disclosure text changes", typeof fp0 === "string" && attempt(() => mandateFingerprint(textOnly)) !== fp0);
  const linesOnly = clone(rec ?? {}); if (linesOnly.disclosure?.ruleLines) linesOnly.disclosure.ruleLines[0] += " ";
  ok("⭐ the fingerprint moves when ONLY a disclosure rule line changes", typeof fp0 === "string" && attempt(() => mandateFingerprint(linesOnly)) !== fp0);
  const rulesOnly = clone(rec ?? {}); if (rulesOnly.rules) rulesOnly.rules[1].limitBps = 51;
  ok("⭐ the fingerprint moves when ONLY a rule changes (disclosure held fixed)", typeof fp0 === "string" && attempt(() => mandateFingerprint(rulesOnly)) !== fp0);
  const choiceOnly = clone(rec ?? {}); if (choiceOnly.rules) choiceOnly.rules[0].onFinding = "pause";
  ok("⭐ …including only a pause/exit choice", typeof fp0 === "string" && attempt(() => mandateFingerprint(choiceOnly)) !== fp0);
  ok("acknowledged with a WRONG fingerprint → refused", refusedWith(attempt(() => acknowledgeMandate(rec, "0".repeat(64), NOW))));
  ok("acknowledging with no fingerprint → refused", refusedWith(attempt(() => acknowledgeMandate(rec, undefined, NOW))));

  const active = acked?.record;
  const changed = clone(active ?? {}); if (changed.rules) changed.rules[1].onFinding = "pause";
  const vc = attempt(() => verifyMandateRecord(changed));
  ok("⭐⭐ a rule changed AFTER the acknowledgement (exit → pause) → may NOT act", vc?.mayAct === false, show(vc));
  const lim = clone(active ?? {}); if (lim.rules) lim.rules[1].limitBps = 5000;
  ok("⭐ a limit changed after the acknowledgement → may NOT act", attempt(() => verifyMandateRecord(lim))?.mayAct === false);

  // A consistent rewrite: rules changed, disclosure re-rendered, fingerprint recomputed, old ack kept.
  const rewritten = clone(active ?? {});
  if (rewritten.rules) {
    rewritten.rules[1].limitBps = 5000;
    rewritten.disclosure = attempt(() => renderDisclosure(rewritten));
    rewritten.fingerprint = attempt(() => mandateFingerprint(rewritten));
  }
  const vr = attempt(() => verifyMandateRecord(rewritten));
  ok("⭐⭐ rules + disclosure + fingerprint rewritten consistently, OLD ack kept → STALE, may NOT act",
    vr?.ok === true && vr?.mayAct === false && (vr?.errors ?? []).join(" ").match(/stale|acknowledg/i), show(vr));

  // A disclosure that does not match the rules, with a fingerprint computed over that mismatch.
  const lying = clone(active ?? {});
  if (lying.disclosure?.ruleLines) {
    lying.disclosure.ruleLines[1] = lying.disclosure.ruleLines[1].replace("if found: exit.", "if found: pause.");
    lying.disclosure.text = lying.disclosure.text.replace("if found: exit.", "if found: pause.");
    lying.fingerprint = attempt(() => mandateFingerprint(lying));
    lying.ack = { fingerprint: lying.fingerprint, at: new Date(NOW).toISOString() };
  }
  const vl = attempt(() => verifyMandateRecord(lying));
  ok("⭐⭐ a disclosure that does NOT match its rules → refused, even with a matching fingerprint and ack",
    vl?.ok === false && vl?.mayAct === false && /disclosure/i.test((vl?.errors ?? []).join(" ")), show(vl));

  const exitOnPauseOnly = clone(active ?? {});
  if (exitOnPauseOnly.rules) {
    exitOnPauseOnly.rules[3].onFinding = "exit";
    exitOnPauseOnly.disclosure = attempt(() => renderDisclosure(exitOnPauseOnly));
    exitOnPauseOnly.fingerprint = attempt(() => mandateFingerprint(exitOnPauseOnly));
    exitOnPauseOnly.ack = { fingerprint: exitOnPauseOnly.fingerprint, at: "x" };
  }
  ok("⭐ a hand-built record storing exit on vault-cannot-pay → refused by verify",
    attempt(() => verifyMandateRecord(exitOnPauseOnly))?.ok === false);

  ok("status active but no ack → may NOT act", attempt(() => verifyMandateRecord({ ...clone(active ?? {}), ack: null }))?.mayAct === false);
  ok("an unknown status → may NOT act", attempt(() => verifyMandateRecord({ ...clone(active ?? {}), status: "running" }))?.mayAct === false);
  ok("the wrong schema → refused", attempt(() => verifyMandateRecord({ ...clone(active ?? {}), schema: "vault-mandate/0" }))?.ok === false);

  const am = attempt(() => amendMandateRules(active, [{ kind: "state", subject: "exit-fee-above", limitBps: 100, onFinding: "pause" }], NOW + 5000));
  ok("amending the rules → a record AWAITING a fresh acknowledgement", am?.ok === true && am?.record?.status === MANDATE_STATUS.AWAITING_ACK && am?.record?.ack === null, show(am?.errors ?? am?.threw));
  ok("  …with a new fingerprint", am?.record?.fingerprint && am.record.fingerprint !== active?.fingerprint);
  ok("  …the OLD acknowledgement's fingerprint does not activate it", refusedWith(attempt(() => acknowledgeMandate(am?.record, active?.fingerprint, NOW))));
  ok("  …the new one does", attempt(() => acknowledgeMandate(am?.record, am?.record?.fingerprint, NOW))?.ok === true);
  ok("  …the baseline is carried over, not re-read from the request", am?.record?.baseline?.owner === VAULT_OWNER);
  ok("amending with exit on a pause-only rule → refused", refusedWith(attempt(() => amendMandateRules(active, [{ kind: "state", subject: "vault-cannot-pay", onFinding: "exit" }], NOW))));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — the store: write-time checks, re-verified on read, CAS on acknowledge");
{
  const st = fakeStore();
  const w = await attemptAsync(() => writeNewMandate({ store: st, record: rec }));
  ok("a valid new record is written", w?.ok === true && st._map.has(vaultMandateKey(OWNER, "vm-1")), show(w));
  ok("the key is owner-scoped", vaultMandateKey(OWNER, "vm-1") === `m/${OWNER}/vm-1`);
  ok("writing the same id again → refused (onlyIfNew)", (await attemptAsync(() => writeNewMandate({ store: st, record: rec })))?.ok === false);

  const bad = clone(rec ?? {});
  if (bad.rules) {
    bad.id = "vm-bad"; bad.rules[3].onFinding = "exit";
    bad.disclosure = attempt(() => renderDisclosure(bad)); bad.fingerprint = attempt(() => mandateFingerprint(bad));
  }
  const s2 = fakeStore();
  const wb = await attemptAsync(() => writeNewMandate({ store: s2, record: bad }));
  ok("⭐⭐ a record storing EXIT on a pause-only rule → refused AT WRITE, nothing stored", wb?.ok === false && s2._map.size === 0, show(wb));

  const mis = clone(rec ?? {}); if (mis.disclosure) { mis.id = "vm-mis"; mis.disclosure.text += "\nextra"; mis.fingerprint = attempt(() => mandateFingerprint(mis)); }
  const wm = await attemptAsync(() => writeNewMandate({ store: s2, record: mis }));
  ok("⭐ a record whose disclosure does not match its rules → refused at write, nothing stored", wm?.ok === false && s2._map.size === 0, show(wm));

  // Internally consistent (fingerprint recomputed for the new id) so the ONLY thing wrong is that it is
  // already active — otherwise the write is refused for a fingerprint mismatch and this proves nothing.
  const pre = clone(rec ?? {}); pre.id = "vm-pre"; pre.fingerprint = attempt(() => mandateFingerprint(pre));
  pre.status = MANDATE_STATUS.ACTIVE; pre.ack = { fingerprint: pre.fingerprint, at: "x" };
  ok("  (control: that pre-activated record is otherwise valid and would act)", attempt(() => verifyMandateRecord(pre))?.mayAct === true);
  ok("⭐ a NEW record written already ACTIVE → refused (an acknowledgement only comes through acknowledge)",
    (await attemptAsync(() => writeNewMandate({ store: s2, record: pre })))?.ok === false && s2._map.size === 0);

  const r = await attemptAsync(() => readMandate({ store: st, owner: OWNER, id: "vm-1" }));
  ok("read back: readable, verified, not yet actable", r?.readable === true && r?.record?.id === "vm-1" && r?.verdict?.ok === true && r?.verdict?.mayAct === false, show(r?.verdict ?? r?.threw));
  ok("read with ANOTHER owner → absent", (await attemptAsync(() => readMandate({ store: st, owner: WALLET, id: "vm-1" })))?.record === null);
  const down = await attemptAsync(() => readMandate({ store: fakeStore({ failReads: true }), owner: OWNER, id: "vm-1" }));
  ok("⭐ a store that cannot be read → readable:false, NOT 'no mandate'", down?.readable === false && down?.record === null, show(down));

  const bad1 = await attemptAsync(() => acknowledgeStoredMandate({ store: st, owner: OWNER, id: "vm-1", fingerprint: "f".repeat(64), now: NOW }));
  ok("acknowledging with the wrong fingerprint → refused, record still awaiting", bad1?.ok === false &&
    st._map.get(vaultMandateKey(OWNER, "vm-1"))?.data?.status === MANDATE_STATUS.AWAITING_ACK, show(bad1));
  const good = await attemptAsync(() => acknowledgeStoredMandate({ store: st, owner: OWNER, id: "vm-1", fingerprint: rec?.fingerprint, now: NOW }));
  ok("acknowledging with the right fingerprint → ACTIVE in the store", good?.ok === true &&
    st._map.get(vaultMandateKey(OWNER, "vm-1"))?.data?.status === MANDATE_STATUS.ACTIVE, show(good));
  const after = await attemptAsync(() => readMandate({ store: st, owner: OWNER, id: "vm-1" }));
  ok("  …and read back it may act", after?.verdict?.mayAct === true);

  // Tampered in the store after the acknowledgement: re-verified on read, never trusted because it was checked on write.
  const key = vaultMandateKey(OWNER, "vm-1");
  if (st._map.has(key)) { const t = clone(st._map.get(key).data); t.rules[0].onFinding = "pause"; st._map.set(key, { data: t, etag: '"tampered"' }); }
  const tr = await attemptAsync(() => readMandate({ store: st, owner: OWNER, id: "vm-1" }));
  ok("⭐ a record changed in the store after acknowledgement → read back it may NOT act", tr?.verdict?.mayAct === false, show(tr?.verdict));

  // CAS: the record changes between the acknowledge's read and write.
  const s3 = fakeStore(); await attemptAsync(() => writeNewMandate({ store: s3, record: rec }));
  const origGet = s3.getWithMetadata.bind(s3);
  s3.getWithMetadata = async (k) => { const r0 = await origGet(k); await s3.setJSON(k, r0.data); return r0; }; // someone writes in between
  const race = await attemptAsync(() => acknowledgeStoredMandate({ store: s3, owner: OWNER, id: "vm-1", fingerprint: rec?.fingerprint, now: NOW }));
  ok("⭐ the record changed under the acknowledge → refused (CAS), not overwritten", race?.ok === false, show(race));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — creating under a verified session");
{
  const deps = (over = {}) => ({ store: fakeStore(), now: () => NOW, newId: () => "vm-new",
    resolveVault: (k) => (k === "xylo-usdc" ? VAULT : null), readBaseline: async () => BASELINE, ...over });
  const d = deps();
  const c = await attemptAsync(() => createVaultMandate({ session: { address: OWNER }, walletAddress: WALLET, input: { vault: "xylo-usdc", ...TERMS, rules: PAUSE_RULES }, deps: d }));
  ok("created: written AWAITING acknowledgement, fingerprint returned to show the user",
    c?.ok === true && c?.record?.status === MANDATE_STATUS.AWAITING_ACK && c?.fingerprint === c?.record?.fingerprint && d.store._map.size === 1, show(c?.errors ?? c?.threw));
  ok("  …owned by the SESSION address", c?.record?.owner === OWNER);
  ok("  …carrying the terms sent and the baseline's vault ack token", c?.record?.terms?.amountPerDepositUsdc === 10 && c?.record?.baseline?.vaultAckToken === BASELINE.vaultAckToken);
  const ex5 = deps();
  const cx = await attemptAsync(() => createVaultMandate({ session: { address: OWNER }, walletAddress: WALLET, input: { vault: "xylo-usdc", ...TERMS, rules: INPUT_RULES }, deps: ex5 }));
  ok("⭐ exit rules via the create path → refused until piece 5, nothing written", cx?.ok === false && ex5.store._map.size === 0 && /cannot exit yet/.test((cx?.errors ?? []).join(" ")), show(cx));
  const spoof = await attemptAsync(() => createVaultMandate({ session: { address: OWNER }, walletAddress: WALLET,
    input: { vault: "xylo-usdc", ...TERMS, rules: PAUSE_RULES, owner: WALLET }, deps: deps() }));
  ok("⭐ an owner in the request body → refused (the owner is the session)", spoof?.ok === false, show(spoof));
  const noS = deps();
  ok("no session → refused, nothing written",
    (await attemptAsync(() => createVaultMandate({ session: null, walletAddress: WALLET, input: { vault: "xylo-usdc", ...TERMS, rules: PAUSE_RULES }, deps: noS })))?.ok === false && noS.store._map.size === 0);
  const unk = deps();
  ok("a vault not on the allowlist → refused, nothing written",
    (await attemptAsync(() => createVaultMandate({ session: { address: OWNER }, walletAddress: WALLET, input: { vault: "0x240Eb85458CD41361bd8C3773253a1D78054f747", ...TERMS, rules: PAUSE_RULES }, deps: unk })))?.ok === false && unk.store._map.size === 0);
  const fb = deps({ readBaseline: async () => ({ ok: false, why: "signer could not be verified" }) });
  const cf = await attemptAsync(() => createVaultMandate({ session: { address: OWNER }, walletAddress: WALLET, input: { vault: "xylo-usdc", ...TERMS, rules: PAUSE_RULES }, deps: fb }));
  ok("the baseline could not be read → refused, nothing written, the reason carried", cf?.ok === false && fb.store._map.size === 0 && /signer/.test((cf?.errors ?? []).join(" ")), show(cf));
  const ex = deps();
  ok("⭐ exit on vault-cannot-pay via the create path → refused, nothing written",
    (await attemptAsync(() => createVaultMandate({ session: { address: OWNER }, walletAddress: WALLET,
      input: { vault: "xylo-usdc", rules: [{ kind: "state", subject: "vault-cannot-pay", onFinding: "exit" }] }, deps: ex })))?.ok === false && ex.store._map.size === 0);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
