import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { forwardRepositoryRequest } from "../lib/repository-backend";

const originalEnv = { ...process.env };
const token = "a".repeat(43);
const request = (query = "", headers = {}) => new Request(`http://localhost:3000/api/projects/project-a/repository${query}`, { headers: { Cookie: `unrelated=private; scenarioforge_session=${token}`, Authorization: "must-not-forward", ...headers } });
const unexpected: typeof fetch = async () => { throw new Error("unexpected network request"); };
beforeEach(() => Object.assign(process.env, { NODE_ENV: "development", SCENARIOFORGE_REPOSITORY_BACKEND_URL: "http://127.0.0.1:13000", SCENARIOFORGE_REPOSITORY_BACKEND_ORIGIN: "https://example.com" }));
afterEach(() => { process.env = { ...originalEnv }; });

test("disabled relay returns control to the local repository", async () => {
  delete process.env.SCENARIOFORGE_REPOSITORY_BACKEND_URL;
  assert.equal(await forwardRepositoryRequest(request(), "project-a", undefined, unexpected), null);
});

test("only development loopback tunnels and HTTPS origins are allowed", async () => {
  for (const target of ["https://127.0.0.1:13000", "http://example.com:13000", "http://127.0.0.1", "http://user:pass@127.0.0.1:13000", "http://127.0.0.1:13000/other", "http://127.0.0.1:13000/?q=1"]) {
    process.env.SCENARIOFORGE_REPOSITORY_BACKEND_URL = target;
    await assert.rejects(forwardRepositoryRequest(request(), "project-a", undefined, unexpected), { status: 503 });
  }
  process.env.SCENARIOFORGE_REPOSITORY_BACKEND_URL = "http://127.0.0.1:13000";
  Object.assign(process.env, { NODE_ENV: "production" });
  await assert.rejects(forwardRepositoryRequest(request(), "project-a", undefined, unexpected), { status: 503 });
  Object.assign(process.env, { NODE_ENV: "development", SCENARIOFORGE_REPOSITORY_BACKEND_ORIGIN: "http://example.com" });
  await assert.rejects(forwardRepositoryRequest(request(), "project-a", undefined, unexpected), { status: 503 });
});

test("rejects loops, malformed session cookies and path traversal before fetching", async () => {
  await assert.rejects(forwardRepositoryRequest(request("", { "x-scenarioforge-repository-relay": "1" }), "project-a", undefined, unexpected), { status: 503 });
  for (const Cookie of ["", "scenarioforge_session=bad", `__Host-scenarioforge_session=${token}`]) {
    await assert.rejects(forwardRepositoryRequest(request("", { Cookie }), "project-a", undefined, unexpected), { status: 401 });
  }
  await assert.rejects(forwardRepositoryRequest(request(), "../project-b", undefined, unexpected), { status: 503 });
  await assert.rejects(forwardRepositoryRequest(request("?task=..%2Ftask"), "project-a", undefined, unexpected), { status: 400 });
});

test("forwards only the selected project, task and translated session", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), "http://127.0.0.1:13000/api/projects/project-a/repository?task=task-a");
    assert.equal(options?.method, "GET");
    assert.equal(options?.body, undefined);
    assert.equal(options?.cache, "no-store");
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal instanceof AbortSignal);
    assert.deepEqual(Object.fromEntries(new Headers(options?.headers)), { "content-type": "application/json", cookie: `__Host-scenarioforge_session=${token}`, origin: "https://example.com", "x-scenarioforge-repository-relay": "1" });
    return Response.json({ enabled: true }, { headers: { "Set-Cookie": "must-not-leak=1" } });
  };
  const response = await forwardRepositoryRequest(request("?task=task-a&ignored=secret"), "project-a", undefined, fetcher);
  assert.equal(calls, 1);
  assert.equal(response?.headers.get("set-cookie"), null);
  assert.equal(response?.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response?.json(), { enabled: true });
});

test("preserves POST payload and upstream permission failures", async () => {
  const action = { action: "connect", url: "https://github.com/owner/repo.git" };
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(String(url), "http://127.0.0.1:13000/api/projects/project-b/repository");
    assert.equal(options?.method, "POST");
    assert.deepEqual(JSON.parse(String(options?.body)), action);
    return Response.json({ error: "只有项目创建者可以管理仓库。" }, { status: 403 });
  };
  const response = await forwardRepositoryRequest(request(), "project-b", action, fetcher);
  assert.equal(response?.status, 403);
  assert.deepEqual(await response?.json(), { error: "只有项目创建者可以管理仓库。" });
});

test("connection failures are sanitized without retrying mutations", async () => {
  for (const failure of ["network", "timeout", "html", "invalid-json"]) {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      if (failure === "network") throw new Error("private connection detail");
      if (failure === "timeout") throw new DOMException("private timeout detail", "TimeoutError");
      if (failure === "html") return new Response("private upstream response");
      return new Response("private invalid json", { headers: { "Content-Type": "application/json" } });
    };
    await assert.rejects(forwardRepositoryRequest(request(), "project-a", { action: "push" }, fetcher), (error: unknown) => {
      assert.ok(error instanceof Error && "status" in error && error.status === 503);
      assert.match(error.message, /先刷新确认结果/);
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("workspace queries and file commit bodies survive the tunnel unchanged", async () => {
  const fetcher: typeof fetch = async (url, options) => {
    const query = new URL(String(url)).searchParams;
    assert.equal(query.get("view"), "file"); assert.equal(query.get("branch"), "work/member/feature/docs"); assert.equal(query.get("path"), "docs/中文 空格.md"); assert.equal(query.get("ignored"), null);
    assert.equal(options?.method, "GET");
    return Response.json({ text: "# 中文\n\n" });
  };
  const query = new URLSearchParams({ view: "file", branch: "work/member/feature/docs", path: "docs/中文 空格.md", ignored: "secret" });
  const response = await forwardRepositoryRequest(request("?" + query), "project-a", undefined, fetcher);
  assert.deepEqual(await response?.json(), { text: "# 中文\n\n" });
  const action = { action: "files-commit", branch: "work/member/a", head: "a".repeat(40), message: "upload", changes: [{ path: "binary.bin", content: "AP8K", encoding: "base64" }] };
  await forwardRepositoryRequest(request(), "project-a", action, async (_url, options) => { assert.deepEqual(JSON.parse(String(options?.body)), action); return Response.json({ ok: true }); });
});
