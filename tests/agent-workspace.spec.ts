import { test, expect, type Page } from "@playwright/test";
import type { ExecutionView, SkillDescription } from "../lib/workspace-agent/types";
import type { ResearchEvent } from "../lib/types";

// Browser fixtures never contact a database, model provider or real repository.
const skill: SkillDescription = { id: "skill-plan", packageId: "research-fixture", packageTitle: "研究方案", filename: "PLAN.md", version: 3,
  purpose: "实现步骤与验收条件", kind: "workflow", hash: "a".repeat(64), path: `.scenarioforge/skills/${"a".repeat(16)}-PLAN.md` };
type FixtureRunner = { id: string; label: string; online: boolean; lastSeenAt: string | null; workspaceDirectory?: string | null };
const runner: FixtureRunner = { id: "runner-fixture", label: "本机课题项目", online: true, lastSeenAt: "2026-11-10T00:00:00.000Z", workspaceDirectory: "D:\\研究项目\\Node 演示" };
const pairingCode = "f".repeat(72);
type CommandApproval = NonNullable<ExecutionView["commandApprovals"]>[number];
async function workspacePage(page: Page, options: { owner?: boolean; initialStatus?: string; unavailable?: boolean; repositoryEnabled?: boolean; local?: boolean; runners?: FixtureRunner[]; commandApprovals?: CommandApproval[]; createdBy?: string; executionDirectory?: string | null; events?: ResearchEvent[]; executions?: ExecutionView[] } = {}) {
  const snapshot = { id: "research-fixture", title: "研究方案", goal: "生成项目配置", status: "replied", taskState: "idle", currentStage: 0, summary: "方案已就绪。", files: [], filePlan: [], evidence: [], clarifications: [], events: options.events ?? [] };
  const requests: Record<string, unknown>[] = [];
  const runnerRequests: Record<string, unknown>[] = [];
  let runners = options.runners ?? [];
  let run: ExecutionView | null = options.initialStatus ? execution(options.initialStatus, options.local) : null;
  const olderRuns = options.executions ?? [];
  if (run) { run.commandApprovals = options.commandApprovals; run.createdBy = options.createdBy ?? run.createdBy; if (options.executionDirectory !== undefined) run.workspaceDirectory = options.executionDirectory; }
  let downloads = 0;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "user-fixture", username: "fixture" } } });
    if (path === "/api/projects") return route.fulfill({ json: { projects: [{ id: "project-fixture", name: "执行测试项目", inviteCode: "TEST01", role: "owner", memberCount: 1, researchPackages: [{ id: snapshot.id, title: snapshot.title, status: snapshot.status, updatedAt: "2026-11-10T00:00:00.000Z" }] }] } });
    if (path.endsWith("/knowledge")) return route.fulfill({ json: { total: 0, results: [] } });
    if (path.endsWith("/model")) return route.fulfill({ json: { settings: null, canEdit: true } });
    if (path.endsWith("/personal-agent")) return route.fulfill({ json: { settings: null, acceptsAgentTasks: false, tasks: [] } });
    if (path.endsWith("/repository")) return route.fulfill({ json: { enabled: false } });
    if (path === `/api/research/${snapshot.id}`) return route.fulfill({ json: snapshot });
    if (path.includes("/files/")) { downloads++; return route.fulfill({ body: "# Plan" }); }
    if (path.endsWith("/stream")) return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" });
    if (path.endsWith("/local-runners")) {
      const body = route.request().postDataJSON(); runnerRequests.push(body);
      if (body.action === "pair") {
        runners = [...runners, { id: "runner-new", label: body.label, online: false, lastSeenAt: null }];
        return route.fulfill({ status: 201, json: { id: "runner-new", code: pairingCode, expiresAt: "2026-11-10T12:10:00.000Z" } });
      }
      runners = runners.filter(runner => runner.id !== body.runnerId);
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith("/executions")) {
      if (options.unavailable) return route.fulfill({ status: 503, json: { error: "工作区执行功能需要先应用新增数据库迁移。原有研究和文档仍可使用。" } });
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON(); requests.push(body);
        if (body.action === "start") { run = execution("running", body.target === "local"); run.request = body.request; if (body.target === "local") run.workspaceDirectory = runners.find(runner => runner.id === body.runnerId)?.workspaceDirectory ?? null; return route.fulfill({ status: 202, json: { packageId: snapshot.id, execution: run } }); }
        if (body.action === "approve_command" || body.action === "reject_command") {
          const chosen = [run, ...olderRuns].find(item => item?.id === body.executionId);
          if (chosen) chosen.commandApprovals = chosen.commandApprovals?.filter(approval => approval.id !== body.commandId);
          return route.fulfill({ json: { ok: true } });
        }
        const chosen = [run, ...olderRuns].find(item => item?.id === body.executionId);
        if (chosen) chosen.status = body.action === "stop" ? "stopped" : "running";
        return route.fulfill({ json: { ok: true } });
      }
      if (url.searchParams.has("run")) return route.fulfill({ json: url.searchParams.has("file")
        ? { path: "src/config.ts", content: "export const locale = 'zh-CN';", head: "b".repeat(40) }
        : { head: "b".repeat(40), files: [{ path: "src/config.ts", size: 36 }], changedPaths: ["src/config.ts"], diff: "diff --git a/src/config.ts b/src/config.ts\n+export const locale = 'zh-CN';" } });
      return route.fulfill({ json: { executions: [...(run ? [run] : []), ...olderRuns], skills: [skill], repositoryEnabled: options.repositoryEnabled !== false, runners, userId: "user-fixture", owner: options.owner !== false } });
    }
    return route.fulfill({ status: 404, json: { error: "Unexpected fixture API route" } });
  });
  return { requests, runnerRequests, downloads: () => downloads,
    updateRunner(id: string, patch: Partial<FixtureRunner>) { runners = runners.map(item => item.id === id ? { ...item, ...patch } : item); },
    updateProgress(events: ResearchEvent[], status?: string) { snapshot.events = events; if (run && status) run.status = status; } };
}
function execution(status: string, local = false): ExecutionView {
  return { id: "run-fixture", createdBy: local ? "user-fixture" : "another-member", request: "根据方案生成配置并验证", status, branch: "work/member/agent-run-fixture", target: local ? "local" : "github", runnerId: local ? runner.id : null, workspaceDirectory: local ? runner.workspaceDirectory : null, head: "b".repeat(40), attempts: 1, skills: [skill],
    summary: "文件已生成。", error: null, verification: [{ head: "b".repeat(40), kind: "syntax", status: "passed", output: "只检查静态语法，不代表测试通过。" },
      { head: "b".repeat(40), kind: "command", command: ["node", "--test"], status: "unavailable", output: "命令未执行：隔离容器尚未就绪。" }], createdAt: "2026-11-10T00:00:00.000Z" };
}

test("研究技能默认传入执行，无需下载；可审查真实文件、区分验证结果并停止恢复", async ({ page }) => {
  const fixture = await workspacePage(page);
  await page.goto("/?project=project-fixture&package=research-fixture");
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  const panel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  await panel.locator("summary").filter({ hasText: "项目技能文件" }).click();
  await expect(panel.getByRole("checkbox", { name: /PLAN.md/ })).toBeChecked();
  await expect(panel.getByRole("link", { name: "浏览原文" })).toHaveAttribute("href", /package=research-fixture&file=PLAN.md/);
  await expect(panel.getByRole("link", { name: "下载", exact: true })).toHaveAttribute("href", /PLAN.md\?download=1/);
  await panel.getByRole("textbox", { name: "工作区执行要求" }).fill("根据方案生成配置并验证");
  await panel.getByRole("button", { name: "开始执行", exact: true }).click();
  await expect(panel.getByText("正在执行", { exact: true })).toBeVisible();
  expect(fixture.requests[0]).toEqual({ action: "start", request: "根据方案生成配置并验证", packageId: "research-fixture", skillIds: [skill.id], target: "github" });
  expect(fixture.downloads()).toBe(0);
  await expect(panel.getByText("技能：PLAN.md v3", { exact: true })).toBeVisible();
  await expect(panel.getByText("静态语法检查 · 通过", { exact: true })).toBeVisible();
  await expect(panel.getByText("命令：node --test · 未完成验证", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "查看文件与差异" }).click();
  await expect(panel.locator("pre").filter({ hasText: "diff --git" })).toBeVisible();
  await panel.getByRole("combobox", { name: "任务分支文件" }).selectOption("src/config.ts");
  await expect(panel.locator("pre").filter({ hasText: /^export const locale/ })).toBeVisible();
  await panel.getByRole("button", { name: "停止任务", exact: true }).click();
  await expect(panel.getByText("已停止", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "从原分支继续", exact: true }).click();
  await expect(panel.getByText("正在执行", { exact: true })).toBeVisible();
  expect(fixture.requests.slice(1)).toEqual([{ action: "stop", executionId: "run-fixture" }, { action: "resume", executionId: "run-fixture" }]);
});

test("本机命令按原始参数展示并单次批准，不受当前工作方式选项影响", async ({ page }) => {
  const approval: CommandApproval = { id: "command-approve", head: "c".repeat(40),
    command: ["node", "tests/example.mjs", "argument with spaces", "literal && echo unchanged"], expiresAt: new Date(Date.now() + 120_000).toISOString() };
  const fixture = await workspacePage(page, { local: true, initialStatus: "running", runners: [runner], commandApprovals: [approval] });
  await page.goto("/?project=project-fixture&package=research-fixture");
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  const panel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  await expect(panel.getByRole("radio", { name: "GitHub 仓库", exact: true })).toBeChecked();
  const command = panel.getByRole("group", { name: "待审批的本机命令", exact: true });
  await expect(command.getByLabel("命令参数", { exact: true })).toHaveText(JSON.stringify(approval.command, null, 2));
  await expect(command).toContainText("本机 Docker 的无网络临时容器");
  await expect(command).toContainText("只能读取已导出的安全文件快照");
  await expect(command).toContainText("输出会经过 ScenarioForge 服务端并发送给模型");
  await expect(command).toContainText(approval.head);
  await command.getByRole("button", { name: "批准本次命令", exact: true }).click();
  await expect(command).toHaveCount(0);
  expect(fixture.requests).toEqual([{ action: "approve_command", executionId: "run-fixture", commandId: approval.id }]);
});

test("拒绝本机命令仅提交审批标识，刷新后移除等待卡片", async ({ page }) => {
  const approval: CommandApproval = { id: "command-reject", head: "b".repeat(40), command: ["node", "--test"], expiresAt: new Date(Date.now() + 120_000).toISOString() };
  const fixture = await workspacePage(page, { local: true, initialStatus: "running", runners: [runner], commandApprovals: [approval] });
  await page.goto("/?project=project-fixture&package=research-fixture");
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  const panel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  const command = panel.getByRole("group", { name: "待审批的本机命令", exact: true });
  await command.getByRole("button", { name: "拒绝执行", exact: true }).click();
  await expect(command).toHaveCount(0);
  await expect(panel.getByText("正在执行", { exact: true })).toBeVisible();
  expect(fixture.requests).toEqual([{ action: "reject_command", executionId: "run-fixture", commandId: approval.id }]);
});

test("本机命令审批过期后即使仍在页面中也不能批准或拒绝", async ({ page }) => {
  const now = new Date();
  await page.clock.install({ time: now });
  const approval: CommandApproval = { id: "command-expired", head: "b".repeat(40), command: ["node", "--test"], expiresAt: new Date(now.getTime() + 120_000).toISOString() };
  const fixture = await workspacePage(page, { local: true, initialStatus: "running", runners: [runner], commandApprovals: [approval] });
  await page.goto("/?project=project-fixture&package=research-fixture");
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  const command = page.getByRole("group", { name: "待审批的本机命令", exact: true });
  await expect(command.getByRole("button", { name: "批准本次命令", exact: true })).toBeEnabled();
  await page.clock.fastForward(121_000);
  await expect(command).toContainText("审批已过期，请等待任务更新。");
  await expect(command.getByRole("button", { name: "批准本次命令", exact: true })).toBeDisabled();
  await expect(command.getByRole("button", { name: "拒绝执行", exact: true })).toBeDisabled();
  expect(fixture.requests).toHaveLength(0);
});

test("项目所有者也不能批准其他成员的本机命令", async ({ page }) => {
  const approval: CommandApproval = { id: "command-other-member", head: "b".repeat(40), command: ["node", "--test"], expiresAt: new Date(Date.now() + 120_000).toISOString() };
  const fixture = await workspacePage(page, { owner: true, local: true, initialStatus: "running", createdBy: "another-member", commandApprovals: [approval] });
  await page.goto("/?project=project-fixture&package=research-fixture");
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  const panel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  await expect(panel.getByText("正在执行", { exact: true })).toBeVisible();
  await expect(panel.getByRole("group", { name: "待审批的本机命令", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "批准本次命令", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "拒绝执行", exact: true })).toHaveCount(0);
  expect(fixture.requests).toHaveLength(0);
});

test("没有研究对话时也可选择项目技能并直接启动执行", async ({ page }) => {
  const fixture = await workspacePage(page);
  await page.goto("/?project=project-fixture");
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  const panel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  await panel.locator("summary").filter({ hasText: "项目技能文件" }).click();
  const choice = panel.getByRole("checkbox", { name: /PLAN.md/ });
  await expect(choice).not.toBeChecked();
  await choice.check();
  await panel.getByRole("textbox", { name: "工作区执行要求" }).fill("直接实现配置");
  await panel.getByRole("button", { name: "开始执行", exact: true }).click();
  await expect(page).toHaveURL(/package=research-fixture/);
  await expect(panel.getByText("正在执行", { exact: true })).toBeVisible();
  expect(fixture.requests[0]).toEqual({ action: "start", request: "直接实现配置", skillIds: [skill.id], target: "github" });
});

test("普通成员可以查看其他成员执行，但无法停止或恢复", async ({ page }) => {
  await workspacePage(page, { owner: false, initialStatus: "running" });
  await page.goto("/?project=project-fixture&package=research-fixture");
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  const panel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  await expect(panel.getByText("正在执行", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "停止任务" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "从原分支继续" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "查看文件与差异" })).toBeEnabled();
});

test("数据库功能未启用时解释原因并阻止提交，研究对话仍可用", async ({ page }) => {
  await workspacePage(page, { unavailable: true });
  await page.goto("/?project=project-fixture&package=research-fixture");
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  const panel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  await expect(panel.getByRole("alert")).toContainText("需要先应用新增数据库迁移");
  await panel.getByRole("textbox", { name: "工作区执行要求" }).fill("生成配置");
  await expect(panel.getByRole("button", { name: "开始执行", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: "方案与文档", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "继续与 Agent 对话" })).toBeEnabled();
});

test("本地模式无需服务器 Git 仓库，传递连接与技能并在原目录继续", async ({ page }) => {
  const fixture = await workspacePage(page, { repositoryEnabled: false, runners: [runner] });
  await page.goto("/?project=project-fixture&package=research-fixture");
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  const panel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  await panel.getByRole("radio", { name: "本地工作区", exact: true }).check();
  await expect(panel.getByRole("combobox", { name: "本地工作区连接" })).toHaveValue(runner.id);
  await expect(panel.getByText("Runner 已连接，可以开始任务。", { exact: true })).toBeVisible();
  await panel.locator("summary").filter({ hasText: "连接与运行设置" }).click();
  await expect(panel.getByText(/Agent 读取的文件内容会经过 ScenarioForge 服务器和模型供应商/)).toBeVisible();
  await panel.getByRole("textbox", { name: "工作区执行要求" }).fill("根据技能修改本机项目");
  await panel.getByRole("button", { name: "开始执行", exact: true }).click();
  await expect(panel.getByText("正在执行", { exact: true })).toBeVisible();
  expect(fixture.requests[0]).toEqual({ action: "start", request: "根据技能修改本机项目", packageId: "research-fixture", skillIds: [skill.id], target: "local", runnerId: runner.id });
  expect(fixture.downloads()).toBe(0);
  await expect(panel.getByText("本地工作区 · 本机课题项目", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "停止任务", exact: true }).click();
  await expect(panel.getByText("已停止", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "在原本地目录继续", exact: true }).click();
  await expect(panel.getByText("正在执行", { exact: true })).toBeVisible();
});

test("本地配对显示一次性命令，离线连接阻止执行并可撤销", async ({ page }) => {
  const fixture = await workspacePage(page, { repositoryEnabled: false });
  await page.goto("/?project=project-fixture&package=research-fixture");
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  const panel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  await panel.getByRole("radio", { name: "本地工作区", exact: true }).check();
  await panel.getByRole("textbox", { name: "工作区执行要求" }).fill("生成本地文件");
  await expect(panel.getByRole("button", { name: "开始执行", exact: true })).toBeDisabled();
  await panel.locator("summary").filter({ hasText: "连接与运行设置" }).click();
  await panel.locator("summary").filter({ hasText: "连接新的本地目录" }).click();
  await panel.getByRole("textbox", { name: "本地连接名称" }).fill("实验室电脑");
  await panel.getByRole("button", { name: "生成配对码", exact: true }).click();
  await expect(panel.locator("pre").filter({ hasText: pairingCode })).toContainText('scripts/scenarioforge-local-runner.mjs pair --url');
  await expect(panel.locator("pre").filter({ hasText: pairingCode })).toContainText('--directory "D:\\your-project"');
  await expect(panel.locator("pre").filter({ hasText: pairingCode })).toContainText("scripts/scenarioforge-local-runner.mjs run");
  expect(fixture.runnerRequests[0]).toEqual({ action: "pair", label: "实验室电脑" });
  await expect(panel.getByRole("combobox", { name: "本地工作区连接" })).toHaveValue("runner-new");
  await expect(panel.getByText(/Runner 当前离线/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "开始执行", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "撤销连接", exact: true }).click();
  await expect(panel.getByRole("combobox", { name: "本地工作区连接" })).toHaveValue("");
  await expect(panel.locator("pre").filter({ hasText: pairingCode })).toHaveCount(0);
  expect(fixture.runnerRequests[1]).toEqual({ action: "revoke", runnerId: "runner-new" });
  expect(fixture.requests).toHaveLength(0);
});

test("本地 Runner 离线仍能审查保存的差异和文件快照", async ({ page }) => {
  await workspacePage(page, { repositoryEnabled: false, local: true, initialStatus: "review", runners: [{ ...runner, online: false }] });
  await page.goto("/?project=project-fixture&package=research-fixture");
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  const panel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  await panel.getByRole("radio", { name: "本地工作区", exact: true }).check();
  await expect(panel.getByRole("button", { name: "在原本地目录继续", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "查看文件与差异", exact: true }).click();
  await expect(panel.locator("pre").filter({ hasText: "diff --git" })).toBeVisible();
  await panel.getByRole("combobox", { name: "任务变更文件" }).selectOption("src/config.ts");
  await expect(panel.locator("pre").filter({ hasText: /^export const locale/ })).toBeVisible();
  await expect(panel.getByText(/任务保存的文件快照：/)).toBeVisible();
  await expect(panel.getByText(/请在本机查看当前文件，并决定是否提交或推送/)).toBeVisible();
  await expect(panel.getByRole("combobox", { name: "任务分支文件" })).toHaveCount(0);
});

test("显示选中连接的实际目录，历史任务保留执行目录，支持展开和复制", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    writeText: async (text: string) => { document.documentElement.dataset.copiedDirectory = text; },
  } }));
  const currentDirectory = "D:\\研究材料\\正在使用的新目录\\" + "较长的目录名称".repeat(16);
  const previousDirectory = "D:\\此前任务\\保留的执行目录";
  await workspacePage(page, { local: true, initialStatus: "review", runners: [{ ...runner, workspaceDirectory: currentDirectory }], executionDirectory: previousDirectory });
  await page.goto("/?project=project-fixture&package=research-fixture");
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  const panel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  await panel.getByRole("radio", { name: "本地工作区", exact: true }).check();
  const connected = panel.getByRole("group", { name: "当前连接目录", exact: true });
  const historical = panel.getByRole("group", { name: "本次执行目录", exact: true });
  await expect(connected.getByTitle(currentDirectory)).toHaveText(currentDirectory);
  await expect(historical.getByTitle(previousDirectory)).toHaveText(previousDirectory);
  await connected.getByRole("button", { name: "展开完整目录", exact: true }).click();
  await expect(connected.getByRole("button", { name: "收起目录", exact: true })).toHaveAttribute("aria-expanded", "true");
  await connected.getByRole("button", { name: "复制目录", exact: true }).click();
  await expect(connected.getByRole("status")).toHaveText("目录已复制");
  expect(await page.evaluate(() => document.documentElement.dataset.copiedDirectory)).toBe(currentDirectory);
  await panel.screenshot({ path: ".tmp/workspace-progress-ui-20261111/desktop-directories.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await panel.screenshot({ path: ".tmp/workspace-progress-ui-20261111/mobile-directories.png" });
});

test("未上报和旧任务目录保持未知，复制失败时展示完整路径供手动复制", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    writeText: async () => { throw new Error("clipboard unavailable"); },
  } }));
  await workspacePage(page, { local: true, initialStatus: "review", runners: [runner, { id: "runner-legacy", label: "旧版连接", online: true, lastSeenAt: runner.lastSeenAt }], executionDirectory: null });
  await page.goto("/?project=project-fixture&package=research-fixture");
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  const panel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  await panel.getByRole("radio", { name: "本地工作区", exact: true }).check();
  const connected = panel.getByRole("group", { name: "当前连接目录", exact: true });
  const historical = panel.getByRole("group", { name: "本次执行目录", exact: true });
  await expect(historical).toContainText("此历史任务未记录执行目录。");
  await expect(historical).not.toContainText(runner.workspaceDirectory!);
  await connected.getByRole("button", { name: "复制目录", exact: true }).click();
  await expect(connected.getByRole("status")).toHaveText("无法自动复制，请选中完整目录复制。");
  await expect(connected.getByRole("button", { name: "收起目录", exact: true })).toBeVisible();
  await panel.getByRole("combobox", { name: "本地工作区连接", exact: true }).selectOption("runner-legacy");
  await expect(connected).toContainText("目录尚未上报，请重启 Runner。");
  await expect(connected.getByRole("button", { name: "复制目录", exact: true })).toHaveCount(0);
});

function operationEvent(sequence: number, message: string, progress?: Record<string, unknown>, executionId = "run-fixture"): ResearchEvent {
  return { id: `progress-${sequence}`, sequence, type: "execution_progress", message,
    payload: { executionId, ...(progress ? { progress } : {}) }, createdAt: new Date(Date.UTC(2026, 10, 11, 4, 0, sequence)).toISOString() };
}

test("执行进度合并操作前后事件，显示技能、文件、耗时并实时切换当前步骤", async ({ page }) => {
  const events = [
    operationEvent(1, "开始浏览工作区", { operationId: "list-1", phase: "started", action: "list_workspace" }),
    operationEvent(2, "已浏览工作区：发现 8 个文件", { operationId: "list-1", phase: "completed", action: "list_workspace", fileCount: 8, durationMs: 125 }),
    operationEvent(3, "已读取 PLAN.md v3", { operationId: "skill-1", phase: "completed", action: "read_skill", skill: { filename: "PLAN.md", version: 3 }, durationMs: 5 }),
    operationEvent(4, "已保存 2 个文件", { operationId: "write-1", phase: "completed", action: "apply_changes", paths: ["src/add.mjs", "tests/add.test.mjs"], fileCount: 2, durationMs: 1560 }),
    operationEvent(5, "等待模型响应", { operationId: "model-2", phase: "waiting", action: "model_wait" }),
    operationEvent(6, "另一个任务的私有操作", { operationId: "other-run", phase: "started", action: "read_file" }, "other-run"),
  ];
  const fixture = await workspacePage(page, { local: true, initialStatus: "running", runners: [runner], events });
  await page.goto("/?project=project-fixture&package=research-fixture");
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  const panel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  const timeline = panel.getByRole("list", { name: "执行任务进度", exact: true });
  await expect(panel.getByLabel("当前执行步骤", { exact: true })).toContainText("等待模型响应");
  await expect(timeline.locator(":scope > li")).toHaveCount(4);
  await expect(timeline).not.toContainText("开始浏览工作区");
  await expect(panel).not.toContainText("另一个任务的私有操作");
  const write = timeline.locator(":scope > li").filter({ hasText: "已保存 2 个文件" });
  await expect(write).toContainText("耗时 1.6 秒");
  await write.locator("summary").filter({ hasText: "操作详情" }).click();
  await expect(write.getByRole("list", { name: "操作文件", exact: true })).toContainText("src/add.mjs");
  await expect(write.getByRole("list", { name: "操作文件", exact: true })).toContainText("tests/add.test.mjs");
  const loadedSkill = timeline.locator(":scope > li").filter({ hasText: "已读取 PLAN.md v3" });
  await loadedSkill.locator("summary").filter({ hasText: "操作详情" }).click();
  await expect(loadedSkill).toContainText("技能：PLAN.md v3");
  await panel.screenshot({ path: ".tmp/workspace-progress-ui-20261111/detailed-progress.png" });
  fixture.updateProgress([...events, operationEvent(7, "正在读取 src/add.mjs", { operationId: "read-1", phase: "started", action: "read_file", paths: ["src/add.mjs"] })]);
  await page.reload();
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  await expect(panel.getByLabel("当前执行步骤", { exact: true })).toContainText("正在读取 src/add.mjs");
  fixture.updateProgress([...events,
    operationEvent(7, "正在读取 src/add.mjs", { operationId: "read-1", phase: "started", action: "read_file", paths: ["src/add.mjs"] }),
    { ...operationEvent(8, "此前尝试已中断"), type: "execution_failed" },
    { ...operationEvent(9, "从原目录继续执行"), type: "execution_queued" },
    operationEvent(10, "等待恢复后的模型响应", { operationId: "model-resume", phase: "waiting", action: "model_wait" }),
  ]);
  await page.reload();
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  await expect(panel.getByLabel("当前执行步骤", { exact: true })).toContainText("等待恢复后的模型响应");
  await expect(timeline.locator(":scope > li").filter({ hasText: "正在读取 src/add.mjs" })).toContainText("未记录完成");
});

test("待审批优先于执行中，未执行命令显示真实结果，终态不保留旧等待提示", async ({ page }) => {
  const command = ["node", "--test", "tests/add.test.mjs"];
  const approval: CommandApproval = { id: "command-progress", command, head: "b".repeat(40), expiresAt: new Date(Date.now() + 120_000).toISOString() };
  const events = [operationEvent(1, "准备请求测试命令", { operationId: "command-1", phase: "waiting", action: "run_command", command })];
  const fixture = await workspacePage(page, { local: true, initialStatus: "running", runners: [runner], commandApprovals: [approval], events });
  await page.goto("/?project=project-fixture&package=research-fixture");
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  const panel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  await expect(panel.getByLabel("当前执行步骤", { exact: true })).toContainText("等待你批准本机命令");
  await panel.getByRole("group", { name: "待审批的本机命令", exact: true }).getByRole("button", { name: "拒绝执行", exact: true }).click();
  fixture.updateProgress([...events, operationEvent(2, "命令未执行：用户已拒绝本次命令", { operationId: "command-1", phase: "completed", action: "run_command", command, status: "unavailable", durationMs: 1500 })]);
  await page.reload();
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  const timeline = panel.getByRole("list", { name: "执行任务进度", exact: true });
  await expect(timeline.locator(":scope > li")).toHaveCount(1);
  await expect(timeline).toContainText("未执行");
  await expect(panel.getByLabel("当前执行步骤", { exact: true })).toContainText("命令未执行：用户已拒绝本次命令");
  await timeline.locator("summary").filter({ hasText: "操作详情" }).click();
  await expect(timeline.getByLabel("操作命令参数", { exact: true })).toHaveText(JSON.stringify(command, null, 2));
  fixture.updateProgress([...events], "review");
  await page.reload();
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  await expect(panel.getByLabel("当前执行步骤", { exact: true })).toContainText("本轮结束，等待人工验证。");
  await expect(panel.getByLabel("当前执行步骤", { exact: true })).not.toContainText("准备请求");
  await panel.locator("summary").filter({ hasText: "执行进度" }).click();
  await expect(timeline).toContainText("未记录完成");
});

test("两个页签支持键盘切换，执行草稿、技能、连接和差异在往返后保持", async ({ page }) => {
  const secondRunner = { ...runner, id: "runner-second", label: "第二个目录", workspaceDirectory: "D:\\演示项目\\second" };
  const fixture = await workspacePage(page, { local: true, initialStatus: "review", runners: [runner, secondRunner] });
  await page.goto("/?project=project-fixture&package=research-fixture");
  const schemeTab = page.getByRole("tab", { name: "方案与文档", exact: true });
  const executionTab = page.getByRole("tab", { name: "执行工作区", exact: true });
  const panel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  await expect(schemeTab).toHaveAttribute("aria-selected", "true");
  await expect(panel).not.toBeVisible();
  const discussion = page.getByRole("textbox", { name: "继续与 Agent 对话", exact: true });
  await discussion.fill("方案页尚未提交的想法");
  await schemeTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(executionTab).toBeFocused();
  await expect(executionTab).toHaveAttribute("aria-selected", "true");
  await expect(panel).toBeVisible();
  await expect(discussion).not.toBeVisible();
  await panel.getByRole("radio", { name: "本地工作区", exact: true }).check();
  await panel.getByRole("combobox", { name: "本地工作区连接", exact: true }).selectOption(secondRunner.id);
  await panel.locator("summary").filter({ hasText: "项目技能文件" }).click();
  const selectedSkill = panel.getByRole("checkbox", { name: /PLAN.md/ });
  await selectedSkill.uncheck();
  const requirement = panel.getByRole("textbox", { name: "工作区执行要求", exact: true });
  await requirement.fill("执行页尚未提交的任务");
  await panel.getByRole("button", { name: "查看文件与差异", exact: true }).click();
  await panel.getByRole("combobox", { name: "任务变更文件", exact: true }).selectOption("src/config.ts");
  await expect(panel.locator("pre").filter({ hasText: /^export const locale/ })).toBeVisible();
  await schemeTab.click();
  await expect(discussion).toHaveValue("方案页尚未提交的想法");
  await executionTab.click();
  await expect(requirement).toHaveValue("执行页尚未提交的任务");
  await expect(selectedSkill).not.toBeChecked();
  await expect(panel.getByRole("radio", { name: "本地工作区", exact: true })).toBeChecked();
  await expect(panel.getByRole("combobox", { name: "本地工作区连接", exact: true })).toHaveValue(secondRunner.id);
  await expect(panel.getByRole("combobox", { name: "任务变更文件", exact: true })).toHaveValue("src/config.ts");
  await expect(panel.locator("pre").filter({ hasText: /^export const locale/ })).toBeVisible();
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.runnerRequests).toHaveLength(0);
});

test("历史任务默认收起，所有活跃任务的审批保持可见，展开后仍可审查和恢复", async ({ page }) => {
  const approval = (id: string): CommandApproval => ({ id, head: "b".repeat(40), command: ["node", "--test"], expiresAt: new Date(Date.now() + 120_000).toISOString() });
  const activeSecond = { ...execution("running", true), id: "run-second", request: "另一项活跃任务", commandApprovals: [approval("command-second")] };
  const old = { ...execution("review", true), id: "run-old", request: "历史待审查任务", createdAt: "2026-11-09T00:00:00.000Z" };
  const fixture = await workspacePage(page, { local: true, initialStatus: "running", runners: [runner], commandApprovals: [approval("command-current")], executions: [activeSecond, old] });
  await page.goto("/?project=project-fixture&package=research-fixture");
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  const panel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  const current = panel.getByRole("region", { name: "当前执行任务", exact: true });
  const historical = panel.locator('details[aria-label="历史执行任务"]');
  const oldArticle = panel.locator('[data-execution-id="run-old"]');
  await expect(current.getByRole("group", { name: "待审批的本机命令", exact: true })).toHaveCount(2);
  await expect(current.getByRole("button", { name: "批准本次命令", exact: true })).toHaveCount(2);
  await expect(historical).not.toHaveAttribute("open", "");
  await expect(oldArticle).not.toBeVisible();
  await historical.locator(":scope > summary").click();
  await expect(oldArticle).toBeVisible();
  await oldArticle.getByRole("button", { name: "查看文件与差异", exact: true }).click();
  await expect(oldArticle.locator("pre").filter({ hasText: "diff --git" })).toBeVisible();
  await page.getByRole("tab", { name: "方案与文档", exact: true }).click();
  await page.getByRole("tab", { name: "执行工作区", exact: true }).click();
  await expect(historical).toHaveAttribute("open", "");
  await expect(oldArticle.locator("pre").filter({ hasText: "diff --git" })).toBeVisible();
  expect(fixture.requests).toHaveLength(0);
  await current.locator('[data-execution-id="run-fixture"]').getByRole("button", { name: "停止任务", exact: true }).click();
  await current.locator('[data-execution-id="run-second"]').getByRole("button", { name: "停止任务", exact: true }).click();
  await historical.locator('[data-execution-id="run-old"]').getByRole("button", { name: "在原本地目录继续", exact: true }).click();
  await expect(current.locator('[data-execution-id="run-old"]')).toBeVisible();
  expect(fixture.requests.at(-1)).toEqual({ action: "resume", executionId: "run-old" });
});

test("顶部连接随目录选择和后台心跳更新，研究页也能直接进入待审批任务", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    writeText: async (text: string) => { document.documentElement.dataset.copiedDirectory = text; },
  } }));
  const secondRunner = { ...runner, id: "runner-second", label: "第二个工作区", workspaceDirectory: "D:\\独立演示\\第二个目录" };
  const approval: CommandApproval = { id: "command-header", head: "b".repeat(40), command: ["node", "--test"], expiresAt: new Date(Date.now() + 120_000).toISOString() };
  const fixture = await workspacePage(page, { local: true, initialStatus: "running", runners: [runner, secondRunner], commandApprovals: [approval] });
  await page.goto("/?project=project-fixture&package=research-fixture");
  const navigation = page.locator('header[aria-label="项目工作区导航"]');
  const connection = navigation.getByRole("group", { name: "工作区连接概况", exact: true });
  await expect(navigation.getByRole("button", { name: "查看待审批命令", exact: true })).toBeVisible();
  await navigation.getByRole("button", { name: "查看待审批命令", exact: true }).click();
  const panel = page.getByRole("region", { name: "Agent 执行工作区", exact: true });
  await expect(panel.getByRole("group", { name: "待审批的本机命令", exact: true })).toBeVisible();
  await panel.getByRole("radio", { name: "本地工作区", exact: true }).check();
  await expect(connection).toContainText("本机课题项目 · Runner 在线");
  await expect(connection.getByTitle(runner.workspaceDirectory!)).toBeVisible();
  await panel.getByRole("combobox", { name: "本地工作区连接", exact: true }).selectOption(secondRunner.id);
  await expect(connection).toContainText("第二个工作区 · Runner 在线");
  await expect(connection.getByTitle(secondRunner.workspaceDirectory)).toHaveText(secondRunner.workspaceDirectory);
  await connection.getByRole("button", { name: "复制当前连接目录", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.dataset.copiedDirectory)).toBe(secondRunner.workspaceDirectory);
  await page.getByRole("tab", { name: "方案与文档", exact: true }).click();
  fixture.updateRunner(secondRunner.id, { online: false });
  await expect(connection).toContainText("第二个工作区 · Runner 离线", { timeout: 10_000 });
  await expect(connection.getByTitle(secondRunner.workspaceDirectory)).toBeVisible();
  await expect(panel).not.toBeVisible();
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.runnerRequests).toHaveLength(0);
});
