import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page, { member = false, fail = false, importSupported = false, initialized = false } = {}) {
  const projects = [{ id: "project-a", name: "团队甲", inviteCode: "TEAM01", role: member ? "member" : "owner", memberCount: 2, researchPackages: [] as unknown[] }];
  const repositories: Record<string, { enabled: boolean; remoteUrl?: string; remoteBranch?: string; head?: string; remote?: { configured: boolean; publicKey: string; checkedAt: string | null; head: string | null; connection: { url: string; branch: string; imported: boolean } } }> = { "project-a": { enabled: initialized } };
  const state = { fail, denyImport: false, reads: 0, writes: [] as { project: string; action: string }[], projects, repositories };
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { sessionStorage.setItem("copied-invitation", text); } } });
  });
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "fixture-user", username: "fixture" } } });
    if (path === "/api/projects") {
      if (request.method() === "POST") {
        const project = { id: "project-b", name: request.postDataJSON().name, inviteCode: "TEAM02", role: "owner", memberCount: 1, researchPackages: [] };
        projects.push(project); repositories[project.id] = { enabled: false };
        return route.fulfill({ json: { project } });
      }
      return route.fulfill({ json: { projects } });
    }
    if (path.endsWith("/repository")) {
      const id = path.split("/")[3];
      if (request.method() === "POST") {
        const action = request.postDataJSON();
        state.writes.push({ project: id, action: action.action });
        if (action.action === "prepare") {
          repositories[id].remote = { configured: true, publicKey: "ssh-ed25519 fixture-project-key", checkedAt: null, head: null, connection: { url: action.url, branch: action.branch, imported: false } };
        } else if (action.action === "import") {
          if (state.denyImport) return route.fulfill({ status: 502, json: { error: "GitHub 尚未授权此部署密钥" } });
          const repo = repositories[id];
          repo.enabled = true; repo.remoteUrl = repo.remote!.connection.url; repo.remoteBranch = repo.remote!.connection.branch || "master"; repo.head = "a".repeat(40);
          repo.remote!.connection.imported = true; repo.remote!.checkedAt = "2026-11-08T12:00:00Z"; repo.remote!.head = repo.head;
        } else {
          expect(action.action).toBe("connect");
          repositories[id] = { enabled: true, remoteUrl: action.url };
        }
        return route.fulfill({ json: { ok: true } });
      }
      state.reads++;
      return state.fail ? route.fulfill({ status: 503, json: { error: "仓库暂时无法读取" } }) : route.fulfill({ json: { ...repositories[id], capabilities: { import: importSupported } } });
    }
    if (path.endsWith("/model")) return route.fulfill({ json: { settings: null, canEdit: !member } });
    if (path.endsWith("/personal-agent")) return route.fulfill({ json: { settings: null, acceptsAgentTasks: false, tasks: [] } });
    if (path.endsWith("/knowledge")) return route.fulfill({ json: { total: 0, results: [] } });
    return route.fulfill({ status: 404, json: { error: "Unexpected fixture route" } });
  });
  await page.goto("/?project=project-a");
  return state;
}

test("新建项目有独立 Git 连接和邀请码，切换项目不串配置", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await fixture(page);
  const panel = page.getByTestId("project-repository");
  await expect(panel.locator("summary").first()).toContainText("待连接");
  await expect(panel).not.toHaveAttribute("open", "");
  await panel.locator("summary").first().click();
  await expect(panel.getByRole("region", { name: "邀请项目成员" })).toHaveCount(0);
  await page.getByRole("button", { name: "复制邀请码", exact: true }).click();
  expect(await page.evaluate(() => sessionStorage.getItem("copied-invitation"))).toBe("TEAM01");
  await panel.screenshot({ path: ".tmp/preview/project-repository-desktop.png" });
  await panel.getByRole("textbox", { name: "GitHub 仓库地址" }).fill("https://github.com/fixture/team-a.git");
  await panel.getByRole("button", { name: "关联公开空仓库" }).click();
  await expect(panel.getByRole("textbox", { name: "GitHub 仓库地址" })).toHaveValue("https://github.com/fixture/team-a.git");
  await expect(panel.locator("summary").first()).toContainText("已关联远程地址");
  await expect(panel.locator("summary").first()).not.toContainText("已同步");
  await page.getByRole("button", { name: "← 返回项目" }).click();
  await page.getByRole("textbox", { name: "项目名称" }).fill("团队乙");
  await page.getByRole("button", { name: "创建项目" }).click();
  await expect(page.getByRole("heading", { name: "团队乙", exact: true })).toBeVisible();
  await panel.locator("summary").first().click();
  await expect(panel.getByRole("textbox", { name: "GitHub 仓库地址" })).toHaveValue("");
  await expect(page.locator(".sf-invite-code")).toHaveText("TEAM02");
  await panel.getByRole("textbox", { name: "GitHub 仓库地址" }).fill("https://github.com/fixture/team-b.git");
  await panel.getByRole("button", { name: "关联公开空仓库" }).click();
  await expect(panel.getByRole("textbox", { name: "GitHub 仓库地址" })).toHaveValue("https://github.com/fixture/team-b.git");
  expect(state.writes).toEqual([{ project: "project-a", action: "connect" }, { project: "project-b", action: "connect" }]);
  await page.getByRole("button", { name: "← 返回项目" }).click();
  await page.getByRole("button").filter({ has: page.getByRole("heading", { name: "团队甲", exact: true }) }).click();
  await panel.locator("summary").first().click();
  await expect(panel.getByRole("textbox", { name: "GitHub 仓库地址" })).toHaveValue("https://github.com/fixture/team-a.git");
  await expect(panel).not.toContainText("team-b.git");
});

test("仓库读取失败仍能邀请，重试后恢复可配置状态", async ({ page }) => {
  const state = await fixture(page, { fail: true });
  const panel = page.getByTestId("project-repository");
  await expect(panel.locator("summary").first()).toContainText("暂不可用");
  await panel.locator("summary").first().click();
  await expect(panel.getByRole("alert")).toContainText("仓库暂时无法读取");
  await expect(page.getByRole("button", { name: "复制邀请码", exact: true })).toBeEnabled();
  await expect(panel.getByRole("textbox", { name: "GitHub 仓库地址" })).toHaveCount(0);
  state.fail = false;
  await panel.getByRole("button", { name: "重新读取仓库" }).click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(panel.getByRole("textbox", { name: "GitHub 仓库地址" })).toBeEnabled();
  expect(state.reads).toBeGreaterThanOrEqual(2);
  expect(state.writes).toHaveLength(0);
});

test("项目成员可邀请但不能管理仓库，复制失败可手动复制", async ({ page }) => {
  const state = await fixture(page, { member: true });
  const panel = page.getByTestId("project-repository");
  await panel.locator("summary").first().click();
  await expect(panel).toContainText("等待项目创建者连接仓库或创建工作区");
  await expect(panel.getByRole("textbox", { name: "GitHub 仓库地址" })).toHaveCount(0);
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { value: undefined }); });
  await page.getByRole("button", { name: "复制邀请码", exact: true }).click();
  await expect(page.getByText("请选中邀请码，手动复制后分享给伙伴。")).toBeVisible();
  expect(state.writes).toHaveLength(0);
});

test("手机宽度可展开与收起，连接表单和长仓库地址不溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  const panel = page.getByTestId("project-repository");
  await panel.locator("summary").first().click();
  await expect(panel.getByRole("textbox", { name: "GitHub 仓库地址" })).toBeVisible();
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await panel.screenshot({ path: ".tmp/preview/project-repository-mobile.png" });
  await panel.getByRole("textbox", { name: "GitHub 仓库地址" }).fill("https://github.com/fixture/very-long-project-repository-address-for-mobile-display.git");
  await panel.getByRole("button", { name: "关联公开空仓库" }).click();
  await expect(panel.getByText(/尚未验证远程同步/)).toBeVisible();
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await panel.locator("summary").first().click();
  await expect(panel.getByRole("region", { name: "邀请项目成员" })).not.toBeVisible();
  await expect(panel.locator("summary").first()).toContainText("展开");
});

test("已创建初始工作区也能授权导入已有仓库，不再走空仓库接口", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 1000 });
  const state = await fixture(page, { importSupported: true, initialized: true });
  const panel = page.getByTestId("project-repository");
  await panel.locator("summary").first().click();
  await panel.getByRole("textbox", { name: "GitHub 仓库地址" }).fill("https://github.com/fixture/private.git");
  await panel.getByRole("textbox", { name: "导入分支（可选）" }).fill("release/v1");
  await panel.getByRole("button", { name: "生成部署公钥" }).click();
  await expect(panel.getByRole("textbox", { name: "仓库部署公钥" })).toHaveValue("ssh-ed25519 fixture-project-key");
  await expect(panel.getByRole("region", { name: "仓库导入授权" })).toContainText("release/v1");
  await expect(panel.getByRole("button", { name: "准备推送已审核 main" })).toHaveCount(0);
  await panel.screenshot({ path: ".tmp/preview/repository-import-authorization.png" });
  await page.reload();
  await panel.locator("summary").first().click();
  await expect(panel.getByRole("textbox", { name: "GitHub 仓库地址" })).toHaveValue("https://github.com/fixture/private.git");
  await expect(panel.getByRole("textbox", { name: "导入分支（可选）" })).toHaveValue("release/v1");
  state.denyImport = true;
  await panel.getByRole("button", { name: "验证授权并导入" }).click();
  await expect(panel.getByRole("alert")).toContainText("GitHub 尚未授权");
  await expect(panel.getByRole("textbox", { name: "仓库部署公钥" })).toHaveValue("ssh-ed25519 fixture-project-key");
  state.denyImport = false;
  await panel.getByRole("button", { name: "验证授权并导入" }).click();
  await expect(panel.getByRole("textbox", { name: "远程目标分支" })).toHaveValue("release/v1");
  await expect(panel.locator("summary").first()).toContainText("已同步到 GitHub");
  expect(state.writes.map(write => write.action)).toEqual(["prepare", "import", "import"]);
});
