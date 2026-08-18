// _cid.mjs — derive the CIDv1 raw-codec content address ("bafkrei…") for a set of bytes.
//
// Extracted from pin-invariants.mjs so a second pinning path cannot carry a second copy of the
// derivation. ⚠️ Duplicated LOGIC drifts exactly like duplicated data, and this particular logic
// decides whether bytes are allowed to be published under an address a document asserts about
// itself — a divergence here would be silent and would only surface as a CID that addresses the
// wrong thing.
//
// The documents are all well under one IPFS chunk (256 KiB), so this raw single-block CID equals
// the raw LEAF stored under a pinned DAG. It is distinct from the dag-pb "bafybei…"/"Qm…" root a
// file-upload API returns — which is precisely why the second-operator work pins BY CID rather
// than by re-uploading bytes: the raw CID is the address the chain and the reports point at.
//
// Derivation: multibase 'b' + base32( 0x01 version | 0x55 raw codec | 0x12 sha256 | 0x20 len=32 | digest ).

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export function base32NoPad(bytes) {
  let bits = 0, val = 0, out = "";
  for (const b of bytes) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

/** @param {Buffer} sha256Buf the 32-byte sha256 digest of the bytes */
export function bafkreiRawCid(sha256Buf) {
  if (!sha256Buf || sha256Buf.length !== 32) throw new Error("bafkreiRawCid(): needs a 32-byte sha256 digest");
  return "b" + base32NoPad(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), sha256Buf]));
}

// ⚠️ Routing endpoints answer as either a {"Providers":[…]} envelope or NDJSON, and which one you
// get depends on content negotiation. Returns null for an unparseable body — NEVER an empty array,
// because "nothing announced" and "I could not read the answer" are different facts and collapsing
// them is how an absence comes to read as a measurement.
export function parseProviders(text) {
  if (!text) return null;
  try {
    const d = JSON.parse(text);
    if (Array.isArray(d?.Providers)) return d.Providers;
    if (Array.isArray(d)) return d;
  } catch { /* fall through to NDJSON */ }
  const lines = text.trim().split("\n").filter(Boolean);
  const out = [];
  let parsedAny = false;
  for (const l of lines) {
    try { const o = JSON.parse(l); parsedAny = true; out.push(...(Array.isArray(o.Providers) ? o.Providers : [o])); }
    catch { /* skip */ }
  }
  return parsedAny ? out : null;
}
