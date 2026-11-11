import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page, owner = false) {
  const task = { id: "task-a", objective: "交互验收任务", context: "虚拟演示条件", status: owner ? "submitted" : "review", result: "初稿验收点", conversation: [{ role: "assistant", content: "初稿验收点" }], revision: 0, canRecover: false, error: null, modelRequests: 1, inputTokens: 30, outputTokens: 20, createdAt: "2026-11-08T08:00:00Z", package: { id: "pkg-a", title: "交互测试" } };
  const state = { messages: 0, submissions: 0, merges: 0, pushes: 0, submitted: "", remoteUrl: "", remote: { configured: false, publicKey: "", checkedAt: null as string | null, head: null as string | null } };
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "member", username: owner ? "owner" : "member" } } });
    if (path === "/api/projects") return route.fulfill({ json: { projects: [{ id: "project-a", name: "交互测试项目", inviteCode: "TEST01", role: owner ? "owner" : "member", memberCount: 2, researchPackages: [] }] } });
    if (path.endsWith("/model")) return route.fulfill({ json: { settings: null, canEdit: owner } });
    if (path.endsWith("/knowledge")) return route.fulfill({ json: { total: 0, results: [] } });
    if (path.endsWith("/personal-agent")) return route.fulfill({ json: { settings: { baseUrl: "https://example.com/v1", model: "fixture", apiMode: "chat_completions", timeoutSeconds: 120, hasApiKey: true }, acceptsAgentTasks: true, tasks: [task] } });
    if (path.endsWith("/tasks/task-a")) {
      const body = request.postDataJSON();
      if (body.action === "message") {
        state.messages++; expect(body.message).toBe("只在个人对话补充一个检查点");
        task.conversation.push({ role: "user", content: body.message }, { role: "assistant", content: "修订后的验收点" }); task.result = "修订后的验收点"; task.revision++; task.modelRequests++;
      } else { state.submissions++; state.submitted = body.result; task.result = body.result; task.status = "submitted"; task.revision++; expect(body).not.toHaveProperty("conversation"); }
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith("/repository")) {
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        if (body.action === "connect") state.remoteUrl = body.url;
        else if (body.action === "key") { state.remote.configured = true; state.remote.publicKey = "ssh-ed25519 fixture-public-key"; }
        else if (body.action === "check") state.remote.checkedAt = "2026-11-08T10:00:00Z";
        else if (body.action === "push") { expect(body).toEqual({ action: "push", head: "a".repeat(40), remoteHead: null }); state.pushes++; state.remote.head = body.head; }
        else { expect(body).toEqual({ action: "merge", taskId: "task-a", head: "a".repeat(40), commit: "b".repeat(40) }); state.merges++; }
        return route.fulfill({ json: { ok: true } });
      }
      if (url.searchParams.has("task")) return route.fulfill({ json: { taskId: "task-a", head: "a".repeat(40), commit: "b".repeat(40), merged: false, diff: "+ 成员确认的交付文档" } });
      return route.fulfill({ json: owner ? { enabled: true, remoteUrl: state.remoteUrl, remote: state.remote, head: "a".repeat(40), files: ["README.md"], tasks: [{ id: "task-a", objective: "交互验收任务", assigneeName: "member", mine: false, git: { branch: "task/task-a", commit: "b".repeat(40), merged: state.merges > 0 } }] } : { enabled: false } });
    }
    return route.fulfill({ status: 404, json: { error: "Unexpected fixture route" } });
  });
  await page.goto("/?project=project-a");
  return state;
}

test("成员私有追问、编辑交付并确认提交，刷新保留状态", async ({ page }) => {
  const state = await setup(page);
  const inbox = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: "个人 Agent 与任务收件箱" }) }).first();
  await expect(inbox).not.toHaveAttribute("open");
  await inbox.locator("summary").first().click();
  await expect(page.getByText("待你确认提交", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "补充要求或追问" }).fill("只在个人对话补充一个检查点");
  await page.getByRole("button", { name: "发送给个人 Agent" }).click();
  await expect(page.getByRole("textbox", { name: "待提交的交付内容" })).toHaveValue("修订后的验收点");
  expect(state.submissions).toBe(0);
  await page.getByRole("textbox", { name: "待提交的交付内容" }).fill("成员亲自确认的交付");
  await page.screenshot({ path: ".tmp/preview/personal-task-interaction.png", fullPage: true });
  await page.getByRole("button", { name: "确认提交给团队" }).click();
  await expect(page.getByText("已提交团队", { exact: true })).toBeVisible();
  expect(state).toMatchObject({ messages: 1, submissions: 1, submitted: "成员亲自确认的交付" });
  await page.reload();
  await inbox.locator("summary").first().click();
  await expect(page.getByRole("link", { name: "查看团队审核对话" })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认提交给团队" })).toHaveCount(0);
});

test("哈希目标在隐藏页签内时只切换一次，异步显露后展开并聚焦", async ({ page }) => {
  await setup(page);
  await expect(page.getByRole("tab", { name: "方案与文档", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const fixture = document.createElement("section");
    fixture.id = "async-target-fixture";
    fixture.dataset.clicks = "0";
    fixture.innerHTML = `<div role="tablist" aria-label="异步定位夹具">
      <button type="button" role="tab" id="async-research-tab" aria-controls="async-research-panel" aria-selected="false">异步研究页签</button>
      <button type="button" role="tab" id="async-execution-tab" aria-controls="async-execution-panel" aria-selected="true">异步执行页签</button>
    </div>
    <div role="tabpanel" id="async-research-panel" aria-labelledby="async-research-tab" hidden>
      <details><summary>异步研究详情</summary><p id="research-reply-async-target">定位到此研究回复</p></details>
    </div>
    <div role="tabpanel" id="async-execution-panel" aria-labelledby="async-execution-tab">等待切换</div>`;
    document.body.append(fixture);
    const tab = document.getElementById("async-research-tab")!;
    tab.addEventListener("click", () => {
      fixture.dataset.clicks = String(Number(fixture.dataset.clicks) + 1);
      // A real tab may reveal its panel after a state/render boundary.
      window.setTimeout(() => {
        tab.setAttribute("aria-selected", "true");
        document.getElementById("async-execution-tab")!.setAttribute("aria-selected", "false");
        document.getElementById("async-research-panel")!.removeAttribute("hidden");
        document.getElementById("async-execution-panel")!.setAttribute("hidden", "");
      }, 30);
    });
    window.location.hash = "research-reply-async-target";
  });
  await expect(page.locator("#research-reply-async-target")).toBeFocused();
  await expect(page.locator("#research-reply-async-target")).toBeInViewport();
  await expect(page.locator("#async-research-panel details")).toHaveAttribute("open");
  await expect(page.locator("#async-target-fixture")).toHaveAttribute("data-clicks", "1");
});

test("组长先查看 Git 差异，再确认合并", async ({ page }) => {
  const state = await setup(page, true);
  await page.locator("summary").filter({ hasText: "团队 Git 工作区" }).click();
  await expect(page.getByRole("button", { name: "确认将此差异合并到 main" })).toHaveCount(0);
  await page.getByRole("button", { name: "查看差异" }).click();
  await expect(page.getByText("+ 成员确认的交付文档", { exact: true })).toBeVisible();
  expect(state.merges).toBe(0);
  await page.getByRole("button", { name: "确认将此差异合并到 main" }).click();
  expect(state.merges).toBe(1);
  await expect(page.getByText(/已合并$/)).toBeVisible();
});

test("关联 GitHub 后明确显示尚未推送", async ({ page }) => {
  const state = await setup(page, true);
  await page.locator("summary").filter({ hasText: "团队 Git 工作区" }).click();
  await page.getByRole("textbox", { name: "GitHub 仓库地址" }).fill("https://github.com/owner/repository.git");
  await page.getByRole("button", { name: "关联公开空仓库" }).click();
  await expect(page.getByText(/尚未验证远程同步/)).toBeVisible();
  await expect(page.getByRole("link", { name: "在 GitHub 查看仓库" })).toHaveAttribute("href", state.remoteUrl);
  expect(state.merges).toBe(0);
  await page.getByRole("button", { name: "创建本仓库部署密钥" }).click();
  await expect(page.getByRole("button", { name: "准备推送已审核 main" })).toBeDisabled();
  await page.getByText("GitHub 仓库授权", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "仓库部署公钥" })).toHaveValue("ssh-ed25519 fixture-public-key");
  await page.getByRole("button", { name: "检查 GitHub 连接" }).click();
  await page.getByRole("button", { name: "准备推送已审核 main" }).click();
  expect(state.pushes).toBe(0);
  await expect(page.getByRole("region", { name: "确认 GitHub 推送" })).toContainText("所关联 GitHub 仓库");
  await page.getByRole("button", { name: "确认推送到 GitHub" }).click();
  await expect(page.getByText("上次检查：远程 main 与工作区 main 一致。")).toBeVisible();
  expect(state.pushes).toBe(1);
});
