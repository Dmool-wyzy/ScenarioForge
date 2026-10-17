import "server-only";
import { parseInput, searchResult } from "./shared";
import type { SearchInput, SearchProvider } from "./types";

export class MockProvider implements SearchProvider {
  readonly name = "mock" as const;
  isConfigured() { return true; }
  async search(input: SearchInput) {
    const { query, maxResults } = parseInput(this.name, input);
    return searchResult(this.name, query, ["overview", "considerations", "next-steps"].map((topic) => ({
      title: `[MOCK] ${query} - ${topic}`,
      url: `https://example.com/mock/${topic}?${new URLSearchParams({ q: query })}`,
      snippet: `[MOCK SEARCH RESULT] Deterministic ${topic} example for: ${query}. This is test data, not verified research.`,
    })), maxResults);
  }
}
