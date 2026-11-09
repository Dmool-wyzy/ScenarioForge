import { test, expect } from "./fixtures";
import { PrismaClient } from "@prisma/client";

test("固定公开来源的同源提交通过，其他端口和主机来源拒绝", async ({ page, request, baseURL, project }) => {
  const url = new URL(baseURL!);
  await page.goto(`${url.origin}/?project=${project.id}`);
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/research", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    return { status: response.status, body: await response.json() };
  });
  expect(result.status).toBe(400);
  expect(result.body.error).toContain("输入格式不正确");
  for (const origin of ["https://untrusted.example", `http://${url.hostname}:${Number(url.port) + 1}`, `http://${url.hostname === "localhost" ? "127.0.0.1" : "localhost"}:${url.port}`]) {
    const response = await request.post("/api/research", { headers: { Origin: origin }, data: {} });
    expect(response.status()).toBe(403);
    expect((await response.json()).error).toBe("请求来源无效。");
  }
});

test("文件预览、SSE 实时更新、下载和刷新恢复", async ({ page, project }) => {
  const db = new PrismaClient();
  const pkg = await db.researchPackage.create({ data: { projectId: project.id, goal: "浏览器验证专用目标", title: "浏览器验证", status: "completed", files: { create: [{ filename: "README.md", content: "# 浏览器研究项目\n\n这是测试文档。" }, { filename: "PLAN.md", content: "# 阶段计划\n\n执行第一阶段。" }] } } });
  try {
    await page.goto(`/?project=${project.id}&package=${pkg.id}`);
    await expect(page.getByRole("heading", { name: "浏览器研究项目", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "PLAN.md" }).click();
    await expect(page.getByRole("heading", { name: "阶段计划", exact: true })).toBeVisible();
    await db.$transaction(async (tx) => {
      await tx.workspaceFile.update({ where: { packageId_filename: { packageId: pkg.id, filename: "PLAN.md" } }, data: { content: "# 实时更新的计划", version: 2 } });
      await tx.researchPackage.update({ where: { id: pkg.id }, data: { eventSequence: 1 } });
      await tx.researchEvent.create({ data: { packageId: pkg.id, sequence: 1, type: "file_updated", message: "更新 PLAN.md" } });
    });
    await expect(page.getByRole("heading", { name: "实时更新的计划", exact: true })).toBeVisible({ timeout: 10_000 });
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "↓ 当前文件" }).click();
    expect((await downloadPromise).suggestedFilename()).toBe("PLAN.md");
    await page.reload();
    await expect(page.getByRole("heading", { name: "浏览器研究项目", exact: true })).toBeVisible();
  } finally { await page.goto("about:blank"); await db.$disconnect(); }
});

test("示例填写和上传限制的中文提示", async ({ page, project }) => {
  await page.goto(`/?project=${project.id}`);
  await page.getByRole("button", { name: "软件项目示例" }).click();
  await expect(page.getByRole("textbox", { name: "你想完成什么？" })).toHaveValue(/东京留学生/);
  await page.locator('input[type="file"]').setInputFiles([{ name: "invalid.exe", mimeType: "application/octet-stream", buffer: Buffer.from("invalid") }]);
  await page.getByRole("button", { name: "发送 →", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "请上传最多 5 个" })).toBeVisible();
});

test("搜索 SSE 展示 Provider、查询、结果数量及失败原因", async ({ page, project }) => {
  const db = new PrismaClient();
  const pkg = await db.researchPackage.create({ data: { projectId: project.id, goal: "搜索进度浏览器验证", title: "搜索进度", status: "researching" } });
  try {
    await page.goto(`/?project=${project.id}&package=${pkg.id}`);
    await expect(page.getByRole("heading", { name: "任务进度", exact: true })).toBeVisible();
    const events = [
      { sequence: 1, type: "search_started", message: "正在检索 [mock]：Tokyo rental rules", payload: { provider: "mock", query: "Tokyo rental rules" } },
      { sequence: 2, type: "evidence_found", message: "[mock] 搜索完成：3 条结果 · Tokyo rental rules", payload: { provider: "mock", query: "Tokyo rental rules", resultCount: 3 } },
      { sequence: 3, type: "search_failed", message: "搜索失败：搜索服务暂时不可用，请稍后重试或切换搜索 Provider。", payload: { provider: "mock", code: "upstream_error", message: "搜索服务暂时不可用，请稍后重试或切换搜索 Provider。" } },
    ];
    for (const event of events) {
      await db.$transaction(async (tx) => {
        await tx.researchEvent.create({ data: { packageId: pkg.id, ...event, payload: JSON.stringify(event.payload) } });
        await tx.researchPackage.update({ where: { id: pkg.id }, data: { eventSequence: event.sequence } });
      });
      const expected = event.type === "search_failed" ? "搜索失败 [mock] · upstream_error：搜索服务暂时不可用，请稍后重试或切换搜索 Provider。" : event.message;
      await expect(page.getByText(expected, { exact: true })).toBeVisible({ timeout: 10000 });
    }
  } finally { await page.goto("about:blank"); await db.$disconnect(); }
});

test("阻塞问题卡片提交选择后恢复研究", async ({ page, project }) => {
  const db = new PrismaClient();
  const pkg = await db.researchPackage.create({ data: { projectId: project.id, goal: "澄清卡片浏览器验证", title: "澄清验证", status: "waiting_for_user", taskState: "running", leaseUntil: new Date(Date.now() + 120000), clarifications: { create: { groupId: "browser-group", questionId: "browser-question", question: "你希望面向谁？", type: "single_choice", options: JSON.stringify(["大学生", "所有人"]), priority: "blocking", whyNeeded: "决定目标用户", expiresAt: new Date(Date.now() + 600000) } } } });
  try {
    await page.goto(`/?project=${project.id}&package=${pkg.id}`);
    await expect(page.getByRole("heading", { name: "你希望面向谁？" })).toBeVisible();
    await page.getByRole("radio", { name: "大学生", exact: true }).check();
    await page.getByRole("button", { name: "提交回答" }).click();
    await expect(page.getByText("你的回答：大学生", { exact: true })).toBeVisible();
    const stored = await db.researchPackage.findUniqueOrThrow({ where: { id: pkg.id } });
    expect(stored.status).toBe("researching"); expect(stored.pendingMessage).toContain("澄清问题已回答");
  } finally { await page.goto("about:blank"); await db.$disconnect(); }
});

test("Markdown 编辑保存、解锁与 Agent 通知", async ({ page, project }) => {
  const db = new PrismaClient();
  const pkg = await db.researchPackage.create({ data: { projectId: project.id, goal: "编辑器浏览器验证", title: "编辑验证", status: "completed", taskState: "running", leaseUntil: new Date(Date.now() + 120000), files: { create: { filename: "README.md", content: "# 初始文件" } } } });
  try {
    await page.goto(`/?project=${project.id}&package=${pkg.id}`);
    await page.getByRole("button", { name: "编辑 Markdown" }).click();
    const editor = page.getByRole("textbox", { name: "Markdown 文件内容" });
    await expect(editor).toBeVisible();
    await editor.fill("# 用户保存的标题\n\n保留用户的计划。\n\n<script>window.__unsafe=true</script>");
    await page.getByRole("textbox", { name: "修改说明" }).fill("更新项目计划");
    await page.getByRole("button", { name: "保存并通知 Agent" }).click();
    await expect(page.getByRole("heading", { name: "用户保存的标题", exact: true })).toBeVisible();
    const file = await db.workspaceFile.findUniqueOrThrow({ where: { packageId_filename: { packageId: pkg.id, filename: "README.md" } } });
    expect(file.version).toBe(2); expect(file.lockedBy).toBeNull(); expect(file.userContent).toContain("保留用户的计划");
    expect((await db.researchPackage.findUniqueOrThrow({ where: { id: pkg.id } })).pendingMessage).toContain("read_workspace_file");
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__unsafe)).toBeUndefined();
  } finally { await page.goto("about:blank"); await db.$disconnect(); }
});
