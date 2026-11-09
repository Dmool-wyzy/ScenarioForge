import { test, expect, type Page } from "@playwright/test";

// All API routes are fixtures: no database, credentials or model requests.
const event = (sequence: number, type: string, message: string) => ({ id: `event-${sequence}`, sequence, type, message, payload: null, createdAt: "2026-11-07T00:00:00.000Z" });
const sharedKnowledge = [{ id: "shared-knowledge-1", title: "项目背景资料", question: "课程项目需要复用什么？", claim: "一条经过人工分享的参考结论。", confidence: "medium", status: "confirmed", sources: [{ title: "项目笔记", url: "https://example.test/source", snippet: "项目背景", accessedAt: "2026-11-07T00:00:00.000Z" }], originPackageTitle: "历史研究", originEvidenceCode: "E1", createdAt: "2026-11-07T00:00:00.000Z", archivedAt: null, canManage: true }];

async function conversationPage(page: Page, status = "replied", taskState = "idle", knowledge: typeof sharedKnowledge = []) {
  const snapshot = { id: "chat-fixture", title: "聊天测试", goal: "你好", status, taskState, currentStage: 0, summary: "你好，可以聊聊你的任务。", filePlan: [], files: [], evidence: [], clarifications: [], events: [event(1, "user_message", "你好"), event(2, "assistant_message", "你好，可以聊聊你的任务。"), event(3, "turn_completed", "本轮回复已完成")] };
  let creations = 0;
  let messages = 0;
  let sharedKnowledgeIncluded = false;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "user-fixture", username: "chat_fixture" } } });
    if (path === "/api/projects") return route.fulfill({ json: { projects: [{ id: "project-fixture", name: "对话测试项目", inviteCode: "TEST01", role: "owner", memberCount: 1, researchPackages: [{ id: snapshot.id, title: snapshot.title, status: snapshot.status, updatedAt: "2026-11-07T00:00:00.000Z" }] }] } });
    if (path === "/api/projects/project-fixture/knowledge") return route.fulfill({ json: { total: knowledge.length, results: knowledge } });
    if (path.endsWith("/model")) return route.fulfill({ json: { settings: null, canEdit: true } });
    if (path.endsWith("/personal-agent")) return route.fulfill({ json: { settings: null, acceptsAgentTasks: false, tasks: [] } });
    if (path.endsWith("/repository")) return route.fulfill({ json: { enabled: false } });
    if (path === "/api/research" && route.request().method() === "POST") {
      creations++;
      const body = route.request().postData() ?? "";
      if (knowledge.some(item => body.includes(item.id))) sharedKnowledgeIncluded = true;
      expect(body).toContain(knowledge.length ? "sharedKnowledgeIds" : "你好");
      return route.fulfill({ status: 202, json: { packageId: snapshot.id, status: "created" } });
    }
    if (path === `/api/research/${snapshot.id}`) return route.fulfill({ json: snapshot });
    if (path.endsWith("/stream")) return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" });
    if (path.endsWith("/messages")) {
      messages++;
      const { message } = route.request().postDataJSON();
      snapshot.events.push(event(4, "user_message", message), event(5, "assistant_message", "这是普通聊天回复，研究仍等待原来的条件。"));
      return route.fulfill({ status: 202, json: { status: "queued" } });
    }
    return route.fulfill({ status: 404, json: { error: "Unexpected fixture API route" } });
  });
  return { snapshot, counts: () => ({ creations, messages }), sharedKnowledgeIncluded: () => sharedKnowledgeIncluded };
}

test("短消息可以开启聊天，显示历史且不出现待生成的默认文档", async ({ page }) => {
  const fixture = await conversationPage(page);
  await page.goto("/?project=project-fixture");
  const input = page.getByRole("textbox", { name: "你想完成什么？" });
  await expect(input).toHaveAttribute("minlength", "1");
  await input.fill("你好");
  await page.getByRole("button", { name: "发送 →", exact: true }).click();
  const history = page.getByRole("region", { name: "对话记录" });
  await expect(history.getByText("你好", { exact: true })).toBeVisible();
  await expect(history.getByText("你好，可以聊聊你的任务。", { exact: true })).toHaveCount(1);
  await expect(input).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "继续与 Agent 对话" })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "工作区文件" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "文件计划", exact: true })).toHaveCount(0);
  await expect(page.getByText("已回复", { exact: true })).toBeVisible();
  expect(fixture.counts()).toEqual({ creations: 1, messages: 0 });
});

test("创建研究时可以复用项目共享资料", async ({ page }) => {
  const fixture = await conversationPage(page, "replied", "idle", sharedKnowledge);
  await page.goto("/?project=project-fixture");
  await page.getByRole("textbox", { name: "你想完成什么？" }).fill("基于共享资料继续研究");
  await page.locator("summary").filter({ hasText: "复用团队共享资料" }).click();
  await page.getByRole("checkbox", { name: /项目背景资料/ }).check();
  await page.getByRole("button", { name: "发送 →", exact: true }).click();
  await expect.poll(() => fixture.counts().creations).toBe(1);
  expect(fixture.sharedKnowledgeIncluded()).toBe(true);
});

for (const status of ["waiting_for_user", "blocked", "waiting_for_edit"]) test(`研究处于 ${status} 且空闲时仍可续聊`, async ({ page }) => {
  const fixture = await conversationPage(page, status);
  await page.goto("/?project=project-fixture&package=chat-fixture");
  await page.getByRole("textbox", { name: "继续与 Agent 对话" }).fill("先聊聊任务分工");
  const send = page.getByRole("button", { name: "发送", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByRole("region", { name: "对话记录" }).getByText("这是普通聊天回复，研究仍等待原来的条件。", { exact: true })).toBeVisible();
  expect(fixture.snapshot.status).toBe(status);
  expect(fixture.counts()).toEqual({ creations: 0, messages: 1 });
  await page.reload();
  await expect(page.getByRole("region", { name: "对话记录" }).getByText("先聊聊任务分工", { exact: true })).toBeVisible();
});

for (const taskState of ["queued", "running"]) test(`${taskState} 时阻止重复提交`, async ({ page }) => {
  await conversationPage(page, "replied", taskState);
  await page.goto("/?project=project-fixture&package=chat-fixture");
  await page.getByRole("textbox", { name: "继续与 Agent 对话" }).fill("重复提交");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
});
