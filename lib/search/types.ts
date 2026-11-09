export type SearchProviderName = "searxng" | "ddgs" | "tavily" | "deepseek" | "mock";
export type SearchSource = { title: string; url: string; snippet: string; publishedDate?: string };
export type SearchResult = { query: string; provider: SearchProviderName; results: SearchSource[]; fetchedAt: string };
export type SearchInput = { query: string; maxResults: number };
export interface SearchProvider {
  name: SearchProviderName;
  isConfigured(): boolean;
  search(input: SearchInput): Promise<SearchResult>;
}
export type SearchErrorCode = "missing_config" | "unauthorized" | "rate_limited" | "upstream_error" | "empty_results" | "invalid_response";
export class SearchProviderError extends Error {
  constructor(public provider: SearchProviderName, public code: SearchErrorCode, message: string) {
    super(message);
    this.name = "SearchProviderError";
  }
}
