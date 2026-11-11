import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { runProjectAgent } from "./project-agent";
import { appendEvent } from "./events";
import { ApiError, logError, publicError } from "./errors";
import { expireQuestions } from "./clarifications";
import { expireFileLocks } from "./editing";
import { taskOutcome } from "./task-outcome";
import { tickKnowledgeJobs } from "./rag/knowledge";
import { TASK_RUNTIME_MS } from "./agent-budget";
import { tickWorkspaceExecutions } from "./workspace-agent/jobs";
import { DOCUMENTS_DRAFTING, DOCUMENTS_PLAN_READY, runPlanDocumentJob } from "./plan-documents";
import { refreshTaskScheduler, type TaskSchedulerState } from "./task-scheduler";

const globalTasks = globalThis as unknown as TaskSchedulerState;
const LEASE_MS = 120_000;

export async function queueResearch(packageId: string, message: string, userMessage = false) {
  await db.$transaction(tx => queueResearchInTransaction(tx, packageId, message, userMessage));
}

export async function queueResearchInTransaction(tx: Prisma.TransactionClient, packageId: string, message: string, userMessage = false) {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM ResearchPackage WHERE id = ${packageId} FOR UPDATE`);
    const row = await tx.researchPackage.findUniqueOrThrow({ where: { id: packageId } });
    if (userMessage && row.status === DOCUMENTS_DRAFTING) throw new ApiError(409, "方案文档正在生成，请等待完成后再继续讨论。");
    await tx.researchPackage.update({ where: { id: packageId }, data: {
      pendingMessage: [row.pendingMessage, message].filter(Boolean).join("\n"),
      ...(row.taskState === "running" && row.leaseUntil && row.leaseUntil > new Date() ? {} : { taskState: "queued" }),
      // New discussion changes the proposal's context even when the reply does not run research.
      ...(userMessage && row.status === DOCUMENTS_PLAN_READY ? { contextVersion: { increment: 1 } } : {}),
    } });
    if (userMessage) await appendEvent(tx, packageId, "user_message", message);
}

async function runTask(id: string) {
  const owner = randomUUID();
  if (!await claimResearchTask(id, owner)) return;
  const turn = await db.$transaction(async (tx) => {
    // Queue writers use the same row lock so a concurrent member submission cannot be lost.
    await tx.$queryRaw(Prisma.sql`SELECT id FROM ResearchPackage WHERE id = ${id} FOR UPDATE`);
    const row = await tx.researchPackage.findUniqueOrThrow({ where: { id } });
    const project = row.projectId ? await tx.project.findUnique({ where: { id: row.projectId }, select: { modelConfigEncrypted: true } }) : null;
    await tx.researchPackage.update({ where: { id }, data: { modelConfigEncrypted: project?.modelConfigEncrypted ?? null, pendingMessage: null } });
    const documents = row.status === DOCUMENTS_DRAFTING;
    await appendEvent(tx, id, documents ? "documents_started" : "turn_started", documents ? "正在根据需求与讨论生成方案文档" : "Agent 正在处理本轮请求");
    return { documents, message: row.pendingMessage ?? "继续当前研究，复用已有计划、证据及文件，保留用户修改。" };
  });
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), TASK_RUNTIME_MS);
  const heartbeat = setInterval(() => {
    void db.researchPackage.updateMany({ where: { id, leaseOwner: owner }, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } }).then((result) => { if (!result.count) abort.abort(); }).catch((error) => { logError(error); abort.abort(); });
  }, 20_000);
  try {
    if (turn.documents) {
      await runPlanDocumentJob(id, owner, turn.message, abort.signal);
      return;
    }
    const { summary, usedResearch } = await runProjectAgent(id, turn.message, abort.signal);
    await db.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM ResearchPackage WHERE id = ${id} FOR UPDATE`);
      const current = await tx.researchPackage.findUniqueOrThrow({ where: { id } });
      if (current.leaseOwner !== owner) return;
      const files = usedResearch ? await tx.workspaceFile.findMany({ where: { packageId: id }, select: { filename: true } }) : [];
      const outcome = taskOutcome(current, usedResearch, files.map(file => file.filename));
      await tx.researchPackage.update({ where: { id }, data: { modelConfigEncrypted: null, summary, ...outcome, taskState: current.pendingMessage ? "queued" : "idle", leaseOwner: null, leaseUntil: null } });
      await appendEvent(tx, id, "assistant_message", summary);
      await appendEvent(tx, id, "turn_completed", "本轮回复已完成");
      if (usedResearch && outcome.status === "completed") await appendEvent(tx, id, "research_completed", summary);
    });
  } catch (error) {
    logError(error);
    await db.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM ResearchPackage WHERE id = ${id} FOR UPDATE`);
      const current = await tx.researchPackage.findUniqueOrThrow({ where: { id } });
      const status = turn.documents ? "documents_failed" : ["created", "replied", "researching"].includes(current.status) ? "failed" : current.status;
      const updated = await tx.researchPackage.updateMany({ where: { id, leaseOwner: owner }, data: { modelConfigEncrypted: null, status, taskState: current.pendingMessage ? "queued" : "idle", leaseOwner: null, leaseUntil: null } });
      if (updated.count) await appendEvent(tx, id, turn.documents ? "documents_failed" : current.status === "researching" ? "research_failed" : "turn_failed", publicError(error));
    }).catch(logError);
  } finally { clearTimeout(timeout); clearInterval(heartbeat); }
}

export async function claimResearchTask(id: string, owner = randomUUID()) {
  return db.$transaction(async tx => {
    const now = new Date();
    await tx.$queryRaw`SELECT id FROM ResearchPackage WHERE id = ${id} FOR UPDATE`;
    const previous = await tx.researchPackage.findUnique({ where: { id }, select: { status: true, taskState: true, leaseOwner: true, leaseUntil: true } });
    if (previous?.status === DOCUMENTS_DRAFTING && previous.taskState === "running" && (!previous.leaseUntil || previous.leaseUntil <= new Date())) {
      await tx.researchPackage.update({ where: { id }, data: { status: "documents_failed", taskState: "idle", leaseOwner: null, leaseUntil: null, modelConfigEncrypted: null, pendingMessage: null } });
      await appendEvent(tx, id, "documents_failed", "文档生成进程已中断，未自动重试。请检查已保存文档后手动重新生成。");
      return false;
    }
    const claimed = await tx.researchPackage.updateMany({ where: { id, OR: [{ taskState: "queued" }, { taskState: "running", leaseUntil: { lt: now } }] }, data: { taskState: "running", leaseOwner: owner, leaseUntil: new Date(Date.now() + LEASE_MS), agentTaskCount: 0 } });
    if (!claimed.count) return false;
    if (previous?.taskState === "running" && previous.leaseOwner) {
      const stale = await tx.agentSubtask.updateMany({ where: { packageId: id, runId: previous.leaseOwner, status: "running" }, data: { status: "failed", error: "父任务租约过期，子任务未完成。", finishedAt: now } });
      if (stale.count) await appendEvent(tx, id, "agent_task_failed", `父任务租约过期，${stale.count} 个未完成的团队子任务已停止。`, { runId: previous.leaseOwner, count: stale.count });
    }
    return true;
  });
}

export async function tickTasks() {
  void tickWorkspaceExecutions().catch(logError);
  void tickKnowledgeJobs().catch(logError);
  if (globalTasks.scenarioforgeTick) return;
  globalTasks.scenarioforgeTick = true;
  try {
    await expireQuestions();
    await expireFileLocks();
    // Keep this local MVP bounded: at most two active packages in one server process.
    const active = await db.researchPackage.count({ where: { taskState: "running", leaseUntil: { gt: new Date() } } });
    if (active >= 2) return;
    const pending = await db.researchPackage.findMany({ where: { OR: [{ taskState: "queued" }, { taskState: "running", leaseUntil: { lt: new Date() } }] }, select: { id: true }, take: 2 - active, orderBy: { createdAt: "asc" } });
    for (const row of pending) void runTask(row.id).catch(logError);
  } finally { globalTasks.scenarioforgeTick = false; }
}

export function startTaskScheduler() {
  // A local UI sharing production data leaves queued work to the server worker.
  refreshTaskScheduler(globalTasks, tickTasks, logError, process.env.SCENARIOFORGE_TASK_SCHEDULER !== "off");
}

// Instrumentation runs once per server instance. Refresh an existing scheduler
// when dev reloads this module, retaining active workers and their lease guards.
if (globalTasks.scenarioforgeScheduler) startTaskScheduler();
