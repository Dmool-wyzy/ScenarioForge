import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import JSZip from "jszip";

// Real SDK, HTTP MCP, API, database and worker; deterministic model/search fixtures.
// All provider URLs are local and all subprocesses receive fake API keys.
const root = process.cwd();
await mkdir(resolve(root, ".tmp"), { recursive: true });
const databaseUrl = process.env.SCENARIOFORGE_TEST_DATABASE_URL;
assert.ok(databaseUrl && URL.canParse(databaseUrl), "Set SCENARIOFORGE_TEST_DATABASE_URL to a dedicated MySQL database.");
const target = new URL(databaseUrl);
assert.ok(target.protocol === "mysql:" && /^\/scenarioforge_test_[a-z0-9_]{1,45}$/i.test(target.pathname), "The test database name must start with scenarioforge_test_.");
const fixturePort = process.env.AGENT_E2E_PORT ?? "3000";
const base = `http://localhost:${fixturePort}`;
const token = randomUUID() + randomUUID();
const env = { ...process.env, DATABASE_URL: databaseUrl, SCENARIOFORGE_INTERNAL_TOKEN: token, OPENAI_API_KEY: "fixture-local-key", SEARCH_PROVIDER: "mock", TAVILY_API_KEY: "", OPENAI_BASE_URL: "http://127.0.0.1:9009/v1", SCENARIOFORGE_MCP_URL: "http://127.0.0.1:8001/mcp", SCENARIOFORGE_BACKEND_URL: base, SCENARIOFORGE_PUBLIC_ORIGIN: base, SCENARIOFORGE_MODEL: process.env.SCENARIOFORGE_MODEL ?? "fixture-model", NEXT_TELEMETRY_DISABLED: "1", PYTHONUTF8: "1" };
env.PORT = fixturePort;
env.SCENARIOFORGE_ENV_FILE = "";
env.SCENARIOFORGE_TEST_DIST = "true";
const db = new PrismaClient({ datasourceUrl: databaseUrl });
const processes = new Set();
const ids = [], projectIds = [], userIds = [];
let cookie = "", projectId;
async function authenticatedFetch(url, options = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set("Cookie", cookie);
  if (options.method && options.method !== "GET") headers.set("Origin", base);
  const response = await fetch(url, { ...options, headers });
  const session = response.headers.get("set-cookie");
  if (session) cookie = session.split(";", 1)[0];
  return response;
}
async function createAccountAndProject() {
  cookie = "";
  const response = await authenticatedFetch(`${base}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: `agent_${randomUUID().replaceAll("-", "").slice(0, 16)}`, password: randomUUID() }) });
  assert.equal(response.status, 200);
  userIds.push((await response.json()).user.id);
  const created = await authenticatedFetch(`${base}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Agent fixture project" }) });
  assert.equal(created.status, 201);
  projectId = (await created.json()).project.id;
  projectIds.push(projectId);
}
const calls = new Map();
const lastReads = new Map();
const protocols = new Map();
const ragTest = process.env.AGENT_RAG_TEST === "true";
env.RAG_ENABLED = ragTest ? "true" : "false";
env.EMBEDDING_PROVIDER = "mock";
env.RAG_MIN_SCORE = "0.05";
env.EMBEDDING_API_KEY = "fixture-embedding-key";
const contextReads = new Map();

function pdfFixture() {
  const text = "BT /F1 12 Tf 30 250 Td (PDF fixture) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`];
  let value = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(value)); value += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(value);
  value += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return value;
}

async function uploadFixture(goal) {
  const form = new FormData(); form.set("projectId", projectId); form.set("goal", goal); form.set("constraints", "{}");
  form.append("files", new File(["# Markdown fixture\n用户参考资料。"], "reference.md"));
  form.append("files", new File(["TXT fixture " + "x".repeat(21000)], "reference.txt"));
  form.append("files", new File([pdfFixture()], "reference.pdf", { type: "application/pdf" }));
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX fixture</w:t></w:r></w:p></w:body></w:document>');
  form.append("files", new File([new Uint8Array(await zip.generateAsync({ type: "uint8array" }))], "reference.docx"));
  return form;
}

function launch(executable, args, extraEnv = {}) {
  const child = spawn(executable, args, { cwd: root, env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout.on("data", (data) => { output = (output + data.toString()).slice(-10000); });
  child.stderr.on("data", (data) => { output = (output + data.toString()).slice(-10000); });
  child.on("error", (error) => { output += error.message; });
  processes.add(child);
  return { child, output: () => output };
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill();
  await Promise.race([exited, new Promise((done) => setTimeout(done, 4000))]);
  processes.delete(child);
}

async function until(check, message, milliseconds = 90000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 400));
  }
  throw new Error(message);
}

function toolName(body, suffix) {
  const names = body.tools?.map((t) => t.function?.name ?? t.name) ?? [];
  const name = names.find((n) => n.endsWith(suffix));
  assert.ok(name, `Missing tool ${suffix}`);
  return name;
}

async function choose(body) {
  const serialized = JSON.stringify(body);
  const id = serialized.match(/当前研究包 ID：([a-zA-Z0-9_-]+)/)?.[1];
  assert.ok(id, "SDK request must include its package ID");
  const p = await db.researchPackage.findUniqueOrThrow({ where: { id }, include: { files: true, events: true, clarifications: true } });
  if (body.tools?.some(tool => (tool.function?.name ?? tool.name) === "run_research")) return { name: "run_research", args: { request: p.goal } };
  let call;
  if (p.events.some((event) => event.type === "search_failed")) return { text: "搜索服务暂时不可用，请稍后重试或切换搜索 Provider；本轮不生成来源或文档。" };
  if (!p.researchPlan) {
    const creation = body.tools.find((tool) => (tool.function?.name ?? tool.name).endsWith("create_research_package"));
    const schema = creation.function?.parameters ?? creation.parameters;
    assert.deepEqual(Object.keys(schema.properties), ["package_id"]);
    assert.equal(schema.additionalProperties, false);
    // A compatible provider may still send undeclared fields. The scoped MCP
    // adapter must strip them before the real Python tool validates arguments.
    call = ["create_research_package", { package_id: id, research_questions: ["invented output"], constraints_summary: "invented output" }];
  }
  else {
    const searched = new Set(p.events.filter((e) => e.type === "search_completed").map((e) => JSON.parse(e.payload).question));
    const missing = JSON.parse(p.researchPlan).researchQuestions.find((q) => !searched.has(q));
    // Simulate a provider sending paraphrased question text: only the saved
    // question index may determine evidence and completion identity.
    if (missing) call = ["search_scenario", { package_id: id, question_index: JSON.parse(p.researchPlan).researchQuestions.indexOf(missing), question: `Rewritten: ${missing}` }];
    else if (!p.clarifications.length) call = ["ask_user", { package_id: id, questions: [{ question: "请选择测试目标用户", type: "single_choice", options: ["学生", "所有人"], priority: "blocking", why_needed: "验证 Agent 暂停与恢复" }] }];
    else if (JSON.parse(p.researchPlan).filePlan.some((item) => !p.files.some((file) => file.filename === item.filename))) call = ["generate_workspace", { package_id: id }];
    else {
      const edited = p.files.find((f) => f.userContent && !f.content.includes("AI 测试补充"));
      if (edited && lastReads.get(id) !== edited.version) { lastReads.set(id, edited.version); call = ["read_workspace_file", { package_id: id, filename: edited.filename }]; }
      else if (edited && ragTest && contextReads.get(id) !== edited.version) { contextReads.set(id, edited.version); call = ["get_file_context", { package_id: id, filename: edited.filename }]; }
      else if (edited) {
        const log = ragTest ? await db.retrievalLog.findFirstOrThrow({ where: { packageId: id, query: { startsWith: `${edited.filename}: ` } }, orderBy: { createdAt: "desc" } }) : null;
        call = ["write_workspace_file", { package_id: id, filename: edited.filename, content: `${edited.content}\n\nAI 测试补充：保留用户内容。待确认：当前证据不足以确认额外事实。`, base_version: edited.version, reason: "读取用户修改后追加测试建议", ...(log ? { rag: { retrievalId: log.id, contextVersion: p.contextVersion } } : {}) }];
      }
    }
  }
  if (!call) return { text: "已基于测试证据按文件计划生成文档，所有测试结论待确认。" };
  calls.set(id, [...calls.get(id) ?? [], call[0]]);
  return { name: toolName(body, call[0]), args: call[1] };
}

const fixture = http.createServer(async (request, response) => {
  try {
    if (request.url.startsWith("/search")) {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "private upstream diagnostic" }));
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.stream ?? false, false);
    const packageId = JSON.stringify(body).match(/当前研究包 ID：([a-zA-Z0-9_-]+)/)?.[1];
    protocols.set(packageId, request.url.endsWith("chat/completions") ? "chat_completions" : "responses");
    const choice = await choose(body);
    const callId = `call_${randomUUID()}`;
    const model = body.model;
    const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
    let result;
    if (request.url.endsWith("chat/completions")) {
      result = { id: `chatcmpl_${randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, finish_reason: choice.name ? "tool_calls" : "stop", message: { role: "assistant", content: choice.text ?? null, ...(choice.name ? { tool_calls: [{ id: callId, type: "function", function: { name: choice.name, arguments: JSON.stringify(choice.args) } }] } : {}) } }], usage };
    } else {
      result = { id: `resp_${randomUUID()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", error: null, model, parallel_tool_calls: false, output: choice.name ? [{ type: "function_call", id: `fc_${randomUUID()}`, call_id: callId, name: choice.name, arguments: JSON.stringify(choice.args), status: "completed" }] : [{ type: "message", id: `msg_${randomUUID()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: choice.text, annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    }
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(result));
  } catch (error) {
    console.error("Fixture request failed:", error.message);
    response.writeHead(500, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: { message: error.message } }));
  }
});

let next;
let mcp;
try {
  // Refuse to collide with an existing user development server.
  const occupied = await fetch(base, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
  assert.equal(occupied, false, `Port ${fixturePort} must be free before running check:agent`);
  const migration = launch(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"]);
  assert.equal(await new Promise((done) => migration.child.once("exit", done)), 0, migration.output());
  await new Promise((done) => fixture.listen(9009, "127.0.0.1", done));
  const python = resolve(root, process.platform === "win32" ? "mcp-server/.venv/Scripts/python.exe" : "mcp-server/.venv/bin/python");
  mcp = launch(python, ["scripts/fixture_mcp.py"]);
  await until(async () => fetch("http://127.0.0.1:8001/mcp", { signal: AbortSignal.timeout(1500) }).then(() => true, () => false), `MCP fixture did not start: ${mcp.output()}`);
  for (const mode of ["chat_completions", "responses"]) {
    next = launch(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1"], { OPENAI_API_MODE: mode });
    await until(async () => fetch(base, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false), "Next.js did not start", 180_000);
    await createAccountAndProject();
    const goal = `自动验证完整 Agent 流程 ${mode}`;
    const response = await authenticatedFetch(`${base}/api/research`, mode === "chat_completions" ? { method: "POST", body: await uploadFixture(goal) } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, goal, constraints: {}, files: [] }) });
    assert.equal(response.status, 202, await response.clone().text());
    const { packageId } = await response.json(); ids.push(packageId);
    await until(async () => {
      const p = await db.researchPackage.findUniqueOrThrow({ where: { id: packageId } });
      if (p.status === "failed") throw new Error(`Agent failed: ${next.output()}`);
      return p.status === "waiting_for_user" && p.taskState === "idle";
    }, `Agent did not pause: ${next.output()}`);
    const question = await db.clarification.findFirstOrThrow({ where: { packageId } });
    const session = await db.researchPackage.findUniqueOrThrow({ where: { id: packageId } });
    if (mode === "chat_completions") {
      const uploaded = JSON.parse(session.uploadedFiles);
      assert.equal(uploaded.length, 4);
      assert.equal(uploaded.find((f) => f.filename === "reference.txt").extractedText.length, 20000);
      assert.ok(uploaded.find((f) => f.filename === "reference.pdf").extractedText.includes("PDF fixture"));
      assert.ok(uploaded.find((f) => f.filename === "reference.docx").extractedText.includes("DOCX fixture"));
    }
    assert.ok(JSON.parse(session.sessionState).length > 0, "SDK must persist its session on pause");
    await db.researchPackage.update({ where: { id: packageId }, data: { searchCount: 12 } });
    const beginAgain = async (data) => {
      const response = await fetch(`${base}/api/internal/research/${packageId}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ operation: "begin_search", data }) });
      assert.equal(response.status, 200);
      return response.json();
    };
    const reused = await beginAgain({ question_index: 0 });
    assert.equal(reused.status, "already_researched");
    assert.ok(reused.evidence.length > 0);
    const rewritten = await beginAgain("Rewritten question not in the saved plan");
    assert.equal(rewritten.status, "question_required");
    assert.equal((await db.researchPackage.findUniqueOrThrow({ where: { id: packageId } })).searchCount, 12);
    const answer = await authenticatedFetch(`${base}/api/research/${packageId}/answer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clarificationId: question.id, answer: "学生" }) });
    assert.equal(answer.status, 200);
    await until(async () => {
      const p = await db.researchPackage.findUniqueOrThrow({ where: { id: packageId } });
      if (p.status === "failed") throw new Error(`Agent failed after resume: ${next.output()}`);
      return p.status === "completed" && p.taskState === "idle";
    }, "Agent did not complete after answer");
    const planned = JSON.parse((await db.researchPackage.findUniqueOrThrow({ where: { id: packageId } })).researchPlan).filePlan;
    assert.equal(await db.workspaceFile.count({ where: { packageId } }), planned.length);
    const file = await db.workspaceFile.findUniqueOrThrow({ where: { packageId_filename: { packageId, filename: "PLAN.md" } } });
    const update = await authenticatedFetch(`${base}/api/research/${packageId}/files/PLAN.md`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseVersion: file.version, content: "# 用户最新计划\n\n用户修改必须保留。", changeNote: "验证上下文更新" }) });
    assert.equal(update.status, 200);
    await until(async () => {
      const p = await db.researchPackage.findUniqueOrThrow({ where: { id: packageId } });
      const current = await db.workspaceFile.findUniqueOrThrow({ where: { packageId_filename: { packageId, filename: "PLAN.md" } } });
      if (p.status === "failed") throw new Error(`Agent failed after user edit: ${next.output()}`);
      return p.status === "completed" && p.taskState === "idle" && current.content.includes("AI 测试补充");
    }, "Agent did not read and incorporate user changes");
    const final = await db.researchPackage.findUniqueOrThrow({ where: { id: packageId } });
    assert.equal(final.sessionId, session.sessionId);
    assert.equal(protocols.get(packageId), mode, "The SDK must use the selected API protocol");
    const names = calls.get(packageId);
    assert.deepEqual(names.slice(0, 5), ["create_research_package", "search_scenario", "search_scenario", "search_scenario", "ask_user"]);
    assert.ok(names.includes("generate_workspace")); assert.ok(names.includes("read_workspace_file")); assert.ok(names.includes("write_workspace_file"));
    const searchEvents = await db.researchEvent.findMany({ where: { packageId, type: "evidence_found" } });
    assert.equal(searchEvents.filter((event) => JSON.parse(event.payload)?.kind === "search_results").every((event) => JSON.parse(event.payload).provider === "mock"), true);
    assert.equal((await db.evidence.findMany({ where: { packageId } })).every((card) => card.status === "unconfirmed" && card.confidence === "low"), true);
    if (ragTest) {
      assert.ok(await db.citation.count({ where: { packageId } }));
      assert.ok(await db.retrievalLog.count({ where: { packageId } }) >= planned.length);
      const knowledge = await (await authenticatedFetch(`${base}/api/research/${packageId}/knowledge`)).json();
      assert.equal(knowledge.enabled, true); assert.ok(knowledge.vectorCount > 0);
      if (mode === "chat_completions") {
        const browser = launch(process.execPath, ["node_modules/@playwright/test/cli.js", "test"], { PLAYWRIGHT_CHANNEL: process.env.PLAYWRIGHT_CHANNEL ?? "msedge" });
        assert.equal(await new Promise(done => browser.child.once("exit", done)), 0, browser.output());
        console.log(browser.output());
      }
    }
    console.log(`PASS: ${mode} SDK → indexed research despite rewritten questions → reuse at budget limit → pause/answer/resume → planned files → user edit → re-read, same session`);
    await stop(next.child); next = undefined;
  }
  next = launch(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1"], { OPENAI_API_MODE: "chat_completions", SEARCH_PROVIDER: "searxng", SEARXNG_URL: "http://127.0.0.1:9009" });
  await until(async () => fetch(base, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false), "Next.js did not start for search failure check", 180_000);
  const failedResponse = await authenticatedFetch(`${base}/api/research`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, goal: "验证搜索失败后禁止伪造来源与生成文档", constraints: {}, files: [] }) });
  assert.equal(failedResponse.status, 202);
  const { packageId: failedId } = await failedResponse.json(); ids.push(failedId);
  await until(async () => {
    const pkg = await db.researchPackage.findUniqueOrThrow({ where: { id: failedId } });
    return pkg.status === "failed" && pkg.taskState === "idle";
  }, "Search failure did not block completion");
  const failureEvent = await db.researchEvent.findFirstOrThrow({ where: { packageId: failedId, type: "search_failed" } });
  assert.equal(JSON.parse(failureEvent.payload).provider, "searxng");
  assert.equal(JSON.parse(failureEvent.payload).code, "upstream_error");
  assert.equal(failureEvent.payload.includes("private upstream diagnostic"), false);
  assert.equal(await db.workspaceFile.count({ where: { packageId: failedId } }), 0);
  assert.equal(await db.evidence.count({ where: { packageId: failedId } }), 0);
  const rejectedWrite = await fetch(`${base}/api/internal/research/${failedId}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ operation: "write_file", data: { filename: "README.md", content: "Unverified content", base_version: 0, reason: "verify search guard" } }) });
  assert.equal(rejectedWrite.status, 409);
  console.log("PASS: SearXNG upstream failure → search_failed SSE event → no fabricated evidence or documents, write guard remains active");
} catch (error) {
  if (next) console.error(next.output());
  if (mcp) console.error(`MCP fixture output:\n${mcp.output()}`);
  throw error;
} finally {
  for (const child of processes) await stop(child);
  await new Promise((done) => fixture.close(done));
  try {
    if (ids.length) {
      await db.knowledgeJob.deleteMany({ where: { packageId: { in: ids } } });
      await db.evidence.deleteMany({ where: { packageId: { in: ids } } });
      await db.researchPackage.deleteMany({ where: { id: { in: ids } } });
    }
    if (projectIds.length) await db.project.deleteMany({ where: { id: { in: projectIds } } });
    if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
  } finally { await db.$disconnect(); }
}
