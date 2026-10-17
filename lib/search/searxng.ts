import "server-only";
import { fetchSearchJson, parseInput, record, requireConfigured, searchResult, validHttpUrl } from "./shared";
import type { SearchInput, SearchProvider } from "./types";

export class SearxngProvider implements SearchProvider {
  readonly name = "searxng" as const;
  isConfigured() { return !!validHttpUrl(process.env.SEARXNG_URL); }
  async search(input: SearchInput) {
    requireConfigured(this);
    const { query, maxResults } = parseInput(this.name, input);
    const base = process.env.SEARXNG_URL!.replace(/\/+$/, "");
    const url = new URL(`${base}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    const payload = record(await fetchSearchJson(this.name, url));
    const rows = Array.isArray(payload?.results) ? payload.results.map((value) => { const item = record(value); return { title: item?.title, url: item?.url, snippet: item?.content ?? "", publishedDate: item?.publishedDate }; }) : payload?.results;
    return searchResult(this.name, query, rows, maxResults);
  }
}
