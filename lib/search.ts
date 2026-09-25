export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const SEARCH_TIMEOUT_MS = 4000;

/* Domains treated as more authoritative when picking a source to cite. */
const PREFERRED_DOMAINS =
  /\.(gov|edu|int)([/:]|$)|who\.int|un\.org|oecd\.org|worldbank\.org|imf\.org|europa\.eu|nature\.com|science\.org|britannica\.com|reuters\.com|apnews\.com|pewresearch\.org|ourworldindata\.org|wikipedia\.org/i;

/* Keyless — sources work with zero configuration and no extra API. */
async function searchWikipedia(query: string): Promise<SearchResult[]> {
  const res = await fetch(
    `https://en.wikipedia.org/w/rest.php/v1/search/page?limit=3&q=${encodeURIComponent(query)}`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    }
  );
  if (!res.ok) throw new Error(`Wikipedia search error ${res.status}`);
  const data = await res.json();
  return (data?.pages ?? [])
    .filter((p: { key?: string }) => typeof p?.key === "string")
    .map((p: { title?: string; key: string; excerpt?: string }) => ({
      title: p.title ? `Wikipedia: ${p.title}` : "Wikipedia",
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.key)}`,
      snippet: (p.excerpt ?? "").replace(/<[^>]+>/g, ""),
    }));
}

/**
 * Look up a citable page for a correction. Returns null on failure — callers
 * should fall back gracefully rather than block the debate.
 */
export async function searchWeb(query: string): Promise<SearchResult[] | null> {
  try {
    const results = await searchWikipedia(query);
    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}

/** Pick the most citable result, preferring authoritative domains. */
export function pickBestResult(results: SearchResult[]): SearchResult {
  return results.find((r) => PREFERRED_DOMAINS.test(r.url)) ?? results[0];
}
