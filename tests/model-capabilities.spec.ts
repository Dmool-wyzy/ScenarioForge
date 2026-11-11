import { test, expect, type Page } from "@playwright/test";

type ProbeKind = "connection" | "tools" | "structured_output";
type ApiMode = "responses" | "chat_completions";
type FixtureSettings = { baseUrl: string; model: string; apiMode: ApiMode; timeoutSeconds: number; deepseekSearchEnabled: boolean; hasApiKey: boolean; reasoningEffort?: string; maxOutputTokens?: number | null };
const projectId = "capability-project";
const labels: Record<ProbeKind, string> = { connection: "基础连接", tools: "工具调用", structured_output: "结构化输出" };

async function modelSettingsPage(page: Page, personal: boolean) {
  const state = {
    settings: { baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro", apiMode: "chat_completions", timeoutSeconds: 120, deepseekSearchEnabled: false, hasApiKey: true } as FixtureSettings,
    acceptsAgentTasks: false,
    probes: [] as Record<string, unknown>[], saves: [] as Record<string, unknown>[],
    failure: null as { kind: ProbeKind; status: number; message: string } | null,
  };
  const endpoint = `/api/projects/${projectId}/${personal ? "personal-agent" : "model"}`;
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "capability-user", username: "capability_fixture" } } });
    if (path === "/api/projects") return route.fulfill({ json: { projects: [{ id: projectId, name: "模型能力检查", inviteCode: "TEST01", role: "owner", memberCount: 1, researchPackages: [] }] } });
    if (path === "/api/me/profile") return route.fulfill({ json: {
      user: { username: "capability_fixture", createdAt: "2026-11-11T00:00:00Z" },
      profile: { nickname: "能力检查", avatar: "leaf", bio: "", specialty: "", skills: [], agentStyle: "balanced", agentTech: "", agentDelivery: "", agentNotes: "" },
      projects: [{ id: projectId, name: "模型能力检查" }],
    } });
    if (path === `${endpoint}/test`) {
      const draft = request.postDataJSON(); state.probes.push(draft);
      const failure = state.failure;
      if (failure && failure.kind === draft.testKind) return route.fulfill({ status: failure.status, json: { error: failure.message } });
      return route.fulfill({ json: { ok: true, testKind: draft.testKind, apiMode: draft.apiMode, message: `${draft.apiMode === "responses" ? "Responses API" : "Chat Completions"} · ${labels[draft.testKind as ProbeKind]}测试通过。` } });
    }
    if (path === endpoint) {
      if (request.method() === "PUT") {
        const draft = request.postDataJSON(); state.saves.push(draft);
        const settings = personal ? draft.settings : draft;
        state.settings = { ...settings, deepseekSearchEnabled: settings.deepseekSearchEnabled ?? false, hasApiKey: true };
        if (personal) state.acceptsAgentTasks = draft.acceptsAgentTasks;
      }
      return route.fulfill({ json: personal ? { settings: state.settings, acceptsAgentTasks: state.acceptsAgentTasks, tasks: [] } : { settings: state.settings, canEdit: true } });
    }
    if (path.endsWith("/model")) return route.fulfill({ json: { settings: null, canEdit: true } });
    if (path.endsWith("/personal-agent")) return route.fulfill({ json: { settings: null, acceptsAgentTasks: false, tasks: [] } });
    if (path.endsWith("/knowledge")) return route.fulfill({ json: { total: 0, results: [] } });
    if (path.endsWith("/repository")) return route.fulfill({ json: { enabled: false } });
    if (path.endsWith("/executions")) return route.fulfill({ json: { executions: [], skills: [] } });
    if (path.endsWith("/local-runners")) return route.fulfill({ json: { runners: [] } });
    if (path === "/api/me/next-steps") return route.fulfill({ json: { actions: [], warnings: [], generatedAt: "2026-11-11T00:00:00Z" } });
    return route.fulfill({ status: 404, json: { error: "Unexpected capability fixture route" } });
  });
  await page.goto(personal ? `/profile?tab=agent&project=${projectId}` : `/?project=${projectId}`);
  const panel = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: personal ? "个人模型与接收权限" : "模型 API 设置" }) }).first();
  if (!personal) await panel.locator("summary").click();
  await expect(panel.getByLabel("模型 ID", { exact: true })).toHaveValue(state.settings.model);
  return { state, panel };
}

for (const personal of [false, true]) test(`${personal ? "个人" : "项目"}模型按项测试，保留具体失败并使修改后的旧结果失效`, async ({ page }) => {
  const { state, panel } = await modelSettingsPage(page, personal);
  const tests = panel.getByRole("region", { name: "模型能力测试" });
  const rows = tests.getByRole("list", { name: "当前配置的测试结果" });
  const row = (kind: ProbeKind) => rows.locator("li").filter({ hasText: labels[kind] });
  await expect(tests.getByRole("combobox", { name: "测试项目", exact: true })).toHaveValue("connection");
  await expect(tests).toContainText("方案文档生成不可用");
  expect(state.probes).toHaveLength(0);

  await tests.getByRole("button", { name: "测试基础连接", exact: true }).click();
  await expect(row("connection")).toContainText("已通过");
  await expect(row("tools")).toContainText("未测试");
  await expect(row("structured_output")).toContainText("未测试");
  expect(state.probes).toHaveLength(1);
  expect(state.probes[0]).toMatchObject({ testKind: "connection", apiMode: "chat_completions" });
  expect(state.saves).toHaveLength(0);

  state.failure = { kind: "tools", status: 422, message: "Chat Completions · 工具调用：模型服务返回 HTTP 400，未自动重试。" };
  await tests.getByRole("combobox", { name: "测试项目", exact: true }).selectOption("tools");
  await expect(row("connection")).toContainText("已通过");
  await tests.getByRole("button", { name: "测试工具调用", exact: true }).click();
  await expect(row("tools")).toContainText("未通过");
  await expect(row("tools")).toContainText("HTTP 400");
  await expect(row("connection")).toContainText("已通过");
  expect(state.probes).toHaveLength(2);

  await panel.getByRole("combobox", { name: "API 协议", exact: true }).selectOption("responses");
  await expect(rows.getByText("未测试", { exact: true })).toHaveCount(3);
  await expect(tests).not.toContainText("方案文档生成不可用");
  state.failure = { kind: "structured_output", status: 504, message: "Responses API · 结构化输出测试超过 30 秒，未自动重试。" };
  await tests.getByRole("combobox", { name: "测试项目", exact: true }).selectOption("structured_output");
  await tests.getByRole("button", { name: "测试结构化输出", exact: true }).click();
  await expect(row("structured_output")).toContainText("未通过");
  await expect(row("structured_output")).toContainText("超过 30 秒");
  expect(state.probes).toHaveLength(3);
  expect(state.probes.at(-1)).toMatchObject({ testKind: "structured_output", apiMode: "responses" });

  state.failure = null;
  await tests.getByRole("button", { name: "测试结构化输出", exact: true }).click();
  await expect(row("structured_output")).toContainText("已通过");
  await expect(row("connection")).toContainText("未测试");
  expect(state.probes).toHaveLength(4);
  await panel.getByLabel("模型 ID", { exact: true }).fill("fixture-other-model");
  await expect(rows.getByText("未测试", { exact: true })).toHaveCount(3);
  await panel.getByRole("button", { name: personal ? "保存个人设置" : "保存设置", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText(personal ? "个人 Agent 配置已保存" : "项目模型配置已保存");
  expect(state.saves).toHaveLength(1);
  const saved = personal ? state.saves[0].settings : state.saves[0];
  expect(saved).toMatchObject({ apiMode: "responses", model: "fixture-other-model" });
  expect(saved).not.toHaveProperty("testKind");
  expect(saved).not.toHaveProperty("apiKey");
  expect(state.probes).toHaveLength(4);
});

for (const personal of [false, true]) test(`${personal ? "个人" : "项目"}模型明确区分已保存参数与草稿，并保留思考和输出预算`, async ({ page }) => {
  const { state, panel } = await modelSettingsPage(page, personal);
  const summary = panel.getByLabel(personal ? "已保存的个人模型配置" : "已保存的项目模型配置");
  const reasoning = panel.getByRole("combobox", { name: "思考强度", exact: true });
  const budget = panel.getByRole("combobox", { name: "输出预算", exact: true });
  const save = panel.getByRole("button", { name: personal ? "保存个人设置" : "保存设置", exact: true });
  const unsaved = panel.getByRole("status").filter({ hasText: "未保存修改" });
  const tests = panel.getByRole("region", { name: "模型能力测试" });
  const results = tests.getByRole("list", { name: "当前配置的测试结果" });

  // Metadata saved before generation parameters existed uses the new safe defaults.
  await expect(reasoning).toHaveValue("auto");
  await expect(reasoning.locator('option[value="medium"]')).toHaveCount(0);
  await expect(budget).toHaveValue("auto");
  await expect(summary).toContainText("超时 120 秒");
  await expect(summary).toContainText("自动（关闭思考，优先响应）");
  await expect(summary).toContainText("输出上限：自动预算");
  await expect(unsaved).toHaveCount(0);

  await panel.getByRole("spinbutton", { name: "超时（秒）", exact: true }).fill("300");
  await reasoning.selectOption("default");
  await budget.selectOption("custom");
  const tokens = panel.getByRole("spinbutton", { name: "输出上限（tokens，含思考）", exact: true });
  await tokens.fill("16384");
  if (!personal) {
    const search = panel.getByRole("checkbox", { name: /启用 DeepSeek 联网搜索/ });
    await search.check();
    await search.uncheck();
  }
  await expect(unsaved).toBeVisible();
  await expect(summary).toContainText("超时 120 秒");
  await expect(summary).not.toContainText("16,384");
  await expect(tests).toContainText("最多等待 60 秒并使用较小输出预算");
  await tests.getByRole("button", { name: "测试基础连接", exact: true }).click();
  await expect(results).toContainText("已通过");
  expect(state.probes).toHaveLength(1);
  expect(state.probes[0]).toMatchObject({ timeoutSeconds: 300, reasoningEffort: "default", maxOutputTokens: 16384 });
  if (!personal) expect(state.probes[0]).toHaveProperty("deepseekSearchEnabled", false);
  expect(state.saves).toHaveLength(0);
  await expect(unsaved).toBeVisible();

  await reasoning.selectOption("none");
  await expect(results.getByText("未测试", { exact: true })).toHaveCount(3);
  // Browser validation prevents both accidental saves and probes outside the supported range.
  for (const invalid of ["511", "65537"]) {
    await tokens.fill(invalid);
    expect(await tokens.evaluate(input => (input as HTMLInputElement).validity.valid)).toBe(false);
    await save.click();
    expect(state.saves).toHaveLength(0);
  }
  for (const valid of ["512", "65536"]) {
    await tokens.fill(valid);
    expect(await tokens.evaluate(input => (input as HTMLInputElement).validity.valid)).toBe(true);
  }
  await tokens.fill("16384");
  await save.click();
  await expect(panel.getByRole("status")).toContainText(personal ? "个人 Agent 配置已保存" : "项目模型配置已保存");
  expect(state.saves).toHaveLength(1);
  const saved = personal ? state.saves[0].settings : state.saves[0];
  expect(saved).toMatchObject({ timeoutSeconds: 300, reasoningEffort: "none", maxOutputTokens: 16384 });
  if (!personal) expect(saved).toHaveProperty("deepseekSearchEnabled", false);
  await expect(summary).toContainText("超时 300 秒 · 思考：关闭思考 · 输出上限：16,384 tokens（含思考）");
  await expect(unsaved).toHaveCount(0);
  if (personal) await expect(panel).toContainText("项目研究与工作区执行仍使用项目模型设置");
  else await expect(panel).toContainText("已启动或恢复的任务保留原快照");

  await page.reload();
  if (!personal && await panel.getAttribute("open") === null) await panel.locator("summary").click();
  await expect(panel.getByRole("spinbutton", { name: "超时（秒）", exact: true })).toHaveValue("300");
  await expect(reasoning).toHaveValue("none");
  await expect(budget).toHaveValue("custom");
  await expect(tokens).toHaveValue("16384");
  await expect(unsaved).toHaveCount(0);

  // Changing provider never switches protocol or silently changes an explicit effort.
  await panel.getByRole("textbox", { name: /^API Base URL/ }).fill("https://models.example.test/v1");
  await expect(reasoning.locator('option[value="medium"]')).toHaveCount(1);
  await reasoning.selectOption("medium");
  await panel.getByRole("textbox", { name: /^API Base URL/ }).fill("https://api.deepseek.com");
  await expect(reasoning).toHaveValue("medium");
  await expect(reasoning.locator('option[value="medium"]')).toHaveAttribute("disabled", "");
  await expect(panel.getByRole("combobox", { name: "API 协议", exact: true })).toHaveValue("chat_completions");
  await reasoning.selectOption("auto");
  await budget.selectOption("auto");
  await save.click();
  await expect(unsaved).toHaveCount(0);
  expect(state.saves).toHaveLength(2);
  const automatic = personal ? state.saves[1].settings : state.saves[1];
  expect(automatic).toMatchObject({ timeoutSeconds: 300, reasoningEffort: "auto", maxOutputTokens: null });
  await expect(summary).toContainText("输出上限：自动预算");
  expect(state.probes).toHaveLength(1);
});
