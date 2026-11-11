import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { PrismaClient } from "@prisma/client";
import { chromium, expect, type Browser } from "@playwright/test";
import ts from "typescript";

async function main() {
// Opt-in, isolated database only. No application imports or connections before these checks.
const databaseUrl = process.env.SCENARIOFORGE_TEST_DATABASE_URL;
assert.ok(databaseUrl && process.env.DATABASE_URL === databaseUrl, "Explicit, matching DATABASE_URL and SCENARIOFORGE_TEST_DATABASE_URL required.");
const database = new URL(databaseUrl);
assert.ok(database.protocol === "mysql:" && /^\/scenarioforge_test_[a-z0-9_]{1,45}$/i.test(database.pathname), "Only a dedicated scenarioforge_test_ MySQL database is allowed.");
const real = process.env.SCENARIOFORGE_LOCAL_JOINT_MODE === "real";
// PLAN=1 exercises the public document API and explicit browser handoff with a
// loopback fixture. START=production uses an already-built isolated test dist.
const planWorkflow = process.env.SCENARIOFORGE_LOCAL_JOINT_PLAN === "1";
assert.ok(!planWorkflow || !real, "The explicit document workflow acceptance is fixture-only; it never uses a real provider.");
assert.ok(!real || process.env.SCENARIOFORGE_TEST_MODEL === "1", "A real model run requires SCENARIOFORGE_TEST_MODEL=1 and explicit user authorization.");
const repo = process.cwd(), temporaryParent = path.resolve(repo, ".tmp");
await mkdir(temporaryParent, { recursive: true });
const root = await mkdtemp(path.join(temporaryParent, planWorkflow ? "plan-joint-fixture-" : real ? "local-joint-real-" : "local-joint-fixture-"));
const workspace = path.join(root, "selected-project"), appData = path.join(root, "appdata");
await mkdir(path.join(workspace, "src"), { recursive: true });
await mkdir(path.join(workspace, "tests"), { recursive: true });
const stamp = randomBytes(6).toString("hex"), marker = "LOCAL_JOINT_SKILL_" + randomBytes(12).toString("hex");
const privateMarker = "EXCLUDED_LOCAL_SECRET_" + randomBytes(12).toString("hex");
const password = randomBytes(18).toString("base64url"), username = "joint_" + stamp;
const notes = "# Existing user notes\nPreserve this uncommitted local document.\n";
const broken = "export function add(a, b) { return a - b; }\n";
const trustedTests = [
  'import assert from "node:assert/strict";', 'import { test } from "node:test";', 'import { add } from "../src/calc.mjs";',
  'test("positive numbers", () => assert.equal(add(2, 3), 5));',
  'test("negative numbers", () => assert.equal(add(-7, -2), -9));',
  'test("zero", () => assert.equal(add(0, 0), 0));',
  'test("decimals", () => assert.equal(add(0.5, 0.25), 0.75));',
  'test("mixed signs", () => assert.equal(add(-2, 5), 3));', "",
].join("\n");
await Promise.all([
  writeFile(path.join(workspace, "src/calc.mjs"), broken),
  writeFile(path.join(workspace, "tests/calc.test.mjs"), trustedTests),
  writeFile(path.join(workspace, "notes.md"), notes),
  writeFile(path.join(workspace, ".env"), "PRIVATE=" + privateMarker),
]);
const webPort = process.env.SCENARIOFORGE_LOCAL_JOINT_PORT ?? (planWorkflow ? "3017" : "3000"), base = "http://127.0.0.1:" + webPort;
const secrets = [password, privateMarker];
const redact = (value: string) => secrets.reduce((text, secret) => secret ? text.split(secret).join("[REDACTED]") : text, value)
  .replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [REDACTED]");
const report: Record<string, unknown> = { mode: real ? "real" : "fixture", workflow: planWorkflow ? "explicit-documents" : "preexisting-skill", startedAt: new Date().toISOString(), passed: false, root, limits: { attempts: 1, maxTurns: 24, timeoutMinutes: 10 }, realTaskSubmitted: false };
const db = new PrismaClient({ datasourceUrl: databaseUrl });
const processes: { child: ChildProcess; log: string; exited: Promise<number | null> }[] = [];
let browser: Browser | undefined, projectId: string | undefined, userId: string | undefined;
let stub: Awaited<ReturnType<typeof import("./fixtures/local-workspace-model.mjs").createLocalWorkspaceModelServer>> | undefined;
let runner: typeof processes[number] | undefined;
let budgetGuardInstalled = false;
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
type ChildEnv = Record<string, string | undefined>;
const cleanEnv: ChildEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|OPENAI|SCENARIOFORGE|NODE_OPTIONS/i.test(key)));
function launch(args: string[], env: ChildEnv) {
  const child = spawn(process.execPath, args, { cwd: repo, env: { ...env, NODE_ENV: env.NODE_ENV === "production" ? "production" : "development" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const capture = { child, log: "", exited: Promise.resolve<number | null>(null) };
  child.stdout?.on("data", chunk => { capture.log = (capture.log + redact(String(chunk))).slice(-24000); });
  child.stderr?.on("data", chunk => { capture.log = (capture.log + redact(String(chunk))).slice(-24000); });
  capture.exited = new Promise<number | null>(resolve => {
    child.once("error", error => { capture.log += redact(error.message); resolve(-1); });
    child.once("close", code => resolve(code));
  });
  processes.push(capture); return capture;
}
async function testBudgetSql(sql: string) {
  const client = process.env.SCENARIOFORGE_TEST_MYSQL_CLIENT ?? (process.platform === "win32" ? "mysql.exe" : "mysql");
  const child = spawn(client, ["--no-defaults", "--host=" + database.hostname, "--port=" + (database.port || "3306"),
    "--user=" + decodeURIComponent(database.username), "--database=" + database.pathname.slice(1)], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...cleanEnv, NODE_ENV: "test", MYSQL_PWD: decodeURIComponent(database.password) },
  });
  let diagnostic = "";
  child.stderr.on("data", chunk => { diagnostic += redact(String(chunk)); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  child.stdin.end(sql + "\n");
  assert.equal(await exited, 0, "Temporary database budget guard failed: " + diagnostic);
}
async function stop(capture: typeof processes[number]) {
  if (capture.child.exitCode !== null || capture.child.signalCode !== null) return;
  if (process.platform === "win32" && capture.child.pid) {
    await new Promise<void>(resolve => {
      const killer = spawn("taskkill.exe", ["/PID", String(capture.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => resolve()); killer.once("exit", () => resolve());
    });
  } else capture.child.kill("SIGTERM");
  await Promise.race([capture.exited, pause(4000)]);
  if (capture.child.exitCode === null && capture.child.signalCode === null) { capture.child.kill("SIGKILL"); await capture.exited; }
}
async function until<T>(check: () => Promise<T | null | false | undefined>, message: string, timeout = 120000): Promise<T> {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await check(); if (result) return result as T; await pause(300); }
  throw new Error(message);
}
function reviewSafeArithmetic(sourceText: string) {
  // The harness alone executes generated arithmetic. Product Runner still exposes no shell.
  const source = ts.createSourceFile("calc.mjs", sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  assert.equal(source.statements.length, 1, "Trusted tests accept one exported arithmetic function only.");
  const declaration = source.statements[0];
  assert.ok(ts.isFunctionDeclaration(declaration) && declaration.name?.text === "add", "Expected exported add function.");
  assert.ok(declaration.modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword), "add must be exported.");
  const allowed = new Set([ts.SyntaxKind.SourceFile, ts.SyntaxKind.EndOfFileToken, ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.ExportKeyword,
    ts.SyntaxKind.Identifier, ts.SyntaxKind.Parameter, ts.SyntaxKind.Block, ts.SyntaxKind.ReturnStatement, ts.SyntaxKind.BinaryExpression,
    ts.SyntaxKind.ParenthesizedExpression, ts.SyntaxKind.NumericLiteral, ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken,
    ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.PrefixUnaryExpression]);
  const inspect = (node: ts.Node) => { assert.ok(allowed.has(node.kind), "Generated arithmetic contains an executable construct outside the acceptance subset: " + ts.SyntaxKind[node.kind]); ts.forEachChild(node, inspect); };
  inspect(source);
}
let next: typeof processes[number] | undefined;
try {
  const occupied = await fetch(base + "/api/auth/me", { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
  assert.equal(occupied, false, "Joint acceptance port is already in use; existing process was not stopped.");
  assert.equal(await db.workspaceExecution.count(), 0, "Dedicated acceptance database must not contain another execution.");
  assert.equal(await db.researchPackage.count({ where: { taskState: { in: ["queued", "running"] } } }), 0, "Dedicated database must not contain queued research.");
  if (real) {
    // Database guard applies only to this throwaway test schema. No product test backdoor.
    await testBudgetSql("DELIMITER $$\nCREATE TRIGGER sf_local_joint_single_attempt BEFORE UPDATE ON WorkspaceExecution FOR EACH ROW BEGIN IF NEW.attempts > 1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Joint acceptance permits only one model attempt'; END IF; END$$\nDELIMITER ;");
    budgetGuardInstalled = true;
    const guardPackage = await db.researchPackage.create({ data: { title: "Budget guard fixture", goal: "Never scheduled", status: "replied" } });
    try {
      const guardRun = await db.workspaceExecution.create({ data: { packageId: guardPackage.id, createdBy: "never-scheduled-fixture", request: "Budget check only", skills: "[]", status: "stopped", attempts: 1 } });
      await assert.rejects(db.workspaceExecution.update({ where: { id: guardRun.id }, data: { attempts: 2 } }), /Joint acceptance permits only one model attempt/);
      report.singleAttemptGuardVerified = true;
    } finally { await db.researchPackage.delete({ where: { id: guardPackage.id } }); }
  }
  const initialTests = launch(["--test", path.join(workspace, "tests/calc.test.mjs")], cleanEnv);
  assert.equal(await initialTests.exited, 1, "The deliberately broken fixture must fail the trusted tests before the task.");
  report.initialIndependentTests = initialTests.log;
  let modelEnv: ChildEnv;
  if (real) {
    const source = parseEnv(await readFile(path.join(repo, ".env.local"), "utf8"));
    assert.ok(source.OPENAI_API_KEY && source.OPENAI_BASE_URL && source.SCENARIOFORGE_MODEL, "Authorized local model configuration is incomplete.");
    assert.equal(new URL(source.OPENAI_BASE_URL).protocol, "https:", "Real model service must use HTTPS.");
    secrets.push(source.OPENAI_API_KEY);
    modelEnv = Object.fromEntries(["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_MODE", "SCENARIOFORGE_MODEL", "MODEL_TIMEOUT_SECONDS"].filter(key => source[key]).map(key => [key, source[key]]));
    report.model = { origin: new URL(source.OPENAI_BASE_URL).origin, name: source.SCENARIOFORGE_MODEL, apiMode: source.OPENAI_API_MODE ?? "responses" };
  } else {
    stub = await (await import("./fixtures/local-workspace-model.mjs")).createLocalWorkspaceModelServer({ planWorkflow, marker });
    modelEnv = { OPENAI_API_KEY: "fixture-local-key", OPENAI_BASE_URL: stub.baseUrl, OPENAI_API_MODE: "responses", SCENARIOFORGE_MODEL: "fixture-local-workspace" };
  }
  const serverEnv = { ...cleanEnv, ...modelEnv, DATABASE_URL: databaseUrl, NODE_ENV: "development", SCENARIOFORGE_ENV_FILE: "",
    SCENARIOFORGE_TASK_SCHEDULER: "on", SCENARIOFORGE_TEST_DIST: "true", SCENARIOFORGE_SETTINGS_KEY: randomBytes(32).toString("base64"),
    SCENARIOFORGE_INTERNAL_TOKEN: randomBytes(32).toString("hex"), SCENARIOFORGE_PUBLIC_ORIGIN: base, SCENARIOFORGE_BACKEND_URL: base,
    RAG_ENABLED: "false", SEARCH_PROVIDER: "mock", NEXT_TELEMETRY_DISABLED: "1", MODEL_TIMEOUT_SECONDS: modelEnv.MODEL_TIMEOUT_SECONDS ?? "120" };
  const production = process.env.SCENARIOFORGE_LOCAL_JOINT_START === "production";
  next = launch(["node_modules/next/dist/bin/next", production ? "start" : "dev", ...(production ? [] : ["--webpack"]), "--hostname", "127.0.0.1", "--port", webPort], { ...serverEnv, NODE_ENV: production ? "production" : "development" });
  await until(async () => fetch(base + "/api/auth/me", { signal: AbortSignal.timeout(2000) }).then(response => response.status === 401 || response.ok, () => false), "Next.js test service did not start: " + next.log, 180000);
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? "msedge", headless: true });
  process.stdout.write("Isolated web service ready; exercising real browser login and project creation.\n");
  const context = await browser.newContext(), page = await context.newPage();
  page.setDefaultTimeout(60000);
  const registered = await context.request.post(base + "/api/auth/register", { data: { username, password }, headers: { Origin: base } });
  assert.equal(registered.status(), 200, await registered.text());
  userId = (await registered.json()).user.id;
  await context.request.post(base + "/api/auth/logout", { headers: { Origin: base } });
  await page.goto(base);
  await page.locator("#account-username").fill(username);
  await page.locator("#account-password").fill(password);
  const signedIn = page.waitForResponse(response => response.url().endsWith("/api/auth/login") && response.request().method() === "POST");
  await page.getByRole("button", { name: "登录工作空间" }).click();
  assert.equal((await signedIn).status(), 200);
  await page.getByLabel("项目名称", { exact: true }).fill("本地联合验收 " + stamp);
  const created = page.waitForResponse(response => response.url().endsWith("/api/projects") && response.request().method() === "POST");
  await page.getByRole("button", { name: /^创建项目/ }).click();
  const projectResponse = await created; assert.equal(projectResponse.status(), 201);
  projectId = (await projectResponse.json()).project.id;
  let pkg: { id: string }, skill: { id: string; version: number; content: string };
  const goal = "Repair addition in src/calc.mjs and write docs/REPORT.md using the generated skills. Preserve tests and existing notes. Static syntax checks only. " + marker;
  if (planWorkflow) {
    const researchResponse = await context.request.post(base + "/api/research", { headers: { Origin: base }, data: { projectId, goal, mode: "documents" } });
    assert.equal(researchResponse.status(), 202, await researchResponse.text());
    pkg = { id: (await researchResponse.json()).packageId };
    const proposedResponse = await context.request.get(base + "/api/research/" + pkg.id);
    assert.equal(proposedResponse.status(), 200);
    const proposed = await proposedResponse.json();
    assert.equal(proposed.status, "documents_plan_ready");
    assert.equal(proposed.taskState, "idle");
    assert.equal(proposed.files.length, 0, "A proposed filename is not a saved document.");
    assert.equal(stub?.requests.length, 0, "Preview must not call a model.");
    const previewResponse = await context.request.post(base + "/api/research/" + pkg.id + "/documents", { headers: { Origin: base }, data: { action: "preview", request: goal } });
    assert.equal(previewResponse.status(), 200, await previewResponse.text());
    let latest = (await previewResponse.json()).proposal;
    const stale = await context.request.post(base + "/api/research/" + pkg.id + "/documents", { headers: { Origin: base },
      data: { action: "generate", proposalId: proposed.documentProposal.id, documents: latest.documents } });
    assert.equal(stale.status(), 409, "A replaced proposal must not queue work.");
    const invalidSelection = await context.request.post(base + "/api/research/" + pkg.id + "/documents", { headers: { Origin: base },
      data: { action: "generate", proposalId: latest.id, documents: [latest.documents[0], latest.documents[0]] } });
    assert.equal(invalidSelection.status(), 400);
    // Simulate a separate context update while the proposal editor is open.
    await db.researchPackage.update({ where: { id: pkg.id }, data: { contextVersion: { increment: 1 } } });
    const outdated = await (await context.request.get(base + "/api/research/" + pkg.id)).json();
    assert.equal(outdated.documentProposal.id, latest.id, "An outdated proposal stays visible so edits are not lost.");
    assert.equal(outdated.documentProposalStale, true);
    const contextStale = await context.request.post(base + "/api/research/" + pkg.id + "/documents", { headers: { Origin: base },
      data: { action: "generate", proposalId: latest.id, documents: latest.documents } });
    assert.equal(contextStale.status(), 409, "A context change requires explicit proposal refresh.");
    const refreshed = await context.request.post(base + "/api/research/" + pkg.id + "/documents", { headers: { Origin: base }, data: { action: "preview", request: goal } });
    assert.equal(refreshed.status(), 200);
    latest = (await refreshed.json()).proposal;
    assert.equal(stub?.requests.length, 0, "Rejected confirmation must not call a model.");
    const selectedDocuments = [...latest.documents, { filename: "VERIFICATION.md", purpose: "独立验证边界与人工审查", contentOutline: ["静态检查与测试的区别", "保留原始测试", "人工复核实际差异"] }];
    const confirmations = await Promise.all([1, 2].map(() => context.request.post(base + "/api/research/" + pkg.id + "/documents", { headers: { Origin: base },
      data: { action: "generate", proposalId: latest.id, documents: selectedDocuments } })));
    assert.deepEqual(confirmations.map(response => response.status()).sort(), [202, 409], "Repeated confirmation must queue only one job.");
    const documentPackage = await until(async () => {
      const current = await db.researchPackage.findUniqueOrThrow({ where: { id: pkg.id }, include: { files: true } });
      if (["failed", "blocked", "documents_failed"].includes(current.status)) {
        const failure = await db.researchEvent.findFirst({ where: { packageId: pkg.id, type: "documents_failed" }, orderBy: { sequence: "desc" } });
        assert.fail("Document worker failed: " + (failure?.message ?? current.summary));
      }
      return current.status === "documents_ready" && current.taskState === "idle" ? current : null;
    }, "Explicit document worker did not save the three confirmed documents.");
    assert.deepEqual(documentPackage.files.map(file => file.filename).sort(), ["PLAN.md", "TASKS.md", "VERIFICATION.md"]);
    assert.ok(documentPackage.files.every(file => file.version === 1 && file.updatedBy === "agent" && file.content.includes(marker)));
    assert.ok(documentPackage.files.every(file => file.content.includes("不代表已联网核实、已修改项目或已通过测试")));
    assert.equal(documentPackage.pendingMessage, null);
    assert.equal(documentPackage.researchPlan, null, "Document generation must not create a research execution plan.");
    assert.equal(await db.workspaceExecution.count({ where: { packageId: pkg.id } }), 0, "Saving documents must not start a workspace Agent.");
    const documentEvents = await db.researchEvent.findMany({ where: { packageId: pkg.id }, orderBy: { sequence: "asc" }, select: { type: true, payload: true } });
    assert.equal(documentEvents.filter(event => event.type === "documents_requested").length, 1);
    assert.equal(documentEvents.filter(event => event.type === "documents_completed").length, 1);
    assert.equal(documentEvents.filter(event => event.type === "file_created").length, 3);
    assert.ok(!documentEvents.some(event => event.type.startsWith("execution_")));
    assert.equal(stub?.requests.length, 1, "No research or execution model may run after saving documents.");
    const optionalQuestion = await db.clarification.create({ data: { packageId: pkg.id, groupId: "legacy-optional-" + stamp,
      questionId: "legacy-optional-question-" + stamp, question: "Which test framework should the future execution preserve?",
      type: "text", priority: "optional", whyNeeded: "A previous optional question can be answered after documents are saved.",
      expiresAt: new Date(Date.now() + 600_000) } });
    const optionalAnswer = "Preserve the existing Node built-in tests.";
    const answered = await context.request.post(base + "/api/research/" + pkg.id + "/answer", { headers: { Origin: base },
      data: { clarificationId: optionalQuestion.id, answer: optionalAnswer } });
    assert.equal(answered.status(), 200, await answered.text()); assert.equal((await answered.json()).status, "answered");
    await pause(3200); // Observe a scheduler tick, so an unintended queued research turn is detectable.
    const storedAnswer = await db.clarification.findUniqueOrThrow({ where: { id: optionalQuestion.id } });
    assert.equal(storedAnswer.status, "answered"); assert.equal(storedAnswer.answer, optionalAnswer); assert.equal(storedAnswer.answeredBy, "user");
    const afterAnswer = await db.researchPackage.findUniqueOrThrow({ where: { id: pkg.id } });
    assert.equal(afterAnswer.contextVersion, documentPackage.contextVersion + 1);
    assert.equal(afterAnswer.status, "documents_ready"); assert.equal(afterAnswer.taskState, "idle"); assert.equal(afterAnswer.pendingMessage, null);
    assert.equal(stub?.requests.length, 1, "Answering an older optional question must not silently invoke a model in document mode.");
    assert.equal(await db.workspaceExecution.count({ where: { packageId: pkg.id } }), 0);
    assert.equal(await db.researchEvent.count({ where: { packageId: pkg.id, type: "clarification_answered" } }), 1);
    const generatedPlan = documentPackage.files.find(file => file.filename === "PLAN.md")!;
    const editedContent = generatedPlan.content + "\n\n## User-confirmed revision\nPreserve all unrelated user files.\n";
    const edited = await context.request.put(base + "/api/research/" + pkg.id + "/files/PLAN.md", { headers: { Origin: base }, data: { baseVersion: 1, content: editedContent, changeNote: "Confirm generated draft before execution" } });
    assert.equal(edited.status(), 200, await edited.text());
    assert.equal((await edited.json()).version, 2);
    await pause(1500);
    const afterEdit = await db.researchPackage.findUniqueOrThrow({ where: { id: pkg.id } });
    assert.equal(afterEdit.status, "documents_ready"); assert.equal(afterEdit.taskState, "idle"); assert.equal(afterEdit.pendingMessage, null);
    assert.equal(stub?.requests.length, 1, "Editing a draft skill must not automatically invoke a model.");
    assert.equal(await db.workspaceExecution.count({ where: { packageId: pkg.id } }), 0);
    const previewAgain = await context.request.post(base + "/api/research/" + pkg.id + "/documents", { headers: { Origin: base }, data: { action: "preview" } });
    assert.equal(previewAgain.status(), 200, await previewAgain.text());
    const latestProposal = (await previewAgain.json()).proposal;
    const regenerate = await context.request.post(base + "/api/research/" + pkg.id + "/documents", { headers: { Origin: base }, data: { action: "generate", proposalId: latestProposal.id, documents: latestProposal.documents } });
    assert.equal(regenerate.status(), 409, "Regeneration must refuse to overwrite the human-edited PLAN.md.");
    assert.equal(stub?.requests.length, 1, "A refused regeneration must not invoke the model.");
    assert.equal((await db.workspaceFile.findUniqueOrThrow({ where: { id: generatedPlan.id } })).content, editedContent);
    skill = { id: generatedPlan.id, version: 2, content: editedContent };
    report.documents = { filenames: documentPackage.files.map(file => file.filename), initialVersions: documentPackage.files.map(file => file.version), previewCalls: 0, confirmedDocuments: selectedDocuments, editedPlanVersion: 2, events: documentEvents, modelCallsBeforeExecution: stub?.requests.length, editingRemainsIdle: true, humanEditRegenerationRefused: true,
      optionalAnswerRemainsIdle: true, optionalAnswerContextVersionIncremented: true, replacedProposalRefused: true, staleContextRefused: true, concurrentConfirmQueuesOnce: true };
  } else {
  pkg = await db.researchPackage.create({ data: { projectId, title: "联合验收技能", goal: "仅供本轮独立验收", status: "replied" } });
  skill = await db.workspaceFile.create({ data: { packageId: pkg.id, filename: "PLAN.md", version: 2, content: [
    "# 本地加法修复技能", "专属标记：" + marker,
    "仅修改 src/calc.mjs、新建 docs/REPORT.md；不得改 tests/calc.test.mjs、notes.md 或其他用户文件。",
    "src/calc.mjs 应只包含导出的 add(a,b) 普通函数，以基本算术求和，支持正数、负数、零、小数；不要导入依赖或执行其他代码。",
    "先读取现有源码，保留用户无关内容。报告逐字包含上述专属标记；区分已知事实、建议、待确认事项。",
    "本地 Runner 不提供命令执行；只做静态检查，不得声称 Agent 已运行测试。任务后由验收脚本独立运行可信测试。",
    "保存文件后调用 verify_workspace 和 review_changes，不提交、不推送。", "",
  ].join("\n") } });
  }
  await page.goto(base + "/?project=" + projectId + "&package=" + pkg.id);
  const panel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  if (planWorkflow) {
    await page.getByRole("button", { name: "使用这些文档继续执行", exact: true }).click();
    await expect(panel.getByRole("textbox", { name: "工作区执行要求", exact: true })).toHaveValue(goal);
    await expect(panel.getByRole("checkbox", { name: /TASKS.md/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /VERIFICATION.md/ })).toBeChecked();
    await expect(panel.getByRole("status").filter({ hasText: "已带入当前方案的 3 份" })).toBeVisible();
    assert.equal(await db.workspaceExecution.count({ where: { packageId: pkg.id } }), 0, "The document handoff must not automatically submit execution.");
    await page.screenshot({ path: path.join(root, "documents-handoff.png"), fullPage: true });
  } else await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  await panel.getByRole("radio", { name: "本地工作区", exact: true }).check();
  await panel.locator("summary").filter({ hasText: "连接与运行设置" }).click();
  await panel.locator("summary").filter({ hasText: "连接新的本地目录" }).click();
  await panel.getByRole("textbox", { name: "本地连接名称", exact: true }).fill("联合验收电脑目录");
  const pairedResponse = page.waitForResponse(response => response.url().endsWith("/local-runners") && response.request().method() === "POST");
  await panel.getByRole("button", { name: "生成配对码", exact: true }).click();
  const pairingResponse = await pairedResponse; assert.equal(pairingResponse.status(), 201);
  const pairing = await pairingResponse.json(); secrets.push(pairing.code);
  const pair = launch(["--import", "tsx", "scripts/scenarioforge-local-runner.mjs", "pair", "--url", base, "--code", pairing.code, "--directory", workspace], { ...cleanEnv, APPDATA: appData });
  assert.equal(await pair.exited, 0, pair.log);
  const credentialFile = path.join(appData, "ScenarioForge", "runner.json");
  const credentials = JSON.parse(await readFile(credentialFile, "utf8")); secrets.push(credentials.token);
  runner = launch(["--import", "tsx", "scripts/scenarioforge-local-runner.mjs", "run"], { ...cleanEnv, APPDATA: appData });
  await panel.getByRole("button", { name: "隐藏配对信息", exact: true }).click();
  await expect(panel.getByRole("combobox", { name: "本地工作区连接" })).toContainText("在线", { timeout: 30000 });
  await panel.getByRole("combobox", { name: "本地工作区连接" }).selectOption(pairing.id);
  const skillDetails = panel.locator("details").filter({ hasText: "项目技能文件" });
  if (!await skillDetails.getAttribute("open").then(value => value !== null)) await skillDetails.locator("summary").click();
  await expect(panel.getByRole("checkbox", { name: /PLAN.md/ })).toBeChecked();
  await panel.getByRole("textbox", { name: "工作区执行要求", exact: true }).fill(planWorkflow ? "严格按选中的 PLAN.md、TASKS.md 和 VERIFICATION.md 技能修复加法函数并生成报告，实际保存文件、做静态语法检查并审查差异。" : "严格按唯一选中的 PLAN.md 技能修复加法函数并生成报告，实际保存文件、做静态语法检查并审查差异。");
  const startResponse = page.waitForResponse(response => response.url().endsWith("/executions") && response.request().method() === "POST");
  report.realSubmissionInitiated = real;
  await panel.getByRole("button", { name: "开始执行", exact: true }).click();
  const started = await startResponse; assert.equal(started.status(), 202, await started.text());
  const startedBody = await started.json(), runId = startedBody.execution.id;
  report.executionId = runId; report.realTaskSubmitted = real;
  // Change the source after submission to ensure the worker uses the frozen version.
  await db.workspaceFile.update({ where: { id: skill.id }, data: { version: 3, content: "# New source version must not replace the task skill." } });
  process.stdout.write("Task submitted through the real browser; waiting for one worker attempt.\n");
  const saved = await until(async () => {
    const run = await db.workspaceExecution.findUniqueOrThrow({ where: { id: runId } });
    assert.ok(run.attempts <= 1, "Refusing a second worker attempt.");
    return ["completed", "review", "failed", "stopped"].includes(run.status) ? run : null;
  }, "Joint workspace task timed out.", 625000);
  report.status = saved.status; report.attempts = saved.attempts; report.error = saved.error;
  report.checks = JSON.parse(saved.verification ?? "[]");
  const events = await db.researchEvent.findMany({ where: { packageId: pkg.id, type: { startsWith: "execution_" } }, orderBy: { sequence: "asc" }, select: { type: true, message: true } });
  report.events = events;
  assert.ok(["completed", "review"].includes(saved.status), saved.error ?? "Workspace task failed.");
  assert.equal(saved.attempts, 1, "No automatic second attempt or resume is permitted.");
  const frozen = JSON.parse(saved.skills) as { filename: string; version: number; content: string }[];
  const frozenPlan = frozen.find(file => file.filename === "PLAN.md")!;
  assert.equal(frozenPlan.version, 2); assert.equal(frozenPlan.content, skill.content); assert.ok(frozenPlan.content.includes(marker));
  if (planWorkflow) {
    assert.equal(frozen.length, 3); assert.equal(frozen.find(file => file.filename === "TASKS.md")?.version, 1);
    assert.equal(frozen.find(file => file.filename === "VERIFICATION.md")?.version, 1);
    assert.equal(stub?.requests.filter(item => item.kind === "documents").length, 1);
    assert.equal(stub?.requests.filter(item => item.requestedTool === "read_skill").length, 3);
    const afterExecution = await db.researchPackage.findUniqueOrThrow({ where: { id: pkg.id } });
    assert.equal(afterExecution.taskState, "idle"); assert.equal(afterExecution.pendingMessage, null);
    report.frozenSkills = frozen.map(file => ({ filename: file.filename, version: file.version }));
  }
  const actualSource = await readFile(path.join(workspace, "src/calc.mjs"), "utf8"), actualReport = await readFile(path.join(workspace, "docs/REPORT.md"), "utf8");
  assert.ok(actualReport.includes(marker), "Generated report did not include the frozen skill marker.");
  assert.equal(await readFile(path.join(workspace, "notes.md"), "utf8"), notes);
  assert.equal(await readFile(path.join(workspace, "tests/calc.test.mjs"), "utf8"), trustedTests);
  assert.equal(await readFile(path.join(workspace, ".env"), "utf8"), "PRIVATE=" + privateMarker);
  reviewSafeArithmetic(actualSource);
  const tests = launch(["--test", path.join(workspace, "tests/calc.test.mjs")], cleanEnv);
  assert.equal(await tests.exited, 0, tests.log);
  report.independentTests = tests.log; report.sourceHash = createHash("sha256").update(actualSource).digest("hex");
  const detailResponse = await context.request.get(base + "/api/projects/" + projectId + "/executions?run=" + runId);
  assert.equal(detailResponse.status(), 200); const detail = await detailResponse.json();
  assert.ok(detail.diff.includes(marker)); assert.ok(!JSON.stringify(detail).includes(privateMarker)); assert.equal(detail.head, saved.head);
  await expect(panel.getByText(/本轮完成，待审查|待人工验证/, { exact: true })).toBeVisible({ timeout: 30000 });
  if (planWorkflow) {
    await panel.locator("summary").filter({ hasText: /^执行进度(?:\s*·|$)/ }).click();
    await expect(panel.getByRole("list", { name: "执行任务进度" })).toContainText("工作区任务已排队");
    await expect(panel.getByRole("list", { name: "执行任务进度" })).not.toContainText("方案文档已排队");
  }
  await panel.getByRole("button", { name: "查看文件与差异", exact: true }).click();
  await panel.getByRole("combobox", { name: "任务变更文件", exact: true }).selectOption("docs/REPORT.md");
  await expect(panel.locator("pre").filter({ hasText: marker }).first()).toBeVisible();
  await page.screenshot({ path: path.join(root, "completed.png"), fullPage: true });
  await stop(runner);
  await page.reload();
  const offlinePanel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  await offlinePanel.getByRole("radio", { name: "本地工作区", exact: true }).check();
  await offlinePanel.getByRole("button", { name: "查看文件与差异", exact: true }).click();
  await offlinePanel.getByRole("combobox", { name: "任务变更文件", exact: true }).selectOption("docs/REPORT.md");
  await expect(offlinePanel.locator("pre").filter({ hasText: marker }).first()).toBeVisible();
  report.disconnectedPreviewPassed = true; report.scriptedRequests = stub?.requests;
  report.passed = true;
} catch (error) {
  report.error = redact(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  const cleanupErrors: string[] = [];
  const cleanup = async (label: string, action: () => Promise<unknown>) => {
    try { await action(); } catch (error) { cleanupErrors.push(redact(label + ": " + (error instanceof Error ? error.message : "cleanup failed"))); }
  };
  await cleanup("browser", async () => browser?.close());
  for (const capture of [...processes].reverse()) await cleanup("child process", () => stop(capture));
  if (projectId) {
    await cleanup("test research packages", () => db.researchPackage.deleteMany({ where: { projectId } }));
    await cleanup("test project", () => db.project.deleteMany({ where: { id: projectId } }));
  }
  if (userId) await cleanup("test user", () => db.user.deleteMany({ where: { id: userId } }));
  if (budgetGuardInstalled) await cleanup("test budget guard", () => testBudgetSql("DROP TRIGGER IF EXISTS sf_local_joint_single_attempt;"));
  await cleanup("database client", () => db.$disconnect());
  await cleanup("local scripted model", async () => stub?.close());
  const resolvedAppData = path.resolve(appData);
  assert.equal(path.dirname(resolvedAppData), path.resolve(root), "Refusing cleanup outside this acceptance directory.");
  await cleanup("Runner credentials", () => rm(resolvedAppData, { recursive: true, force: true }));
  if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; report.passed = false; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  report.apiUsage = real ? report.realTaskSubmitted ? "One authorized task submitted; provider billing/token totals are unavailable."
    : report.realSubmissionInitiated ? "Task submission was attempted; model requests may have occurred. Do not retry without approval."
    : "No real task was submitted." : "No real model requests.";
  await writeFile(path.join(root, "report.json"), redact(JSON.stringify(report, null, 2)) + "\n");
  if (next) await writeFile(path.join(root, "web.log"), redact(next.log));
  if (runner) await writeFile(path.join(root, "runner.log"), redact(runner.log));
  process.stdout.write("Joint acceptance " + (report.passed ? "passed" : "failed") + ". Report: " + path.join(root, "report.json") + "\n");
  if (report.error) process.stderr.write(String(report.error) + "\n");
}
}

void main().catch(error => { process.stderr.write((error instanceof Error ? error.message : "Joint acceptance setup failed.") + "\n"); process.exitCode = 1; });
