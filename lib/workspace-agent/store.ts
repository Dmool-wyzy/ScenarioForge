import "server-only";
import { Prisma, type ResearchPackage, type WorkspaceExecution } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { db } from "../db";
import { ApiError } from "../errors";
import { appendEvent } from "../events";
import { repositoryOperation, repositorySummary } from "../repository";
import { describeSkill, selectSkillSnapshots, snapshotSkill } from "./skills";
import type { ExecutionView, SkillFile, Verification } from "./types";

export async function projectSkillSources(projectId: string, filter?: { ids?: string[]; packageId?: string }) {
  return db.workspaceFile.findMany({ where: { package: { projectId }, ...(filter?.ids ? { id: { in: filter.ids } } : {}), ...(filter?.packageId ? { packageId: filter.packageId } : {}) }, orderBy: { updatedAt: "desc" }, take: filter ? 20 : 200,
    select: { id: true, packageId: true, filename: true, content: true, version: true, package: { select: { title: true, researchPlan: true } } } });
}
export async function skillCatalog(projectId: string, packageId?: string) {
  const [current, recent] = await Promise.all([packageId ? projectSkillSources(projectId, { packageId }) : [], projectSkillSources(projectId)]);
  return [...new Map([...current, ...recent].map(source => [source.id, source])).values()].map(source => describeSkill(snapshotSkill(source)));
}
export function executionView(run: WorkspaceExecution): ExecutionView {
  return { id: run.id, createdBy: run.createdBy, request: run.request, status: run.status, branch: run.branch, head: run.head,
    target: run.target === "local" ? "local" : "github", runnerId: run.runnerId, workspaceDirectory: run.workspaceDirectory,
    summary: run.summary, error: run.error, attempts: run.attempts, skills: (JSON.parse(run.skills) as SkillFile[]).map(describeSkill),
    verification: run.verification ? JSON.parse(run.verification) as Verification[] : [], createdAt: run.createdAt.toISOString() };
}
export function assertExecutionResearchReady(pkg: Pick<ResearchPackage, "status" | "taskState" | "pendingMessage">, lockedFiles: number, blockingQuestions: number) {
  if (pkg.status === "drafting_documents") throw new ApiError(409, "方案文档正在生成，请等待完成并确认文档后再执行工作区任务。");
  if (["queued", "running"].includes(pkg.taskState) || pkg.pendingMessage) throw new ApiError(409, "当前对话仍有待处理任务，请等待完成后再执行工作区任务。");
  if (blockingQuestions || ["waiting_for_user", "blocked", "waiting_for_edit"].includes(pkg.status)) throw new ApiError(409, "请先回答阻塞问题并结束文档编辑，再执行工作区任务。");
  if (lockedFiles) throw new ApiError(409, "文档正在编辑，请先保存或取消编辑，再执行工作区任务。");
}

async function ensureExecutionResearchReady(tx: Prisma.TransactionClient, packageId: string, projectId: string) {
  const pkg = await tx.researchPackage.findFirst({ where: { id: packageId, projectId } });
  if (!pkg) throw new ApiError(404, "当前对话不属于此项目。");
  const locked = await tx.workspaceFile.count({ where: { packageId, lockedBy: { not: null } } });
  const blocking = await tx.clarification.count({ where: { packageId, priority: "blocking", status: { in: ["waiting", "blocked"] } } });
  assertExecutionResearchReady(pkg, locked, blocking);
  return pkg;
}

export async function createExecution(projectId: string, userId: string, input: { packageId?: string; request: string; skillIds: string[]; target?: "github" | "local"; runnerId?: string }) {
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { repositoryEnabled: true, modelConfigEncrypted: true } });
  const local = input.target === "local";
  if (!local && !project.repositoryEnabled) throw new ApiError(409, "请先在团队 Git 工作区创建或导入项目仓库。");
  const skills = selectSkillSnapshots(await projectSkillSources(projectId, { ids: input.skillIds }), input.skillIds);
  const baseCommit = local ? null : (await repositoryOperation(projectId, () => repositorySummary(projectId))).head;
  return db.$transaction(async tx => {
    const packageId = input.packageId ?? (await tx.researchPackage.create({ data: { projectId, goal: input.request, title: input.request.slice(0, 60), status: "replied" } })).id;
    await tx.$queryRaw`SELECT id FROM ResearchPackage WHERE id = ${packageId} FOR UPDATE`;
    const pkg = await ensureExecutionResearchReady(tx, packageId, projectId);
    let workspaceDirectory: string | null = null;
    if (local) {
      if (!input.runnerId) throw new ApiError(400, "请选择本地 Runner。");
      await tx.$queryRaw`SELECT id FROM LocalRunner WHERE id = ${input.runnerId} FOR UPDATE`;
      const runner = await tx.localRunner.findFirst({ where: { id: input.runnerId, projectId, userId, revokedAt: null, expiresAt: { gt: new Date() }, lastSeenAt: { gt: new Date(Date.now() - 30_000) }, tokenHash: { not: null } } });
      if (!runner) throw new ApiError(409, "本地 Runner 未连接，请先配对并保持运行。");
      workspaceDirectory = runner.workspaceDirectory;
      if (await tx.workspaceExecution.count({ where: { runnerId: input.runnerId, status: { in: ["queued", "running", "stopping"] } } })) throw new ApiError(409, "该本地工作区已有执行任务。");
    }
    if (await tx.workspaceExecution.count({ where: { packageId: pkg.id, status: { in: ["queued", "running", "stopping"] } } })) throw new ApiError(409, "当前对话已有执行任务，请等待、停止或恢复原任务。");
    const id = randomUUID();
    const run = await tx.workspaceExecution.create({ data: { id, packageId: pkg.id, createdBy: userId, request: input.request,
      skills: JSON.stringify(skills), modelConfigEncrypted: project.modelConfigEncrypted, baseCommit,
      target: local ? "local" : "github", runnerId: local ? input.runnerId : null, workspaceDirectory,
      branch: local ? "local/" + input.runnerId + "/" + id : `work/${userId}/agent-${id}` } });
    await appendEvent(tx, pkg.id, "execution_queued", "工作区任务已排队", { executionId: id });
    return { packageId: pkg.id, execution: executionView(run) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
export async function controlExecution(projectId: string, userId: string, runId: string, action: "stop" | "resume") {
  return db.$transaction(async tx => {
    const initial = await tx.workspaceExecution.findFirst({ where: { id: runId, package: { projectId } }, select: { packageId: true } });
    if (!initial) throw new ApiError(404, "执行任务不存在。");
    await tx.$queryRaw`SELECT id FROM ResearchPackage WHERE id = ${initial.packageId} FOR UPDATE`;
    const run = await tx.workspaceExecution.findFirst({ where: { id: runId, package: { projectId } } });
    const member = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } });
    if (!run || !member) throw new ApiError(404, "执行任务不存在。");
    if (run.createdBy !== userId && member.role !== "owner") throw new ApiError(403, "只能控制本人任务，或由项目创建者操作。");
    const status = action === "stop" ? (run.status === "running" ? "stopping" : "stopped") : "queued";
    if (action === "stop" && !["queued", "running"].includes(run.status)) throw new ApiError(409, "该任务目前不能停止。");
    if (action === "resume") {
      await ensureExecutionResearchReady(tx, run.packageId, projectId);
      if (run.target === "local") {
        if (run.createdBy !== userId || !run.runnerId) throw new ApiError(403, "本地任务只能由工作区所有者恢复。");
        await tx.$queryRaw`SELECT id FROM LocalRunner WHERE id = ${run.runnerId} FOR UPDATE`;
        const runner = await tx.localRunner.findFirst({ where: { id: run.runnerId, userId, projectId, revokedAt: null, expiresAt: { gt: new Date() }, lastSeenAt: { gt: new Date(Date.now() - 30_000) } } });
        if (!runner) throw new ApiError(409, "请先连接原本地 Runner。");
        if (await tx.workspaceExecution.count({ where: { runnerId: run.runnerId, id: { not: runId }, status: { in: ["queued", "running", "stopping"] } } })) throw new ApiError(409, "该本地工作区已有执行任务。");
      }
      if (!["stopped", "failed", "review"].includes(run.status)) throw new ApiError(409, "当前任务不能恢复。");
      if (run.attempts >= 3) throw new ApiError(429, "本任务已达到 3 次执行上限，请审查已有文件后创建新任务。");
      if (await tx.workspaceExecution.count({ where: { packageId: run.packageId, id: { not: runId }, status: { in: ["queued", "running", "stopping"] } } })) throw new ApiError(409, "当前对话已有其他执行任务。");
    }
    const updated = await tx.workspaceExecution.updateMany({ where: { id: runId, status: run.status }, data: { status, ...(action === "resume" ? { leaseOwner: null, leaseUntil: null, error: null } : {}) } });
    if (!updated.count) throw new ApiError(409, "任务状态已变化，请刷新。");
    await appendEvent(tx, run.packageId, action === "stop" ? "execution_stopped" : "execution_queued", action === "stop" ? "已请求停止工作区任务" : "从原任务分支继续执行", { executionId: runId });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
