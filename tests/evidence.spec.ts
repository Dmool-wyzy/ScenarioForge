import { test, expect } from "./fixtures";
import { PrismaClient } from "@prisma/client";

for (const [goal, content, query] of [
  ["我想做一个东京留学生合租平台", "东京留学生合租平台首版提供中文日文房源信息，租赁价格待确认。", "东京留学生合租平台 房源"],
  ["我要做一个基于 YOLO 的安全帽检测项目", "YOLO 安全帽检测采用边界框标注，数据集授权和训练性能待确认。", "YOLO 安全帽检测 边界框"],
  ["我想组织一次校园社团活动", "校园社团活动预算为 3000 元，参与人数 50 人，地点是校内礼堂。", "校园社团活动 预算 人数"],
]) {
  test(`RAG 证据检索、过滤、引用预览与 ZIP：${goal}`, async ({ page, request, project }) => {
    test.skip(process.env.AGENT_RAG_TEST !== "true", "使用 npm run check:rag-agent 启动隔离 RAG 环境");
    const db = new PrismaClient();
    const pkg = await db.researchPackage.create({ data: { projectId: project.id, goal, title: goal, status: "completed", uploadedFiles: JSON.stringify([{ filename: "reference.txt", extractedText: content }]), files: { create: { filename: "README.md", content: "# 演示工作区" } } } });
    try {
      const rebuild = await request.post(`/api/research/${pkg.id}/knowledge/rebuild`);
      expect(rebuild.ok()).toBeTruthy();
      await expect.poll(async () => db.chunkEmbedding.count({ where: { packageId: pkg.id } }), { timeout: 20000 }).toBeGreaterThan(0);
      await expect.poll(async () => (await db.researchPackage.findUniqueOrThrow({ where: { id: pkg.id } })).activeIndexId, { timeout: 20000 }).not.toBeNull();
      const evidence = await db.evidenceChunk.findFirstOrThrow({ where: { packageId: pkg.id, content: { contains: content } } });
      const evidenceId = `EVIDENCE-${evidence.evidenceNumber}`;
      await db.workspaceFile.update({ where: { packageId_filename: { packageId: pkg.id, filename: "README.md" } }, data: { content: `# 演示工作区\n\n用户资料 [${evidenceId}]\n\n\`[EVIDENCE-999999]\`\n\n\`\`\`\n[EVIDENCE-999999]\n\`\`\`` } });
      await page.goto(`/?project=${project.id}&package=${pkg.id}`);
      await page.getByRole("button", { name: `[${evidenceId}]`, exact: true }).click();
      const detail = page.getByRole("dialog", { name: "证据详情" });
      await expect(detail.getByText(content, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "关闭证据详情" }).click();
      await expect(page.getByRole("button", { name: "[EVIDENCE-999999]", exact: true })).toHaveCount(0);
      await page.getByText(/证据与检索 ·/).click();
      await expect(page.getByRole("heading", { name: "项目证据库" })).toBeVisible();
      await page.getByRole("combobox", { name: "证据来源类型" }).selectOption("upload");
      await page.getByRole("textbox", { name: "证据检索问题" }).fill(query);
      await page.getByRole("button", { name: "检索 Top-K 证据" }).click();
      await expect(page.getByText(/已检索到相关项目证据/)).toBeVisible();
      await expect(page.getByText(/相似度/).first()).toBeVisible();
      await page.getByRole("combobox", { name: "证据来源类型" }).selectOption("web");
      await expect(page.getByText("暂无证据分块。配置 Embedding 后可为现有资料建立索引。", { exact: true })).toBeVisible();
      const zip = await request.get(`/api/research/${pkg.id}/workspace`);
      expect(zip.ok()).toBeTruthy();
      const archive = await (await import("jszip")).default.loadAsync(await zip.body());
      expect(archive.file("evidence-index.json")).not.toBeNull();
    } finally { await page.goto("about:blank"); await db.$disconnect(); }
  });
}
