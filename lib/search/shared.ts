import "server-only";
import { SearchProviderError, type SearchInput, type SearchProvider, type SearchProviderName, type SearchResult, type SearchSource } from "./types";

export function validHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return;
  try {
    const url = new URL(value);
    if (!url.hostname || url.username || url.password) return;
    url.hash = "";
    return url.toString();
  } catch { return; }
}

export function positiveSetting(name: string, fallback: number, provider: SearchProviderName, max: number) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new SearchProviderError(provider, "missing_config", `${name} 必须为 1–${max} 的整数，请检查 .env.local。`);
  return value;
}

export function timeoutMs(provider: SearchProviderName) { return positiveSetting("SEARCH_TIMEOUT_MS", 30000, provider, 120000); }
export function maxSearchResults(provider: SearchProviderName) { return positiveSetting("MAX_SEARCH_RESULTS_PER_QUESTION", 5, provider, 20); }

export function requireConfigured(provider: SearchProvider) {
  if (provider.isConfigured()) return;
  const messages = {
    searxng: process.env.SEARXNG_URL?.trim() ? "SEARXNG_URL 无效，必须是 HTTP/HTTPS 服务地址，例如：http://localhost:8888。" : "缺少 SEARXNG_URL。请在 .env.local 中设置，例如：\nSEARXNG_URL=http://localhost:8888",
    tavily: "缺少 TAVILY_API_KEY。请在 .env.local 中设置，或将 SEARCH_PROVIDER 改为 searxng / ddgs / mock。",
    deepseek: "DeepSeek Search 需要项目内启用该功能，并配置有效的 DeepSeek API Key 和已验证的 API 地址。",
    ddgs: "DDGS Provider 需要 ScenarioForge Python MCP Server。请设置有效的 SCENARIOFORGE_MCP_URL 和至少 32 字符的 SCENARIOFORGE_INTERNAL_TOKEN，并确认服务支持 /internal/search/ddgs。",
    mock: "Mock 搜索配置无效。",
  };
  throw new SearchProviderError(provider.name, "missing_config", messages[provider.name]);
}

export function parseInput(provider: SearchProviderName, input: SearchInput) {
  const query = input.query.trim();
  if (!query || query.length > 1000 || !Number.isInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > 20) throw new SearchProviderError(provider, "invalid_response", "搜索 query 须为 1–1000 字，maxResults 须为 1–20 的整数。");
  return { query, maxResults: input.maxResults };
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function normalizeSources(provider: SearchProviderName, rows: unknown, maxResults: number): SearchSource[] {
  if (!Array.isArray(rows)) throw new SearchProviderError(provider, "invalid_response", "搜索服务返回的数据格式无效，请稍后重试或切换 Provider。");
  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  for (const value of rows) {
    const item = record(value);
    const url = validHttpUrl(item?.url);
    if (!item || !url || seen.has(url.replace(/\/$/, ""))) continue;
    seen.add(url.replace(/\/$/, ""));
    sources.push({ title: typeof item.title === "string" ? item.title.slice(0, 500) : url, url, snippet: typeof item.snippet === "string" ? item.snippet.slice(0, 3000) : "", ...(typeof item.publishedDate === "string" && item.publishedDate ? { publishedDate: item.publishedDate.slice(0, 100) } : {}) });
    if (sources.length >= maxResults) break;
  }
  if (!sources.length) throw new SearchProviderError(provider, rows.length ? "invalid_response" : "empty_results", rows.length ? "搜索结果没有有效的 HTTP/HTTPS 链接，请重试或切换 Provider。" : "搜索服务未返回结果，请调整查询或切换 Provider；不能据此生成来源。");
  return sources;
}

export function searchResult(provider: SearchProviderName, query: string, rows: unknown, maxResults: number): SearchResult {
  return { provider, query, results: normalizeSources(provider, rows, maxResults), fetchedAt: new Date().toISOString() };
}

export async function fetchSearchJson(provider: SearchProviderName, url: string | URL, init?: RequestInit, fetcher: typeof fetch = fetch): Promise<unknown> {
  try {
    // The local DDGS bridge enforces SEARCH_TIMEOUT_MS itself. Leave time for
    // its structured error response before the caller aborts the connection.
    const response = await fetcher(url, { ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(timeoutMs(provider) + (provider === "ddgs" ? 5000 : 0)) });
    if (response.status === 401 || response.status === 403) {
      const message = provider === "searxng" && response.status === 403 ? "SearXNG 返回 403。请检查 settings.yml 的 search.formats 是否包含 json（format=json）。"
        : provider === "tavily" ? "搜索服务鉴权失败，请检查 TAVILY_API_KEY。"
          : provider === "deepseek" ? "DeepSeek Search 鉴权失败，请检查项目 API Key 和账户权限。"
            : "搜索服务鉴权失败，请检查服务访问权限及内部凭据。";
      throw new SearchProviderError(provider, "unauthorized", message);
    }
    if (provider === "deepseek" && response.status === 402) throw new SearchProviderError(provider, "upstream_error", "DeepSeek Search 账户余额不足（HTTP 402），请检查账户余额。");
    if (response.status === 429) throw new SearchProviderError(provider, "rate_limited", "搜索服务已达限流或额度限制，请稍后重试或切换 Provider。");
    // Only the authenticated local DDGS endpoint uses structured non-2xx errors.
    if (provider === "ddgs" && !response.ok) {
      let code: unknown;
      try { code = record(record(await response.json())?.error)?.code; } catch { /* use the generic upstream error */ }
      if (code === "empty_results") throw new SearchProviderError(provider, code, "DDGS 未返回结果，请调整查询或切换 Provider。");
      if (code === "rate_limited") throw new SearchProviderError(provider, code, "DDGS 已被限流，请稍后重试或切换 Provider。");
      if (code === "missing_config" || response.status === 404) throw new SearchProviderError(provider, "missing_config", "DDGS 需要安装依赖并启动支持 /internal/search/ddgs 的 Python MCP Server。");
      if (code === "invalid_response") throw new SearchProviderError(provider, code, "DDGS 返回的数据格式无效，请切换 Provider 或稍后重试。");
      if (response.status === 504) throw new SearchProviderError(provider, "upstream_error", "DDGS 搜索超时，请尝试更简短的查询，或检查网络后重试。");
    }
    if (!response.ok) throw new SearchProviderError(provider, "upstream_error", "搜索服务暂时不可用，请稍后重试或切换搜索 Provider。");
    try { return await response.json(); }
    catch { throw new SearchProviderError(provider, "invalid_response", "搜索服务未返回有效 JSON，请检查配置或切换 Provider。"); }
  } catch (error) {
    if (error instanceof SearchProviderError) throw error;
    throw new SearchProviderError(provider, "upstream_error", "搜索服务连接失败或请求超时，请检查网络、服务地址，或切换 Provider。");
  }
}
