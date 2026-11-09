import "server-only";
import { modelFetch, modelTransport } from "../model-endpoint";
import { isPublicIPv4 } from "../rag/fetch-source";
import { fetchSearchJson, parseInput, record, requireConfigured, searchResult, timeoutMs } from "./shared";
import { SearchProviderError, type SearchInput, type SearchProvider } from "./types";

const endpoint = "https://api.deepseek.com/v1/tools/search";

export class DeepSeekProvider implements SearchProvider {
  readonly name = "deepseek" as const;

  constructor(private apiKey?: string, private address?: string, private testFetch?: typeof fetch) {}

  isConfigured() {
    return !!this.apiKey?.trim() && !!this.address && isPublicIPv4(this.address);
  }

  async search(input: SearchInput) {
    requireConfigured(this);
    const { query, maxResults } = parseInput(this.name, input);
    if ([...query].length > 128) throw new SearchProviderError(this.name, "invalid_response", "DeepSeek Search 查询最多 128 个 Unicode 字符。");

    const transport = this.testFetch ? undefined : modelTransport(endpoint, timeoutMs(this.name), this.address);
    try {
      const payload = record(await fetchSearchJson(this.name, endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey!.trim()}` },
        body: JSON.stringify({ query, count: maxResults, need_content: false }),
      }, this.testFetch ?? modelFetch(transport!, endpoint)));
      const rows = Array.isArray(payload?.results) ? payload.results.map(value => {
        const item = record(value);
        return { title: item?.title, url: item?.url, snippet: item?.summary || item?.snippet, publishedDate: item?.date };
      }) : payload?.results;
      return searchResult(this.name, query, rows, maxResults);
    } finally {
      await transport?.close();
    }
  }
}
