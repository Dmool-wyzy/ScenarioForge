import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { runResearchAgent } from "./agent";
import { appendEvent } from "./events";
import { ApiError, logError, publicError } from "./errors";
import { expireQuestions } from "./clarifications";
import { expireFileLocks } from "./editing";
import { readFilePlan } from "./file-plan";
import { tickKnowledgeJobs } from "./rag/knowledge";

const globalTasks = globalThis as unknown as { scenarioforgeScheduler?: ReturnType<typeof setInterval>; scenarioforgeTick?: boolean };
const LEASE_MS = 120_000;

export async function queueResearch(packageId: string, message: string) {
  await db.$transaction(async (tx) => {
    const row = await tx.researchPackage.findUniqueOrThrow({ where: { id: packageId } });
    await tx.researchPackage.update({ where: { id: packageId }, data: { pendingMessage: [row.pendingMessage, message].filter(Boolean).join("\n"), ...(row.taskState === "running" && row.leaseUntil && row.leaseUntil > new Date() ? {} : { taskState: "queued" }) } });
  });
}

async function runTask(id: string) {
  const owner = randomUUID();
  const claim = await db.researchPackage.updateMany({ where: { id, OR: [{ taskState: "queued" }, { taskState: "running", leaseUntil: { lt: new Date() } }] }, data: { taskState: "running", leaseOwner: owner, leaseUntil: new Date(Date.now() + LEASE_MS) } });
  if (!claim.count) return;
  const row = await db.researchPackage.findUniqueOrThrow({ where: { id } });
  const message = row.pendingMessage ?? "继续当前研究，复用已有计划、证据及文件，保留用户修改。";
  await db.$transaction(async (tx) => {
    await tx.researchPackage.update({ where: { id }, data: { pendingMessage: null, status: "researching", currentStage: Math.max(1, row.currentStage) } });
    await appendEvent(tx, id, "research_started", row.currentStage ? "研究继续" : "研究任务已启动");
  });
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 20 * 60_000);
  const heartbeat = setInterval(() => {
    void db.researchPackage.updateMany({ where: { id, leaseOwner: owner }, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } }).then((result) => { if (!result.count) abort.abort(); }).catch((error) => { logError(error); abort.abort(); });
  }, 20_000);
  try {
    const summary = await runResearchAgent(id, message, abort.signal);
    await db.$transaction(async (tx) => {
      const current = await tx.researchPackage.findUniqueOrThrow({ where: { id } });
      if (current.leaseOwner !== owner) return;
      const waiting = ["waiting_for_user", "blocked", "waiting_for_edit"].includes(current.status);
      const again = !!current.pendingMessage && !waiting;
      if (!waiting && !again) {
        const filePlan = readFilePlan(current.researchPlan ? JSON.parse(current.researchPlan) : null);
        const files = await tx.workspaceFile.findMany({ where: { packageId: id }, select: { filename: true } });
        const missing = filePlan.filter((item) => !files.some((file) => file.filename === item.filename));
        if (!filePlan.length) throw new ApiError(502, "研究计划尚未成功保存，Agent 已结束本轮。请检查前面的工具执行进度及 MCP 服务日志后再继续研究。");
        if (missing.length) throw new ApiError(502, `Agent 本轮结束但未完成文件计划：缺少 ${missing.map((item) => item.filename).join("、")}，请继续研究。`);
      }
      await tx.researchPackage.update({ where: { id }, data: { summary, status: waiting ? current.status : again ? "researching" : "completed", taskState: again ? "queued" : "idle", leaseOwner: null, leaseUntil: null, currentStage: waiting ? current.currentStage : 4 } });
      if (!waiting && !again) await appendEvent(tx, id, "research_completed", summary);
    });
  } catch (error) {
    logError(error);
    await db.$transaction(async (tx) => {
      const updated = await tx.researchPackage.updateMany({ where: { id, leaseOwner: owner }, data: { status: "failed", taskState: "idle", leaseOwner: null, leaseUntil: null } });
      if (updated.count) await appendEvent(tx, id, "research_failed", publicError(error));
    }).catch(logError);
  } finally { clearTimeout(timeout); clearInterval(heartbeat); }
}

export async function tickTasks() {
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
  if (globalTasks.scenarioforgeScheduler) return;
  globalTasks.scenarioforgeScheduler = setInterval(() => { void tickTasks().catch(logError); }, 3000);
  globalTasks.scenarioforgeScheduler.unref();
}
