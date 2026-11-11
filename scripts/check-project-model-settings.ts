import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import type { LookupFunction } from "node:net";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { Agent, MockAgent } from "undici";
import { ApiError } from "../lib/errors";
import { encryptModelSettings, decryptModelSettings, encryptPersonalAgentSettings, decryptPersonalAgentSettings, settingsMetadata, modelProviderData, modelSettingsSchema, type ModelSettings } from "../lib/model-settings";
import { modelBaseUrl, modelAddress, modelTransport, modelFetch } from "../lib/model-endpoint";
import { testModelConnection } from "../lib/model-test";
import { Agent as ResearchAgent, Runner } from "@openai/agents";
import { createModelProvider } from "../lib/openai";
import { getResearchConfig } from "../lib/env";

const fixture: ModelSettings = { baseUrl: "https://model-fixture.example/v1", model: "fixture-model", apiMode: "responses", timeoutSeconds: 30, deepseekSearchEnabled: false, apiKey: "fixture-key-not-a-real-provider-secret" };

function responsesReply(output: Record<string, unknown>[]) {
  return { id: "resp-fixture", object: "response", created_at: 0, model: fixture.model, status: "completed", output };
}

function chatReply(message: Record<string, unknown>, finishReason = "stop") {
  return { id: "chatcmpl-fixture", object: "chat.completion", created: 0, model: fixture.model, choices: [{ index: 0, finish_reason: finishReason, message }] };
}

test("model settings use randomized authenticated encryption bound to one project", () => {
  const original = process.env.SCENARIOFORGE_SETTINGS_KEY;
  process.env.SCENARIOFORGE_SETTINGS_KEY = randomBytes(32).toString("base64");
  try {
    const encrypted = encryptModelSettings("project-a", fixture);
    assert.ok(!encrypted.includes(fixture.apiKey));
    assert.ok(encrypted !== encryptModelSettings("project-a", fixture), "Encryption reused its nonce.");
    assert.deepEqual(decryptModelSettings("project-a", encrypted), fixture);
    assert.throws(() => decryptModelSettings("project-b", encrypted), error => error instanceof ApiError && error.status === 503);
    for (const component of [1, 2, 3]) {
      const parts = encrypted.split(".");
      const altered = Buffer.from(parts[component], "base64");
      altered[0] ^= 1;
      parts[component] = altered.toString("base64");
      assert.throws(() => decryptModelSettings("project-a", parts.join(".")), error => error instanceof ApiError && error.status === 503);
    }
    const metadata = settingsMetadata(fixture)!;
    assert.deepEqual(Object.keys(metadata).sort(), ["apiMode", "baseUrl", "deepseekSearchEnabled", "hasApiKey", "model", "timeoutSeconds"].sort());
    assert.ok(!JSON.stringify(metadata).includes(fixture.apiKey.slice(-8)));
    process.env.SCENARIOFORGE_SETTINGS_KEY = randomBytes(32).toString("base64");
    assert.throws(() => decryptModelSettings("project-a", encrypted), error => error instanceof ApiError && error.status === 503);
    delete process.env.SCENARIOFORGE_SETTINGS_KEY;
    assert.throws(() => encryptModelSettings("project-a", fixture), error => error instanceof ApiError && error.status === 503);
  } finally {
    if (original === undefined) delete process.env.SCENARIOFORGE_SETTINGS_KEY;
    else process.env.SCENARIOFORGE_SETTINGS_KEY = original;
  }
});

test("personal Agent credentials are encrypted separately for each project member", () => {
  const original = process.env.SCENARIOFORGE_SETTINGS_KEY;
  process.env.SCENARIOFORGE_SETTINGS_KEY = randomBytes(32).toString("base64");
  try {
    const encrypted = encryptPersonalAgentSettings("project-a", "member-a", fixture);
    assert.ok(!encrypted.includes(fixture.apiKey));
    assert.deepEqual(decryptPersonalAgentSettings("project-a", "member-a", encrypted), fixture);
    for (const [projectId, userId] of [["project-b", "member-a"], ["project-a", "member-b"]]) {
      assert.throws(() => decryptPersonalAgentSettings(projectId, userId, encrypted), error => error instanceof ApiError && error.status === 503);
    }
  } finally {
    if (original === undefined) delete process.env.SCENARIOFORGE_SETTINGS_KEY;
    else process.env.SCENARIOFORGE_SETTINGS_KEY = original;
  }
});

test("DeepSeek Search defaults off for old settings and only accepts the official host", () => {
  const oldSettings: Record<string, unknown> = { ...fixture };
  delete oldSettings.deepseekSearchEnabled;
  assert.equal(modelSettingsSchema.parse(oldSettings).deepseekSearchEnabled, false);
  assert.equal(modelSettingsSchema.parse({ ...fixture, baseUrl: "https://api.deepseek.com/v1", deepseekSearchEnabled: true }).deepseekSearchEnabled, true);
  assert.throws(() => modelSettingsSchema.parse({ ...fixture, deepseekSearchEnabled: true }), /api\.deepseek\.com/);
});

test("model API URLs reject unsafe syntax, private destinations and mixed DNS answers", async t => {
  assert.equal(modelBaseUrl("https://api.example.com:443/v1///"), "https://api.example.com/v1");
  for (const value of ["invalid", "http://example.com/v1", "https://user:password@example.com/v1", "https://example.com/v1?key=secret", "https://example.com/v1#secret", "https://example.com:8443/v1"]) {
    assert.throws(() => modelBaseUrl(value), error => error instanceof ApiError && error.status === 400);
  }
  for (const address of ["127.0.0.1", "127.1", "2130706433", "10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.100.100.200", "0.0.0.0"]) {
    await assert.rejects(modelAddress(`https://${address}/v1`), error => error instanceof ApiError && error.status === 400);
  }
  let answers = [{ address: "93.184.216.34", family: 4 }];
  const lookup = t.mock.method(dns, "lookup", async () => answers);
  syncBuiltinESMExports();
  t.after(() => { lookup.mock.restore(); syncBuiltinESMExports(); });
  assert.equal(await modelAddress(fixture.baseUrl), "93.184.216.34");
  assert.deepEqual(lookup.mock.calls[0].arguments, ["model-fixture.example", { family: 4, all: true }]);
  answers = [{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }];
  await assert.rejects(modelAddress(fixture.baseUrl), error => error instanceof ApiError && error.status === 400);
  answers = [{ address: "127.0.0.1", family: 4 }];
  await assert.rejects(modelAddress("https://localhost/v1"), error => error instanceof ApiError && error.status === 400);
  await assert.rejects(modelAddress("https://metadata.google.internal/v1"), error => error instanceof ApiError && error.status === 400);
  const originalFakeHosts = process.env.SCENARIOFORGE_MODEL_FAKE_IP_HOSTS;
  try {
    process.env.SCENARIOFORGE_MODEL_FAKE_IP_HOSTS = "api.sudocode.chat,model-fixture.example";
    answers = [{ address: "198.18.0.8", family: 4 }];
    assert.equal(await modelAddress("https://api.sudocode.chat/v1"), "198.18.0.8");
    assert.equal(await modelAddress(fixture.baseUrl), "198.18.0.8");
    await assert.rejects(modelAddress("https://api.sudocode.chat.evil.example/v1"), error => error instanceof ApiError && error.status === 400);
    answers = [{ address: "198.18.0.8", family: 4 }, { address: "93.184.216.34", family: 4 }];
    await assert.rejects(modelAddress(fixture.baseUrl), error => error instanceof ApiError && error.status === 400);
    answers = [{ address: "198.18.0.8", family: 4 }, { address: "10.0.0.4", family: 4 }];
    await assert.rejects(modelAddress(fixture.baseUrl), error => error instanceof ApiError && error.status === 400);
    await assert.rejects(modelAddress("https://198.18.0.8/v1"), error => error instanceof ApiError && error.status === 400);
    process.env.SCENARIOFORGE_MODEL_FAKE_IP_HOSTS = "other.example";
    answers = [{ address: "198.18.0.8", family: 4 }];
    await assert.rejects(modelAddress(fixture.baseUrl), error => error instanceof ApiError && error.status === 400);
  } finally {
    if (originalFakeHosts === undefined) delete process.env.SCENARIOFORGE_MODEL_FAKE_IP_HOSTS;
    else process.env.SCENARIOFORGE_MODEL_FAKE_IP_HOSTS = originalFakeHosts;
  }
});

test("the transport lookup pins the validated address and rejects other hosts or private pins", async () => {
  const transport = modelTransport(fixture.baseUrl, 5000, "93.184.216.34");
  const blocked = modelTransport(fixture.baseUrl, 5000, "169.254.169.254");
  const originalFakeHosts = process.env.SCENARIOFORGE_MODEL_FAKE_IP_HOSTS;
  function lookupOf(agent: Agent) {
    const options = Object.getOwnPropertySymbols(agent).find(key => key.description === "options");
    assert.ok(options, "Undici no longer exposes its connection options to this transport check.");
    return (Reflect.get(agent, options) as { connect: { lookup: LookupFunction } }).connect.lookup;
  }
  function resolve(lookup: LookupFunction, host: string, all = false) {
    return new Promise<unknown>((done, reject) => lookup(host, { all }, (error, address) => error ? reject(error) : done(address)));
  }
  try {
    assert.equal(await resolve(lookupOf(transport), "model-fixture.example"), "93.184.216.34");
    assert.deepEqual(await resolve(lookupOf(transport), "model-fixture.example", true), [{ address: "93.184.216.34", family: 4 }]);
    await assert.rejects(resolve(lookupOf(transport), "different.example"));
    await assert.rejects(resolve(lookupOf(blocked), "model-fixture.example"));
    process.env.SCENARIOFORGE_MODEL_FAKE_IP_HOSTS = "model-fixture.example";
    const fakeIpTransport = modelTransport(fixture.baseUrl, 5000, "198.18.0.8");
    try {
      assert.equal(await resolve(lookupOf(fakeIpTransport), "model-fixture.example"), "198.18.0.8");
      process.env.SCENARIOFORGE_MODEL_FAKE_IP_HOSTS = "other.example";
      await assert.rejects(resolve(lookupOf(fakeIpTransport), "model-fixture.example"));
    } finally { await fakeIpTransport.destroy(); }
  } finally {
    if (originalFakeHosts === undefined) delete process.env.SCENARIOFORGE_MODEL_FAKE_IP_HOSTS;
    else process.env.SCENARIOFORGE_MODEL_FAKE_IP_HOSTS = originalFakeHosts;
    await transport.destroy();
    await blocked.destroy();
  }
});

async function mockedProbe(t: TestContext, apiMode: ModelSettings["apiMode"], status: number, reply: object | string | Buffer, headers: Record<string, string> = {}, baseUrl = fixture.baseUrl) {
  const mock = new MockAgent();
  mock.disableNetConnect();
  const origin = new URL(baseUrl).origin;
  const pool = mock.get(origin);
  const calls: { origin: string; path: string; body: Record<string, unknown>; identityRequested: boolean }[] = [];
  const path = `${new URL(baseUrl).pathname.replace(/\/$/, "")}${apiMode === "responses" ? "/responses" : "/chat/completions"}`;
  pool.intercept({ path, method: "POST" }).reply(status, reply, { headers: { "content-type": "application/json", ...headers } });
  const dispatch = t.mock.method(Agent.prototype, "dispatch", (options: Parameters<Agent["dispatch"]>[0], handler: Parameters<Agent["dispatch"]>[1]) => {
    const call = { origin: String(options.origin), path: options.path, body: {} as Record<string, unknown>, identityRequested: /accept-encoding.*identity/i.test(JSON.stringify(options.headers)) };
    calls.push(call);
    void (async () => {
      let body = "";
      if (typeof options.body === "string" || Buffer.isBuffer(options.body)) body = options.body.toString();
      else if (options.body) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of options.body as AsyncIterable<Uint8Array>) chunks.push(chunk);
        body = Buffer.concat(chunks).toString();
      }
      call.body = JSON.parse(body || "{}");
      pool.dispatch({ ...options, body }, handler);
    })().catch(error => handler.onError?.(error));
    return true;
  });
  t.after(async () => { dispatch.mock.restore(); await mock.close(); });
  const raw = async (url = origin + path, signal?: AbortSignal) => {
    const transport = modelTransport(baseUrl, 5000, "93.184.216.34");
    try { return await modelFetch(transport, baseUrl)(url, { method: "POST", body: "{}", signal }); }
    finally { await transport.destroy(); }
  };
  return { run: () => testModelConnection({ ...fixture, baseUrl, apiMode }, "93.184.216.34"), raw, calls };
}

test("Responses and Chat probes require valid function arguments and sanitize provider errors without retries", async t => {
  for (const apiMode of ["responses", "chat_completions"] as const) {
    const success = apiMode === "responses"
      ? responsesReply([{ id: "fc-fixture", type: "function_call", name: "connection_check", arguments: '{"ok":true}', call_id: "fixture-call", status: "completed" }])
      : chatReply({ role: "assistant", tool_calls: [{ id: "fixture-call", type: "function", function: { name: "connection_check", arguments: '{"ok":true}' } }] }, "tool_calls");
    await t.test(`${apiMode}: function probe succeeds offline`, async child => {
      const probe = await mockedProbe(child, apiMode, 200, success);
      assert.equal((await probe.run()).ok, true);
      assert.equal(probe.calls.length, 1);
      assert.equal(probe.calls[0].identityRequested, true);
      assert.equal(probe.calls[0].body.model, fixture.model);
      assert.deepEqual(probe.calls[0].body.tool_choice, apiMode === "responses" ? { type: "function", name: "connection_check" } : { type: "function", function: { name: "connection_check" } });
      assert.equal(probe.calls[0].body.thinking, undefined);
      if (apiMode === "responses") assert.equal((probe.calls[0].body.text as { format: { type: string } }).format.type, "json_schema");
    });
    for (const argumentsText of ['{"ok":false}', 'invalid-json']) {
      await t.test(`${apiMode}: invalid tool arguments are rejected`, async child => {
        const reply = apiMode === "responses"
          ? responsesReply([{ id: "fc-fixture", type: "function_call", name: "connection_check", arguments: argumentsText, call_id: "fixture-call", status: "completed" }])
          : chatReply({ role: "assistant", tool_calls: [{ id: "fixture-call", type: "function", function: { name: "connection_check", arguments: argumentsText } }] }, "tool_calls");
        const probe = await mockedProbe(child, apiMode, 200, reply);
        await assert.rejects(probe.run(), error => error instanceof ApiError && error.status === 422);
      });
    }
    await t.test(`${apiMode}: text-only output is not a successful tool probe`, async child => {
      const plain = apiMode === "responses" ? responsesReply([]) : chatReply({ role: "assistant", content: "connected" });
      const probe = await mockedProbe(child, apiMode, 200, plain);
      await assert.rejects(probe.run(), error => error instanceof ApiError && error.status === 422);
      assert.equal(probe.calls.length, 1);
    });
    for (const [status, expected] of [[401, 422], [429, 429], [500, 502]]) {
      await t.test(`${apiMode}: provider ${status} is sanitized and not retried`, async child => {
        const probe = await mockedProbe(child, apiMode, status, { error: { message: `private diagnostic ${fixture.apiKey}` } });
        await assert.rejects(probe.run(), error => error instanceof ApiError && error.status === expected && !error.message.includes(fixture.apiKey) && !error.message.includes("private diagnostic") && (status !== 500 || /HTTP 500/.test(error.message)));
        assert.equal(probe.calls.length, 1);
      });
    }
    await t.test(`${apiMode}: redirects do not forward the key to metadata endpoints`, async child => {
      const probe = await mockedProbe(child, apiMode, 302, {}, { location: "https://169.254.169.254/latest/meta-data/" });
      await assert.rejects(probe.run(), error => error instanceof ApiError && error.status === 502);
      assert.equal(probe.calls.length, 1, "The client followed a model API redirect.");
    });
  }
  await t.test("DeepSeek Chat Completions disables thinking for forced tool calls", async child => {
    const reply = chatReply({ role: "assistant", tool_calls: [{ id: "fixture-call", type: "function", function: { name: "connection_check", arguments: '{"ok":true}' } }] }, "tool_calls");
    const probe = await mockedProbe(child, "chat_completions", 200, reply, {}, "https://api.deepseek.com");
    assert.equal((await probe.run()).ok, true);
    assert.deepEqual(probe.calls[0].body.thinking, { type: "disabled" });
  });
  await t.test("DeepSeek Responses mode does not receive Chat Completions settings", async child => {
    const reply = responsesReply([{ id: "fc-fixture", type: "function_call", name: "connection_check", arguments: '{"ok":true}', call_id: "fixture-call", status: "completed" }]);
    const probe = await mockedProbe(child, "responses", 200, reply, {}, "https://api.deepseek.com");
    assert.equal((await probe.run()).ok, true);
    assert.equal(probe.calls[0].body.thinking, undefined);
  });
});

test("DeepSeek research requests carry the same compatibility settings through the Agents SDK", async t => {
  assert.deepEqual(modelProviderData({ baseUrl: "https://api.deepseek.com.evil.example", apiMode: "chat_completions" }), {});
  const reply = { id: "chatcmpl-fixture", object: "chat.completion", created: 0, model: "fixture-model", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }] };
  const probe = await mockedProbe(t, "chat_completions", 200, reply, {}, "https://api.deepseek.com");
  const env = { ...getResearchConfig({ OPENAI_API_KEY: fixture.apiKey, OPENAI_BASE_URL: "https://api.deepseek.com", OPENAI_API_MODE: "chat_completions", SCENARIOFORGE_MODEL: fixture.model, SCENARIOFORGE_INTERNAL_TOKEN: "fixture-token-".repeat(3) }), PROJECT_MODEL_CONFIG: true, MODEL_VALIDATED_ADDRESS: "93.184.216.34" };
  const provider = createModelProvider(env);
  try {
    const agent = new ResearchAgent({ name: "DeepSeek fixture", model: fixture.model, modelSettings: { maxTokens: 777, providerData: modelProviderData({ baseUrl: env.OPENAI_BASE_URL, apiMode: env.OPENAI_API_MODE }), retry: { maxRetries: 0 } } });
    const runner = new Runner({ modelProvider: provider, tracingDisabled: true });
    assert.equal((await runner.run(agent, "test")).finalOutput, "ok");
    assert.equal(probe.calls.length, 1);
    assert.deepEqual(probe.calls[0].body.thinking, { type: "disabled" });
    assert.equal(probe.calls[0].body.max_tokens, 777);
  } finally { await provider.close(); }
});

test("Agents SDK sends output-token caps for both API modes", async t => {
  for (const apiMode of ["responses", "chat_completions"] as const) {
    await t.test(apiMode, async child => {
      const reply = apiMode === "responses"
        ? { id: "resp-fixture", object: "response", created_at: 0, model: "fixture-model", status: "completed", output: [{ type: "message", id: "msg-fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }] }
        : { id: "chatcmpl-fixture", object: "chat.completion", created: 0, model: "fixture-model", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }] };
      const probe = await mockedProbe(child, apiMode, 200, reply);
      const env = { ...getResearchConfig({ OPENAI_API_KEY: fixture.apiKey, OPENAI_BASE_URL: fixture.baseUrl, OPENAI_API_MODE: apiMode, SCENARIOFORGE_MODEL: fixture.model, SCENARIOFORGE_INTERNAL_TOKEN: "fixture-token-".repeat(3) }), PROJECT_MODEL_CONFIG: true, MODEL_VALIDATED_ADDRESS: "93.184.216.34" };
      const provider = createModelProvider(env);
      try {
        const agent = new ResearchAgent({ name: "token budget fixture", model: fixture.model, modelSettings: { maxTokens: 321, retry: { maxRetries: 0 } } });
        assert.equal((await new Runner({ modelProvider: provider, tracingDisabled: true }).run(agent, "test")).finalOutput, "ok");
        const key = apiMode === "responses" ? "max_output_tokens" : "max_tokens";
        assert.equal(probe.calls[0].body[key], 321);
      } finally { await provider.close(); }
    });
  }
});

test("model fetch bounds actual bodies, rejects compression and enforces its origin", async t => {
  const limit = 8 * 1024 * 1024;
  await t.test("an identity response at exactly 8 MiB is accepted", async child => {
    const body = "x".repeat(limit);
    const probe = await mockedProbe(child, "responses", 200, body, { "content-encoding": "identity" });
    assert.equal((await (await probe.raw()).arrayBuffer()).byteLength, limit);
    assert.equal(probe.calls[0].identityRequested, true);
  });
  await t.test("an over-budget body is rejected despite an undersized Content-Length", async child => {
    const probe = await mockedProbe(child, "responses", 200, "x".repeat(limit + 1), { "content-length": "1" });
    await assert.rejects(probe.raw(), error => error instanceof ApiError && error.status === 502 && /8 MiB/.test(error.message));
  });
  await t.test("compressed responses are rejected", async child => {
    const probe = await mockedProbe(child, "responses", 200, gzipSync('{"ok":true}'), { "content-encoding": "gzip" });
    await assert.rejects(probe.raw(), error => error instanceof ApiError && error.status === 502 && /编码/.test(error.message));
  });
  await t.test("cross-origin requests fail before dispatch", async child => {
    const probe = await mockedProbe(child, "responses", 200, {});
    await assert.rejects(probe.raw("https://169.254.169.254/latest/meta-data/"), error => error instanceof ApiError && error.status === 502);
    assert.equal(probe.calls.length, 0);
  });
});

test("a body stalled after response headers remains covered by the request abort budget", async t => {
  let aborted = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const dispatch = t.mock.method(Agent.prototype, "dispatch", (_options: Parameters<Agent["dispatch"]>[0], handler: Parameters<Agent["dispatch"]>[1]) => {
    handler.onConnect?.(error => { aborted = true; clearTimeout(pending); handler.onError?.(error ?? new Error("Request aborted")); });
    handler.onHeaders?.(200, [Buffer.from("content-type"), Buffer.from("application/json")], () => {}, "OK");
    handler.onData?.(Buffer.from('{"partial":'));
    pending = setTimeout(() => { handler.onData?.(Buffer.from("true}")); handler.onComplete?.([]); }, 500);
    return true;
  });
  const transport = modelTransport(fixture.baseUrl, 5000, "93.184.216.34");
  try {
    await assert.rejects(modelFetch(transport, fixture.baseUrl)(fixture.baseUrl + "/responses", { method: "POST", body: "{}", signal: AbortSignal.timeout(40) }));
    assert.equal(aborted, true, "The model response body ignored its abort signal.");
  } finally { clearTimeout(pending); dispatch.mock.restore(); await transport.destroy(); }
});
