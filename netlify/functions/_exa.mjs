// _exa.mjs — Exa retrieval, so research briefs are grounded on real retrieved
// sources rather than the model's own web search.
//
// READ ONLY: one POST to Exa's /search endpoint. No on-chain read, no wallet,
// no signing, no transaction. The caller (the research engine) feeds the
// returned snippets into the model as the ONLY allowed evidence.
//
// On any failure — missing key, non-ok response, or fetch error — this throws,
// and the caller is expected to fall back to its existing web-search path so an
// Exa outage can't break the product.

export async function exaSearch(question, { type = "auto", numResults = 6 } = {}) {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) throw new Error("Missing EXA_API_KEY (server env)");

  // Bound the request: a hung Exa call must not stall the whole research run.
  // On abort the fetch rejects, hitting the throw below → research() falls back.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  let res, data;
  try {
    res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        query: question,
        type,
        numResults,
        contents: { text: { maxCharacters: 2000 } },
        systemPrompt: "Prefer authoritative and primary sources.",
      }),
      signal: controller.signal,
    });

    data = await res.json().catch(() => null);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(data?.error || `Exa search failed (${res.status})`);
  }

  // Surface what the search cost so it shows up in function logs.
  const cost = data?.costDollars?.total;
  if (cost != null) console.log(`[exa] search cost $${cost}`);

  // Normalize: title/url/publishedDate/text may each be absent — fill safely.
  const results = Array.isArray(data?.results) ? data.results : [];
  const normalized = results.map((r) => ({
    title: r?.title || "",
    url: r?.url || "",
    publishedDate: r?.publishedDate || "",
    text: r?.text || "",
  }));

  // No results is as useless as a failure — throw so research() falls back.
  if (normalized.length === 0) throw new Error("Exa returned no results");

  return normalized;
}
