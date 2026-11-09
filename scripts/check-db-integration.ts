import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Usage, type Model, type ModelProvider } from "@openai/agents";
import { db } from "../lib/db";
import { dispatchTeamSubtasks } from "../lib/team-agent";
import { encryptPersonalAgentSettings, type ModelSettings } from "../lib/model-settings";
import { claimResearchTask, queueResearch } from "../lib/tasks";
import { createResearch } from "../lib/research";
import * as knowledgeRoute from "../app/api/projects/[id]/knowledge/route";
import * as knowledgeItemRoute from "../app/api/projects/[id]/knowledge/[itemId]/route";
import * as researchRoute from "../app/api/research/[id]/route";
import * as personalAgentRoute from "../app/api/projects/[id]/personal-agent/route";
import * as personalTaskRoute from "../app/api/projects/[id]/personal-agent/tasks/[taskId]/route";
import * as repositoryRoute from "../app/api/projects/[id]/repository/route";
import { interactWithPersonalTask } from "../lib/personal-agent";

const databaseUrl = process.env.SCENARIOFORGE_TEST_DATABASE_URL;
assert.ok(databaseUrl && URL.canParse(databaseUrl), "Set SCENARIOFORGE_TEST_DATABASE_URL to an isolated MySQL database.");
assert.equal(process.env.DATABASE_URL, databaseUrl, "DATABASE_URL must point to the same isolated test database.");
assert.match(new URL(databaseUrl).pathname, /^\/scenarioforge_test_[a-z0-9_]{1,45}$/i, "The database name must start with scenarioforge_test_.");

const run = randomBytes(5).toString("hex");
const cookieName = process.env.NODE_ENV === "production" ? "__Host-scenarioforge_session" : "scenarioforge_session";
const users: { id: string; token: string }[] = [];
const projectIds: string[] = [];
const packageIds: string[] = [];

function request(user: { token: string } | null, path: string, method = "GET", body?: unknown) {
  const headers = new Headers();
  if (user) headers.set("Cookie", `${cookieName}=${user.token}`);
  if (method !== "GET") {
    headers.set("Origin", "http://localhost");
    headers.set("Content-Type", "application/json");
  }
  return new Request(`http://localhost${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

function reply(text: string) {
  return { usage: new Usage({ requests: 1, inputTokens: 12, outputTokens: 7, totalTokens: 19 }), output: [{ type: "message" as const, role: "assistant" as const, status: "completed" as const, content: [{ type: "output_text" as const, text }] }] };
}

function modelProvider(model: Model): ModelProvider { return { getModel: () => model }; }

test("isolated MySQL preserves project access, knowledge boundaries, and subtask lease state", async () => {
  const gitRoot = await mkdtemp(path.join(tmpdir(), "scenarioforge-git-db-test-"));
  process.env.SCENARIOFORGE_GIT_ROOT = gitRoot;
  try {
    const actors = await Promise.all(["owner", "creator", "member", "outsider"].map(async (role, index) => {
      const username = `db_${run}_${index}`;
      const user = await db.user.create({ data: { username, passwordHash: "fixture-only" } });
      const token = randomBytes(32).toString("base64url");
      await db.authSession.create({ data: { tokenHash: createHash("sha256").update(token).digest("hex"), userId: user.id, expiresAt: new Date(Date.now() + 60_000) } });
      users.push({ id: user.id, token });
      return { id: user.id, token, username, role };
    }));
    const [owner, creator, member, outsider] = actors;
    const personalSettings: ModelSettings = { baseUrl: "https://example.com/v1", model: "fixture-model", apiMode: "responses", timeoutSeconds: 30, deepseekSearchEnabled: false, apiKey: `fixture-${run}-personal-key` };
    const projectAId = randomUUID();
    const projectA = await db.project.create({ data: {
      id: projectAId, name: `DB integration A ${run}`, inviteCode: randomBytes(3).toString("hex").toUpperCase(),
      members: { create: { userId: owner.id, role: "owner", acceptsAgentTasks: true, personalAgentConfigEncrypted: encryptPersonalAgentSettings(projectAId, owner.id, personalSettings) } },
    } });
    projectIds.push(projectA.id);
    await db.projectMember.createMany({ data: [
      { projectId: projectA.id, userId: creator.id, role: "member" },
      { projectId: projectA.id, userId: member.id, role: "member", acceptsAgentTasks: true, personalAgentConfigEncrypted: encryptPersonalAgentSettings(projectA.id, member.id, personalSettings) },
    ] });
    const projectB = await db.project.create({ data: {
      name: `DB integration B ${run}`, inviteCode: randomBytes(3).toString("hex").toUpperCase(),
      members: { create: { userId: outsider.id, role: "owner" } },
    } });
    projectIds.push(projectB.id);

    const knowledgePackage = await db.researchPackage.create({ data: { projectId: projectA.id, title: "Knowledge source", goal: "Fixture source", status: "completed" } });
    const otherPackage = await db.researchPackage.create({ data: { projectId: projectB.id, title: "Other project", goal: "Private source", status: "completed" } });
    packageIds.push(knowledgePackage.id, otherPackage.id);
    const sources = JSON.stringify([{ title: "Official documentation", url: "https://example.com/source", snippet: "Useful verified fixture source", accessedAt: new Date().toISOString() }]);
    const evidence = await db.evidence.create({ data: { packageId: knowledgePackage.id, code: "E-1", question: "How is isolation enforced?", claim: "Project data is isolated by membership checks.", sources, confidence: "high", status: "verified" } });
    const mockEvidence = await db.evidence.create({ data: { packageId: knowledgePackage.id, code: "E-2", question: "Mock source", claim: "Must not be shared.", sources: JSON.stringify([{ title: "Mock", url: "https://example.com/mock", snippet: "[MOCK SEARCH RESULT] fixture", accessedAt: new Date().toISOString() }]), confidence: "low", status: "unconfirmed" } });
    const foreignEvidence = await db.evidence.create({ data: { packageId: otherPackage.id, code: "E-3", question: "Private project source", claim: "Must not cross projects.", sources, confidence: "high", status: "verified" } });

    const projectKnowledgePath = `/api/projects/${projectA.id}/knowledge`;
    const sharedResponse = await knowledgeRoute.POST(request(creator, projectKnowledgePath, "POST", { packageId: knowledgePackage.id, evidenceId: evidence.id }), { params: Promise.resolve({ id: projectA.id }) });
    assert.equal(sharedResponse.status, 201);
    const shared = await sharedResponse.json();
    assert.equal(shared.created, true);
    const duplicate = await knowledgeRoute.POST(request(creator, projectKnowledgePath, "POST", { packageId: knowledgePackage.id, evidenceId: evidence.id }), { params: Promise.resolve({ id: projectA.id }) });
    assert.equal((await duplicate.json()).created, false);
    const crossProject = await knowledgeRoute.POST(request(creator, projectKnowledgePath, "POST", { packageId: otherPackage.id, evidenceId: foreignEvidence.id }), { params: Promise.resolve({ id: projectA.id }) });
    assert.equal(crossProject.status, 404);
    const mockShare = await knowledgeRoute.POST(request(creator, projectKnowledgePath, "POST", { packageId: knowledgePackage.id, evidenceId: mockEvidence.id }), { params: Promise.resolve({ id: projectA.id }) });
    assert.equal(mockShare.status, 409);

    const outsiderList = await knowledgeRoute.GET(request(outsider, projectKnowledgePath), { params: Promise.resolve({ id: projectA.id }) });
    assert.equal(outsiderList.status, 404);
    const otherProjectList = await knowledgeRoute.GET(request(outsider, `/api/projects/${projectB.id}/knowledge`), { params: Promise.resolve({ id: projectB.id }) });
    assert.equal((await otherProjectList.json()).total, 0);
    const itemId = shared.item.id as string;
    const reuseInput = { goal: "Reuse a shared source", sharedKnowledgeIds: [itemId], files: [], constraints: {} };
    const reused = await createResearch(reuseInput, projectA.id);
    packageIds.push(reused.id);
    const snapshot = JSON.parse(reused.uploadedFiles);
    assert.equal(snapshot.length, 1);
    assert.ok(snapshot[0].extractedText.includes(evidence.claim));
    assert.ok(snapshot[0].extractedText.includes("high 置信度，verified 状态"));
    assert.ok(snapshot[0].extractedText.includes("https://example.com/source"));
    await assert.rejects(createResearch(reuseInput, projectB.id), /不属于当前项目/);
    const itemPath = `/api/projects/${projectA.id}/knowledge/${itemId}`;
    const deniedArchive = await knowledgeItemRoute.PATCH(request(member, itemPath, "PATCH", { archived: true }), { params: Promise.resolve({ id: projectA.id, itemId }) });
    assert.equal(deniedArchive.status, 403);
    const archived = await knowledgeItemRoute.PATCH(request(creator, itemPath, "PATCH", { archived: true }), { params: Promise.resolve({ id: projectA.id, itemId }) });
    assert.equal(archived.status, 200);
    assert.ok((await archived.json()).archivedAt);
    await assert.rejects(createResearch(reuseInput, projectA.id), /已移除/);
    assert.equal((await db.researchPackage.findUniqueOrThrow({ where: { id: reused.id } })).uploadedFiles, reused.uploadedFiles);
    const visibleAfterArchive = await knowledgeRoute.GET(request(owner, `${projectKnowledgePath}?q=isolation`), { params: Promise.resolve({ id: projectA.id }) });
    assert.equal((await visibleAfterArchive.json()).results.length, 0);
    const restored = await knowledgeItemRoute.PATCH(request(owner, itemPath, "PATCH", { archived: false }), { params: Promise.resolve({ id: projectA.id, itemId }) });
    assert.equal((await restored.json()).archivedAt, null);

    const successRun = randomUUID();
    const successPackage = await db.researchPackage.create({ data: { projectId: projectA.id, title: "Subtask success", goal: "Persist successful child results", taskState: "running", leaseOwner: successRun, leaseUntil: new Date(Date.now() + 60_000) } });
    packageIds.push(successPackage.id);
    let modelCalls = 0;
    const successModel: Model = { async getResponse() { modelCalls++; return reply("已核对的子任务结果"); }, getStreamedResponse() { throw new Error("unused"); } };
    const completed = JSON.parse(await dispatchTeamSubtasks({ packageId: successPackage.id, runId: successRun, input: { tasks: [{ objective: "核对甲", context: "甲的最小上下文", assigneeId: owner.id }, { objective: "核对乙", context: "乙的最小上下文", assigneeId: member.id }] }, resolveSubagent: async () => ({ model: "fixture", provider: modelProvider(successModel), settings: {} }), signal: new AbortController().signal }));
    assert.equal(modelCalls, 2);
    assert.ok(completed.tasks.every((task: { status: string; result?: string }) => task.status === "review" && !task.result));
    const persisted = await db.agentSubtask.findMany({ where: { packageId: successPackage.id, runId: successRun }, orderBy: { ordinal: "asc" } });
    assert.equal(persisted.length, 2);
    assert.equal(persisted[0].context, "甲的最小上下文");
    assert.equal(persisted[0].result, "已核对的子任务结果");
    assert.equal(persisted[0].assigneeId, owner.id);
    assert.equal(persisted[0].assigneeName, owner.username);
    assert.equal(persisted[1].assigneeId, member.id);
    const ownerInbox = await personalAgentRoute.GET(request(owner, `/api/projects/${projectA.id}/personal-agent`), { params: Promise.resolve({ id: projectA.id }) });
    const memberInbox = await personalAgentRoute.GET(request(member, `/api/projects/${projectA.id}/personal-agent`), { params: Promise.resolve({ id: projectA.id }) });
    assert.equal((await ownerInbox.json()).tasks[0].id, persisted[0].id);
    assert.equal((await memberInbox.json()).tasks[0].id, persisted[1].id);
    assert.equal((await personalAgentRoute.GET(request(outsider, `/api/projects/${projectA.id}/personal-agent`), { params: Promise.resolve({ id: projectA.id }) })).status, 404);
    assert.equal(persisted[0].inputTokens, 12);
    assert.equal(persisted[0].outputTokens, 7);
    const permittedResearch = await researchRoute.GET(request(creator, `/api/research/${successPackage.id}`), { params: Promise.resolve({ id: successPackage.id }) });
    assert.equal(permittedResearch.status, 200);
    const deniedResearch = await researchRoute.GET(request(outsider, `/api/research/${successPackage.id}`), { params: Promise.resolve({ id: successPackage.id }) });
    assert.equal(deniedResearch.status, 404);

    const ownTask = persisted[1];
    const taskPath = `/api/projects/${projectA.id}/personal-agent/tasks/${ownTask.id}`;
    const taskContext = { params: Promise.resolve({ id: projectA.id, taskId: ownTask.id }) };
    const submitBody = { action: "submit", revision: 0, result: "越权提交" };
    assert.equal((await personalTaskRoute.POST(request(owner, taskPath, "POST", submitBody), taskContext)).status, 404, "Owner cannot act as the member");
    assert.equal((await personalTaskRoute.POST(request(outsider, taskPath, "POST", submitBody), taskContext)).status, 404);
    const otherScope = { params: Promise.resolve({ id: projectB.id, taskId: ownTask.id }) };
    assert.equal((await personalTaskRoute.POST(request(outsider, `/api/projects/${projectB.id}/personal-agent/tasks/${ownTask.id}`, "POST", submitBody), otherScope)).status, 404);
    let chatCalls = 0;
    const chatModel: Model = { async getResponse(input) { chatCalls++; assert.deepEqual(input.tools, []); assert.match(JSON.stringify(input.input), /私有追问/); return reply("个人私有修订草稿"); }, getStreamedResponse() { throw new Error("unused"); } };
    const resolveChat = async () => ({ model: "fixture", provider: modelProvider(chatModel), settings: {} });
    await interactWithPersonalTask(projectA.id, member.id, ownTask.id, { action: "message", revision: 0, message: "私有追问：请补充验收点" }, new AbortController().signal, resolveChat);
    assert.equal(chatCalls, 1);
    await assert.rejects(interactWithPersonalTask(projectA.id, member.id, ownTask.id, { action: "message", revision: 0, message: "重复请求" }, new AbortController().signal, resolveChat), /刷新/);
    assert.equal(chatCalls, 1);
    const privateTask = await db.agentSubtask.findUniqueOrThrow({ where: { id: ownTask.id } });
    assert.equal(privateTask.status, "review");
    assert.equal(privateTask.modelRequests, 2);
    assert.equal(JSON.parse(privateTask.conversation).length, 3);
    const sharedView = await researchRoute.GET(request(owner, `/api/research/${successPackage.id}`), { params: Promise.resolve({ id: successPackage.id }) });
    assert.doesNotMatch(JSON.stringify(await sharedView.json()), /私有追问|个人私有修订草稿/);
    const publishedText = "成员手动确认的最终交付";
    assert.equal((await personalTaskRoute.POST(request(member, taskPath, "POST", { action: "submit", revision: 1, result: publishedText }), taskContext)).status, 200);
    const submitted = await db.agentSubtask.findUniqueOrThrow({ where: { id: ownTask.id } });
    assert.equal(submitted.status, "submitted");
    assert.equal(submitted.result, publishedText);
    const parentNotification = await db.researchPackage.findUniqueOrThrow({ where: { id: successPackage.id } });
    assert.match(parentNotification.pendingMessage ?? "", new RegExp(ownTask.id));
    await Promise.all([queueResearch(successPackage.id, "并发成员通知甲"), queueResearch(successPackage.id, "并发成员通知乙")]);
    const queuedTogether = await db.researchPackage.findUniqueOrThrow({ where: { id: successPackage.id } });
    assert.match(queuedTogether.pendingMessage ?? "", /并发成员通知甲/);
    assert.match(queuedTogether.pendingMessage ?? "", /并发成员通知乙/);
    const submittedEvents = await db.researchEvent.findMany({ where: { packageId: successPackage.id, type: "agent_task_submitted" } });
    assert.equal(submittedEvents.length, 1);
    assert.match(submittedEvents[0].payload ?? "", new RegExp(publishedText));
    assert.doesNotMatch(submittedEvents[0].payload ?? "", /私有追问/);
    assert.equal((await personalTaskRoute.POST(request(member, taskPath, "POST", { action: "submit", revision: 1, result: "重复" }), taskContext)).status, 409);
    const repoPath = `/api/projects/${projectA.id}/repository`, repoContext = { params: Promise.resolve({ id: projectA.id }) };
    assert.equal((await repositoryRoute.POST(request(member, repoPath, "POST", { action: "initialize" }), repoContext)).status, 403);
    for (const action of [{ action: "key" }, { action: "check" }, { action: "push", head: "a".repeat(40), remoteHead: null }]) {
      assert.equal((await repositoryRoute.POST(request(member, repoPath, "POST", action), repoContext)).status, 403);
      assert.equal((await repositoryRoute.POST(request(outsider, repoPath, "POST", action), repoContext)).status, 404);
    }
    assert.equal((await repositoryRoute.POST(request(owner, repoPath, "POST", { action: "initialize" }), repoContext)).status, 200);
    assert.equal((await repositoryRoute.POST(request(owner, repoPath, "POST", { action: "store", taskId: ownTask.id }), repoContext)).status, 404);
    assert.equal((await repositoryRoute.POST(request(member, repoPath, "POST", { action: "store", taskId: ownTask.id }), repoContext)).status, 200);
    const diffResponse = await repositoryRoute.GET(request(owner, `${repoPath}?task=${ownTask.id}`), repoContext);
    const review = await diffResponse.json();
    assert.match(review.diff, new RegExp(publishedText));
    assert.doesNotMatch(review.diff, /私有追问|个人私有修订草稿/);
    const mergeBody = { action: "merge", taskId: ownTask.id, head: review.head, commit: review.commit };
    assert.equal((await repositoryRoute.POST(request(member, repoPath, "POST", mergeBody), repoContext)).status, 403);
    assert.equal((await repositoryRoute.POST(request(owner, repoPath, "POST", mergeBody), repoContext)).status, 200);
    assert.equal((await repositoryRoute.GET(request(outsider, repoPath), repoContext)).status, 404);

    const failureRun = randomUUID();
    const failurePackage = await db.researchPackage.create({ data: { projectId: projectA.id, title: "Subtask failure", goal: "Persist failed child calls", taskState: "running", leaseOwner: failureRun, leaseUntil: new Date(Date.now() + 60_000) } });
    packageIds.push(failurePackage.id);
    const failureModel: Model = { async getResponse() { throw new Error("simulated fixture failure"); }, getStreamedResponse() { throw new Error("unused"); } };
    const failed = JSON.parse(await dispatchTeamSubtasks({ packageId: failurePackage.id, runId: failureRun, input: { tasks: [{ objective: "触发离线失败", assigneeId: member.id }] }, resolveSubagent: async () => ({ model: "fixture", provider: modelProvider(failureModel), settings: {} }), signal: new AbortController().signal }));
    assert.equal(failed.tasks[0].status, "failed");
    const failedRow = await db.agentSubtask.findFirstOrThrow({ where: { packageId: failurePackage.id, runId: failureRun } });
    assert.equal(failedRow.status, "failed");
    assert.equal(failedRow.modelRequests, 1);
    await db.agentSubtask.update({ where: { id: failedRow.id }, data: { modelRequests: 6 } });
    await assert.rejects(interactWithPersonalTask(projectA.id, member.id, failedRow.id, { action: "message", revision: 0, message: "超预算" }, new AbortController().signal, resolveChat), /上限/);

    let personalStarted!: () => void, releasePersonal!: () => void;
    const startPersonal = new Promise<void>(resolve => { personalStarted = resolve; });
    const personalGate = new Promise<void>(resolve => { releasePersonal = resolve; });
    const delayedPersonal: Model = { async getResponse() { personalStarted(); await personalGate; return reply("不得写入的迟到私有结果"); }, getStreamedResponse() { throw new Error("unused"); } };
    const personalPending = interactWithPersonalTask(projectA.id, owner.id, persisted[0].id, { action: "message", revision: 0, message: "等待回复" }, new AbortController().signal, async () => ({ model: "fixture", provider: modelProvider(delayedPersonal), settings: {} }));
    await startPersonal;
    await assert.rejects(interactWithPersonalTask(projectA.id, owner.id, persisted[0].id, { action: "submit", revision: 1, result: "执行中抢先提交" }, new AbortController().signal), /等待当前执行/);
    await db.agentSubtask.update({ where: { id: persisted[0].id }, data: { chatLeaseUntil: new Date(Date.now() - 1000) } });
    await interactWithPersonalTask(projectA.id, owner.id, persisted[0].id, { action: "recover", revision: 1 }, new AbortController().signal);
    const rejectsLate = assert.rejects(personalPending, /迟到结果/);
    releasePersonal();
    await rejectsLate;
    assert.equal((await db.agentSubtask.findUniqueOrThrow({ where: { id: persisted[0].id } })).result, "已核对的子任务结果");

    const staleRun = randomUUID();
    const recoveredRun = randomUUID();
    const stalePackage = await db.researchPackage.create({ data: { projectId: projectA.id, title: "Subtask lease recovery", goal: "Discard late child output", taskState: "running", leaseOwner: staleRun, leaseUntil: new Date(Date.now() + 60_000) } });
    packageIds.push(stalePackage.id);
    let markStarted!: () => void;
    let releaseModel!: () => void;
    const modelStarted = new Promise<void>(resolve => { markStarted = resolve; });
    const modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
    const delayedModel: Model = { async getResponse() { markStarted(); await modelGate; return reply("迟到结果不得覆盖失败状态"); }, getStreamedResponse() { throw new Error("unused"); } };
    const lateDispatch = dispatchTeamSubtasks({ packageId: stalePackage.id, runId: staleRun, input: { tasks: [{ objective: "等待后超出租约", assigneeId: member.id }] }, resolveSubagent: async () => ({ model: "fixture", provider: modelProvider(delayedModel), settings: {} }), signal: new AbortController().signal });
    await modelStarted;
    await db.researchPackage.update({ where: { id: stalePackage.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    assert.equal(await claimResearchTask(stalePackage.id, recoveredRun), true);
    releaseModel();
    const lateResult = JSON.parse(await lateDispatch);
    assert.equal(lateResult.tasks[0].status, "failed");
    assert.match(lateResult.tasks[0].error, /租约已结束/);
    const recovered = await db.agentSubtask.findFirstOrThrow({ where: { packageId: stalePackage.id, runId: staleRun } });
    assert.equal(recovered.status, "failed");
    assert.match(recovered.error ?? "", /租约过期/);
    const newLease = await db.researchPackage.findUniqueOrThrow({ where: { id: stalePackage.id }, select: { leaseOwner: true, agentTaskCount: true } });
    assert.equal(newLease.leaseOwner, recoveredRun);
    assert.equal(newLease.agentTaskCount, 0);
  } finally {
    if (projectIds.length) await db.projectKnowledgeItem.deleteMany({ where: { projectId: { in: projectIds } } });
    if (packageIds.length) await db.researchPackage.deleteMany({ where: { id: { in: packageIds } } });
    if (projectIds.length) await db.project.deleteMany({ where: { id: { in: projectIds } } });
    if (users.length) {
      await db.authSession.deleteMany({ where: { userId: { in: users.map(user => user.id) } } });
      await db.user.deleteMany({ where: { id: { in: users.map(user => user.id) } } });
    }
    await db.$disconnect();
    delete process.env.SCENARIOFORGE_GIT_ROOT;
    await rm(gitRoot, { recursive: true, force: true });
  }
});
