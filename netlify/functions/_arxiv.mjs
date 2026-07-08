// _arxiv.mjs — arXiv academic-paper search for the deeper-research capability.
// FREE public API (export.arxiv.org), no key, no wallet, no payment — a plain GET.
//
// PURE fetch + DEFENSIVE Atom-XML parse. Fail-safe by construction:
//   - a paper is emitted ONLY if ALL required fields (title, summary, id/absLink,
//     date/year, authors) extract cleanly; any partial/malformed entry is DROPPED
//     (never a half-parsed or mangled citation),
//   - malformed / empty / non-XML input → [],
//   - never throws.
// The STRICT LLM relevance filter lives in _research.mjs (this module stays
// LLM-free, so no circular import). arXiv etiquette: ~1 request / 3s — we do ONE
// request per brief, well within it.

const ARXIV_ENDPOINT = "https://export.arxiv.org/api/query";
const MAX_RESULTS = 6;
const QUERY_MAX = 200;
const FETCH_TIMEOUT_MS = 8000;

// Decode the small set of XML entities arXiv emits (&amp; last, so it can't
// double-decode an already-decoded entity).
function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
const clean = (s) => decodeXml(String(s).replace(/\s+/g, " ").trim());

// First <tag>…</tag> inner text within a block, or null if absent.
function tagText(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : null;
}

// Parse one <entry> into a fully-formed paper, or null if ANY required field is
// missing / malformed. Drop, never emit a partial.
function parseEntry(block) {
  try {
    const rawTitle = tagText(block, "title");
    const rawSummary = tagText(block, "summary");
    const rawId = tagText(block, "id");
    const rawPublished = tagText(block, "published");
    if (!rawTitle || !rawSummary || !rawId || !rawPublished) return null;

    const title = clean(rawTitle);
    const summary = clean(rawSummary);
    if (!title || !summary) return null;

    // <id> looks like http://arxiv.org/abs/2209.15001v3 → arXiv id + https abs URL.
    const idMatch = clean(rawId).match(/arxiv\.org\/abs\/(\S+)$/i);
    if (!idMatch) return null;
    const arxivId = idMatch[1];
    const absLink = `https://arxiv.org/abs/${arxivId}`;

    // published → 4-digit year (required, must be sane).
    const year = clean(rawPublished).slice(0, 4);
    if (!/^\d{4}$/.test(year)) return null;

    // authors: every <name>…</name> (required — at least one).
    const names = [...block.matchAll(/<name(?:\s[^>]*)?>([\s\S]*?)<\/name>/g)]
      .map((m) => clean(m[1]))
      .filter(Boolean);
    if (!names.length) return null;
    const authors = names.length > 3 ? `${names.slice(0, 3).join(", ")} et al.` : names.join(", ");

    // PDF link (best-effort; falls back to the canonical pdf URL for this id).
    const pdfMatch =
      block.match(/<link[^>]*type="application\/pdf"[^>]*href="([^"]+)"/) ||
      block.match(/<link[^>]*href="([^"]+)"[^>]*type="application\/pdf"/);
    const pdfLink = pdfMatch ? pdfMatch[1].replace(/^http:/, "https:") : `https://arxiv.org/pdf/${arxivId}`;

    return { arxivId, title, summary, authors, year, absLink, pdfLink };
  } catch {
    return null; // any hiccup → drop this paper
  }
}

// Parse the Atom feed into clean papers. Malformed / empty / non-XML → [].
export function parseAtom(xml) {
  try {
    if (typeof xml !== "string" || !xml.includes("<entry")) return [];
    const entries = [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
    return entries.map(parseEntry).filter(Boolean);
  } catch {
    return [];
  }
}

// Fetch + parse. `query` is a focused academic search string (classifier-built).
// Returns papers[] or [] on any failure (never throws).
export async function searchArxiv({ query } = {}) {
  try {
    const q = String(query || "").trim().slice(0, QUERY_MAX);
    if (!q) return [];
    const url =
      `${ARXIV_ENDPOINT}?search_query=all:${encodeURIComponent(q)}` +
      `&start=0&max_results=${MAX_RESULTS}&sortBy=relevance&sortOrder=descending`;
    const r = await fetch(url, {
      headers: { "User-Agent": "Tikpema-research/1.0 (autonomous research agent; tikpema274@gmail.com)" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return [];
    return parseAtom(await r.text());
  } catch {
    return [];
  }
}

// Map kept papers → { claim, source }. source = the arXiv abs link; claim = title +
// authors/year + a trimmed abstract. Defensive: skips anything missing title/link.
export function arxivToFacts(papers) {
  if (!Array.isArray(papers)) return [];
  return papers
    .filter((p) => p && p.title && p.absLink && p.summary)
    .map((p) => {
      const abstract = p.summary.length > 320 ? `${p.summary.slice(0, 317)}…` : p.summary;
      return {
        claim: `"${p.title}" (${p.authors}, ${p.year}) — ${abstract}`,
        source: p.absLink,
      };
    });
}
