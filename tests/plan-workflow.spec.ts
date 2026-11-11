import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ResearchEvent, ResearchSnapshot, WorkspaceFile } from "../lib/types";
import type { ExecutionView, SkillDescription } from "../lib/workspace-agent/types";

// Every API request is intercepted: these tests use no real accounts, database,
// Runner, model calls, downloads, or repository writes.
const projectId = "plan-project-fixture";
const packageId = "plan-package-fixture";
const goal = "创建 Node.js 加法模块和内置测试，运行测试并生成报告。";
const now = "2026-11-11T00:00:00.000Z";
const runner = { id: "plan-runner-fixture", label: "演示工作区", online: true, lastSeenAt: now, workspaceDirectory: "D:\\演示项目\\加法模块" };
type DocumentSpec = { filename: string; purpose: string; contentOutline: string[] };
type Proposal = { id: string; request: string; contextVersion: number; documents: DocumentSpec[] };
const defaults: DocumentSpec[] = [
  { filename: "PLAN.md", purpose: "目标、范围与实施步骤", contentOutline: ["目标与约束", "实现步骤", "待确认事项"] },
  { filename: "TASKS.md", purpose: "任务清单与验收标准", contentOutline: ["可执行任务", "验收标准", "验证与审查"] },
];
const apiSpec: DocumentSpec = { filename: "API_DESIGN.md", purpose: "接口契约与错误处理", contentOutline: ["请求与响应", "认证与错误处理"] };

function researchEvent(sequence: number, type: string, message: string, payload: unknown = null): ResearchEvent {
  return { id: `plan-event-${sequence}`, sequence, type, message, payload, createdAt: now };
}
function planDocument(filename: string, version: number): WorkspaceFile {
  return { filename, version, content: filename === "PLAN.md" ? `# 加法模块实施方案\n\n实现模块、测试和报告。当前方案版本 ${version}。` : filename === "TASKS.md" ? "# 验收清单\n\n- 使用 Node 内置测试器。\n- 报告实际验证结果。" : `# ${filename.replace(/\.md$/i, "")} 设计说明\n\n独立说明本文件的职责与验收要求。当前版本 ${version}。`,
    updatedBy: "agent", changeNote: null, lockedBy: null, updatedAt: now };
}
function skill(file: WorkspaceFile): SkillDescription {
  return { id: `skill-${file.filename}`, packageId, packageTitle: "加法模块方案", filename: file.filename, version: file.version,
    purpose: file.filename === "PLAN.md" ? "实现步骤" : "验收要求", kind: "workflow", hash: String(file.version).repeat(64), path: `.scenarioforge/skills/${file.filename}` };
}
function execution(id: string, request: string, skills: SkillDescription[], status = "completed"): ExecutionView {
  return { id, request, createdBy: "plan-user-fixture", status, target: "local", runnerId: runner.id, branch: `local/${runner.id}/${id}`,
    head: "b".repeat(40), attempts: 1, skills: structuredClone(skills), summary: null, error: null, verification: [], createdAt: now };
}

async function planPage(page: Page, options: { savedVersion?: number; executions?: ExecutionView[]; extraEvents?: ResearchEvent[]; generateError?: string; queuedGeneration?: boolean; refreshableStream?: boolean } = {}) {
  const snapshot: ResearchSnapshot = { id: packageId, title: "加法模块方案", goal, status: "replied", taskState: "idle", currentStage: 0,
    summary: "已讨论目标，可以整理为执行方案。", filePlan: [], files: [], evidence: [], clarifications: [],
    events: [researchEvent(1, "user_message", goal), researchEvent(2, "assistant_message", "已讨论目标，可以整理为执行方案。"), researchEvent(3, "turn_completed", "普通对话已完成")] };
  const requests: Record<string, unknown>[] = [];
  const documentRequests: Record<string, unknown>[] = [];
  const fileActions: Record<string, unknown>[] = [];
  const creations: string[] = [];
  const unexpected: string[] = [];
  let proposalNumber = 0;
  let proposal: Proposal | null = null;
  let snapshotUpdatePending: string | null = null;
  let downloads = 0;
  let runs = options.executions ?? [];
  const prepareDocuments = (request: string) => {
    proposal = { id: `document-proposal-${++proposalNumber}`, request, contextVersion: 0,
      documents: structuredClone(/接口|API/i.test(request) ? [...defaults, apiSpec] : defaults) };
    snapshot.documentProposal = proposal;
    snapshot.documentProposalStale = false;
    snapshot.status = "documents_plan_ready";
    snapshot.summary = "文档清单已准备，请确认后生成。";
    snapshot.events.push(researchEvent(snapshot.events.length + 1, "documents_plan_proposed", snapshot.summary));
    return proposal;
  };
  const saveDocuments = (version = 1, documents = defaults) => {
    const names = new Set(documents.map(document => document.filename));
    snapshot.files = [...snapshot.files.filter(document => !names.has(document.filename)), ...documents.map(document => planDocument(document.filename, version))];
    snapshot.documentProposal = null;
    proposal = null;
    snapshot.status = "documents_ready";
    snapshot.summary = "方案文档已保存，可以选择技能继续执行。";
    const sequence = snapshot.events.length;
    snapshot.events.push(researchEvent(sequence + 1, "documents_started", "方案文档正在整理"), researchEvent(sequence + 2, "documents_completed", "方案文档已保存"));
  };
  const failDocuments = (message: string) => {
    snapshot.status = "documents_failed";
    snapshot.taskState = "idle";
    snapshot.documentProposal = null;
    proposal = null;
    snapshot.events.push(researchEvent(snapshot.events.length + 1, "documents_failed", message));
    snapshotUpdatePending = "documents_failed";
  };
  if (options.savedVersion) saveDocuments(options.savedVersion);
  snapshot.events.push(...(options.extraEvents ?? []));
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "plan-user-fixture", username: "plan_fixture" } } });
    if (path === "/api/me/favorites") return route.fulfill({ json: { favorite: null } });
    if (path === "/api/me/next-steps") return route.fulfill({ json: { actions: [], warnings: [], generatedAt: now } });
    if (path === "/api/projects") return route.fulfill({ json: { projects: [{ id: projectId, name: "方案交接测试项目", inviteCode: "PLAN01", role: "owner", memberCount: 1,
      researchPackages: [{ id: packageId, title: snapshot.title, status: snapshot.status, updatedAt: now }] }] } });
    if (path === `/api/research/${packageId}/knowledge`) return route.fulfill({ json: { enabled: false, status: "disabled", message: "Fixture knowledge index", sourceCount: 0, chunkCount: 0, vectorCount: 0, model: null, dimensions: null, generation: null, lastIndexedAt: null } });
    if (path === `/api/research/${packageId}/evidence`) return route.fulfill({ json: { total: 0, pageSize: 20, results: [] } });
    if (path.endsWith("/knowledge")) return route.fulfill({ json: { total: 0, results: [] } });
    if (path.endsWith("/model")) return route.fulfill({ json: { settings: null, canEdit: true } });
    if (path.endsWith("/personal-agent")) return route.fulfill({ json: { settings: null, acceptsAgentTasks: false, tasks: [] } });
    if (path.endsWith("/repository")) return route.fulfill({ json: { enabled: false } });
    if (path === "/api/research" && route.request().method() === "POST") {
      const body = route.request().postData() ?? "";
      creations.push(body);
      if (body.includes("documents")) prepareDocuments(goal);
      return route.fulfill({ status: 202, json: { packageId, status: "created" } });
    }
    if (path === `/api/research/${packageId}`) return route.fulfill({ json: snapshot });
    if (path === `/api/research/${packageId}/documents`) {
      const body = route.request().postDataJSON();
      documentRequests.push(body);
      if (body.action === "preview") return route.fulfill({ json: { proposal: prepareDocuments(body.request || goal) } });
      if (body.action !== "generate" || body.proposalId !== proposal?.id) return route.fulfill({ status: 409, json: { error: "文档清单已变化，请重新预览。" } });
      if (options.generateError) return route.fulfill({ status: 409, json: { error: options.generateError } });
      if (options.queuedGeneration) {
        snapshot.status = "drafting_documents";
        snapshot.taskState = "running";
        snapshot.documentProposal = null;
        proposal = null;
        snapshot.events.push(researchEvent(snapshot.events.length + 1, "documents_started", "方案文档正在整理"));
        return route.fulfill({ status: 202, json: { status: "queued" } });
      }
      saveDocuments((options.savedVersion ?? 0) + 1, body.documents);
      return route.fulfill({ status: 202, json: { status: "queued" } });
    }
    if (path.endsWith("/stream")) {
      const body = options.refreshableStream ? `retry: 100\n\n${snapshotUpdatePending ? `event: ${snapshotUpdatePending}\ndata: {}\n\n` : ": fixture\n\n"}` : ": fixture\n\n";
      snapshotUpdatePending = null;
      return route.fulfill({ contentType: "text/event-stream", body });
    }
    if (path.includes("/files/") && route.request().method() === "PATCH") {
      const body = route.request().postDataJSON(); fileActions.push(body);
      const document = snapshot.files.find(file => file.filename === decodeURIComponent(path.split("/").at(-1)!));
      if (!document) return route.fulfill({ status: 404, json: { error: "Fixture document missing" } });
      document.lockedBy = body.action === "lock" ? "plan-user-fixture" : null;
      return route.fulfill({ json: { file: { content: document.content, version: document.version } } });
    }
    if (path.includes("/files/") || path.endsWith("/workspace")) {
      downloads++;
      return route.fulfill({ body: "Unexpected download" });
    }
    if (path.endsWith("/executions")) {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON(); requests.push(body);
        if (body.action === "start") {
          const chosen = snapshot.files.map(skill).filter(item => body.skillIds.includes(item.id));
          runs = [execution("new-plan-run", body.request, chosen, "running"), ...runs];
          return route.fulfill({ status: 202, json: { packageId, execution: runs[0] } });
        }
      }
      return route.fulfill({ json: { executions: runs, skills: snapshot.files.map(skill), repositoryEnabled: false, runners: [runner], userId: "plan-user-fixture", owner: true } });
    }
    unexpected.push(`${route.request().method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: "Unexpected fixture API route" } });
  });
  return { snapshot, requests, documentRequests, fileActions, creations, unexpected, failDocuments, notifySnapshotUpdate: () => { snapshotUpdatePending = "file_updated"; }, downloads: () => downloads };
}

async function screenshotDirectory() {
  const directory = path.resolve(".tmp/dynamic-documents-ui-20261111");
  await mkdir(directory, { recursive: true });
  return directory;
}

test("文档生成失败在文档区展示原因，刷新后保留失败提示与展开进度", async ({ page }) => {
  const fixture = await planPage(page);
  const reason = "模型服务返回错误（HTTP 400），本轮已停止，未自动重试。";
  fixture.failDocuments(reason);
  await page.goto(`/?project=${projectId}&package=${packageId}`);
  const documents = page.getByRole("region", { name: "研究文档", exact: true });
  const failure = documents.getByRole("alert");
  await expect(failure.getByRole("heading", { name: "文档生成失败", exact: true })).toBeVisible();
  await expect(failure).toContainText(reason);
  await expect(failure).toContainText("本次未保存文档");
  await expect(documents.getByText("还没有保存的方案文档", { exact: true })).toHaveCount(0);
  await expect(documents.getByText("文档正在生成", { exact: true })).toHaveCount(0);
  await expect(page.locator("details").filter({ has: page.locator("#research-progress") })).toHaveAttribute("open", "");
  await expect(page.locator("#research-progress")).toContainText(reason);
  await expect(documents.getByRole("button", { name: "↓ 全部 ZIP", exact: true })).toBeDisabled();
  await page.reload();
  await expect(failure).toContainText(reason);
  expect(fixture.documentRequests).toHaveLength(0);
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.snapshot.files).toHaveLength(0);
  expect(fixture.unexpected).toEqual([]);
});

test("排队后的异步失败通过 SSE 展示，仅手动重新规划后回到确认清单", async ({ page }) => {
  const fixture = await planPage(page, { queuedGeneration: true, refreshableStream: true });
  await page.goto(`/?project=${projectId}&package=${packageId}`);
  await page.getByRole("button", { name: "预览文档清单", exact: true }).click();
  await page.getByRole("button", { name: "确认并生成 2 份文档", exact: true }).click();
  await expect.poll(() => fixture.documentRequests.length).toBe(2);
  await expect(page.locator("#research-progress")).toContainText("Agent 正在处理");
  const reason = "当前接口不支持文档所需的结构化输出，请检查模型 API 设置。";
  fixture.failDocuments(reason);
  const documents = page.getByRole("region", { name: "研究文档", exact: true });
  await expect(documents.getByRole("alert")).toContainText(reason);
  await expect(page.locator("#research-progress")).toBeVisible();
  expect(fixture.documentRequests.filter(request => request.action === "generate")).toHaveLength(1);
  await documents.getByRole("button", { name: "重新规划文档", exact: true }).click();
  await expect(page.getByRole("region", { name: "确认文档清单", exact: true })).toBeVisible();
  await expect(documents.getByRole("alert")).toHaveCount(0);
  expect(fixture.documentRequests.filter(request => request.action === "preview")).toHaveLength(2);
  expect(fixture.documentRequests.filter(request => request.action === "generate")).toHaveLength(1);
  expect(fixture.snapshot.files).toHaveLength(0);
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.unexpected).toEqual([]);
});

test("重新生成失败仍可浏览旧文档，明确旧版本未更新且不自动交接执行", async ({ page }) => {
  const fixture = await planPage(page, { savedVersion: 3 });
  const savedFiles = structuredClone(fixture.snapshot.files);
  fixture.failDocuments("模型服务响应超时，本轮已停止，未自动重试。");
  await page.goto(`/?project=${projectId}&package=${packageId}`);
  const documents = page.getByRole("region", { name: "研究文档", exact: true });
  await expect(documents.getByRole("alert")).toContainText("下方 2 份文档仍为之前保存的版本");
  await expect(documents.getByText("检查已保存的文档，再继续执行", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "加法模块实施方案", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /TASKS\.md/ }).click();
  await expect(page.getByRole("heading", { name: "验收清单", exact: true })).toBeVisible();
  await expect(documents.getByRole("alert")).toBeVisible();
  await expect(documents.getByRole("button", { name: "↓ 全部 ZIP", exact: true })).toBeEnabled();
  expect(fixture.snapshot.files).toEqual(savedFiles);
  expect(fixture.documentRequests).toHaveLength(0);
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.downloads()).toBe(0);
  expect(fixture.unexpected).toEqual([]);
});

test("已有对话先确认文档清单，保存正文后显式交接技能并手动执行", async ({ page }) => {
  const fixture = await planPage(page);
  await page.goto(`/?project=${projectId}&package=${packageId}`);
  const executionPanel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  await expect(page.getByRole("heading", { name: "研究文档", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "生成方案", exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "使用这些文档继续执行", exact: true })).toHaveCount(0);
  const request = "创建加法模块，覆盖正负数与小数，并记录实际测试结果。";
  await page.getByRole("textbox", { name: "继续与 Agent 对话", exact: true }).fill(request);
  await page.getByRole("button", { name: "预览文档清单", exact: true }).click();
  await expect.poll(() => fixture.documentRequests.length).toBe(1);
  expect(fixture.documentRequests[0]).toEqual({ action: "preview", request });
  const proposal = page.getByRole("region", { name: "确认文档清单", exact: true });
  await expect(proposal.getByRole("textbox", { name: "文档 1 文件名", exact: true })).toHaveValue("PLAN.md");
  await expect(proposal.getByRole("textbox", { name: "文档 2 文件名", exact: true })).toHaveValue("TASKS.md");
  expect(fixture.snapshot.files).toHaveLength(0);
  expect(fixture.requests).toHaveLength(0);
  await expect(page.getByRole("tablist", { name: "工作区文件", exact: true })).toHaveCount(0);
  await proposal.getByRole("button", { name: "确认并生成 2 份文档", exact: true }).click();
  await expect.poll(() => fixture.documentRequests.length).toBe(2);
  expect(fixture.documentRequests[1]).toEqual({ action: "generate", proposalId: "document-proposal-1", documents: defaults });
  await page.getByRole("tab", { name: /PLAN\.md/ }).click();
  await expect(page.getByRole("heading", { name: "加法模块实施方案", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "↓ 当前文件", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "↓ 全部 ZIP", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "使用这些文档继续执行", exact: true }).click();
  await expect(page.getByRole("tab", { name: "执行工作区", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "研究文档", exact: true })).not.toBeVisible();
  await expect(executionPanel.getByRole("checkbox", { name: /PLAN\.md/ })).toBeChecked();
  await expect(executionPanel.getByRole("checkbox", { name: /TASKS\.md/ })).toBeChecked();
  const requirements = executionPanel.getByRole("textbox", { name: "工作区执行要求", exact: true });
  await expect(requirements).not.toHaveValue("");
  expect(fixture.requests).toHaveLength(0); // Handoff requires a separate explicit start.
  const edited = "按所选方案实现；先保留用户文件，再运行 Node 内置测试。";
  await requirements.fill(edited);
  await executionPanel.getByRole("radio", { name: "本地工作区", exact: true }).check();
  await executionPanel.getByRole("button", { name: "开始执行", exact: true }).click();
  await expect.poll(() => fixture.requests.length).toBe(1);
  expect(fixture.requests[0]).toEqual({ action: "start", request: edited, packageId, skillIds: ["skill-PLAN.md", "skill-TASKS.md"], target: "local", runnerId: runner.id });
  await expect(executionPanel.getByText("技能：PLAN.md v1、TASKS.md v1", { exact: true })).toBeVisible();
  expect(fixture.downloads()).toBe(0);
  expect(fixture.unexpected).toEqual([]);
});

test("首次输入只准备清单，用户确认后才保存 Markdown", async ({ page }) => {
  const fixture = await planPage(page);
  await page.goto(`/?project=${projectId}`);
  await page.getByRole("textbox", { name: "你想完成什么？", exact: true }).fill(goal);
  await expect(page.getByRole("radio", { name: "生成方案", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "仅讨论", exact: true })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "发送 →", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "预览文档清单", exact: true }).click();
  await expect.poll(() => fixture.creations.length).toBe(1);
  expect(fixture.creations[0]).toContain(goal);
  expect(fixture.creations[0]).toMatch(/name="mode"\r\n\r\ndocuments\r\n/);
  expect(fixture.documentRequests).toHaveLength(0);
  await expect(page.getByRole("region", { name: "确认文档清单", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "使用这些文档继续执行", exact: true })).toHaveCount(0);
  expect(fixture.snapshot.files).toHaveLength(0);
  await page.getByRole("button", { name: "确认并生成 2 份文档", exact: true }).click();
  await expect.poll(() => fixture.documentRequests.length).toBe(1);
  expect(fixture.documentRequests[0]).toEqual({ action: "generate", proposalId: "document-proposal-1", documents: defaults });
  await expect(page.getByRole("button", { name: "使用这些文档继续执行", exact: true })).toBeVisible();
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.downloads()).toBe(0);
  expect(fixture.unexpected).toEqual([]);
});

test("右侧空文档区可以按已有需求规划清单，取消不会生成文件", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const fixture = await planPage(page);
  await page.goto(`/?project=${projectId}&package=${packageId}`);
  const documents = page.getByRole("region", { name: "研究文档", exact: true });
  await expect(page.getByRole("textbox", { name: "继续与 Agent 对话", exact: true })).toHaveValue("");
  await page.getByRole("region", { name: "研究与对话", exact: true }).evaluate(element => element.scrollIntoView({ block: "start" }));
  await page.locator(".sf-research-grid").screenshot({ path: test.info().outputPath("desktop-empty-documents.png") });
  await documents.getByRole("button", { name: "根据当前需求规划文档", exact: true }).click();
  await expect.poll(() => fixture.documentRequests.length).toBe(1);
  expect(fixture.documentRequests[0]).toEqual({ action: "preview", request: goal });
  await expect(documents.getByRole("region", { name: "确认文档清单", exact: true })).toBeVisible();
  await documents.getByRole("button", { name: "暂不生成", exact: true }).click();
  await expect(documents.getByRole("region", { name: "确认文档清单", exact: true })).toHaveCount(0);
  expect(fixture.snapshot.files).toHaveLength(0);
  expect(fixture.documentRequests.filter(request => request.action === "generate")).toHaveLength(0);
  await page.reload();
  await expect(documents.getByRole("region", { name: "确认文档清单", exact: true })).toBeVisible();
  await documents.getByRole("button", { name: "确认并生成 2 份文档", exact: true }).click();
  await expect(documents.getByRole("heading", { name: "加法模块实施方案", exact: true })).toBeVisible();
  await expect(documents.getByRole("button", { name: "根据当前需求规划文档", exact: true })).toHaveCount(0);
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.unexpected).toEqual([]);
});

test("复杂任务可调整清单，保留未选旧文件，全部实际文档仍能交接为技能", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fixture = await planPage(page, { savedVersion: 1 });
  const notes = { ...planDocument("USER_NOTES.md", 3), updatedBy: "user", content: "# 用户笔记\n\n保留原始人工记录，不自动覆盖。" };
  fixture.snapshot.files.push(notes);
  await page.goto(`/?project=${projectId}&package=${packageId}`);
  const request = "为加法服务准备 API 接口设计，并整理独立的验收文档。";
  await page.getByRole("textbox", { name: "继续与 Agent 对话", exact: true }).fill(request);
  await page.getByRole("button", { name: "预览文档清单", exact: true }).click();
  const editor = page.getByRole("region", { name: "确认文档清单", exact: true });
  await expect(editor.getByRole("textbox", { name: "文档 3 文件名", exact: true })).toHaveValue("API_DESIGN.md");
  await editor.getByRole("textbox", { name: "文档 3 文件名", exact: true }).fill("CONTRACT.md");
  await editor.getByRole("textbox", { name: "文档 3 用途", exact: true }).fill("约定接口输入、输出与错误响应");
  await editor.getByRole("textbox", { name: "文档 3 内容要点", exact: true }).fill("请求与响应\n错误响应");
  await editor.getByRole("button", { name: "移除文档 2", exact: true }).click();
  await editor.getByRole("button", { name: "添加自定义文档", exact: true }).click();
  await editor.getByRole("textbox", { name: "文档 3 文件名", exact: true }).fill("ACCEPTANCE.md");
  await editor.getByRole("textbox", { name: "文档 3 用途", exact: true }).fill("独立验收步骤与人工确认事项");
  await editor.getByRole("textbox", { name: "文档 3 内容要点", exact: true }).fill("验收步骤\n人工确认事项");
  expect(fixture.documentRequests.filter(request => request.action === "generate")).toHaveLength(0);
  await expect(page.getByRole("tab", { name: /USER_NOTES\.md/ })).toBeVisible();
  await page.getByTestId("research-document-scroll").evaluate(element => { element.scrollTop = 0; });
  await page.locator(".sf-research-grid").evaluate(element => element.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: path.join(await screenshotDirectory(), "editable-document-list.png") });
  await editor.getByRole("button", { name: "确认并生成 3 份文档", exact: true }).click();
  await expect.poll(() => fixture.documentRequests.filter(request => request.action === "generate").length).toBe(1);
  expect(fixture.documentRequests.at(-1)).toEqual({ action: "generate", proposalId: "document-proposal-1", documents: [defaults[0],
    { filename: "CONTRACT.md", purpose: "约定接口输入、输出与错误响应", contentOutline: ["请求与响应", "错误响应"] },
    { filename: "ACCEPTANCE.md", purpose: "独立验收步骤与人工确认事项", contentOutline: ["验收步骤", "人工确认事项"] }] });
  expect(fixture.snapshot.files.find(file => file.filename === "USER_NOTES.md")).toEqual(notes);
  expect(fixture.snapshot.files.find(file => file.filename === "TASKS.md")?.version).toBe(1);
  await page.getByRole("tab", { name: /CONTRACT\.md/ }).click();
  await expect(page.getByRole("heading", { name: "CONTRACT 设计说明", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "使用这些文档继续执行", exact: true }).click();
  const executionPanel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  for (const filename of ["PLAN.md", "TASKS.md", "USER_NOTES.md", "CONTRACT.md", "ACCEPTANCE.md"]) await expect(executionPanel.getByRole("checkbox", { name: new RegExp(filename.replace(".", "\\.")) })).toBeChecked();
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.downloads()).toBe(0);
  expect(fixture.unexpected).toEqual([]);
});

test("清单允许单份自定义文档，模板增删不强制保留 PLAN 或 TASKS", async ({ page }) => {
  const fixture = await planPage(page);
  await page.goto(`/?project=${projectId}&package=${packageId}`);
  await page.getByRole("button", { name: "预览文档清单", exact: true }).click();
  const editor = page.getByRole("region", { name: "确认文档清单", exact: true });
  await editor.getByRole("combobox", { name: "添加文档模板", exact: true }).selectOption("API_DESIGN.md");
  await editor.getByRole("button", { name: "添加模板", exact: true }).click();
  await expect(editor.getByRole("textbox", { name: "文档 3 文件名", exact: true })).toHaveValue("API_DESIGN.md");
  await editor.getByRole("button", { name: "移除文档 1", exact: true }).click();
  await editor.getByRole("button", { name: "移除文档 1", exact: true }).click();
  await editor.getByRole("textbox", { name: "文档 1 文件名", exact: true }).fill("RUNBOOK.md");
  await editor.getByRole("button", { name: "确认并生成 1 份文档", exact: true }).click();
  await expect.poll(() => fixture.snapshot.files.length).toBe(1);
  expect(fixture.snapshot.files[0].filename).toBe("RUNBOOK.md");
  await expect(page.getByRole("tab", { name: /RUNBOOK\.md/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /PLAN\.md|TASKS\.md/ })).toHaveCount(0);
  expect(fixture.documentRequests.filter(request => request.action === "generate")).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
});

test("重名、越界或非 Markdown 文件在确认前被阻止，拒绝保存时保留编辑内容", async ({ page }) => {
  const fixture = await planPage(page, { generateError: "该文件已由你编辑，未覆盖当前文档。" });
  await page.goto(`/?project=${projectId}&package=${packageId}`);
  await page.getByRole("button", { name: "预览文档清单", exact: true }).click();
  const editor = page.getByRole("region", { name: "确认文档清单", exact: true });
  const filename = editor.getByRole("textbox", { name: "文档 2 文件名", exact: true });
  const confirm = editor.getByRole("button", { name: "确认并生成 2 份文档", exact: true });
  for (const invalid of ["plan.md", "../SECRETS.md", "README.txt", "NUL.md"]) {
    await filename.fill(invalid);
    await expect(confirm).toBeDisabled();
    expect(fixture.documentRequests.filter(request => request.action === "generate")).toHaveLength(0);
  }
  await filename.fill("VALIDATION.md");
  await editor.getByRole("textbox", { name: "文档 2 用途", exact: true }).fill("自定义验收要求");
  await confirm.click();
  await expect(page.getByText("该文件已由你编辑，未覆盖当前文档。", { exact: true })).toBeVisible();
  await expect(filename).toHaveValue("VALIDATION.md");
  await expect(editor.getByRole("textbox", { name: "文档 2 用途", exact: true })).toHaveValue("自定义验收要求");
  expect(fixture.snapshot.files).toHaveLength(0);
  expect(fixture.requests).toHaveLength(0);
});

test("资料更新使清单过期时保留本地编辑，明确重新预览后才替换清单", async ({ page }) => {
  const fixture = await planPage(page, { refreshableStream: true });
  await page.goto(`/?project=${projectId}&package=${packageId}`);
  await page.getByRole("textbox", { name: "继续与 Agent 对话", exact: true }).fill("原始加法模块需求");
  await page.getByRole("button", { name: "预览文档清单", exact: true }).click();
  const editor = page.getByRole("region", { name: "确认文档清单", exact: true });
  const filename = editor.getByRole("textbox", { name: "文档 2 文件名", exact: true });
  const purpose = editor.getByRole("textbox", { name: "文档 2 用途", exact: true });
  await filename.fill("LOCAL_DRAFT.md");
  await purpose.fill("暂存中的自定义约束");
  await page.getByRole("textbox", { name: "继续与 Agent 对话", exact: true }).fill("左侧尚未提交的新想法");
  fixture.snapshot.documentProposalStale = true;
  fixture.notifySnapshotUpdate();
  await expect(editor.getByText("资料或文档已更新，请重新预览清单；当前编辑内容已保留。", { exact: true })).toBeVisible();
  await expect(filename).toHaveValue("LOCAL_DRAFT.md");
  await expect(purpose).toHaveValue("暂存中的自定义约束");
  await expect(filename).toBeEnabled();
  await expect(editor.getByRole("button", { name: "确认并生成 2 份文档", exact: true })).toBeDisabled();
  expect(fixture.documentRequests.filter(request => request.action === "generate")).toHaveLength(0);
  await editor.getByRole("button", { name: "重新预览清单", exact: true }).click();
  await expect.poll(() => fixture.documentRequests.length).toBe(2);
  expect(fixture.documentRequests[1]).toEqual({ action: "preview", request: "原始加法模块需求" });
  await expect(filename).toHaveValue("TASKS.md");
  await expect(editor.getByText("资料或文档已更新，请重新预览清单；当前编辑内容已保留。", { exact: true })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "确认并生成 2 份文档", exact: true })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "继续与 Agent 对话", exact: true })).toHaveValue("左侧尚未提交的新想法");
  expect(fixture.snapshot.documentProposal?.id).toBe("document-proposal-2");
  expect(fixture.snapshot.files).toHaveLength(0);
  expect(fixture.requests).toHaveLength(0);
});

test("手机文档清单可编辑且不横向溢出，未确认前不交接执行", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await planPage(page);
  await page.goto(`/?project=${projectId}&package=${packageId}`);
  await page.getByRole("textbox", { name: "继续与 Agent 对话", exact: true }).fill("设计一个 API 接口方案");
  await page.getByRole("button", { name: "预览文档清单", exact: true }).click();
  const editor = page.getByRole("region", { name: "确认文档清单", exact: true });
  await expect(editor.getByRole("textbox", { name: "文档 3 文件名", exact: true })).toHaveValue("API_DESIGN.md");
  await page.getByTestId("research-document-scroll").evaluate(element => { element.scrollTop = 0; });
  await page.getByRole("region", { name: "研究文档", exact: true }).evaluate(element => element.scrollIntoView({ block: "start" }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: path.join(await screenshotDirectory(), "mobile-document-list.png") });
  await expect(page.getByRole("button", { name: "使用这些文档继续执行", exact: true })).toHaveCount(0);
  expect(fixture.documentRequests.filter(request => request.action === "generate")).toHaveLength(0);
  expect(fixture.snapshot.files).toHaveLength(0);
  expect(fixture.requests).toHaveLength(0);
});

async function longWorkspace(page: Page) {
  const fixture = await planPage(page, { savedVersion: 1 });
  for (let index = 0; index < 48; index++) fixture.snapshot.events.push(researchEvent(100 + index,
    index % 2 ? "assistant_message" : "user_message", `第 ${index + 1} 轮讨论\n\n${"补充目标、范围和需要人工确认的约束。".repeat(14)}\n\n${"long-unbroken-reference-".repeat(24)}`));
  fixture.snapshot.files[0].content += Array.from({ length: 65 }, (_, index) => `\n\n## 实施阶段 ${index + 1}\n\n${"读取已有文件，遵守任务约束，记录实际结果。".repeat(16)}\n\n\`\`\`text\n${"long-source-name-".repeat(32)}\n\`\`\``).join("");
  await page.goto(`/?project=${projectId}&package=${packageId}`);
  await expect(page.getByRole("heading", { name: "加法模块实施方案", exact: true })).toBeVisible();
  return fixture;
}

test("桌面长对话与长文档保持左右同高，各自滚动且输入区持续可见", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const fixture = await longWorkspace(page);
  const research = page.getByRole("region", { name: "研究与对话", exact: true });
  const documents = page.getByRole("region", { name: "研究文档", exact: true });
  const historyScroll = page.getByTestId("research-history-scroll");
  const documentScroll = page.getByTestId("research-document-scroll");
  const composer = page.getByTestId("research-composer");
  await research.evaluate(element => element.scrollIntoView({ block: "start" }));
  const left = await research.boundingBox(), right = await documents.boundingBox();
  expect(left).not.toBeNull(); expect(right).not.toBeNull();
  expect(Math.abs(left!.height - right!.height)).toBeLessThanOrEqual(2);
  expect(Math.abs(left!.y - right!.y)).toBeLessThanOrEqual(2);
  expect(right!.x).toBeGreaterThan(left!.x + left!.width);
  const composerBefore = await composer.boundingBox();
  expect(composerBefore).not.toBeNull();
  expect(composerBefore!.y).toBeGreaterThanOrEqual(0);
  expect(composerBefore!.y + composerBefore!.height).toBeLessThanOrEqual(901);
  const windowScroll = await page.evaluate(() => window.scrollY);
  for (const scroll of [historyScroll, documentScroll]) {
    const metrics = await scroll.evaluate(element => ({ client: element.clientHeight, content: element.scrollHeight, overflow: getComputedStyle(element).overflowY }));
    expect(metrics.content).toBeGreaterThan(metrics.client + 200);
    expect(["auto", "scroll"]).toContain(metrics.overflow);
    await scroll.evaluate(element => { element.scrollTop = 0; });
    await scroll.hover();
    await page.mouse.wheel(0, 1200);
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  }
  const composerAfter = await composer.boundingBox();
  expect(Math.abs(composerAfter!.y - composerBefore!.y)).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => window.scrollY)).toBe(windowScroll);
  await expect(composer.getByRole("textbox", { name: "继续与 Agent 对话", exact: true })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.locator(".sf-research-grid").screenshot({ path: test.info().outputPath("desktop-long-workspace-scrolled.png") });
  expect(fixture.unexpected).toEqual([]);
});

test("移动端长对话与文档竖排，区域有高度边界且页面不横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await longWorkspace(page);
  const research = await page.getByRole("region", { name: "研究与对话", exact: true }).boundingBox();
  const documents = await page.getByRole("region", { name: "研究文档", exact: true }).boundingBox();
  expect(research).not.toBeNull(); expect(documents).not.toBeNull();
  expect(documents!.y).toBeGreaterThanOrEqual(research!.y + research!.height);
  for (const id of ["research-history-scroll", "research-document-scroll"]) {
    const metrics = await page.getByTestId(id).evaluate(element => ({ client: element.clientHeight, content: element.scrollHeight }));
    expect(metrics.content).toBeGreaterThan(metrics.client + 200);
  }
  const composer = page.getByTestId("research-composer");
  await composer.scrollIntoViewIfNeeded();
  await expect(composer.getByRole("textbox", { name: "继续与 Agent 对话", exact: true })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("mobile-long-workspace.png"), fullPage: true });
  expect(fixture.unexpected).toEqual([]);
});

test("研究和执行进度分别展示，更新技能不会改变旧任务的冻结版本", async ({ page }) => {
  const oldSkills = [skill(planDocument("PLAN.md", 1))];
  const first = execution("first-plan-run", "第一份执行要求", oldSkills);
  const second = execution("second-plan-run", "第二份执行要求", oldSkills);
  const extraEvents = [researchEvent(6, "planning_completed", "研究方案独有进度"),
    researchEvent(7, "execution_progress", "第一任务独有进度", { executionId: first.id }),
    researchEvent(8, "execution_progress", "第二任务独有进度", { executionId: second.id }),
    researchEvent(9, "execution_progress", "不可见任务进度", { executionId: "hidden-run" })];
  const fixture = await planPage(page, { savedVersion: 2, executions: [first, second], extraEvents });
  await page.goto(`/?project=${projectId}&package=${packageId}`);
  const executionPanel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  const researchProgress = page.locator("#research-progress");
  await expect(researchProgress).toContainText("研究方案独有进度");
  await expect(researchProgress).not.toContainText("第一任务独有进度");
  await expect(researchProgress).not.toContainText("第二任务独有进度");
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  await expect(executionPanel).not.toContainText("研究方案独有进度");
  await expect(executionPanel).not.toContainText("不可见任务进度");
  const firstArticle = executionPanel.locator("article").filter({ hasText: "第一份执行要求" });
  const secondArticle = executionPanel.locator("article").filter({ hasText: "第二份执行要求" });
  await expect(firstArticle).toContainText("第一任务独有进度");
  await expect(firstArticle).not.toContainText("第二任务独有进度");
  await expect(secondArticle).toContainText("第二任务独有进度");
  await expect(secondArticle).not.toContainText("第一任务独有进度");
  await expect(firstArticle).toContainText("技能：PLAN.md v1");
  await page.getByRole("tab", { name: "方案与文档", exact: true }).click();
  await page.getByRole("button", { name: "使用这些文档继续执行", exact: true }).click();
  await expect(executionPanel.getByRole("checkbox", { name: /PLAN\.md · v2/ })).toBeChecked();
  await expect(firstArticle).toContainText("技能：PLAN.md v1");
  await expect(page.getByRole("tab", { name: "执行工作区", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "研究与对话", exact: true })).not.toBeVisible();
  expect(fixture.requests).toHaveLength(0);
});

test("页签往返保留未确认清单和聊天草稿，切换本身不生成正文或启动任务", async ({ page }) => {
  const fixture = await planPage(page);
  await page.goto(`/?project=${projectId}&package=${packageId}`);
  const discussion = page.getByRole("textbox", { name: "继续与 Agent 对话", exact: true });
  await discussion.fill("需要独立的 API 接口说明");
  await page.getByRole("button", { name: "预览文档清单", exact: true }).click();
  const editor = page.getByRole("region", { name: "确认文档清单", exact: true });
  await editor.getByRole("textbox", { name: "文档 3 文件名", exact: true }).fill("MY_API.md");
  await editor.getByRole("textbox", { name: "文档 3 用途", exact: true }).fill("保留尚未确认的接口约定");
  await discussion.fill("左侧还有未提交的补充想法");
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  await expect(page).toHaveURL(/workspace=execution/);
  await expect(editor).not.toBeVisible();
  await page.getByRole("tab", { name: "方案与文档", exact: true }).click();
  await expect(editor.getByRole("textbox", { name: "文档 3 文件名", exact: true })).toHaveValue("MY_API.md");
  await expect(editor.getByRole("textbox", { name: "文档 3 用途", exact: true })).toHaveValue("保留尚未确认的接口约定");
  await expect(discussion).toHaveValue("左侧还有未提交的补充想法");
  expect(fixture.documentRequests).toEqual([{ action: "preview", request: "需要独立的 API 接口说明" }]);
  expect(fixture.snapshot.files).toHaveLength(0);
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.unexpected).toEqual([]);
});

test("文档编辑中切换页签保留编辑器和修改说明，不释放编辑锁或自动保存", async ({ page }) => {
  const fixture = await planPage(page, { savedVersion: 1 });
  await page.goto(`/?project=${projectId}&package=${packageId}`);
  await page.getByRole("tab", { name: /TASKS\.md/ }).click();
  await page.getByRole("button", { name: "编辑 Markdown", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 文件内容", exact: true });
  await editor.fill("# 尚未保存的任务草稿\n\n保留人工约束。");
  await page.getByRole("textbox", { name: "修改说明", exact: true }).fill("未提交的修改说明");
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  const executionPanel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  await expect(executionPanel).toContainText("方案仍在处理");
  await executionPanel.getByRole("radio", { name: "本地工作区", exact: true }).check();
  await executionPanel.getByRole("textbox", { name: "工作区执行要求", exact: true }).fill("等待文档编辑完成");
  await expect(executionPanel.getByRole("button", { name: "开始执行", exact: true })).toBeDisabled();
  expect(fixture.fileActions.map(action => action.action)).toEqual(["lock"]);
  await page.getByRole("tab", { name: "方案与文档", exact: true }).click();
  await expect(page.getByRole("tab", { name: /TASKS\.md/ })).toHaveAttribute("aria-selected", "true");
  await expect(editor).toHaveValue("# 尚未保存的任务草稿\n\n保留人工约束。");
  await expect(page.getByRole("textbox", { name: "修改说明", exact: true })).toHaveValue("未提交的修改说明");
  await expect(page.getByRole("button", { name: "保存并通知 Agent", exact: true })).toBeVisible();
  expect(fixture.fileActions.map(action => action.action)).toEqual(["lock"]);
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.snapshot.files.find(file => file.filename === "TASKS.md")?.version).toBe(1);
  await page.getByRole("button", { name: "取消编辑", exact: true }).click();
  expect(fixture.unexpected).toEqual([]);
});

test("执行页可通过地址恢复，文件与研究深链优先打开方案页", async ({ page }) => {
  const fixture = await planPage(page, { savedVersion: 1 });
  await page.goto(`/?project=${projectId}&package=${packageId}&workspace=execution`);
  await expect(page.getByRole("tab", { name: "执行工作区", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Agent 执行工作区", exact: true })).toBeVisible();
  await page.goto(`/?project=${projectId}&package=${packageId}&workspace=execution&file=TASKS.md`);
  await expect(page.getByRole("tab", { name: "方案与文档", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "验收清单", exact: true })).toBeVisible();
  await page.goto(`/?project=${projectId}&package=${packageId}&workspace=execution#research-summary`);
  await expect(page.getByRole("tab", { name: "方案与文档", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "研究与对话", exact: true })).toBeVisible();
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.documentRequests).toHaveLength(0);
});

test("执行记录展示真实模型预算、响应阶段和截断用量，恢复轮次互不覆盖", async ({ page }) => {
  const run = { ...execution("model-budget-progress", goal, [], "failed"), attempts: 2, error: "模型输出达到本轮 token 上限而被截断。" };
  const base = { requestNumber: 3, apiMode: "responses", timeoutSeconds: 300, maxOutputTokens: 16384, reasoningEffort: "none", budgetMode: "auto" };
  const fixture = await planPage(page, { savedVersion: 1, executions: [run], extraEvents: [
    researchEvent(20, "execution_progress", "第一尝试：等待模型服务响应", { executionId: run.id, progress: { operationId: "attempt-one-3", action: "model_request", phase: "waiting", model: { ...base, phase: "started" } } }),
    researchEvent(21, "execution_progress", "第一尝试：已收到响应头，等待完整结果", { executionId: run.id, progress: { operationId: "attempt-one-3", action: "model_request", phase: "waiting", model: { ...base, phase: "headers", headersDurationMs: 120 } } }),
    researchEvent(22, "execution_progress", "第一尝试：输出预算耗尽", { executionId: run.id, progress: { operationId: "attempt-one-3", action: "model_request", phase: "failed", durationMs: 123000, model: { ...base, phase: "failed", headersDurationMs: 120, httpStatus: 200, inputTokens: 1000, outputTokens: 16384, reasoningTokens: 0, failureKind: "incomplete", incompleteReason: "max_output_tokens" } } }),
    researchEvent(23, "execution_progress", "第二尝试：模型返回未完成结果", { executionId: run.id, progress: { operationId: "attempt-two-3", action: "model_request", phase: "failed", durationMs: 12000, model: { ...base, phase: "failed", incompleteReason: "unknown" } } }),
  ] });
  await page.goto(`/?project=${projectId}&package=${packageId}&workspace=execution`);
  const panel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  await panel.getByRole("radio", { name: "本地工作区", exact: true }).check();
  const timeline = panel.getByRole("list", { name: "执行任务进度" });
  await panel.locator("summary").filter({ hasText: /^执行进度 ·/ }).click();
  const first = timeline.getByRole("listitem").filter({ hasText: "第一尝试：输出预算耗尽" });
  const second = timeline.getByRole("listitem").filter({ hasText: "第二尝试：模型返回未完成结果" });
  await expect(first).toHaveCount(1); await expect(second).toHaveCount(1);
  await expect(timeline).not.toContainText("第一尝试：等待模型服务响应");
  await expect(first.getByLabel("本轮模型参数")).toHaveText("超时 300 秒 · 输出上限 16384（自动） · 思考关闭");
  await expect(first).toContainText("本轮输出 16384 token，其中思考 0 token");
  await first.getByText("操作详情", { exact: true }).click();
  await expect(first.getByLabel("模型请求详情")).toContainText("HTTP 状态：200");
  await expect(first.getByLabel("模型请求详情")).toContainText("收到响应头：120 毫秒");
  await second.getByText("操作详情", { exact: true }).click();
  await expect(second).toContainText("服务商未返回可用的输出用量");
  expect(fixture.requests).toHaveLength(0); expect(fixture.documentRequests).toHaveLength(0); expect(fixture.unexpected).toEqual([]);
});

test("双页签桌面与手机截图，当前任务展开且历史默认收起，页面不横向溢出", async ({ page }) => {
  const directory = path.resolve(".tmp/workspace-tabs-ui-20261111");
  await mkdir(directory, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const current = execution("screenshot-current", "根据所选文档实现加法模块，并记录实际验证结果。", [skill(planDocument("PLAN.md", 1))], "running");
  const old = { ...execution("screenshot-old", "此前已结束的任务", [skill(planDocument("TASKS.md", 1))]), createdAt: "2026-11-10T00:00:00.000Z" };
  const fixture = await planPage(page, { savedVersion: 1, executions: [current, old], extraEvents: [
    researchEvent(20, "execution_progress", "已读取 PLAN.md v1", { executionId: current.id, progress: { operationId: "read-plan", action: "read_skill", phase: "completed", skill: { filename: "PLAN.md", version: 1 }, durationMs: 5 } }),
    researchEvent(21, "execution_progress", "正在读取 src/calc.mjs", { executionId: current.id, progress: { operationId: "read-source", action: "read_file", phase: "started", paths: ["src/calc.mjs"] } }),
  ] });
  await page.goto(`/?project=${projectId}&package=${packageId}`);
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  const executionPanel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  await executionPanel.getByRole("radio", { name: "本地工作区", exact: true }).check();
  await page.getByRole("tab", { name: "方案与文档", exact: true }).click();
  const navigation = page.locator('header[aria-label="项目工作区导航"]');
  await navigation.evaluate(element => element.scrollIntoView({ block: "start" }));
  await expect(page.getByRole("heading", { name: "加法模块实施方案", exact: true })).toBeVisible();
  await expect(executionPanel).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: path.join(directory, "desktop-research.png") });
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  await navigation.evaluate(element => element.scrollIntoView({ block: "start" }));
  await expect(executionPanel.locator('[data-execution-id="screenshot-current"]')).toBeVisible();
  await expect(executionPanel.locator('[data-execution-id="screenshot-old"]')).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: path.join(directory, "desktop-execution.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await navigation.evaluate(element => element.scrollIntoView({ block: "start" }));
  await expect(navigation.getByRole("tab", { name: "执行工作区", exact: true })).toBeVisible();
  await expect(navigation.getByRole("group", { name: "工作区连接概况", exact: true })).toContainText(runner.workspaceDirectory);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: path.join(directory, "mobile-workspace.png") });
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.documentRequests).toHaveLength(0);
  expect(fixture.unexpected).toEqual([]);
});
