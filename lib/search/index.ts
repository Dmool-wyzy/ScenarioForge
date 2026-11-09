import "server-only";
import { MockProvider } from "./mock";
import { SearxngProvider } from "./searxng";
import { DdgsProvider } from "./ddgs";
import { TavilyProvider } from "./tavily";
import { DeepSeekProvider } from "./deepseek";
import { maxSearchResults, requireConfigured, timeoutMs } from "./shared";
import { SearchProviderError, type SearchProvider, type SearchProviderName } from "./types";

type ProjectSearchConfig = { DEEPSEEK_SEARCH_ENABLED?: boolean; OPENAI_API_KEY?: string; MODEL_VALIDATED_ADDRESS?: string };

export function searchProviderName(config?: ProjectSearchConfig): SearchProviderName {
  if (config?.DEEPSEEK_SEARCH_ENABLED) return "deepseek";
  const name = process.env.SEARCH_PROVIDER?.trim() || "mock";
  if (name === "mock" || name === "searxng" || name === "ddgs" || name === "tavily") return name;
  throw new Error("SEARCH_PROVIDER 无效，请在 .env.local 中选择 searxng / ddgs / tavily / mock。");
}

export function getSearchProvider(config?: ProjectSearchConfig): SearchProvider {
  const name = searchProviderName(config);
  if (name === "deepseek") {
    const provider = new DeepSeekProvider(config?.OPENAI_API_KEY, config?.MODEL_VALIDATED_ADDRESS);
    requireConfigured(provider);
    timeoutMs(name);
    maxSearchResults(name);
    return provider;
  }
  const factories = { mock: MockProvider, searxng: SearxngProvider, ddgs: DdgsProvider, tavily: TavilyProvider };
  const provider = new factories[name]();
  requireConfigured(provider);
  timeoutMs(name);
  maxSearchResults(name);
  return provider;
}

export { SearchProviderError };
export type { SearchProvider, SearchProviderName, SearchSource, SearchResult } from "./types";
