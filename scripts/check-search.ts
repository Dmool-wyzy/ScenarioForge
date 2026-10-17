import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getSearchProvider } from "../lib/search/index";
import { completedSearchQuestions } from "../lib/search/progress";
import { SearchProviderError, type SearchErrorCode } from "../lib/search/types";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
afterEach(() => { process.env = { ...originalEnv }; globalThis.fetch = originalFetch; });

function configure(name?: string) {
  delete process.env.SEARCH_PROVIDER;
  delete process.env.SEARCH_TIMEOUT_MS;
  delete process.env.MAX_SEARCH_RESULTS_PER_QUESTION;
  delete process.env.TAVILY_MAX_RESULTS;
  process.env.TAVILY_API_KEY = "";
  process.env.SEARXNG_URL = "";
  process.env.SCENARIOFORGE_MCP_URL = "http://localhost:8000/mcp";
  process.env.SCENARIOFORGE_INTERNAL_TOKEN = "search-test-token-".repeat(3);
  if (name) process.env.SEARCH_PROVIDER = name;
}
function rejects(code: SearchErrorCode, message?: RegExp) {
  return (error: unknown) => error instanceof SearchProviderError && error.code === code && (!message || message.test(error.message));
}
const row = { title: "A source", url: "https://example.org/a", content: "Source excerpt", publishedDate: "2026-10-15" };

test("Mock defaults to three related, labelled results and makes zero network requests", async () => {
  configure();
  globalThis.fetch = async () => { throw new Error("Mock must never fetch"); };
  const provider = getSearchProvider();
  assert.equal(provider.name, "mock");
  const result = await provider.search({ query: "Tokyo rental rules", maxResults: 5 });
  assert.equal(result.provider, "mock"); assert.equal(result.query, "Tokyo rental rules");
  assert.equal(result.results.length, 3); assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
  for (const source of result.results) {
    assert.ok(source.url.startsWith("https://example.com/mock/"));
    assert.ok(source.title.includes(result.query));
    assert.ok(source.snippet.includes("[MOCK SEARCH RESULT]"));
  }
  assert.equal((await provider.search({ query: "budget", maxResults: 1 })).results.length, 1);
  const punctuation = await provider.search({ query: "user's budget (2026)", maxResults: 5 });
  assert.equal(punctuation.results.some((source) => /[()']/.test(source.url)), false);
});

for (const name of ["mock", "searxng", "ddgs", "tavily"] as const) {
  test(`Factory selects ${name} without contacting any service`, () => {
    configure(name); process.env.SEARXNG_URL = "http://localhost:8888"; process.env.TAVILY_API_KEY = "test-key";
    globalThis.fetch = async () => { throw new Error("Factory must never fetch"); };
    assert.equal(getSearchProvider().name, name);
  });
}

test("Factory validates only the chosen Provider, rejects invalid configuration", () => {
  configure("tavily"); assert.throws(getSearchProvider, rejects("missing_config", /TAVILY_API_KEY/));
  process.env.SEARCH_PROVIDER = "searxng"; assert.throws(getSearchProvider, rejects("missing_config", /SEARXNG_URL/));
  process.env.SEARXNG_URL = "file:///local"; assert.throws(getSearchProvider, rejects("missing_config"));
  process.env.SEARCH_PROVIDER = "ddgs"; delete process.env.SCENARIOFORGE_MCP_URL; assert.throws(getSearchProvider, rejects("missing_config"));
  process.env.SEARCH_PROVIDER = "mock"; assert.equal(getSearchProvider().name, "mock");
  process.env.SEARCH_TIMEOUT_MS = "invalid"; assert.throws(getSearchProvider, rejects("missing_config"));
  process.env.SEARCH_PROVIDER = "unknown"; assert.throws(getSearchProvider, /SEARCH_PROVIDER/);
});

test("SearXNG encodes query, maps fields, strips raw fields, filters/deduplicates URLs and limits results", async () => {
  configure("searxng"); process.env.SEARXNG_URL = "http://localhost:8888/";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/search"); assert.equal(url.searchParams.get("format"), "json"); assert.equal(url.searchParams.get("q"), "Tokyo & rental");
    assert.equal(init?.cache, "no-store"); assert.ok(init?.signal);
    return Response.json({ results: [{}, { url: "javascript:alert(1)" }, { url: "https://user:secret@example.org/" }, { ...row, engine: "private raw field" }, row, { ...row, url: "https://example.org/b" }, { ...row, url: "https://example.org/c" }] });
  };
  const result = await getSearchProvider().search({ query: "Tokyo & rental", maxResults: 2 });
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results[0], { title: row.title, url: row.url, snippet: row.content, publishedDate: row.publishedDate });
  assert.equal(result.results[1].url, "https://example.org/b");
});

test("Tavily carries key/basic depth and requested maximum, maps normalized sources", async () => {
  configure("tavily"); process.env.TAVILY_API_KEY = "test-private-key"; process.env.TAVILY_MAX_RESULTS = "10";
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.tavily.com/search");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.api_key, "test-private-key"); assert.equal(body.max_results, 6); assert.equal(body.search_depth, "basic");
    return Response.json({ results: [{ ...row, published_date: row.publishedDate, score: 0.8 }] });
  };
  assert.deepEqual((await getSearchProvider().search({ query: "study plan", maxResults: 6 })).results, [{ title: row.title, url: row.url, snippet: row.content, publishedDate: row.publishedDate }]);
});

for (const provider of ["searxng", "tavily", "ddgs"] as const) {
  test(`${provider} handles HTTP errors without leaking upstream content`, async () => {
    configure(provider); process.env.SEARXNG_URL = "http://localhost:8888"; process.env.TAVILY_API_KEY = "test-key";
    for (const [status, code] of [[401, "unauthorized"], [403, "unauthorized"], [429, "rate_limited"], [500, "upstream_error"], [503, "upstream_error"]] as const) {
      globalThis.fetch = async () => new Response("private upstream content", { status });
      await assert.rejects(getSearchProvider().search({ query: "test", maxResults: 5 }), (error: unknown) => rejects(code)(error) && error instanceof Error && !error.message.includes("private upstream content") && (provider !== "searxng" || status !== 403 || /settings.yml.*json/.test(error.message)));
    }
    globalThis.fetch = async () => { throw new DOMException("secret request details", "TimeoutError"); };
    await assert.rejects(getSearchProvider().search({ query: "test", maxResults: 5 }), rejects("upstream_error"));
    globalThis.fetch = async () => new Response("not json");
    await assert.rejects(getSearchProvider().search({ query: "test", maxResults: 5 }), rejects("invalid_response"));
    globalThis.fetch = async () => Response.json({ results: [] });
    await assert.rejects(getSearchProvider().search({ query: "test", maxResults: 5 }), rejects("empty_results"));
    globalThis.fetch = async () => Response.json({ results: [{ url: "file:///secret" }] });
    await assert.rejects(getSearchProvider().search({ query: "test", maxResults: 5 }), rejects("invalid_response"));
  });
}

test("DDGS calls the authenticated Python endpoint and handles unavailable endpoint", async () => {
  configure("ddgs");
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "http://localhost:8000/internal/search/ddgs");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${process.env.SCENARIOFORGE_INTERNAL_TOKEN}`);
    assert.deepEqual(JSON.parse(String(init?.body)), { query: "test", maxResults: 5 });
    return Response.json({ results: [{ title: "Source", url: row.url, snippet: "Excerpt", unknown: "discard" }] });
  };
  assert.equal((await getSearchProvider().search({ query: "test", maxResults: 5 })).results[0].snippet, "Excerpt");
  globalThis.fetch = async () => new Response("Not Found", { status: 404 });
  await assert.rejects(getSearchProvider().search({ query: "test", maxResults: 5 }), rejects("missing_config", /internal\/search\/ddgs/));
  globalThis.fetch = async () => Response.json({ error: { code: "empty_results", message: "private" } }, { status: 502 });
  await assert.rejects(getSearchProvider().search({ query: "test", maxResults: 5 }), rejects("empty_results"));
});

test("DDGS allows the bridge to report its own timeout before the HTTP client aborts", async () => {
  configure("ddgs"); process.env.SEARCH_TIMEOUT_MS = "1";
  globalThis.fetch = async (_input, init) => {
    await new Promise<void>((resolve, reject) => {
      const signal = init!.signal!;
      const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 20);
      function onAbort() { clearTimeout(timer); reject(signal.reason); }
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    return Response.json({ error: { code: "upstream_error", message: "private" } }, { status: 504 });
  };
  await assert.rejects(getSearchProvider().search({ query: "test", maxResults: 5 }), rejects("upstream_error", /DDGS.*超时/));
});

test("Only evidence completion qualifies new searches; legacy records remain readable", () => {
  const event = (type: string, payload: unknown) => ({ type, payload });
  const start = event("search_started", { question: "q", query: "query", provider: "mock" });
  assert.equal(completedSearchQuestions([start]).has("q"), false);
  assert.equal(completedSearchQuestions([start, event("search_completed", JSON.stringify({ question: "q" }))]).has("q"), true);
  assert.equal(completedSearchQuestions([start, event("search_failed", { question: "q" })]).has("q"), false);
  assert.equal(completedSearchQuestions([event("search_started", { question: "legacy" })]).has("legacy"), true);
  assert.equal(completedSearchQuestions([event("search_completed", { question: " q " })]).has("q"), true);
});
