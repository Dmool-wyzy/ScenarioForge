import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { Agent, Runner, ToolCallError, Usage, type Model } from "@openai/agents";
import { ScopedMcpServer } from "../lib/research-mcp";
import { ApiError, publicError } from "../lib/errors";
import OpenAI from "openai";
import { RESEARCH_AGENT_BUDGET } from "../lib/agent-budget";

test("model transport and provider failures expose safe actionable diagnostics", () => {
  assert.match(publicError(new OpenAI.APIConnectionTimeoutError()), /模型服务.*超时.*未自动重试/);
  assert.match(publicError(new OpenAI.APIConnectionError({ cause: new Error("private network diagnostic") })), /无法连接模型服务/);
  const secret = "private-provider-content";
  const limited = new OpenAI.RateLimitError(429, { message: secret }, secret, new Headers());
  assert.match(publicError(limited), /限流或额度不足/);
  assert.equal(publicError(limited).includes(secret), false);
  const invalidKey = new OpenAI.AuthenticationError(401, { message: secret }, secret, new Headers());
  assert.match(publicError(invalidKey), /项目专用 API key/);
  assert.equal(publicError(invalidKey).includes(secret), false);
});

// Real Agents SDK and HTTP MCP transport; no model API or application database.
let url: string;
let delayMs = 0;
let fail = false;
let toolCalls = 0;
let searchUnavailable = false;
let generationFailed = false;
let planningFailed = false;
const scopes: string[] = [];
const creationArguments: Record<string, unknown>[] = [];
const server = http.createServer(async (request, response) => {
  if (request.method !== "POST") { response.writeHead(405).end(); return; }
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  if (body.id === undefined) { response.writeHead(202).end(); return; }
  let result;
  if (body.method === "initialize") {
    result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "local-fixture", version: "1" } };
  } else if (body.method === "tools/list") {
    result = { tools: ["create_research_package", "search_scenario", "generate_workspace", "answer_user"].map((name) => ({ name, description: "Local research fixture", inputSchema: { type: "object", properties: { package_id: { type: "string" } }, required: ["package_id"], additionalProperties: false } })) };
  } else if (body.method === "tools/call") {
    toolCalls++;
    scopes.push(body.params.arguments.package_id);
    if (body.params.name === "create_research_package") creationArguments.push(body.params.arguments);
    if (delayMs) await new Promise<void>((done) => {
      const timer = setTimeout(done, delayMs);
      response.once("close", () => { clearTimeout(timer); done(); });
    });
    result = { isError: fail, content: [{ type: "text", text: fail ? "private provider error must not reach the UI" : "plan saved" }] };
    if (searchUnavailable) {
      result = { isError: false, content: [{ type: "text", text: JSON.stringify({ status: "search_unavailable", code: "no_evidence", message: "当前使用 mock 测试搜索，模型未提取到有效证据。请切换真实搜索 Provider。" }) }] };
    }
    if (generationFailed) result = { isError: false, content: [{ type: "text", text: JSON.stringify({ status: "generation_failed", code: "model_timeout", filename: "RESEARCH.md", message: "模型服务等待超过 120 秒，未自动重试；已保存文件保留。" }) }] };
    if (planningFailed) result = { isError: false, content: [{ type: "text", text: JSON.stringify({ status: "planning_failed", code: "invalid_model_output", message: "模型连续返回不符合格式的内容，已停止；已保存文件保留。" }) }] };
  } else {
    result = {};
  }
  if (!response.destroyed) response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
});

before(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  url = `http://127.0.0.1:${address.port}/mcp`;
});
after(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });

function fixture() {
  const events: { type: string; message: string }[] = [];
  const mcp = new ScopedMcpServer("owned-package", url, async (type, message) => { events.push({ type, message }); });
  return { mcp, events };
}

test("research Agent cannot submit its own user answers", async () => {
  const { mcp } = fixture();
  try {
    await mcp.connect();
    assert.equal((await mcp.listTools()).some(tool => tool.name === "answer_user"), false);
    await assert.rejects(mcp.callToolResult("answer_user", { package_id: "owned-package" }), /不可代替用户/);
  } finally { await mcp.close(); }
});

test("research MCP stops before exceeding its tool-call budget", async () => {
  const { mcp } = fixture();
  const beforeCalls = toolCalls;
  try {
    await mcp.connect();
    for (let i = 0; i < RESEARCH_AGENT_BUDGET.maxToolCalls; i++) {
      await mcp.callToolResult("create_research_package", { package_id: "other-package" });
    }
    assert.equal(toolCalls - beforeCalls, RESEARCH_AGENT_BUDGET.maxToolCalls);
    await assert.rejects(mcp.callToolResult("create_research_package", { package_id: "other-package" }), /工具调用已达到上限/);
    assert.equal(toolCalls - beforeCalls, RESEARCH_AGENT_BUDGET.maxToolCalls);
  } finally { await mcp.close(); }
});

test("creation advertises only the package ID and strips invented plan arguments before HTTP", async () => {
  const { mcp } = fixture();
  try {
    await mcp.connect();
    const creation = (await mcp.listTools()).find((tool) => tool.name === "create_research_package");
    assert.ok(creation);
    assert.deepEqual(Object.keys(creation.inputSchema.properties ?? {}), ["package_id"]);
    assert.equal(creation.inputSchema.additionalProperties, false);
    await mcp.callTool("create_research_package", { package_id: "other-package", research_questions: ["invented"], constraints_summary: "invented", goal: "rewritten user goal" });
    assert.deepEqual(creationArguments.at(-1), { package_id: "owned-package" });
  } finally { await mcp.close(); }
});

test("search advertises the saved question index rather than editable question text", async () => {
  const { mcp } = fixture();
  try {
    await mcp.connect();
    const search = (await mcp.listTools()).find((tool) => tool.name === "search_scenario");
    assert.ok(search);
    assert.ok(search.inputSchema.required?.includes("question_index"));
    assert.equal("question" in (search.inputSchema.properties ?? {}), false);
    assert.equal(search.inputSchema.additionalProperties, false);
  } finally { await mcp.close(); }
});

test("a model-backed tool may take longer than the MCP default 60 seconds", { timeout: 75_000 }, async () => {
  delayMs = 61_000;
  fail = false;
  const { mcp, events } = fixture();
  try {
    await mcp.connect();
    await mcp.listTools();
    const result = await mcp.callTool("create_research_package", { package_id: "other-package" });
    assert.equal(result[0].type, "text");
    assert.equal(scopes.at(-1), "owned-package");
    assert.deepEqual(events.map((event) => event.type), ["tool_started", "tool_completed"]);
  } finally { await mcp.close(); }
});

for (const planningFailure of [false, true]) test(`${planningFailure ? "planning failures" : "tool errors"} stop the real Runner after one model call and report the failing step`, async () => {
  delayMs = 0;
  fail = !planningFailure;
  planningFailed = planningFailure;
  const { mcp, events } = fixture();
  let modelCalls = 0;
  const previousCalls = toolCalls;
  const model: Model = {
    async getResponse(request) {
      modelCalls++;
      const tool = request.tools.find((item) => item.type === "function");
      assert.ok(tool);
      return { usage: new Usage(), output: [{ type: "function_call", callId: "fixture-call", name: tool.name, arguments: JSON.stringify({ package_id: "other-package" }), status: "completed" }] };
    },
    getStreamedResponse() { throw new Error("Streaming is not used by this fixture"); },
  };
  try {
    await mcp.connect();
    const agent = new Agent({ name: "fixture", model, mcpServers: [mcp] });
    await assert.rejects(new Runner({ tracingDisabled: true }).run(agent, "start"), (error: unknown) => {
      assert.ok(error instanceof ToolCallError, String(error));
      assert.ok(error.error instanceof ApiError);
      assert.match(publicError(error), /创建研究计划失败/);
      if (planningFailure) assert.match(publicError(error), /模型连续返回不符合格式的内容.*已停止/);
      assert.equal(publicError(error).includes("private provider"), false);
      return true;
    });
    assert.equal(modelCalls, 1);
    assert.equal(toolCalls - previousCalls, 1);
    assert.deepEqual(events.map((event) => event.type), ["tool_started", "tool_failed"]);
    if (planningFailure) assert.match(events.at(-1)!.message, /模型连续返回不符合格式的内容/);
    assert.equal(scopes.at(-1), "owned-package");
  } finally { planningFailed = false; await mcp.close(); }
});

test("cancellation interrupts a pending tool instead of marking it completed", async () => {
  delayMs = 10_000;
  fail = false;
  const { mcp, events } = fixture();
  const abort = new AbortController();
  try {
    await mcp.connect();
    await mcp.listTools();
    const pending = mcp.callTool("create_research_package", {}, undefined, { signal: abort.signal });
    setTimeout(() => abort.abort(), 100);
    await assert.rejects(pending, /已取消/);
    assert.deepEqual(events.map((event) => event.type), ["tool_started", "tool_failed"]);
  } finally { await mcp.close(); }
});

test("a search with no usable evidence reports its reason and stops the tool", async () => {
  delayMs = 0;
  fail = false;
  searchUnavailable = true;
  const { mcp, events } = fixture();
  try {
    await mcp.connect();
    await mcp.listTools();
    await assert.rejects(mcp.callTool("search_scenario", {}), /mock 测试搜索.*未提取到有效证据/);
    assert.deepEqual(events.map((event) => event.type), ["tool_started", "tool_failed"]);
  } finally { searchUnavailable = false; await mcp.close(); }
});

test("generation timeouts show the file and safe reason instead of asking to inspect MCP logs", async () => {
  delayMs = 0; fail = false; generationFailed = true;
  const { mcp, events } = fixture();
  try {
    await mcp.connect(); await mcp.listTools();
    await assert.rejects(mcp.callTool("generate_workspace", {}), /RESEARCH\.md.*120 秒.*已保存文件保留/);
    assert.deepEqual(events.map(event => event.type), ["tool_started", "tool_failed"]);
  } finally { generationFailed = false; await mcp.close(); }
});
