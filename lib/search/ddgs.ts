import "server-only";
import { fetchSearchJson, parseInput, record, requireConfigured, searchResult, validHttpUrl } from "./shared";
import type { SearchInput, SearchProvider } from "./types";

export class DdgsProvider implements SearchProvider {
  readonly name = "ddgs" as const;
  isConfigured() { return !!validHttpUrl(process.env.SCENARIOFORGE_MCP_URL) && (process.env.SCENARIOFORGE_INTERNAL_TOKEN?.trim().length ?? 0) >= 32; }
  async search(input: SearchInput) {
    requireConfigured(this);
    const { query, maxResults } = parseInput(this.name, input);
    const payload = record(await fetchSearchJson(this.name, new URL("/internal/search/ddgs", process.env.SCENARIOFORGE_MCP_URL!), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.SCENARIOFORGE_INTERNAL_TOKEN}` }, body: JSON.stringify({ query, maxResults }),
    }));
    return searchResult(this.name, query, payload?.results, maxResults);
  }
}
