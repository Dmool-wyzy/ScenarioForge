import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page, owner = true) {
  const sha = "a".repeat(40), own = "work/member/feature/test";
  const state = { writes: [] as Record<string, unknown>[], stale: false, main: sha, remote: sha, commits: 0, files: { "main": { "README.md": "# Existing\n", "src/main.ts": "console.log('hello')\n" } } as Record<string, Record<string, string>>, heads: { main: sha } as Record<string, string>, merged: new Set<string>(["main"]) };
  const isEditable = (branch: string) => branch.startsWith("work/") && (owner || branch.startsWith("work/member/"));
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
    if (pathname === "/api/auth/me") return route.fulfill({ json: { user: { id: "member", username: "fixture" } } });
    if (pathname === "/api/projects") return route.fulfill({ json: { projects: [{ id: "project-a", name: "Git 文件工作区", inviteCode: "TEST01", role: owner ? "owner" : "member", memberCount: 2, researchPackages: [] }] } });
    if (pathname.endsWith("/repository")) {
      if (request.method() === "POST") {
        const body = request.postDataJSON(); state.writes.push(body);
        if (body.action === "branch-create") {
          const branch = "work/member/" + body.name; state.files[branch] = { ...state.files[body.from] }; state.heads[branch] = body.head; state.merged.add(branch);
          return route.fulfill({ json: { ok: true, branch } });
        }
        if (body.action === "files-commit") {
          if (state.stale) return route.fulfill({ status: 409, json: { error: "分支已有新提交，请先保存草稿并刷新" } });
          for (const change of body.changes) { if (change.delete) delete state.files[body.branch][change.path]; else state.files[body.branch][change.path] = change.encoding === "base64" ? Buffer.from(change.content, "base64").toString() : change.content; }
          state.commits++; state.heads[body.branch] = String(state.commits).repeat(40); state.merged.delete(body.branch);
        } else if (body.action === "branch-merge") { expect(owner).toBe(true); state.files.main = { ...state.files[body.branch] }; state.main = state.heads.main = body.commit; state.merged.add(body.branch); }
        else if (body.action === "branch-delete") { delete state.files[body.branch]; delete state.heads[body.branch]; }
        else if (body.action === "pull") { expect(owner).toBe(true); state.main = state.heads.main = state.remote; }
        else if (body.action === "push") { expect(owner).toBe(true); state.remote = state.main; }
        else expect(body.action).toBe("check");
        return route.fulfill({ json: { ok: true } });
      }
      const branch = url.searchParams.get("branch") || "main", view = url.searchParams.get("view");
      const files = Object.entries(state.files[branch] ?? {}).map(([path, content]) => ({ path, mode: "100644", type: "blob", oid: sha, size: Buffer.byteLength(content) }));
      if (view === "workspace") return route.fulfill({ json: { branch, head: state.heads[branch], editable: isEditable(branch), prefix: "work/member/", ahead: state.merged.has(branch) ? 0 : 1, behind: 0, files, branches: Object.keys(state.files).map(name => ({ name, head: state.heads[name], editable: isEditable(name), merged: state.merged.has(name) })) } });
      if (view === "file") { const filename = url.searchParams.get("path")!, text = state.files[branch][filename]; return route.fulfill({ json: { ...files.find(file => file.path === filename), head: state.heads[branch], text, base64: Buffer.from(text).toString("base64"), reason: null } }); }
      if (view === "compare") return route.fulfill({ json: { branch, head: state.main, commit: state.heads[branch], merged: state.merged.has(branch), diff: "diff --git a/docs/test.md b/docs/test.md\n+测试文档", truncated: false } });
      if (view === "history") return route.fulfill({ json: { head: state.heads[branch], more: false, commits: [{ commit: state.heads[branch], author: "ScenarioForge", date: "2026-11-08T12:00:00Z", subject: "测试提交" }] } });
      if (view === "commit") return route.fulfill({ json: { commit: state.heads[branch], diff: "+测试文档", truncated: false } });
      return route.fulfill({ json: { enabled: true, capabilities: { import: true, workspace: true }, head: state.main, remoteUrl: "https://github.com/fixture/repo.git", remoteBranch: "master", remote: { configured: true, checkedAt: "2026-11-08T12:00:00Z", head: state.remote, publicKey: "ssh-ed25519 fixture" }, files: Object.keys(state.files.main), tasks: [] } });
    }
    if (pathname.endsWith("/model")) return route.fulfill({ json: { settings: null, canEdit: owner } });
    if (pathname.endsWith("/personal-agent")) return route.fulfill({ json: { settings: null, acceptsAgentTasks: false, tasks: [] } });
    if (pathname.endsWith("/knowledge")) return route.fulfill({ json: { total: 0, results: [] } });
    return route.fulfill({ status: 404, json: { error: "Unexpected fixture route" } });
  });
  await page.goto("/?project=project-a");
  await page.getByTestId("project-repository").locator("summary").first().click();
  const panel = page.getByRole("region", { name: "仓库文件与版本" });
  await expect(panel.getByRole("combobox", { name: "浏览分支" })).toHaveValue("main");
  return { state, panel, own };
}
async function create(page: Page) {
  const panel = page.getByRole("region", { name: "仓库文件与版本" });
  await panel.getByRole("button", { name: "分支与合并", exact: true }).click();
  await panel.getByRole("textbox", { name: "新分支名称" }).fill("feature/test");
  await panel.getByRole("button", { name: "创建我的分支" }).click();
  await expect(panel.getByRole("button", { name: "新建文本文件" })).toBeVisible();
}

test("浏览、上传、编辑、重命名、删除、提交历史和审查合并", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  const { state, panel, own } = await setup(page);
  await panel.getByRole("button", { name: /README.md/ }).click();
  await expect(panel.getByText("# Existing", { exact: true })).toBeVisible();
  await panel.screenshot({ path: ".tmp/preview/repository-files-desktop.png" });
  await create(page);
  await panel.getByRole("textbox", { name: "上传到目录（可选）" }).fill("docs");
  await panel.getByLabel("上传文件", { exact: true }).setInputFiles({ name: "test.md", mimeType: "text/markdown", buffer: Buffer.from("测试文档\n") });
  await expect(panel.getByRole("region", { name: "待提交变更" })).toContainText("docs/test.md");
  await expect(panel.getByRole("combobox")).toBeDisabled();
  await panel.getByRole("textbox", { name: "提交说明" }).fill("上传测试文档");
  await panel.getByRole("button", { name: "提交到当前分支" }).click();
  await expect(panel.getByRole("region", { name: "待提交变更" })).toHaveCount(0);
  expect(state.files.main).not.toHaveProperty("docs/test.md");
  await panel.getByRole("button", { name: "📁 docs/", exact: true }).click();
  await panel.getByRole("button", { name: /test.md/ }).click();
  await panel.getByRole("button", { name: "编辑 / 重命名" }).click();
  await panel.getByRole("textbox", { name: "文件路径", exact: true }).fill("docs/改名.md");
  await panel.getByRole("textbox", { name: "文件内容" }).fill("修改后的内容\n");
  await panel.getByRole("button", { name: "加入待提交", exact: true }).click();
  await panel.getByRole("textbox", { name: "提交说明" }).fill("重命名文档");
  await panel.getByRole("button", { name: "提交到当前分支" }).click();
  await expect(panel.getByRole("button", { name: /改名.md/ })).toBeVisible();
  await panel.getByRole("button", { name: /改名.md/ }).click();
  await panel.getByRole("button", { name: "标记删除" }).click();
  await expect(panel.getByRole("region", { name: "待提交变更" })).toContainText("删除 · docs/改名.md");
  await panel.getByRole("button", { name: "撤回", exact: true }).click();
  await panel.getByRole("button", { name: "提交历史", exact: true }).click();
  await panel.getByRole("button", { name: "测试提交", exact: true }).click();
  await expect(panel.getByLabel("提交差异")).toContainText("+测试文档");
  await panel.getByRole("button", { name: "分支与合并", exact: true }).click();
  await panel.getByRole("button", { name: "与 main 比较" }).click();
  await expect(panel.getByRole("region", { name: "分支合并审查" })).toContainText("+测试文档");
  await panel.getByRole("button", { name: "确认将分支合并到 main" }).click();
  await expect(panel.getByRole("status")).toContainText("分支已合并");
  expect(state.files.main["docs/改名.md"]).toBe("修改后的内容\n");
  await panel.getByRole("button", { name: "删除已合并分支" }).click();
  await panel.getByRole("button", { name: "确认删除分支" }).click();
  await expect(panel.getByRole("combobox")).toHaveValue("main");
  expect(state.files).not.toHaveProperty(own);
  await page.getByRole("button", { name: "准备推送已审核 main" }).click();
  await page.getByRole("button", { name: "确认推送到 GitHub" }).click();
  await expect(page.getByTestId("project-repository").locator("summary").first()).toContainText("已同步到 GitHub");
  expect(state.writes.map(row => row.action)).toEqual(["branch-create", "files-commit", "files-commit", "branch-merge", "branch-delete", "push"]);
});

test("成员可上传自己的分支，不能编辑他人分支或合并推送", async ({ page }) => {
  const { state, panel } = await setup(page, false);
  state.files["work/another/review"] = { "README.md": "other" }; state.heads["work/another/review"] = "b".repeat(40);
  await panel.getByRole("button", { name: "刷新文件与分支" }).click();
  await panel.getByRole("combobox").selectOption("work/another/review");
  await expect(panel.getByRole("button", { name: "新建文本文件" })).toHaveCount(0);
  await panel.getByRole("button", { name: "分支与合并", exact: true }).click();
  await panel.getByRole("button", { name: "与 main 比较" }).click();
  await expect(panel.getByRole("button", { name: "确认将分支合并到 main" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "准备推送已审核 main" })).toHaveCount(0);
  await create(page);
  await expect(panel.getByLabel("上传文件", { exact: true })).toBeEnabled();
});

test("过期提交保留草稿，未保存编辑阻止切换，移动端不溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { state, panel } = await setup(page);
  await create(page);
  await panel.getByRole("button", { name: "新建文本文件" }).click();
  await panel.getByRole("textbox", { name: "文件路径", exact: true }).fill("docs/test.md");
  await panel.getByRole("textbox", { name: "文件内容" }).fill("保留草稿");
  await expect(panel.getByRole("combobox")).toBeDisabled();
  await expect(panel.getByRole("button", { name: "提交到当前分支" })).toBeDisabled();
  await panel.getByRole("button", { name: "加入待提交", exact: true }).click();
  await panel.getByRole("textbox", { name: "提交说明" }).fill("草稿提交");
  state.stale = true;
  await panel.getByRole("button", { name: "提交到当前分支" }).click();
  await expect(panel.getByRole("alert")).toContainText("分支已有新提交");
  await expect(panel.getByRole("region", { name: "待提交变更" })).toContainText("docs/test.md");
  await expect(panel.getByRole("textbox", { name: "提交说明" })).toHaveValue("草稿提交");
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await panel.screenshot({ path: ".tmp/preview/repository-files-mobile.png" });
});
