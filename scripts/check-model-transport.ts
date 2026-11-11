import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { after, test } from "node:test";
import { Agent, Runner, tool } from "@openai/agents";
import OpenAI from "openai";
import { Request as HttpRequest, fetch as httpFetch } from "undici";
import { z } from "zod";
import { createModelProvider } from "../lib/openai";
import { logError, publicError } from "../lib/errors";
import { modelFetch, modelTransport } from "../lib/model-endpoint";
import { modelResponseFetch } from "../lib/model-response";
import type { ResearchConfig } from "../lib/model-settings";
import { generatePlanDocuments } from "../lib/plan-documents";
import { testModelConnection } from "../lib/model-test";

// Every request below uses fixture credentials and loopback. Safe logging must
// not load a developer's model configuration while testing its redaction.
const previousEnvFile = process.env.SCENARIOFORGE_ENV_FILE;
process.env.SCENARIOFORGE_ENV_FILE = "";
after(() => {
  if (previousEnvFile === undefined) delete process.env.SCENARIOFORGE_ENV_FILE;
  else process.env.SCENARIOFORGE_ENV_FILE = previousEnvFile;
});

type FixtureRequest = { url: string | undefined; body: Record<string, unknown>; headers: http.IncomingHttpHeaders };
type FixtureReply = { body: string; status?: number; contentType?: string };

async function httpFixture(reply: (request: FixtureRequest, count: number) => FixtureReply) {
  const requests: FixtureRequest[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const received = { url: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")), headers: request.headers };
    requests.push(received);
    const result = reply(received, requests.length);
    response.statusCode = result.status ?? 200;
    if (result.contentType) response.setHeader("Content-Type", result.contentType);
    response.end(result.body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { requests, baseUrl: `http://127.0.0.1:${address.port}/v1`, async close() {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  } };
}

function fixtureConfig(baseUrl: string, project = false, apiMode: ResearchConfig["OPENAI_API_MODE"] = "responses"): ResearchConfig {
  return { OPENAI_API_KEY: "fixture-local-key", OPENAI_BASE_URL: baseUrl, OPENAI_API_MODE: apiMode,
    SCENARIOFORGE_MODEL: "fixture-model", MODEL_TIMEOUT_SECONDS: 10, SCENARIOFORGE_INTERNAL_TOKEN: "fixture-token-".repeat(3),
    SCENARIOFORGE_MCP_URL: "http://127.0.0.1:8000/mcp", SCENARIOFORGE_BACKEND_URL: "http://127.0.0.1:3000",
    PROJECT_MODEL_CONFIG: project, MODEL_VALIDATED_ADDRESS: project ? "127.0.0.1" : undefined };
}

function responseEnvelope(text: string) {
  return { id: "resp_fixture", object: "response", created_at: 0, status: "completed", model: "fixture-model",
    output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }] };
}

const planOutput = { plan: "# Fixture plan\n\nCreate a Node addition module, write built-in tests, and review the resulting changes. This is a plan only.",
  tasks: "# Fixture tasks\n\n- [ ] Create addition module\n- [ ] Write Node tests\n- [ ] Request test execution\n- [ ] Review results and report" };

function assertSafeLogs(error: unknown, secret: string) {
  const original = console.error;
  const messages: unknown[][] = [];
  try {
    console.error = (...args) => { messages.push(args); };
    logError(error);
    assert.equal(JSON.stringify(messages).includes(secret), false);
  } finally { console.error = original; }
}

test("real HTTP and Agents SDK generate skill documents from valid JSON, wrong media types, and one extra JSON encoding", async (t) => {
  for (const project of [false, true]) {
    for (const variant of ["json", "text", "missing", "double"] as const) await t.test(`${project ? "project" : "default"} / ${variant}`, async () => {
      const json = JSON.stringify(responseEnvelope(JSON.stringify(planOutput)));
      const fixture = await httpFixture(() => ({ body: variant === "double" ? JSON.stringify(json) : json,
        contentType: variant === "missing" ? undefined : variant === "text" ? "text/plain" : "application/json" }));
      const provider = createModelProvider(fixtureConfig(fixture.baseUrl, project));
      try {
        const result = await generatePlanDocuments({ model: "fixture-model", runner: new Runner({ modelProvider: provider, tracingDisabled: true }),
          input: "Create a Node addition module and test plan", signal: new AbortController().signal });
        assert.deepEqual(result.documents.map(document => document.filename), ["PLAN.md", "TASKS.md"]);
        assert.ok(result.documents[0].content.endsWith(planOutput.plan));
        assert.ok(result.documents[1].content.endsWith(planOutput.tasks));
        assert.equal(fixture.requests.length, 1, "document generation must make exactly one model request");
        assert.equal(fixture.requests[0].url, "/v1/responses");
        assert.match(JSON.stringify(fixture.requests[0].body), /json_schema/);
        assert.deepEqual(fixture.requests[0].body.tools, []);
        if (project) assert.equal(fixture.requests[0].headers["accept-encoding"], "identity");
      } finally { await provider.close(); await fixture.close(); }
    });
  }
});

test("normal JSON tool calls survive normalization for Responses and Chat Completions", async (t) => {
  for (const mode of ["responses", "chat_completions"] as const) await t.test(mode, async () => {
    const fixture = await httpFixture((_request, count) => {
      if (mode === "responses") return { contentType: "application/json", body: JSON.stringify(count === 1
        ? { ...responseEnvelope(""), output: [{ type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "fixture_add", arguments: '{"a":1,"b":2}', status: "completed" }] }
        : responseEnvelope("3")) };
      return { contentType: "application/json", body: JSON.stringify({ id: "chatcmpl_fixture", object: "chat.completion", created: 0, model: "fixture-model",
        choices: [{ index: 0, finish_reason: count === 1 ? "tool_calls" : "stop", message: count === 1
          ? { role: "assistant", content: null, tool_calls: [{ id: "call_fixture", type: "function", function: { name: "fixture_add", arguments: '{"a":1,"b":2}' } }] }
          : { role: "assistant", content: "3" } }] }) };
    });
    const provider = createModelProvider(fixtureConfig(fixture.baseUrl, false, mode));
    let toolCalls = 0;
    try {
      const add = tool({ name: "fixture_add", description: "Add fixture numbers", parameters: z.object({ a: z.number(), b: z.number() }),
        execute({ a, b }) { toolCalls++; return String(a + b); } });
      const agent = new Agent({ name: "tool transport fixture", model: "fixture-model", tools: [add], modelSettings: { retry: { maxRetries: 0 } } });
      const result = await new Runner({ modelProvider: provider, tracingDisabled: true }).run(agent, "Add 1 and 2", { maxTurns: 2 });
      assert.equal(result.finalOutput, "3");
      assert.equal(toolCalls, 1);
      assert.equal(fixture.requests.length, 2, "one tool turn and one final turn, without retries");
      assert.equal(fixture.requests[0].url, mode === "responses" ? "/v1/responses" : "/v1/chat/completions");
    } finally { await provider.close(); await fixture.close(); }
  });
});

test("valid refusal, incomplete, reasoning and future output fields remain available to the SDK", async (t) => {
  const complete = responseEnvelope("partial or complete text");
  const variants = [
    { name: "refusal", response: { ...complete, output: [{ ...complete.output[0], content: [{ type: "refusal", refusal: "fixture refusal" }] }] } },
    { name: "incomplete", response: { ...complete, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
    { name: "reasoning", response: { ...complete, output: [{ type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "fixture summary" }] }, ...complete.output] } },
    { name: "future type", response: { ...complete, output: [{ type: "constructor", id: "future_fixture", future_data: "preserve me" }, ...complete.output] } },
  ];
  for (const { name, response } of variants) await t.test(name, async () => {
    const envelope = { ...response, future_provider_field: { keep: true } };
    const fixture = await httpFixture(() => ({ body: JSON.stringify(envelope), contentType: "application/json" }));
    const transport = modelTransport(fixture.baseUrl, 10_000);
    const client = new OpenAI({ apiKey: "fixture-local-key", baseURL: fixture.baseUrl, maxRetries: 0,
      fetch: modelResponseFetch(httpFetch as unknown as typeof globalThis.fetch, "responses"), fetchOptions: { dispatcher: transport } });
    try {
      const result = await client.responses.create({ model: "fixture-model", input: "fixture" }) as unknown as Record<string, unknown>;
      assert.deepEqual(result.future_provider_field, { keep: true });
      assert.deepEqual(result.output, envelope.output);
      assert.equal(result.status, envelope.status);
      assert.equal(fixture.requests.length, 1);
    } finally { await transport.destroy(); await fixture.close(); }
  });
});

test("normalized JSON resets stale wire headers and preserves provider fields", async () => {
  const envelope = { ...responseEnvelope("ok"), provider_extension: { preserved: true } };
  const original = new Response(JSON.stringify(envelope), { headers: { "Content-Type": "text/plain", "Content-Encoding": "gzip", "Transfer-Encoding": "chunked", "Content-Length": "1", "x-request-id": "fixture-request-id" } });
  const response = await modelResponseFetch(async () => original, "responses")("http://fixture.invalid/responses", { body: "{}" });
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(response.headers.get("transfer-encoding"), null);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(JSON.stringify(envelope))));
  assert.equal(response.headers.get("x-request-id"), "fixture-request-id");
  assert.deepEqual(await response.json(), envelope);
});

test("streaming requests pass through the original response without buffering or changing its media type", async () => {
  for (const requestObject of [false, true]) {
    const original = new Response("data: fixture-event\n\n", { headers: { "Content-Type": "text/event-stream" } });
    const wrapped = modelResponseFetch(async () => original, "responses");
    const init = { method: "POST", body: JSON.stringify({ stream: true }) };
    const response = requestObject ? await wrapped(new Request("http://fixture.invalid/responses", init)) : await wrapped("http://fixture.invalid/responses", init);
    assert.equal(response, original);
    assert.equal(original.bodyUsed, false);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(await response.text(), "data: fixture-event\n\n");
  }
});

test("both transports return live HTTP streams before the server ends the response", async (t) => {
  for (const project of [false, true]) for (const requestObject of [false, true]) await t.test(`${project ? "project" : "default"} / ${requestObject ? "Request" : "init"}`, async () => {
    let requests = 0;
    const server = http.createServer(async (request, response) => {
      for await (const chunk of request) assert.ok(chunk);
      requests++;
      if (project) assert.equal(request.headers["accept-encoding"], "identity");
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write("data: fixture-event\n\n");
      // Intentionally leave it open: buffering must not delay fetch's result.
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const transport = modelTransport(baseUrl, 10_000);
    const wrapped = modelResponseFetch(project ? modelFetch(transport, baseUrl, { preserveStreamingResponse: true }) : httpFetch as unknown as typeof globalThis.fetch, "responses");
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 1500);
    try {
      const init = { method: "POST", body: JSON.stringify({ stream: true }), signal: abort.signal };
      const response = requestObject ? await wrapped(new HttpRequest(baseUrl + "/responses", init) as unknown as Request) : await wrapped(baseUrl + "/responses", init);
      assert.equal(response.bodyUsed, false);
      assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
      const reader = response.body!.getReader();
      assert.equal(new TextDecoder().decode((await reader.read()).value), "data: fixture-event\n\n");
      await reader.cancel();
      assert.equal(requests, 1);
    } finally {
      clearTimeout(timer);
      abort.abort();
      await transport.destroy();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

test("invalid success bodies stop safely after one HTTP request, with no response content in diagnostics", async (t) => {
  const secret = "fixture-private-response-text";
  const cases: { name: string; body: string; mode?: ResearchConfig["OPENAI_API_MODE"] }[] = [
    { name: "HTML", body: `<html>${secret}</html>` },
    { name: "bad JSON", body: `{broken:${secret}}` },
    { name: "arbitrary string", body: JSON.stringify(secret) },
    { name: "error object", body: JSON.stringify({ error: { message: secret } }) },
    { name: "array", body: JSON.stringify([responseEnvelope(secret)]) },
    { name: "two extra encodings", body: JSON.stringify(JSON.stringify(JSON.stringify(responseEnvelope(secret)))) },
    { name: "message without content", body: JSON.stringify({ ...responseEnvelope(secret), output: [{ type: "message", role: "assistant", text: secret }] }) },
    { name: "reasoning without summary", body: JSON.stringify({ ...responseEnvelope(secret), output: [{ type: "reasoning", text: secret }] }) },
    { name: "function without arguments", body: JSON.stringify({ ...responseEnvelope(secret), output: [{ type: "function_call", name: secret }] }) },
    { name: "chat envelope for responses", body: JSON.stringify({ id: secret, object: "chat.completion", choices: [{ message: { role: "assistant", content: secret } }] }) },
    { name: "response envelope for chat", body: JSON.stringify(responseEnvelope(secret)), mode: "chat_completions" },
    { name: "chat function without function data", body: JSON.stringify({ id: secret, object: "chat.completion", choices: [{ message: { role: "assistant", content: null, tool_calls: [{ type: "function", id: secret }] } }] }), mode: "chat_completions" },
  ];
  for (const { name, body, mode } of cases) await t.test(name, async () => {
    const fixture = await httpFixture(() => ({ body, contentType: "text/plain" }));
    const provider = createModelProvider(fixtureConfig(fixture.baseUrl, false, mode));
    try {
      const agent = new Agent({ name: "invalid response fixture", model: "fixture-model", modelSettings: { retry: { maxRetries: 0 } } });
      await assert.rejects(new Runner({ modelProvider: provider, tracingDisabled: true }).run(agent, "test"), (error: unknown) => {
        assert.ok(error instanceof OpenAI.APIConnectionError);
        const message = publicError(error);
        assert.match(message, /响应|JSON|协议/);
        assert.equal(message.includes("无法连接"), false);
        assert.equal(message.includes(secret), false);
        assert.equal(String(error).includes(secret), false);
        assertSafeLogs(error, secret);
        return true;
      });
      assert.equal(fixture.requests.length, 1);
    } finally { await provider.close(); await fixture.close(); }
  });
});

test("the response byte limit stops oversized success bodies without retaining provider content in the error", async () => {
  const fixture = await httpFixture(() => ({ body: "x".repeat(8 * 1024 * 1024 + 1), contentType: "application/json" }));
  const provider = createModelProvider(fixtureConfig(fixture.baseUrl));
  try {
    const agent = new Agent({ name: "oversize response fixture", model: "fixture-model", modelSettings: { retry: { maxRetries: 0 } } });
    await assert.rejects(new Runner({ modelProvider: provider, tracingDisabled: true }).run(agent, "test"), (error: unknown) => {
      assert.ok(error instanceof OpenAI.APIConnectionError);
      assert.match(publicError(error), /8 MiB/);
      return true;
    });
    assert.equal(fixture.requests.length, 1);
  } finally { await provider.close(); await fixture.close(); }
});

test("HTTP errors retain their SDK status and are neither normalized nor retried", async () => {
  const secret = "fixture-private-auth-error";
  const fixture = await httpFixture(() => ({ status: 401, contentType: "text/plain", body: secret }));
  const provider = createModelProvider(fixtureConfig(fixture.baseUrl));
  try {
    const agent = new Agent({ name: "HTTP error fixture", model: "fixture-model", modelSettings: { retry: { maxRetries: 0 } } });
    await assert.rejects(new Runner({ modelProvider: provider, tracingDisabled: true }).run(agent, "test"), (error: unknown) => {
      assert.ok(error instanceof OpenAI.AuthenticationError);
      assert.equal(error.status, 401);
      assert.equal(publicError(error).includes(secret), false);
      assert.match(publicError(error), /认证失败/);
      assertSafeLogs(error, secret);
      return true;
    });
    assert.equal(fixture.requests.length, 1);
  } finally { await provider.close(); await fixture.close(); }
});

test("the frontend connection check uses the same response compatibility and safe errors", async () => {
  for (const valid of [true, false]) {
    const secret = "fixture-private-connection-check";
    const fixture = await httpFixture(() => ({ contentType: "text/plain", body: valid
      ? JSON.stringify(JSON.stringify({ ...responseEnvelope(""), output: [{ type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "connection_check", arguments: '{"ok":true}', status: "completed" }] }))
      : `<html>${secret}</html>` }));
    const settings = { baseUrl: fixture.baseUrl, model: "fixture-model", apiMode: "responses" as const, timeoutSeconds: 30, deepseekSearchEnabled: false, apiKey: "fixture-local-key" };
    try {
      if (valid) assert.equal((await testModelConnection(settings, "127.0.0.1")).ok, true);
      else await assert.rejects(testModelConnection(settings, "127.0.0.1"), (error: unknown) => {
        assert.match(publicError(error), /JSON/);
        assert.equal(publicError(error).includes(secret), false);
        assert.equal(publicError(error).includes("无法连接"), false);
        return true;
      });
      assert.equal(fixture.requests.length, 1);
    } finally { await fixture.close(); }
  }
});

test("provider diagnostics retain HTTP status without exposing response secrets", () => {
  const secret = "fixture-private-provider-value";
  for (const status of [400, 403, 404, 422, 500, 502, 503]) {
    const error = OpenAI.APIError.generate(status, { message: secret, code: secret }, secret,
      new Headers({ "x-request-id": secret, authorization: "Bearer " + secret }));
    const message = publicError(error);
    assert.ok(message.includes(`HTTP ${status}`));
    assert.equal(message.includes(secret), false);
  }
  const error = new OpenAI.APIError(undefined, { message: secret }, secret, undefined);
  assert.equal(publicError(error).includes("HTTP"), false);
  assert.equal(publicError(error).includes(secret), false);
});

test("model connections use the configured budget beyond native fetch's 10 seconds without retrying", { timeout: 25_000 }, async () => {
  const originalEnv = { ...process.env };
  const sockets = new Set<net.Socket>();
  let connections = 0;
  // Hold the TLS handshake open past native fetch's connection timeout, then
  // close it. This needs no certificates or external model requests.
  const server = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("error", () => {});
    const timer = setTimeout(() => socket.destroy(), 11_500);
    socket.on("close", () => { clearTimeout(timer); sockets.delete(socket); });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  Object.assign(process.env, {
    SCENARIOFORGE_ENV_FILE: "",
    OPENAI_API_KEY: "fixture-local-key", OPENAI_BASE_URL: `https://127.0.0.1:${address.port}/v1`,
    OPENAI_API_MODE: "responses", SCENARIOFORGE_MODEL: "fixture-model", MODEL_TIMEOUT_SECONDS: "20",
    SCENARIOFORGE_INTERNAL_TOKEN: "fixture-token-".repeat(3),
  });
  const provider = createModelProvider();
  const started = Date.now();
  try {
    const runner = new Runner({ modelProvider: provider, tracingDisabled: true });
    const agent = new Agent({ name: "transport fixture", model: "fixture-model", modelSettings: { retry: { maxRetries: 0 } } });
    await assert.rejects(runner.run(agent, "test"), (error: unknown) => {
      assert.ok(error instanceof OpenAI.APIConnectionError);
      assert.equal(error instanceof OpenAI.APIConnectionTimeoutError, false, "connection was cut off before the configured budget");
      return true;
    });
    assert.ok(Date.now() - started >= 11_000);
    assert.equal(connections, 1, "a failed model request must not be retried");
  } finally {
    await provider.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
    process.env = originalEnv;
  }
});
