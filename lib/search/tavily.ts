import "server-only";
import { fetchSearchJson, parseInput, positiveSetting, record, requireConfigured, searchResult } from "./shared";
import type { SearchInput, SearchProvider } from "./types";

export class TavilyProvider implements SearchProvider {
  readonly name = "tavily" as const;
  isConfigured() { const key = process.env.TAVILY_API_KEY?.trim(); return !!key && !key.startsWith("tvly-your-"); }
  async search(input: SearchInput) {
    requireConfigured(this);
    const { query, maxResults } = parseInput(this.name, input);
    const limit = Math.min(maxResults, positiveSetting("TAVILY_MAX_RESULTS", 5, this.name, 20));
    const payload = record(await fetchSearchJson(this.name, "https://api.tavily.com/search", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY!.trim(), query, max_results: limit, search_depth: "basic", include_answer: false }),
    }));
    const rows = Array.isArray(payload?.results) ? payload.results.map((value) => { const item = record(value); return { title: item?.title, url: item?.url, snippet: item?.content ?? "", publishedDate: item?.published_date }; }) : payload?.results;
    return searchResult(this.name, query, rows, limit);
  }
}
